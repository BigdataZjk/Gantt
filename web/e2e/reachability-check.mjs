// 真实浏览器可达性确认（含游客横幅 + 真实库数据 + 320x568 矮屏）
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RSM_BASE_URL || "http://127.0.0.1:1111";
const SHOTS = path.resolve(process.cwd(), "../.work/screenshots");
const RESULT = path.resolve(process.cwd(), "../.work/reachability-check.json");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
const page = await context.newPage();
await page.request.post(BASE + "/api/logout", { data: {} });
await page.goto(BASE + "/");
await page.waitForTimeout(900);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function layout() {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) };
    };
    const scroller = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      return { scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, scrollTop: node.scrollTop, overflowY: getComputedStyle(node).overflowY };
    };
    const doc = document.scrollingElement || document.documentElement;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      doc: { scrollHeight: doc.scrollHeight, clientHeight: doc.clientHeight, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
      body: { scrollHeight: document.body.scrollHeight, clientHeight: document.body.clientHeight, overflow: getComputedStyle(document.body).overflow },
      topbar: rect("header"),
      nav: rect('nav[aria-label="主导航"]'),
      legend: rect('[data-testid="gantt-legend"]'),
      guestBanner: rect("main > div:first-child"),
      content: scroller('[data-scroll-container="requests-content"]'),
      gantt: scroller('[data-scroll-container="gantt"]'),
    };
  });
}

const results = [];
fs.mkdirSync(SHOTS, { recursive: true });
await page.getByRole("tab", { name: "甘特图" }).click();
await page.waitForTimeout(500);
let info = await layout();
assert(info.legend, "甘特图图例不存在");
assert(info.legend.top >= 0 && info.legend.bottom <= info.viewport.height + 1, "甘特图图例超出视窗: " + JSON.stringify(info.legend));
assert(info.topbar.top >= 0 && info.topbar.bottom <= info.viewport.height + 1, "顶栏超出视窗");
assert(info.nav.top >= 0 && info.nav.bottom <= info.viewport.height + 1, "导航超出视窗");
assert(info.doc.scrollHeight <= info.doc.clientHeight + 1, "document 出现整体滚动");
assert(info.body.scrollHeight <= info.body.clientHeight + 1, "body 出现整体滚动");
assert(info.content && info.content.clientHeight > 0, "主内容区无高度");
results.push({ view: "320x568 游客甘特图", ...info });
await page.screenshot({ path: path.join(SHOTS, "reachability-320x568-guest-gantt.png") });

// 甘特内容可内部滚动，且滚到底仍有表格行
const gantt = page.locator('[data-scroll-container="gantt"]');
const content = page.locator('[data-scroll-container="requests-content"]');
await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(250);
await gantt.evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(400);
const rowsAtBottom = await page.locator("tr[data-row]").count();
const ganttAfter = await gantt.evaluate((node) => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, bottom: node.getBoundingClientRect().bottom }));
assert(rowsAtBottom > 0, "甘特滚到底后无可见行");
results.push({ view: "320x568 甘特内部滚到底", rowsAtBottom, gantt: ganttAfter });
await page.screenshot({ path: path.join(SHOTS, "reachability-320x568-gantt-bottom.png") });

// 需求池：表格内部滚到最后一行
await page.getByRole("tab", { name: "需求池" }).click();
await page.waitForTimeout(400);
const table = page.locator('[data-scroll-container="table"]');
await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(200);
await table.evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(400);
const poolRows = await page.locator('[role="table"] [role="row"][data-row]').count();
const tableInfo = await table.evaluate((node) => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, bottom: node.getBoundingClientRect().bottom }));
assert(poolRows > 0 && tableInfo.scrollTop + tableInfo.clientHeight >= tableInfo.scrollHeight - 2, "需求池无法滚到最后记录");
results.push({ view: "320x568 游客需求池滚到底", poolRows, table: tableInfo });

// 已归档
await page.getByRole("tab", { name: "已归档" }).click();
await page.waitForTimeout(400);
await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(250);
results.push({ view: "320x568 游客已归档", ...(await layout()) });

// 设置：内部内容滚动到最后
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.getByRole("tab", { name: "操作记录" }).click();
await page.waitForTimeout(400);
const settings = page.locator('[data-scroll-container="settings-content"]');
const settingsInfo = await settings.evaluate((node) => {
  const before = { scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
  node.scrollTop = node.scrollHeight;
  const last = node.lastElementChild?.getBoundingClientRect();
  return { ...before, scrollTop: node.scrollTop, lastBottom: last ? Math.round(last.bottom) : null };
});
await page.waitForTimeout(250);
assert(settingsInfo.scrollHeight <= settingsInfo.clientHeight + 1 || settingsInfo.scrollTop > 0, "设置内容不可滚动");
results.push({ view: "320x568 设置操作记录", settings: settingsInfo, layout: await layout() });
await page.screenshot({ path: path.join(SHOTS, "reachability-320x568-settings-bottom.png") });

fs.writeFileSync(RESULT, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map((item) => ({ view: item.view, legend: item.legend, topbar: item.topbar, nav: item.nav, doc: item.doc, content: item.content })), null, 2));
await browser.close();
console.log("[reachability] PASS");
