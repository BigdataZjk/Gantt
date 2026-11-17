// 真实浏览器布局验收：html/body 不允许整体滚动，仅内容区内部滚动。
// 运行：cd web && node e2e/layout-check.mjs
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.RSM_BASE_URL || "http://127.0.0.1:1111";
const PASSWORD = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";
const SHOTS = path.resolve(process.cwd(), "../.work/screenshots");
const RESULT = path.resolve(process.cwd(), "../.work/layout-check.json");
const widths = [
  { width: 1440, height: 900, label: "desktop" },
  { width: 736, height: 900, label: "tablet" },
  { width: 320, height: 720, label: "mobile" },
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(BASE + "/");
await page.waitForTimeout(500);
const login = await page.request.post(BASE + "/api/login", { data: { username: "张金科", password: PASSWORD } });
if (!login.ok()) {
  const setup = await page.request.post(BASE + "/api/setup", { data: { password: PASSWORD } });
  if (!setup.ok()) throw new Error("无法登录或初始化：" + (await login.text()) + " / " + (await setup.text()));
}
await page.goto(BASE + "/");
await page.waitForTimeout(900);

async function measure(label) {
  const metrics = await page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const body = document.body;
    return {
      docScrollHeight: doc.scrollHeight,
      docClientHeight: doc.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      bodyClientHeight: body.clientHeight,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(body).overflow,
      rootHeight: document.getElementById("root")?.getBoundingClientRect().height ?? 0,
      viewportHeight: window.innerHeight,
    };
  });
  const verticalOk = metrics.docScrollHeight <= metrics.docClientHeight + 1 && metrics.bodyScrollHeight <= metrics.bodyClientHeight + 1;
  const horizontalOk = metrics.docScrollWidth <= metrics.docClientWidth + 1;
  return { label, ...metrics, verticalOk, horizontalOk };
}

const results = [];
fs.mkdirSync(SHOTS, { recursive: true });
for (const size of widths) {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(300);
  const tabs = ["甘特图", "需求池", "已归档"];
  for (const tab of tabs) {
    await page.getByRole("button", { name: "需求", exact: true }).click();
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(350);
    results.push(await measure(size.label + ":" + tab));
    await page.screenshot({ path: path.join(SHOTS, `layout-${size.label}-${tab}.png`), fullPage: false });
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  for (const tab of ["角色权限", "个性化", "操作记录", "版本记录"]) {
    const tabButton = page.getByRole("tab", { name: tab });
    if (await tabButton.count()) {
      await tabButton.click();
      await page.waitForTimeout(300);
      results.push(await measure(size.label + ":设置-" + tab));
      await page.screenshot({ path: path.join(SHOTS, `layout-${size.label}-设置-${tab}.png`), fullPage: false });
    }
  }
}
// 窄而矮的视口：确认甘特区域可内部滚到底部记录且不撑开页面
await page.request.post(BASE + "/api/login", { data: { username: "张金科", password: PASSWORD } });
await page.goto(BASE + "/");
await page.waitForTimeout(700);
await page.getByRole("button", { name: "需求", exact: true }).click();
await page.getByRole("tab", { name: "甘特图" }).click();
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(350);
const contentScroller = page.locator("main > div").last();
await contentScroller.evaluate((node) => { if (node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight; }).catch(() => {});
await page.waitForTimeout(200);
const ganttWrap = page.locator("table[aria-label='按天显示的人员需求排期']").locator("..");
await ganttWrap.evaluate((node) => { node.scrollTop = node.scrollHeight; });
await page.waitForTimeout(350);
const scrolledRows = await page.locator("tr[data-row]").count();
const wrapMetrics = await ganttWrap.evaluate((node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }));
const shortMeasure = await measure("mobile-short:甘特图滚动到底");
results.push({ ...shortMeasure, scrolledRows, wrapMetrics });
await page.screenshot({ path: path.join(SHOTS, "layout-mobile-short-甘特图.png"), fullPage: false });

// 游客只读横幅也要保持单屏
await page.request.post(BASE + "/api/logout", { data: {} });
await page.goto(BASE + "/");
await page.waitForTimeout(700);
for (const size of widths) {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(250);
  results.push(await measure(size.label + ":游客横幅"));
  await page.screenshot({ path: path.join(SHOTS, `layout-${size.label}-游客.png`), fullPage: false });
}

fs.mkdirSync(path.dirname(RESULT), { recursive: true });
fs.writeFileSync(RESULT, JSON.stringify(results, null, 2));
for (const item of results) console.log(item.label, "vertical", item.verticalOk, "horizontal", item.horizontalOk, "doc", item.docScrollHeight + "/" + item.docClientHeight, "body", item.bodyScrollHeight + "/" + item.bodyClientHeight, item.htmlOverflow, item.bodyOverflow);
const failed = results.filter((item) => !item.verticalOk || !item.horizontalOk);
await browser.close();
if (failed.length) {
  console.error("[layout] FAILED", failed.map((item) => item.label));
  process.exitCode = 1;
} else {
  console.log("[layout] PASS", results.length, "cases");
}
