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
