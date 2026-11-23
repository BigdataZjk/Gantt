import { expect, test, type Page } from "@playwright/test";
import type { LogCleanupPreview, LogCleanupRun, LogManagement, State, User } from "../src/api/types";
import { users } from "../src/test/fixtures";

async function open(page: Page, options: { role?: User["role"] | "guest"; theme?: "light" | "dark" } = {}) {
  const original = await (await page.request.get("/api/state")).json() as State;
  const role = options.role ?? "superadmin";
  const state: State = {
    ...original, revision: 100, setupRequired: false, requests: [],
    users: [...users], me: role === "guest" ? null : { ...users[0], role },
    logPolicy: { operationRetentionDays: 0, archiveRetentionDays: 0 },
    logs: [1, 2, 3].map((id) => ({ id, actor: "测试账号", action: `历史操作 ${id}`, createdAt: "2025-01-01T00:00:00Z", reversible: true, undone: false })),
    preferences: { ...original.preferences, theme: options.theme ?? "light" },
  };
  const management: LogManagement = { policy: state.logPolicy!, operationCount: 3, operationBytes: 6144, oldestOperationAt: "2025-01-01T00:00:00Z", archiveCount: 2, archiveBytes: 4096, activeFileCount: 4, activeFileBytes: 65536 };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let previewFailure = false;
  let cleanupFailure: 0 | 409 | 503 = 0;
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if (path === "/api/logs/management") return route.fulfill({ json: management });
    if (path === "/api/events") return route.abort();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ path, body });
    if (path === "/api/logs/policy") {
      state.logPolicy = { operationRetentionDays: Number(body.operationRetentionDays), archiveRetentionDays: Number(body.archiveRetentionDays) };
      management.policy = state.logPolicy;
      state.revision++;
      return route.fulfill({ json: state });
    }
    if (path === "/api/logs/cleanup/preview") {
      if (previewFailure) { previewFailure = false; return route.fulfill({ status: 503, json: { error: "预览服务暂不可用" } }); }
      const preview: LogCleanupPreview = { scope: body.scope as LogCleanupPreview["scope"], days: Number(body.days), before: "2026-10-17T16:00:00Z", revision: state.revision, token: "preview-token", count: body.scope === "operations" ? management.operationCount : management.archiveCount, bytes: body.scope === "operations" ? management.operationBytes : management.archiveBytes, reversibleCount: body.scope === "operations" ? 3 : 0 };
      return route.fulfill({ json: preview });
    }
    if (path === "/api/logs/cleanup") {
      if (cleanupFailure) {
        const status = cleanupFailure;
        cleanupFailure = 0;
        if (status === 409) state.revision++;
        return route.fulfill({ status, json: { error: status === 409 ? "数据已变化，请重新预览" : "清理服务暂不可用" } });
      }
      const run: LogCleanupRun = { checkedAt: new Date().toISOString(), operationsDeleted: body.scope === "operations" ? management.operationCount : 0, archivesDeleted: body.scope === "archives" ? management.archiveCount : 0, bytes: 4096, error: "" };
      if (body.scope === "operations") { state.logs = []; management.operationCount = 0; management.operationBytes = 0; }
      else { management.archiveCount = 0; management.archiveBytes = 0; }
      management.lastManual = run;
      state.revision++;
      return route.fulfill({ json: { state, cleanup: run } });
    }
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "操作记录", exact: true }).click();
  return { state, management, calls, failPreview: () => { previewFailure = true; }, failCleanup: (code: 409 | 503) => { cleanupFailure = code; } };
}

async function dialog(page: Page) {
  await page.getByRole("button", { name: "日志管理", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "日志管理", exact: true });
  await expect(panel.getByText("3 条", { exact: true })).toBeVisible();
  return panel;
}

test("设置表格行铺满可用宽度，列按内容收紧，窄屏在表格内滚动", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 780 });
  const { state } = await open(page);
  state.logs = Array.from({ length: 30 }, (_, index) => ({ ...state.logs[0]!, id: index + 1, action: "调整需求方优先级" }));
  await page.reload();
  const pageSize = page.getByLabel("操作记录每页行数");
  await pageSize.fill("30");
  await pageSize.press("Enter");
  const table = page.getByRole("table", { name: "操作记录", exact: true });
  const viewport = table.locator("..");
  const size = () => viewport.evaluate((element) => ({
    width: element.clientWidth,
    viewportWidth: Math.round(element.getBoundingClientRect().width),
    tableWidth: element.querySelector("table")!.offsetWidth,
    scrollWidth: element.scrollWidth,
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    panelWidth: element.closest('[data-scroll-container="settings-content"]')!.clientWidth,
  }));
  await expect(table.getByRole("row")).toHaveCount(31);
  const short = await size();
  expect(short.viewportWidth).toBe(short.panelWidth);
  expect(short.tableWidth).toBeLessThan(short.panelWidth / 2);
  expect(short.scrollHeight).toBeGreaterThan(short.height);
  expect(short.scrollWidth).toBe(short.width);
  expect(await table.evaluate((element) => {
    const container = element.parentElement!;
    const x = container.getBoundingClientRect().left + container.clientWidth - 8;
    return Array.from(element.querySelectorAll("tr")).slice(0, 2).every((row) => {
      const bounds = row.getBoundingClientRect();
      return row.contains(document.elementFromPoint(x, bounds.top + bounds.height / 2));
    });
  })).toBe(true);
  await pageSize.blur();
  await page.screenshot({ path: testInfo.outputPath("operation-log-wide.png") });

  state.logs[0]!.action = `新增需求：${"RSM-2026-测试日志".repeat(24)}`;
  await page.reload();
  const longCell = table.getByRole("cell", { name: state.logs[0]!.action, exact: true });
  await expect(longCell).toBeVisible();
  expect((await size()).tableWidth).toBeGreaterThan(short.tableWidth);
  expect(await longCell.evaluate((cell) => {
    const text = document.createRange();
    text.selectNodeContents(cell);
    return text.getClientRects().length;
  })).toBeGreaterThan(1);

  await page.setViewportSize({ width: 390, height: 720 });
  const narrow = await size();
  expect(narrow.width).toBeLessThanOrEqual(narrow.panelWidth);
  expect(narrow.scrollWidth).toBeGreaterThan(narrow.width);
  await viewport.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect(table.getByRole("columnheader", { name: "撤回", exact: true })).toBeInViewport();
  await expect(page.getByRole("navigation", { name: "操作记录分页", exact: true })).toBeInViewport();
});

test("管理员保存自动清理策略，刷新保留，未保存的修改不提交", async ({ page }) => {
  const model = await open(page);
  const panel = await dialog(page);
  await expect(panel.getByRole("switch", { name: "按天自动清理操作记录", exact: true })).not.toBeChecked();
  await expect(panel.getByLabel("操作记录自动清理天数", { exact: true })).toBeDisabled();
  await panel.getByRole("switch", { name: "按天自动清理操作记录", exact: true }).click();
  await panel.getByLabel("操作记录自动清理天数", { exact: true }).fill("14");
  await panel.getByRole("switch", { name: "按天自动清理归档文件", exact: true }).click();
  await panel.getByLabel("归档文件自动清理天数", { exact: true }).fill("45");
  await panel.getByRole("button", { name: "保存策略", exact: true }).click();
  await expect(page.getByText("日志保留策略已保存", { exact: true })).toBeVisible();
  expect(model.calls).toEqual([{ path: "/api/logs/policy", body: { baseRevision: 100, operationRetentionDays: 14, archiveRetentionDays: 45 } }]);
  await panel.getByRole("button", { name: "完成", exact: true }).click();
  await page.reload();
  const reopened = await dialog(page);
  await expect(reopened.getByLabel("操作记录自动清理天数", { exact: true })).toHaveValue("14");
  await expect(reopened.getByLabel("归档文件自动清理天数", { exact: true })).toHaveValue("45");
  await reopened.getByRole("switch", { name: "按天自动清理归档文件", exact: true }).click();
  await page.keyboard.press("Escape");
  expect(model.calls).toHaveLength(1);
});

test("手动清理先预览截止时间和撤回影响，切换条件使预览失效", async ({ page }) => {
  const model = await open(page);
  const panel = await dialog(page);
  await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(panel.getByText("2026/10/18 00:00", { exact: true })).toBeVisible();
  await expect(panel.getByText(/含 3 条当前可撤回记录/)).toBeVisible();
  expect(model.calls.every((call) => call.path.endsWith("preview"))).toBe(true);
  await panel.getByRole("button", { name: "7 天", exact: true }).click();
  await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "预览清理", exact: true }).click();
  await panel.getByRole("button", { name: "确认清理", exact: true }).click();
  await expect(page.getByText("已清理 3 条操作记录", { exact: true })).toBeVisible();
  expect(model.state.logs).toHaveLength(0);
  expect(model.calls.at(-1)?.body).toEqual({ baseRevision: 100, scope: "operations", days: 7, before: "2026-10-17T16:00:00Z", token: "preview-token" });
  await panel.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(panel.getByText("没有符合条件的日志，无需清理。", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "操作记录分页", exact: true })).toBeInViewport();
});

test("归档文件使用独立范围，预览和确认保持一致", async ({ page }) => {
  const model = await open(page);
  const panel = await dialog(page);
  await panel.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "归档文件日志", exact: true }).click();
  await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "90 天", exact: true }).click();
  await panel.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(panel.getByText("2 个归档文件", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "确认清理", exact: true }).click();
  await expect(page.getByText("已清理 2 个归档文件", { exact: true })).toBeVisible();
  expect(model.state.logs).toHaveLength(3);
  expect(model.calls.at(-1)?.body.scope).toBe("archives");
  expect(model.calls.at(-1)?.body.days).toBe(90);
});

test("空值、零、分数和超范围天数不可保存或清理", async ({ page }) => {
  const model = await open(page);
  const panel = await dialog(page);
  for (const value of ["", "0", "1.5", "3651"]) {
    await panel.getByLabel("手动清理天数", { exact: true }).fill(value);
    await expect(panel.getByRole("button", { name: "预览清理", exact: true })).toBeDisabled();
  }
  await panel.getByRole("switch", { name: "按天自动清理操作记录", exact: true }).click();
  await panel.getByLabel("操作记录自动清理天数", { exact: true }).fill("0");
  await expect(panel.getByRole("button", { name: "保存策略", exact: true })).toBeDisabled();
  expect(model.calls).toHaveLength(0);
});

test("预览和清理失败均不假报成功，重试须重新预览", async ({ page }) => {
  const model = await open(page);
  const panel = await dialog(page);
  model.failPreview();
  await panel.getByRole("button", { name: "预览清理", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("预览服务暂不可用");
  for (const code of [503, 409] as const) {
    await panel.getByRole("button", { name: "预览清理", exact: true }).click();
    model.failCleanup(code);
    await panel.getByRole("button", { name: "确认清理", exact: true }).click();
    await expect(panel.getByText("清理未完成，请重新预览后重试。", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toHaveCount(0);
    expect(model.state.logs).toHaveLength(3);
    await expect(page.getByText("已清理 3 条操作记录", { exact: true })).toHaveCount(0);
  }
});

for (const role of ["guest", "readonly", "collaborator"] as const) {
  test(`${role} 无日志管理入口`, async ({ page }) => {
    await open(page, { role });
    await expect(page.getByRole("table", { name: "操作记录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "日志管理", exact: true })).toHaveCount(0);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`日志管理日夜与窄屏无整体滚动，确认及完成按钮可达（${theme}）`, async ({ page }, testInfo) => {
    await open(page, { theme });
    const panel = await dialog(page);
    await panel.getByRole("button", { name: "预览清理", exact: true }).click();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      await expect(panel).toBeInViewport();
      await panel.getByRole("button", { name: "确认清理", exact: true }).scrollIntoViewIfNeeded();
      await expect(panel.getByRole("button", { name: "确认清理", exact: true })).toBeInViewport();
      await expect(panel.getByRole("button", { name: "完成", exact: true })).toBeInViewport();
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`log-management-${theme}-${viewport.width}.png`) });
    }
    expect(errors).toEqual([]);
  });
}
