<div align="center">

# ⚡ EATS — Energy-Aware Thermal CPU Scheduler

**An energy-efficient CPU scheduling simulator using DVFS and thermal-aware scheduling for mobile and embedded systems.**

[![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Chart.js](https://img.shields.io/badge/Chart.js-4.4-FF6384?style=for-the-badge&logo=chartdotjs&logoColor=white)](https://www.chartjs.org/)
[![Tkinter](https://img.shields.io/badge/GUI-Tkinter-blue?style=for-the-badge)](https://docs.python.org/3/library/tkinter.html)
[![Matplotlib](https://img.shields.io/badge/Plots-Matplotlib-orange?style=for-the-badge)](https://matplotlib.org/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

<br/>

*Simulates and compares three CPU scheduling strategies — EATS, Performance-First, and Round-Robin — with real-time animated visualizations of energy consumption, thermal behavior, DVFS scaling, and core utilization.*

</div>

---

## 📌 About

Modern mobile and embedded processors waste significant energy by running at maximum performance when the workload doesn't demand it. **EATS** is a simulator that demonstrates how intelligent scheduling can dramatically reduce power consumption without sacrificing performance on critical tasks.

The project ships with **two interfaces**:

| Interface | Stack | Launch |
|-----------|-------|--------|
| 🌐 **Web App** | HTML · CSS · JavaScript · Chart.js | Open `index.html` in any browser |
| 🖥️ **Desktop App** | Python · Tkinter · Matplotlib · NumPy | `python cpu_simulator_fixed.py` |

Both  interfaces implement the same simulation engine and provide identical scheduling algorithms, real-time charts, and comparison tools.

### Core Techniques

- **DVFS (Dynamic Voltage and Frequency Scaling)** — dynamically adjusts CPU frequency and voltage based on workload demand
- **Thermal-Aware Scheduling** — monitors die temperature and throttles frequency to prevent overheating
- **Priority-Based Task Dispatching** — ensures critical tasks meet deadlines while conserving energy on background work
- **Dynamic Core Management** — activates only the cores needed, reducing static/leakage power

---

## 🎯 Problem Statement

This project designs an energy-efficient CPU scheduling algorithm that:

1. **Saves energy** by selecting the lowest frequency/voltage that still meets task deadlines
2. **Manages thermals** by proactively throttling before hitting dangerous temperatures
3. **Maintains performance** by prioritizing critical tasks using EDF (Earliest Deadline First) scheduling

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│                   Task Queue                     │
│  [Critical Tasks] [Normal Tasks] [Background]    │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              EATS Scheduler Core                 │
│                                                  │
│  1. Read Temperature ──► Thermal Limit?          │
│  2. Get Ready Tasks  ──► Sort by Priority + EDF  │
│  3. Evaluate Configs ──► (Freq × Cores) combos   │
│  4. Pick Min-Power   ──► Feasibility check       │
│  5. Execute Tasks    ──► Update energy & thermal  │
└──────────────────────┬──────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐
    │   DVFS   │ │ Thermal  │ │   Core   │
    │  Control │ │  Model   │ │ Manager  │
    │ 4 levels │ │ RC model │ │ 1-4 cores│
    └──────────┘ └──────────┘ └──────────┘
          │            │            │
          └────────────┼────────────┘
                       ▼
        ┌─────────────────────────────┐
        │     Visualization Layer     │
        │  Web (Chart.js) │ Desktop   │
        │    (Tkinter + Matplotlib)   │
        └─────────────────────────────┘
```

---

## 🔬 Key Techniques

### DVFS (Dynamic Voltage and Frequency Scaling)

Power consumption follows: **P = C × V² × f**

| Mode | Frequency | Voltage | Relative Power |
|------|-----------|---------|----------------|
| Ultra-Low-Power | 0.4× | 0.60× | ~14% |
| Low-Power | 0.6× | 0.75× | ~34% |
| Balanced | 0.8× | 0.90× | ~65% |
| Full Performance | 1.0× | 1.00× | 100% |

### Thermal Model

First-order RC thermal model with:
- **Ambient temperature:** 35°C
- **Throttle threshold:** 75°C (begin soft throttling)
- **Critical threshold:** 90°C (force minimum frequency)
- **Thermal resistance:** 8.0 °C/W
- **Thermal capacitance:** 5.0 J/°C

---

## 📊 Schedulers Compared

| Feature | EATS (Proposed) | Performance-First | Round-Robin |
|---------|----------------|-------------------|-------------|
| Frequency | Dynamic (0.4–1.0×) | Always 1.0× | Fixed 0.8× |
| Cores | Dynamic (1–4) | Always 4 | Always 4 |
| Thermal Aware | ✅ Yes | ❌ No | ❌ No |
| Priority Aware | ✅ Yes | ❌ No | ❌ No |
| DVFS | ✅ Full | ❌ None | ❌ None |
| Energy Savings | **40–65%** | Baseline | Moderate |

---

## 🌐 Web Interface

The web app provides a premium, interactive experience with:

- **Glassmorphism UI** — frosted-glass panels with animated particle background
- **Real-time CPU visualization** — animated core activity, frequency bar, temperature gauge with needle, DVFS mode indicator, and task queue breakdown
- **6 live-updating charts** — powered by Chart.js with smooth animations
- **Stat cards** — energy consumed, die temperature, CPU utilization, tasks completed, deadline misses, and instantaneous power
- **Scheduler comparison** — side-by-side energy and temperature chart overlays with bar chart summaries
- **Interactive controls** — scheduler selection, seed, task count, and speed slider

### Running the Web App

Simply open `index.html` in any modern browser — no build step or server required.

```bash
# Option 1: Double-click index.html in your file explorer

# Option 2: From the terminal
start index.html          # Windows
open index.html           # macOS
xdg-open index.html       # Linux
```

---

## 🖥️ Desktop Interface (Python)

The Tkinter-based desktop app provides 6 real-time Matplotlib plots with animated simulation:

| Plot | Description |
|------|-------------|
| Cumulative Energy (J) | Total energy consumed — lower is better |
| CPU Temperature (°C) | Die temp with throttle/critical threshold lines |
| DVFS Frequency | Current operating frequency over time |
| Active Cores | Number of active cores (1–4) |
| CPU Utilization | How busy the CPU is (0–100%) |
| Instantaneous Power (W) | Real-time power draw |

### Running the Desktop App

```bash
# Install dependencies
pip install matplotlib numpy

# Run
python cpu_simulator_fixed.py
```

> **Note:** `tkinter` comes pre-installed with Python on most systems. If missing, install it via your package manager.

---

## 🎮 How to Use

Both interfaces share the same controls:

| Control | Description |
|---------|-------------|
| **Scheduler** | Choose EATS, Performance-First, or Round-Robin |
| **Seed** | Random seed for workload generation (change for different task sets) |
| **Tasks** | Number of tasks to generate (default: 30) |
| **Speed** | Animation speed multiplier (0.25× to 4×) |

| Button | Action |
|--------|--------|
| **Start** | Run the selected scheduler with animated real-time plots |
| **Pause** | Pause the running simulation |
| **Reset** | Clear plots and reset to initial state |
| **Compare All** | Run all 3 schedulers on identical workload and compare side-by-side |
| **Batch Run** *(Desktop only)* | Test across 5 seeds, export CSV + graphs for analysis |

---

## 📈 Sample Results

Running **Compare All** with default settings (Seed=1, 30 tasks):

```
EATS saves ~55% energy vs Performance-First
EATS peak temperature: ~45°C  vs  Performance-First: ~70°C
```

### Batch Run Output *(Desktop only)*

The batch run generates:
- `results.csv` — Tabular data for all runs
- `batch_graphs/` — Individual energy + temperature plots per run
- `batch_graphs/summary_comparison.png` — Averaged bar chart comparison

---

## 📁 Project Structure

```
OS Project/
│
├── index.html                 # Web app — main HTML
├── style.css                  # Web app — glassmorphism styles & animations
├── app.js                     # Web app — simulation engine & UI controller
│
├── cpu_simulator_fixed.py     # Desktop app — Tkinter/Matplotlib simulator
├── README.md                  # This file
│
└── batch_graphs/              # Generated after batch run (Desktop)
    ├── EATS_Proposed_seed1.png
    ├── Performance-First_seed1.png
    ├── Round-Robin_seed1.png
    └── summary_comparison.png
```

---

## 🔧 Configuration

Key simulation parameters can be tuned in `app.js` (web) or `cpu_simulator_fixed.py` (desktop):

```javascript
// DVFS Operating Points
const DVFS_LEVELS = [
    { freq: 0.4, voltage: 0.60, label: 'Ultra Low Power' },
    { freq: 0.6, voltage: 0.75, label: 'Low Power' },
    { freq: 0.8, voltage: 0.90, label: 'Balanced' },
    { freq: 1.0, voltage: 1.00, label: 'Full Performance' },
];

// Hardware
const MAX_CORES        = 4;       // Number of CPU cores
const C_DYN            = 1.5;     // Dynamic capacitance
const P_STATIC         = 0.10;    // Static power per core (W)

// Thermal Model
const THERMAL_RESISTANCE  = 8.0;  // °C/W
const THERMAL_CAPACITANCE = 5.0;  // J/°C
const AMBIENT_TEMP        = 35.0; // °C
const THROTTLE_TEMP       = 75.0; // °C
const CRITICAL_TEMP       = 90.0; // °C

// Simulation
const DT           = 0.05;       // Time-step (seconds)
const SIM_DURATION = 10.0;       // Total simulation time
```

---

## 📚 Academic Context

This project demonstrates core **Operating Systems** concepts:

- **CPU Scheduling** — EDF, priority-based, and round-robin algorithms
- **Power Management** — DVFS as used in ARM big.LITTLE, Intel SpeedStep, AMD Cool'n'Quiet
- **Thermal Management** — Throttling mechanisms used in real mobile SoCs
- **Resource Allocation** — Dynamic core activation/deactivation
- **Real-Time Systems** — Hard vs soft deadline handling

### Real-World Applications

| Domain | Example |
|--------|---------|
| Mobile Phones | Qualcomm Snapdragon, Apple A-series DVFS |
| Laptops | Intel Turbo Boost / SpeedStep |
| Data Centers | Server power capping to reduce electricity costs |
| IoT & Embedded | Battery-powered sensor nodes, automotive ECUs |

---

## 🛠️ Built With

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Web Frontend** | HTML5 / CSS3 / JavaScript (ES6+) | Structure, styling, logic |
| **Web Charts** | Chart.js 4.4 | Real-time data visualization |
| **Web Fonts** | Inter, JetBrains Mono (Google Fonts) | Typography |
| **Desktop GUI** | Python 3 / Tkinter | Native desktop interface |
| **Desktop Plots** | Matplotlib | Scientific plotting & animation |
| **Computation** | NumPy | Numerical computation |

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## 👤 Author

**Aadit**

- GitHub: [@aaditrraj](https://github.com/aaditrraj)

---

## 🙏 Acknowledgments

- DVFS concepts based on research in dynamic power management for embedded systems
- Thermal model based on first-order RC approximation used in industry thermal simulators
- EDF scheduling algorithm as described in real-time systems literature
- Chart.js for powering the web-based real-time visualizations
