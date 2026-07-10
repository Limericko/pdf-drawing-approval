import { defineConfig, devices } from "@playwright/test";

const apiUrl = "http://127.0.0.1:18080";
const webUrl = "http://127.0.0.1:14173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: ".cache/e2e/test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: ".cache/e2e/playwright-report", open: "never" }]],
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.02 }
  },
  use: {
    baseURL: webUrl,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: "npm run e2e:server",
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "npm run e2e:client",
      url: webUrl,
      env: { PDF_APPROVAL_DEV_API_TARGET: apiUrl },
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
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
