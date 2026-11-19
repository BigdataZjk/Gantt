import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const PASSWORD = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";
const RUN_ID = Date.now().toString(36).toUpperCase();
const MAIN_NAME = `订单指标口径统一E2E-${RUN_ID}`;
const SHOTS = path.resolve(process.cwd(), "../.work/screenshots");

test.describe.configure({ mode: "serial" });

async function login(page: Page, username = "张金科") {
  const stateResponse = await page.request.get("/api/state");
  const state = await stateResponse.json();
  if (state.setupRequired) {
    await page.request.post("/api/setup", { data: { password: PASSWORD } });
  } else if (!state.me || state.me.username !== username) {
    await page.request.post("/api/logout", { data: {} });
    const loginResponse = await page.request.post("/api/login", { data: { username, password: PASSWORD } });
    expect(loginResponse.ok()).toBeTruthy();
  }
  await page.goto("/");
  await expect(page.getByRole("button", { name: "需求", exact: true })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "个性化" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("banner").getByRole("button", { name: "未登录", exact: true })).toBeVisible();
}

async function apiState(page: Page) {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function searchRequirements(page: Page, name: string) {
  const input = page.getByRole("searchbox", { name: "搜索需求" });
  if (!(await input.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "展开搜索" }).click();
  }
  await input.fill(name);
  await page.waitForTimeout(200);
}

async function openEdit(page: Page, name: string) {
  await page.getByRole("tab", { name: "需求池" }).click();
  await searchRequirements(page, name);
  await page.getByRole("button", { name, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "编辑需求" }) });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("真实后端认证后进入应用（HttpOnly 会话）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await login(page);
  await expect(page.getByRole("button", { name: "新增需求" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "甘特图" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("创建需求、持久化与真后端刷新", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "新增需求" }).click();
  await expect(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "新增需求" }) })).toBeVisible();
  await page.locator("#rsm-field-name").fill(MAIN_NAME);
  await page.locator("#rsm-field-prd").fill("https://example.com/prd/e2e");
  await page.locator("#rsm-field-requester").fill("产品-小林");
  await page.getByRole("tab", { name: "开发信息" }).click();
  await page.getByRole("button", { name: "业务域" }).click();
  await page.getByRole("option", { name: "流量域" }).click();
  await page.getByRole("button", { name: "开发人" }).click();
  await page.getByRole("option", { name: "张金科" }).click();
  await page.locator("#rsm-field-start").fill("2026-11-16");
  await page.getByRole("button", { name: "创建需求" }).click();
  await expect(page.getByText("需求已创建")).toBeVisible();
  await page.getByRole("tab", { name: "需求池" }).click();
  await searchRequirements(page, MAIN_NAME);
  await expect(page.getByRole("button", { name: MAIN_NAME, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "甘特图" }).click();
  await expect(page.getByRole("button", { name: MAIN_NAME, exact: true })).toBeVisible();
  await expect(page.getByText("张金科").first()).toBeVisible();
  // 页面刷新后仍能读到 SQLite 中持久化的正式数据
  await page.reload();
  await page.getByRole("tab", { name: "需求池" }).click();
  await searchRequirements(page, MAIN_NAME);
  await expect(page.getByRole("button", { name: MAIN_NAME, exact: true })).toBeVisible();
  const state = await apiState(page);
  const row = state.requests.find((item: { name: string }) => item.name === MAIN_NAME);
  expect(row).toBeTruthy();
  expect(row.id).toBeGreaterThan(0);
});

test("打开编辑仅改备注不改变已存排期（休假标记 / 休息日交付 / 多段 HOLD）", async ({ page }) => {
  await login(page);
  const initial = await apiState(page);
  const singleName = `休息日交付-${RUN_ID}`;
  const multiName = `多段HOLD-${RUN_ID}`;
  const makeRequest = (payload: Record<string, unknown>) => ({
    id: 0,
    revision: 0,
    priority: "P1",
    status: "待开发",
    prd: "https://example.com/prd/regression",
    requester: "回归测试",
    requestedAt: "2026-11-16",
    domain: "流量域",
    requestType: "常规需求",
    wangyue: "",
    developer: "",
    project: "",
    brd: "",
    review: "",
    expected: "",
    notes: "",
    segments: [],
    vacation: [],
    overtime: [],
    archived: false,
    ...payload,
  });
  let revision = initial.revision;
  for (const payload of [
    makeRequest({ name: singleName, days: 1, start: "2026-12-04", delivery: "2026-12-05", vacation: ["2026-12-04"] }),
    makeRequest({
      name: multiName,
      days: 4,
      start: "2026-12-07",
      delivery: "2026-12-12",
      segments: [
        { start: "2026-12-07", end: "2026-12-08", holdBefore: false },
        { start: "2026-12-10", end: "2026-12-12", holdBefore: true },
      ],
    }),
  ]) {
    const response = await page.request.post("/api/requests", { data: { baseRevision: revision, request: payload } });
    expect(response.ok()).toBeTruthy();
    const state = await response.json();
    const created = state.requests.find((item: { name: string }) => item.name === (payload as unknown as { name: string }).name);
    expect(created).toBeTruthy();
    revision = state.revision;
  }
  const before = await apiState(page);
  const singleBefore = before.requests.find((item: { name: string }) => item.name === singleName);
  const multiBefore = before.requests.find((item: { name: string }) => item.name === multiName);
  expect(singleBefore.delivery).toBe("2026-12-05");
  expect(multiBefore.delivery).toBe("2026-12-12");
  expect(multiBefore.segments[1].holdBefore).toBe(true);

  const singleDialog = await openEdit(page, singleName);
  await expect(page.locator("#rsm-field-delivery")).toHaveValue("2026-12-05");
  await page.getByRole("tab", { name: "补充信息" }).click();
  await page.locator("#rsm-field-notes").fill("仅改备注，不应重算排期");
  await singleDialog.getByRole("button", { name: "保存需求" }).click();
  await expect(singleDialog).toBeHidden();

  const multiDialog = await openEdit(page, multiName);
  await expect(page.locator("#rsm-field-delivery")).toHaveValue("2026-12-12");
  await page.getByRole("tab", { name: "补充信息" }).click();
  await page.locator("#rsm-field-notes").fill("多段仅改备注");
  await multiDialog.getByRole("button", { name: "保存需求" }).click();
  await expect(multiDialog).toBeHidden();

  const after = await apiState(page);
  const singleAfter = after.requests.find((item: { name: string }) => item.name === singleName);
  const multiAfter = after.requests.find((item: { name: string }) => item.name === multiName);
  expect(singleAfter.start).toBe(singleBefore.start);
  expect(singleAfter.delivery).toBe(singleBefore.delivery);
  expect(singleAfter.days).toBe(singleBefore.days);
  expect(singleAfter.vacation).toEqual(singleBefore.vacation);
  expect(singleAfter.segments).toEqual(singleBefore.segments);
  expect(multiAfter.start).toBe(multiBefore.start);
  expect(multiAfter.delivery).toBe(multiBefore.delivery);
  expect(multiAfter.days).toBe(multiBefore.days);
  expect(multiAfter.segments).toEqual(multiBefore.segments);
});

test("甘特图缩放仅在图表区域生效并可重置", async ({ page }) => {
  await login(page);
  const wrap = page.locator("table[aria-label='按天显示的人员需求排期']").locator("..");
  await expect(wrap).toBeVisible();
  const box = await wrap.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 600);
  await page.keyboard.up("Control");
  await expect(page.getByRole("button", { name: "重置比例" })).toBeVisible();
  await page.getByRole("button", { name: "重置比例" }).click();
  await expect(page.getByRole("button", { name: "重置比例" })).toHaveCount(0);
});

test("右键归档、归档只读详情与恢复", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "需求池" }).click();
  await searchRequirements(page, MAIN_NAME);
  await page.getByRole("button", { name: MAIN_NAME, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "归档" }).click();
  await expect(page.getByText("已归档，可在需求归档中查看")).toBeVisible();
  await page.getByRole("tab", { name: "已归档" }).click();
  const archived = page.getByRole("button", { name: MAIN_NAME, exact: true });
  await expect(archived).toBeVisible();
  await archived.dblclick();
  const drawer = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "需求详情" }) });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "基本信息" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "开发信息" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "补充信息" })).toBeVisible();
  await expect(drawer.locator("input")).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: MAIN_NAME, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "恢复到需求池" }).click();
  await expect(page.getByText("已恢复到需求池")).toBeVisible();
});

test("筛选、搜索与显示字段", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "需求池" }).click();
  await page.getByRole("button", { name: /业务域：全部/ }).click();
  await page.getByRole("checkbox", { name: "流量域" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /业务域：流量域/ })).toBeVisible();
  await page.getByRole("button", { name: "展开搜索" }).click();
  await page.getByRole("searchbox", { name: "搜索需求" }).fill("不存在的需求关键字");
  await expect(page.getByText("没有匹配的需求")).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索需求" }).fill("");
  await page.getByRole("button", { name: "显示字段" }).click();
  await expect(page.getByRole("checkbox", { name: "显示字段：项目" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("日夜切换与桌面/窄屏截图", async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await login(page);
  await page.getByRole("tab", { name: "甘特图" }).click();
  await searchRequirements(page, MAIN_NAME);
  await page.waitForTimeout(300);
  const toggle = page.getByRole("switch", { name: /切换为夜间模式|切换为日间模式/ });
  if ((await page.locator("html").getAttribute("data-theme")) === "dark") {
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  }
  await page.screenshot({ path: path.join(SHOTS, "requests-light.png"), fullPage: false });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: path.join(SHOTS, "requests-dark.png"), fullPage: false });
  await page.setViewportSize({ width: 736, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "requests-736-dark.png"), fullPage: false });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "requests-320-dark.png"), fullPage: false });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "角色权限" })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "settings-320-dark.png"), fullPage: false });
});

test("真实权限：游客只读、只读账号禁用、协作者隐藏管理员排期字段", async ({ page }) => {
  await login(page);
  const state = await apiState(page);
  const collabName = `e2e-collab-${RUN_ID}`;
  const readonlyName = `e2e-readonly-${RUN_ID}`;
  for (const [username, role] of [[collabName, "collaborator"], [readonlyName, "readonly"]] as const) {
    const response = await page.request.post("/api/users", { data: { username, password: PASSWORD, role } });
    expect(response.ok()).toBeTruthy();
  }
  void state;

  await logout(page);
  await expect(page.getByRole("button", { name: "新增需求" })).toBeDisabled();

  await login(page, collabName);
  await page.getByRole("button", { name: "新增需求" }).click();
  await expect(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "新增需求" }) })).toBeVisible();
  await expect(page.getByRole("tab", { name: "开发信息" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "补充信息" })).toBeVisible();
  await page.getByRole("button", { name: "收起", exact: true }).click();

  await logout(page);
  await login(page, readonlyName);
  await expect(page.getByRole("button", { name: "新增需求" })).toBeDisabled();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "个性化" }).click();
  await expect(page.getByRole("button", { name: "修改密码" })).toBeEnabled();
});

test("409 冲突：先开编辑再外部更新，旧草稿保存得到 409 且草稿保留", async ({ page }) => {
  await login(page);
  const conflictName = `冲突测试-${RUN_ID}`;
  const stateBefore = await apiState(page);
  const me = stateBefore.users.find((user: { id: string }) => user.id === stateBefore.me.id);
  const createdResponse = await page.request.post("/api/requests", {
    data: {
      baseRevision: stateBefore.revision,
      request: {
        id: 0, revision: 0, name: conflictName, priority: "P1", status: "待开发",
        prd: "https://example.com/prd/conflict", requester: "回归测试", requestedAt: "2026-11-16",
        domain: "流量域", requestType: "常规需求", wangyue: "", developer: me.id, days: 2,
        start: "2026-12-21", delivery: "2026-12-22", project: "", brd: "", review: "", expected: "", notes: "",
        segments: [], vacation: [], overtime: [], archived: false,
      },
    },
  });
  expect(createdResponse.ok()).toBeTruthy();
  const dialog = await openEdit(page, conflictName);
  const nameInput = page.locator("#rsm-field-name");
  await expect(nameInput).toHaveValue(conflictName);
  await page.getByRole("tab", { name: "补充信息" }).click();
  await page.locator("#rsm-field-notes").fill("草稿中的本地备注");

  const state = await apiState(page);
  const row = state.requests.find((item: { name: string }) => item.name === conflictName);
  expect(row).toBeTruthy();
  const external = await page.request.put(`/api/requests/${row.id}`, {
    data: { baseRevision: state.revision, request: { ...row, notes: "外部并发修改", revision: row.revision } },
  });
  expect(external.ok()).toBeTruthy();

  await dialog.getByRole("button", { name: "保存需求" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /数据已被其他人更新|该需求已被其他人修改|冲突/ })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(nameInput).toHaveValue(conflictName);
  await expect(page.locator("#rsm-field-notes")).toHaveValue("草稿中的本地备注");
});
test("甘特拖段/双端拉伸真实保存且无 React 嵌套错误", async ({ page }) => {
  await login(page);
  const state = await apiState(page);
  const me = state.users.find((user: { id: string }) => user.id === state.me.id);
  const name = `甘特交互-${RUN_ID}`;
  const createResponse = await page.request.post("/api/requests", {
    data: {
      baseRevision: state.revision,
      request: {
        id: 0, revision: 0, name, priority: "P1", status: "待开发",
        prd: "https://example.com/prd/gantt", requester: "回归测试", requestedAt: "2026-11-16",
        domain: "流量域", requestType: "常规需求", wangyue: "", developer: me.id, days: 3,
        start: "2026-11-16", delivery: "2026-11-18", project: "", brd: "", review: "", expected: "", notes: "",
        segments: [], vacation: [], overtime: [], archived: false,
      },
    },
  });
  expect(createResponse.ok()).toBeTruthy();
  const createdState = await createResponse.json();
  const created = createdState.requests.find((item: { name: string }) => item.name === name);
  expect(created).toBeTruthy();
  const rowId = created.id as number;

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error" && /validateDOMNesting|nesting|button/i.test(message.text())) errors.push(message.text()); });
  await page.reload();
  await page.getByRole("tab", { name: "甘特图" }).click();
  await page.getByRole("button", { name: "展开搜索" }).click();
  await page.getByRole("searchbox", { name: "搜索需求" }).fill(name);
  const row = page.locator(`tr[data-row="${rowId}"]`);
  await expect(row).toBeVisible();

  const waitPut = () => page.waitForResponse((response) => response.url().includes(`/api/requests/${rowId}`) && response.request().method() === "PUT", { timeout: 20000 });
  const box = await row.locator("[data-bar]").first().boundingBox();
  expect(box).not.toBeNull();
  let put = waitPut();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + box!.height / 2 - 6, { steps: 8 });
  await page.mouse.up({ button: "right" });
  expect((await put).ok()).toBeTruthy();
  let rowState = (await apiState(page)).requests.find((item: { id: number }) => item.id === rowId);
  expect(rowState.start).toBe("2026-11-18");

  const endHandle = page.locator(`tr[data-row="${rowId}"] [data-resize][data-edge="end"]`).last();
  const handleBox = await endHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  put = waitPut();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x - 30, handleBox!.y + handleBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await put).ok()).toBeTruthy();
  rowState = (await apiState(page)).requests.find((item: { id: number }) => item.id === rowId);
  expect(rowState.delivery).not.toBe("2026-11-20");

  await page.waitForTimeout(500);
  await row.locator("[data-name]").click();
  await expect(row.locator("[data-name]")).toHaveAttribute("aria-pressed", "true");
  await expect(row.locator("[data-extend]")).toHaveCount(0);
  const resize = row.locator('[data-resize][data-edge="end"]').last();
  const resizeBox = await resize.boundingBox();
  expect(resizeBox).not.toBeNull();
  put = waitPut();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox!.x + 40, resizeBox!.y + resizeBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await put).ok()).toBeTruthy();

  // 空白双击补排期：第一击记录，第二击按住/松开提交
  let current = (await apiState(page)).requests.find((item: { id: number }) => item.id === rowId);
  const targetDate = (() => {
    const date = new Date(current.delivery + "T12:00:00Z");
    do { date.setUTCDate(date.getUTCDate() + 1); } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
    return date.toISOString().slice(0, 10);
  })();
  const blankCell = page.locator(`tr[data-row="${rowId}"] td[data-date="${targetDate}"]`);
  await expect(blankCell).toBeVisible();
  const blankBox = await blankCell.boundingBox();
  expect(blankBox).not.toBeNull();
  const cellX = blankBox!.x + blankBox!.width / 2;
  const cellY = blankBox!.y + blankBox!.height / 2;
  put = waitPut();
  await page.mouse.click(cellX, cellY);
  await page.waitForTimeout(120);
  await page.mouse.click(cellX, cellY);
  expect((await put).ok()).toBeTruthy();
  current = (await apiState(page)).requests.find((item: { id: number }) => item.id === rowId);
  expect(current.delivery >= targetDate).toBeTruthy();
  expect(current.days).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});
test("右键日标记：工作日休假/取消休假、休息日加班/取消加班", async ({ page }) => {
  await login(page);
  const state = await apiState(page);
  const me = state.users.find((user: { id: string }) => user.id === state.me.id);
  const name = `日标记测试-${RUN_ID}`;
  const created = await page.request.post("/api/requests", {
    data: {
      baseRevision: state.revision,
      request: {
        id: 0, revision: 0, name, priority: "P1", status: "待开发",
        prd: "https://example.com/prd/mark", requester: "回归测试", requestedAt: "2026-11-16",
        domain: "流量域", requestType: "常规需求", wangyue: "", developer: me.id, days: 2,
        start: "2026-12-04", delivery: "2026-12-07", project: "", brd: "", review: "", expected: "",
        notes: "", segments: [], vacation: [], overtime: [], archived: false,
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const rowId = (await created.json()).requests.find((item: { name: string }) => item.name === name).id as number;
  await page.goto("/");
  await page.getByRole("tab", { name: "甘特图" }).click();
  await searchRequirements(page, name);
  const row = page.locator(`tr[data-row="${rowId}"]`);
  await expect(row).toBeVisible();
  const markCell = async (date: string) => row.locator(`td[data-date="${date}"]`).click({ button: "right" });
  const dayMarker = (date: string, kind: string) => row.locator(`td[data-date="${date}"] [data-marker="${kind}"]`);
  const waitPut = () => page.waitForResponse((response) => response.url().includes(`/api/requests/${rowId}`) && response.request().method() === "PUT", { timeout: 20000 });
  const readRow = async () => (await apiState(page)).requests.find((item: { id: number }) => item.id === rowId);

  // 工作日休假 -> 取消休假
  let put = waitPut();
  await markCell("2026-12-04");
  await page.getByRole("menuitem", { name: "休假" }).click();
  expect((await put).ok()).toBeTruthy();
  expect((await readRow()).vacation).toContain("2026-12-04");
  await expect(dayMarker("2026-12-04", "leave")).toBeVisible();
  put = waitPut();
  await markCell("2026-12-04");
  await page.getByRole("menuitem", { name: "取消休假" }).click();
  expect((await put).ok()).toBeTruthy();
  expect((await readRow()).vacation).not.toContain("2026-12-04");
  await expect(dayMarker("2026-12-04", "leave")).toHaveCount(0);

  // 休息日加班 -> 取消加班
  put = waitPut();
  await markCell("2026-12-05");
  await page.getByRole("menuitem", { name: "加班" }).click();
  expect((await put).ok()).toBeTruthy();
  expect((await readRow()).overtime).toContain("2026-12-05");
  await expect(dayMarker("2026-12-05", "overtime")).toBeVisible();
  put = waitPut();
  await markCell("2026-12-05");
  await page.getByRole("menuitem", { name: "取消加班" }).click();
  expect((await put).ok()).toBeTruthy();
  expect((await readRow()).overtime).not.toContain("2026-12-05");
  await expect(dayMarker("2026-12-05", "overtime")).toHaveCount(0);

  // 段外标记必须同时验证 SQLite 中的值与画面，不能只检查成功响应。
  const before = await readRow();
  put = waitPut();
  await markCell("2026-12-12");
  await page.getByRole("menuitem", { name: "加班", exact: true }).click();
  expect((await put).ok()).toBeTruthy();
  await expect(dayMarker("2026-12-12", "overtime")).toBeVisible();
  const marked = await readRow();
  expect(marked.overtime).toContain("2026-12-12");
  expect([marked.start, marked.delivery, marked.days, marked.segments]).toEqual([before.start, before.delivery, before.days, before.segments]);
  await page.reload();
  await expect(dayMarker("2026-12-12", "overtime")).toBeVisible();
  put = waitPut();
  await markCell("2026-12-12");
  await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
  expect((await put).ok()).toBeTruthy();
  await expect(dayMarker("2026-12-12", "overtime")).toHaveCount(0);
  put = waitPut();
  await page.keyboard.press("Control+z");
  expect((await put).ok()).toBeTruthy();
  await expect(dayMarker("2026-12-12", "overtime")).toBeVisible();
  expect((await readRow()).overtime).toContain("2026-12-12");
});

test("多选带标记多段需求顺排预览 batch 请求返回 200 且标记随段移动", async ({ page }) => {
  await login(page);
  const devName = `e2e-seq-dev-${RUN_ID}`;
  const userResponse = await page.request.post("/api/users", { data: { username: devName, password: PASSWORD, role: "collaborator" } });
  expect(userResponse.ok()).toBeTruthy();
  const userState = await userResponse.json();
  const me = userState.users.find((user: { username: string }) => user.username === devName);
  const suffix = RUN_ID;
  const aName = `顺排标记A-SQB-${suffix}`;
  const bName = `顺排标记B-SQB-${suffix}`;
  const cName = `顺排标记C-SQB-${suffix}`;
  const makeBody = (name: string, segments: { start: string; end: string; holdBefore: boolean }[], vacation: string[], days: number) => ({
    baseRevision: 0,
    request: {
      id: 0, revision: 0, name, priority: "P1", status: "待开发",
      prd: "https://example.com/prd/sequence", requester: "回归测试", requestedAt: "2026-11-16",
      domain: "流量域", requestType: "常规需求", wangyue: "", developer: me.id, days,
      start: segments[0]!.start, delivery: segments[segments.length - 1]!.end,
      project: "", brd: "", review: "", expected: "", notes: "",
      segments, vacation, overtime: [], archived: false,
    },
  });
  let revision = userState.revision;
  const createdIds: number[] = [];
  for (const body of [
    makeBody(aName, [{ start: "2026-12-07", end: "2026-12-08", holdBefore: false }, { start: "2026-12-10", end: "2026-12-11", holdBefore: true }], ["2026-12-07"], 4),
    makeBody(bName, [{ start: "2026-12-09", end: "2026-12-10", holdBefore: false }, { start: "2026-12-14", end: "2026-12-15", holdBefore: true }], ["2026-12-09"], 4),
    makeBody(cName, [{ start: "2026-12-10", end: "2026-12-11", holdBefore: false }, { start: "2026-12-17", end: "2026-12-18", holdBefore: true }], ["2026-12-10"], 4),
  ]) {
    const response = await page.request.post("/api/requests", { data: { ...body, baseRevision: revision } });
    expect(response.ok()).toBeTruthy();
    const next = await response.json();
    revision = next.revision;
    createdIds.push(next.requests.find((item: { name: string }) => item.name === body.request.name).id);
  }
  await page.goto("/");
  await page.getByRole("tab", { name: "甘特图" }).click();
  await searchRequirements(page, `SQB-${RUN_ID}`);
  await page.locator(`tr[data-row="${createdIds[0]}"] [data-name]`).click();
  await page.locator(`tr[data-row="${createdIds[2]}"] [data-name]`).click({ modifiers: ["Shift"] });
  for (const id of createdIds) await expect(page.locator(`tr[data-row="${id}"] [data-name]`)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`tr[data-row="${createdIds[0]}"] [data-name]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺排预览" }).click();
  const drawer = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "顺排预览" }) });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("table", { name: "顺排甘特预览", exact: true })).toBeVisible();
  await expect(drawer.locator("[data-preview-row]")).toHaveCount(3);
  await expect(drawer.locator('[data-preview-bar="before"]')).toHaveCount(6);
  await expect(drawer.locator('[data-preview-bar="after"]')).toHaveCount(6);
  const batchResponse = page.waitForResponse((response) => response.url().includes("/api/requests/batch") && response.request().method() === "POST", { timeout: 20000 });
  await expect(drawer.getByRole("button", { name: "应用顺排" })).toBeEnabled();
  await drawer.getByRole("button", { name: "应用顺排" }).click();
  const batch = await batchResponse;
  expect(batch.status()).toBe(200);
  expect((batch.request().postDataJSON() as { requests: unknown[] }).requests).toHaveLength(2);
  const after = await apiState(page);
  for (const id of createdIds) {
    const row = after.requests.find((item: { id: number }) => item.id === id);
    expect(row).toBeTruthy();
    expect(row.vacation.length).toBe(1);
    expect(row.segments.length).toBe(2);
    expect(row.days).toBe(4);
    expect(row.segments[1].holdBefore).toBe(true);
    expect(row.vacation[0]).toBe(row.start);
  }
  const ordered = createdIds.map((id) => after.requests.find((item: { id: number }) => item.id === id));
  expect(ordered[1].start > ordered[0].delivery).toBe(true);
  expect(ordered[2].start > ordered[1].delivery).toBe(true);
});
