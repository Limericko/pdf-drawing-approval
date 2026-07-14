import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

const viewports = [
  { width: 1440, height: 900, inspectorWidth: 320, railWidth: 112 },
  { width: 1100, height: 820, inspectorWidth: 280, railWidth: 88 },
  { width: 800, height: 900, inspectorWidth: null, railWidth: null },
  { width: 680, height: 860, inspectorWidth: null, railWidth: null },
  { width: 390, height: 844, inspectorWidth: null, railWidth: null }
] as const;

test("PDF Studio satisfies all five responsive contracts and accessibility gate", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Five explicit widths are exercised in one desktop browser session.");
  test.setTimeout(90_000);
  await loginAs(page, "supervisor");
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await expect(page.locator('canvas[aria-label^="PDF 第"]').first()).toBeVisible();

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    expect(overflow.document, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(overflow.viewport + 1);

    const inspector = page.getByRole("complementary", { name: "审阅检查器" });
    const rail = page.getByRole("navigation", { name: "PDF 缩略页导航" });
    if (viewport.inspectorWidth) {
      await expect.poll(async () => Math.round((await inspector.boundingBox())?.width ?? 0)).toBe(viewport.inspectorWidth);
      await expect.poll(async () => Math.round((await rail.boundingBox())?.width ?? 0)).toBe(viewport.railWidth);
    } else {
      await expect(rail).toBeHidden();
      await page.getByRole("button", { name: "打开审阅检查器" }).click();
      await expect(inspector).toBeInViewport();
      await expect(page.getByRole("tab", { name: /问题/ })).toBeVisible();
    }

    const axe = await new AxeBuilder({ page }).include("#main-content").analyze();
    const blocking = axe.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
    expect(blocking, `${viewport.width}px: ${JSON.stringify(blocking, null, 2)}`).toEqual([]);

    if (!viewport.inspectorWidth) {
      await page.getByTitle("关闭审阅检查器").click();
    }
  }
});
