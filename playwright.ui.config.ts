import { existsSync } from "node:fs";
import { chromium, defineConfig } from "@playwright/test";

const webUrl = "http://127.0.0.1:34173";
const browserChannel = existsSync(chromium.executablePath()) ? {} : { channel: "chrome" as const };

const viewports = [
  ["desktop-1440", 1440, 900],
  ["compact-1280", 1280, 800],
  ["landscape-1024", 1024, 768],
  ["portrait-768", 768, 1024],
  ["mobile-390", 390, 844]
] as const;

export default defineConfig({
  testDir: "./e2e/ui-gallery",
  testMatch: "**/*.spec.ts",
  outputDir: ".cache/ui-gallery-e2e/test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.01 }
  },
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
  projects: viewports.map(([name, width, height]) => ({ name, use: { viewport: { width, height } } }))
});
