// 受控 180 条需求、一年范围；仅读取日历与公共配置，全部交互在浏览器内模拟。
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = process.env.RSM_PERF_URL || "http://127.0.0.1:1111";
const output = path.resolve(root, process.env.RSM_PERF_OUTPUT || ".work/performance-ui/results.json");
const modes = (process.env.RSM_PERF_MODES || "normal").split(",");
const browser = await chromium.launch();
const results = [];

function frameSummary(frames, phase) {
  const times = frames.filter((frame) => frame.phase === phase).map((frame) => frame.dt).sort((a, b) => a - b);
  return { frames: times.length, p50: times[Math.floor(times.length * 0.5)], p95: times[Math.floor(times.length * 0.95)], max: times.at(-1), over24: times.filter((time) => time > 24).length };
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const response = await context.request.get(`${base}/api/state`);
  if (!response.ok()) throw new Error("无法读取预览配置，请先启动开发服务");
  const original = await response.json();
  const me = { id: "perf-owner", username: "性能验收", role: "superadmin", deleted: false, disabled: false, avatar: "" };
  const requests = Array.from({ length: 180 }, (_, index) => ({
    id: 50000 + index, revision: 1, name: `流畅度验收 ${index}`, priority: "P1", status: "待开发",
    prd: "https://example.test/prd", requester: "性能验收", requestedAt: "2027-01-20",
    domain: original.domains[0]?.name ?? "", requestType: "常规需求", wangyue: "", developer: me.id,
    days: 22, start: "2027-01-20", delivery: "2027-02-20", project: "", brd: "", review: "", expected: "", notes: "",
    segments: [], vacation: [], overtime: [], archived: false,
  }));

  for (const theme of ["light", "dark"]) {
    for (const mode of modes) {
      const page = await context.newPage();
      const state = { ...original, me, users: [me], setupRequired: false, requests, logs: [], versions: [], preferences: { ...original.preferences, theme } };
      await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/api/state") await route.fulfill({ json: state });
        else if (pathname === "/api/presence") await route.fulfill({ json: { users: [], guests: 0 } });
        else await route.abort();
      });
      await page.addInitScript(({ id, theme }) => {
        localStorage.setItem("rsm.theme", theme);
        localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({ ganttRange: { start: "2027-01-01", end: "2027-12-31" } }));
      }, { id: me.id, theme });
      await page.goto(base);
      await page.getByRole("tab", { name: "甘特图", exact: true }).waitFor();
      if (mode === "no-blur" || mode === "both") await page.addStyleTag({ content: "* {backdrop-filter:none!important;-webkit-backdrop-filter:none!important}" });
      if (mode === "no-background" || mode === "both") await page.addStyleTag({ content: '[data-slot="grid-background"],[data-slot="rain-background"]{display:none!important}[data-slot="rain-drop"]{animation:none!important}' });
      await page.waitForTimeout(700);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      const before = (await cdp.send("Performance.getMetrics")).metrics;
      await page.evaluate(() => {
        window.__perf = { frames: [], longTasks: [], phase: "drawer", last: 0 };
        window.__observer = new PerformanceObserver((list) => window.__perf.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration }))));
        window.__observer.observe({ entryTypes: ["longtask"] });
        const tick = (now) => {
          const record = window.__perf;
          if (record.last) record.frames.push({ phase: record.phase, dt: now - record.last });
          record.last = now;
          window.__raf = requestAnimationFrame(tick);
        };
        window.__raf = requestAnimationFrame(tick);
      });
      await page.getByRole("button", { name: "新增需求", exact: true }).click();
      await page.getByRole("dialog", { name: "新增需求", exact: true }).waitFor();
      await page.waitForTimeout(550);
      await page.getByRole("button", { name: "收起面板", exact: true }).click();
      await page.waitForTimeout(280);
      await page.evaluate(async () => {
        window.__perf.phase = "scroll";
        const wrap = document.querySelector('[data-scroll-container="gantt"]');
        const start = performance.now();
        await new Promise((resolve) => {
          const move = (now) => {
            wrap.scrollTop += 9;
            wrap.scrollLeft += 6;
            if (now - start > 1600) resolve();
            else requestAnimationFrame(move);
          };
          requestAnimationFrame(move);
        });
        cancelAnimationFrame(window.__raf);
        window.__observer.disconnect();
      });
      const record = await page.evaluate(() => ({ ...window.__perf, nodes: document.querySelectorAll("*").length }));
      const after = (await cdp.send("Performance.getMetrics")).metrics;
      const metrics = {};
      for (const name of ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"]) {
        metrics[name] = (after.find((metric) => metric.name === name)?.value ?? 0) - (before.find((metric) => metric.name === name)?.value ?? 0);
      }
      const summary = { theme, mode, nodes: record.nodes, longTasks: record.longTasks, metrics, drawer: frameSummary(record.frames, "drawer"), scroll: frameSummary(record.frames, "scroll") };
      results.push(summary);
      console.log(JSON.stringify(summary));
      await page.close();
    }
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ environment: "Chromium headless, 1440×900, DPR 2; requestAnimationFrame intervals, not a device-wide FPS guarantee", results }, null, 2));
  console.log(`结果已写入 ${output}`);
} finally {
  await browser.close();
}
