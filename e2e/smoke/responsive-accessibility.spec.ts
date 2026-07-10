import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "../support/login.ts";

async function waitForAdminSurface(page: Page) {
  await expect(page.getByRole("heading", { name: "系统运维控制台" })).toBeVisible();
  await expect(page.getByLabel("坚果云图纸审批根目录")).toHaveValue(/[\\/]watch$/);
}

test("authenticated shell fits the viewport", async ({ page }) => {
  await loginAs(page, "admin");
  await waitForAdminSurface(page);
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});

test("admin surface has no critical accessibility violations", async ({ page }) => {
  await loginAs(page, "admin");
  await waitForAdminSurface(page);
  const result = await new AxeBuilder({ page }).include("#main-content").analyze();
  const critical = result.violations.filter((item) => item.impact === "critical");
  expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
  await test.info().attach("axe-violations", {
    body: JSON.stringify(result.violations, null, 2),
    contentType: "application/json"
  });
});

test("authenticated shell visual baseline", async ({ page }) => {
  await loginAs(page, "admin");
  await waitForAdminSurface(page);
  await expect(page).toHaveScreenshot("admin-shell.png", {
    fullPage: true,
    mask: [
      page.locator("time"),
      page.getByLabel("坚果云图纸审批根目录"),
      page.locator(".status-tile").filter({ hasText: "监听根目录" }).locator("strong")
    ]
  });
});
