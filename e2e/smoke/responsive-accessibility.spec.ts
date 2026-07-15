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

test("desktop shell collapses to the 64px navigation contract", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "mobile uses the compact horizontal task flow");
  await loginAs(page, "admin");
  const toggle = page.getByRole("button", { name: "收起侧边栏" });
  await toggle.click();
  const shell = page.locator('[data-collapsed="true"]').first();
  await expect(shell).toBeVisible();
  await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ")[0])).toBe("64px");
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "系统管理" })).toBeVisible();
  await page.getByRole("button", { name: "展开侧边栏" }).click();
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
