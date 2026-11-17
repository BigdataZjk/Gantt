import { expect, test, type Page } from "@playwright/test";
import type { ApiRequest, State } from "../src/api/types";
import { diffDays } from "../src/lib/dates";
import { calendar, domains, request, users } from "../src/test/fixtures";

const rows = [
  request({ id: 1, name: "顺排起点", start: "2026-11-16", delivery: "2026-11-18" }),
  request({ id: 2, name: "交叠需求", start: "2026-11-17", delivery: "2026-11-19", status: "HOLD" }),
  request({ id: 3, name: "分段需求", start: "2026-11-18", delivery: "2026-11-25", days: 4, segments: [{ start: "2026-11-18", end: "2026-11-19", holdBefore: false }, { start: "2026-11-24", end: "2026-11-25", holdBefore: true }] }),
  request({ id: 4, name: "未排期需求", start: "", delivery: "" }),
  request({ id: 5, name: "另一开发人", developer: "u2" }),
  request({ id: 6, name: "另一未排期", developer: "u2", start: "", delivery: "" }),
  request({ id: 7, name: "未分配需求", developer: "", start: "", delivery: "" }),
  request({ id: 8, name: "已归档需求", archived: true }),
];

async function open(page: Page, options: { theme?: "light" | "dark"; guest?: boolean; rows?: ApiRequest[]; order?: number[] } = {}) {
  const original = await (await page.request.get("/api/state")).json() as State;
  const state: State = { ...original, me: options.guest ? null : users[0], setupRequired: false, users, domains, calendar, requests: structuredClone(options.rows ?? rows), preferences: { ...original.preferences, theme: options.theme ?? "light", density: "compact" } };
  const writes: ApiRequest[][] = [];
  let failure = 0;
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if ((path === "/api/requests/batch" && route.request().method() === "POST") || (/^\/api\/requests\/\d+$/.test(path) && route.request().method() === "PUT")) {
      if (failure) return route.fulfill({ status: failure, json: { error: failure === 409 ? "资料已更新，请刷新后重试" : "保存失败，请重试" } });
      const body = route.request().postDataJSON() as { requests?: ApiRequest[]; request?: ApiRequest };
      const updates = body.requests ?? [body.request!];
      writes.push(structuredClone(updates));
      state.requests = state.requests.map((row) => {
        const update = updates.find((item) => item.id === row.id);
        return update ? { ...update, revision: row.revision + 1 } : row;
      });
      state.revision += 1;
      return route.fulfill({ json: state });
    }
    return route.abort();
  });
  await page.addInitScript(({ user, theme, order }) => {
    localStorage.setItem("rsm.theme", theme);
    localStorage.setItem(`rsm.ui.v2:${user}`, JSON.stringify({ ganttRange: { start: "2026-11-09", end: "2026-12-10" }, ganttRowOrder: order ? { u1: order } : {} }));
  }, { user: options.guest ? "guest" : "u1", theme: options.theme ?? "light", order: options.order });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toHaveAttribute("aria-selected", "true");
  return { state, writes, fail: (status: number) => { failure = status; } };
}

const name = (page: Page, id: number) => page.locator(`tr[data-row="${id}"] [data-name]`);
const cell = (page: Page, id: number) => page.locator(`tr[data-row="${id}"] [data-request-select]`);
const selected = (page: Page) => page.locator('tr[data-row][aria-selected="true"]').evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).dataset.row)));
const drawer = (page: Page) => page.getByRole("dialog", { name: "顺排预览", exact: true });

async function selectRange(page: Page, first = 1, last = 3) {
  await name(page, first).click();
  await name(page, last).click({ modifiers: ["Shift"] });
}

async function showPreview(page: Page) {
  await name(page, 1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺排预览", exact: true }).click();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

test("Shift 正反向连选覆盖未排期和未分配需求，保留起点可伸缩选区", async ({ page }) => {
  const { writes } = await open(page);
  await selectRange(page, 2, 7);
  await expect.poll(() => selected(page)).toEqual([2, 3, 4, 5, 6, 7]);
  await name(page, 3).click({ modifiers: ["Shift"] });
  await expect.poll(() => selected(page)).toEqual([2, 3]);
  await name(page, 1).click({ modifiers: ["Shift"] });
  await expect.poll(() => selected(page)).toEqual([1, 2]);
  await selectRange(page, 7, 1);
  await expect.poll(() => selected(page)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  await expect(page.getByRole("status").filter({ hasText: "已选 7 项" })).toBeVisible();
  await expect(page.locator('tr[data-row="8"]')).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`选区与悬停底色相同，点击名称外任意区域清除且不破坏排期（${theme}）`, async ({ page }) => {
    const { state, writes } = await open(page, { theme });
    const before = structuredClone(state.requests);
    await name(page, 1).hover();
    const hover = await cell(page, 1).evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(hover).not.toBe("none");
    await selectRange(page);
    await page.mouse.move(0, 0);
    for (const id of [1, 2, 3]) {
      expect(await page.locator(`tr[data-row="${id}"]`).evaluate((element) => [...element.children].every((child) => getComputedStyle(child).backgroundImage === getComputedStyle(element.querySelector("th")!).backgroundImage))).toBe(true);
      await expect(cell(page, id)).toHaveCSS("background-image", hover);
    }
    const targets = [
      page.locator('tr[data-row="1"] td[data-date="2026-11-10"]'),
      page.locator('tr[data-row="1"] [data-bar]').first(),
      page.getByText("优先级 / 需求", { exact: true }),
      page.getByTestId("gantt-legend").getByLabel("需求数量", { exact: true }),
      page.getByLabel("甘特图开始日期", { exact: true }),
    ];
    for (const target of targets) {
      await selectRange(page);
      await target.click();
      await page.mouse.move(0, 0);
      await expect.poll(() => selected(page)).toEqual([]);
      await expect(cell(page, 1)).toHaveCSS("background-image", "none");
    }
    expect(state.requests).toEqual(before);
    expect(writes).toHaveLength(0);
  });

  test(`整个冻结名称格的左右边缘和优先级都能右键，多选菜单与单选一致（${theme}）`, async ({ page }) => {
    const { writes } = await open(page, { theme });
    await selectRange(page);
    for (const id of [1, 2, 3]) {
      for (const edge of ["right", "left", "priority"] as const) {
        const bounds = (await cell(page, id).boundingBox())!;
        const position = { x: edge === "right" ? bounds.width - 2 : edge === "left" ? 2 : 25, y: bounds.height / 2 };
        await cell(page, id).click({ button: "right", position });
        await expect(page.getByRole("menuitem")).toHaveText(["编辑", "归档", "删除", "顺排预览", "按准入日期排序", "取消选中"]);
        await expect.poll(() => selected(page)).toEqual([1, 2, 3]);
        await page.keyboard.press("Escape");
      }
    }
    await name(page, 4).click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["编辑", "归档", "删除"]);
    await expect.poll(() => selected(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await name(page, 1).click();
    await name(page, 1).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "顺排预览", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await name(page, 2).click({ modifiers: ["ControlOrMeta"] });
    await name(page, 2).press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "顺排预览", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "取消选中", exact: true }).click();
    await expect.poll(() => selected(page)).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  test(`顺排图展示原排期和调整后关系，含保持起始项、HOLD 及精确日期范围（${theme}）`, async ({ page }, testInfo) => {
    const { state, writes } = await open(page, { theme });
    const original = structuredClone(state.requests);
    await selectRange(page, 1, 4);
    await showPreview(page);
    const chart = drawer(page).getByRole("table", { name: "顺排甘特预览", exact: true });
    await expect(chart.locator("[data-preview-row]")).toHaveCount(4);
    await expect(chart.locator('[data-preview-row="1"]')).toContainText("保持");
    await expect(chart.locator('[data-preview-row="4"]')).toContainText("未排期");
    await expect(chart.locator('[data-preview-row="1"] [data-preview-bar="after"]')).toHaveAttribute("data-start", "2026-11-16");
    await expect(chart.locator('[data-preview-bar="before"]')).toHaveCount(4);
    await expect(chart.locator('[data-preview-bar="after"]')).toHaveCount(4);
    await expect(chart.locator('[data-preview-row="3"] [data-tooltip*="顺排后 HOLD"]')).toBeVisible();
    const boundaries = await chart.locator('[data-preview-bar]').evaluateAll((elements) => elements.map((element) => ({ start: (element as HTMLElement).dataset.start!, end: (element as HTMLElement).dataset.end! })));
    const start = boundaries.map((bar) => bar.start).sort()[0]!;
    const end = boundaries.map((bar) => bar.end).sort().at(-1)!;
    await expect(chart).toHaveAttribute("data-start", start);
    await expect(chart).toHaveAttribute("data-end", end);
    const after = chart.locator('[data-preview-bar="after"]');
    const barA = (await after.nth(0).boundingBox())!;
    const barB = (await after.nth(1).boundingBox())!;
    expect(barA.x + barA.width).toBeLessThanOrEqual(barB.x + 1);
    const timeline = (await chart.locator("tbody td").first().boundingBox())!;
    const expectedWidth = 3 / (diffDays(start, end) + 1) * timeline.width;
    expect(Math.abs(barA.width - expectedWidth)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath(`sequence-${theme}.png`) });
    expect(state.requests).toEqual(original);
    expect(writes).toHaveLength(0);
    await drawer(page).getByRole("button", { name: "取消", exact: true }).click();
    await expect(drawer(page)).toHaveCount(0);
    expect(writes).toHaveLength(0);
  });
}

test("Shift 按当前个人顺序和筛选连选，隐藏及收起需求不进入选择", async ({ page }) => {
  await open(page, { order: [3, 2, 1, 4] });
  await selectRange(page, 3, 1);
  await expect.poll(() => selected(page)).toEqual([3, 2, 1]);
  await page.getByRole("button", { name: "状态：全部", exact: true }).click();
  await page.getByRole("dialog").getByRole("checkbox", { name: "待开发", exact: true }).click();
  await page.keyboard.press("Escape");
  await selectRange(page, 3, 4);
  await expect.poll(() => selected(page)).toEqual([3, 1, 4]);
  await page.getByRole("button", { name: "收起张金科的 3 条需求", exact: true }).click();
  await expect.poll(() => selected(page)).toEqual([]);
  await name(page, 5).click({ modifiers: ["Shift"] });
  await expect.poll(() => selected(page)).toEqual([5]);
});

test("虚拟化跨屏连续选择包含中间全部需求，滚动不丢失选区", async ({ page }) => {
  await open(page, { rows: Array.from({ length: 80 }, (_, index) => request({ id: index + 1, name: `连续需求${index + 1}` })) });
  const wrap = page.locator('[data-scroll-container="gantt"]');
  await name(page, 1).click();
  await wrap.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(name(page, 80)).toBeVisible();
  await name(page, 80).click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status").filter({ hasText: "已选 80 项" })).toBeVisible();
  await wrap.evaluate((element) => { element.scrollTop = 0; });
  await expect(name(page, 1)).toHaveAttribute("aria-pressed", "true");
  await expect(name(page, 2)).toHaveAttribute("aria-pressed", "true");
  await name(page, 1).click({ button: "right" });
  await expect(page.getByRole("menu")).toContainText("已选 80 项");
});

test("未选中但会随动的需求在顺排图中明确标记，无关需求不进入范围", async ({ page }) => {
  await open(page, { rows: [
    ...rows.slice(0, 3),
    request({ id: 9, name: "随动参照", start: "2026-11-19", delivery: "2026-11-23" }),
    request({ id: 10, name: "无关远期", developer: "u2", start: "2027-05-04", delivery: "2027-05-06" }),
  ] });
  await selectRange(page);
  await showPreview(page);
  await expect(drawer(page).locator('[data-preview-row="9"]')).toContainText("随动");
  await expect(drawer(page).locator('[data-preview-row="9"]')).toHaveAttribute("data-preview-selected", "false");
  await expect(drawer(page).locator('[data-preview-row="10"]')).toHaveCount(0);
  await expect(drawer(page).getByRole("table")).not.toHaveAttribute("data-end", "2027-05-06");
});

test("仅未排期需求也可连选预览，不生成虚构排期且禁止应用", async ({ page }) => {
  const { writes } = await open(page, { rows: [request({ id: 1, start: "", delivery: "" }), request({ id: 2, name: "未分配", developer: "", start: "", delivery: "" })] });
  await selectRange(page, 1, 2);
  await showPreview(page);
  await expect(drawer(page).locator("[data-preview-row]")).toHaveCount(2);
  await expect(drawer(page).locator("[data-preview-bar]")).toHaveCount(0);
  await expect(drawer(page).getByRole("button", { name: "应用顺排", exact: true })).toBeDisabled();
  await expect(drawer(page).getByText("当前排期无需移动。", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
});

for (const status of [409, 503]) {
  test(`顺排保存 ${status} 保留甘特预览，恢复后可应用并批量撤回`, async ({ page }) => {
    const { state, writes, fail } = await open(page);
    const original = structuredClone(state.requests);
    await selectRange(page);
    await showPreview(page);
    fail(status);
    await drawer(page).getByRole("button", { name: "应用顺排", exact: true }).click();
    await expect(page.getByText(status === 409 ? "资料已更新，请刷新后重试" : "保存失败，请重试", { exact: true })).toBeVisible();
    await expect(drawer(page)).toBeVisible();
    expect(state.requests).toEqual(original);
    expect(writes).toHaveLength(0);
    fail(0);
    await drawer(page).getByRole("button", { name: "应用顺排", exact: true }).click();
    await expect(drawer(page)).toHaveCount(0);
    expect(writes[0]).toHaveLength(2);
    expect(state.requests[1]!.start).toBe("2026-11-19");
    expect(state.requests[2]!.start > state.requests[1]!.delivery).toBe(true);
    await expect.poll(() => selected(page)).toEqual([]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => writes.length).toBe(2);
    expect(state.requests.map((row) => ({ ...row, revision: 0 }))).toEqual(original.map((row) => ({ ...row, revision: 0 })));
  });
}

test("预览期间资料变化后先重算提示，第二次确认才保存", async ({ page }) => {
  const { state, writes } = await open(page);
  await selectRange(page);
  await showPreview(page);
  state.requests[1]!.notes = "其他人补充的备注";
  state.revision += 1;
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/state")),
    page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))),
  ]);
  expect((await response.json() as State).revision).toBe(state.revision);
  await drawer(page).getByRole("button", { name: "应用顺排", exact: true }).click();
  await expect(page.getByText("数据已变化，顺排预览已更新，请重新核对。", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(0);
  await drawer(page).getByRole("button", { name: "应用顺排", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  expect(writes[0]!.find((row) => row.id === 2)?.notes).toBe("其他人补充的备注");
});

for (const theme of ["light", "dark"] as const) {
  test(`320px 和 390px 预览图内滚动，应用按钮可见且页面不溢出（${theme}）`, async ({ page }, testInfo) => {
    await open(page, { theme });
    await selectRange(page);
    await showPreview(page);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      await expect(drawer(page).getByRole("button", { name: "应用顺排", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      const chartViewport = drawer(page).locator('[data-scroll-container="sequence-preview"]');
      expect(await chartViewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await chartViewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await expect(drawer(page).locator('[data-preview-row="1"] th')).toBeInViewport();
      expect(await drawer(page).locator('[data-preview-row="3"] th').evaluate((element) => {
        const background = getComputedStyle(element).backgroundColor;
        const color = document.createElement("span");
        color.style.backgroundColor = "var(--rsm-panel)";
        element.append(color);
        const expected = getComputedStyle(color).backgroundColor;
        color.remove();
        return background === expected && !background.startsWith("rgba");
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`sequence-${theme}-${width}.png`) });
    }
  });
}

test("游客右键名称格边缘只显示查看详情，不出现多选和顺排", async ({ page }) => {
  await open(page, { guest: true });
  await selectRange(page);
  await expect.poll(() => selected(page)).toEqual([]);
  const bounds = (await cell(page, 1).boundingBox())!;
  await cell(page, 1).click({ button: "right", position: { x: bounds.width - 2, y: bounds.height / 2 } });
  await expect(page.getByRole("menuitem")).toHaveText(["查看详情"]);
});
