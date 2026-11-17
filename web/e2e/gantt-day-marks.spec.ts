import { expect, test, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
import { request } from "../src/test/fixtures";

async function openDayMarks(page: Page, overrides: Partial<ApiRequest> = {}, theme: "light" | "dark" = "light") {
  const original = await (await page.request.get("/api/state")).json() as State;
  const me = original.users.find((user) => user.role === "superadmin" && !user.deleted)!;
  const state: State = {
    ...original, me, setupRequired: false,
    requests: [request({ developer: me.id, domain: original.domains[0]!.name, ...overrides })],
    preferences: { ...original.preferences, theme },
  };
  const writes: ApiRequest[] = [];
  let failure = 0;
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if (path === "/api/requests/1" && route.request().method() === "PUT") {
      if (failure) return route.fulfill({ status: failure, json: { error: failure === 409 ? "资料已更新，请刷新后重试" : "保存失败，请重试" } });
      const body = route.request().postDataJSON() as { request: ApiRequest };
      writes.push(body.request);
      state.requests = [{ ...body.request, revision: state.requests[0]!.revision + 1 }];
      state.revision += 1;
      return route.fulfill({ json: state });
    }
    return route.abort();
  });
  await page.addInitScript(({ id, theme }) => {
    localStorage.setItem("rsm.theme", theme);
    localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({ ganttRange: { start: "2026-11-09", end: "2026-12-03" } }));
  }, { id: me.id, theme });
  await page.goto("/");
  const row = page.locator('tr[data-row="1"]');
  await expect(row).toBeVisible();
  return { state, writes, row, fail: (status: number) => { failure = status; } };
}

const split = [
  { start: "2026-11-16", end: "2026-11-17", holdBefore: false },
  { start: "2026-11-23", end: "2026-11-24", holdBefore: true },
];

for (const theme of ["light", "dark"] as const) {
  test(`取消首端周日加班恢复休息日灰底，重载和撤回一致（${theme}）`, async ({ page }, testInfo) => {
    const { state, writes, row } = await openDayMarks(page, {
      start: "2026-11-22", delivery: "2026-11-24", overtime: ["2026-11-22"],
      segments: [{ start: "2026-11-22", end: "2026-11-24", holdBefore: false }],
    }, theme);
    const original = structuredClone(state.requests[0]!);
    const sunday = row.locator('[data-date="2026-11-22"]');
    const bar = sunday.locator("[data-bar]");
    const filledColor = await bar.evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(sunday.locator('[data-marker="overtime"]')).toBeVisible();
    const cancel = async () => {
      await sunday.click({ button: "right" });
      await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
      await expect(sunday.locator('[data-marker="overtime"]')).toHaveCount(0);
      await expect(bar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    };
    await cancel();
    const blankSunday = row.locator('[data-date="2026-11-15"]');
    expect(await sunday.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await blankSunday.evaluate((element) => getComputedStyle(element).backgroundColor));
    await expect(row.locator('[data-date="2026-11-23"] [data-bar]')).toHaveCSS("border-top-left-radius", "5px");
    await expect(sunday.locator('[data-resize][data-edge="start"]')).toHaveCount(1);
    await expect(row.locator('[data-date="2026-11-24"] [data-resize][data-edge="end"]')).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(bar).toHaveCSS("background-color", filledColor);
    await expect(sunday.locator('[data-marker="overtime"]')).toBeVisible();
    await cancel();
    await page.reload();
    await expect(bar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await row.getByRole("button", { name: original.name, exact: false }).first().click();
    await expect(row.locator('[data-date="2026-11-24"] [class*="deliveryGuide"]')).toHaveCount(1);
    expect(writes.every((item) => item.start === original.start && item.delivery === original.delivery && item.days === original.days && JSON.stringify(item.segments) === JSON.stringify(original.segments))).toBe(true);
    await page.mouse.move(0, 0);
    await row.screenshot({ path: testInfo.outputPath("cancelled-leading-overtime.png") });
  });

  test(`内部周末保留淡色连接，末端及整段休息不着业务色（${theme}）`, async ({ page }) => {
    const { state, row } = await openDayMarks(page, {
      start: "2026-11-20", delivery: "2026-11-24", overtime: ["2026-11-21"],
    }, theme);
    const saturday = row.locator('[data-date="2026-11-21"]');
    await saturday.click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
    await expect(saturday.locator('[data-marker="overtime"]')).toHaveCount(0);
    const internalColor = await row.locator('[data-date="2026-11-22"] [data-bar]').evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(internalColor).not.toBe("rgba(0, 0, 0, 0)");
    await expect(saturday.locator("[data-bar]")).toHaveCSS("background-color", internalColor);
    state.requests[0] = { ...state.requests[0]!, delivery: "2026-11-22", overtime: ["2026-11-22"] };
    await page.reload();
    const sunday = row.locator('[data-date="2026-11-22"]');
    await sunday.click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
    await expect(sunday.locator("[data-bar]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(saturday.locator("[data-bar]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const friday = row.locator('[data-date="2026-11-20"] [data-bar]');
    await expect(friday).toHaveCSS("border-top-right-radius", "5px");
    state.requests[0] = { ...state.requests[0]!, start: "2026-11-21" };
    await page.reload();
    for (const piece of await row.locator("[data-bar]").all()) await expect(piece).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(row.locator("[data-resize]")).toHaveCount(2);
  });

  test(`首尾休假只显示标记，内部休假保留连接及原排期（${theme}）`, async ({ page }) => {
    const { row } = await openDayMarks(page, {
      start: "2026-11-16", delivery: "2026-11-20", vacation: ["2026-11-16", "2026-11-18", "2026-11-20"],
    }, theme);
    for (const date of ["2026-11-16", "2026-11-20"]) {
      const cell = row.locator(`[data-date="${date}"]`);
      await expect(cell.locator('[data-marker="leave"]')).toBeVisible();
      await expect(cell.locator("[data-bar]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    const middle = row.locator('[data-date="2026-11-18"]');
    await expect(middle.locator('[data-marker="leave"]')).toBeVisible();
    expect(await middle.locator("[data-bar]").evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  });

  for (const [placement, overrides, date] of [
    ["排期前", {}, "2026-11-14"],
    ["排期后", {}, "2026-11-21"],
    ["未排期", { start: "", delivery: "" }, "2026-11-21"],
    ["未分配", { developer: "", start: "", delivery: "" }, "2026-11-21"],
    ["HOLD 间隔", { segments: split, delivery: "2026-11-24" }, "2026-11-21"],
    ["排期段内", { delivery: "2026-11-23" }, "2026-11-21"],
  ] as const) {
    test(`加班在${placement}保存后立即显示，刷新、取消与撤回一致（${theme}）`, async ({ page }) => {
      const { state, writes, row } = await openDayMarks(page, overrides, theme);
      const geometry = (item: ApiRequest) => [item.start, item.delivery, item.days, item.segments];
      const before = geometry(state.requests[0]!);
      const cell = row.locator(`td[data-date="${date}"]`);
      const marker = cell.locator('[data-marker="overtime"]');
      await cell.click({ button: "right" });
      await page.getByRole("menuitem", { name: "加班", exact: true }).click();
      await expect(page.getByText("当天标记已保存", { exact: true })).toBeVisible();
      await expect(marker).toBeVisible();
      expect(state.requests[0]!.overtime).toContain(date);
      expect(geometry(state.requests[0]!)).toEqual(before);
      await page.reload();
      await expect(marker).toBeVisible();
      await cell.click({ button: "right" });
      await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
      await expect(marker).toHaveCount(0);
      expect(state.requests[0]!.overtime).not.toContain(date);
      await page.keyboard.press("Control+z");
      await expect(marker).toBeVisible();
      await cell.click({ button: "right" });
      await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
      await expect(marker).toHaveCount(0);
      expect(writes.every((item) => JSON.stringify(geometry(item)) === JSON.stringify(before))).toBeTruthy();
    });
  }
}

for (const [placement, overrides] of [
  ["段内", { delivery: "2026-11-20" }],
  ["HOLD 内", { segments: split, delivery: "2026-11-24" }],
  ["未排期", { start: "", delivery: "" }],
] as const) {
  test(`休假在${placement}立即显示且能取消，不遮盖 HOLD 中点`, async ({ page }) => {
    const { state, row } = await openDayMarks(page, overrides);
    const cell = row.locator('td[data-date="2026-11-19"]');
    const hold = row.locator('[data-marker="hold"]');
    const before = await hold.count() ? await hold.boundingBox() : null;
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "休假", exact: true }).click();
    await expect(cell.locator('[data-marker="leave"]')).toBeVisible();
    expect(state.requests[0]!.vacation).toContain("2026-11-19");
    if (before) expect(await hold.boundingBox()).toEqual(before);
    await page.reload();
    await expect(cell.locator('[data-marker="leave"]')).toBeVisible();
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消休假", exact: true }).click();
    await expect(cell.locator('[data-marker="leave"]')).toHaveCount(0);
  });
}

const holdCenterCases: ["leave" | "overtime", string, Partial<ApiRequest>, string][] = [
  ["leave", "2026-11-20", { segments: split, delivery: "2026-11-24" }, "休假"],
  ["overtime", "2026-11-21", { segments: [{ start: "2026-11-16", end: "2026-11-18", holdBefore: false }, { start: "2026-11-24", end: "2026-11-24", holdBefore: true }], delivery: "2026-11-24" }, "加班"],
];

for (const [kind, date, overrides, action] of holdCenterCases) {
  test(`HOLD 中点同一天的${action}有独立标记，图标不重叠`, async ({ page }) => {
    const { row } = await openDayMarks(page, overrides);
    const hold = row.locator('[data-marker="hold"]');
    const center = (await hold.boundingBox())!;
    const cell = row.locator(`td[data-date="${date}"]`);
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    const mark = cell.locator(`[data-marker="${kind}"]`);
    await expect(mark).toBeVisible();
    const bounds = (await mark.boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(center.x);
    expect(await hold.boundingBox()).toEqual(center);
  });
}

const oppositeMarkCases: [string, Partial<ApiRequest>, string, "leave" | "overtime"][] = [
  ["2026-11-19", { overtime: ["2026-11-19"] }, "休假", "leave"],
  ["2026-11-21", { vacation: ["2026-11-21"] }, "加班", "overtime"],
];

for (const [date, overrides, action, kind] of oppositeMarkCases) {
  test(`日历变化后改标${action}时清除同日相反标记，刷新一致`, async ({ page }) => {
    const { state, row } = await openDayMarks(page, { vacation: [], overtime: [], ...overrides, segments: split, delivery: "2026-11-24" });
    const cell = row.locator(`td[data-date="${date}"]`);
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: action, exact: true }).click();
    await expect(cell.locator(`[data-marker="${kind}"]`)).toBeVisible();
    const saved = state.requests[0]!;
    expect(kind === "leave" ? saved.vacation : saved.overtime).toContain(date);
    expect(kind === "leave" ? saved.overtime : saved.vacation).not.toContain(date);
    await page.reload();
    await expect(cell.locator(`[data-marker="${kind}"]`)).toBeVisible();
  });
}

for (const status of [409, 503]) {
  test(`保存加班返回 ${status} 时不显示成功或假标记，恢复后可重试`, async ({ page }) => {
    const { fail, row } = await openDayMarks(page);
    const cell = row.locator('td[data-date="2026-11-21"]');
    fail(status);
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "加班", exact: true }).click();
    await expect(page.getByText(status === 409 ? "资料已更新，请刷新后重试" : "保存失败，请重试", { exact: true })).toBeVisible();
    await expect(page.getByText("当天标记已保存", { exact: true })).toHaveCount(0);
    await expect(cell.locator('[data-marker="overtime"]')).toHaveCount(0);
    fail(0);
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "加班", exact: true }).click();
    await expect(cell.locator('[data-marker="overtime"]')).toBeVisible();
  });
}
