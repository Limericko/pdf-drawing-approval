import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("DS0/DS1 foundation is stable, accessible and responsive", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/__ui-gallery");
  await expect(page.getByRole("heading", { level: 1, name: "UI 设计系统基线" })).toBeVisible();
  await expect(page.getByText("Phase 2 · DS0 / DS1")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(overflow.content).toBeLessThanOrEqual(overflow.viewport + 1);

  await page.keyboard.press("Tab");
  await expect(page.locator("button:focus-visible").first()).toBeVisible();

  const axe = await new AxeBuilder({ page }).analyze();
  const blocking = axe.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  expect(consoleErrors).toEqual([]);

  await expect(page).toHaveScreenshot("foundation.png", { fullPage: true });
});
