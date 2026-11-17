import { expect, test, type Page } from "@playwright/test";
import type { State } from "../src/api/types";
import { users } from "../src/test/fixtures";

async function open(page: Page, mode: "setup" | "guest" | "member") {
  const original = await (await page.request.get("/api/state")).json() as State;
  const state: State = { ...original, users: [...users], requests: [], setupRequired: mode === "setup", me: mode === "member" ? users[0] : null };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
    if (route.request().method() === "POST" || route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "/api/setup" || path === "/api/login") {
        state.setupRequired = false;
        state.me = users[0];
      } else if (path === "/api/users") {
        state.users.push({ ...users[1], id: "single-character-user", username: String(body.username) });
      }
      state.revision += 1;
      return route.fulfill({ json: state });
    }
    return route.abort();
  });
  await page.goto("/");
  return writes;
}

test("首次设密只拒绝空值并接受单个中文字符", async ({ page }) => {
  const writes = await open(page, "setup");
  await page.getByRole("button", { name: "设置密码并进入", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("密码至少 1 个字符");
  expect(writes).toHaveLength(0);
  await page.locator("#rsm-setup-password").fill("密");
  await page.locator("#rsm-setup-confirm").fill("密");
  await page.getByRole("button", { name: "设置密码并进入", exact: true }).click();
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
  expect(writes).toEqual([{ path: "/api/setup", body: { password: "密" } }]);
});

for (const [label, password] of [["字母", "x"], ["表情", "🙂"], ["空格", " "], ["超过原长度上限", "q".repeat(300)]] as const) {
  test(`登录保留密码原值并支持${label}`, async ({ page }) => {
    const writes = await open(page, "guest");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登录 RSM", exact: true });
    await dialog.locator("#rsm-login-username").fill("张金科");
    await dialog.locator("#rsm-login-password").fill(password);
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
    expect(writes[0]?.body.password).toBe(password);
  });
}

test("本人改密与管理员创建、重置接受单字符，空密码不提交", async ({ page }) => {
  const writes = await open(page, "member");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "个性化", exact: true }).click();
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  const password = page.getByRole("dialog", { name: "修改密码", exact: true });
  await password.locator("#rsm-pw-current").fill("original");
  await password.getByRole("button", { name: "保存", exact: true }).click();
  await expect(password.getByRole("alert")).toHaveText("新密码至少 1 个字符");
  expect(writes).toHaveLength(0);
  await password.locator("#rsm-pw-next").fill(" ");
  await password.getByRole("button", { name: "保存", exact: true }).click();
  await expect(password).toHaveCount(0);
  expect(writes[0]).toEqual({ path: "/api/auth/password", body: { currentPassword: "original", password: " " } });

  await page.getByRole("tab", { name: "角色权限", exact: true }).click();
  await page.getByRole("button", { name: "新增账号", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新增账号", exact: true });
  await create.locator("#rsm-account-name").fill("单字符账号");
  await create.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(create.getByText("初始密码至少 1 个字符", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  await create.locator("#rsm-account-password").fill("🙂");
  await create.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(create).toHaveCount(0);
  expect(writes[1]?.body.password).toBe("🙂");
  const row = page.getByRole("table", { name: "账号列表", exact: true }).getByRole("row").filter({ hasText: "单字符账号" });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑账号", exact: true });
  await edit.locator("#rsm-account-password").fill("x");
  await edit.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect(writes[2]).toEqual({ path: "/api/users/single-character-user", body: { role: "collaborator", password: "x" } });
});
