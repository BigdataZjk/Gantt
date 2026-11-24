import { mockRequestHistory, operationToReverse } from "./request-history-fixture";
import { expect, test, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
import { request } from "../src/test/fixtures";

async function openPreview(page: Page, theme: "light" | "dark" = "light") {
  const original = await (await page.request.get("/api/state")).json() as State;
  const me = original.users.find((user) => user.role === "superadmin" && !user.deleted)!;
  const state: State = { ...original, me, setupRequired: false, requests: [request({ developer: me.id, domain: original.domains[0]?.name ?? "" })], preferences: { ...original.preferences, theme } };
  const mutations: ApiRequest[][] = [];
  let rejectNext = false;
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  const history = mockRequestHistory(state, (changes) => {
    mutations.push(changes);
    state.requests = state.requests.map((row) => {
      const next = changes.find((item) => item.id === row.id);
      return next ? { ...next, revision: row.revision + 1 } : row;
    });
    state.revision += 1;
  });
  await page.route(/\/api\/requests\/(?:\d+|batch|operations\/\d+\/reverse)$/, async (route) => {
    if (rejectNext) { rejectNext = false; await route.fulfill({ status: 503, json: { message: "请重试" } }); return; }
    const operation = operationToReverse(new URL(route.request().url()).pathname);
    if (operation) return history.reverse(route, operation);
    const body = route.request().postDataJSON() as { request?: ApiRequest; requests?: ApiRequest[] };
    return history.save(route, body.requests ?? [body.request!]);
  });
  await page.addInitScript(({ id, theme }) => {
    localStorage.setItem("rsm.theme", theme);
    localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({ ganttRange: { start: "2026-11-09", end: "2026-12-10" } }));
  }, { id: me.id, theme });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toBeVisible();
  return { state, mutations, failOnce: () => { rejectNext = true; } };
}

async function resizeEnd(page: Page) {
  const row = page.locator('tr[data-row="1"]');
  const handle = row.locator('td[data-date="2026-11-18"] [data-resize][data-edge="end"]');
  const box = (await handle.boundingBox())!;
  const width = await row.locator('td[data-date="2026-11-18"]').evaluate((cell) => cell.getBoundingClientRect().width);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + width, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
}

for (const theme of ["light", "dark"] as const) {
  test(`年份网格即时切换、键盘翻页及窄屏边界（${theme}）`, async ({ page }, testInfo) => {
    await openPreview(page, theme);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "工作日历", exact: true }).click();
    const current = new Date().getFullYear() + 1;
    const trigger = page.getByRole("button", { name: /^日历年份，/ });
    const picker = page.getByRole("dialog", { name: "选择日历年份", exact: true });
    await trigger.click();
    await expect(picker.getByRole("button", { name: `${current} 年，已覆盖`, exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`calendar-year-${theme}.png`) });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(picker).not.toBeVisible();
    await expect(trigger).toHaveText(`${current + 1}年`);
    await expect(page.getByRole("table", { name: `${current + 1} 年节假日及调休`, exact: true })).toBeVisible();
    await trigger.click();
    await expect(picker.getByRole("button", { name: `${current + 1} 年`, exact: true })).toBeFocused();
    await page.keyboard.press("PageDown");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveText(`${current + 13}年`);
    await page.setViewportSize({ width: 320, height: 568 });
    await trigger.click();
    await expect(picker).toBeInViewport();
    const box = (await picker.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(312);
    await picker.getByRole("button", { name: "今年", exact: true }).click();
    await expect(trigger).toHaveText(`${current - 1}年`);
    await expect(trigger).toBeFocused();
    const content = page.locator('[data-scroll-container="calendar-content"]');
    const table = page.getByRole("table", { name: `${current - 1} 年节假日及调休`, exact: true });
    expect(await table.locator("..").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(160);
    await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(table.getByRole("columnheader", { name: "日期", exact: true })).toBeInViewport();
    await table.locator("..").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(table.locator("tbody tr").last()).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`calendar-compact-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  });
}

test("右键移动的日期提示居中悬浮，Meta/Control+Z 恢复且底栏不跳动", async ({ page }, testInfo) => {
  const { state, mutations } = await openPreview(page);
  const row = page.locator('tr[data-row="1"]');
  const legend = page.getByTestId("gantt-legend");
  const beforeFooter = await legend.boundingBox();
  const beforePlot = await page.locator('[data-scroll-container="gantt"]').boundingBox();
  const box = (await row.locator('td[data-date="2026-11-16"] [data-bar]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width * 1.5, box.y + box.height / 2, { steps: 4 });
  const hint = page.locator('[data-slot="gantt-drag-hint"]');
  await expect(hint).toHaveText("2026-11-17 至 2026-11-19");
  const hintBox = (await hint.boundingBox())!;
  const first = (await row.locator('td[data-date="2026-11-17"]').boundingBox())!;
  const last = (await row.locator('td[data-date="2026-11-19"]').boundingBox())!;
  expect(Math.abs(hintBox.x + hintBox.width / 2 - (first.x + last.x + last.width) / 2)).toBeLessThanOrEqual(1);
  expect(hintBox.y + hintBox.height).toBeLessThan((await row.boundingBox())!.y);
  expect(await legend.boundingBox()).toEqual(beforeFooter);
  expect(await page.locator('[data-scroll-container="gantt"]').boundingBox()).toEqual(beforePlot);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("centered-drag-hint.png") });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => mutations.length).toBe(1);
  await expect(hint).not.toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(state.requests[0]!.start).toBe("2026-11-17");
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await page.keyboard.press("Meta+z");
  await expect.poll(() => mutations.length).toBe(2);
  expect(state.requests[0]!.start).toBe("2026-11-16");
  await resizeEnd(page);
  await expect.poll(() => mutations.length).toBe(3);
  await page.keyboard.press("Control+z");
  await expect.poll(() => mutations.length).toBe(4);
  expect(state.requests[0]!.delivery).toBe("2026-11-18");
  await page.keyboard.press("Control+z");
  expect(mutations.length).toBe(4);
});

test("个人撤回失败可重试，后续同排期变更阻止覆盖", async ({ page }) => {
  const { state, mutations, failOnce } = await openPreview(page);
  await resizeEnd(page);
  await expect.poll(() => mutations.length).toBe(1);
  failOnce();
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Control+z");
  await expect.poll(() => mutations.length).toBe(2);
  expect(state.requests[0]!.delivery).toBe("2026-11-18");
  await resizeEnd(page);
  await expect.poll(() => mutations.length).toBe(3);
  state.requests[0] = { ...state.requests[0]!, days: 8, delivery: "2026-11-25", segments: [{ start: "2026-11-16", end: "2026-11-25", holdBefore: false }], revision: state.requests[0]!.revision + 1 };
  state.revision += 1;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator('tr[data-row="1"] td[data-date="2026-11-25"] [data-bar]')).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("alert").filter({ hasText: "保留最新数据" })).toBeVisible();
  expect(mutations.length).toBe(3);
  expect(state.requests[0]!.days).toBe(8);
});

test("日期提示在两侧边缘避让，滚动小于虚拟化步长时仍跟随预览", async ({ page }) => {
  const { mutations } = await openPreview(page);
  await page.getByLabel("甘特图结束日期", { exact: true }).fill("2026-12-31");
  const wrap = page.locator('[data-scroll-container="gantt"]');
  const row = page.locator('tr[data-row="1"]');
  const hint = page.locator('[data-slot="gantt-drag-hint"]');
  const bounds = (await wrap.boundingBox())!;
  const name = (await row.getByRole("rowheader").boundingBox())!;
  const gridLeft = name.x + name.width;
  const gridRight = bounds.x + bounds.width;

  for (const x of [gridLeft + 5, gridRight - 5, gridLeft + 400]) {
    const bar = (await row.locator('td[data-date="2026-11-16"] [data-bar]').boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x, bar.y + bar.height / 2, { steps: 4 });
    await expect(hint).toBeVisible();
    const box = (await hint.boundingBox())!;
    const cells = await row.locator('td[class*="dropValid"]').evaluateAll((items) => items.map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }));
    expect(cells.length).toBeGreaterThan(0);
    const center = (Math.max(gridLeft, cells[0]!.left) + Math.min(gridRight, cells.at(-1)!.right)) / 2;
    const width = page.viewportSize()!.width;
    const expected = Math.max(8, Math.min(width - box.width - 8, center - box.width / 2));
    expect(Math.abs(box.x - expected)).toBeLessThanOrEqual(1);
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 8);

    if (x === gridLeft + 400) {
      await wrap.evaluate((element) => { element.scrollLeft += 9; });
      await expect.poll(async () => Math.abs((await hint.boundingBox())!.x - (box.x - 9))).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press("Control+z");
    await page.mouse.up({ button: "right" });
    await expect(hint).not.toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  expect(mutations).toHaveLength(0);
});

test("日历 JSON 先校验和预览，应用后更新列表并支持导出", async ({ page }) => {
  const { state } = await openPreview(page);
  let imported = 0;
  const year = new Date().getFullYear() + 1;
  const calendar = {
    year,
    papers: [],
    days: [{ name: "导入的节假日", date: `${year}-01-04`, isOffDay: true }],
  };
  await page.route("**/api/calendar/import", async (route) => {
    imported += 1;
    expect(route.request().postDataJSON()).toEqual({ baseRevision: state.revision, year, calendar });
    state.calendar = {
      ...state.calendar,
      editions: [{ ...calendar, source: "管理员导入", updatedAt: "2026-11-17T04:00:00Z" }],
      restDays: calendar.days.map((day) => day.date),
    };
    state.revision += 1;
    await route.fulfill({ json: state });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "工作日历", exact: true }).click();
  const input = page.getByLabel("选择日历 JSON", { exact: true });
  await input.setInputFiles({ name: "wrong-year.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...calendar, year: year + 1 })) });
  await expect(page.getByRole("alert").filter({ hasText: "当前年份一致" })).toBeVisible();
  await expect(page.getByRole("button", { name: "应用导入", exact: true })).toHaveCount(0);
  await input.setInputFiles({ name: `${year}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(calendar)) });
  await expect(page.getByRole("status").filter({ hasText: `${year}.json` })).toBeVisible();
  expect(imported).toBe(0);
  await page.getByRole("button", { name: "应用导入", exact: true }).click();
  await expect(page.getByRole("table", { name: `${year} 年节假日及调休`, exact: true }).getByText("导入的节假日")).toBeVisible();
  expect(imported).toBe(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`${year}.json`);
});

test("保存人天后，跨需求子页可逐步撤回至沙漏，并用 Ctrl/Command+Shift+Z 重做", async ({ page }) => {
  const password = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";
  const readState = async () => await (await page.request.get("/api/state")).json() as State;
  const guest = await readState();
  const login = guest.setupRequired
    ? await page.request.post("/api/setup", { data: { password } })
    : await page.request.post("/api/login", { data: { username: "张金科", password } });
  expect(login.ok()).toBeTruthy();
  const signedIn = await login.json() as State;
  const name = `待估撤回-${Date.now().toString(36)}`;
  const create = await page.request.post("/api/requests", {
    data: {
      baseRevision: signedIn.revision,
      request: request({ name, developer: signedIn.me!.id, domain: signedIn.domains[0]!.name, days: 0, delivery: "" }),
    },
  });
  expect(create.ok()).toBeTruthy();
  const initial = await create.json() as State;
  const item = initial.requests.find((row) => row.name === name)!;
  await page.addInitScript((id) => {
    localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({ ganttRange: { start: "2026-11-16", end: "2026-11-27" } }));
  }, signedIn.me!.id);
  await page.goto("/");
  const row = page.locator(`tr[data-row="${item.id}"]`);
  const marker = row.locator('[data-marker="estimated"]');
  await expect(marker).toBeVisible();
  const editor = page.getByRole("dialog", { name: "编辑需求", exact: true });
  const saveDays = async (days: number) => {
    await page.getByRole("button", { name, exact: true }).dblclick();
    await editor.getByRole("tab", { name: "开发信息", exact: true }).click();
    await editor.getByLabel("开发人天", { exact: true }).fill(String(days));
    await editor.getByRole("button", { name: "保存需求", exact: true }).click();
    await expect(editor).toBeHidden();
  };
  const savedDays = async () => (await readState()).requests.find((request) => request.id === item.id)!.days;
  await saveDays(4);
  await expect(marker).toHaveCount(0);
  await saveDays(5);
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await page.keyboard.press("Control+z");
  await expect.poll(savedDays).toBe(4);
  await page.keyboard.press("Control+z");
  await expect.poll(savedDays).toBe(0);
  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await expect(marker).toBeVisible();
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(savedDays).toBe(4);
  await expect(marker).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(savedDays).toBe(5);
  await page.keyboard.press("Control+z");
  await expect.poll(savedDays).toBe(4);
  await saveDays(6);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(savedDays).toBe(6);
});
