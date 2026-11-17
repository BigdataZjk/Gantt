import { expect, test, type Page } from "@playwright/test";
import type { State } from "../src/api/types";

const password = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";

async function expectTheme(page: Page, theme: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.getByRole("switch", { name: theme === "dark" ? "切换为日间模式" : "切换为夜间模式" })).toHaveAttribute("aria-checked", String(theme === "dark"));
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
});

test("游客连续切换日夜无需登录，重新读取资料及刷新后仍保留主题", async ({ page }, testInfo) => {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/preferences" && request.method() === "PUT") writes.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() => localStorage.setItem("rsm.theme", "light"));
  await page.goto("/");
  await expectTheme(page, "light");
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeDisabled();
  for (const theme of ["dark", "light", "dark", "light", "dark"] as const) {
    await page.getByRole("switch", { name: /切换为.*模式/ }).click();
    await expectTheme(page, theme);
  }

  const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state" && response.request().method() === "GET");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect((await refresh).ok()).toBeTruthy();
  await expectTheme(page, "dark");
  await page.reload();
  await expectTheme(page, "dark");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("guest-theme.png") });
});

test("登录用户主题保存到账户，与游客隔离，另一标签页重新读取时同步", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeDisabled();
  if (await page.locator("html").getAttribute("data-theme") !== "dark") {
    await page.getByRole("switch", { name: "切换为夜间模式" }).click();
  }
  await expectTheme(page, "dark");
  const login = await page.request.post("/api/login", { data: { username: "张金科", password } });
  expect(login.ok()).toBeTruthy();
  const original = (await login.json() as State).preferences;
  let other: Page | undefined;
  try {
    const seed = await page.request.put("/api/preferences", { data: { ...original, theme: "light" } });
    expect(seed.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
    await expectTheme(page, "light");

    other = await page.context().newPage();
    await other.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
    await other.goto("/");
    await expectTheme(other, "light");
    for (const theme of ["dark", "light"] as const) {
      const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/preferences" && response.request().method() === "PUT");
      await page.getByRole("switch", { name: /切换为.*模式/ }).click();
      const response = await saved;
      expect(response.ok()).toBeTruthy();
      expect((await response.json() as State).preferences.theme).toBe(theme);
      await expectTheme(page, theme);
      const refresh = other.waitForResponse((response) => new URL(response.url()).pathname === "/api/state" && response.request().method() === "GET");
      await other.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      expect((await refresh).ok()).toBeTruthy();
      await expectTheme(other, theme);
    }
    await page.reload();
    await expectTheme(page, "light");
    await other.close();
    other = undefined;

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "个性化", exact: true }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeDisabled();
    await expectTheme(page, "dark");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await other?.close();
    const login = await page.request.post("/api/login", { data: { username: "张金科", password } });
    expect(login.ok()).toBeTruthy();
    const restored = await page.request.put("/api/preferences", { data: original });
    expect(restored.ok()).toBeTruthy();
    await page.request.post("/api/logout");
  }
});
