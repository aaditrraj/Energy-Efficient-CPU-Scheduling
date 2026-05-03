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
const C_DYN            = 2.0;      // dynamic capacitance constant (Watts at V=1, f=1)
const P_STATIC         = 0.25;     // static/leakage power per core (W)
const DT               = 0.05;     // simulation time-step (seconds)
const SIM_DURATION     = 10.0;     // total simulation window (seconds)

// Overhead penalties
const CS_OVERHEAD_ENERGY = 0.01;    // Joules per context switch
const MIGRATION_ENERGY   = 0.03;    // Joules per core migration
const CS_OVERHEAD_TIME   = 0.002;   // Seconds lost per context switch

// Thermal model — RC-circuit equivalent
// Lower capacitance = faster temperature response (more responsive gauges)
// Higher resistance = higher steady-state temperatures
let THERMAL_RESISTANCE  = 12.0;    // °C/W — junction-to-ambient
const THERMAL_CAPACITANCE = 1.8;   // J/°C — die thermal mass (small embedded SoC)
let AMBIENT_TEMP        = 35.0;    // °C
let THROTTLE_TEMP       = 75.0;    // °C
let CRITICAL_TEMP       = 90.0;    // °C
let TEMP_TAU = THERMAL_RESISTANCE * THERMAL_CAPACITANCE;
let COOLING_POWER = 0.0;
let ARCHITECTURE = 'smp';

// Battery model — realistic small embedded/IoT battery
// 500 mAh single-cell LiPo at 3.7V = 1.85 Wh
// For a 10-second simulation window, this gives visible drain with typical power levels
const BATTERY_CAPACITY_WH = 1.85;        // Watt-hours
const BATTERY_CAPACITY_J  = BATTERY_CAPACITY_WH * 3600;  // 6660 Joules

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
        this.priority = priority; // 'critical' | 'normal' | 'background' | 'irq'
        this.remaining = wcet;
        this.startTime = null;
        this.finishTime = null;
        this.lastCore = null;
        this.waitTime = 0;
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
        t.lastCore = this.lastCore;
        t.waitTime = this.waitTime;
        return t;
    }
}

function generateWorkload(seed = 1, n = 30, type = 'mixed') {
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
        let weights = [0.15, 0.50, 0.35]; // mixed
        if (type === 'heavy') weights = [0.60, 0.30, 0.10];
        else if (type === 'light') weights = [0.05, 0.15, 0.80];
        const typ = rngChoice(['critical', 'normal', 'background'], weights);
        
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

function dvfsPower(freqFrac, activeCoreIndices, currentTemp = AMBIENT_TEMP) {
    const v = getVoltage(freqFrac);
    // Leakage doubles roughly every 10°C above reference (Arrhenius-like model)
    const leakageMultiplier = 1 + 0.03 * Math.max(0, currentTemp - 25) +
                              0.0005 * Math.pow(Math.max(0, currentTemp - 50), 2);
    let totalPower = 0;

    for (let i = 0; i < MAX_CORES; i++) {
        let isActive = activeCoreIndices.includes(i);
        let cDyn = C_DYN;
        let pStat = P_STATIC;

        if (ARCHITECTURE === 'biglittle') {
            if (i < 2) { // LITTLE cores
                cDyn = 0.6;
                pStat = 0.06;
                let actualFreq = Math.min(freqFrac, 0.6);
                let actualV = getVoltage(actualFreq);
                if (isActive) totalPower += cDyn * actualV * actualV * actualFreq;
                totalPower += pStat * leakageMultiplier;
            } else { // big cores
                cDyn = 2.2;
                pStat = 0.30;
                if (isActive) totalPower += cDyn * v * v * freqFrac;
                totalPower += pStat * leakageMultiplier;
            }
        } else {
            if (isActive) totalPower += cDyn * v * v * freqFrac;
            totalPower += pStat * leakageMultiplier;
        }
    }
    
    return totalPower + COOLING_POWER;
}

function thermalStep(currentTemp, power, dt) {
    const cpuPower = Math.max(0, power - COOLING_POWER);
    // Newton's law of cooling: dT/dt = (P*R_th - (T - T_amb)) / tau
    // Steady-state: T_ss = T_amb + P * R_th
    const target = AMBIENT_TEMP + cpuPower * THERMAL_RESISTANCE;
    const alpha = dt / TEMP_TAU;
    // Clamp alpha to prevent overshooting (numerical stability)
    const clampedAlpha = Math.min(alpha, 0.5);
    const newTemp = currentTemp + clampedAlpha * (target - currentTemp);
    // Never drop below ambient
    return Math.max(AMBIENT_TEMP, newTemp);
}

function cyclesPerSecond(freqFrac, coreIdx) {
    let perf = PERF_CONSTANT;
    if (ARCHITECTURE === 'biglittle' && coreIdx < 2) perf *= 0.5; // LITTLE cores are slower
    return freqFrac * perf * 1000.0;
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
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTasksOnCores:[] };
        this.lastRunningOnCores = new Array(MAX_CORES).fill(null);
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

                // Calculate cumulative capacity
                let totalRate = 0;
                for(let i=0; i<n; i++) totalRate += (ARCHITECTURE === 'biglittle' && i < 2) ? d.freq * 0.5 : d.freq;

                for (const t of ready) {
                    const estFinish = this.now + t.remaining / (totalRate / n || 1e-9);
                    if (estFinish > t.deadline + 1e-9) {
                        feasible = false;
                        break;
                    }
                    const slack = t.deadline - estFinish;
                    if (slack < 0.2) urgencyPenalty += (0.2 - slack);
                }

                if (feasible) {
                    const activeIndices = Array.from({length: n}, (_, i) => i);
                    const pw = dvfsPower(d.freq, activeIndices, this.temperature);
                    const score = pw + urgencyPenalty * 0.05;
                    if (best === null || score < best.score) {
                        best = { freq: d.freq, cores: n, power: pw, score };
                    }
                }
            }
        }

        if (!best) {
            for (const priority of [['irq', 'critical', 'normal'], ['irq', 'critical']]) {
                for (const d of DVFS_LEVELS) {
                    if (d.freq > thermalCap) continue;
                    for (let n = 1; n <= MAX_CORES; n++) {
                        let feasible = true;
                        let totalRate = 0;
                        for(let i=0; i<n; i++) totalRate += (ARCHITECTURE === 'biglittle' && i < 2) ? d.freq * 0.5 : d.freq;

                        for (const t of ready) {
                            if (!priority.includes(t.priority)) continue;
                            if (this.now + t.remaining / (totalRate / n || 1e-9) > t.deadline + 1e-9) {
                                feasible = false;
                                break;
                            }
                        }
                        if (feasible) {
                            const activeIndices = Array.from({length: n}, (_, i) => i);
                            const pw = dvfsPower(d.freq, activeIndices, this.temperature);
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

        const priorityOrder = { irq: -1, critical: 0, normal: 1, background: 2 };
        const ready = this.runnable().sort((a, b) => {
            const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
            return pd !== 0 ? pd : a.deadline - b.deadline;
        });

        // Track waiting time
        for(const t of ready) {
            if (t.startTime === null) t.waitTime += dt;
        }

        const config = this._pickConfig(ready);
        this.freq = config.freq;
        this.cores = config.cores;

        let workDone = 0;
        let runningTasksOnCores = new Array(MAX_CORES).fill(null);
        let activeIndices = Array.from({length: this.cores}, (_, i) => i);

        let penaltyEnergy = 0;
        for (let i = 0; i < this.cores; i++) {
            if (i >= ready.length) break;
            const t = ready[i];
            
            // Check for context switch or migration
            if (this.lastRunningOnCores[i] !== t.tid) {
                penaltyEnergy += CS_OVERHEAD_ENERGY;
                if (t.lastCore !== null && t.lastCore !== i) penaltyEnergy += MIGRATION_ENERGY;
            }

            let coreCapSec = (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
            let doWork = Math.min(t.remaining, coreCapSec);
            if (doWork <= 0 && t.remaining > 0) doWork = Math.min(1e-6, t.remaining);
            
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            t.lastCore = i;
            
            runningTasksOnCores[i] = { tid: t.tid, priority: t.priority };
            if (t.isDone()) t.finishTime = this.now + dt;
        }

        this.lastRunningOnCores = runningTasksOnCores.map(r => r ? r.tid : null);

        const pw = dvfsPower(this.freq, activeIndices, this.temperature);
        this.energy += (pw * dt) + penaltyEnergy;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        let totalCapacity = 0;
        for(let i=0; i<this.cores; i++) totalCapacity += (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
        const util = Math.min(totalCapacity > 0 ? workDone / totalCapacity : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTasksOnCores.push(runningTasksOnCores);

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
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTasksOnCores:[] };
        this.lastRunningOnCores = new Array(MAX_CORES).fill(null);
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        this.freq = Math.max(...FREQ_LEVELS);
        this.cores = MAX_CORES;

        const ready = this.runnable().sort((a, b) => a.deadline - b.deadline);

        // Track waiting time
        for(const t of ready) {
            if (t.startTime === null) t.waitTime += dt;
        }

        let workDone = 0;
        let runningTasksOnCores = new Array(MAX_CORES).fill(null);
        let activeIndices = Array.from({length: this.cores}, (_, i) => i);

        let penaltyEnergy = 0;
        for (let i = 0; i < this.cores; i++) {
            if (i >= ready.length) break;
            const t = ready[i];
            
            if (this.lastRunningOnCores[i] !== t.tid) {
                penaltyEnergy += CS_OVERHEAD_ENERGY;
                if (t.lastCore !== null && t.lastCore !== i) penaltyEnergy += MIGRATION_ENERGY;
            }

            let coreCapSec = (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
            let doWork = Math.min(t.remaining, coreCapSec);
            if (doWork <= 0 && t.remaining > 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            t.lastCore = i;
            runningTasksOnCores[i] = { tid: t.tid, priority: t.priority };
            if (t.isDone()) t.finishTime = this.now + dt;
        }

        this.lastRunningOnCores = runningTasksOnCores.map(r => r ? r.tid : null);

        const pw = dvfsPower(this.freq, activeIndices, this.temperature);
        this.energy += (pw * dt) + penaltyEnergy;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        let totalCapacity = 0;
        for(let i=0; i<this.cores; i++) totalCapacity += (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
        const util = Math.min(totalCapacity > 0 ? workDone / totalCapacity : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTasksOnCores.push(runningTasksOnCores);

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
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTasksOnCores:[] };
        this.lastRunningOnCores = new Array(MAX_CORES).fill(null);
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        const ready = this.runnable().sort((a, b) => a.tid - b.tid);

        // Track waiting time
        for(const t of ready) {
            if (t.startTime === null) t.waitTime += dt;
        }

        let workDone = 0;
        let runningTasksOnCores = new Array(MAX_CORES).fill(null);
        let activeIndices = Array.from({length: this.cores}, (_, i) => i);

        let penaltyEnergy = 0;
        for (let i = 0; i < this.cores; i++) {
            if (i >= ready.length) break;
            const t = ready[i];
            
            if (this.lastRunningOnCores[i] !== t.tid) {
                penaltyEnergy += CS_OVERHEAD_ENERGY;
                if (t.lastCore !== null && t.lastCore !== i) penaltyEnergy += MIGRATION_ENERGY;
            }

            let coreCapSec = (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
            let doWork = Math.min(t.remaining, coreCapSec);
            if (doWork <= 0 && t.remaining > 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            t.lastCore = i;
            runningTasksOnCores[i] = { tid: t.tid, priority: t.priority };
            if (t.isDone()) t.finishTime = this.now + dt;
        }

        this.lastRunningOnCores = runningTasksOnCores.map(r => r ? r.tid : null);

        const pw = dvfsPower(this.freq, activeIndices, this.temperature);
        this.energy += (pw * dt) + penaltyEnergy;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        let totalCapacity = 0;
        for(let i=0; i<this.cores; i++) totalCapacity += (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
        const util = Math.min(totalCapacity > 0 ? workDone / totalCapacity : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTasksOnCores.push(runningTasksOnCores);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Scheduler: Shortest Job First (SJF)
// ============================================================
class ShortestJobFirstScheduler {
    static NAME = 'Shortest Job First (SJF)';

    constructor(tasks) {
        this.name = ShortestJobFirstScheduler.NAME;
        this.tasks = cloneTasks(tasks);
        this.now = 0;
        this.freq = 1.0;
        this.cores = MAX_CORES;
        this.energy = 0;
        this.temperature = AMBIENT_TEMP;
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTasksOnCores:[] };
        this.lastRunningOnCores = new Array(MAX_CORES).fill(null);
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        this.freq = 1.0;
        this.cores = MAX_CORES;

        const ready = this.runnable().sort((a, b) => a.remaining - b.remaining);

        // Track waiting time
        for(const t of ready) {
            if (t.startTime === null) t.waitTime += dt;
        }

        let workDone = 0;
        let runningTasksOnCores = new Array(MAX_CORES).fill(null);
        let activeIndices = Array.from({length: this.cores}, (_, i) => i);

        let penaltyEnergy = 0;
        for (let i = 0; i < this.cores; i++) {
            if (i >= ready.length) break;
            const t = ready[i];
            
            if (this.lastRunningOnCores[i] !== t.tid) {
                penaltyEnergy += CS_OVERHEAD_ENERGY;
                if (t.lastCore !== null && t.lastCore !== i) penaltyEnergy += MIGRATION_ENERGY;
            }

            let coreCapSec = (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
            let doWork = Math.min(t.remaining, coreCapSec);
            if (doWork <= 0 && t.remaining > 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            t.lastCore = i;
            runningTasksOnCores[i] = { tid: t.tid, priority: t.priority };
            if (t.isDone()) t.finishTime = this.now + dt;
        }

        this.lastRunningOnCores = runningTasksOnCores.map(r => r ? r.tid : null);

        const pw = dvfsPower(this.freq, activeIndices, this.temperature);
        this.energy += (pw * dt) + penaltyEnergy;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        let totalCapacity = 0;
        for(let i=0; i<this.cores; i++) totalCapacity += (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
        const util = Math.min(totalCapacity > 0 ? workDone / totalCapacity : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTasksOnCores.push(runningTasksOnCores);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Scheduler: First Come First Serve (FCFS)
// ============================================================
class FCFSScheduler {
    static NAME = 'First Come First Serve (FCFS)';

    constructor(tasks) {
        this.name = FCFSScheduler.NAME;
        this.tasks = cloneTasks(tasks);
        this.now = 0;
        this.freq = 1.0;
        this.cores = MAX_CORES;
        this.energy = 0;
        this.temperature = AMBIENT_TEMP;
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTasksOnCores:[] };
        this.lastRunningOnCores = new Array(MAX_CORES).fill(null);
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        this.freq = 1.0;
        this.cores = MAX_CORES;

        const ready = this.runnable().sort((a, b) => a.arrival === b.arrival ? a.tid - b.tid : a.arrival - b.arrival);

        // Track waiting time
        for(const t of ready) {
            if (t.startTime === null) t.waitTime += dt;
        }

        let workDone = 0;
        let runningTasksOnCores = new Array(MAX_CORES).fill(null);
        let activeIndices = Array.from({length: this.cores}, (_, i) => i);

        let penaltyEnergy = 0;
        for (let i = 0; i < this.cores; i++) {
            if (i >= ready.length) break;
            const t = ready[i];
            
            if (this.lastRunningOnCores[i] !== t.tid) {
                penaltyEnergy += CS_OVERHEAD_ENERGY;
                if (t.lastCore !== null && t.lastCore !== i) penaltyEnergy += MIGRATION_ENERGY;
            }

            let coreCapSec = (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
            let doWork = Math.min(t.remaining, coreCapSec);
            if (doWork <= 0 && t.remaining > 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            t.lastCore = i;
            runningTasksOnCores[i] = { tid: t.tid, priority: t.priority };
            if (t.isDone()) t.finishTime = this.now + dt;
        }

        this.lastRunningOnCores = runningTasksOnCores.map(r => r ? r.tid : null);

        const pw = dvfsPower(this.freq, activeIndices, this.temperature);
        this.energy += (pw * dt) + penaltyEnergy;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        let totalCapacity = 0;
        for(let i=0; i<this.cores; i++) totalCapacity += (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
        const util = Math.min(totalCapacity > 0 ? workDone / totalCapacity : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTasksOnCores.push(runningTasksOnCores);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Scheduler: Priority Preemptive
// ============================================================
class PriorityScheduler {
    static NAME = 'Priority-Preemptive';

    constructor(tasks) {
        this.name = PriorityScheduler.NAME;
        this.tasks = cloneTasks(tasks);
        this.now = 0;
        this.freq = 1.0;
        this.cores = MAX_CORES;
        this.energy = 0;
        this.temperature = AMBIENT_TEMP;
        this.history = { t:[], energy:[], freq:[], cores:[], util:[], temp:[], power:[], runningTasksOnCores:[] };
        this.lastRunningOnCores = new Array(MAX_CORES).fill(null);
    }

    runnable() { return this.tasks.filter(t => t.isReady(this.now)); }

    step(dt = DT) {
        if (this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION) return false;

        this.freq = 1.0;
        this.cores = MAX_CORES;

        const priorityOrder = { irq: 0, critical: 1, normal: 2, background: 3 };
        const ready = this.runnable().sort((a, b) => {
            const pa = priorityOrder[a.priority] ?? priorityOrder.normal;
            const pb = priorityOrder[b.priority] ?? priorityOrder.normal;
            if (pa !== pb) return pa - pb;
            if (a.deadline !== b.deadline) return a.deadline - b.deadline;
            return a.tid - b.tid;
        });

        for (const t of ready) {
            if (t.startTime === null) t.waitTime += dt;
        }

        let workDone = 0;
        let runningTasksOnCores = new Array(MAX_CORES).fill(null);
        let activeIndices = Array.from({length: this.cores}, (_, i) => i);
        let penaltyEnergy = 0;

        for (let i = 0; i < this.cores; i++) {
            if (i >= ready.length) break;
            const t = ready[i];

            if (this.lastRunningOnCores[i] !== t.tid) {
                penaltyEnergy += CS_OVERHEAD_ENERGY;
                if (t.lastCore !== null && t.lastCore !== i) penaltyEnergy += MIGRATION_ENERGY;
            }

            let coreCapSec = (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
            let doWork = Math.min(t.remaining, coreCapSec);
            if (doWork <= 0 && t.remaining > 0) doWork = Math.min(1e-6, t.remaining);
            if (t.startTime === null && doWork > 0) t.startTime = this.now;
            t.remaining -= doWork;
            workDone += doWork;
            t.lastCore = i;
            runningTasksOnCores[i] = { tid: t.tid, priority: t.priority };
            if (t.isDone()) t.finishTime = this.now + dt;
        }

        this.lastRunningOnCores = runningTasksOnCores.map(r => r ? r.tid : null);

        const pw = dvfsPower(this.freq, activeIndices, this.temperature);
        this.energy += (pw * dt) + penaltyEnergy;
        this.temperature = thermalStep(this.temperature, pw, dt);
        this.now += dt;

        let totalCapacity = 0;
        for (let i = 0; i < this.cores; i++) {
            totalCapacity += (ARCHITECTURE === 'biglittle' && i < 2) ? this.freq * 0.5 * dt : this.freq * dt;
        }
        const util = Math.min(totalCapacity > 0 ? workDone / totalCapacity : 0, 1.0);

        const h = this.history;
        h.t.push(this.now); h.energy.push(this.energy);
        h.freq.push(this.freq); h.cores.push(this.cores);
        h.util.push(util); h.temp.push(this.temperature);
        h.power.push(pw); h.runningTasksOnCores.push(runningTasksOnCores);

        return !(this.tasks.every(t => t.isDone()) || this.now >= SIM_DURATION);
    }
}

// ============================================================
// Stats Helper
// ============================================================
function calcMissed(scheduler) {
    return scheduler.tasks.filter(t =>
        (t.finishTime !== null && t.finishTime > t.deadline + 1e-6) ||
        (!t.isDone() && scheduler.now > t.deadline + 1e-6)
    ).length;
}

function calcCompleted(scheduler) {
    return scheduler.tasks.filter(t => t.isDone()).length;
}

function calcAvgWaitTime(scheduler) {
    const completed = scheduler.tasks.filter(t => t.startTime !== null);
    if (completed.length === 0) return 0;
    const totalWait = completed.reduce((sum, t) => sum + t.waitTime, 0);
    return totalWait / completed.length;
}

function calcAvgTurnaroundTime(scheduler) {
    const done = scheduler.tasks.filter(t => t.isDone());
    if (done.length === 0) return 0;
    const totalTurnaround = done.reduce((sum, t) => sum + (t.finishTime - t.arrival), 0);
    return totalTurnaround / done.length;
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
    'Shortest Job First (SJF)': '#ff9f43',
    'First Come First Serve (FCFS)': '#9c88ff',
    'Priority-Preemptive': '#00bcd4',
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
                backgroundColor: (context) => {
                    const chart = context.chart;
                    const {ctx, chartArea} = chart;
                    if (!chartArea) return color + '18';
                    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                    gradient.addColorStop(0, color + '80');
                    gradient.addColorStop(1, color + '00');
                    return gradient;
                },
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: stepped ? 0 : 0.4,
                stepped: stepped ? 'before' : false,
            }],
        },
        options: cfg,
    };
}

// Register Chart.js Annotation Plugin
if (typeof Chart !== 'undefined' && window['chartjs-plugin-annotation']) {
    Chart.register(window['chartjs-plugin-annotation']);
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
        this.btnExport  = document.getElementById('btnExport');
        this.btnInject  = document.getElementById('btnInject');
        this.btnIrq     = document.getElementById('btnIrq');
        this.ambientInput = document.getElementById('ambientInput');

        this.statusBadge = document.getElementById('statusBadge');
        this.statusText  = document.getElementById('statusText');

        this.logContainer = document.getElementById('logContainer');
        this.btnClearLog  = document.getElementById('btnClearLog');
        this.coolingSelect = document.getElementById('coolingSelect');
        this.thermalSelect = document.getElementById('thermalSelect');
        this.workloadSelect = document.getElementById('workloadSelect');
        this.archSelect = document.getElementById('archSelect');
        if (this.btnClearLog) {
            this.btnClearLog.addEventListener('click', () => {
                if (this.logContainer) this.logContainer.innerHTML = '';
            });
        }

        // Stats
        this.valEnergy = document.getElementById('valEnergy');
        this.valTemp   = document.getElementById('valTemp');
        this.valUtil   = document.getElementById('valUtil');
        this.valTasks  = document.getElementById('valTasks');
        this.valMissed = document.getElementById('valMissed');
        this.valPower  = document.getElementById('valPower');
        this.valBattery = document.getElementById('valBattery');
        this.valWait = document.getElementById('valWait');

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

        this._lastCompleted = 0;
        this._lastMissed = 0;
        this._lastTasks = 0;
        this._lastThrottled = false;

        for(let c=0; c<MAX_CORES; c++) {
            const track = document.getElementById('ganttTrack' + c);
            if(track) {
                track.innerHTML = '';
                track._currentBlock = null;
            }
        }

        this.logEvent('Simulation reset.');
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

    _updateChartAnnotations() {
        if (this.charts.chartTemp && this.charts.chartTemp.options.plugins.annotation) {
            const anns = this.charts.chartTemp.options.plugins.annotation.annotations;
            anns.throttleLine.yMin = THROTTLE_TEMP;
            anns.throttleLine.yMax = THROTTLE_TEMP;
            anns.throttleLine.label.content = `Throttle (${THROTTLE_TEMP}°C)`;
            anns.criticalLine.yMin = CRITICAL_TEMP;
            anns.criticalLine.yMax = CRITICAL_TEMP;
            anns.criticalLine.label.content = `Critical (${CRITICAL_TEMP}°C)`;
            this.charts.chartTemp.update('none');
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
        this.btnExport.addEventListener('click', () => this.exportCSV());
        this.btnInject.addEventListener('click', () => this.injectBurst());
        this.btnIrq.addEventListener('click', () => this.injectIrq());

        this.ambientInput.addEventListener('change', () => this._hideComparison());

        this.speedSlider.addEventListener('input', () => {
            this.speedValue.textContent = parseFloat(this.speedSlider.value).toFixed(2) + '×';
        });
    }

    // ---- Button State ----
    _setButtons(states) {
        const map = { start: this.btnStart, pause: this.btnPause, reset: this.btnReset, compare: this.btnCompare, export: this.btnExport, inject: this.btnInject, irq: this.btnIrq };
        for (const [key, enabled] of Object.entries(states)) {
            if (map[key]) map[key].disabled = !enabled;
        }
    }

    _setStatus(text, state = '') {
        this.statusText.textContent = text;
        this.statusBadge.className = 'status-badge' + (state ? ' ' + state : '');
    }

    logEvent(msg, type = 'info') {
        if (!this.logContainer) return;
        const el = document.createElement('div');
        el.textContent = msg;
        if (type === 'warn') el.style.color = 'var(--accent-warm)';
        if (type === 'error') el.style.color = 'var(--accent-danger)';
        if (type === 'success') el.style.color = 'var(--accent-primary)';
        this.logContainer.appendChild(el);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
    }

    // ---- Get Scheduler Class ----
    _getSchedulerClass() {
        const val = this.schedulerSelect.value;
        if (val === 'eats') return EATSScheduler;
        if (val === 'performance') return PerformanceFirstScheduler;
        if (val === 'sjf') return ShortestJobFirstScheduler;
        if (val === 'fcfs') return FCFSScheduler;
        if (val === 'priority') return PriorityScheduler;
        return RoundRobinScheduler;
    }

    // ---- Start Simulation ----
    start() {
        if (this.running) return;
        this.running = true;
        this._setButtons({ start: false, pause: true, reset: false, compare: false, export: false, inject: true, irq: true });
        AMBIENT_TEMP = parseFloat(this.ambientInput.value) || 35.0;
        ARCHITECTURE = this.archSelect ? this.archSelect.value : 'smp';
        
        if (this.coolingSelect && this.coolingSelect.value === 'fan') {
            THERMAL_RESISTANCE = 5.0;
            COOLING_POWER = 1.5;
        } else {
            THERMAL_RESISTANCE = 12.0;
            COOLING_POWER = 0.0;
        }

        if (this.thermalSelect) {
            const val = this.thermalSelect.value;
            if (val === 'aggressive') { THROTTLE_TEMP = 65.0; CRITICAL_TEMP = 85.0; }
            else if (val === 'lenient') { THROTTLE_TEMP = 85.0; CRITICAL_TEMP = 100.0; }
            else { THROTTLE_TEMP = 75.0; CRITICAL_TEMP = 90.0; }
            this._initGaugeMarkers();
            this._updateChartAnnotations();
        }

        TEMP_TAU = THERMAL_RESISTANCE * THERMAL_CAPACITANCE;

        for(let c=0; c<MAX_CORES; c++) {
            const track = document.getElementById('ganttTrack' + c);
            if(track) {
                track.innerHTML = '';
                track._currentBlock = null;
            }
        }

        const seed = parseInt(this.seedInput.value) || 1;
        const nTasks = parseInt(this.tasksInput.value) || 30;
        const workloadType = this.workloadSelect ? this.workloadSelect.value : 'mixed';
        const Cls = this._getSchedulerClass();
        const tasks = generateWorkload(seed, nTasks, workloadType);
        this.scheduler = new Cls(tasks);

        this._lastCompleted = 0;
        this._lastMissed = 0;
        this._lastTasks = tasks.length;
        this._lastThrottled = false;
        if (this.logContainer) this.logContainer.innerHTML = '';
        this.logEvent(`Simulation started: ${this.scheduler.name} with ${tasks.length} tasks.`, 'info');

        // Clear charts
        for (const chart of Object.values(this.charts)) {
            chart.data.datasets[0].data = [];
            chart.update('none');
        }

        this._setStatus(`Running — ${this.scheduler.name}`, 'running');
        this._hideComparison();
        this._animate();
    }

    // ---- Inject Burst ----
    injectBurst() {
        if (!this.scheduler || !this.running) return;
        const now = this.scheduler.now;
        for(let i=0; i<5; i++) {
            const wcet = 0.15 + Math.random() * 0.4;
            const deadline = now + wcet + 0.2 + Math.random() * 1.5;
            const priority = Math.random() < 0.2 ? 'critical' : 'normal';
            const maxTid = this.scheduler.tasks.length > 0 ? Math.max(...this.scheduler.tasks.map(t => t.tid)) : 0;
            this.scheduler.tasks.push(new Task(maxTid + 1 + i, wcet, now, deadline, priority));
        }
        
        // Add visual flash to tasks queue
        const flashColor = 'rgba(0, 212, 170, 0.4)';
        this.valTasks.style.background = flashColor;
        setTimeout(() => this.valTasks.style.background = 'transparent', 400);

        this._lastTasks += 5;
        this.logEvent(`[${now.toFixed(2)}s] ⚡ Burst of 5 tasks injected! Total queue: ${this._lastTasks}`, 'warn');
        this._setStatus('Burst of 5 tasks injected!', 'running');
    }

    injectIrq() {
        if (!this.scheduler) return;
        const irqTask = new Task(9000 + Math.floor(Math.random()*1000), 0.1, this.scheduler.now, this.scheduler.now + 0.15, 'irq');
        this.scheduler.tasks.push(irqTask);
        this.logEvent(`⚠️ Hardware Interrupt (IRQ) injected at ${this.scheduler.now.toFixed(2)}s`, 'warn');
    }

    // ---- Pause ----
    pause() {
        if (!this.running) return;
        this.running = false;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this._setButtons({ start: true, pause: false, reset: true, compare: true, export: true, inject: false, irq: false });
        this._setStatus('Paused', '');
    }

    _hideComparison() {
        if (this.comparisonPanel) {
            this.comparisonPanel.classList.add('hidden');
        }
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

        for(let c=0; c<MAX_CORES; c++) {
            const track = document.getElementById('ganttTrack' + c);
            if(track) {
                track.innerHTML = '';
                track._currentBlock = null;
            }
        }

        this._resetViz();
        this._setButtons({ start: true, pause: false, reset: false, compare: true, export: false, inject: false, irq: false });
        this._setStatus('Ready', '');
    }

    _resetViz() {
        this.valEnergy.textContent = '0.00';
        this.valTemp.textContent = '35.0';
        this.valUtil.textContent = '0';
        this.valTasks.textContent = '0/0';
        this.valMissed.textContent = '0';
        this.valPower.textContent = '0.00';
        if (this.valBattery) this.valBattery.textContent = '100.0';
        if (this.valWait) this.valWait.textContent = '0.00';

        this.coreElements.forEach(el => el.classList.remove('active'));
        this.freqBarFill.style.width = '40%';
        this.freqValueEl.textContent = '0.4×';
        this.dvfsLevels.forEach(el => el.classList.remove('active'));

        this.gaugeTemp.textContent = AMBIENT_TEMP.toFixed(1) + '°';
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
            this._setButtons({ start: true, pause: false, reset: true, compare: true, export: true, inject: false, irq: false });
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
            const vals = h[keys[i]];
            if (!vals || vals.length === 0) continue;

            const data = vals.map((v, j) => ({ x: h.t[j], y: v }));
            chart.data.datasets[0].data = data;

            // Use fixed scales for better comparison visibility
            if (chartIds[i] === 'chartTemp') {
                chart.options.scales.y.min = AMBIENT_TEMP - 5;
                chart.options.scales.y.max = 100;
            } else if (chartIds[i] === 'chartUtil') {
                chart.options.scales.y.min = 0;
                chart.options.scales.y.max = 1.05;
            } else if (chartIds[i] === 'chartFreq') {
                chart.options.scales.y.min = 0;
                chart.options.scales.y.max = 1.1;
            } else if (chartIds[i] === 'chartCores') {
                chart.options.scales.y.min = 0;
                chart.options.scales.y.max = 5;
            } else {
                // Auto-scale with generous margin for energy/power
                const mn = Math.min(...vals);
                const mx = Math.max(...vals);
                const margin = Math.max((mx - mn) * 0.2, 1.0);
                chart.options.scales.y.min = Math.max(0, mn - margin);
                chart.options.scales.y.max = mx + margin;
            }

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
        if (this.valWait) this.valWait.textContent = calcAvgWaitTime(s).toFixed(2);
        
        // Battery drains based on energy consumed using realistic capacity
        // BATTERY_CAPACITY_J = 6660 J (500mAh @ 3.7V LiPo)
        const battery = Math.max(0, 100 - (s.energy / BATTERY_CAPACITY_J) * 100);
        if (this.valBattery) this.valBattery.textContent = battery.toFixed(1);

        // Dynamic stat card color feedback
        const tempCard = document.getElementById('statTemp');
        if (tempCard) {
            const curTemp = h.temp[lastIdx];
            if (curTemp >= CRITICAL_TEMP) {
                tempCard.style.borderColor = 'rgba(255, 61, 61, 0.5)';
                tempCard.style.boxShadow = '0 0 20px rgba(255, 61, 61, 0.15)';
            } else if (curTemp >= THROTTLE_TEMP) {
                tempCard.style.borderColor = 'rgba(255, 217, 61, 0.4)';
                tempCard.style.boxShadow = '0 0 15px rgba(255, 217, 61, 0.1)';
            } else {
                tempCard.style.borderColor = '';
                tempCard.style.boxShadow = '';
            }
        }
        const battCard = document.getElementById('statBattery');
        if (battCard) {
            if (battery < 20) {
                battCard.style.borderColor = 'rgba(255, 71, 87, 0.5)';
                battCard.style.boxShadow = '0 0 15px rgba(255, 71, 87, 0.12)';
            } else if (battery < 50) {
                battCard.style.borderColor = 'rgba(255, 217, 61, 0.4)';
                battCard.style.boxShadow = '0 0 10px rgba(255, 217, 61, 0.08)';
            } else {
                battCard.style.borderColor = '';
                battCard.style.boxShadow = '';
            }
        }

        // System Log Updates
        if (s.temperature >= THROTTLE_TEMP && !this._lastThrottled) {
            this.logEvent(`[${s.now.toFixed(2)}s] ⚠️ WARNING: Thermal throttling engaged (Die Temp: ${s.temperature.toFixed(1)}°C)`, 'warn');
            this._lastThrottled = true;
        } else if (s.temperature < THROTTLE_TEMP - 2 && this._lastThrottled) {
            this.logEvent(`[${s.now.toFixed(2)}s] ❄️ Temperature normalized. Throttling disengaged.`, 'success');
            this._lastThrottled = false;
        }

        const completed = calcCompleted(s);
        if (completed > this._lastCompleted) {
            this.logEvent(`[${s.now.toFixed(2)}s] ✅ ${completed - this._lastCompleted} task(s) finished execution.`, 'info');
            this._lastCompleted = completed;
        }

        const missed = calcMissed(s);
        if (missed > this._lastMissed) {
            this.logEvent(`[${s.now.toFixed(2)}s] ❌ ${missed - this._lastMissed} task(s) missed their deadlines!`, 'error');
            this._lastMissed = missed;
        }
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
            if (i < activeCores) {
                el.classList.add('active');
                if (ARCHITECTURE === 'biglittle') {
                    if (freq <= 0.6) {
                        el.style.borderColor = 'rgba(46, 213, 115, 0.6)'; // Green LITTLE
                        el.style.background = 'rgba(46, 213, 115, 0.1)';
                        el.querySelector('.core-activity').style.background = '#2ed573';
                        el.querySelector('.core-activity').style.boxShadow = '0 0 10px #2ed573';
                    } else {
                        el.style.borderColor = 'rgba(255, 71, 87, 0.6)'; // Red BIG
                        el.style.background = 'rgba(255, 71, 87, 0.1)';
                        el.querySelector('.core-activity').style.background = '#ff4757';
                        el.querySelector('.core-activity').style.boxShadow = '0 0 10px #ff4757';
                    }
                } else {
                    el.style.borderColor = '';
                    el.style.background = '';
                    el.querySelector('.core-activity').style.background = '';
                    el.querySelector('.core-activity').style.boxShadow = '';
                }
            } else {
                el.classList.remove('active');
                el.style.borderColor = '';
                el.style.background = '';
                el.querySelector('.core-activity').style.background = '';
                el.querySelector('.core-activity').style.boxShadow = '';
            }
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

        // 4. Gantt Chart Updating
        const curTasksOnCores = h.runningTasksOnCores[lastIdx];
        if (curTasksOnCores) {
            for (let c = 0; c < MAX_CORES; c++) {
                const track = document.getElementById('ganttTrack' + c);
                if (!track) continue;
                
                const taskInfo = curTasksOnCores[c];
                if (taskInfo) {
                    if (!track._currentBlock || track._currentBlock.tid !== taskInfo.tid) {
                        const block = document.createElement('div');
                        block.className = `gantt-block ${taskInfo.priority}`;
                        block.style.left = (s.now / SIM_DURATION * 100) + '%';
                        block.style.width = '0%';
                        track.appendChild(block);
                        track._currentBlock = { tid: taskInfo.tid, el: block, startT: s.now };
                    } else {
                        const duration = s.now - track._currentBlock.startT;
                        track._currentBlock.el.style.width = (duration / SIM_DURATION * 100) + '%';
                    }
                } else {
                    track._currentBlock = null;
                }
            }
        }

        // 5. Task Queue Metrics
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

    compareAll() {
        this._setButtons({ start: false, pause: false, reset: false, compare: false, export: false, inject: false, irq: false });
        this._setStatus('Comparing all schedulers...', 'comparing');

        // Run asynchronously to avoid blocking UI
        setTimeout(() => {
            try {
                AMBIENT_TEMP = parseFloat(this.ambientInput.value) || 35.0;
                ARCHITECTURE = this.archSelect ? this.archSelect.value : 'smp';
                
                if (this.coolingSelect && this.coolingSelect.value === 'fan') {
                    THERMAL_RESISTANCE = 5.0;
                    COOLING_POWER = 1.5;
                } else {
                    THERMAL_RESISTANCE = 12.0;
                    COOLING_POWER = 0.0;
                }
                
                if (this.thermalSelect) {
                    const val = this.thermalSelect.value;
                    if (val === 'aggressive') { THROTTLE_TEMP = 65.0; CRITICAL_TEMP = 85.0; }
                    else if (val === 'lenient') { THROTTLE_TEMP = 85.0; CRITICAL_TEMP = 100.0; }
                    else { THROTTLE_TEMP = 75.0; CRITICAL_TEMP = 90.0; }
                    this._initGaugeMarkers();
                    this._updateChartAnnotations();
                }

                TEMP_TAU = THERMAL_RESISTANCE * THERMAL_CAPACITANCE;

                const seed = parseInt(this.seedInput.value) || 1;
                const nTasks = parseInt(this.tasksInput.value) || 30;
                const workloadType = this.workloadSelect ? this.workloadSelect.value : 'mixed';
                const tasks = generateWorkload(seed, nTasks, workloadType);

                const results = {};
                const schedulers = [EATSScheduler, PerformanceFirstScheduler, RoundRobinScheduler, ShortestJobFirstScheduler, FCFSScheduler, PriorityScheduler];

                for (const Cls of schedulers) {
                    const s = new Cls(cloneTasks(tasks));
                    while (s.step(DT)) {}
                    const completed = calcCompleted(s);
                    results[s.name] = {
                        scheduler: s,
                        energy: s.energy,
                        peakTemp: s.history.temp.length > 0 ? Math.max(...s.history.temp) : AMBIENT_TEMP,
                        missed: calcMissed(s),
                        completed: completed,
                        avgWait: calcAvgWaitTime(s),
                        avgTurnaround: calcAvgTurnaroundTime(s),
                        efficiency: s.energy > 0 ? (completed / s.energy) : 0,
                    };
                }

                this._showComparison(results);

                const eatsE = results['EATS (Proposed)'].energy;
                const perfE = results['Performance-First'].energy;
                const saving = perfE > 0 ? ((perfE - eatsE) / perfE * 100) : 0;
                this._setStatus(
                    `Comparison done — EATS saves ${saving.toFixed(1)}% energy vs Performance-First`,
                    'done'
                );
            } catch (err) {
                console.error("Comparison Error:", err);
                this._setStatus("Error during comparison", "error");
                this.logEvent("Comparison failed: " + err.message, "error");
            } finally {
                this._setButtons({ start: true, pause: false, reset: true, compare: true, export: true, inject: false, irq: false });
            }
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
        let dsIdx = 0;
        for (const [name, r] of Object.entries(results)) {
            const data = r.scheduler.history.t.map((t, i) => ({ x: t, y: r.scheduler.history.temp[i] }));
            const dashStyle = dsIdx === 0 ? [] : dsIdx === 1 ? [5, 5] : dsIdx === 2 ? [2, 2] : [10, 5];
            tempDatasets.push({
                label: name,
                data,
                borderColor: SCHEDULER_COLORS[name],
                backgroundColor: SCHEDULER_COLORS[name] + '10',
                borderWidth: name === 'EATS (Proposed)' ? 4 : 2,
                borderDash: dashStyle,
                pointRadius: 0,
                fill: false,
                tension: 0.4,
            });
            dsIdx++;
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
                        <span class="comp-metric-label">Avg Wait</span>
                        <span class="comp-metric-value" style="color:${color}">${r.avgWait.toFixed(3)}s</span>
                    </div>
                    <div class="comp-metric">
                        <span class="comp-metric-label">Efficiency</span>
                        <span class="comp-metric-value" style="color:${color}">${r.efficiency.toFixed(2)} /J</span>
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

    // ---- Export CSV ----
    exportCSV() {
        if (!this.scheduler || this.scheduler.history.t.length === 0) {
            alert('No simulation data to export. Please run a simulation first.');
            return;
        }
        
        const h = this.scheduler.history;
        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Time(s),Energy(J),Temperature(C),Frequency(x),Cores,Utilization,Power(W)\n";
        
        for (let i = 0; i < h.t.length; i++) {
            const row = [
                h.t[i].toFixed(2),
                h.energy[i].toFixed(4),
                h.temp[i].toFixed(2),
                h.freq[i].toFixed(2),
                h.cores[i],
                h.util[i].toFixed(4),
                h.power[i].toFixed(4)
            ].join(",");
            csvContent += row + "\n";
        }
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `${this.scheduler.name.replace(/[^a-z0-9]/gi, '_')}_results.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// ============================================================
// Initialize
// ============================================================
function initEATSApp() {
    try {
        if (window.eatsApp) return;
        window.eatsApp = new EATSApp();
    } catch (e) {
        console.error("EATS Initialization Error:", e);
    }
}

window.EATSApp = EATSApp;
window.EATSScheduler = EATSScheduler;
window.PerformanceFirstScheduler = PerformanceFirstScheduler;
window.RoundRobinScheduler = RoundRobinScheduler;
window.ShortestJobFirstScheduler = ShortestJobFirstScheduler;
window.FCFSScheduler = FCFSScheduler;
window.PriorityScheduler = PriorityScheduler;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEATSApp, { once: true });
} else {
    initEATSApp();
}
