import { existsSync } from "node:fs";
import { chromium, defineConfig, devices } from "@playwright/test";

const webUrl = "http://127.0.0.1:24173";
const browserChannel = existsSync(chromium.executablePath()) ? {} : { channel: "chrome" as const };

export default defineConfig({
  testDir: "./e2e/platform",
  testMatch: "**/*.spec.ts",
  outputDir: ".cache/platform-e2e/test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: webUrl,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...browserChannel
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }
    }
  ]
});
