import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ApiRequest, GanttOrderInput, State } from "../src/api/types";
import { calendar, domains, request, users } from "../src/test/fixtures";

const requests = [
  request({ id: 1, name: "已排期甲", developer: "u1" }),
  request({ id: 2, name: "已排期乙", developer: "u1", start: "2026-11-20", delivery: "2026-11-24" }),
  request({ id: 3, name: "未排期甲", developer: "u1", start: "", delivery: "" }),
  request({ id: 4, name: "未排期乙", developer: "u1", start: "", delivery: "" }),
  request({ id: 5, name: "其他人员需求", developer: "u2" }),
  request({ id: 6, name: "未分配甲", developer: "", start: "", delivery: "" }),
  request({ id: 7, name: "未分配乙", developer: "", start: "", delivery: "" }),
  request({ id: 8, name: "日期轴外需求", developer: "u2", start: "2027-05-10", delivery: "2027-05-12" }),
  request({ id: 9, name: "归档需求", archived: true }),
];

async function preview(page: Page, options: { guest?: boolean; theme?: "light" | "dark"; rows?: ApiRequest[] } = {}) {
  const original = await (await page.request.get("/api/state")).json() as State;
  const state: State = { ...original, me: options.guest ? null : users[0], setupRequired: false, users, domains, calendar, requests: structuredClone(options.rows ?? requests), preferences: { ...original.preferences, theme: options.theme ?? "light" } };
  delete state.ganttRowOrder;
  const mutations: { method: string; id: number }[] = [];
  const orderWrites: GanttOrderInput[] = [];
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.route("**/api/requests/**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/requests/gantt-order" && method === "PUT") {
      const order = route.request().postDataJSON() as GanttOrderInput;
      orderWrites.push(order);
      const moved = state.requests.find((row) => row.id === order.move?.requestId);
      if (moved && order.move) {
        const oldOrder = state.ganttRowOrder?.[moved.developer];
        if (oldOrder) state.ganttRowOrder![moved.developer] = oldOrder.filter((id) => id !== moved.id);
        moved.developer = order.move.developer;
        moved.revision += 1;
      }
      state.ganttRowOrder ??= {};
      for (const group of order.orders) state.ganttRowOrder[group.developer] = group.requestIds;
      state.revision += 1;
      return route.fulfill({ json: state });
    }
    const id = Number(path.split("/")[3]);
    mutations.push({ method, id });
    if (method === "DELETE") state.requests = state.requests.filter((row) => row.id !== id);
    else if (path.endsWith("/archive")) {
      const { archived } = route.request().postDataJSON();
      state.requests = state.requests.map((row) => row.id === id ? { ...row, archived, revision: row.revision + 1 } : row);
    } else if (method === "PUT") {
      const { request: updated } = route.request().postDataJSON();
      state.requests = state.requests.map((row) => row.id === id ? { ...updated, revision: row.revision + 1 } : row);
    } else {
      await route.fulfill({ status: 400, json: { error: "非预期测试操作" } });
      return;
    }
    state.revision += 1;
    await route.fulfill({ json: state });
  });
  await page.addInitScript(({ user, theme }) => {
    localStorage.setItem("rsm.theme", theme);
    const key = `rsm.ui.v2:${user}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ ganttRange: { start: "2026-11-09", end: "2026-12-10" } }));
  }, { user: options.guest ? "guest" : "u1", theme: options.theme ?? "light" });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toBeVisible();
  return { state, mutations, orderWrites };
}

const nameOf = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const rowIds = (page: Page) => page.locator('[data-scroll-container="gantt"] tr[data-row], [data-scroll-container="table"] [data-row]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.row)));

async function dragTo(page: Page, source: Locator, target: Locator, edge: "before" | "after" = "after", release = true) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.locator('xpath=ancestor::*[@data-row][1]').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + to.height * (edge === "before" ? 0.2 : 0.8), { steps: 8 });
  await expect(page.locator('[data-slot="request-reorder-hint"]')).toBeVisible();
  if (release) await page.mouse.up();
}

test("甘特图按日期显示排期，未分配遵循日期范围，隐藏无排期的历史需求", async ({ page }) => {
  await preview(page, { rows: [
    ...requests,
    request({ id: 10, name: "范围外的未分配需求", developer: "", status: "已完成" }),
    request({ id: 11, name: "未排期的已完成需求", developer: "", status: "已完成", start: "", delivery: "" }),
    request({ id: 12, name: "未排期的归档需求", archived: true, start: "", delivery: "" }),
    request({ id: 13, name: "范围内的已归档排期", developer: "", archived: true, status: "已完成", start: "2026-11-23", delivery: "2026-11-25" }),
  ] });
  await expect.poll(() => rowIds(page)).toEqual([1, 9, 2, 3, 4, 5, 10, 13, 6, 7]);
  await expect(page.getByRole("button", { name: "收起-的 4 条需求", exact: true })).toBeVisible();
  await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("显示 10 / 共 13 条需求");
  const endDate = page.getByLabel("甘特图结束日期", { exact: true });
  const startDate = page.getByLabel("甘特图开始日期", { exact: true });
  await endDate.fill("2027-01-17");
  await startDate.fill("2026-11-23");
  await expect.poll(() => rowIds(page)).toEqual([2, 3, 4, 13, 6, 7]);
  await expect(page.locator('tr[data-row="2"] [data-date="2026-11-23"] [data-bar]')).toBeVisible();
  await expect(page.locator('tr[data-row="13"][data-archived] [data-date="2026-11-23"] [data-bar]')).toBeVisible();
  await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("显示 6 / 共 13 条需求");

  await endDate.fill("2027-05-12");
  await startDate.fill("2027-05-10");
  await expect.poll(() => rowIds(page)).toEqual([3, 4, 8, 6, 7]);
  await expect(page.locator('tr[data-row="8"] [data-date="2027-05-10"] [data-bar]')).toBeVisible();
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await expect.poll(() => rowIds(page)).toEqual([11, 10, 8, 7, 6, 5, 4, 3, 2, 1]);
  await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("10 条需求");
  await page.getByRole("tab", { name: "已归档", exact: true }).click();
  await expect.poll(() => rowIds(page)).toEqual([13, 12, 9]);
});

test("需求池修改优先级后清除级联排序并保留完整行序", async ({ page }) => {
  const rows = requests.map((row): ApiRequest => {
    if (row.id === 2) return { ...row, status: "HOLD", requesterRank: 1 };
    if (row.id === 6) return { ...row, requesterRank: 2 };
    return row;
  });
  const { state } = await preview(page, { rows });
  const changes: (number | "clear")[] = [];
  await page.route("**/api/requests/priority", async (route) => {
    const { action, requestId } = route.request().postDataJSON();
    const ranked = state.requests.filter((row) => !row.archived && row.requesterRank)
      .sort((a, b) => a.requesterRank! - b.requesterRank!);
    changes.push(action === "clear" ? "clear" : requestId);
    if (action === "toggle") {
      const row = state.requests.find((item) => item.id === requestId)!;
      const index = ranked.indexOf(row);
      if (index < 0) ranked.push(row);
      else {
        ranked.splice(index, 1);
        row.requesterRank = 0;
      }
    }
    ranked.forEach((row, index) => { row.requesterRank = action === "clear" ? 0 : index + 1; });
    state.revision += 1;
    await route.fulfill({ json: state });
  });
  const tab = page.getByRole("tab", { name: "需求池", exact: true });
  await tab.click();
  const headerSort = (name: string) => page.getByRole("columnheader", { name, exact: true }).getByRole("button");
  const priority = headerSort("优先级");
  const status = headerSort("状态");
  const reset = page.getByRole("button", { name: "重置排序", exact: true });
  const rank = (id: number) => page.locator(`[data-row="${id}"] [data-key="requesterRank"]`);
  const toggleStatusFilter = async (label: string) => {
    await page.getByRole("button", { name: `状态：${label}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("checkbox", { name: "待开发", exact: true }).click();
    await page.keyboard.press("Escape");
  };
  await status.click();
  await priority.click();
  const fullOrder = [6, 8, 7, 5, 4, 3, 1, 2];
  await expect.poll(() => rowIds(page)).toEqual(fullOrder);
  await expect(priority).toHaveAccessibleName(/第 2 排序，升序/);
  await toggleStatusFilter("全部");
  const filteredOrder = fullOrder.filter((id) => id !== 2);
  await expect.poll(() => rowIds(page)).toEqual(filteredOrder);

  await nameOf(page, "未排期甲").click();
  await page.locator('[data-row="7"] [data-key="status"]').click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await rank(3).click({ position: { x: 4, y: 8 } });
  await expect(reset).toHaveCount(0);
  await expect(priority).toHaveAccessibleName("优先级，点击升序");
  await expect(status).toHaveAccessibleName("状态，点击升序");
  await expect(rank(3)).toHaveText("3");
  await expect.poll(() => rowIds(page)).toEqual(filteredOrder);
  await rank(7).getByRole("button").click();
  await rank(5).getByRole("button").click();
  await expect(rank(7)).toHaveText("4");
  await expect(rank(5)).toHaveText("5");
  await rank(6).getByRole("button").click();
  await expect(rank(6)).toHaveText("–");
  await expect(rank(3)).toHaveText("2");

  await tab.hover();
  await expect.poll(() => rowIds(page)).toEqual(filteredOrder);
  await toggleStatusFilter("待开发");
  await expect.poll(() => rowIds(page)).toEqual(fullOrder);
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual(fullOrder);

  await priority.click();
  const rankedOrder = [2, 3, 7, 5, 6, 8, 4, 1];
  await expect.poll(() => rowIds(page)).toEqual(rankedOrder);
  await rank(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "清除优先级", exact: true }).click();
  await expect(reset).toHaveCount(0);
  await expect(rank(2)).toHaveText("–");
  await expect.poll(() => rowIds(page)).toEqual(rankedOrder);

  await status.click();
  const statusOrder = [3, 7, 5, 6, 8, 4, 1, 2];
  await expect.poll(() => rowIds(page)).toEqual(statusOrder);
  await rank(8).getByRole("button").click();
  await expect(rank(8)).toHaveText("1");
  await expect(status).toHaveAccessibleName(/第 1 排序，升序/);
  await expect.poll(() => rowIds(page)).toEqual(statusOrder);
  expect(changes).toEqual([3, 7, 5, 6, "clear", 8]);
});

for (const tab of ["甘特图", "需求池"] as const) {
  test(`${tab}归档后甘特图保留排期和只读详情，删除后移除需求`, async ({ page }) => {
    const { state, mutations } = await preview(page);
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const name = nameOf(page, "已排期甲");
    const editor = page.getByRole("dialog", { name: "编辑需求", exact: true });
    await name.dblclick({ delay: tab === "需求池" ? 280 : 0 });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("需求名", { exact: false })).toHaveValue("已排期甲");
    await editor.getByRole("button", { name: "收起面板", exact: true }).click();
    await name.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["编辑", "归档", "删除"]);
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("需求名", { exact: false })).toHaveValue("已排期甲");
    await editor.getByRole("button", { name: "收起面板", exact: true }).click();
    await name.click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档", exact: true }).click();
    await expect(page.getByText("已归档，可在需求归档中查看", { exact: true })).toBeVisible();
    expect(state.requests.find((row) => row.id === 1)?.archived).toBe(true);
    if (tab === "需求池") await expect(name).toHaveCount(0);
    await nameOf(page, "未排期乙").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "删除需求", exact: true }) });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    await expect(nameOf(page, "未排期乙")).toBeVisible();
    expect(mutations).toHaveLength(1);
    await nameOf(page, "未排期乙").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    await confirm.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(nameOf(page, "未排期乙")).toHaveCount(0);
    await page.getByRole("tab", { name: "甘特图", exact: true }).click();
    const archivedRow = page.locator('tr[data-row="1"][data-archived]');
    await expect(name).toBeVisible();
    await expect(archivedRow.locator('[data-date="2026-11-16"] [data-bar]')).toBeVisible();
    await expect(archivedRow.locator("[data-resize]")).toHaveCount(0);
    await name.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["查看详情"]);
    await page.keyboard.press("Escape");
    await name.dblclick();
    const details = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "需求详情", exact: true }) });
    await expect(details.getByText("已归档 · 只读", { exact: true })).toBeVisible();
    await details.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("tab", { name: "需求池", exact: true }).click();
    await expect(name).toHaveCount(0);
    await expect(nameOf(page, "未排期乙")).toHaveCount(0);
    await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("6 条需求");
    await page.getByRole("tab", { name: "已归档", exact: true }).click();
    await expect(name).toBeVisible();
    expect(mutations).toEqual([{ method: "POST", id: 1 }, { method: "DELETE", id: 4 }]);
  });

  test(`${tab}名称拖动排序、刷新保留与 Escape 取消，不修改业务数据`, async ({ page }, testInfo) => {
    const { state, mutations, orderWrites } = await preview(page, { theme: tab === "甘特图" ? "light" : "dark" });
    const before = structuredClone(state.requests);
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const edge = tab === "甘特图" ? "before" : "after";
    const hint = page.locator('[data-slot="request-reorder-hint"]');
    await dragTo(page, nameOf(page, "未排期乙"), nameOf(page, "未排期甲"), edge, false);
    await expect(page.locator('[data-row="3"]')).toHaveAttribute("data-reorder-edge", edge);
    await expect(hint).toHaveText(`在「未排期甲」${edge === "before" ? "前" : "后"}`);
    await page.screenshot({ path: testInfo.outputPath(`${tab}-reorder.png`) });
    await page.mouse.up();
    const expected = tab === "甘特图" ? [1, 9, 2, 4, 3, 5, 6, 7] : [8, 7, 6, 5, 3, 4, 2, 1];
    await expect.poll(() => rowIds(page)).toEqual(expected);
    await expect(hint).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect.poll(() => rowIds(page)).toEqual(expected);
    await page.setViewportSize({ width: 800, height: 900 });
    const wrap = page.locator(`[data-scroll-container="${tab === "甘特图" ? "gantt" : "table"}"]`);
    await wrap.evaluate((element) => { element.scrollLeft = 150; });
    const fixedX = (await nameOf(page, "未排期甲").boundingBox())!.x;
    await dragTo(page, nameOf(page, "未排期乙"), nameOf(page, "未排期甲"), "after", false);
    expect(Math.abs((await nameOf(page, "未排期甲").boundingBox())!.x - fixedX)).toBeLessThan(1);
    const target = page.locator('[data-row="3"]');
    expect(await target.evaluate((element) => getComputedStyle(element.querySelector('th, [data-key="name"]')!).position)).toBe("sticky");
    const targetBox = (await target.boundingBox())!;
    const targetTop = targetBox.y + targetBox.height / 4;
    await expect(hint).toHaveText("在「未排期甲」后");
    await page.mouse.move(fixedX + 2, targetTop);
    await expect(target).toHaveAttribute("data-reorder-edge", "before");
    await expect(hint).toHaveText("在「未排期甲」前");
    await page.mouse.move(0, 0);
    await expect(hint).toBeHidden();
    await expect(target).not.toHaveAttribute("data-reorder-edge");
    await page.mouse.move(fixedX + 2, targetTop);
    await expect(hint).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(hint).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => rowIds(page)).toEqual(expected);
    expect(state.requests).toEqual(before);
    expect(mutations).toEqual([]);
    expect(orderWrites.map((item) => item.orders)).toEqual(tab === "甘特图" ? [[{ developer: "u1", requestIds: [1, 9, 2, 4, 3] }]] : []);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });
}

test("甘特需求格的两侧空白、优先级短竖线和状态标签均可拖动排序", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const { state, mutations, orderWrites } = await preview(page, {
    rows: requests.map((row) => row.id === 4 || row.id === 9 ? { ...row, status: "HOLD" } : row),
  });
  const before = structuredClone(state.requests);
  const wrap = page.locator('[data-scroll-container="gantt"]');
  const source = wrap.locator('tr[data-row="4"] [data-request-select]');
  const target = wrap.locator('tr[data-row="3"]');
  const separator = wrap.getByRole("separator", { name: "调整需求列宽", exact: true });
  const width = await separator.getAttribute("aria-valuenow");
  await wrap.evaluate((element) => { element.scrollLeft = 150; });
  await expect.poll(() => wrap.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  const cell = (await source.boundingBox())!;
  const priority = (await source.locator('[data-priority="P1"]').boundingBox())!;
  const hold = source.locator('[data-dict-field="status"]');
  await expect(hold).toHaveText("HOLD");
  const badge = (await hold.boundingBox())!;
  const destination = (await target.boundingBox())!;
  const centerY = cell.y + cell.height / 2;
  const positions = [
    { x: cell.x + 2, y: centerY },
    { x: cell.x + cell.width / 2, y: cell.y + 1 },
    { x: priority.x + priority.width / 2, y: priority.y + priority.height / 2 },
    { x: cell.x + cell.width - 2, y: centerY },
    { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 },
  ];
  for (const [index, { x, y }] of positions.entries()) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, destination.y + destination.height / 4, { steps: 4 });
    await expect(target).toHaveAttribute("data-reorder-edge", "before");
    if (index < positions.length - 1) await page.keyboard.press("Escape");
    else await wrap.screenshot({ path: testInfo.outputPath("gantt-reorder-from-status.png") });
    await page.mouse.up();
  }

  const expected = [1, 9, 2, 4, 3, 5, 6, 7];
  await expect.poll(() => rowIds(page)).toEqual(expected);
  await expect(separator).toHaveAttribute("aria-valuenow", width!);
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual(expected);
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await expect(nameOf(page, "未排期乙")).toBeVisible();
  await expect(page.locator("[data-request-name] [data-priority]")).toHaveCount(0);
  await page.getByRole("tab", { name: "已归档", exact: true }).click();
  await expect(nameOf(page, "归档需求")).toBeVisible();
  await expect(page.locator("[data-request-name] [data-priority]")).toHaveCount(0);
  expect(state.requests).toEqual(before);
  expect(mutations).toEqual([]);
  expect(orderWrites.map((item) => item.orders)).toEqual([[{ developer: "u1", requestIds: [1, 9, 2, 4, 3] }]]);
});

test("甘特图的默认顺序按筛选范围内第一段开发时间升序排列", async ({ page }) => {
  const archived = request({
    id: 9,
    name: "分段开发的归档需求",
    archived: true,
    segments: [
      { start: "2026-11-10", end: "2026-11-12", holdBefore: false },
      { start: "2026-11-23", end: "2026-11-24", holdBefore: true },
    ],
  });
  const { orderWrites } = await preview(page, { rows: [requests[0]!, requests[2]!, archived] });
  await expect.poll(() => rowIds(page)).toEqual([9, 1, 3]);
  await page.getByLabel("甘特图开始日期", { exact: true }).fill("2026-11-16");
  await expect.poll(() => rowIds(page)).toEqual([1, 9, 3]);
  await page.getByLabel("甘特图结束日期", { exact: true }).fill("2026-11-18");
  await expect.poll(() => rowIds(page)).toEqual([1, 9, 3]);
  expect(orderWrites).toEqual([]);
});

test("甘特图归档需求可拖动调整同组顺序，刷新后仍保留", async ({ page }) => {
  const { state, mutations, orderWrites } = await preview(page);
  const before = structuredClone(state.requests);
  const source = page.locator('tr[data-row="9"][data-archived] [data-request-select]');
  const hint = page.locator('[data-slot="request-reorder-hint"]');
  await expect(source).toHaveCSS("cursor", "grab");
  await dragTo(page, source, nameOf(page, "其他人员需求"), "after", false);
  await expect(hint).toHaveText("已归档需求只能在当前分组排序");
  await expect(hint).toHaveAttribute("data-valid", "false");
  await page.mouse.up();
  expect(orderWrites).toEqual([]);

  await dragTo(page, source, nameOf(page, "已排期乙"), "after", false);
  await expect(hint).toHaveText("在「已排期乙」后");
  await expect(page.locator('tr[data-row="2"]')).toHaveAttribute("data-reorder-edge", "after");
  await page.mouse.up();
  const expected = [1, 2, 9, 3, 4, 5, 6, 7];
  await expect.poll(() => rowIds(page)).toEqual(expected);
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual(expected);
  expect(orderWrites).toEqual([expect.objectContaining({
    draggedRequestId: 9,
    orders: [{ developer: "u1", requestIds: [1, 2, 9, 3, 4] }],
  })]);
  expect(orderWrites[0]?.move).toBeUndefined();
  expect(state.requests).toEqual(before);
  expect(mutations).toEqual([]);
});

test("甘特拖动支持跨组换人并保留未排期末尾规则，多选右键仍有需求操作", async ({ page }) => {
  const { state, mutations, orderWrites } = await preview(page);
  await dragTo(page, nameOf(page, "未排期甲"), nameOf(page, "已排期甲"), "before", false);
  await expect(page.locator('[data-slot="request-reorder-hint"]')).toContainText("未排期需求保持在分组末尾");
  await expect(page.locator("[data-reorder-edge]")).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => rowIds(page)).toEqual([1, 9, 2, 3, 4, 5, 6, 7]);
  await dragTo(page, nameOf(page, "未分配乙"), nameOf(page, "未分配甲"), "before");
  await expect.poll(() => rowIds(page)).toEqual([1, 9, 2, 3, 4, 5, 7, 6]);
  await nameOf(page, "已排期甲").click();
  await nameOf(page, "已排期乙").click({ modifiers: ["Shift"] });
  await expect(nameOf(page, "归档需求")).toHaveAttribute("aria-pressed", "false");
  await nameOf(page, "已排期甲").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["编辑", "归档", "删除", "顺排预览", "按准入日期排序", "取消选中"]);
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("需求名", { exact: false })).toHaveValue("已排期甲");
  await dialog.getByRole("button", { name: "收起面板", exact: true }).click();
  await dragTo(page, nameOf(page, "已排期甲"), nameOf(page, "其他人员需求"), "after");
  await expect.poll(() => rowIds(page)).toEqual([9, 2, 3, 4, 5, 1, 7, 6]);
  expect(state.requests.find((row) => row.id === 1)?.developer).toBe("u2");
  expect(orderWrites.map(({ orders, move }) => ({ orders, move }))).toEqual([
    { orders: [{ developer: "", requestIds: [7, 6] }], move: undefined },
    { orders: [{ developer: "u2", requestIds: [5, 1, 8] }], move: { requestId: 1, developer: "u2" } },
  ]);
  expect(mutations).toEqual([]);
});

test("筛选下拖排行保留隐藏行的位置，清除筛选后次序完整", async ({ page }) => {
  const rows = requests.slice(0, 4).map((row): ApiRequest => ({ ...row, name: `排序${row.id}`, status: row.id === 2 ? "HOLD" : "待开发" }));
  await preview(page, { rows });
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await page.getByRole("button", { name: "状态：全部", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "待开发", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => rowIds(page)).toEqual([4, 3, 1]);
  await dragTo(page, nameOf(page, "排序4"), nameOf(page, "排序1"), "before");
  await expect.poll(() => rowIds(page)).toEqual([3, 4, 1]);
  await page.getByRole("button", { name: "状态：待开发", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "待开发", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => rowIds(page)).toEqual([3, 4, 2, 1]);
});

test("自定义右键不叠浏览器菜单，键盘与窄屏边缘可用，输入保留原生菜单", async ({ page }) => {
  await preview(page);
  for (const tab of ["甘特图", "需求池"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const name = nameOf(page, "已排期甲");
    expect(await name.evaluate((element) => !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })))).toBe(true);
    const menu = page.getByRole("menu", { name: "需求操作", exact: true });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(name).toBeFocused();
    await name.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "编辑", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "删除", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await name.evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 312, clientY: 560 })));
    await expect(menu).toBeInViewport();
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(312);
    expect(box.y + box.height).toBeLessThanOrEqual(560);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  expect(await page.locator("body").evaluate((element) => !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  await nameOf(page, "已排期甲").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const input = page.getByRole("dialog").getByLabel("需求名", { exact: false });
  expect(await input.evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("游客可看需求详情和优先级，无法修改优先级", async ({ page }) => {
  const { mutations } = await preview(page, {
    guest: true,
    rows: requests.map((row) => row.id === 3 ? { ...row, requesterRank: 1 } : row),
  });
  for (const tab of ["甘特图", "需求池"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const name = nameOf(page, "未排期甲");
    await name.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["查看详情"]);
    await page.getByRole("menuitem", { name: "查看详情", exact: true }).click();
    await expect(page.getByRole("dialog").locator("input, textarea, select")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
    await name.dblclick();
    await expect(page.getByRole("heading", { name: "需求详情", exact: true })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  }
  const rank = page.locator('[data-row="3"] [data-key="requesterRank"]');
  await expect(rank.getByRole("button")).toHaveCount(0);
  await rank.click();
  await rank.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(rank).toHaveText("1");
  expect(mutations).toEqual([]);
});

for (const tab of ["甘特图", "需求池", "已归档"] as const) {
  test(`${tab}搜索框内部滚动不关闭需求菜单，列表滚动仍会关闭`, async ({ page }) => {
    const name = "订单指标口径统一及多端排期标记回归验证-长名称搜索";
    const archived = tab === "已归档";
    const { state } = await preview(page, { rows: [request({ name, archived })] });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.getByRole("button", { name: "展开搜索", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "搜索需求", exact: true });
    await search.fill(name);
    const menu = page.getByRole("menu", { name: "需求操作", exact: true });
    await nameOf(page, name).click({ button: "right" });
    await expect(menu).toBeVisible();
    await search.evaluate((element) => element.dispatchEvent(new Event("scroll")));
    await expect(menu).toBeVisible();
    await search.locator("..").evaluate((element) => element.dispatchEvent(new Event("scroll")));
    await expect(menu).toBeVisible();
    const container = page.locator(`[data-scroll-container="${tab === "甘特图" ? "gantt" : "table"}"]`);
    await container.evaluate((element) => element.dispatchEvent(new Event("scroll")));
    await expect(menu).toHaveCount(0);
    await nameOf(page, name).click({ button: "right" });
    if (archived) {
      await page.getByRole("menuitem", { name: "恢复到需求池", exact: true }).click();
      await expect(nameOf(page, name)).toHaveCount(0);
      expect(state.requests[0]!.archived).toBe(false);
    } else {
      await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "编辑需求", exact: true })).toBeVisible();
    }
  });
}

test("长列表名称拖动可沿边缘滚动到虚拟化行", async ({ page }) => {
  const rows = Array.from({ length: 70 }, (_, index) => request({ id: index + 1, name: `长列表${index + 1}`, start: "", delivery: "" }));
  const { mutations } = await preview(page, { rows });
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  const wrap = page.locator('[data-scroll-container="table"]');
  const box = (await nameOf(page, "长列表70").boundingBox())!;
  const bounds = (await wrap.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, bounds.y + bounds.height - 5, { steps: 10 });
  await expect.poll(() => wrap.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await expect(page.locator('[data-slot="request-reorder-hint"]')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[data-slot="request-reorder-hint"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("rsm.ui.v2:u1") ?? "{}").poolRowOrder?.indexOf(70) ?? 0)).toBeGreaterThan(15);
  expect(mutations).toEqual([]);
});

for (const archive of [false, true]) {
  const tab = archive ? "已归档" : "需求池";
  test(`${tab}可拖动需求列宽，双击分隔线适应视口外的最长名称`, async ({ page }) => {
    const name = "用于检查需求列表整列适应的很长需求名称".repeat(3);
    const rows = Array.from({ length: 70 }, (_, index) => request({ id: index + 1, name: index ? `需求 ${index}` : name, archived: archive }));
    rows.push(request({ id: 71, name, archived: !archive }));
    const { mutations } = await preview(page, { rows });
    const currentTab = page.getByRole("tab", { name: tab, exact: true });
    await currentTab.click();
    const wrap = page.getByRole("table", { name: archive ? "归档需求列表" : "需求列表", exact: true });
    const separator = wrap.getByRole("separator", { name: "调整需求列宽", exact: true });
    const rowEdge = wrap.locator('[data-row="70"] [data-table-column-resize]');
    await expect(nameOf(page, name)).toHaveCount(0);
    await separator.press("Home");
    const minimum = Number(await separator.getAttribute("aria-valuemin"));
    await expect(separator).toHaveAttribute("aria-valuenow", String(minimum));
    const edge = (await separator.boundingBox())!;
    const x = edge.x + edge.width / 2;
    const y = edge.y + edge.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 48, y, { steps: 6 });
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", String(minimum + 48));
    await separator.dblclick();
    const fitted = Number(await separator.getAttribute("aria-valuenow"));
    expect(fitted).toBeGreaterThan(500);
    expect(fitted).toBeLessThan(Number(await separator.getAttribute("aria-valuemax")));

    await separator.press("End");
    await rowEdge.dblclick();
    await expect(separator).toHaveAttribute("aria-valuenow", String(fitted));
    await expect(page.getByRole("button", { name: "重置排序", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("tab", { name: archive ? "需求池" : "已归档", exact: true }).click();
    await expect(page.getByRole("separator", { name: "调整需求列宽", exact: true })).toHaveAttribute("aria-valuenow", "230");
    await currentTab.click();
    await page.reload();
    await expect(separator).toHaveAttribute("aria-valuenow", String(fitted));

    await wrap.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const label = nameOf(page, name);
    await expect(label).toBeVisible();
    expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const { gap, padding } = await label.evaluate((element) => {
      const cell = element.closest('[data-key="name"]')!;
      const text = document.createRange();
      text.selectNodeContents(element);
      return {
        gap: cell.getBoundingClientRect().right - text.getBoundingClientRect().right,
        padding: parseFloat(getComputedStyle(cell).paddingRight),
      };
    });
    expect(Math.abs(gap - padding)).toBeLessThanOrEqual(1);
    expect(mutations).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`时间轴与人员分组层级清楚，长姓名单行，日夜窄屏布局稳定（${theme}）`, async ({ page }, testInfo) => {
    const { state } = await preview(page, { theme });
    const longName = "跨团队研发协作人员名称很长的情况";
    state.users = state.users.map((user) => user.id === "u2" ? { ...user, username: longName } : user);
    await page.reload();
    const table = page.getByRole("table", { name: "按天显示的人员需求排期", exact: true });
    const group = page.getByRole("button", { name: `收起${longName}的 1 条需求`, exact: true });
    for (const [width, height] of [[1440, 900], [1366, 768], [390, 844], [320, 568]]) {
      await page.setViewportSize({ width, height });
      await expect(group).toBeVisible();
      await expect.poll(() => group.locator("xpath=ancestor::tr").evaluate((element) => element.getBoundingClientRect().height)).toBe(28);
      const name = group.locator('[class*="personName"]');
      const count = group.locator('[class*="personCount"]');
      const nameBox = (await name.boundingBox())!;
      const countBox = (await count.boundingBox())!;
      expect(Math.abs(nameBox.y + nameBox.height / 2 - countBox.y - countBox.height / 2)).toBeLessThan(1);
      expect(nameBox.x + nameBox.width).toBeLessThan(countBox.x);
      const colors = await table.evaluate((element) => {
        const month = getComputedStyle(element.querySelector('th[scope="colgroup"]')!);
        const day = getComputedStyle(element.querySelector('thead tr:last-child th:not([aria-hidden]):not([aria-current])')!);
        const person = getComputedStyle(element.querySelector('th[scope="rowgroup"]')!);
        const ratio = (foreground: string, background: string) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const luminance = (color: string) => {
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((part) => {
              const channel = part / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
          };
          const first = luminance(foreground);
          const second = luminance(background);
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        };
        return { fills: [month.backgroundColor, day.backgroundColor, person.backgroundColor], contrast: [month, day, person].map((style) => ratio(style.color, style.backgroundColor)) };
      });
      expect(new Set(colors.fills).size).toBe(3);
      expect(colors.contrast.every((contrast) => contrast >= 4.5)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath(`hierarchy-${theme}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await group.locator("xpath=ancestor::tr").locator("td").click({ position: { x: 90, y: 18 } });
    await expect(page.getByRole("button", { name: `展开${longName}的 1 条需求`, exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(nameOf(page, "其他人员需求")).toHaveCount(0);
    await page.getByRole("tab", { name: "需求池", exact: true }).click();
    const header = page.getByRole("columnheader", { name: "需求名称", exact: true });
    await expect(header).toBeVisible();
    if (theme === "light") await page.screenshot({ path: testInfo.outputPath("pool-hierarchy.png") });
  });
}
