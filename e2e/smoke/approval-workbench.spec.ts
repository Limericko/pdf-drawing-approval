import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

test.beforeEach(async ({ page }) => {
  await loginAs(page, "supervisor");
});

test("reviewer opens the seeded approval and renders a nonblank PDF canvas", async ({ page }) => {
  const row = page.getByRole("row", { name: /E2E项目.*E2E轴承座/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "查看" }).click();
  await expect(page.getByRole("heading", { name: "E2E项目 / E2E轴承座" })).toBeVisible();

  const canvas = page.locator("canvas.pdf-annotation-canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () =>
      canvas.evaluate((element: HTMLCanvasElement) => {
        const context = element.getContext("2d");
        if (!context || element.width === 0 || element.height === 0) return 0;
        const pixels = context.getImageData(0, 0, element.width, element.height).data;
        let nonWhite = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            pixels[index + 3] > 0 &&
            (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245)
          ) {
            nonWhite += 1;
          }
        }
        return nonWhite;
      })
    )
    .toBeGreaterThan(100);

  await expect(page).toHaveScreenshot("approval-workbench.png", {
    fullPage: true,
    mask: [
      page.locator("time"),
      page.locator(".drawing-meta-strip > div").filter({ hasText: "提交时间" }).locator("strong")
    ]
  });
});

test("annotation tools and review actions remain available", async ({ page }) => {
  await page
    .getByRole("row", { name: /E2E项目.*E2E轴承座/ })
    .getByRole("link", { name: "查看" })
    .click();
  await expect(page.getByLabel("PDF 批注工具")).toBeVisible();
  for (const name of ["选择", "定位", "箭头", "矩形", "圆形", "文字", "画笔", "云线"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /通过/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /驳回/ })).toBeVisible();
});
