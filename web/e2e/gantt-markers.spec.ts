import { expect, test, type Page } from "@playwright/test";
import type { Density, State } from "../src/api/types";
import { request } from "../src/test/fixtures";

async function openMarkers(page: Page, theme: "light" | "dark", density: Density) {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const state = await response.json() as State;
  const base = { developer: state.users[0]!.id, domain: state.domains[0]!.name };
  const segmented = (id: number, name: string, end: string, next: string, holdBefore = true) => request({
    ...base, id, name, start: "2026-11-16", delivery: next,
    segments: [
      { start: "2026-11-16", end, holdBefore: false },
      { start: next, end: next, holdBefore },
    ],
  });
  const mocked: State = {
    ...state,
    me: null,
    setupRequired: false,
    preferences: { ...state.preferences, theme, density },
    requests: [
      segmented(1, "HOLD 单日", "2026-11-17", "2026-11-19"),
      segmented(2, "HOLD 偶数日", "2026-11-17", "2026-11-20"),
      segmented(3, "HOLD 跨周末", "2026-11-19", "2026-11-24"),
      segmented(4, "普通周末空档", "2026-11-20", "2026-11-23"),
      segmented(5, "未标暂停空档", "2026-11-17", "2026-11-20", false),
      request({ ...base, id: 6, name: "待估与加班休假", status: "开发中", start: "2026-11-16", delivery: "2026-11-23", days: 0, vacation: ["2026-11-18"], overtime: ["2026-11-21"] }),
      request({ ...base, id: 7, name: "未排期休假", start: "", delivery: "", vacation: ["2026-11-18"] }),
      segmented(8, "HOLD 长间隔", "2026-11-17", "2026-12-16"),
    ],
  };
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: mocked });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if (route.request().method() !== "GET") {
      writes.push(path);
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(({ theme }) => {
    localStorage.setItem("rsm.theme", theme);
    localStorage.setItem("rsm.ui.v2:guest", JSON.stringify({ ganttRange: { start: "2026-11-16", end: "2027-01-31" } }));
  }, { theme });
  await page.goto("/");
  const wrap = page.locator('[data-scroll-container="gantt"]');
  await expect(wrap.locator("table")).toHaveAttribute("data-marker-mode", "icon");
  return { wrap, writes, errors };
}

for (const theme of ["light", "dark"] as const) {
  for (const density of ["compact", "comfortable"] as const) {
    test(`HOLD 居中连接排期，所有标记按缩放简化并恢复（${theme}/${density}）`, async ({ page }, testInfo) => {
      const { wrap, writes, errors } = await openMarkers(page, theme, density);
      const table = wrap.locator("table");
      const checkHold = async (id: number) => {
        const row = wrap.locator(`tr[data-row="${id}"]`);
        const left = (await row.locator('[data-bar][data-phase="0"]').last().boundingBox())!;
        const right = (await row.locator('[data-bar][data-phase="1"]').first().boundingBox())!;
        const marker = (await row.locator('[data-marker="hold"]').boundingBox())!;
        expect(Math.abs(marker.x + marker.width / 2 - (left.x + left.width + right.x) / 2)).toBeLessThan(1);
        expect(Math.abs(marker.y + marker.height / 2 - left.y - left.height / 2)).toBeLessThan(1);
        const lines = await row.locator("[data-hold-connector]").evaluateAll((cells) => cells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          const line = getComputedStyle(cell, "::before");
          return { x: rect.x, right: rect.right, y: rect.y + parseFloat(line.top), height: parseFloat(line.height) };
        }));
        expect(Math.abs(lines[0]!.x - left.x - left.width)).toBeLessThan(1);
        expect(Math.abs(lines.at(-1)!.right - right.x)).toBeLessThan(1);
        lines.forEach((line, index) => {
          expect(line.height).toBe(1);
          expect(Math.abs(line.y - left.y - left.height / 2)).toBeLessThan(1);
          if (index) expect(Math.abs(line.x - lines[index - 1]!.right)).toBeLessThan(1);
        });
      };
      for (const id of [1, 2, 3]) await checkHold(id);
      for (const id of [4, 5]) await expect(wrap.locator(`tr[data-row="${id}"] [data-hold-connector]`)).toHaveCount(0);
      for (const kind of ["hold", "estimated", "overtime", "leave", "parallel"]) {
        await expect(wrap.locator(`[data-marker="${kind}"]`).first()).toBeVisible();
        await expect(wrap.locator(`[data-marker="${kind}"] svg`).first()).toBeVisible();
      }
      await expect(wrap.locator('tr[data-row="6"] [data-date="2026-11-18"] [data-marker="leave"]')).toBeVisible();
      await expect(wrap.locator('tr[data-row="7"] [data-marker="leave"]')).toBeVisible();
      const legend = page.getByTestId("gantt-legend");
      const legendBox = await legend.boundingBox();
      const legendArrow = legend.locator('[class*="parallelSymbol"]');
      expect((await legendArrow.boundingBox())!.width).toBe(18);
      await page.mouse.move(0, 0);
      await wrap.screenshot({ path: testInfo.outputPath("markers-normal.png") });

      const bounds = (await wrap.boundingBox())!;
      const zoom = async (delta: number) => {
        await page.mouse.move(bounds.x + 196, bounds.y + 85);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, delta);
        await page.keyboard.up("Control");
      };
      await zoom(300);
      await expect(table).toHaveAttribute("data-marker-mode", "tick");
      await expect(wrap.locator("[data-marker] svg")).toHaveCount(0);
      for (const kind of ["hold", "estimated", "overtime", "leave", "parallel"]) {
        const marker = wrap.locator(`[data-marker="${kind}"]`).first();
        await expect(marker).toBeVisible();
        expect((await marker.boundingBox())!.width).toBeLessThanOrEqual(5);
      }
      for (const id of [1, 2, 3]) await checkHold(id);
      const colors = await wrap.locator('[class*="parallelTicks"]').first().evaluate((element) => [getComputedStyle(element, "::before").backgroundColor, getComputedStyle(element, "::after").backgroundColor]);
      expect(colors[0]).not.toEqual(colors[1]);
      await page.mouse.move(0, 0);
      await wrap.screenshot({ path: testInfo.outputPath("markers-small.png") });

      await zoom(1000);
      await expect(table).toHaveAttribute("data-marker-mode", "hidden");
      await expect(wrap.locator("[data-marker]")).toHaveCount(0);
      await expect(wrap.locator('[class*="floatingPoints"]')).toHaveCount(0);
      await expect(wrap.locator('[data-date="2026-11-21"]').filter({ has: page.locator("[data-bar]") }).first()).toHaveAttribute("aria-label", /加班/);
      expect((await legendArrow.boundingBox())!.width).toBe(18);
      expect(await legend.boundingBox()).toEqual(legendBox);
      await page.getByRole("button", { name: "重置比例", exact: true }).click();
      await expect(table).toHaveAttribute("data-marker-mode", "icon");
      for (const id of [1, 2, 3]) await checkHold(id);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test("HOLD 中点随日期冻结在原处，横向虚拟化不在可见空档另补图标", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  const { wrap, writes, errors } = await openMarkers(page, "light", "compact");
  const marker = wrap.locator('tr[data-row="8"] [data-marker="hold"]');
  await expect(marker).toBeVisible();
  const normal = (await marker.boundingBox())!;
  await wrap.evaluate((el) => { el.scrollLeft = 180; });
  await expect.poll(async () => (await marker.boundingBox())!.x).toBeCloseTo(normal.x - 180, 0);
  await wrap.evaluate((el) => { el.scrollLeft = 1000; });
  await expect(marker).toHaveCount(0);
  await wrap.evaluate((el) => { el.scrollLeft = 0; });
  await expect(marker).toBeVisible();
  expect(Math.abs((await marker.boundingBox())!.x - normal.x)).toBeLessThan(1);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
