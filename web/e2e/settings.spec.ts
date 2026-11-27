import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { State, UpgradeJob, UpgradeState } from "../src/api/types";
import { request as makeRequest } from "../src/test/fixtures";

const password = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";
const runId = Date.now().toString(36);

async function login(page: Page) {
  const response = await page.request.post("/api/login", { data: { username: "张金科", password } });
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
}

async function state(page: Page): Promise<State> {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBe(true);
  return response.json() as Promise<State>;
}

async function createRequest(page: Page, name: string, project = "") {
  const before = await state(page);
  const response = await page.request.post("/api/requests", {
    data: { baseRevision: before.revision, request: makeRequest({ id: 0, revision: 0, name, project, developer: "", domain: before.domains[0]!.name, start: "", delivery: "" }) },
  });
  expect(response.ok()).toBe(true);
  return (await response.json() as State).requests.find((item) => item.name === name)!;
}

test("系统维护合并三个区块，超管可下载备份，游客可查看日志", async ({ page }) => {
  await login(page);
  const before = await state(page);
  const tab = page.getByRole("tab", { name: "系统维护", exact: true });
  await tab.click();
  const panel = page.getByRole("region", { name: "实例备份", exact: true });
  const upgrade = page.getByRole("region", { name: "上传源码并更新", exact: true });
  const updates = page.getByRole("region", { name: "更新日志", exact: true });
  await expect(upgrade.getByRole("button", { name: "选择源码 ZIP", exact: true })).toBeVisible();
  await expect(updates).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await panel.getByRole("button", { name: "生成并下载备份", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^rsm-backup-v[^/]+-\d{8}-\d{6}\.zip$/);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const result = panel.getByRole("status");
  await expect(result).toContainText("校验通过，已开始下载");
  await expect(result).toContainText(`数据修订号 ${before.revision}`);
  await expect(result.locator("time")).toHaveAttribute("datetime", /^\d{4}-/);
  expect((await state(page)).revision).toBe(before.revision);
  await download.delete();

  await page.request.post("/api/logout");
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await tab.click();
  await expect(panel).toHaveCount(0);
  await expect(upgrade).toHaveCount(0);
  await updates.getByRole("searchbox", { name: "搜索更新日志" }).fill("0.1.7");
  await expect(updates.getByRole("heading", { name: "V0", exact: true })).toBeVisible();
  await expect(updates.getByText("v0.1.7", { exact: true })).toBeVisible();
});

test("网页升级重连时保留当前页和进度，完成后只刷新一次", async ({ page }) => {
  await login(page);
  const staged: UpgradeJob = { version: "0.1.8", sha256: "a".repeat(64), status: "ready", step: 0 };
  const started: UpgradeJob = { ...staged, status: "starting", startedAt: "2026-11-27T10:00:00Z" };
  const stages = ["校验并解压源码包", "构建前端页面", "停止旧服务", "检查服务健康状态", "保存部署结果"];
  let update: UpgradeState = { currentVersion: staged.version, maxSourceBytes: 16 * 1024 ** 2, available: true };
  let disconnected = false;
  let navigationCount = 0;
  let polls = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigationCount += 1; });
  await page.route("**/api/state", (route) => disconnected ? route.abort("connectionrefused") : route.continue());
  await page.route("**/api/upgrade", (route) => {
    polls += 1;
    return disconnected ? route.abort("connectionrefused") : route.fulfill({ json: update });
  });
  await page.route("**/api/upgrade/source", (route) => {
    update = { ...update, job: staged };
    return route.fulfill({ json: update });
  });
  await page.route("**/api/upgrade/apply", (route) => {
    expect(route.request().postDataJSON()).toEqual({ sha256: staged.sha256 });
    update = { ...update, job: started };
    return route.fulfill({ status: 202, json: update });
  });

  const tab = page.getByRole("tab", { name: "系统维护", exact: true });
  await tab.click();
  const panel = page.getByRole("region", { name: "上传源码并更新", exact: true });
  await expect(panel.getByRole("button", { name: "选择源码 ZIP" })).toBeEnabled();
  await panel.getByLabel("源码 ZIP 文件").setInputFiles({ name: "rsm-source-0.1.8.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await page.getByRole("dialog", { name: "确认同版本覆盖更新" }).getByRole("button", { name: "开始更新" }).click();
  const progress = panel.getByRole("progressbar", { name: "升级进度" });
  await expect(progress).toHaveAttribute("aria-valuenow", "0");
  const running: UpgradeJob = { ...started, status: "running", step: 7, progress: { total: stages.length, stages: stages.slice(0, 3) } };
  update = { ...update, job: running };
  await expect(progress).toHaveAttribute("aria-valuenow", "2");
  await panel.getByText("升级步骤", { exact: true }).click();
  const steps = panel.getByRole("list", { name: "升级步骤" });
  const progressElement = await progress.elementHandle();
  const scroll = page.locator('[data-scroll-container="system-maintenance"]');
  const scrollPosition = await scroll.evaluate((element) => {
    element.scrollTop = 25;
    return element.scrollTop;
  });
  const scrolledBounds = await progress.boundingBox();
  expect(scrollPosition).toBeGreaterThan(0);

  disconnected = true;
  const stateFailed = page.waitForEvent("requestfailed", (request) => new URL(request.url()).pathname === "/api/state");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await stateFailed;
  await expect(panel.getByText("正在重新连接服务… · 上次记录 停止旧服务", { exact: true })).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", "2");
  expect(await progressElement!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await progress.boundingBox()).toEqual(scrolledBounds);
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(scrollPosition);
  await expect(steps).toBeVisible();
  expect(navigationCount).toBe(0);

  const finalizing: UpgradeJob = { ...running, step: 8, progress: { total: stages.length, stages } };
  update = { ...update, job: finalizing };
  disconnected = false;
  await expect(panel.getByText("正在保存部署结果", { exact: true })).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuenow", String(stages.length - 1));
  await expect(steps).toBeVisible();
  expect(navigationCount).toBe(0);

  const reloaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  update = { ...update, job: { ...finalizing, status: "succeeded" } };
  await expect(progress).toHaveAttribute("aria-valuenow", String(stages.length));
  await reloaded;
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByText("已完成更新 · v0.1.8", { exact: true })).toBeVisible();
  const pollsAfterReload = polls;
  await expect.poll(() => polls, { timeout: 8000 }).toBeGreaterThan(pollsAfterReload);
  expect(navigationCount).toBe(1);
});

test("字段管理新增删除及名称合并与刷新、归档数据一致", async ({ page }) => {
  await login(page);
  await page.getByRole("tab", { name: "字段管理", exact: true }).click();
  const domainName = `回归域-${runId}`;
  await page.getByRole("button", { name: "新增业务域", exact: true }).click();
  const add = page.getByRole("dialog", { name: "新增业务域", exact: true });
  await add.getByLabel("业务域名称", { exact: true }).fill(domainName);
  await add.getByRole("button", { name: "新增", exact: true }).click();
  const domain = page.getByRole("table", { name: "业务域枚举" }).getByRole("row").filter({ hasText: domainName });
  await expect(domain).toBeVisible();
  await page.reload();
  await expect(domain).toBeVisible();
  expect((await state(page)).domains.some((item) => item.name === domainName)).toBe(true);
  await domain.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "删除业务域", exact: true }).getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(domain).toHaveCount(0);
  expect((await state(page)).domains.some((item) => item.name === domainName)).toBe(false);

  const projectA = `回归项目A-${runId}`;
  const projectB = `回归项目B-${runId}`;
  const target = `回归项目合并-${runId}`;
  const first = await createRequest(page, `字段回归A-${runId}`, projectA);
  const second = await createRequest(page, `字段回归B-${runId}`, projectB);
  const current = await state(page);
  const archived = await page.request.post(`/api/requests/${second.id}/archive`, { data: { baseRevision: current.revision, archived: true } });
  expect(archived.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("checkbox", { name: `选择${projectA}`, exact: true }).check();
  await page.getByRole("checkbox", { name: `选择${projectB}`, exact: true }).check();
  await page.getByRole("button", { name: "合并名称（2）", exact: true }).click();
  const merge = page.getByRole("dialog", { name: "合并项目", exact: true });
  await merge.getByLabel("更新为", { exact: true }).fill(target);
  await merge.getByRole("button", { name: "确认合并", exact: true }).click();
  await expect(page.getByRole("table", { name: "项目名称维护" }).getByText(target, { exact: true })).toBeVisible();
  const saved = await state(page);
  expect(saved.requests.filter((item) => [first.id, second.id].includes(item.id)).map((item) => item.project)).toEqual([target, target]);
  expect(saved.requests.find((item) => item.id === second.id)!.archived).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("table", { name: "项目名称维护" }).getByText(target, { exact: true })).toBeVisible();
});

test("版本保存恢复删除及日志撤回均同步界面和持久化", async ({ page }) => {
  await login(page);
  const originalName = `版本回归-${runId}`;
  const item = await createRequest(page, originalName);
  await page.reload();
  await page.getByRole("tab", { name: "版本记录", exact: true }).click();
  await page.getByRole("button", { name: "保存当前版本", exact: true }).click();
  const versions = page.getByRole("table", { name: "版本记录", exact: true });
  await expect(versions.getByRole("button", { name: "恢复", exact: true }).first()).toBeVisible();
  const snapshot = (await state(page)).versions[0]!;
  const beforeEdit = await state(page);
  const edited = await page.request.put(`/api/requests/${item.id}`, { data: { baseRevision: beforeEdit.revision, request: { ...item, name: `${originalName}-已改` } } });
  expect(edited.ok()).toBe(true);
  await page.reload();
  const row = versions.getByRole("row").filter({ has: page.getByRole("cell", { name: snapshot.label, exact: true }) });
  await row.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(page.getByText("版本已恢复", { exact: true })).toBeVisible();
  const restored = await state(page);
  expect(restored.requests.find((entry) => entry.id === item.id)!.name).toBe(originalName);
  expect(restored.me?.role).toBe("superadmin");
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await state(page)).versions.some((version) => version.id === snapshot.id)).toBe(false);

  const sentinel = await createRequest(page, `日志撤回-${runId}`);
  await page.reload();
  await page.getByRole("tab", { name: "操作记录", exact: true }).click();
  const log = page.getByRole("table", { name: "操作记录", exact: true }).getByRole("row")
    .filter({ has: page.getByText("新增需求", { exact: true }) })
    .filter({ has: page.getByText(sentinel.name, { exact: true }) });
  await log.getByRole("button", { name: "撤回到此动作", exact: true }).click();
  await page.getByRole("dialog", { name: "撤回到此动作", exact: true }).getByRole("button", { name: "确认撤回", exact: true }).click();
  await expect(page.getByText("已撤回到所选操作之前", { exact: true })).toBeVisible();
  expect((await state(page)).requests.some((entry) => entry.id === sentinel.id)).toBe(false);
  await expect(log.getByRole("button", { name: "撤回到此动作", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "操作记录分页", exact: true })).toBeInViewport();
  expect((await state(page)).requests.some((entry) => entry.id === sentinel.id)).toBe(false);
});

test("账号创建改权停用启用删除与实际登录权限一致", async ({ page, request }) => {
  await login(page);
  await page.getByRole("tab", { name: "角色权限", exact: true }).click();
  const username = `回归账号-${runId}`;
  await page.getByRole("button", { name: "新增账号", exact: true }).click();
  const add = page.getByRole("dialog", { name: "新增账号", exact: true });
  await add.getByLabel("用户名", { exact: true }).fill(username);
  await add.getByLabel("初始密码（至少 1 个任意字符）", { exact: true }).fill(password);
  await add.getByRole("button", { name: "创建账号", exact: true }).click();
  const row = page.getByRole("table", { name: "账号列表" }).getByRole("row").filter({ hasText: username });
  await expect(row).toBeVisible();
  await page.reload();
  await expect(row).toBeVisible();
  expect((await request.post("/api/login", { data: { username, password } })).ok()).toBe(true);
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑账号", exact: true });
  await edit.getByLabel("角色", { exact: true }).selectOption("readonly");
  await edit.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(row.getByRole("cell", { name: "只读", exact: true })).toBeVisible();
  const downgraded = await request.get("/api/state");
  expect((await downgraded.json() as State).me).toBeFalsy();
  const readonlyLogin = await request.post("/api/login", { data: { username, password } });
  expect(readonlyLogin.ok()).toBe(true);
  const readonlyState = await readonlyLogin.json() as State;
  expect(readonlyState.me?.role).toBe("readonly");
  const deniedName = `只读禁止新增-${runId}`;
  const denied = await request.post("/api/requests", {
    data: {
      baseRevision: readonlyState.revision,
      request: makeRequest({ id: 0, revision: 0, name: deniedName, domain: readonlyState.domains[0]!.name, developer: "", start: "", delivery: "" }),
    },
  });
  expect(denied.status()).toBe(403);
  const afterDenied = await state(page);
  expect(afterDenied.revision).toBe(readonlyState.revision);
  expect(afterDenied.requests.some((item) => item.name === deniedName)).toBe(false);
  await row.getByRole("button", { name: "停用", exact: true }).click();
  await page.getByRole("dialog", { name: "停用账号", exact: true }).getByRole("button", { name: "确认停用", exact: true }).click();
  await expect(row.getByRole("button", { name: "启用", exact: true })).toBeVisible();
  expect((await request.get("/api/state").then((response) => response.json()) as State).me).toBeFalsy();
  expect((await request.post("/api/login", { data: { username, password } })).status()).toBe(401);
  await row.getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("dialog", { name: "启用账号", exact: true }).getByRole("button", { name: "确认启用", exact: true }).click();
  await expect(row.getByRole("button", { name: "停用", exact: true })).toBeVisible();
  expect((await request.post("/api/login", { data: { username, password } })).ok()).toBe(true);
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "删除账号", exact: true }).getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await request.post("/api/login", { data: { username, password } })).status()).toBe(401);
  await page.reload();
  await expect(row).toHaveCount(0);
});
