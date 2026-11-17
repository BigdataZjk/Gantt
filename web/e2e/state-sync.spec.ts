import { expect, test } from "@playwright/test";
import type { ApiRequest, Preferences, State } from "../src/api/types";
import { request } from "../src/test/fixtures";

for (const source of ["个人偏好保存", "后台资料刷新"] as const) {
  test(`${source}的旧响应晚到时不覆盖刚保存的加班`, async ({ page }) => {
    const original = await (await page.request.get("/api/state")).json() as State;
    const me = original.users.find((user) => user.role === "superadmin" && !user.deleted)!;
    const state: State = {
      ...original, me, revision: 100, setupRequired: false,
      requests: [request({ developer: me.id, domain: original.domains[0]!.name })],
      preferences: { ...original.preferences, theme: "light" },
    };
    let delayRead = false;
    let release: (() => Promise<void>) | undefined;
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/preferences" || (path === "/api/state" && delayRead)) {
        delayRead = false;
        if (path === "/api/preferences") state.preferences = route.request().postDataJSON() as Preferences;
        const snapshot = structuredClone(state);
        release = async () => { await route.fulfill({ json: snapshot }); };
        return;
      }
      if (path === "/api/state") return route.fulfill({ json: state });
      if (path === "/api/presence") return route.fulfill({ json: { users: [], guests: 0 } });
      if (path === "/api/requests/1" && route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as { request: ApiRequest };
        state.requests = [{ ...body.request, revision: state.requests[0]!.revision + 1 }];
        state.revision += 1;
        return route.fulfill({ json: state });
      }
      return route.abort();
    });
    await page.addInitScript((id) => {
      localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({ ganttRange: { start: "2026-11-09", end: "2026-12-03" } }));
    }, me.id);
    await page.goto("/");
    const cell = page.locator('tr[data-row="1"] td[data-date="2026-11-21"]');
    await expect(cell).toBeVisible();
    if (source === "个人偏好保存") {
      await page.getByRole("switch", { name: "切换为夜间模式" }).click();
    } else {
      delayRead = true;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    await expect.poll(() => Boolean(release)).toBe(true);
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "加班", exact: true }).click();
    await expect(cell.locator('[data-marker="overtime"]')).toBeVisible();
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === (source === "个人偏好保存" ? "/api/preferences" : "/api/state"));
    await release!();
    await response;
    await expect(cell.locator('[data-marker="overtime"]')).toBeVisible();
    await cell.click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消加班", exact: true }).click();
    await expect(cell.locator('[data-marker="overtime"]')).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
