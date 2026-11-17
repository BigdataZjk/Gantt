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

test("首次设密时任一非空密码显示明文，小人持续移开视线", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSession(page, "setup");
  const scene = page.locator("[data-attention]");
  const eyes = scene.locator('[class*="eyes"]').first();
  const password = page.locator("#rsm-setup-password");
  const confirm = page.locator("#rsm-setup-confirm");
  await expect(scene).toHaveAttribute("data-attention", "idle");
  await password.fill("密");
  await expect(scene).toHaveAttribute("data-attention", "idle");
  await page.getByRole("button", { name: "显示初始密码", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(scene).toHaveAttribute("data-attention", "privacy");
  await expect(eyes).toHaveCSS("transform", "matrix(1, 0, 0, 1, -12, -6)");
  await confirm.fill("密");
  await page.getByRole("button", { name: "显示确认密码", exact: true }).click();
  await page.getByRole("button", { name: "隐藏初始密码", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(scene).toHaveAttribute("data-attention", "privacy");
  await confirm.fill("");
  await expect(scene).toHaveAttribute("data-attention", "idle");
  await confirm.fill("密");
  await expect(scene).toHaveAttribute("data-attention", "privacy");
  await page.getByRole("button", { name: "隐藏确认密码", exact: true }).click();
  await expect(scene).toHaveAttribute("data-attention", "idle");
  await page.getByRole("button", { name: "设置密码并进入", exact: true }).click();
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
  await expect(page.getByText(guestNotice, { exact: true })).toHaveCount(0);
});

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
      await page.setViewportSize({ width: count === 1 ? 1024 : 1440, height: 900 });
      for (const [avatar, name] of [[first, "张金科"], [second, "李明"], [profile, "张金科"]] as const) {
        await avatar.hover();
        await expect(tooltip).toHaveText(name);
        await expect(tooltip).toBeVisible();
        const target = (await avatar.boundingBox())!;
        const bubble = (await tooltip.boundingBox())!;
        expect(Math.max(target.x - bubble.x - bubble.width, bubble.x - target.x - target.width, 0)).toBeLessThanOrEqual(16);
        expect(Math.max(target.y - bubble.y - bubble.height, bubble.y - target.y - target.height, 0)).toBeLessThanOrEqual(20);
        expect(bubble.x).toBeGreaterThanOrEqual(8);
        expect(bubble.x + bubble.width).toBeLessThanOrEqual(page.viewportSize()!.width - 8);
      }
      await page.mouse.move(600, 400);
      await expect(tooltip).toHaveCount(0);
    }
    await profile.focus();
    await expect(tooltip).toHaveText("张金科");
    await expect.poll(async () => {
      const anchor = await profile.boundingBox();
      const bubble = await tooltip.boundingBox();
      if (!anchor || !bubble) return Infinity;
      return Math.abs(bubble.x + bubble.width / 2 - anchor.x - anchor.width / 2);
    }).toBeLessThanOrEqual(16);
    await profile.click();
    await expect(tooltip).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "个性化", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("长提示在视窗右下角向上避让，并保持靠近目标", async ({ page }) => {
  await openSession(page, "member");
  const message = "需求开始与结束时间、开发人与当前状态的说明。".repeat(10);
  await page.evaluate((text) => {
    const parent = document.createElement("div");
    parent.style.cssText = "position:fixed;inset:0;transform:translate(0);pointer-events:none;z-index:100";
    const target = document.createElement("button");
    target.textContent = "边缘提示检查";
    target.dataset.tooltip = text;
    target.style.cssText = "position:absolute;right:8px;bottom:8px;pointer-events:auto";
    parent.append(target);
    document.body.append(parent);
  }, message);
  const target = page.getByRole("button", { name: "边缘提示检查", exact: true });
  await target.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(message);
  const anchor = (await target.boundingBox())!;
  const bubble = (await tooltip.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bubble.x).toBeGreaterThanOrEqual(8);
  expect(bubble.y).toBeGreaterThanOrEqual(8);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(viewport.width - 8);
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(anchor.y + anchor.height / 2);
  expect(anchor.y - bubble.y - bubble.height).toBeLessThanOrEqual(20);
  await page.mouse.move(500, 300);
  await expect(tooltip).toHaveCount(0);
});
