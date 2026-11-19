import { expect, test, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
import { request, users } from "../src/test/fixtures";

const target = request({ id: 2, name: "跨组指标核对", developer: "colleague", priority: "P0" });

async function openGantt(page: Page, theme: "light" | "dark") {
  const original = await (await page.request.get("/api/state")).json() as State;
  const me = users[0]!;
  const source = request({ developer: me.id, domain: original.domains[0]!.name });
  const state: State = {
    ...original, me, setupRequired: false,
    requests: [source, target, request({ id: 3, name: "已归档需求", archived: true })],
    users: [me, { ...me, id: target.developer, username: "协作同事", role: "admin" }],
    preferences: { ...original.preferences, theme, ui: {} },
  };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if (path === "/api/requests/1" && route.request().method() === "PUT") {
      const { request: next } = route.request().postDataJSON() as { request: ApiRequest };
      state.requests[0] = { ...next, revision: state.requests[0]!.revision + 1 };
      state.revision += 1;
      return route.fulfill({ json: state });
    }
    return route.abort();
  });
  await page.addInitScript(({ id, theme }) => {
    localStorage.setItem("rsm.theme", theme);
    localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({
      ganttRange: { start: "2026-11-09", end: "2026-12-03" }, filters: { developer: [id] },
    }));
  }, { id: me.id, theme });
  await page.goto("/");
  const row = page.locator('tr[data-row="1"]');
  await expect(row).toBeVisible();
  return { state, source, row, cell: (date: string) => row.locator(`[data-date="${date}"]`) };
}

async function pickSupport(page: Page) {
  await page.getByRole("menuitem", { name: "补位", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安排补位" });
  await expect(dialog.getByText("已归档需求", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "确认补位" })).toBeDisabled();
  await dialog.getByRole("searchbox").fill("协作同事");
  await dialog.getByText(target.name, { exact: true }).click();
  await dialog.getByRole("button", { name: "确认补位" }).click();
  await expect(dialog).toBeHidden();
}

test("可从筛选之外选择未归档需求，补位能拉伸、移动、取消和撤回", async ({ page }, testInfo) => {
  const { state, row, cell, source } = await openGantt(page, "light");
  const legend = page.getByTestId("gantt-legend");
  await expect(legend.getByText("补位", { exact: true }).locator("svg")).toBeVisible();
  await expect(page.locator('tr[data-row="2"]')).toHaveCount(0);

  const friday = cell("2026-11-20");
  await friday.click({ button: "right" });
  await pickSupport(page);
  const start = friday.locator("[data-support-bar]");
  await start.hover();
  await expect(page.getByRole("tooltip")).toHaveText(`补位 · ${target.name}`);

  const handle = (await start.locator('[data-edge="end"]').boundingBox())!;
  const tuesday = (await cell("2026-11-24").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(tuesday.x + tuesday.width - 3, handle.y + handle.height / 2, { steps: 12 });
  await expect(page.locator('[data-slot="gantt-drag-hint"]')).toHaveText("2026-11-20 至 2026-11-24");
  await page.mouse.up();
  await expect(cell("2026-11-24").locator("[data-support-bar]")).toBeVisible();
  await expect(cell("2026-11-21").locator("[data-support-bar]")).toHaveCount(0);
  await expect(cell("2026-11-22").locator("[data-support-bar]")).toHaveCount(0);

  const beforeMove = (await start.boundingBox())!;
  const monday = (await cell("2026-11-23").boundingBox())!;
  await page.mouse.move(beforeMove.x + beforeMove.width / 2, beforeMove.y + beforeMove.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(monday.x + monday.width / 2, beforeMove.y + beforeMove.height / 2, { steps: 10 });
  await page.mouse.up({ button: "right" });
  await expect(cell("2026-11-25").locator("[data-support-bar]")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect(start).toBeVisible();
  await expect(cell("2026-11-25").locator("[data-support-bar]")).toHaveCount(0);
  expect(state.requests[0]).toMatchObject({ developer: source.developer, start: source.start, delivery: source.delivery, days: source.days, segments: source.segments });
  expect(state.requests[1]).toEqual(target);

  await page.reload();
  await expect(row.locator("[data-support-bar]")).toHaveCount(3);
  await legend.screenshot({ path: testInfo.outputPath("support-legend.png") });
  await row.screenshot({ path: testInfo.outputPath("support-segment.png") });
  await start.click({ button: "right" });
  await page.getByRole("menuitem", { name: "取消补位", exact: true }).click();
  await expect(row.locator("[data-support-bar]")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(row.locator("[data-support-bar]")).toHaveCount(3);
});

test("休息日先加班才可安排补位，取消加班恢复灰底", async ({ page }) => {
  const { cell } = await openGantt(page, "dark");
  const saturday = cell("2026-11-21");
  const open = () => saturday.click({ button: "right" });
  const baseline = await saturday.evaluate((element) => getComputedStyle(element).backgroundColor);
  await open();
  await expect(page.getByRole("menuitem", { name: "补位", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "加班", exact: true }).click();
  await expect(saturday.locator('[data-marker="overtime"]')).toBeVisible();
  await open();
  await pickSupport(page);
  await expect(saturday.locator("[data-support-bar]")).toBeVisible();
  await expect(saturday.locator('[data-marker="overtime"]')).toBeVisible();

  await open();
  await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
  await expect(saturday.locator("[data-support-bar]")).toHaveCount(0);
  await expect(saturday.locator('[data-marker="overtime"]')).toHaveCount(0);
  await expect(saturday).toHaveCSS("background-color", baseline);
  await page.keyboard.press("Control+z");
  await expect(saturday.locator("[data-support-bar]")).toBeVisible();
});
