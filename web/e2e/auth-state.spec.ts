import { expect, test, type Page } from "@playwright/test";
import type { State } from "../src/api/types";
import { users } from "../src/test/fixtures";

const guestNotice = "当前为游客只读访问，登录后可编辑需求。";

async function openSession(page: Page, mode: "setup" | "guest" | "member") {
  const original = await (await page.request.get("/api/state")).json() as State;
  const state: State = {
    ...original, revision: 100, requests: [], users: [...users],
    setupRequired: mode === "setup", me: mode === "member" ? users[0] : null,
  };
  let delayRead = false;
  let delayPreference = false;
  let delayed: (() => Promise<void>) | undefined;
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget {
      listener = () => this.dispatchEvent(new MessageEvent("change", { data: '{"revision":1000}' }));
      constructor() {
        super();
        window.addEventListener("rsm-test-refresh", this.listener);
      }
      close() { window.removeEventListener("rsm-test-refresh", this.listener); }
    } as unknown as typeof EventSource;
  });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") {
      const snapshot = structuredClone(state);
      if (delayRead) {
        delayRead = false;
        delayed = () => route.fulfill({ json: snapshot });
        return;
      }
      return route.fulfill({ json: snapshot });
    }
    if (path === "/api/presence") return route.fulfill({ json: { users: state.me ? [state.me.id] : [], guests: state.me ? 0 : 1 } });
    if (path === "/api/preferences") {
      state.preferences = route.request().postDataJSON() as State["preferences"];
      const snapshot = structuredClone(state);
      if (delayPreference) {
        delayPreference = false;
        delayed = () => route.fulfill({ json: snapshot });
        return;
      }
      return route.fulfill({ json: snapshot });
    }
    if (path === "/api/setup" || path === "/api/login") {
      state.setupRequired = false;
      state.me = users[0];
      return route.fulfill({ json: state });
    }
    if (path === "/api/logout") {
      state.me = null;
      return route.fulfill({ json: state });
    }
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: mode === "setup" ? "设置密码并进入" : "新增需求", exact: true })).toBeVisible();
  return {
    state,
    delay: async () => {
      delayRead = true;
      delayed = undefined;
      await page.evaluate(() => window.dispatchEvent(new Event("rsm-test-refresh")));
      await expect.poll(() => Boolean(delayed)).toBe(true);
    },
    delayPreferences: async () => {
      delayPreference = true;
      delayed = undefined;
      await page.getByRole("switch", { name: /切换为.*模式/ }).click();
      await expect.poll(() => Boolean(delayed)).toBe(true);
    },
    release: async () => {
      await delayed!();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    },
  };
}

for (const mode of ["setup", "guest"] as const) {
  test(`${mode === "setup" ? "首次设密" : "普通登录"}后，晚到的游客资料不能恢复登录提示和只读权限`, async ({ page }) => {
    const session = await openSession(page, mode);
    await session.delay();
    if (mode === "setup") {
      await page.locator("#rsm-setup-password").fill("密");
      await page.locator("#rsm-setup-confirm").fill("密");
      await page.getByRole("button", { name: "设置密码并进入", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "登录", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "登录 RSM", exact: true });
      await dialog.getByLabel("用户名", { exact: true }).fill("张金科");
      await dialog.getByLabel("密码", { exact: true }).fill("密");
      await dialog.getByRole("button", { name: "登录", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
    await session.release();
    await expect(page.getByText(guestNotice, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "游客，点击登录", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
    await expect(page.getByText(guestNotice, { exact: true })).toHaveCount(0);
  });
}

test("资料刷新先识别登录身份时，随后到达的登录响应仍完成并关闭弹窗", async ({ page }) => {
  const { state } = await openSession(page, "guest");
  let finishLogin: (() => Promise<void>) | undefined;
  await page.route("**/api/login", (route) => {
    state.me = users[0];
    finishLogin = () => route.fulfill({ json: state });
  });
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录 RSM", exact: true });
  await dialog.getByLabel("用户名", { exact: true }).fill("张金科");
  await dialog.getByLabel("密码", { exact: true }).fill("密");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect.poll(() => Boolean(finishLogin)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("rsm-test-refresh")));
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
  await finishLogin!();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(guestNotice, { exact: true })).toHaveCount(0);
});

for (const source of ["资料刷新", "偏好保存"] as const) {
  test(`退出后，晚到的${source}不能恢复头像和编辑权限`, async ({ page }) => {
    const session = await openSession(page, "member");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "个性化", exact: true }).click();
    if (source === "资料刷新") await session.delay();
    else await session.delayPreferences();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByText(guestNotice, { exact: true })).toBeVisible();
    await session.release();
    await expect(page.getByText(guestNotice, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "游客，点击登录", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByText(guestNotice, { exact: true })).toBeVisible();
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`连续滑过在线头像、个人头像及退出悬停，姓名提示始终跟随（${theme}）`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await openSession(page, "member");
    await page.route("**/api/presence", (route) => route.fulfill({ json: { users: users.map((user) => user.id), guests: 0 } }));
    await page.reload();
    const online = page.locator('[aria-label="2 位登录用户在线"]');
    const first = online.locator('[data-tooltip="张金科"]');
    const second = online.locator('[data-tooltip="李明"]');
    const profile = page.locator('header button[data-tooltip="张金科"]');
    const tooltip = page.getByRole("tooltip");
    for (let count = 0; count < 3; count += 1) {
      for (const [avatar, name] of [[first, "张金科"], [second, "李明"], [profile, "张金科"]] as const) {
        await avatar.hover();
        await expect(tooltip).toHaveText(name);
        await expect(tooltip).toBeVisible();
      }
      await page.mouse.move(600, 400);
      await expect(tooltip).toHaveCount(0);
    }
    await profile.focus();
    await expect(tooltip).toHaveText("张金科");
    await profile.click();
    await expect(tooltip).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "个性化", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
