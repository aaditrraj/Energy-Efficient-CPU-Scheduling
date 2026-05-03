const { JSDOM } = require("jsdom");
const fs = require("fs");

const html = fs.readFileSync("index.html", "utf-8");
const appJs = fs.readFileSync("app.js", "utf-8");

const dom = new JSDOM(html, { runScripts: "dangerously" });

dom.window.Chart = class Chart {
    constructor(ctx, cfg) {
        this.data = cfg.data || { datasets: [{data: []}] };
        this.options = cfg.options;
    }
    update() {}
    destroy() {}
};

dom.window.HTMLCanvasElement.prototype.getContext = () => {
    return {};
};

dom.window.requestAnimationFrame = (cb) => { setTimeout(cb, 16); return 1; };
dom.window.cancelAnimationFrame = () => {};

const scriptEl = dom.window.document.createElement("script");
scriptEl.textContent = appJs;
dom.window.document.body.appendChild(scriptEl);

// Manually trigger DOMContentLoaded since we are injecting script into a ready DOM
const event = dom.window.document.createEvent("Event");
event.initEvent("DOMContentLoaded", true, true);
dom.window.document.dispatchEvent(event);

setTimeout(() => {
    try {
        const app = dom.window.eatsApp;
        if (!app) {
            console.error("eatsApp not found on window object");
            // Try to initialize it manually
            // dom.window.eatsApp = new dom.window.EATSApp();
            return;
        }
        console.log("App initialized. Scheduler type: ", app.schedulerSelect.value);
        console.log("Clicking start button...");
        const btnStart = dom.window.document.getElementById("btnStart");
        if (btnStart) {
            btnStart.click();
            
            setTimeout(() => {
                if (app.scheduler) {
                    console.log("Simulation started. Time: ", app.scheduler.now);
                    console.log("Running a few steps...");
                    for(let i=0; i<10; i++) app.scheduler.step(0.05);
                    console.log("Energy: ", app.scheduler.energy);
                    console.log("Temp: ", app.scheduler.temperature);
                    app.pause();
                    app.schedulerSelect.value = "priority";
                    app.start();
                    if (app.scheduler.name !== "Priority-Preemptive") {
                        throw new Error("Priority scheduler selection failed");
                    }
                    app.pause();
                    console.log("Success: Schedulers working with new logic.");
                    process.exit(0);
                } else {
                    console.error("Scheduler not initialized after start click");
                    process.exit(1);
                }
            }, 200);
        } else {
            console.error("btnStart not found");
            process.exit(1);
        }
    } catch (e) {
        console.error("ERROR: ", e);
        process.exit(1);
    }
}, 500);
