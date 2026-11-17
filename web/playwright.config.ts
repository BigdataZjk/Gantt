import { defineConfig, devices } from "@playwright/test";

const useMock = process.env.RSM_E2E_MOCK === "1";
const external = process.env.RSM_E2E_EXTERNAL === "1";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.RSM_E2E_BASE_URL || "http://127.0.0.1:1111",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  },
  webServer: external
    ? undefined
    : [
        ...(useMock
          ? [{ command: "node e2e/mock-api.mjs", url: "http://127.0.0.1:8080/healthz", reuseExistingServer: false, timeout: 30_000 }]
          : []),
        {
          command: "pnpm dev",
          url: "http://127.0.0.1:1111",
          reuseExistingServer: false,
          timeout: 90_000,
        },
      ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});