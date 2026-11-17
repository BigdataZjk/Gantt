import { expect, test, type Locator } from "@playwright/test";
import type { State } from "../src/api/types";

const filters = ["业务域", "需求类型", "状态", "开发人"];

async function clickRowEnd(row: Locator) {
  const box = (await row.boundingBox())!;
  await row.click({ position: { x: box.width - 3, y: box.height / 2 } });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.goto("/");
});

test("三个需求页的所有筛选均支持空白、文字、复选框和键盘切换", async ({ page }) => {
  for (const tab of ["甘特图", "需求池", "已归档"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    for (const filter of filters) {
      await page.getByRole("button", { name: `${filter}：全部`, exact: true }).click();
      const panel = page.getByRole("dialog");
      await expect(panel.getByRole("button", { name: /^(确认|取消)$/ })).toHaveCount(0);
      const option = panel.getByRole("checkbox").nth(1);
      const row = option.locator("..");
      const name = (await option.getAttribute("aria-label"))!;
      await clickRowEnd(row);
      await expect(option).toBeChecked();
      await expect(panel).toBeVisible();
      await expect(page.getByRole("button", { name: `${filter}：${name}`, exact: true })).toBeVisible();
      const mark = await option.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const icon = el.querySelector("svg")!.getBoundingClientRect();
        return { width: icon.width, height: icon.height, x: icon.x + icon.width / 2 - box.x - box.width / 2, y: icon.y + icon.height / 2 - box.y - box.height / 2 };
      });
      expect(mark.width).toBeLessThanOrEqual(11);
      expect(mark.height).toBeLessThanOrEqual(11);
      expect(mark.x).toBeCloseTo(0);
      expect(mark.y).toBeCloseTo(0);
      await row.getByText(name, { exact: true }).click();
      await expect(option).not.toBeChecked();
      await expect(page.getByRole("button", { name: `${filter}：全部`, exact: true })).toBeVisible();
      await option.click();
      await expect(option).toBeChecked();
      await option.press("Space");
      await expect(option).not.toBeChecked();

      const all = panel.getByRole("checkbox", { name: "全部", exact: true });
      const count = await panel.getByRole("checkbox").count();
      await clickRowEnd(all.locator(".."));
      await expect.poll(() => panel.getByRole("checkbox", { checked: true }).count()).toBe(count);
      await clickRowEnd(all.locator(".."));
      await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(panel).not.toBeVisible();
    }
  }
});

test("筛选即时更新且关闭不撤销，刷新保留，日夜和窄屏下拉紧凑可达", async ({ page }, testInfo) => {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const state = await response.json() as State;
  const active = state.requests.filter((row) => !row.archived);
  const waitingCount = active.filter((row) => row.status === "待开发").length;
  const holdCount = active.filter((row) => row.status === "HOLD").length;
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  const table = page.getByRole("table", { name: "需求列表", exact: true });
  await page.getByRole("button", { name: "状态：全部", exact: true }).click();
  const panel = page.getByRole("dialog");
  const waiting = panel.getByRole("checkbox", { name: "待开发", exact: true });
  await clickRowEnd(waiting.locator(".."));
  await expect(panel).toBeVisible();
  await expect(page.getByRole("button", { name: "状态：待开发", exact: true })).toBeVisible();
  await expect(table).toHaveAttribute("aria-rowcount", String(waitingCount + 1));
  const hold = panel.getByRole("checkbox", { name: "HOLD", exact: true });
  await hold.click();
  await expect(page.getByRole("button", { name: "状态：2 项", exact: true })).toBeVisible();
  await expect(table).toHaveAttribute("aria-rowcount", String(waitingCount + holdCount + 1));
  await hold.click();
  await expect(table).toHaveAttribute("aria-rowcount", String(waitingCount + 1));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "状态：待开发", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "状态：待开发", exact: true }).click();
  await expect(waiting).toBeChecked();
  await expect(table).toHaveAttribute("aria-rowcount", String(waitingCount + 1));
  await clickRowEnd(waiting.locator(".."));
  await expect(table).toHaveAttribute("aria-rowcount", String(active.length + 1));
  await clickRowEnd(panel.getByRole("checkbox", { name: "全部", exact: true }).locator(".."));
  await expect(table).toHaveAttribute("aria-rowcount", String(active.length + 1));
  await expect(page.getByRole("button", { name: "状态：全部", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  for (const [width, height, theme] of [[1440, 900, "light"], [1440, 900, "dark"], [320, 568, "dark"], [390, 844, "light"]] as const) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByRole("switch", { name: /切换为.*模式/ }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const filter of filters) {
      await page.getByRole("button", { name: `${filter}：全部`, exact: true }).click();
      const box = (await panel.boundingBox())!;
      expect(box.width).toBeGreaterThan(0);
      expect(box.width).toBeLessThanOrEqual(width - 16);
      if (filter === "状态") {
        expect(box.width).toBeLessThan(128);
        if (width === 1440) await page.screenshot({ path: testInfo.outputPath(`compact-filters-${theme}.png`) });
      }
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      await expect(panel.getByRole("button", { name: /^(确认|取消)$/ })).toHaveCount(0);
      expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
      await page.keyboard.press("Escape");
    }
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  }
});

test("筛选列表按当前最长值自动变宽或收窄，仅受屏幕边界限制", async ({ page }) => {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const state = await response.json() as State;
  let name = "域";
  await page.route("**/api/state", (route) => route.fulfill({
    json: { ...state, domains: [{ ...state.domains[0]!, name }] },
  }));
  const widths: number[] = [];
  for (const value of ["域", "增长归因数据域", "增长归因跨团队协作与数仓研发需求统一排期业务域", "域"]) {
    name = value;
    await page.reload();
    await page.getByRole("button", { name: "业务域：全部", exact: true }).click();
    const panel = page.getByRole("dialog");
    const box = (await panel.boundingBox())!;
    widths.push(box.width);
    const tag = panel.locator('[data-dict-field="domain"]');
    expect(await tag.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    await page.keyboard.press("Escape");
  }
  expect(widths[1]).toBeGreaterThan(widths[0]);
  expect(widths[2]).toBeGreaterThan(widths[1]);
  expect(widths[2]).toBeGreaterThan(280);
  expect(widths[3]).toBe(widths[0]);

  await page.setViewportSize({ width: 320, height: 568 });
  name = "增长归因跨团队协作与数仓研发需求统一排期业务域";
  await page.reload();
  await page.getByRole("button", { name: "业务域：全部", exact: true }).click();
  const panel = page.getByRole("dialog");
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(304);
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(312);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBeTruthy();
});
