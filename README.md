# ⚡ EATS — Energy-Aware Thermal CPU Scheduler

> An energy-efficient CPU scheduling simulator using **DVFS** and **thermal-aware scheduling** for mobile and embedded systems.

![Python](https://img.shields.io/badge/Python-3.8%2B-3776AB?logo=python&logoColor=white)
![Tkinter](https://img.shields.io/badge/GUI-Tkinter-blue)
![Matplotlib](https://img.shields.io/badge/Plots-Matplotlib-orange)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 📌 About

This project demonstrates an **Energy-Efficient CPU Scheduling Algorithm** that balances performance and power consumption using:

- **DVFS (Dynamic Voltage and Frequency Scaling)** — dynamically adjusts CPU frequency and voltage based on workload
- **Thermal-Aware Scheduling** — monitors die temperature and throttles frequency to prevent overheating
- **Priority-Based Task Dispatching** — ensures critical tasks meet deadlines while saving energy on background work
- **Dynamic Core Management** — activates only the cores needed, reducing static/leakage power

The simulator provides a real-time animated GUI comparing three scheduling strategies to demonstrate the energy savings achieved by the proposed algorithm.

---

## 🎯 Problem Statement

Modern mobile and embedded processors waste significant energy by running at maximum performance when the workload doesn't demand it. This project designs a CPU scheduling method that:

1. **Saves energy** by selecting the lowest frequency/voltage that still meets deadlines
2. **Manages thermals** by proactively throttling before hitting dangerous temperatures
3. **Maintains performance** by prioritizing critical tasks and using EDF (Earliest Deadline First) scheduling

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
- Ambient temperature: 35°C
- Throttle threshold: 75°C (begin soft throttling)
- Critical threshold: 90°C (force minimum frequency)

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

## 🖥️ Screenshots

The simulator provides 6 real-time plots:

| Plot | Description |
|------|-------------|
| Cumulative Energy (J) | Total energy consumed — lower is better |
| CPU Temperature (°C) | Die temp with throttle/critical threshold lines |
| DVFS Frequency | Current operating frequency over time |
| Active Cores | Number of active cores (1–4) |
| CPU Utilization | How busy the CPU is (0–100%) |
| Instantaneous Power (W) | Real-time power draw |

---

## 🚀 Getting Started

### Prerequisites

- Python 3.8 or higher
- pip (Python package manager)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/eats-cpu-scheduler.git
cd eats-cpu-scheduler

# Install dependencies
pip install matplotlib numpy
```

> **Note:** `tkinter` comes pre-installed with Python on most systems. If missing, install it via your package manager.

### Running the Simulator

```bash
python cpu_simulator_fixed.py
```

---

## 🎮 How to Use

| Button | Action |
|--------|--------|
| **Start** | Run the selected scheduler with animated real-time plots |
| **Pause** | Pause the running simulation |
| **Reset** | Clear plots and reset to initial state |
| **Compare All** | Run all 3 schedulers on identical workload and compare side-by-side |
| **Batch Run** | Test across 5 seeds, export CSV + graphs for analysis |

### Controls

- **Scheduler** — Choose EATS, Performance-First, or Round-Robin
- **Seed** — Random seed for workload generation (change for different task sets)
- **Tasks** — Number of tasks to generate (default: 30)
- **Speed** — Animation speed multiplier (0.25× to 4×)

---

## 📈 Sample Results

Running **Compare All** with default settings (Seed=1, 30 tasks):

```
EATS saves ~55% energy vs Performance-First
EATS peak temperature: ~45°C  vs  Performance-First: ~70°C
```

### Batch Run Output

The batch run generates:
- `results.csv` — Tabular data for all runs
- `batch_graphs/` — Individual energy + temperature plots per run
- `batch_graphs/summary_comparison.png` — Averaged bar chart comparison

---

## 📁 Project Structure

```
eats-cpu-scheduler/
│
├── cpu_simulator_fixed.py   # Main simulator (all-in-one)
├── README.md                # This file
└── batch_graphs/            # Generated after batch run
    ├── EATS_Proposed_seed1.png
    ├── Performance-First_seed1.png
    ├── Round-Robin_seed1.png
    ├── ...
    └── summary_comparison.png
```

---

## 🔧 Configuration

Key simulation parameters can be tuned at the top of `cpu_simulator_fixed.py`:

```python
# DVFS Operating Points
DVFS_LEVELS = [
    (0.4, 0.60),   # (frequency, voltage)
    (0.6, 0.75),
    (0.8, 0.90),
    (1.0, 1.00),
]

# Hardware
MAX_CORES     = 4        # Number of CPU cores
C_DYN         = 1.5      # Dynamic capacitance
P_STATIC      = 0.10     # Static power per core (W)

# Thermal Model
THERMAL_RESISTANCE  = 8.0    # °C/W
THERMAL_CAPACITANCE = 5.0    # J/°C
AMBIENT_TEMP        = 35.0   # °C
THROTTLE_TEMP       = 75.0   # °C
CRITICAL_TEMP       = 90.0   # °C

# Simulation
DT           = 0.05     # Time-step (seconds)
SIM_DURATION = 10.0     # Total simulation time
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

- **Python 3** — Core language
- **Tkinter** — Native GUI framework
- **Matplotlib** — Scientific plotting and animation
- **NumPy** — Numerical computation

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## 👤 Author

**Aadit**

- GitHub: [@yourusername](https://github.com/yourusername)

---

## 🙏 Acknowledgments

- DVFS concepts based on research in dynamic power management for embedded systems
- Thermal model based on first-order RC approximation used in industry thermal simulators
- EDF scheduling algorithm as described in real-time systems literature
