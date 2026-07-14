import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("DS0–DS5 foundation is stable, accessible and responsive", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/__ui-gallery");
  await expect(page.getByRole("heading", { level: 1, name: "UI 设计系统基线" })).toBeVisible();
  await expect(page.getByText("Phase 2–3 · DS0–DS5")).toBeVisible();
  await expect(page.getByLabel("PDF Studio DS5 预览")).toBeVisible();
  await expect(page.getByLabel("PDF 审阅动作")).toBeVisible();

  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(overflow.content).toBeLessThanOrEqual(overflow.viewport + 1);

  await page.keyboard.press("Tab");
  await expect(page.locator("button:focus-visible").first()).toBeVisible();

  const dialogTrigger = page.getByRole("button", { name: "打开对话框" });
  await dialogTrigger.click();
  await expect(page.getByRole("dialog", { name: "确认发布版本 A03" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭对话框" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "确认发布版本 A03" })).toHaveCount(0);
  await expect(dialogTrigger).toBeFocused();

  const drawerTrigger = page.getByRole("button", { name: "打开属性抽屉" });
  await drawerTrigger.click();
  await expect(page.getByRole("dialog", { name: "图纸属性" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "图纸属性" })).toHaveCount(0);
  await expect(drawerTrigger).toBeFocused();

  await page.getByRole("button", { name: "筛选条件" }).click();
  await expect(page.getByRole("dialog", { name: "版本筛选" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "版本筛选" })).toHaveCount(0);

  const drawingTable = page.getByRole("table", { name: "图纸版本" });
  await expect(drawingTable).toHaveAttribute("data-sticky-header", "true");
  const mobileTable = (page.viewportSize()?.width ?? 0) <= 768;
  const firstDrawing = page.getByRole("checkbox", { name: "选择 GX-240713-018 · 减速器壳体" });
  if (mobileTable) {
    await expect(firstDrawing).toBeChecked();
    await firstDrawing.uncheck();
    await expect(page.getByText("已选择 1 项")).toHaveCount(0);
    await firstDrawing.check();
  } else {
    const selectAll = page.getByRole("checkbox", { name: "选择全部图纸版本" });
    await selectAll.check();
    await expect(page.getByText("已选择 3 项")).toBeVisible();
    await page.getByRole("button", { name: "清除选择" }).click();
    await expect(page.getByText("已选择 3 项")).toHaveCount(0);
    await firstDrawing.check();
  }
  await expect(page.getByText("已选择 1 项")).toBeVisible();

  await expect(page.getByLabel("正在加载待处理任务")).toBeVisible();
  await expect(page.getByText("暂无已发布版本")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "无法读取同步记录" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "分页" })).toContainText("第 2 / 7 页");

  const ownerCell = drawingTable.locator('td[data-label="负责人"]').first();
  if (mobileTable) await expect(ownerCell).toBeHidden();
  else await expect(ownerCell).toBeVisible();

  const axe = await new AxeBuilder({ page }).analyze();
  const blocking = axe.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  expect(consoleErrors).toEqual([]);

  await expect(page).toHaveScreenshot("foundation.png", { fullPage: true });
});
