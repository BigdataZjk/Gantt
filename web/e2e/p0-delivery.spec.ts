import { expect, test } from "@playwright/test";
import type { State } from "../src/api/types";
import { request } from "../src/test/fixtures";

test("P0 交付日期确认覆盖需求编辑、甘特拖拽、撤回和顺排随动", async ({ page }, testInfo) => {
  const readState = async () => await (await page.request.get("/api/state")).json() as State;
  const password = process.env.RSM_E2E_PASSWORD || "rsm-e2e-pass-123";
  const guest = await readState();
  const session = guest.setupRequired
    ? await page.request.post("/api/setup", { data: { password } })
    : await page.request.post("/api/login", { data: { username: "张金科", password } });
  expect(session.ok()).toBe(true);

  const prefix = `P0确认-${Date.now().toString(36)}`;
  const created = await page.request.post("/api/users", { data: { username: prefix, password, role: "collaborator" } });
  expect(created.ok()).toBe(true);
  let state = await created.json() as State;
  const developer = state.users.find((user) => user.username === prefix)!.id;
  const cases = [
    { name: `${prefix} 顺排起点`, start: "2026-11-16", priority: "P1" },
    { name: `${prefix} 顺排调整项`, start: "2026-11-17", priority: "P1" },
    { name: `${prefix} 随动甲`, start: "2026-11-18", priority: "P0" },
    { name: `${prefix} 随动乙`, start: "2026-11-19", priority: "P0" },
  ] as const;
  for (const item of cases) {
    const result = await page.request.post("/api/requests", {
      data: { baseRevision: state.revision, request: request({ ...item, developer, delivery: "" }) },
    });
    expect(result.ok()).toBe(true);
    state = await result.json() as State;
  }
  const [anchor, next, firstP0, secondP0] = cases.map((item) => state.requests.find((row) => row.name === item.name)!);
  const nameButton = (name: string) => page.getByRole("button", { name, exact: true });
  const confirmation = page.getByRole("dialog", { name: "确认 P0 交付日期变更", exact: true });
  const cancel = confirmation.getByRole("button", { name: "取消", exact: true });
  const confirm = confirmation.getByRole("button", { name: "确认并执行", exact: true });
  const assertDates = async (id: number, before: string, after: string) => {
    const entry = confirmation.getByRole("listitem").filter({ hasText: state.requests.find((row) => row.id === id)!.name });
    await expect(entry.locator("time")).toHaveText([before, after]);
  };
  const savedDelivery = async (id: number) => (await readState()).requests.find((row) => row.id === id)!.delivery;

  await page.addInitScript((id) => {
    localStorage.setItem(`rsm.ui.v2:${id}`, JSON.stringify({ ganttRange: { start: "2026-11-16", end: "2026-12-10" } }));
  }, state.me!.id);
  await page.goto("/");
  await nameButton(firstP0!.name).dblclick();
  const editor = page.getByRole("dialog", { name: "编辑需求", exact: true });
  await editor.getByRole("tab", { name: "开发信息", exact: true }).click();
  const days = editor.getByLabel("开发人天", { exact: true });
  const save = editor.getByRole("button", { name: "保存需求", exact: true });
  await days.fill("4");
  await save.click();
  await assertDates(firstP0!.id, "2026-11-20", "2026-11-23");
  await expect(cancel).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("p0-delivery-editor.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(days).toHaveValue("4");
  expect(await savedDelivery(firstP0!.id)).toBe("2026-11-20");
  await save.click();
  await confirm.click();
  await expect(editor).toBeHidden();
  expect(await savedDelivery(firstP0!.id)).toBe("2026-11-23");

  const row = page.locator(`tr[data-row="${secondP0!.id}"]`);
  const bar = row.locator('td[data-date="2026-11-19"] [data-bar]');
  await bar.scrollIntoViewIfNeeded();
  const start = (await bar.boundingBox())!;
  const target = (await row.locator('td[data-date="2026-11-20"]').boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(target.x + target.width / 2, start.y + start.height / 2, { steps: 5 });
  await expect(page.locator('[data-slot="gantt-drag-hint"]')).toBeVisible();
  await page.mouse.up({ button: "right" });
  await assertDates(secondP0!.id, "2026-11-23", "2026-11-24");
  expect(await savedDelivery(secondP0!.id)).toBe("2026-11-23");
  await confirm.click();
  await expect.poll(() => savedDelivery(secondP0!.id)).toBe("2026-11-24");
  await page.keyboard.press("Control+z");
  await assertDates(secondP0!.id, "2026-11-24", "2026-11-23");
  await confirm.click();
  await expect.poll(() => savedDelivery(secondP0!.id)).toBe("2026-11-23");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await nameButton(anchor!.name).click();
  await nameButton(next!.name).click({ modifiers: ["Shift"] });
  await nameButton(next!.name).click({ button: "right" });
  await page.getByRole("menuitem", { name: "顺排预览", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "顺排预览", exact: true });
  const apply = preview.getByRole("button", { name: "应用顺排", exact: true });
  const changes = await Promise.all([firstP0!, secondP0!].map(async (item) => {
    const follow = preview.locator(`[data-preview-row="${item.id}"]`);
    await expect(follow).toHaveAttribute("data-preview-selected", "false");
    const date = await follow.locator('[data-preview-bar="after"]').last().getAttribute("data-end");
    expect(date).toBeTruthy();
    return { id: item.id, after: date! };
  }));
  const beforeSequence = await readState();
  await apply.click();
  await expect(confirmation.getByRole("listitem")).toHaveCount(2);
  for (const { id, after } of changes) await assertDates(id, "2026-11-23", after);
  await page.screenshot({ path: testInfo.outputPath("p0-delivery-sequence.png"), animations: "disabled" });
  await cancel.click();
  await expect(apply).toBeEnabled();
  await expect(confirmation).toBeHidden();
  expect((await readState()).requests).toEqual(beforeSequence.requests);
  await apply.click();
  await confirm.click();
  await expect(preview).toBeHidden();
  const saved = await readState();
  expect(saved.revision).toBe(beforeSequence.revision + 1);
  for (const { id, after } of changes) expect(saved.requests.find((item) => item.id === id)!.delivery).toBe(after);
});
