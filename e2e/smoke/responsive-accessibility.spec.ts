import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

test("authenticated shell fits the viewport", async ({ page }) => {
  await loginAs(page, "admin");
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});

test("admin surface has no critical accessibility violations", async ({ page }) => {
  await loginAs(page, "admin");
  const result = await new AxeBuilder({ page }).include("#main-content").analyze();
  const critical = result.violations.filter((item) => item.impact === "critical");
  expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
  test.info().attach("axe-violations", {
    body: JSON.stringify(result.violations, null, 2),
    contentType: "application/json"
  });
});

test("authenticated shell visual baseline", async ({ page }) => {
  await loginAs(page, "admin");
  await expect(page).toHaveScreenshot("admin-shell.png", {
    fullPage: true,
    mask: [page.locator("time")]
  });
});
