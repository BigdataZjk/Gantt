import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { State } from "../src/api/types";
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
