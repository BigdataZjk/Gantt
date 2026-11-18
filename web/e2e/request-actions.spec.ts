import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
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
  const mutations: { method: string; id: number }[] = [];
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.route("**/api/requests/**", async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
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
  return { state, mutations };
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

test("需求池与甘特图完整包含未排期、未分配和日期轴外需求", async ({ page }) => {
  await preview(page);
  await expect.poll(() => rowIds(page)).toEqual([1, 2, 3, 4, 5, 8, 6, 7]);
  await expect(page.getByRole("button", { name: "收起-的 2 条需求", exact: true })).toBeVisible();
  await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("8 条需求");
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await expect.poll(() => rowIds(page)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("8 条需求");
});

for (const tab of ["甘特图", "需求池"] as const) {
  test(`${tab}右键可编辑归档删除，双击不编辑，两个视图同步移除`, async ({ page }) => {
    const { state, mutations } = await preview(page);
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const name = nameOf(page, "未排期甲");
    await name.dblclick();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await name.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["编辑", "归档", "删除"]);
    await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "编辑需求", exact: true }) });
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("需求名", { exact: false })).toHaveValue("未排期甲");
    await editor.getByRole("button", { name: "收起面板", exact: true }).click();
    await name.click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档", exact: true }).click();
    await expect(name).toHaveCount(0);
    expect(state.requests.find((row) => row.id === 3)?.archived).toBe(true);
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
    await page.getByRole("tab", { name: tab === "甘特图" ? "需求池" : "甘特图", exact: true }).click();
    await expect(nameOf(page, "未排期甲")).toHaveCount(0);
    await expect(nameOf(page, "未排期乙")).toHaveCount(0);
    await expect(page.getByLabel("需求数量", { exact: true })).toHaveText("6 条需求");
    await page.getByRole("tab", { name: "已归档", exact: true }).click();
    await expect(nameOf(page, "未排期甲")).toBeVisible();
    expect(mutations).toEqual([{ method: "POST", id: 3 }, { method: "DELETE", id: 4 }]);
  });

  test(`${tab}名称拖动排序、刷新保留与 Escape 取消，不修改业务数据`, async ({ page }, testInfo) => {
    const { state, mutations } = await preview(page, { theme: tab === "甘特图" ? "light" : "dark" });
    const before = structuredClone(state.requests);
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const edge = tab === "甘特图" ? "before" : "after";
    await dragTo(page, nameOf(page, "未排期乙"), nameOf(page, "未排期甲"), edge, false);
    await expect(page.locator('[data-row="3"]')).toHaveAttribute("data-reorder-edge", edge);
    await page.screenshot({ path: testInfo.outputPath(`${tab}-reorder.png`) });
    await page.mouse.up();
    const expected = tab === "甘特图" ? [1, 2, 4, 3, 5, 8, 6, 7] : [8, 7, 6, 5, 3, 4, 2, 1];
    await expect.poll(() => rowIds(page)).toEqual(expected);
    await expect(page.locator('[data-slot="request-reorder-hint"]')).toHaveCount(0);
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
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => rowIds(page)).toEqual(expected);
    expect(state.requests).toEqual(before);
    expect(mutations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  });
}

test("甘特需求格的两侧空白、优先级和 HOLD 图标均可拖动排序", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 });
  const { state, mutations } = await preview(page, {
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
  const badge = (await source.getByText("P1", { exact: true }).boundingBox())!;
  const holdIcon = source.locator("[data-request-hold]");
  await expect(holdIcon).toBeVisible();
  const icon = (await holdIcon.boundingBox())!;
  const destination = (await target.boundingBox())!;
  const centerY = cell.y + cell.height / 2;
  const positions = [
    { x: cell.x + 2, y: centerY },
    { x: cell.x + cell.width / 2, y: cell.y + 1 },
    { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 },
    { x: cell.x + cell.width - 2, y: centerY },
    { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 },
  ];
  for (const [index, { x, y }] of positions.entries()) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, destination.y + destination.height / 4, { steps: 4 });
    await expect(target).toHaveAttribute("data-reorder-edge", "before");
    if (index < positions.length - 1) await page.keyboard.press("Escape");
    else await wrap.screenshot({ path: testInfo.outputPath("gantt-reorder-from-hold-icon.png") });
    await page.mouse.up();
  }

  const expected = [1, 2, 4, 3, 5, 8, 6, 7];
  await expect.poll(() => rowIds(page)).toEqual(expected);
  await expect(separator).toHaveAttribute("aria-valuenow", width!);
  await page.reload();
  await expect.poll(() => rowIds(page)).toEqual(expected);
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  await expect(nameOf(page, "未排期乙")).toBeVisible();
  await expect(page.locator("[data-request-hold]")).toHaveCount(0);
  await page.getByRole("tab", { name: "已归档", exact: true }).click();
  await expect(nameOf(page, "归档需求")).toBeVisible();
  await expect(page.locator("[data-request-hold]")).toHaveCount(0);
  expect(state.requests).toEqual(before);
  expect(mutations).toEqual([]);
});

test("甘特拖排行保留开发人及未排期末尾规则，多选右键仍有需求操作", async ({ page }) => {
  const { mutations } = await preview(page);
  await dragTo(page, nameOf(page, "未排期甲"), nameOf(page, "已排期甲"), "before", false);
  await expect(page.locator('[data-slot="request-reorder-hint"]')).toContainText("未排期需求保持在分组末尾");
  await expect(page.locator("[data-reorder-edge]")).toHaveCount(0);
  await page.mouse.up();
  await dragTo(page, nameOf(page, "已排期甲"), nameOf(page, "其他人员需求"), "before", false);
  await expect(page.locator('[data-slot="request-reorder-hint"]')).toContainText("请在同一开发人分组内排序");
  await page.mouse.up();
  await expect.poll(() => rowIds(page)).toEqual([1, 2, 3, 4, 5, 8, 6, 7]);
  await dragTo(page, nameOf(page, "未分配乙"), nameOf(page, "未分配甲"), "before");
  await expect.poll(() => rowIds(page)).toEqual([1, 2, 3, 4, 5, 8, 7, 6]);
  await nameOf(page, "已排期甲").click();
  await nameOf(page, "已排期乙").click({ modifiers: ["Meta"] });
  await nameOf(page, "已排期甲").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["编辑", "归档", "删除", "顺排预览", "按准入日期排序", "取消选中"]);
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("需求名", { exact: false })).toHaveValue("已排期甲");
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

test("游客右键仅查看详情，双击只读详情保持可用", async ({ page }) => {
  const { mutations } = await preview(page, { guest: true });
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

for (const theme of ["light", "dark"] as const) {
  test(`时间轴与人员分组层级清楚，长姓名单行，日夜窄屏布局稳定（${theme}）`, async ({ page }, testInfo) => {
    const { state } = await preview(page, { theme });
    const longName = "跨团队研发协作人员名称很长的情况";
    state.users = state.users.map((user) => user.id === "u2" ? { ...user, username: longName } : user);
    await page.reload();
    const table = page.getByRole("table", { name: "按天显示的人员需求排期", exact: true });
    const group = page.getByRole("button", { name: `收起${longName}的 2 条需求`, exact: true });
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
    await expect(page.getByRole("button", { name: `展开${longName}的 2 条需求`, exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(nameOf(page, "其他人员需求")).toHaveCount(0);
    await page.getByRole("tab", { name: "需求池", exact: true }).click();
    const header = page.getByRole("columnheader", { name: "需求名称", exact: true });
    await expect(header).toBeVisible();
    if (theme === "light") await page.screenshot({ path: testInfo.outputPath("pool-hierarchy.png") });
  });
}
