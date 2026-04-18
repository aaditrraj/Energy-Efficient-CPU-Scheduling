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
