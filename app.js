/* ================================================================
   EATS — Energy-Aware Thermal CPU Scheduler
   Complete Simulation Engine + UI Controller
   ================================================================ */

// ============================================================
// Simulation Parameters
// ============================================================
const DVFS_LEVELS = [
    { freq: 0.4, voltage: 0.60, label: 'Ultra Low Power' },
    { freq: 0.6, voltage: 0.75, label: 'Low Power' },
    { freq: 0.8, voltage: 0.90, label: 'Balanced' },
    { freq: 1.0, voltage: 1.00, label: 'Full Performance' },
];
const FREQ_LEVELS = DVFS_LEVELS.map(d => d.freq);

const MAX_CORES        = 4;
const PERF_CONSTANT    = 2000;     // cycles-per-ms-per-core at freq=1.0
const C_DYN            = 1.5;      // dynamic capacitance constant
const P_STATIC         = 0.10;     // static/leakage power per core (W)
const DT               = 0.05;     // simulation time-step (seconds)
const SIM_DURATION     = 10.0;     // total simulation window (seconds)

const THERMAL_RESISTANCE  = 8.0;   // °C/W
const THERMAL_CAPACITANCE = 5.0;   // J/°C
const AMBIENT_TEMP        = 35.0;  // °C
const THROTTLE_TEMP       = 75.0;  // °C
const CRITICAL_TEMP       = 90.0;  // °C
const TEMP_TAU = THERMAL_RESISTANCE * THERMAL_CAPACITANCE;

// ============================================================
// Seeded Random (Mulberry32) — reproducible workloads
// ============================================================
function mulberry32(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ============================================================
// Task Model
// ============================================================
class Task {
    constructor(tid, wcet, arrival, deadline, priority = 'normal') {
        this.tid = tid;
        this.wcet = wcet;
        this.arrival = arrival;
        this.deadline = deadline;
        this.priority = priority; // 'critical' | 'normal' | 'background'
        this.remaining = wcet;
        this.startTime = null;
        this.finishTime = null;
    }

    isReady(now) {
        return this.arrival <= now && this.remaining > 1e-12;
    }

    isDone() {
        return this.remaining <= 1e-12;
    }

    slack(now) {
        return this.deadline - now - this.remaining;
    }

    clone() {
        const t = new Task(this.tid, this.wcet, this.arrival, this.deadline, this.priority);
        t.remaining = this.remaining;
        t.startTime = this.startTime;
        t.finishTime = this.finishTime;
        return t;
    }
}

function generateWorkload(seed = 1, n = 30) {
    const rng = mulberry32(seed);
    const tasks = [];

    function rngUniform(a, b) { return a + rng() * (b - a); }
    function rngChoice(items, weights) {
        const total = weights.reduce((s, w) => s + w, 0);
        let r = rng() * total;
        for (let i = 0; i < items.length; i++) {
            r -= weights[i];
            if (r <= 0) return items[i];
        }
        return items[items.length - 1];
    }

    for (let i = 0; i < n; i++) {
        const typ = rngChoice(['critical', 'normal', 'background'], [0.15, 0.50, 0.35]);
        const arrival = Math.round(rngUniform(0, SIM_DURATION * 0.75) * 1000) / 1000;
        let wcet, deadline;

        if (typ === 'critical') {
            wcet = rngUniform(0.05, 0.25);
            deadline = arrival + rngUniform(0.3, 0.8);
        } else if (typ === 'normal') {
            wcet = rngUniform(0.10, 0.50);
            deadline = arrival + rngUniform(0.5, 2.0);
        } else {
            wcet = rngUniform(0.20, 1.00);
            deadline = arrival + rngUniform(2.0, 4.0);
        }

        tasks.push(new Task(i + 1, wcet, arrival, deadline, typ));
    }

    tasks.sort((a, b) => a.arrival - b.arrival);
    if (tasks.length > 0 && tasks[0].arrival > 0) tasks[0].arrival = 0.0;
    return tasks;
}

function cloneTasks(tasks) {
    return tasks.map(t => t.clone());
}

// ============================================================
// Power & Thermal Helpers
// ============================================================
function getVoltage(freqFrac) {
    for (const d of DVFS_LEVELS) {
        if (Math.abs(d.freq - freqFrac) < 0.01) return d.voltage;
    }
    return 1.0;
}

function dvfsPower(freqFrac, cores) {
    const v = getVoltage(freqFrac);
    return C_DYN * v * v * freqFrac * cores + P_STATIC * cores;
}

function thermalStep(currentTemp, power, dt) {
    const target = AMBIENT_TEMP + power * THERMAL_RESISTANCE;
    const alpha = dt / TEMP_TAU;
    return currentTemp + alpha * (target - currentTemp);
}

function cyclesPerSecond(freqFrac, cores) {
    return freqFrac * PERF_CONSTANT * cores * 1000.0;
}

// ============================================================
// Scheduler: EATS (Proposed)
// ============================================================
class EATSScheduler {
    static NAME = 'EATS (Proposed)';

    constructor(tasks) {
        this.name = EATSScheduler.NAME;
        this.tasks = cloneTasks(tasks);
        this.now = 0;
        this.freq = FREQ_LEVELS[0];
        this.cores = 1;
        this.energy = 0;
        this.temperature = AMBIENT_TEMP;
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTask:[] };
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    _thermalMaxFreq() {
        if (this.temperature >= CRITICAL_TEMP) return FREQ_LEVELS[0];
        if (this.temperature >= THROTTLE_TEMP) {
            const ratio = (this.temperature - THROTTLE_TEMP) / (CRITICAL_TEMP - THROTTLE_TEMP);
            const maxIdx = Math.max(0, Math.floor((1 - ratio) * (FREQ_LEVELS.length - 1)));
            return FREQ_LEVELS[maxIdx];
        }
        return FREQ_LEVELS[FREQ_LEVELS.length - 1];
    }

    _pickConfig(ready) {
        const thermalCap = this._thermalMaxFreq();
        let best = null;

        for (const d of DVFS_LEVELS) {
            if (d.freq > thermalCap) continue;
            for (let n = 1; n <= MAX_CORES; n++) {
                let feasible = true;
                let urgencyPenalty = 0;

                for (const t of ready) {
                    const rate = d.freq * n || 1e-9;
                    const estFinish = this.now + t.remaining / rate;

                    if (estFinish > t.deadline + 1e-9) {
                        // Any task missing deadline makes this config infeasible
                        feasible = false;
                        break;
                    }

                    // Track how tight the slack is — prefer configs with more headroom
                    const slack = t.deadline - estFinish;
                    if (slack < 0.2) urgencyPenalty += (0.2 - slack);
                }

                if (feasible) {
                    // Weighted score: power + small urgency penalty to prefer configs with slack
                    const pw = dvfsPower(d.freq, n);
                    const score = pw + urgencyPenalty * 0.05;
                    if (best === null || score < best.score) {
                        best = { freq: d.freq, cores: n, power: pw, score };
                    }
                }
            }
        }

        // If no config can meet all deadlines, find the best config that meets
        // at least the critical + normal deadlines, then just critical
        if (!best) {
            for (const priority of [['critical', 'normal'], ['critical']]) {
                for (const d of DVFS_LEVELS) {
                    if (d.freq > thermalCap) continue;
                    for (let n = 1; n <= MAX_CORES; n++) {
                        let feasible = true;
                        for (const t of ready) {
                            if (!priority.includes(t.priority)) continue;
                            const rate = d.freq * n || 1e-9;
                            if (this.now + t.remaining / rate > t.deadline + 1e-9) {
                                feasible = false;
                                break;
                            }
                        }
                        if (feasible) {
                            const pw = dvfsPower(d.freq, n);
                            if (!best || pw < best.score) {
                                best = { freq: d.freq, cores: n, power: pw, score: pw };
                            }
                        }
                    }
                }
                if (best) break;
            }
        }

        return best ? { freq: best.freq, cores: best.cores } : { freq: thermalCap, cores: MAX_CORES };
    }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        const priorityOrder = { critical: 0, normal: 1, background: 2 };
        const ready = this.runnable().sort((a, b) => {
            const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
            return pd !== 0 ? pd : a.deadline - b.deadline;
        });

        const config = this._pickConfig(ready);
        this.freq = config.freq;
        this.cores = config.cores;

        let cap = cyclesPerSecond(this.freq, this.cores) * dt;
        let runningTid = null;
        let workDone = 0;

        for (const t of ready) {
            if (cap <= 0) break;
            let capSec = cap / (PERF_CONSTANT * 1000);
            let doWork = Math.min(t.remaining, capSec);
            if (doWork <= 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            runningTid = t.tid;
            cap -= doWork * PERF_CONSTANT * 1000;
            if (t.isDone()) t.finishTime = this.now + dt;
            if (cap <= 0) break;
        }

        const pw = dvfsPower(this.freq, this.cores);
        this.energy += pw * dt;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        const denom = this.cores * this.freq * dt;
        const util = Math.min(denom > 0 ? workDone / denom : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTask.push(runningTid);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Scheduler: Performance-First
// ============================================================
class PerformanceFirstScheduler {
    static NAME = 'Performance-First';

    constructor(tasks) {
        this.name = PerformanceFirstScheduler.NAME;
        this.tasks = cloneTasks(tasks);
        this.now = 0;
        this.freq = Math.max(...FREQ_LEVELS);
        this.cores = MAX_CORES;
        this.energy = 0;
        this.temperature = AMBIENT_TEMP;
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTask:[] };
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        this.freq = Math.max(...FREQ_LEVELS);
        this.cores = MAX_CORES;

        const ready = this.runnable().sort((a, b) => a.deadline - b.deadline);
        let cap = cyclesPerSecond(this.freq, this.cores) * dt;
        let runningTid = null;
        let workDone = 0;

        for (const t of ready) {
            if (cap <= 0) break;
            let capSec = cap / (PERF_CONSTANT * 1000);
            let doWork = Math.min(t.remaining, capSec);
            if (doWork <= 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            runningTid = t.tid;
            cap -= doWork * PERF_CONSTANT * 1000;
            if (t.isDone()) t.finishTime = this.now + dt;
            if (cap <= 0) break;
        }

        const pw = dvfsPower(this.freq, this.cores);
        this.energy += pw * dt;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        const denom = this.cores * this.freq * dt;
        const util = Math.min(denom > 0 ? workDone / denom : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTask.push(runningTid);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Scheduler: Round-Robin
// ============================================================
class RoundRobinScheduler {
    static NAME = 'Round-Robin';

    constructor(tasks) {
        this.name = RoundRobinScheduler.NAME;
        this.tasks = cloneTasks(tasks);
        this.now = 0;
        this.freq = 0.8;
        this.cores = MAX_CORES;
        this.energy = 0;
        this.temperature = AMBIENT_TEMP;
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTask:[] };
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        const ready = this.runnable().sort((a, b) => a.tid - b.tid);
        let cap = cyclesPerSecond(this.freq, this.cores) * dt;
        let runningTid = null;
        let workDone = 0;

        for (const t of ready) {
            if (cap <= 0) break;
            let capSec = cap / (PERF_CONSTANT * 1000);
            let doWork = Math.min(t.remaining, capSec);
            if (doWork <= 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            runningTid = t.tid;
            cap -= doWork * PERF_CONSTANT * 1000;
            if (t.isDone()) t.finishTime = this.now + dt;
            if (cap <= 0) break;
        }

        const pw = dvfsPower(this.freq, this.cores);
        this.energy += pw * dt;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        const denom = this.cores * this.freq * dt;
        const util = Math.min(denom > 0 ? workDone / denom : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTask.push(runningTid);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Stats Helper
// ============================================================
function calcMissed(scheduler) {
    return scheduler.tasks.filter(t =>
        (t.finishTime !== null && t.finishTime > t.deadline) ||
        (!t.isDone() && scheduler.now > t.deadline)
    ).length;
}

function calcCompleted(scheduler) {
    return scheduler.tasks.filter(t => t.isDone()).length;
}

// ============================================================
// Color Palette
// ============================================================
const COLORS = {
    eats: '#00d4aa',
    perf: '#ff6b6b',
    rr:   '#ffd93d',
    energy: '#00d4aa',
    temp:   '#ff4757',
    freq:   '#6c63ff',
    cores:  '#00bcd4',
    util:   '#ff9800',
    power:  '#e91e63',
};

const SCHEDULER_COLORS = {
    'EATS (Proposed)': COLORS.eats,
    'Performance-First': COLORS.perf,
    'Round-Robin': COLORS.rr,
};

// ============================================================
// Chart Configuration
// ============================================================
const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    plugins: {
        legend: { display: false },
        tooltip: {
            backgroundColor: 'rgba(15, 22, 41, 0.9)',
            titleFont: { family: 'Inter', size: 11 },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            cornerRadius: 8,
            padding: 10,
        },
    },
    scales: {
        x: {
            type: 'linear',
            min: 0,
            max: SIM_DURATION,
            grid: { color: 'rgba(255,255,255,0.04)', lineWidth: 1 },
            ticks: { color: '#555d74', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 },
            border: { color: 'rgba(255,255,255,0.06)' },
            title: { display: true, text: 'Time (s)', color: '#555d74', font: { size: 10 } },
        },
        y: {
            grid: { color: 'rgba(255,255,255,0.04)', lineWidth: 1 },
            ticks: { color: '#555d74', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 6 },
            border: { color: 'rgba(255,255,255,0.06)' },
        },
    },
};

function makeChartConfig(color, yLabel, yMin, yMax, stepped = false) {
    const cfg = JSON.parse(JSON.stringify(CHART_DEFAULTS));
    cfg.scales.y.min = yMin;
    cfg.scales.y.max = yMax;
    cfg.scales.y.title = { display: true, text: yLabel, color: '#555d74', font: { size: 10 } };

    return {
        type: 'line',
        data: {
            datasets: [{
                data: [],
                borderColor: color,
                backgroundColor: color + '18',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: stepped ? 0 : 0.3,
                stepped: stepped ? 'before' : false,
            }],
        },
        options: cfg,
    };
}

// ============================================================
// Application Controller
// ============================================================
class EATSApp {
    constructor() {
        // DOM References
        this.schedulerSelect = document.getElementById('schedulerSelect');
        this.seedInput       = document.getElementById('seedInput');
        this.tasksInput      = document.getElementById('tasksInput');
        this.speedSlider     = document.getElementById('speedSlider');
        this.speedValue      = document.getElementById('speedValue');

        this.btnStart   = document.getElementById('btnStart');
        this.btnPause   = document.getElementById('btnPause');
        this.btnReset   = document.getElementById('btnReset');
        this.btnCompare = document.getElementById('btnCompare');

        this.statusBadge = document.getElementById('statusBadge');
        this.statusText  = document.getElementById('statusText');

        // Stats
        this.valEnergy = document.getElementById('valEnergy');
        this.valTemp   = document.getElementById('valTemp');
        this.valUtil   = document.getElementById('valUtil');
        this.valTasks  = document.getElementById('valTasks');
        this.valMissed = document.getElementById('valMissed');
        this.valPower  = document.getElementById('valPower');

        // CPU Viz
        this.coreElements  = [0,1,2,3].map(i => document.getElementById('core' + i));
        this.freqBarFill   = document.getElementById('freqBarFill');
        this.freqValueEl   = document.getElementById('freqValue');
        this.dvfsLevels    = [0,1,2,3].map(i => document.getElementById('dvfs' + i));
        this.gaugeTemp     = document.getElementById('gaugeTemp');
        this.tempArc       = document.getElementById('tempArc');
        this.tempNeedle    = document.getElementById('tempNeedle');

        this.qCritical   = document.getElementById('qCritical');
        this.qNormal     = document.getElementById('qNormal');
        this.qBackground = document.getElementById('qBackground');

        // Comparison
        this.comparisonPanel = document.getElementById('comparisonPanel');
        this.btnCloseCompare = document.getElementById('btnCloseCompare');
        this.compStatsRow    = document.getElementById('compStatsRow');

        // State
        this.scheduler = null;
        this.running = false;
        this.animFrame = null;
        this.charts = {};
        this.compCharts = {};

        this._initCharts();
        this._bindEvents();
        this._initGaugeMarkers();
    }

    // ---- Chart Initialization ----
    _initCharts() {
        const chartConfigs = {
            chartEnergy: makeChartConfig(COLORS.energy, 'Energy (J)', 0, 20),
            chartTemp:   makeChartConfig(COLORS.temp,   'Temp (°C)',  30, 100),
            chartFreq:   makeChartConfig(COLORS.freq,   'Frequency',  0, 1.1, true),
            chartCores:  makeChartConfig(COLORS.cores,  'Cores',      0, 5, true),
            chartUtil:   makeChartConfig(COLORS.util,   'Utilization', 0, 1.1),
            chartPower:  makeChartConfig(COLORS.power,  'Power (W)',  0, 10),
        };

        // Add thermal threshold annotations to temperature chart
        chartConfigs.chartTemp.options.plugins.annotation = {
            annotations: {
                throttleLine: {
                    type: 'line', yMin: THROTTLE_TEMP, yMax: THROTTLE_TEMP,
                    borderColor: '#ffd93d', borderWidth: 1.5, borderDash: [6,4],
                    label: { display: true, content: 'Throttle (75°C)', position: 'start',
                             backgroundColor: 'transparent', color: '#ffd93d88', font: { size: 9 } }
                },
                criticalLine: {
                    type: 'line', yMin: CRITICAL_TEMP, yMax: CRITICAL_TEMP,
                    borderColor: '#ff3d3d', borderWidth: 1.5, borderDash: [6,4],
                    label: { display: true, content: 'Critical (90°C)', position: 'start',
                             backgroundColor: 'transparent', color: '#ff3d3d88', font: { size: 9 } }
                },
            }
        };

        for (const [id, cfg] of Object.entries(chartConfigs)) {
            const ctx = document.getElementById(id).getContext('2d');
            this.charts[id] = new Chart(ctx, cfg);
        }
    }

    _initGaugeMarkers() {
        // Position throttle and critical markers on the gauge arc
        const arcTotal = Math.PI; // 180 degrees
        const tempRange = CRITICAL_TEMP - AMBIENT_TEMP; // 55 degrees
        
        const throttleAngle = Math.PI + ((THROTTLE_TEMP - AMBIENT_TEMP) / tempRange) * arcTotal;
        const criticalAngle = Math.PI + ((CRITICAL_TEMP - AMBIENT_TEMP) / tempRange) * arcTotal;

        const cx = 100, cy = 100, r1 = 72, r2 = 88;

        const setMarker = (id, angle) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.setAttribute('x1', cx + r1 * Math.cos(angle));
            el.setAttribute('y1', cy + r1 * Math.sin(angle));
            el.setAttribute('x2', cx + r2 * Math.cos(angle));
            el.setAttribute('y2', cy + r2 * Math.sin(angle));
        };

        setMarker('throttleMarker', throttleAngle);
        setMarker('criticalMarker', criticalAngle);
    }

    // ---- Event Binding ----
    _bindEvents() {
        this.btnStart.addEventListener('click', () => this.start());
        this.btnPause.addEventListener('click', () => this.pause());
        this.btnReset.addEventListener('click', () => this.reset());
        this.btnCompare.addEventListener('click', () => this.compareAll());
        this.btnCloseCompare.addEventListener('click', () => this._hideComparison());

        this.speedSlider.addEventListener('input', () => {
            this.speedValue.textContent = parseFloat(this.speedSlider.value).toFixed(2) + '×';
        });
    }

    // ---- Button State ----
    _setButtons(states) {
        const map = { start: this.btnStart, pause: this.btnPause, reset: this.btnReset, compare: this.btnCompare };
        for (const [key, enabled] of Object.entries(states)) {
            if (map[key]) map[key].disabled = !enabled;
        }
    }

    _setStatus(text, state = '') {
        this.statusText.textContent = text;
        this.statusBadge.className = 'status-badge' + (state ? ' ' + state : '');
    }

    // ---- Get Scheduler Class ----
    _getSchedulerClass() {
        const val = this.schedulerSelect.value;
        if (val === 'eats') return EATSScheduler;
        if (val === 'performance') return PerformanceFirstScheduler;
        return RoundRobinScheduler;
    }

    // ---- Start Simulation ----
    start() {
        if (this.running) return;
        this.running = true;
        this._setButtons({ start: false, pause: true, reset: false, compare: false });

        const seed = parseInt(this.seedInput.value) || 1;
        const nTasks = parseInt(this.tasksInput.value) || 30;
        const Cls = this._getSchedulerClass();
        const tasks = generateWorkload(seed, nTasks);
        this.scheduler = new Cls(tasks);

        // Clear charts
        for (const chart of Object.values(this.charts)) {
            chart.data.datasets[0].data = [];
            chart.update('none');
        }

        this._setStatus(`Running — ${this.scheduler.name}`, 'running');
        this._hideComparison();
        this._animate();
    }

    // ---- Pause ----
    pause() {
        if (!this.running) return;
        this.running = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this._setButtons({ start: true, pause: false, reset: true, compare: true });
        this._setStatus('Paused', '');
    }

    // ---- Reset ----
    reset() {
        this.running = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this.scheduler = null;

        for (const chart of Object.values(this.charts)) {
            chart.data.datasets[0].data = [];
            chart.update('none');
        }

        this._resetViz();
        this._setButtons({ start: true, pause: false, reset: false, compare: true });
        this._setStatus('Ready', '');
    }

    _resetViz() {
        this.valEnergy.textContent = '0.00';
        this.valTemp.textContent = '35.0';
        this.valUtil.textContent = '0';
        this.valTasks.textContent = '0/0';
        this.valMissed.textContent = '0';
        this.valPower.textContent = '0.00';

        this.coreElements.forEach(el => el.classList.remove('active'));
        this.freqBarFill.style.width = '40%';
        this.freqValueEl.textContent = '0.4×';
        this.dvfsLevels.forEach(el => el.classList.remove('active'));

        this.gaugeTemp.textContent = '35.0°';
        this.gaugeTemp.className = 'gauge-temp';
        this._updateTempGauge(AMBIENT_TEMP);
        this._updateTaskQueue(0, 0, 0);
    }

    // ---- Animation Loop ----
    _animate() {
        if (!this.running || !this.scheduler) return;

        const speed = parseFloat(this.speedSlider.value) || 1;
        const stepsPerFrame = Math.max(1, Math.round(speed)) * 3;

        let cont = true;
        for (let i = 0; i < stepsPerFrame; i++) {
            cont = this.scheduler.step(DT);
            if (!cont) break;
        }

        this._updateCharts();
        this._updateStats();
        this._updateCPUViz();

        if (!cont) {
            this.running = false;
            const missed = calcMissed(this.scheduler);
            const done = calcCompleted(this.scheduler);
            const peakTemp = this.scheduler.history.temp.length > 0 ?
                Math.max(...this.scheduler.history.temp) : AMBIENT_TEMP;

            this._setStatus(
                `Done — Energy: ${this.scheduler.energy.toFixed(2)}J · Peak: ${peakTemp.toFixed(1)}°C · ${done}/${this.scheduler.tasks.length} tasks · ${missed} missed`,
                'done'
            );
            this._setButtons({ start: true, pause: false, reset: true, compare: true });
            return;
        }

        this.animFrame = requestAnimationFrame(() => this._animate());
    }

    // ---- Update Charts ----
    _updateCharts() {
        const h = this.scheduler.history;
        if (!h.t.length) return;

        const keys = ['energy', 'temp', 'freq', 'cores', 'util', 'power'];
        const chartIds = ['chartEnergy', 'chartTemp', 'chartFreq', 'chartCores', 'chartUtil', 'chartPower'];

        for (let i = 0; i < keys.length; i++) {
            const chart = this.charts[chartIds[i]];
            const data = h[keys[i]].map((v, j) => ({ x: h.t[j], y: v }));
            chart.data.datasets[0].data = data;

            // Auto-scale y axis
            const vals = h[keys[i]];
            const mn = Math.min(...vals);
            const mx = Math.max(...vals);
            const margin = Math.max((mx - mn) * 0.15, 0.5);
            chart.options.scales.y.min = Math.max(0, mn - margin);
            chart.options.scales.y.max = mx + margin;

            chart.update('none');
        }
    }

    // ---- Update Stats ----
    _updateStats() {
        const s = this.scheduler;
        const h = s.history;
        const lastIdx = h.t.length - 1;
        if (lastIdx < 0) return;

        this.valEnergy.textContent = s.energy.toFixed(2);
        this.valTemp.textContent = h.temp[lastIdx].toFixed(1);
        this.valUtil.textContent = Math.round(h.util[lastIdx] * 100);
        this.valTasks.textContent = `${calcCompleted(s)}/${s.tasks.length}`;
        this.valMissed.textContent = calcMissed(s);
        this.valPower.textContent = h.power[lastIdx].toFixed(2);
    }

    // ---- Update CPU Visualization ----
    _updateCPUViz() {
        const s = this.scheduler;
        if (!s) return;
        const h = s.history;
        const lastIdx = h.t.length - 1;
        if (lastIdx < 0) return;

        const activeCores = h.cores[lastIdx];
        const freq = h.freq[lastIdx];
        const temp = h.temp[lastIdx];

        // Cores
        this.coreElements.forEach((el, i) => {
            if (i < activeCores) el.classList.add('active');
            else el.classList.remove('active');
        });

        // Frequency bar
        this.freqBarFill.style.width = (freq * 100) + '%';
        this.freqValueEl.textContent = freq.toFixed(1) + '×';

        // DVFS level indicator
        const dvfsIdx = FREQ_LEVELS.indexOf(freq);
        this.dvfsLevels.forEach((el, i) => {
            if (i === dvfsIdx) el.classList.add('active');
            else el.classList.remove('active');
        });

        // Temperature gauge
        this._updateTempGauge(temp);

        // Task queue
        const ready = s.tasks.filter(t => t.isReady(s.now));
        const crit = ready.filter(t => t.priority === 'critical').length;
        const norm = ready.filter(t => t.priority === 'normal').length;
        const bg   = ready.filter(t => t.priority === 'background').length;
        this._updateTaskQueue(crit, norm, bg);
    }

    _updateTempGauge(temp) {
        // Update arc
        const tempRange = CRITICAL_TEMP + 5 - AMBIENT_TEMP;
        const fraction = Math.min(1, Math.max(0, (temp - AMBIENT_TEMP) / tempRange));
        const arcLength = Math.PI * 80; // circumference of half-circle with r=80
        this.tempArc.style.strokeDasharray = `${fraction * arcLength} ${arcLength}`;

        // Update needle rotation
        const angle = -90 + fraction * 180;
        this.tempNeedle.setAttribute('transform', `rotate(${angle}, 100, 100)`);

        // Update text
        this.gaugeTemp.textContent = temp.toFixed(1) + '°';
        this.gaugeTemp.className = 'gauge-temp' +
            (temp >= CRITICAL_TEMP ? ' hot' : temp >= THROTTLE_TEMP ? ' warm' : '');
    }

    _updateTaskQueue(crit, norm, bg) {
        const total = crit + norm + bg || 1;
        this.qCritical.style.flexBasis = (crit / total * 100) + '%';
        this.qNormal.style.flexBasis = (norm / total * 100) + '%';
        this.qBackground.style.flexBasis = (bg / total * 100) + '%';

        this.qCritical.querySelector('span').textContent = crit;
        this.qNormal.querySelector('span').textContent = norm;
        this.qBackground.querySelector('span').textContent = bg;

        this.qCritical.classList.toggle('has-tasks', crit > 0);
        this.qNormal.classList.toggle('has-tasks', norm > 0);
        this.qBackground.classList.toggle('has-tasks', bg > 0);
    }

    // ---- Compare All ----
    compareAll() {
        this._setButtons({ start: false, pause: false, reset: false, compare: false });
        this._setStatus('Comparing all schedulers...', 'comparing');

        // Run asynchronously to avoid blocking UI
        setTimeout(() => {
            const seed = parseInt(this.seedInput.value) || 1;
            const nTasks = parseInt(this.tasksInput.value) || 30;
            const tasks = generateWorkload(seed, nTasks);

            const results = {};
            const schedulers = [EATSScheduler, PerformanceFirstScheduler, RoundRobinScheduler];

            for (const Cls of schedulers) {
                const s = new Cls(cloneTasks(tasks));
                while (s.step(DT)) {}
                results[s.name] = {
                    scheduler: s,
                    energy: s.energy,
                    peakTemp: s.history.temp.length > 0 ? Math.max(...s.history.temp) : AMBIENT_TEMP,
                    missed: calcMissed(s),
                    completed: calcCompleted(s),
                };
            }

            this._showComparison(results);
            this._setButtons({ start: true, pause: false, reset: true, compare: true });

            const eatsE = results['EATS (Proposed)'].energy;
            const perfE = results['Performance-First'].energy;
            const saving = perfE > 0 ? ((perfE - eatsE) / perfE * 100) : 0;
            this._setStatus(
                `Comparison done — EATS saves ${saving.toFixed(1)}% energy vs Performance-First`,
                'done'
            );
        }, 50);
    }

    _showComparison(results) {
        this.comparisonPanel.style.display = 'block';
        this.comparisonPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Destroy old comparison charts
        for (const c of Object.values(this.compCharts)) {
            c.destroy();
        }
        this.compCharts = {};

        // ---- Energy overlay ----
        const energyCtx = document.getElementById('compChartEnergy').getContext('2d');
        const energyDatasets = [];
        for (const [name, r] of Object.entries(results)) {
            const data = r.scheduler.history.t.map((t, i) => ({ x: t, y: r.scheduler.history.energy[i] }));
            energyDatasets.push({
                label: name,
                data,
                borderColor: SCHEDULER_COLORS[name],
                backgroundColor: SCHEDULER_COLORS[name] + '10',
                borderWidth: 2.5,
                pointRadius: 0,
                fill: false,
                tension: 0.3,
            });
        }

        const compLineOpts = JSON.parse(JSON.stringify(CHART_DEFAULTS));
        compLineOpts.plugins.legend = { display: true, labels: { color: '#8892a8', font: { size: 11, family: 'Inter' }, boxWidth: 12, padding: 16 } };

        this.compCharts.energy = new Chart(energyCtx, {
            type: 'line',
            data: { datasets: energyDatasets },
            options: { ...compLineOpts, scales: { ...compLineOpts.scales, y: { ...compLineOpts.scales.y, title: { display: true, text: 'Energy (J)', color: '#555d74', font: { size: 10 } } } } },
        });

        // ---- Temperature overlay ----
        const tempCtx = document.getElementById('compChartTemp').getContext('2d');
        const tempDatasets = [];
        for (const [name, r] of Object.entries(results)) {
            const data = r.scheduler.history.t.map((t, i) => ({ x: t, y: r.scheduler.history.temp[i] }));
            tempDatasets.push({
                label: name,
                data,
                borderColor: SCHEDULER_COLORS[name],
                backgroundColor: SCHEDULER_COLORS[name] + '10',
                borderWidth: 2.5,
                pointRadius: 0,
                fill: false,
                tension: 0.3,
            });
        }

        this.compCharts.temp = new Chart(tempCtx, {
            type: 'line',
            data: { datasets: tempDatasets },
            options: { ...compLineOpts, scales: { ...compLineOpts.scales, y: { ...compLineOpts.scales.y, min: 30, max: 100, title: { display: true, text: 'Temp (°C)', color: '#555d74', font: { size: 10 } } } } },
        });

        // ---- Bar chart: Total Energy ----
        const barEnergyCtx = document.getElementById('compBarEnergy').getContext('2d');
        const names = Object.keys(results);
        const energies = names.map(n => results[n].energy);
        const barColors = names.map(n => SCHEDULER_COLORS[n]);

        this.compCharts.barEnergy = new Chart(barEnergyCtx, {
            type: 'bar',
            data: {
                labels: names.map(n => n.includes('(') ? n.split('(')[0].trim() : n),
                datasets: [{
                    data: energies,
                    backgroundColor: barColors.map(c => c + 'cc'),
                    borderColor: barColors,
                    borderWidth: 2,
                    borderRadius: 8,
                    barPercentage: 0.6,
                }],
            },
            options: {
                ...JSON.parse(JSON.stringify(CHART_DEFAULTS)),
                scales: {
                    x: {
                        type: 'category',
                        grid: { display: false },
                        ticks: { color: '#8892a8', font: { family: 'Inter', size: 11, weight: '600' } },
                        border: { color: 'rgba(255,255,255,0.06)' },
                    },
                    y: {
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#555d74', font: { family: 'JetBrains Mono', size: 10 } },
                        border: { color: 'rgba(255,255,255,0.06)' },
                        title: { display: true, text: 'Energy (J)', color: '#555d74', font: { size: 10 } },
                    },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(2)} J` },
                    },
                },
            },
        });

        // ---- Bar chart: Missed deadlines + Peak temp rise ----
        const barMissedCtx = document.getElementById('compBarMissed').getContext('2d');
        const missed = names.map(n => results[n].missed);
        const tempRise = names.map(n => results[n].peakTemp - AMBIENT_TEMP);

        this.compCharts.barMissed = new Chart(barMissedCtx, {
            type: 'bar',
            data: {
                labels: names.map(n => n.includes('(') ? n.split('(')[0].trim() : n),
                datasets: [
                    {
                        label: 'Missed Deadlines',
                        data: missed,
                        backgroundColor: '#e9456088',
                        borderColor: '#e94560',
                        borderWidth: 2,
                        borderRadius: 8,
                        barPercentage: 0.5,
                    },
                    {
                        label: 'Peak Temp Rise (°C)',
                        data: tempRise,
                        backgroundColor: '#ff475788',
                        borderColor: '#ff4757',
                        borderWidth: 2,
                        borderRadius: 8,
                        barPercentage: 0.5,
                    },
                ],
            },
            options: {
                ...JSON.parse(JSON.stringify(CHART_DEFAULTS)),
                scales: {
                    x: {
                        type: 'category',
                        grid: { display: false },
                        ticks: { color: '#8892a8', font: { family: 'Inter', size: 11, weight: '600' } },
                        border: { color: 'rgba(255,255,255,0.06)' },
                    },
                    y: {
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: '#555d74', font: { family: 'JetBrains Mono', size: 10 } },
                        border: { color: 'rgba(255,255,255,0.06)' },
                    },
                },
                plugins: {
                    legend: { display: true, labels: { color: '#8892a8', font: { size: 10, family: 'Inter' }, boxWidth: 10, padding: 14 } },
                    tooltip: CHART_DEFAULTS.plugins.tooltip,
                },
            },
        });

        // ---- Comparison stat cards ----
        this.compStatsRow.innerHTML = '';
        const eatsEnergy = results['EATS (Proposed)'].energy;
        const perfEnergy = results['Performance-First'].energy;

        for (const name of names) {
            const r = results[name];
            const color = SCHEDULER_COLORS[name];
            const saving = perfEnergy > 0 ? ((perfEnergy - r.energy) / perfEnergy * 100) : 0;

            const card = document.createElement('div');
            card.className = 'comp-stat-card';
            card.style.background = color + '10';
            card.style.borderColor = color + '30';

            card.innerHTML = `
                <div class="comp-scheduler-name" style="color:${color}">${name}</div>
                <div class="comp-metrics">
                    <div class="comp-metric">
                        <span class="comp-metric-label">Energy</span>
                        <span class="comp-metric-value" style="color:${color}">${r.energy.toFixed(2)}J</span>
                    </div>
                    <div class="comp-metric">
                        <span class="comp-metric-label">Peak Temp</span>
                        <span class="comp-metric-value" style="color:${color}">${r.peakTemp.toFixed(1)}°C</span>
                    </div>
                    <div class="comp-metric">
                        <span class="comp-metric-label">Completed</span>
                        <span class="comp-metric-value" style="color:${color}">${r.completed}/${r.scheduler.tasks.length}</span>
                    </div>
                    <div class="comp-metric">
                        <span class="comp-metric-label">Missed</span>
                        <span class="comp-metric-value" style="color:${color}">${r.missed}</span>
                    </div>
                </div>
                ${name !== 'Performance-First' ? `
                    <div class="comp-saving-badge" style="background:${color}20;color:${color}">
                        ${saving >= 0 ? '↓' : '↑'} ${Math.abs(saving).toFixed(1)}% vs Performance-First
                    </div>
                ` : `<div class="comp-saving-badge" style="background:${color}20;color:${color}">Baseline</div>`}
            `;

            this.compStatsRow.appendChild(card);
        }
    }

    _hideComparison() {
        this.comparisonPanel.style.display = 'none';
        for (const c of Object.values(this.compCharts)) {
            c.destroy();
        }
        this.compCharts = {};
    }
}

// ============================================================
// Initialize
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    window.eatsApp = new EATSApp();
});
