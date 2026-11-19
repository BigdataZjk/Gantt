import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { State } from "../src/api/types";

test("全新生产实例首次设密、刷新、退出、重登及会话失效保持身份一致", async ({ browser, request }) => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const home = await mkdtemp(path.join(tmpdir(), "rsm-first-use-"));
  const binary = process.env.RSM_E2E_BINARY || path.resolve(process.cwd(), "../build/rsm");
  const child = spawn(binary, ["serve", "--home", home, "--addr", `127.0.0.1:${address.port}`], { stdio: "pipe" });
  let error: Error | undefined;
  child.on("error", (caught) => { error = caught; });
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const context = await browser.newContext({ baseURL: url });
  try {
    await expect.poll(async () => {
      if (error) throw error;
      return request.get(`${url}/healthz`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (caught) => errors.push(String(caught)));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "首次使用 RSM", exact: true })).toBeVisible();
    await page.locator("#rsm-setup-password").fill("🙂");
    await page.getByRole("button", { name: "显示初始密码", exact: true }).click();
    await expect(page.locator("[data-attention]")).toHaveAttribute("data-attention", "privacy");
    await expect(page.locator("#rsm-setup-password")).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "隐藏初始密码", exact: true }).click();
    await expect(page.locator("[data-attention]")).toHaveAttribute("data-attention", "idle");
    await page.locator("#rsm-setup-confirm").fill("🙂");
    await page.getByRole("button", { name: "设置密码并进入", exact: true }).click();
    const header = page.getByRole("banner");
    const guest = header.getByRole("button", { name: "未登录", exact: true });
    const profile = header.getByRole("button", { name: "张金科", exact: true });
    const create = page.getByRole("button", { name: "新增需求", exact: true });
    await expect(create).toBeEnabled();
    await expect(guest).toHaveCount(0);
    await expect(profile).toBeVisible();
    const state = await (await context.request.get("/api/state")).json() as State;
    expect(state.me?.role).toBe("superadmin");
    expect(state.requests).toEqual([]);
    expect(state.setupRequired).toBe(false);
    await page.reload();
    await expect(create).toBeEnabled();
    await profile.click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(guest).toBeVisible();
    await expect(create).toBeDisabled();
    await guest.click();
    const dialog = page.getByRole("dialog", { name: "登录 RSM", exact: true });
    await dialog.getByLabel("用户名", { exact: true }).fill("张金科");
    await dialog.getByLabel("密码", { exact: true }).fill("🙂");
    await dialog.getByRole("button", { name: "登录", exact: true }).click();
    await expect(create).toBeEnabled();
    await expect(guest).toHaveCount(0);
    await expect(profile).toBeVisible();
    await page.reload();
    await expect(create).toBeEnabled();
    expect((await (await context.request.post("/api/logout", { data: {} })).json() as State).me).toBeNull();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(guest).toBeVisible();
    await expect(create).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    if (!error && child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.kill("SIGTERM");
      await stopped;
      clearTimeout(timer);
    }
    await rm(home, { recursive: true, force: true });
  }
});
