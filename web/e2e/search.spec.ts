import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: [], guests: 0 } }));
  await page.goto("/");
});

test("日夜及窄屏下搜索图标透明居中，展开及输入聚焦没有边框", async ({ page }, testInfo) => {
  const search = page.getByRole("searchbox", { name: "搜索需求", exact: true });
  for (const [width, height, theme] of [[1440, 900, "light"], [1440, 900, "dark"], [320, 568, "dark"], [390, 844, "light"]] as const) {
    await page.setViewportSize({ width, height });
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByRole("switch", { name: /切换为.*模式/ }).click();
    }
    const toggle = page.getByRole("button", { name: "展开搜索", exact: true });
    await toggle.hover();
    await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const capsule = search.locator("..");
    await expect(capsule).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const icon = await toggle.evaluate((el) => {
      const button = el.getBoundingClientRect();
      const svg = el.querySelector("svg")!.getBoundingClientRect();
      return { width: svg.width, height: svg.height, x: svg.x + svg.width / 2 - button.x - button.width / 2, y: svg.y + svg.height / 2 - button.y - button.height / 2 };
    });
    expect(icon.width).toBe(18);
    expect(icon.height).toBe(18);
    expect(icon.x).toBeCloseTo(0);
    expect(icon.y).toBeCloseTo(0);

    await toggle.click();
    await expect(search).toBeFocused();
    await expect(search).toHaveCSS("opacity", "1");
    await expect(search).toHaveCSS("border-top-width", "0px");
    await expect(search).toHaveCSS("outline-style", "none");
    await expect(search).toHaveCSS("box-shadow", "none");
    await expect(capsule).toHaveCSS("border-top-width", "0px");
    await search.fill("搜索样式回归");
    await expect(search).toHaveCSS("outline-style", "none");
    await page.getByRole("button", { name: "需求", exact: true }).click();
    await expect(page.getByRole("button", { name: "收起搜索", exact: true })).toBeVisible();
    await expect(capsule).toHaveCSS("border-top-width", "0px");
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath(`search-${theme}.png`) });
    const box = (await capsule.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await search.fill("");
    await page.getByRole("button", { name: "需求", exact: true }).click();
    await expect(page.getByRole("button", { name: "展开搜索", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBeTruthy();
  }
});

test("搜索即时筛选且支持键盘，空值失焦收起，有查询时保留", async ({ page }) => {
  await page.getByRole("tab", { name: "需求池", exact: true }).click();
  const toggle = page.getByRole("button", { name: "展开搜索", exact: true });
  await page.keyboard.press("Tab");
  await toggle.focus();
  await expect(toggle).toHaveCSS("outline-style", "solid");
  await toggle.press("Enter");
  const search = page.getByRole("searchbox", { name: "搜索需求", exact: true });
  await expect(search).toBeFocused();
  await search.fill("不会匹配的搜索回归名称-9f3d83");
  await expect(page.getByText("没有匹配的需求", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "需求", exact: true }).click();
  await expect(search).toHaveValue("不会匹配的搜索回归名称-9f3d83");
  await expect(page.getByRole("button", { name: "收起搜索", exact: true })).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByText("没有匹配的需求", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "收起搜索", exact: true })).toBeVisible();
  await search.press("Escape");
  await expect(toggle).toBeVisible();
  await toggle.press("Enter");
  await search.press("Tab");
  await expect(page.getByRole("button", { name: "收起搜索", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
