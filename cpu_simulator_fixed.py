#!/usr/bin/env python3
"""
EATS - Energy-Aware Thermal CPU Scheduler Simulator
=====================================================
Demonstrates energy-efficient CPU scheduling for mobile/embedded systems using:
  - DVFS (Dynamic Voltage and Frequency Scaling)
  - Thermal-Aware Scheduling with throttle/critical thresholds
  - Priority-based task ordering (Critical > Normal > Background)

Three scheduling strategies are compared:
  1. EATS (Proposed)       - Energy-aware + thermal-aware + priority scheduling
  2. Performance-First     - Always max frequency and all cores (baseline)
  3. Round-Robin           - Fixed mid-level frequency, FIFO ordering (baseline)

Features:
  - Live animated simulation with 6 real-time plots
  - "Compare All" - runs all three schedulers on the same workload and overlays results
  - "Batch Run"   - sweeps multiple seeds, exports CSV + per-run graphs + summary chart
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import threading
import random
import numpy as np
import matplotlib
matplotlib.use("TkAgg")
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from copy import deepcopy
import csv
import os

# ============================================================
# Simulation Parameters
# ============================================================

# DVFS Levels: (frequency_fraction, voltage_fraction)
# Dynamic power  ~  C * V^2 * f   ;   V typically scales linearly with f
DVFS_LEVELS = [
    (0.4, 0.60),   # Ultra-low-power mode
    (0.6, 0.75),   # Low-power mode
    (0.8, 0.90),   # Balanced mode
    (1.0, 1.00),   # Full performance
]
FREQ_LEVELS = [d[0] for d in DVFS_LEVELS]

MAX_CORES        = 4
PERF_CONSTANT    = 2000      # cycles-per-ms-per-core at freq = 1.0
C_DYN            = 1.5       # Dynamic capacitance constant
P_STATIC         = 0.10      # Static / leakage power per active core (W)
DT               = 0.05      # Simulation time-step (seconds)
SIM_DURATION     = 10.0      # Total simulation window (seconds)

# Thermal model
THERMAL_RESISTANCE  = 8.0    # deg-C / W   (package-to-ambient)
THERMAL_CAPACITANCE = 5.0    # J / deg-C   (thermal mass of the die)
AMBIENT_TEMP        = 35.0   # deg-C
THROTTLE_TEMP       = 75.0   # deg-C  - begin soft throttling
CRITICAL_TEMP       = 90.0   # deg-C  - emergency: force minimum config
TEMP_TAU = THERMAL_RESISTANCE * THERMAL_CAPACITANCE   # thermal time constant

# ============================================================
# Task Model
# ============================================================
class Task:
    """A schedulable task with WCET, arrival, deadline and priority."""
    def __init__(self, tid, wcet_sec, arrival, deadline, priority="normal"):
        self.tid      = tid
        self.wcet     = wcet_sec
        self.arrival  = arrival
        self.deadline = deadline
        self.priority = priority        # "critical" | "normal" | "background"
        self.remaining   = wcet_sec
        self.start_time  = None
        self.finish_time = None

    def is_ready(self, now):
        return (self.arrival <= now) and (self.remaining > 1e-12)

    def is_done(self):
        return self.remaining <= 1e-12

    def slack(self, now):
        """Remaining slack = deadline - now - remaining_work."""
        return self.deadline - now - self.remaining


def generate_workload(seed=1, n=30):
    """Generate a mixed workload of critical / normal / background tasks."""
    random.seed(seed)
    tasks = []
    for i in range(n):
        typ = random.choices(
            ["critical", "normal", "background"],
            weights=[0.15, 0.50, 0.35],
        )[0]
        arrival = round(random.uniform(0, SIM_DURATION * 0.75), 3)
        if typ == "critical":
            wcet     = random.uniform(0.05, 0.25)
            deadline = arrival + random.uniform(0.3, 0.8)
        elif typ == "normal":
            wcet     = random.uniform(0.10, 0.50)
            deadline = arrival + random.uniform(0.5, 2.0)
        else:
            wcet     = random.uniform(0.20, 1.00)
            deadline = arrival + random.uniform(2.0, 4.0)
        tasks.append(Task(i + 1, wcet, arrival, deadline, priority=typ))
    tasks.sort(key=lambda t: t.arrival)
    if tasks and tasks[0].arrival > 0:
        tasks[0].arrival = 0.0
    return tasks
# ============================================================
# Power & Thermal helpers
# ============================================================
def dvfs_power(freq_frac, cores):
    """Total power = dynamic + static."""
    voltage = 1.0
    for f, v in DVFS_LEVELS:
        if abs(f - freq_frac) < 0.01:
            voltage = v
            break
    return C_DYN * (voltage ** 2) * freq_frac * cores + P_STATIC * cores


def thermal_step(current_temp, power, dt):
    """First-order RC thermal model:  T_ss = T_amb + P * R_th."""
    target = AMBIENT_TEMP + power * THERMAL_RESISTANCE
    alpha  = dt / TEMP_TAU
    return current_temp + alpha * (target - current_temp)


def cycles_per_second(freq_frac, cores):
    return freq_frac * PERF_CONSTANT * cores * 1000.0


# ============================================================
# Scheduler: EATS (Proposed)
# ============================================================
class EATSStepper:
    """
    Energy-Aware Thermal Scheduler (EATS)
    1. Reads current die temperature -> limits max frequency if above thresholds.
    2. Evaluates all (freq, cores) combos within thermal limit.
    3. Picks the *lowest-power* combo that still meets every ready task's deadline.
    4. Dispatches tasks in priority order (Critical -> Normal -> Background),
       then by Earliest-Deadline-First within each priority band.
    """
    NAME = "EATS (Proposed)"

    def __init__(self, tasks):
        self.tasks       = deepcopy(tasks)
        self.now         = 0.0
        self.freq        = FREQ_LEVELS[0]
        self.cores       = 1
        self.energy      = 0.0
        self.temperature = AMBIENT_TEMP
        self.history     = {k: [] for k in
                           ("t", "energy", "freq", "cores", "util", "temp", "power", "running_task")}

    def runnable(self):
        return [t for t in self.tasks if t.is_ready(self.now)]

    def _thermal_max_freq(self):
        if self.temperature >= CRITICAL_TEMP:
            return FREQ_LEVELS[0]
        if self.temperature >= THROTTLE_TEMP:
            ratio   = (self.temperature - THROTTLE_TEMP) / (CRITICAL_TEMP - THROTTLE_TEMP)
            max_idx = max(0, int((1.0 - ratio) * (len(FREQ_LEVELS) - 1)))
            return FREQ_LEVELS[max_idx]
        return FREQ_LEVELS[-1]

    def _pick_config(self, ready):
        thermal_cap = self._thermal_max_freq()
        best = None
        for f, _v in DVFS_LEVELS:
            if f > thermal_cap:
                continue
            for n in range(1, MAX_CORES + 1):
                feasible = True
                for t in ready:
                    rate = f * n if f * n > 0 else 1e-9
                    if self.now + t.remaining / rate > t.deadline + 1e-9:
                        if t.priority == "critical":
                            feasible = False
                            break
                if feasible:
                    pw = dvfs_power(f, n)
                    if best is None or pw < best[2]:
                        best = (f, n, pw)
        return (best[0], best[1]) if best else (thermal_cap, MAX_CORES)

    def step(self, dt=DT):
        if all(t.is_done() for t in self.tasks) or self.now >= SIM_DURATION:
            return False

        ready = sorted(self.runnable(), key=lambda t: (
            {"critical": 0, "normal": 1, "background": 2}[t.priority],
            t.deadline,
        ))
        self.freq, self.cores = self._pick_config(ready)

        cap = cycles_per_second(self.freq, self.cores) * dt
        running_tid = None
        work_done   = 0.0
        for t in ready:
            if cap <= 0:
                break
            cap_sec = cap / (PERF_CONSTANT * 1000.0)
            do = min(t.remaining, cap_sec)
            if do <= 0:
                do = min(1e-6, t.remaining)
            if t.start_time is None and do > 0:
                t.start_time = self.now
            t.remaining -= do
            work_done   += do
            running_tid  = t.tid
            cap -= do * (PERF_CONSTANT * 1000.0)
            if t.is_done():
                t.finish_time = self.now + dt
            if cap <= 0:
                break

        pw = dvfs_power(self.freq, self.cores)
        self.energy      += pw * dt
        self.temperature  = thermal_step(self.temperature, pw, dt)
        self.now         += dt
        util = min(work_done / (self.cores * self.freq * dt) if self.cores * self.freq * dt > 0 else 0, 1.0)

        h = self.history
        h["t"].append(self.now);        h["energy"].append(self.energy)
        h["freq"].append(self.freq);    h["cores"].append(self.cores)
        h["util"].append(util);         h["temp"].append(self.temperature)
        h["power"].append(pw);          h["running_task"].append(running_tid)

        return not (all(t.is_done() for t in self.tasks) or self.now >= SIM_DURATION)


# ============================================================
# Scheduler: Performance-First (baseline)
# ============================================================
class PerformanceFirstStepper:
    """Always max frequency + all cores. No energy or thermal awareness."""
    NAME = "Performance-First"

    def __init__(self, tasks):
        self.tasks       = deepcopy(tasks)
        self.now         = 0.0
        self.freq        = max(FREQ_LEVELS)
        self.cores       = MAX_CORES
        self.energy      = 0.0
        self.temperature = AMBIENT_TEMP
        self.history     = {k: [] for k in
                           ("t", "energy", "freq", "cores", "util", "temp", "power", "running_task")}

    def runnable(self):
        return [t for t in self.tasks if t.is_ready(self.now)]

    def step(self, dt=DT):
        if all(t.is_done() for t in self.tasks) or self.now >= SIM_DURATION:
            return False

        self.freq, self.cores = max(FREQ_LEVELS), MAX_CORES
        ready = sorted(self.runnable(), key=lambda t: t.deadline)
        cap = cycles_per_second(self.freq, self.cores) * dt
        running_tid = None
        work_done   = 0.0

        for t in ready:
            if cap <= 0:
                break
            cap_sec = cap / (PERF_CONSTANT * 1000.0)
            do = min(t.remaining, cap_sec)
            if do <= 0:
                do = min(1e-6, t.remaining)
            if t.start_time is None and do > 0:
                t.start_time = self.now
            t.remaining -= do
            work_done   += do
            running_tid  = t.tid
            cap -= do * (PERF_CONSTANT * 1000.0)
            if t.is_done():
                t.finish_time = self.now + dt
            if cap <= 0:
                break

        pw = dvfs_power(self.freq, self.cores)
        self.energy      += pw * dt
        self.temperature  = thermal_step(self.temperature, pw, dt)
        self.now         += dt
        util = min(work_done / (self.cores * self.freq * dt) if self.cores * self.freq * dt > 0 else 0, 1.0)

        h = self.history
        h["t"].append(self.now);        h["energy"].append(self.energy)
        h["freq"].append(self.freq);    h["cores"].append(self.cores)
        h["util"].append(util);         h["temp"].append(self.temperature)
        h["power"].append(pw);          h["running_task"].append(running_tid)

        return not (all(t.is_done() for t in self.tasks) or self.now >= SIM_DURATION)


# ============================================================
# Scheduler: Round-Robin (baseline)
# ============================================================
class RoundRobinStepper:
    """Fixed mid-level frequency, all cores, FIFO task order."""
    NAME = "Round-Robin"

    def __init__(self, tasks):
        self.tasks       = deepcopy(tasks)
        self.now         = 0.0
        self.freq        = 0.8
        self.cores       = MAX_CORES
        self.energy      = 0.0
        self.temperature = AMBIENT_TEMP
        self.history     = {k: [] for k in
                           ("t", "energy", "freq", "cores", "util", "temp", "power", "running_task")}

    def runnable(self):
        return [t for t in self.tasks if t.is_ready(self.now)]

    def step(self, dt=DT):
        if all(t.is_done() for t in self.tasks) or self.now >= SIM_DURATION:
            return False

        ready = sorted(self.runnable(), key=lambda t: t.tid)
        cap = cycles_per_second(self.freq, self.cores) * dt
        running_tid = None
        work_done   = 0.0

        for t in ready:
            if cap <= 0:
                break
            cap_sec = cap / (PERF_CONSTANT * 1000.0)
            do = min(t.remaining, cap_sec)
            if do <= 0:
                do = min(1e-6, t.remaining)
            if t.start_time is None and do > 0:
                t.start_time = self.now
            t.remaining -= do
            work_done   += do
            running_tid  = t.tid
            cap -= do * (PERF_CONSTANT * 1000.0)
            if t.is_done():
                t.finish_time = self.now + dt
            if cap <= 0:
                break

        pw = dvfs_power(self.freq, self.cores)
        self.energy      += pw * dt
        self.temperature  = thermal_step(self.temperature, pw, dt)
        self.now         += dt
        util = min(work_done / (self.cores * self.freq * dt) if self.cores * self.freq * dt > 0 else 0, 1.0)

        h = self.history
        h["t"].append(self.now);        h["energy"].append(self.energy)
        h["freq"].append(self.freq);    h["cores"].append(self.cores)
        h["util"].append(util);         h["temp"].append(self.temperature)
        h["power"].append(pw);          h["running_task"].append(running_tid)

        return not (all(t.is_done() for t in self.tasks) or self.now >= SIM_DURATION)


# ============================================================
# Shared statistics helper
# ============================================================
def _calc_missed(stepper):
    return sum(
        1 for t in stepper.tasks
        if t.deadline is not None and (
            (t.finish_time is not None and t.finish_time > t.deadline)
            or (not t.is_done() and stepper.now > t.deadline)
        )
    )
# ============================================================
# Color palette
# ============================================================
C = {
    "bg":      "#1a1a2e",
    "panel":   "#16213e",
    "accent":  "#0f3460",
    "hi":      "#e94560",
    "text":    "#eaeaea",
    "grid":    "#2a2a4a",
    "eats":    "#00d4aa",
    "perf":    "#ff6b6b",
    "rr":      "#ffd93d",
    "freq":    "#6c63ff",
    "cores":   "#00bcd4",
    "util":    "#ff9800",
    "temp":    "#f44336",
    "power":   "#e91e63",
}
SCHED_COLOR = {
    "EATS (Proposed)":   C["eats"],
    "Performance-First": C["perf"],
    "Round-Robin":       C["rr"],
}


# ============================================================
# GUI
# ============================================================
class CPUSimApp:
    def __init__(self, master):
        self.master = master
        master.title("EATS - Energy-Aware Thermal CPU Scheduler")
        master.configure(bg=C["bg"])
        master.geometry("1150x880")
        master.minsize(950, 720)

        # ---- ttk styling ----
        style = ttk.Style()
        style.theme_use("clam")
        for widget in ("TFrame", "TLabel", "TCheckbutton"):
            style.configure(widget, background=C["bg"], foreground=C["text"])
        style.configure("Title.TLabel",  background=C["bg"], foreground=C["hi"],
                        font=("Segoe UI", 14, "bold"))
        style.configure("Sub.TLabel",    background=C["bg"], foreground="#888",
                        font=("Segoe UI", 9))
        style.configure("Status.TLabel", background=C["panel"], foreground=C["text"],
                        font=("Segoe UI", 10), padding=5)

        # ---- header ----
        hdr = ttk.Frame(master)
        hdr.pack(side=tk.TOP, fill=tk.X, padx=10, pady=(10, 2))
        ttk.Label(hdr, text="Energy-Aware Thermal CPU Scheduler",
                  style="Title.TLabel").pack(side=tk.LEFT)
        ttk.Label(hdr, text="DVFS + Thermal-Aware Scheduling for Mobile / Embedded Systems",
                  style="Sub.TLabel").pack(side=tk.LEFT, padx=15)

        # ---- controls ----
        ctrl = ttk.Frame(master)
        ctrl.pack(side=tk.TOP, fill=tk.X, padx=10, pady=6)

        ttk.Label(ctrl, text="Scheduler:").grid(row=0, column=0, sticky=tk.W, padx=(0, 4))
        self.sched_var = tk.StringVar(value="EATS (Proposed)")
        ttk.Combobox(ctrl, textvariable=self.sched_var,
                     values=["EATS (Proposed)", "Performance-First", "Round-Robin"],
                     width=20, state="readonly").grid(row=0, column=1, sticky=tk.W)

        ttk.Label(ctrl, text="Seed:").grid(row=0, column=2, sticky=tk.W, padx=(12, 4))
        self.seed_var = tk.IntVar(value=1)
        ttk.Entry(ctrl, textvariable=self.seed_var, width=6).grid(row=0, column=3, sticky=tk.W)

        ttk.Label(ctrl, text="Tasks:").grid(row=0, column=4, sticky=tk.W, padx=(12, 4))
        self.ntasks_var = tk.IntVar(value=30)
        ttk.Entry(ctrl, textvariable=self.ntasks_var, width=6).grid(row=0, column=5, sticky=tk.W)

        ttk.Label(ctrl, text="Speed:").grid(row=0, column=6, sticky=tk.W, padx=(12, 4))
        self.speed_var = tk.DoubleVar(value=1.0)
        ttk.Scale(ctrl, variable=self.speed_var, from_=0.25, to=4.0,
                  orient=tk.HORIZONTAL, length=120).grid(row=0, column=7, sticky=tk.W)

        self.start_btn   = ttk.Button(ctrl, text="Start",   command=self.start)
        self.pause_btn   = ttk.Button(ctrl, text="Pause",   command=self.pause, state=tk.DISABLED)
        self.reset_btn   = ttk.Button(ctrl, text="Reset",   command=self.reset, state=tk.DISABLED)
        self.compare_btn = ttk.Button(ctrl, text="Compare All", command=self.compare_all)
        self.batch_btn   = ttk.Button(ctrl, text="Batch Run",   command=self.batch_run)

        self.start_btn.grid(  row=0, column=8,  padx=(12, 4))
        self.pause_btn.grid(  row=0, column=9,  padx=4)
        self.reset_btn.grid(  row=0, column=10, padx=4)
        self.compare_btn.grid(row=0, column=11, padx=4)
        self.batch_btn.grid(  row=0, column=12, padx=4)

        # ---- status bar ----
        self.status_label = ttk.Label(master,
            text="Ready - Select a scheduler and press Start, or Compare all three",
            style="Status.TLabel")
        self.status_label.pack(side=tk.TOP, fill=tk.X, padx=10, pady=(0, 4))

        # ---- matplotlib figure ----
        plt.style.use("dark_background")
        self.fig, self.axs = plt.subplots(3, 2, figsize=(11, 7))
        self.fig.set_facecolor(C["bg"])
        self.fig.subplots_adjust(hspace=0.55, wspace=0.32, left=0.08, right=0.95,
                                 top=0.94, bottom=0.07)
        self.canvas = FigureCanvasTkAgg(self.fig, master=master)
        self.canvas.get_tk_widget().pack(side=tk.TOP, fill=tk.BOTH, expand=True,
                                         padx=10, pady=(0, 10))

        self.stepper = None
        self.ani     = None
        self.running = False
        self._lines  = None   # pre-created line objects for fast animation

        self._setup_static_axes()

    # ----------------------------------------------------------------
    # Axis setup (done ONCE, not every frame)
    # ----------------------------------------------------------------
    _TITLES = [
        "Cumulative Energy (J)", "CPU Temperature (C)",
        "DVFS Frequency",        "Active Cores",
        "CPU Utilization",       "Instantaneous Power (W)",
    ]
    _YLABELS = [
        "Energy (J)", "Temp (C)",
        "Frequency",  "Cores",
        "Utilization", "Power (W)",
    ]
    _COLORS = None  # set in __init__-time below

    def _get_line_colors(self):
        return [C["eats"], C["temp"], C["freq"], C["cores"], C["util"], C["power"]]

    def _style_ax(self, ax, title=""):
        ax.set_facecolor(C["panel"])
        ax.grid(True, alpha=0.2, color=C["grid"])
        ax.tick_params(colors=C["text"], labelsize=8)
        for sp in ax.spines.values():
            sp.set_color(C["grid"])
        if title:
            ax.set_title(title, fontsize=10, fontweight="bold", color=C["text"], pad=8)

    def _setup_static_axes(self):
        """Set up all 6 subplots with titles, labels, grids. Done once."""
        colors = self._get_line_colors()
        for ax, title, ylabel in zip(self.axs.flat, self._TITLES, self._YLABELS):
            ax.clear()
            self._style_ax(ax, title)
            ax.set_ylabel(ylabel, fontsize=8, color=C["text"])
            ax.set_xlim(0, SIM_DURATION)

        # Set reasonable y-limits
        self.axs[0, 0].set_ylim(0, 20)     # energy
        self.axs[0, 1].set_ylim(30, 100)    # temperature
        self.axs[1, 0].set_ylim(0, 1.1)     # frequency
        self.axs[1, 1].set_ylim(0, 5)       # cores
        self.axs[2, 0].set_ylim(0, 1.1)     # utilization
        self.axs[2, 1].set_ylim(0, 10)      # power

        # Add thermal threshold lines (permanent)
        self.axs[0, 1].axhline(THROTTLE_TEMP, color="#ffd93d", ls="--", alpha=0.5, lw=1)
        self.axs[0, 1].axhline(CRITICAL_TEMP, color="#ff0000", ls="--", alpha=0.5, lw=1)
        self.axs[0, 1].text(0.2, THROTTLE_TEMP + 1, "Throttle", fontsize=7, color="#ffd93d", alpha=0.7)
        self.axs[0, 1].text(0.2, CRITICAL_TEMP + 1, "Critical", fontsize=7, color="#ff0000", alpha=0.7)

        self.canvas.draw()

    def _create_lines(self):
        """Create empty Line2D objects on each axis for fast set_data() updates."""
        colors = self._get_line_colors()
        is_step = [False, False, True, True, False, False]
        lines = []
        for ax, color, step in zip(self.axs.flat, colors, is_step):
            if step:
                line, = ax.step([], [], where="post", color=color, linewidth=1.5)
            else:
                line, = ax.plot([], [], color=color, linewidth=1.5)
            lines.append(line)
        self._lines = lines
        self.canvas.draw()

    # ---------------------------------------------------------------- buttons
    def _set_buttons(self, **kw):
        mapping = dict(start=self.start_btn, pause=self.pause_btn,
                       reset=self.reset_btn, compare=self.compare_btn,
                       batch=self.batch_btn)
        for name, state in kw.items():
            mapping[name].config(state=state)

    def start(self):
        if self.running:
            return
        self.running = True
        self._set_buttons(start=tk.DISABLED, pause=tk.NORMAL,
                          reset=tk.DISABLED, compare=tk.DISABLED, batch=tk.DISABLED)

        seed    = int(self.seed_var.get())
        n_tasks = int(self.ntasks_var.get())
        sched   = self.sched_var.get()
        tasks   = generate_workload(seed=seed, n=n_tasks)

        Cls = {"EATS (Proposed)": EATSStepper,
               "Performance-First": PerformanceFirstStepper,
               "Round-Robin": RoundRobinStepper}[sched]
        self.stepper = Cls(tasks)

        # Reset axes and create fresh line objects
        self._setup_static_axes()
        self._create_lines()

        self.ani = FuncAnimation(self.fig, self._update_frame, interval=100,
                                 blit=False, cache_frame_data=False)
        self.status_label.config(text=f"Running - {sched} | Seed={seed} | Tasks={n_tasks}")

    def pause(self):
        if not self.running:
            return
        self.running = False
        self._set_buttons(start=tk.NORMAL, pause=tk.DISABLED,
                          reset=tk.NORMAL, compare=tk.NORMAL, batch=tk.NORMAL)
        if self.ani:
            self.ani.event_source.stop()
        self.status_label.config(text="Paused")

    def reset(self):
        if self.ani:
            self.ani.event_source.stop()
            self.ani = None
        self.stepper = None
        self._lines  = None
        self.running = False
        self._set_buttons(start=tk.NORMAL, pause=tk.DISABLED,
                          reset=tk.DISABLED, compare=tk.NORMAL, batch=tk.NORMAL)
        self._setup_static_axes()
        self.status_label.config(text="Reset - Ready")

    # ----------------------------------------------------------------
    # FAST animation update (set_data only, no clearing axes)
    # ----------------------------------------------------------------
    def _update_frame(self, _frame):
        if self.stepper is None or self._lines is None:
            return

        # Run multiple simulation steps per frame
        steps = max(1, int(round(float(self.speed_var.get())))) * 3
        cont  = True
        for _ in range(steps):
            cont = self.stepper.step(DT)
            if not cont:
                break

        h = self.stepper.history
        if not h["t"]:
            return

        t_arr = h["t"]
        data_arrays = [
            h["energy"], h["temp"], h["freq"],
            h["cores"],  h["util"], h["power"],
        ]

        # Update line data (FAST - no axis clearing)
        for line, data in zip(self._lines, data_arrays):
            line.set_data(t_arr, data)

        # Auto-scale y-axes to fit data
        for ax, data in zip(self.axs.flat, data_arrays):
            if data:
                mn, mx = min(data), max(data)
                margin = max((mx - mn) * 0.1, 0.5)
                ax.set_ylim(mn - margin, mx + margin)

        # Update x-axis limit if sim progressed
        current_t = t_arr[-1]
        for ax in self.axs.flat:
            ax.set_xlim(0, max(SIM_DURATION, current_t + 0.5))

        # Finish condition
        if not cont:
            if self.ani:
                self.ani.event_source.stop()
            self.running = False
            missed    = _calc_missed(self.stepper)
            done      = sum(1 for tsk in self.stepper.tasks if tsk.is_done())
            peak_temp = max(h["temp"]) if h["temp"] else AMBIENT_TEMP
            self.status_label.config(
                text=f"Done - Energy: {self.stepper.energy:.2f}J | "
                     f"Peak Temp: {peak_temp:.1f}C | "
                     f"Completed: {done}/{len(self.stepper.tasks)} | "
                     f"Missed: {missed}")
            self._set_buttons(start=tk.NORMAL, pause=tk.DISABLED,
                              reset=tk.NORMAL, compare=tk.NORMAL, batch=tk.NORMAL)

        self.canvas.draw_idle()   # draw_idle is faster than draw()
