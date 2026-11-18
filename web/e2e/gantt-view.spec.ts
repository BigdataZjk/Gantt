import { expect, test, type Page } from "@playwright/test";
import type { ApiRequest, Density, State } from "../src/api/types";
import { addDays, diffDays, enumerateDates, todayISO } from "../src/lib/dates";

const today = todayISO();

async function openGantt(page: Page, theme: "light" | "dark" = "light", density: Density = "compact", editable = false, options: {
  autoRange?: boolean;
  count?: number;
  multiplePeople?: boolean;
  lastName?: string;
  fixture?: (state: State, defaultRow: ApiRequest) => Partial<State>;
} = {}) {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const state = await response.json() as State;
  const request: ApiRequest = {
    id: 1,
    revision: 1,
    name: "并行排期 A",
    priority: "P1",
    status: "待开发",
    prd: "https://example.com/gantt-regression",
    requester: "界面回归",
    requestedAt: today,
    domain: state.domains[0]!.name,
    requestType: "常规需求",
    wangyue: "",
    developer: state.users[0]!.id,
    days: editable ? 3 : 5,
    start: editable ? "2026-11-17" : today,
    delivery: editable ? "2026-11-19" : addDays(today, 6),
    project: "",
    brd: "",
    review: "",
    expected: "",
    notes: "",
    segments: [],
    vacation: [],
    overtime: [],
    archived: false,
  };
  const otherUser = { ...state.users[0]!, id: "e2e-other", username: "第二开发人" };
  const count = options.count ?? 40;
  const mockedState: State = {
    ...state,
    me: editable ? state.users.find((user) => user.role === "superadmin")! : null,
    setupRequired: false,
    users: options.multiplePeople ? [...state.users, otherUser] : state.users,
    requests: [
      ...Array.from({ length: count }, (_, index) => ({ ...request, id: index + 1, name: index === count - 1 && options.lastName ? options.lastName : `并行排期 ${index + 1}`, developer: options.multiplePeople && index % 2 ? otherUser.id : request.developer })),
      { ...request, id: 100, name: "归档只读需求", archived: true },
    ],
    preferences: { ...state.preferences, theme, density, domainColors: editable ? { [request.domain]: "#d05d44" } : state.preferences.domainColors },
  };
  Object.assign(mockedState, options.fixture?.(mockedState, request));
  await page.route("**/api/state", (route) => route.fulfill({ json: mockedState }));
  if (editable) {
    await page.route("**/api/requests/1", (route) => {
      expect(route.request().method()).toBe("PUT");
      const body = route.request().postDataJSON() as { request: ApiRequest };
      mockedState.requests = mockedState.requests.map((row) => row.id === 1 ? { ...body.request, revision: row.revision + 1 } : row);
      mockedState.revision += 1;
      return route.fulfill({ json: mockedState });
    });
  }
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.addInitScript(({ start, end, user, theme }) => {
    localStorage.setItem("rsm.theme", theme);
    localStorage.setItem(`rsm.ui.v2:${user}`, JSON.stringify({ ganttRange: { start, end } }));
  }, { start: options.autoRange ? "" : addDays(request.start, -7), end: options.autoRange ? "" : addDays(request.start, 90), user: mockedState.me?.id ?? "guest", theme });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toHaveAttribute("aria-selected", "true");
  return page.locator('[data-scroll-container="gantt"]');
}

test("日期预设点击后移开立即收起，滚动与修饰键不会留下边框", async ({ page }) => {
  const wrap = await openGantt(page);
  const start = await page.getByLabel("甘特图开始日期", { exact: true }).inputValue();
  const presets = page.getByLabel("仅设置结束日期", { exact: true });
  for (const days of [60, 30]) {
    await page.getByLabel("甘特图结束日期", { exact: true }).hover();
    const button = page.getByRole("button", { name: `${days}D`, exact: true });
    await button.click();
    await page.mouse.move(1100, 700);
    await expect(presets).toHaveCSS("opacity", "0");
    await expect.poll(() => presets.evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
    await expect(button).not.toBeFocused();
    await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(addDays(today, days));
    await expect(page.getByLabel("甘特图开始日期", { exact: true })).toHaveValue(start);
    await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.keyboard.press("Control");
    await expect(presets).toHaveCSS("opacity", "0");
    await expect(button).not.toBeFocused();
  }
});

test("日期预设支持键盘展开和选择，焦点边框完整位于按钮内", async ({ page }) => {
  await openGantt(page);
  const presets = page.getByLabel("仅设置结束日期", { exact: true });
  const thirty = page.getByRole("button", { name: "30D", exact: true });
  const sixty = page.getByRole("button", { name: "60D", exact: true });
  await page.getByLabel("甘特图结束日期", { exact: true }).focus();
  for (let index = 0; index < 6 && !(await thirty.evaluate((el) => el === document.activeElement)); index += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(thirty).toBeFocused();
  await expect(presets).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(thirty).toBeFocused();
  await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(addDays(today, 30));
  await page.keyboard.press("Tab");
  await expect(sixty).toBeFocused();
  expect(await sixty.evaluate((el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) <= 0;
  })).toBeTruthy();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(addDays(today, 60));
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "全部收起", exact: true })).toBeFocused();
  await expect(presets).toHaveCSS("opacity", "0");
});

test("需求列拖拽实时调整时间轴，上限按未渲染的最长需求计算", async ({ page }) => {
  const name = "验证列宽和时间轴联动的较长需求名称".repeat(3);
  const wrap = await openGantt(page, "light", "compact", false, { autoRange: true, count: 70, lastName: name });
  const separator = wrap.getByRole("separator", { name: "调整需求列宽", exact: true });
  const firstRow = wrap.locator('tr[data-row="1"]');
  const cell = firstRow.locator("[data-request-select]");
  const date = firstRow.locator("[data-date]").first();
  await expect(wrap.getByText(name, { exact: true })).toHaveCount(0);
  const contentWidth = await cell.evaluate((element, title) => {
    const name = element.querySelector<HTMLButtonElement>("[data-name]")!;
    const priority = name.previousElementSibling!;
    const probe = name.cloneNode() as HTMLButtonElement;
    probe.textContent = title;
    probe.style.cssText = "position:absolute; width:max-content; visibility:hidden";
    element.append(probe);
    const style = getComputedStyle(element);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
    const gap = parseFloat(getComputedStyle(name.parentElement!).columnGap);
    const width = probe.getBoundingClientRect().width + priority.getBoundingClientRect().width + gap + padding;
    probe.remove();
    return width;
  }, name);
  const maxWidth = Number(await separator.getAttribute("aria-valuemax"));
  expect(maxWidth).toBe(Math.floor(contentWidth * 1.2));
  const initialWidth = Number(await separator.getAttribute("aria-valuenow"));
  const edge = (await separator.boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 64, y, { steps: 4 });
  await expect(separator).toHaveAttribute("aria-valuenow", String(initialWidth + 64));
  const expanded = (await cell.boundingBox())!;
  expect(expanded.width).toBe(initialWidth + 64);
  expect((await date.boundingBox())!.x).toBeCloseTo(expanded.x + expanded.width, 0);
  await expect.poll(() => wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await page.mouse.move(1390, y);
  await expect(separator).toHaveAttribute("aria-valuenow", String(maxWidth));
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("rsm.ui.v2:guest") || "{}").ganttNameColumnWidth)).toBe(maxWidth);

  await page.setViewportSize({ width: 320, height: 640 });
  await expect.poll(() => separator.getAttribute("aria-valuenow").then(Number)).toBeLessThan(maxWidth);
  expect(await wrap.evaluate((el) => el.clientWidth - Number(el.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")))).toBeGreaterThanOrEqual(80);
  await expect.poll(() => wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(separator).toHaveAttribute("aria-valuenow", String(maxWidth));

  await page.getByLabel("甘特图结束日期", { exact: true }).fill(addDays(today, 90));
  await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(separator).toBeInViewport();
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", String(maxWidth - 8));
  await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(addDays(today, 90));
});

for (const [theme, density] of [["light", "compact"], ["dark", "compact"], ["dark", "comfortable"]] as const) {
  test(`并行箭头随缩放隐藏及恢复，悬浮按钮只返回水平起点（${theme}/${density}）`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const wrap = await openGantt(page, theme, density);
    const arrows = page.locator("[data-parallel]");
    const legend = page.getByTestId("gantt-legend").locator('[class*="parallelSymbol"]');
    const back = page.getByRole("button", { name: "返回最左侧", exact: true });
    await expect(arrows.first()).toBeVisible();
    const normal = await arrows.first().boundingBox();
    expect(normal!.width).toBe(18);
    await expect(back).toHaveCount(0);
    const box = (await wrap.boundingBox())!;
    await page.mouse.move(box.x + 194, box.y + 70);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 120);
    await page.keyboard.up("Control");
    await expect(page.getByRole("button", { name: "重置比例", exact: true })).toBeVisible();
    await expect.poll(async () => (await arrows.first().boundingBox())!.width).toBeLessThan(normal!.width - 2);
    expect((await arrows.first().boundingBox())!.height).toBeLessThan(normal!.height - 2);
    expect((await legend.boundingBox())!.width).toBe(18);
    const range = await page.getByLabel("甘特图结束日期", { exact: true }).inputValue();
    const width = await wrap.locator("table").evaluate((el) => getComputedStyle(el).getPropertyValue("--day-width"));
    await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth; el.scrollTop = 200; });
    await expect(back).toBeVisible();
    const position = await back.boundingBox();
    await wrap.evaluate((el) => { el.scrollTop = 350; });
    expect(await back.boundingBox()).toEqual(position);
    await page.screenshot({ path: testInfo.outputPath("floating-return.png") });
    await back.click();
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBe(0);
    await expect(back).toHaveCount(0);
    expect(await wrap.evaluate((el) => el.scrollTop)).toBe(350);
    await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(range);
    expect(await wrap.locator("table").evaluate((el) => getComputedStyle(el).getPropertyValue("--day-width"))).toBe(width);
    await page.mouse.move(box.x + 194, box.y + 70);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 1000);
    await page.keyboard.up("Control");
    await expect(arrows).toHaveCount(0);
    expect((await legend.boundingBox())!.width).toBe(18);
    await page.getByRole("button", { name: "重置比例", exact: true }).click();
    await expect(arrows.first()).toBeVisible();
    expect((await arrows.first().boundingBox())!.width).toBe(normal!.width);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
    expect(errors).toEqual([]);
  });
}

test("减少动态效果时悬浮返回直接到达起点", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const wrap = await openGantt(page);
  await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.getByRole("button", { name: "返回最左侧", exact: true }).click();
  expect(await wrap.evaluate((el) => el.scrollLeft)).toBe(0);
});

test("游客在甘特图、需求池和归档都能打开无表单的只读详情", async ({ page }, testInfo) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/requests")) mutations.push(request.url());
  });
  await openGantt(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "需求详情" }) });
  for (const tab of ["甘特图", "需求池", "已归档"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const name = tab === "已归档" ? "归档只读需求" : tab === "需求池" ? "并行排期 40" : "并行排期 1";
    const button = page.getByRole("button", { name, exact: true });
    await button.dblclick();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("input, textarea, select, [contenteditable=true]")).toHaveCount(0);
    await expect(dialog.getByRole("heading")).toHaveText(["需求详情", "基本信息", "开发信息", "分段排期", "补充信息"]);
    await expect(dialog.getByRole("link", { name: "https://example.com/gantt-regression" })).toHaveAttribute("href", "https://example.com/gantt-regression");
    await dialog.getByRole("button", { name: "复制PRD 链接", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("已复制");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://example.com/gantt-regression");
    if (tab === "甘特图") await page.screenshot({ path: testInfo.outputPath("guest-details.png") });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await button.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
  expect(mutations).toEqual([]);
});

test("视图与筛选共用工具栏，优先级仅部分选中时显示全选且位置固定", async ({ page }, testInfo) => {
  await openGantt(page);
  for (const [width, height] of [[1440, 900], [1366, 768], [1024, 768], [736, 620], [390, 844], [320, 568]]) {
    await page.setViewportSize({ width, height });
    const core = page.getByRole("group", { name: "核心筛选", exact: true });
    const dates = core.getByLabel("甘特图显示日期范围", { exact: true });
    await expect(dates).toBeVisible();
    const date = (await dates.boundingBox())!;
    const tabs = core.getByRole("tablist", { name: "需求视图", exact: true });
    const priorities = core.getByRole("group", { name: "按优先级筛选，可多选", exact: true });
    const tabBox = (await tabs.boundingBox())!;
    const priorityBox = (await priorities.boundingBox())!;
    if (width >= 1366) {
      const developer = (await core.getByRole("button", { name: /^开发人：/ }).boundingBox())!;
      expect(priorityBox.x).toBeGreaterThan(developer.x + developer.width);
      expect(date.x).toBeGreaterThan(priorityBox.x + priorityBox.width);
      expect(Math.abs(date.y - developer.y)).toBeLessThan(2);
      expect(Math.abs(tabBox.y + tabBox.height / 2 - date.y - date.height / 2)).toBeLessThan(1);
      expect(Math.abs(priorityBox.y + priorityBox.height / 2 - date.y - date.height / 2)).toBeLessThan(1);
      await expect(core.getByRole("button", { name: "全部收起", exact: true })).toHaveCount(0);
    }
    const endDate = dates.getByLabel("甘特图结束日期", { exact: true });
    const presets = dates.getByLabel("仅设置结束日期", { exact: true });
    const endBox = (await endDate.boundingBox())!;
    await endDate.hover();
    await expect(presets).toHaveCSS("opacity", "1");
    await expect(presets.getByRole("button", { name: "60D", exact: true })).toBeInViewport({ ratio: 1 });
    const presetBox = (await presets.boundingBox())!;
    expect(presetBox.x).toBeGreaterThan(endBox.x + endBox.width);
    expect(Math.abs(presetBox.y + presetBox.height / 2 - endBox.y - endBox.height / 2)).toBeLessThan(1);
    expect(await dates.boundingBox()).toEqual(date);
    expect(await tabs.boundingBox()).toEqual(tabBox);
    expect(await priorities.boundingBox()).toEqual(priorityBox);
    await page.mouse.move(0, 0);

    const all = core.getByRole("button", { name: "全选", exact: true });
    const p0 = core.getByRole("button", { name: /^P0，/ });
    const p1 = core.getByRole("button", { name: /^P1，/ });
    const p2 = core.getByRole("button", { name: /^P2，/ });
    const box = (await p0.boundingBox())!;
    await expect(all).toHaveCount(0);
    await p0.click();
    await expect(all).toBeVisible();
    const allBox = (await all.boundingBox())!;
    const lastBox = (await p2.boundingBox())!;
    expect(Math.abs(allBox.y + allBox.height / 2 - box.y - box.height / 2)).toBeLessThan(1);
    expect(allBox.x).toBeGreaterThanOrEqual(lastBox.x + lastBox.width);
    await p1.click();
    await p2.click();
    await expect(all).toHaveCount(0);
    expect(await p0.boundingBox()).toEqual(box);
    await p0.click();
    await expect(all).toBeVisible();
    expect(await p0.boundingBox()).toEqual(box);
    await all.click();
    await expect(all).toHaveCount(0);
    await p1.click();
    await expect(all).toBeVisible();
    await p1.click();
    await expect(all).toHaveCount(0);
    expect(await p0.boundingBox()).toEqual(box);
    expect(await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth }))).toEqual({ height, width });
    const legend = (await page.getByTestId("gantt-legend").boundingBox())!;
    expect(legend.y + legend.height).toBeLessThanOrEqual(height);
    if (width === 1440 || width === 320) await page.screenshot({ path: testInfo.outputPath(`filters-${width}.png`) });
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`点击排期不选择，名称选择持续高亮且点击其他位置清除（${theme}）`, async ({ page }) => {
    await openGantt(page, theme, "compact", true);
    const row = page.locator('tr[data-row="1"]');
    const next = page.locator('tr[data-row="2"]');
    const name = row.locator("[data-name]");
    await page.mouse.move(0, 0);
    const background = (target = row) => target.locator(":scope > :not([data-live-particles])").evaluateAll((cells) => cells.map((cell) => ({
      color: getComputedStyle(cell).backgroundColor,
      image: getComputedStyle(cell).backgroundImage,
    })));
    const original = await background();
    expect(original.length).toBeGreaterThan(1);
    await row.locator("[data-bar]").first().click();
    await expect(name).toHaveAttribute("aria-pressed", "false");
    expect((await background()).every((cell) => cell.image !== "none")).toBeTruthy();
    await next.locator("[data-name]").hover();
    expect(await background()).toEqual(original);
    expect((await background(next)).every((cell) => cell.image !== "none")).toBeTruthy();
    await page.mouse.move(0, 0);
    expect(await background()).toEqual(original);
    await expect(name).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("[data-extend]")).toHaveCount(0);
    await expect(row.locator("[data-resize]")).toHaveCount(2);
    await name.click();
    await page.mouse.move(0, 0);
    await expect(name).toHaveAttribute("aria-pressed", "true");
    expect((await background()).every((cell) => cell.image !== "none")).toBeTruthy();
    await row.locator("[data-bar]").first().click();
    await page.mouse.move(0, 0);
    await expect(name).toHaveAttribute("aria-pressed", "false");
    expect(await background()).toEqual(original);
  });

  test(`左右端拖拽的边界和中间格使用需求色，覆盖行高亮并正确提交（${theme}）`, async ({ page }, testInfo) => {
    await openGantt(page, theme, "compact", true);
    const row = page.locator('tr[data-row="1"]');
    const domainColor = await row.locator("[data-bar]").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(domainColor).toBe("rgb(208, 93, 68)");
    for (const [edge, date] of [["start", "2026-11-16"], ["end", "2026-11-20"]] as const) {
      await row.locator("[data-name]").hover();
      const handle = row.locator(`[data-resize][data-edge="${edge}"]`);
      const bounds = (await handle.boundingBox())!;
      const target = row.locator(`td[data-date="${date}"]`);
      const targetBounds = (await target.boundingBox())!;
      const dx = targetBounds.x + targetBounds.width / 2 - bounds.x - bounds.width / 2;
      const pointerX = bounds.x + bounds.width / 2;
      const pointerY = bounds.y + bounds.height / 2;
      await page.mouse.move(pointerX, pointerY);
      await page.mouse.down();
      await page.mouse.move(pointerX + dx, pointerY, { steps: 4 });
      const previewDates = edge === "start"
        ? ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]
        : ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
      for (const previewDate of previewDates) {
        const cell = row.locator(`td[data-date="${previewDate}"]`);
        await expect(cell).toHaveCSS("background-image", /linear-gradient/);
        await expect.poll(() => cell.evaluate((el) => getComputedStyle(el, "::after").backgroundColor)).toBe(domainColor);
        const overlay = await cell.evaluate((el) => {
          const style = getComputedStyle(el, "::after");
          return { content: style.content, opacity: Number(style.opacity), layer: Number(style.zIndex), pointerEvents: style.pointerEvents };
        });
        expect(overlay.content).toBe('""');
        expect(overlay.opacity).toBeGreaterThan(0.5);
        expect(overlay.layer).toBeGreaterThan(0);
        expect(overlay.pointerEvents).toBe("none");
      }
      await page.screenshot({ path: testInfo.outputPath(`resize-${edge}-${theme}.png`) });
      const mutation = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/requests/1");
      await page.mouse.up();
      const body = (await mutation).postDataJSON() as { request: ApiRequest };
      expect(body.request.start).toBe("2026-11-16");
      expect(body.request.delivery).toBe(edge === "start" ? "2026-11-19" : "2026-11-20");
      expect(body.request.days).toBe(edge === "start" ? 4 : 5);
      await expect(target.locator(`[data-resize][data-edge="${edge}"]`)).toHaveCount(1);
      expect(await target.evaluate((el) => getComputedStyle(el, "::after").content)).toBe("none");
    }
  });
}

test("视窗变宽与连续缩小时间轴后日期网格始终填满右侧，重置保留原范围", async ({ page }, testInfo) => {
  const wrap = await openGantt(page);
  const start = await page.getByLabel("甘特图开始日期", { exact: true }).inputValue();
  const end = addDays(today, 30);
  await page.getByLabel("甘特图结束日期", { exact: true }).fill(end);
  const assertFilled = async () => {
    await expect.poll(() => wrap.evaluate((el) => el.querySelector("table")!.getBoundingClientRect().width >= el.clientWidth)).toBeTruthy();
    await expect.poll(() => wrap.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return !!document.elementFromPoint(bounds.right - 16, bounds.y + 120)?.closest("td[data-date]");
    })).toBeTruthy();
  };
  for (const width of [1440, 1920, 2560, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await assertFilled();
  }
  await page.setViewportSize({ width: 1920, height: 900 });
  await wrap.evaluate((el) => { el.scrollTop = 200; });
  const scrollTop = await wrap.evaluate((el) => el.scrollTop);
  const bounds = (await wrap.boundingBox())!;
  for (const delta of [80, 120, 160, 300, 1000]) {
    await page.mouse.move(bounds.x + 220, bounds.y + 70);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, delta);
    await page.keyboard.up("Control");
    await assertFilled();
    expect(await wrap.evaluate((el) => el.scrollTop)).toBe(scrollTop);
  }
  await page.screenshot({ path: testInfo.outputPath("zoom-filled-right.png") });
  await page.getByRole("button", { name: "重置比例", exact: true }).click();
  await assertFilled();
  await expect(page.getByLabel("甘特图开始日期", { exact: true })).toHaveValue(start);
  await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(end);
});

for (const theme of ["light", "dark"] as const) {
  test(`甘特图区按内容收缩，收起后下方显示背景且图例固定（${theme}）`, async ({ page }, testInfo) => {
    const wrap = await openGantt(page, theme);
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole("button", { name: "全部收起", exact: true })).toBeVisible();
      await expect.poll(() => wrap.evaluate((el) => el.scrollHeight > el.clientHeight)).toBeTruthy();
      await wrap.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect(wrap.locator('tr[data-row="40"]')).toBeInViewport();
      const footer = (await page.getByTestId("gantt-legend").boundingBox())!;

      await page.getByRole("button", { name: "全部收起", exact: true }).click();
      await expect(wrap.locator("tr[data-row]")).toHaveCount(0);
      await expect.poll(() => wrap.evaluate((el) => Math.abs(el.clientHeight - el.querySelector("table")!.offsetHeight))).toBeLessThanOrEqual(1);
      await expect.poll(() => wrap.evaluate((el) => el.scrollTop)).toBe(0);
      const bounds = (await wrap.boundingBox())!;
      expect(footer.y - bounds.y - bounds.height).toBeGreaterThan(40);
      expect(await page.getByTestId("gantt-legend").boundingBox()).toEqual(footer);
      expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-scroll-container="gantt"]'), { x: bounds.x + 20, y: bounds.y + bounds.height + 20 })).toBeFalsy();
      if (width === 1440) await page.screenshot({ path: testInfo.outputPath(`collapsed-${theme}.png`) });
      await page.getByRole("button", { name: "全部展开", exact: true }).click();
      await expect.poll(() => wrap.evaluate((el) => el.scrollHeight > el.clientHeight)).toBeTruthy();
      expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width, height });
    }
  });

  test(`初始日期适配屏宽且无横轴，缩放及自定义日期范围可滚动（${theme}）`, async ({ page }, testInfo) => {
    const wrap = await openGantt(page, theme, "compact", false, { autoRange: true, count: 2 });
    const ranges = new Map<number, number>();
    for (const [width, height] of [[1440, 900], [1366, 768], [1024, 768], [736, 620], [390, 844], [320, 568], [1920, 1080], [2560, 1440]]) {
      await page.setViewportSize({ width, height });
      await expect.poll(() => wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
      await expect.poll(() => wrap.evaluate((el) => Math.abs(el.querySelector("table")!.getBoundingClientRect().width - el.clientWidth))).toBeLessThanOrEqual(1);
      await expect(wrap.locator('thead [aria-current="date"]')).toBeInViewport();
      const start = await page.getByLabel("甘特图开始日期", { exact: true }).inputValue();
      const end = await page.getByLabel("甘特图结束日期", { exact: true }).inputValue();
      await expect(wrap.locator("thead th[aria-label]").first()).toHaveAttribute("aria-label", new RegExp(`^${start}`));
      await expect(wrap.locator("thead th[aria-label]").last()).toHaveAttribute("aria-label", new RegExp(`^${end}`));
      ranges.set(width, diffDays(start, end) + 1);
      if (width >= 390) await expect.poll(() => wrap.evaluate((el) => Math.abs(el.clientHeight - el.querySelector("table")!.offsetHeight))).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width, height });
      if (width === 1440 || width === 390) await page.screenshot({ path: testInfo.outputPath(`fit-${width}-${theme}.png`) });
    }
    expect(ranges.get(2560)).toBeGreaterThan(ranges.get(1440)!);
    expect(ranges.get(1440)).toBeGreaterThan(ranges.get(390)!);
    await page.setViewportSize({ width: 1440, height: 900 });
    const start = addDays(today, 21);
    await page.getByLabel("甘特图开始日期", { exact: true }).fill(start);
    await expect.poll(() => wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(addDays(start, ranges.get(1440)! - 1));
    const bounds = (await wrap.boundingBox())!;
    await page.mouse.move(bounds.x + 260, bounds.y + 70);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 160);
    await page.keyboard.up("Control");
    await expect(page.getByRole("button", { name: "重置比例", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重置比例", exact: true }).click();
    await expect.poll(() => wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    const end = addDays(start, 90);
    await page.getByLabel("甘特图结束日期", { exact: true }).fill(end);
    await expect.poll(() => wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBeTruthy();
    await expect(page.getByLabel("甘特图结束日期", { exact: true })).toHaveValue(end);
  });
}

test("整块左上表头切换全部折叠，部分展开时仍执行全部收起", async ({ page }, testInfo) => {
  const wrap = await openGantt(page, "light", "compact", false, { count: 8, multiplePeople: true });
  await expect(wrap.locator("tbody [data-row]")).toHaveCount(8);
  await page.getByRole("button", { name: "收起第二开发人的 4 条需求", exact: true }).click();
  await expect(wrap.locator("tbody [data-row]")).toHaveCount(4);
  const collapse = page.getByRole("button", { name: "全部收起", exact: true });
  const header = collapse.locator("..");
  const buttonBox = (await collapse.boundingBox())!;
  const headerBox = (await header.boundingBox())!;
  expect(Math.abs(buttonBox.width - headerBox.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(buttonBox.height - headerBox.height)).toBeLessThanOrEqual(2);
  await collapse.click({ position: { x: 5, y: 5 } });
  await expect(wrap.locator("tbody [data-row]")).toHaveCount(0);
  const expand = page.getByRole("button", { name: "全部展开", exact: true });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  expect((await wrap.boundingBox())!.height).toBeLessThan(180);
  await page.screenshot({ path: testInfo.outputPath("collapsed-header.png") });
  await expand.click({ position: { x: buttonBox.width - 5, y: buttonBox.height - 5 } });
  await expect(wrap.locator("tbody [data-row]")).toHaveCount(8);
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.focus();
  await page.keyboard.press("Enter");
  await expect(wrap.locator("tbody [data-row]")).toHaveCount(0);
  await expand.press("Space");
  await expect(wrap.locator("tbody [data-row]")).toHaveCount(8);
});

for (const theme of ["light", "dark"] as const) {
  test(`当前开发段粒子跨日期格向右流动并适配线段底色（${theme}）`, async ({ page }, testInfo) => {
    const start = addDays(today, -4);
    const end = addDays(today, 36);
    const leave = addDays(today, 3);
    const rest = addDays(today, 6);
    const overtime = addDays(today, 7);
    const nextStart = addDays(today, 50);
    const nextEnd = addDays(today, 53);
    const wrap = await openGantt(page, theme, "compact", false, {
      fixture: (state, base) => {
        const blue = { id: "e2e-blue", name: "深蓝色", color: "#2457b8" };
        const green = { id: "e2e-green", name: "浅绿色", color: "#4fc788" };
        return {
          domains: [blue, green],
          preferences: { ...state.preferences, domainColors: {} },
          calendar: { ...state.calendar, restDays: [rest, overtime], workDays: enumerateDates(start, nextEnd).filter((date) => date !== rest && date !== overtime) },
          requests: [
            { ...base, id: 1, name: "当前分段", status: "开发中", domain: blue.name, start, delivery: nextEnd, vacation: [leave], overtime: [overtime], segments: [{ start, end, holdBefore: false }, { start: nextStart, end: nextEnd, holdBefore: true }] },
            { ...base, id: 2, name: "浅色开发段", status: "开发中", domain: green.name, delivery: addDays(today, 3) },
            { ...base, id: 3, name: "待估开发段", status: "开发中", domain: blue.name, days: 0, delivery: addDays(today, 2) },
          ],
        };
      },
    });
    const row = wrap.locator('[data-row="1"]');
    const particles = row.locator("[data-live-particles]");
    const firstBar = row.locator(`[data-date="${start}"] [data-bar]`);
    await expect(particles).toHaveCount(1);
    const box = (await particles.boundingBox())!;
    const barBox = (await firstBar.boundingBox())!;
    expect(Math.abs(box.x - barBox.x)).toBeLessThan(1);
    expect(box.width).toBeGreaterThan(barBox.width * 2);
    await expect(particles).toHaveCSS("pointer-events", "none");
    await expect(particles).not.toHaveCSS("mask-image", "none");
    await expect(particles).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(wrap.locator('[data-row="2"] [data-live-particles]')).toHaveCSS("color", "rgb(16, 24, 40)");
    await expect(wrap.locator('[data-row="3"] [data-live-particles]')).toHaveCSS("color", theme === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)");

    const motion = await particles.evaluate((element) => {
      const animation = element.getAnimations({ subtree: true })[0]!;
      const playState = animation.playState;
      animation.pause();
      const position = (time: number) => {
        animation.currentTime = time;
        return new DOMMatrixReadOnly(getComputedStyle(element, "::before").transform);
      };
      const before = position(900);
      const after = position(2400);
      return { playState, x: after.m41 - before.m41, y: after.m42 - before.m42 };
    });
    expect(motion.playState).toBe("running");
    expect(motion.x).toBeGreaterThan(barBox.width);
    expect(motion.y).toBe(0);
    await wrap.screenshot({ path: testInfo.outputPath("live-particles.png") });

    const textureOrigin = () => particles.evaluate((element) => (
      element.getBoundingClientRect().left + element.closest('[data-scroll-container="gantt"]')!.scrollLeft
      + parseFloat(getComputedStyle(element, "::before").backgroundPositionX)
    ));
    const initialOrigin = await textureOrigin();
    await wrap.evaluate((element, width) => { element.scrollLeft = width * 15; }, barBox.width);
    await expect(firstBar).toHaveCount(0);
    await expect(particles).toHaveCount(1);
    expect(await textureOrigin()).toBeCloseTo(initialOrigin, 0);
    expect(await particles.evaluate((element) => element.getAnimations({ subtree: true })[0]?.currentTime)).toBe(2400);
    await wrap.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await expect(row.locator(`[data-date="${nextStart}"] [data-bar]`)).toBeInViewport();
    await expect(particles).toHaveCount(0);
    await wrap.evaluate((element) => { element.scrollLeft = 0; });
    await expect(particles).toBeVisible();

    const reset = page.getByRole("button", { name: "重置比例", exact: true });
    await expect(reset).toHaveCount(0);
    const wrapBox = (await wrap.boundingBox())!;
    await page.mouse.move(wrapBox.x + 240, wrapBox.y + 60);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 1000);
    await page.keyboard.up("Control");
    await expect(reset).toBeVisible();
    await expect(particles).toHaveCount(0);
    const resetBox = (await reset.boundingBox())!;
    expect(resetBox.x + resetBox.width).toBeLessThan(wrapBox.x + wrapBox.width);
    expect(resetBox.y).toBeGreaterThan(wrapBox.y);
    expect(resetBox.y + resetBox.height).toBeLessThan(wrapBox.y + wrapBox.height);
    await wrap.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    expect(await reset.boundingBox()).toEqual(resetBox);
    await reset.click();
    await expect(reset).toHaveCount(0);
    await expect(particles).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => particles.evaluate((element) => getComputedStyle(element, "::before").animationName)).toBe("none");
    await expect(particles).toBeVisible();
  });
}
