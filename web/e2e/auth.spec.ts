import { expect, test } from "@playwright/test";

const password = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";

test("登录显隐、关闭清空、错误提示和持久登录", async ({ page }) => {
  await page.goto("/");
  const header = page.getByRole("banner");
  const trigger = header.getByRole("button", { name: "未登录", exact: true });
  await expect(trigger).toBeVisible();
  await expect(header.getByText("当前为游客只读访问，登录后可编辑需求。", { exact: true })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "登录", exact: true })).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "登录 RSM" });
  await expect(dialog.getByLabel("用户名", { exact: true })).toBeFocused();
  await dialog.getByLabel("用户名", { exact: true }).fill("张金科");
  await dialog.getByLabel("密码", { exact: true }).fill("temporary-value");
  await dialog.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute("type", "text");
  await dialog.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await trigger.click();
  await expect(dialog.getByLabel("密码", { exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("请填写密码");
  await dialog.getByLabel("密码", { exact: true }).fill("incorrect-password");
  const failure = page.waitForResponse((response) => response.url().endsWith("/api/login") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  expect((await failure).status()).toBe(401);
  await expect(dialog.getByRole("alert")).toContainText("用户名或密码");
  await dialog.getByLabel("密码", { exact: true }).fill(password);
  await dialog.getByLabel("密码", { exact: true }).press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
  expect((await (await page.request.get("/api/state")).json()).me.username).toBe("张金科");
  const cookie = (await page.context().cookies()).find((item) => item.name === "rsm_session")!;
  expect(cookie.httpOnly).toBeTruthy();
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 24 * 60 * 60);
});

test("保持登录可通过文字及键盘切换，取消后签发临时会话", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "未登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "登录 RSM" });
  const remember = dialog.getByRole("checkbox", { name: "保持登录状态", exact: true });
  await expect(remember).toBeChecked();
  const center = await remember.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const icon = el.querySelector("svg")!.getBoundingClientRect();
    return { x: icon.x + icon.width / 2 - box.x - box.width / 2, y: icon.y + icon.height / 2 - box.y - box.height / 2 };
  });
  expect(center.x).toBeCloseTo(0);
  expect(center.y).toBeCloseTo(0);
  await dialog.getByText("保持登录状态", { exact: true }).click();
  await expect(remember).not.toBeChecked();
  await remember.press("Space");
  await expect(remember).toBeChecked();
  await remember.press("Space");
  await expect(remember).not.toBeChecked();
  await dialog.getByLabel("用户名", { exact: true }).fill("张金科");
  await dialog.getByLabel("密码", { exact: true }).fill(password);
  const response = page.waitForResponse((item) => item.url().endsWith("/api/login") && item.request().method() === "POST");
  await dialog.getByRole("button", { name: "登录", exact: true }).click();
  expect((await response).request().postDataJSON().remember).toBe(false);
  await expect(dialog).not.toBeVisible();
  const cookie = (await page.context().cookies()).find((item) => item.name === "rsm_session")!;
  expect(cookie.expires).toBe(-1);
  expect(cookie.httpOnly).toBeTruthy();
  expect(cookie.sameSite).toBe("Strict");
  await page.reload();
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeEnabled();
});

test("窄屏展开搜索后仍可登录，登录界面在桌面和窄屏均完整显示于一屏", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  const header = page.getByRole("banner");
  const trigger = header.getByRole("button", { name: "未登录", exact: true });
  await header.getByRole("button", { name: "展开搜索", exact: true }).click();
  const search = header.getByRole("searchbox", { name: "搜索需求", exact: true });
  await search.fill("需求筛选");
  await expect(search.locator("..")).toHaveCSS("width", "224px");
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "登录 RSM" });
  for (const [width, height] of [[1440, 900], [1366, 768], [736, 620], [390, 844], [320, 568]]) {
    await page.setViewportSize({ width, height });
    await expect(dialog.getByRole("heading", { name: "欢迎回来！" })).toBeVisible();
    const bounds = await dialog.getByRole("button", { name: "以游客身份浏览" }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    const documentSize = await page.evaluate(() => {
      const element = document.scrollingElement!;
      return { width: element.clientWidth, fullWidth: element.scrollWidth, height: element.clientHeight, fullHeight: element.scrollHeight };
    });
    expect(documentSize.fullWidth).toBe(documentSize.width);
    expect(documentSize.fullHeight).toBe(documentSize.height);
  }
  await dialog.getByRole("button", { name: "以游客身份浏览" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "新增需求", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});
