import { mockRequestHistory, operationToReverse } from "./request-history-fixture";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
import { request, users } from "../src/test/fixtures";

const target = request({ id: 2, name: "跨组指标核对", developer: "colleague", priority: "P0" });

interface GanttFixtures {
  source?: Partial<ApiRequest>;
  extraRequests?: ApiRequest[];
  sourceColor?: string;
}

async function openGantt(page: Page, theme: "light" | "dark", fixtures: GanttFixtures = {}) {
  const original = await (await page.request.get("/api/state")).json() as State;
  const me = users[0]!;
  const source = request({ developer: me.id, domain: original.domains[0]!.name, ...fixtures.source });
  const state: State = {
    ...original, me, setupRequired: false,
    requests: [source, target, request({ id: 3, name: "已归档需求", archived: true }), ...(fixtures.extraRequests ?? [])],
    users: [me, { ...me, id: target.developer, username: "协作同事", role: "admin" }],
    preferences: {
      ...original.preferences,
      theme,
      ui: {},
      domainColors: fixtures.sourceColor ? { [source.domain]: fixtures.sourceColor } : {},
    },
  };
  const history = mockRequestHistory(state, (changes) => {
    state.requests[0] = { ...changes[0]!, revision: state.requests[0]!.revision + 1 };
    state.revision += 1;
  });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    const operation = operationToReverse(path);
    if (operation) return history.reverse(route, operation);
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if (path === "/api/requests/1" && route.request().method() === "PUT") {
      const { request: next } = route.request().postDataJSON() as { request: ApiRequest };
      return history.save(route, [next]);
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

async function expectLegendAppearance(page: Page, bar: Locator) {
  const legend = page.getByTestId("gantt-legend").locator('[data-marker="support"]');
  const marker = bar.locator('[data-marker="support"]');
  for (const property of ["color", "background-color", "height", "width", "border-radius"]) {
    await expect(marker).toHaveCSS(property, await legend.evaluate((element, key) => getComputedStyle(element).getPropertyValue(key), property));
  }
  await expect(bar).toHaveCSS("background-color", await legend.evaluate((element) => getComputedStyle(element).backgroundColor));
  await expect(marker.locator("svg")).toHaveCSS("stroke-width", await legend.locator("svg").evaluate((element) => getComputedStyle(element).strokeWidth));
  expect(await marker.locator("svg path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d")))).toEqual(
    await legend.locator("svg path").evaluateAll((paths) => paths.map((path) => path.getAttribute("d"))),
  );
}

for (const [theme, viewport] of [
  ["light", { width: 1440, height: 900 }],
  ["dark", { width: 480, height: 400 }],
] as const) {
  test(`补位选择 ${theme} 下滚动和选择只影响列表，搜索框保留一层边框`, async ({ page }, testInfo) => {
    const extraRequests = Array.from({ length: 28 }, (_, index) => request({
      id: index + 4,
      name: `补位候选 ${index + 1}`,
      developer: target.developer,
    }));
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { cell } = await openGantt(page, theme, { extraRequests });
    await cell("2026-11-10").click({ button: "right" });
    await page.getByRole("menuitem", { name: "补位", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "安排补位" });
    await expect(dialog).toBeVisible();
    await page.setViewportSize(viewport);
    const title = dialog.getByRole("heading", { name: "安排补位" });
    const search = dialog.getByRole("searchbox");
    const confirm = dialog.getByRole("button", { name: "确认补位" });
    const options = dialog.getByRole("radiogroup");
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("border-top-width", "1px");
    await expect(search).toHaveCSS("padding-inline-start", "34px");
    await expect(search).toHaveCSS("outline-style", "none");
    await expect(search.locator("..")).toHaveCSS("border-top-width", "0px");
    const focusBorder = await search.evaluate((element) => getComputedStyle(element).borderTopColor);
    const searchBox = (await search.boundingBox())!;
    const icon = (await search.locator("..").locator("svg").boundingBox())!;
    expect(Math.abs(icon.y + icon.height / 2 - searchBox.y - searchBox.height / 2)).toBeLessThan(1);

    const positions = () => Promise.all([dialog.boundingBox(), title.boundingBox(), search.boundingBox(), confirm.boundingBox()]);
    const before = await positions();
    await options.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const lastOption = dialog.getByRole("radio", { name: /^补位候选 28/ });
    await dialog.getByText("补位候选 28", { exact: true }).click();
    await expect(lastOption).toBeChecked();
    await expect(confirm).toBeEnabled();
    expect(await positions()).toEqual(before);
    await expect(search).toHaveCSS("border-top-width", "1px");
    await expect(search.locator("..")).toHaveCSS("border-top-width", "0px");
    await expect(search).not.toHaveCSS("border-top-color", focusBorder);

    await lastOption.press("ArrowUp");
    await expect(dialog.getByRole("radio", { name: /^补位候选 27/ })).toBeFocused();
    await expect(dialog.getByRole("radio", { name: /^补位候选 27/ })).toBeChecked();
    expect(await positions()).toEqual(before);
    expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await options.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await dialog.screenshot({ path: testInfo.outputPath("support-picker.png") });

    await search.fill("补位候选 1");
    expect(await options.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(confirm).toBeDisabled();
  });
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
  const scheduled = cell("2026-11-18").locator("[data-bar]");
  const scheduledBox = (await scheduled.boundingBox())!;
  const supportBox = (await start.boundingBox())!;
  expect(supportBox.height).toBe(scheduledBox.height);
  expect(supportBox.y).toBe(scheduledBox.y);
  await expectLegendAppearance(page, start);
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

test("补位与开发排期或 HOLD 重叠时各在线段自身的等高轨道内", async ({ page }, testInfo) => {
  const { cell, row } = await openGantt(page, "dark", {
    sourceColor: "#343a4b",
    source: {
      segments: [
        { start: "2026-11-16", end: "2026-11-18", holdBefore: false },
        { start: "2026-11-20", end: "2026-11-20", holdBefore: true },
      ],
      supportSegments: [{ requestId: target.id, start: "2026-11-18", end: "2026-11-23" }],
    },
  });
  const regular = (await cell("2026-11-16").locator("[data-bar]").boundingBox())!;
  const splitDay = cell("2026-11-18");
  const support = splitDay.locator("[data-support-bar]");
  await expect(support).toBeVisible();
  const upper = (await splitDay.locator("[data-bar]").boundingBox())!;
  const lower = (await support.boundingBox())!;
  const holdDay = cell("2026-11-19");
  const hold = (await holdDay.locator("[data-hold-connector]").boundingBox())!;
  const acrossHold = (await holdDay.locator("[data-support-bar]").boundingBox())!;
  const afterSchedule = cell("2026-11-23").locator("[data-support-bar]");
  const after = (await afterSchedule.boundingBox())!;

  expect(upper.height).toBe(regular.height);
  expect(lower.height).toBe(regular.height);
  expect(lower.y).toBeGreaterThan(upper.y + upper.height);
  expect(acrossHold.y).toBe(lower.y);
  expect(hold.y + hold.height).toBeLessThan(acrossHold.y);
  expect(after.y).toBe(lower.y);
  await expectLegendAppearance(page, support);
  const outline = await support.evaluate((element) => getComputedStyle(element, "::before").borderTopColor);
  expect(outline).not.toBe(await splitDay.locator("[data-bar]").evaluate((element) => getComputedStyle(element).backgroundColor));
  await row.screenshot({ path: testInfo.outputPath("support-overlap.png") });

  const handle = (await support.locator('[data-edge="start"]').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(after.x + 3, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(support).toHaveCount(0);
  const trimmed = (await afterSchedule.boundingBox())!;
  const afterTrim = (await splitDay.locator("[data-bar]").boundingBox())!;
  expect(trimmed.height).toBe(afterTrim.height);
  expect(trimmed.y).toBe(afterTrim.y);
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
