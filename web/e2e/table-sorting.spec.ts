import { expect, test, type Page } from "@playwright/test";
import type { State } from "../src/api/types";
import { calendar, domains, request, users } from "../src/test/fixtures";

async function openTable(page: Page, archive: boolean) {
  const original = await (await page.request.get("/api/state")).json() as State;
  const rows = [
    request({ id: 1, name: "需求10", domain: "广告域", days: 10 }),
    request({ id: 2, name: "需求2", domain: "广告域", days: 2 }),
    request({ id: 3, name: "需求3", domain: "流量域", days: 3 }),
    request({ id: 4, name: "需求4", domain: "流量域", days: 2 }),
  ];
  const state: State = { ...original, setupRequired: false, me: null, users, domains, calendar, requests: rows.flatMap((row) => [
    { ...row, poolEnteredAt: `2026-11-18T00:00:0${row.id}Z` },
    { ...row, id: row.id + 10, archived: true, archivedAt: `2026-11-18T01:00:0${5 - row.id}Z` },
  ]) };
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.addInitScript(({ archive }) => {
    const key = "rsm.ui.v2:guest";
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ requirementTab: archive ? "archive" : "pool", visibleColumns: ["name", "domain", "days"], archiveVisibleColumns: ["name", "domain", "days"] }));
  }, { archive });
  await page.goto("/");
}

const ids = (page: Page) => page.locator('[data-scroll-container="table"] [data-row]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.row)));

for (const archive of [false, true]) {
  test(`${archive ? "归档" : "需求池"}表头级联排序、切换方向、持久化与一键重置`, async ({ page }, testInfo) => {
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && /^\/api\/(requests|preferences)/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await openTable(page, archive);
    const offset = archive ? 10 : 0;
    const reset = page.getByRole("button", { name: "重置排序", exact: true });
    await expect.poll(() => ids(page)).toEqual(archive ? [11, 12, 13, 14] : [4, 3, 2, 1]);
    await expect(reset).toHaveCount(0);
    const domain = page.getByRole("columnheader").getByRole("button", { name: /^业务域，/ });
    const days = page.getByRole("columnheader").getByRole("button", { name: /^开发人天，/ });
    await domain.click();
    await expect(reset).toBeVisible();
    await days.click();
    await expect.poll(() => ids(page)).toEqual([2, 1, 4, 3].map((id) => id + offset));
    await expect(domain).toHaveAccessibleName(/第 1 排序，升序/);
    await expect(days).toHaveAccessibleName(/第 2 排序，升序/);
    await expect(domain.locator("..")).toHaveAttribute("aria-sort", "ascending");
    await domain.click();
    await expect.poll(() => ids(page)).toEqual([4, 3, 2, 1].map((id) => id + offset));
    await page.screenshot({ path: testInfo.outputPath("multi-sort.png") });
    await page.getByRole("tab", { name: archive ? "需求池" : "已归档", exact: true }).click();
    await expect(reset).toHaveCount(0);
    await page.getByRole("tab", { name: archive ? "已归档" : "需求池", exact: true }).click();
    await expect(domain).toHaveAccessibleName(/第 1 排序，降序/);
    await page.reload();
    await expect(domain).toHaveAccessibleName(/第 1 排序，降序/);
    await days.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => ids(page)).toEqual([3, 4, 1, 2].map((id) => id + offset));
    await reset.click();
    await expect(reset).toHaveCount(0);
    await expect.poll(() => ids(page)).toEqual(archive ? [11, 12, 13, 14] : [4, 3, 2, 1]);
    await page.getByRole("columnheader").getByRole("button", { name: /^需求名称，/ }).click();
    await expect.poll(() => ids(page)).toEqual([2, 3, 4, 1].map((id) => id + offset));
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });
}
