import { expect, test, type Page } from "@playwright/test";
import type { State } from "../src/api/types";

async function readGridPixels(page: Page) {
  return page.locator('[data-slot="grid-background"] canvas').evaluate((canvas: HTMLCanvasElement) => new Promise<{ visible: number; hash: number }>((resolve) => {
    let attempts = 0;
    const sample = () => {
      const gl = canvas.getContext("webgl2")!;
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let visible = 0;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 1) {
        if (index % 4 === 3 && pixels[index] > 0) visible += 1;
        hash = Math.imul(hash ^ pixels[index], 16777619) >>> 0;
      }
      if (visible || ++attempts >= 12) resolve({ visible, hash });
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

async function openShell(page: Page, guest = false, theme: "light" | "dark" = "light", announcement?: string) {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const original = await response.json() as State;
  const me = original.users.find((user) => user.role === "superadmin" && !user.deleted)!;
  expect(me).toBeTruthy();
  const state = {
    ...original,
    me: guest ? null : me,
    setupRequired: false,
    announcement: announcement ?? original.announcement,
    preferences: { ...original.preferences, theme },
  };
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/presence", (route) => route.fulfill({ json: { users: guest ? [] : [me.id], guests: 0 } }));
  await page.addInitScript((value) => localStorage.setItem("rsm.theme", value), theme);
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toBeVisible();
  return me;
}

test("需求页显示新增、公告和搜索，搜索展开时给公告留出空间", async ({ page }) => {
  await openShell(page, false, "light", "本周排期公告");
  const create = page.getByRole("button", { name: "新增需求", exact: true });
  const announcement = page.getByRole("region", { name: "系统公告", exact: true });
  const searchToggle = page.getByRole("button", { name: "展开搜索", exact: true });
  for (const tab of ["需求池", "已归档", "甘特图"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(create).toBeEnabled();
    await expect(announcement).toBeVisible();
    await expect(searchToggle).toBeVisible();
  }

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "公告设置", exact: true })).toBeVisible();
  await expect(create).toHaveCount(0);
  await expect(announcement).toHaveCount(0);
  await expect(searchToggle).toHaveCount(0);

  await page.getByRole("button", { name: "需求", exact: true }).click();
  const collapsedAnnouncement = (await announcement.boundingBox())!;
  await searchToggle.click();
  const search = page.getByRole("searchbox", { name: "搜索需求", exact: true });
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS("width", "280px");
  const expandedAnnouncement = (await announcement.boundingBox())!;
  const expandedSearch = (await search.boundingBox())!;
  expect(expandedAnnouncement.width).toBeLessThan(collapsedAnnouncement.width);
  expect(expandedAnnouncement.x + expandedAnnouncement.width).toBeLessThan(expandedSearch.x);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(search).toBeInViewport({ ratio: 1 });
  const mobileSearch = (await search.boundingBox())!;
  const mobileAnnouncement = (await announcement.boundingBox())!;
  expect(mobileSearch.y + mobileSearch.height).toBeLessThan(mobileAnnouncement.y);
  await announcement.getByRole("button", { name: "关闭公告", exact: true }).click();
  await expect(announcement).toHaveCount(0);
});

test("关闭公告后刷新仍隐藏，更新内容后重新展示", async ({ page }) => {
  const message = "本周排期公告";
  const me = await openShell(page, false, "light", message);
  const announcement = page.getByRole("region", { name: "系统公告", exact: true });
  await announcement.getByRole("button", { name: "关闭公告", exact: true }).press("Enter");
  await expect(announcement).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}").dismissedAnnouncement, `rsm.ui.v2:${me.id}`)).toBe(message);
  await page.reload();
  await expect(page.getByRole("tab", { name: "甘特图", exact: true })).toBeVisible();
  await expect(announcement).toHaveCount(0);

  await openShell(page, false, "light", "下周排期公告");
  await expect(announcement).toHaveText("下周排期公告");
});

test("滚动公告中的文字链接可用鼠标和键盘打开", async ({ page }) => {
  const guide = "https://example.com/rsm/guide";
  const details = "http://example.com/rsm/details_(v1)?view=week#dates";
  const context = page.context();
  await context.route(/https?:\/\/example\.com\/rsm\//, (route) => route.fulfill({ body: "公告链接" }));
  const overflow = "本周计划请以需求页排期为准。".repeat(12);
  await openShell(page, false, "light", `本周排期 [查看说明](${guide}) · ${overflow} [调整明细](${details}) [无效地址](javascript:alert(1))`);
  const announcement = page.getByRole("region", { name: "系统公告", exact: true });
  const guideLink = announcement.getByRole("link", { name: "查看说明", exact: true });
  const detailsLink = announcement.getByRole("link", { name: "调整明细", exact: true });
  const track = guideLink.locator("../..");
  const viewport = track.locator("..");
  await expect(track).toHaveAttribute("data-scrolling", "");
  await expect(announcement.getByRole("link", { name: "无效地址", exact: true })).toHaveCount(0);

  await viewport.hover();
  await expect(track).toHaveCSS("animation-play-state", "paused");
  const guidePopup = page.waitForEvent("popup");
  await guideLink.click();
  const openedGuide = await guidePopup;
  await openedGuide.waitForURL(guide);
  await openedGuide.close();

  await viewport.press("Tab");
  await expect(guideLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(detailsLink).toBeFocused();
  await expect(detailsLink).toBeInViewport({ ratio: 1 });
  const detailsPopup = page.waitForEvent("popup");
  await page.keyboard.press("Enter");
  const openedDetails = await detailsPopup;
  await openedDetails.waitForURL(details);
  await openedDetails.close();
});

test("侧栏展开与固定覆盖正文，刷新保留固定状态且取消后可收起", async ({ page }) => {
  const me = await openShell(page);
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await page.mouse.move(1000, 300);
  await expect(nav).toHaveAttribute("data-expanded", "false");
  const main = await page.getByRole("main").boundingBox();

  await page.getByRole("button", { name: "需求", exact: true }).hover();
  await expect(nav).toHaveAttribute("data-expanded", "true");
  await expect.poll(() => nav.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(164);
  expect(await page.getByRole("main").boundingBox()).toEqual(main);
  expect(await nav.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(rect.right - 8, rect.y + 100));
  })).toBeTruthy();

  await page.getByRole("button", { name: "固定侧栏", exact: true }).click();
  await page.mouse.move(1000, 300);
  await expect(nav).toHaveAttribute("data-expanded", "true");
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}").sidebarPinned, `rsm.ui.v2:${me.id}`)).toBe(true);
  await page.reload();
  await expect(nav).toHaveAttribute("data-pinned", "true");
  await expect(nav).toHaveAttribute("data-expanded", "true");
  expect(await page.getByRole("main").boundingBox()).toEqual(main);

  await page.getByRole("button", { name: "取消固定侧栏", exact: true }).click();
  await page.mouse.move(1000, 300);
  await expect(nav).toHaveAttribute("data-expanded", "false");
  await expect.poll(() => nav.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(56);
  await expect(page.getByRole("button", { name: /^(展开|收起)侧栏$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "需求", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(nav).toHaveAttribute("data-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(nav).toHaveAttribute("data-expanded", "false");
  expect(await page.getByRole("main").boundingBox()).toEqual(main);
});

for (const theme of ["light", "dark"] as const) {
  test(`日间立体 Grid、夜间细雨持续绘制，Cyber Button 悬停与键盘可用（${theme}）`, async ({ page }) => {
    await openShell(page, false, theme);
    const background = page.locator(`[data-slot="${theme === "light" ? "grid-background" : "rain-background"}"]`);
    await expect(background).toHaveAttribute("data-motion", "animated");
    await expect(background).toHaveCSS("pointer-events", "none");
    if (theme === "light") {
      await expect(background).toHaveAttribute("data-renderer", "webgl");
      const original = await readGridPixels(page);
      expect(original.visible).toBeGreaterThan(0);
      await expect.poll(async () => (await readGridPixels(page)).hash).not.toBe(original.hash);
    } else {
      const drop = background.locator('[data-slot="rain-drop"]').first();
      const transform = await drop.evaluate((el) => getComputedStyle(el).transform);
      await expect.poll(() => drop.evaluate((el) => getComputedStyle(el).transform)).not.toBe(transform);
    }

    const create = page.getByRole("button", { name: "新增需求", exact: true });
    const frame = page.locator('[data-slot="cyber-button-frame"]');
    const halo = frame.locator('[data-slot="cyber-button-halo"]');
    const edges = frame.locator('[data-slot="cyber-button-edge"]');
    await expect(create).toBeEnabled();
    const rect = (await create.boundingBox())!;
    expect({ width: rect.width, height: rect.height }).toEqual({ width: 108, height: 32 });
    await expect(create).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(halo).toHaveCSS("opacity", "0");
    await expect(edges).toHaveCount(4);
    await expect(edges.first()).toHaveCSS("opacity", "0.5");
    await expect(frame.locator('[data-slot="cyber-button-texture"]')).toHaveCSS("pointer-events", "none");
    await create.hover();
    await expect(create).not.toHaveAttribute("data-tooltip");
    await expect(halo).toHaveCSS("opacity", "1");
    await expect(edges.first()).toHaveCSS("opacity", "0.7");
    await page.mouse.move(1100, 300);
    await expect(halo).toHaveCSS("opacity", "0");
    await page.keyboard.press("Tab");
    await expect(create).toBeFocused();
    await expect(halo).toHaveCSS("opacity", "1");
    await create.click();
    await expect(page.getByRole("dialog", { name: "新增需求", exact: true })).toBeVisible();
  });
}

test("减少动态效果时两种背景静止，连续切换日夜后仍可登录", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openShell(page, true);
  const grid = page.locator('[data-slot="grid-background"]');
  const rain = page.locator('[data-slot="rain-background"]');
  await expect(grid).toHaveAttribute("data-renderer", "webgl");
  await expect(grid).toHaveAttribute("data-motion", "static");
  for (let round = 0; round < 3; round += 1) {
    await page.getByRole("switch").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(grid).toHaveCount(0);
    await expect(rain).toHaveAttribute("data-motion", "static");
    const drop = rain.locator('[data-slot="rain-drop"]').first();
    const before = await drop.evaluate((el) => getComputedStyle(el).transform);
    await page.mouse.move(500, 300);
    await page.waitForTimeout(100);
    expect(await drop.evaluate((el) => getComputedStyle(el).transform)).toBe(before);
    await page.getByRole("switch").click();
    await expect(rain).toHaveCount(0);
    await expect(grid).toHaveAttribute("data-renderer", "webgl");
    await expect(grid).toHaveAttribute("data-motion", "static");
    await expect(grid.locator("canvas")).toHaveCount(1);
  }
  await page.getByRole("banner").getByRole("button", { name: "未登录", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "登录 RSM", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("游客保留新增权限限制，窄屏导航与三个需求底栏均可访问", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openShell(page, true);
  const create = page.getByRole("button", { name: "新增需求", exact: true });
  await expect(create).toBeDisabled();
  await create.hover();
  await expect(page.locator('[data-slot="cyber-button-halo"]')).toHaveCSS("opacity", "0");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "角色权限", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "需求", exact: true }).click();
  for (const [tab, label] of [["甘特图", "甘特图图例"], ["需求池", "需求池底部信息"], ["已归档", "归档底部信息"]]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    const footer = page.getByLabel(label, { exact: true });
    await expect(footer).toBeInViewport();
    expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width: 320, height: 568 });
  }
});
