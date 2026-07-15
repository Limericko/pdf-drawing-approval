import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";
import type { Page } from "@playwright/test";

const consoleErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAs(page, "supervisor");
});

test.afterEach(async ({ page }) => {
  expect(consoleErrors.get(page) ?? [], "PDF 工作台不应产生控制台错误").toEqual([]);
});

test("reviewer opens the seeded approval and renders a nonblank PDF canvas", async ({ page }) => {
  const row = page.getByRole("row", { name: /E2E项目.*E2E轴承座/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "查看" }).click();
  await expect(page.getByRole("heading", { name: "E2E项目 / E2E轴承座" })).toBeVisible();

  const canvas = page.locator('canvas[aria-label^="PDF 第"]').first();
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
      page.getByText("提交时间").locator("..").locator("strong")
    ]
  });
});

test("annotation tools and review actions follow desktop and mobile policy", async ({ page }, testInfo) => {
  await page
    .getByRole("row", { name: /E2E项目.*E2E轴承座/ })
    .getByRole("link", { name: "查看" })
    .click();
  await expect(page.getByLabel("PDF 批注工具")).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.getByText(/精确绘制请使用桌面宽屏/)).toBeVisible();
    await page.getByRole("button", { name: "打开审阅检查器" }).click();
    await expect(page.getByRole("complementary", { name: "审阅检查器" })).toBeInViewport();
    await expect(page.getByRole("tab", { name: /问题/ })).toBeVisible();
    await page.getByTitle("关闭审阅检查器").click();
  } else {
    for (const name of ["选择", "定位", "箭头", "矩形", "圆形", "文字", "画笔", "云线"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }
  }
  await expect(page.getByRole("button", { name: "通过", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "驳回", exact: true })).toBeVisible();
});

test("reviewer draws, saves, zooms, jumps, undoes and redoes an annotation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Precision drawing is a desktop-first workflow.");
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();

  const viewportControls = page.getByLabel("PDF 视图控制");
  await viewportControls.getByRole("button", { name: "按 100% 显示 PDF" }).click();
  await expect(viewportControls.getByText("100%", { exact: true })).toBeVisible();
  await viewportControls.getByRole("button", { name: "放大 PDF" }).click();
  await expect(viewportControls.getByText("110%", { exact: true })).toBeVisible();

  const pageNavigator = page.getByLabel("PDF 页码导航");
  await pageNavigator.locator('input[type="number"]').fill("1");
  await expect(page.getByLabel("PDF 视图状态")).toContainText("第 1 / 1 页");

  const existingMarkers = await page.locator("[data-annotation-id]").count();
  await page.getByRole("button", { name: "矩形", exact: true }).click();
  const layer = page.locator('[data-readonly="false"]').first();
  const box = await layer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.28, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.52, box!.y + box!.height * 0.48, { steps: 8 });
  await page.mouse.up();
  await page.getByLabel("说明内容").fill("E2E 矩形批注");
  await page.getByRole("button", { name: "保存说明" }).click();
  await expect(page.getByText("图纸说明已添加。")).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toHaveCount(existingMarkers + 1);

  await page.getByRole("button", { name: "撤销批注修改" }).click();
  await expect(page.getByText("已撤销上一项批注修改。")).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toHaveCount(existingMarkers);
  await page.getByRole("button", { name: "重做批注修改" }).click();
  await expect(page.getByText("已重做批注修改。")).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toHaveCount(existingMarkers + 1);
  await page.getByRole("button", { name: "撤销批注修改" }).click();
  await expect(page.locator("[data-annotation-id]")).toHaveCount(existingMarkers);
});

test("long PDF renders a bounded window and atomically creates a located formal issue", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Long-document precision review is covered on desktop.");
  await page.getByRole("row", { name: /E2E项目.*E2E长文档/ }).getByRole("link", { name: "查看" }).click();
  await expect(page.getByRole("heading", { name: "E2E项目 / E2E长文档" })).toBeVisible();
  const rail = page.getByRole("navigation", { name: "PDF 缩略页导航" });
  await expect(rail.getByRole("button")).toHaveCount(12);
  await expect(page.locator('canvas[aria-label^="PDF 第"]')).toHaveCount(2);
  await expect(rail.locator("canvas")).toHaveCount(4);

  const navigator = page.getByLabel("PDF 页码导航");
  await navigator.locator('input[type="number"]').fill("7");
  await expect(page.getByLabel("PDF 视图状态")).toContainText("第 7 / 12 页");
  await expect(page.locator('canvas[aria-label^="PDF 第"]')).toHaveCount(3);
  await expect(rail.locator("canvas")).toHaveCount(7);

  await page.getByRole("button", { name: "矩形", exact: true }).click();
  const pageSeven = page.locator('canvas[aria-label="PDF 第 7 页"]').locator("..");
  const layer = pageSeven.locator('[data-readonly="false"]');
  const box = await layer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.48, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "正式问题", exact: true }).click();
  const locatedIssueForm = page.locator("form").filter({
    has: page.getByRole("group", { name: "批注类型" }),
  });
  await locatedIssueForm.locator("#annotation-issue-title").fill("第七页基准尺寸缺失");
  await locatedIssueForm.locator("#annotation-issue-severity").selectOption("medium");
  await locatedIssueForm.locator("#annotation-issue-assignee").selectOption({ label: "E2E设计师" });
  await locatedIssueForm.locator("#annotation-issue-due-at").fill("2026-07-20T09:00");
  await locatedIssueForm.locator("#annotation-issue-message").fill("请补充第七页基准尺寸链。");
  await locatedIssueForm.getByRole("button", { name: "创建正式问题" }).click();
  await expect(page.getByText("正式问题已定位、创建并分配。")).toBeVisible();
  await page.getByRole("button", { name: /第七页基准尺寸缺失/ }).click();
  await expect(page.getByRole("button", { name: "定位关联批注" })).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toHaveCount(1);
  const issueFilters = page.getByLabel("正式问题筛选");
  await issueFilters.getByLabel("严重级").selectOption("medium");
  await issueFilters.getByLabel("页面").selectOption("7");
  await expect(page.getByRole("button", { name: /第七页基准尺寸缺失/ })).toBeVisible();
  await issueFilters.getByLabel("页面").selectOption("1");
  await expect(page.getByText("没有符合筛选条件的问题")).toBeVisible();
});

test("supervisor, designer and reviewer complete a formal issue lifecycle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The full precision review lifecycle is covered on desktop.");
  test.setTimeout(60_000);
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await page.getByRole("button", { name: "新建问题" }).click();
  await page.getByLabel("问题标题").fill("轴承孔公差未标注");
  await page.getByLabel("问题说明").fill("请补充 H7 公差与基准关系。");
  await page.locator("#issue-severity").selectOption("high");
  await page.locator("#issue-assignee").selectOption({ label: "E2E设计师" });
  await page.getByRole("button", { name: "创建正式问题" }).click();
  await expect(page.getByText("正式问题已创建并分配。")).toBeVisible();
  await expect(page.getByRole("button", { name: "通过", exact: true })).toBeDisabled();

  await switchRole(page, "designer");
  await page.getByRole("link", { name: "全部图纸" }).click();
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await page.getByRole("button", { name: /轴承孔公差未标注/ }).click();
  await page.getByRole("button", { name: "开始处理" }).click();
  await page.getByRole("button", { name: /轴承孔公差未标注/ }).click();
  await page.getByRole("button", { name: "提交复核" }).click();
  await page.getByLabel("提交复核说明").fill("已补充 H7 公差与基准关系。");
  await page.getByRole("button", { name: "提交复核", exact: true }).last().click();
  await expect(page.getByText("问题状态已更新。")).toBeVisible();

  await switchRole(page, "supervisor");
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await page.getByRole("button", { name: /轴承孔公差未标注/ }).click();
  await page.getByRole("button", { name: "退回修改" }).click();
  await page.getByLabel("退回修改说明").fill("请同步更新技术要求中的基准引用。");
  await page.getByRole("button", { name: "退回修改", exact: true }).last().click();
  await expect(page.getByText("问题状态已更新。")).toBeVisible();

  await switchRole(page, "designer");
  await page.getByRole("link", { name: "全部图纸" }).click();
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await page.getByRole("button", { name: /轴承孔公差未标注/ }).click();
  await page.getByRole("button", { name: "提交复核" }).click();
  await page.getByLabel("提交复核说明").fill("已同步更新技术要求中的基准引用。");
  await page.getByRole("button", { name: "提交复核", exact: true }).last().click();
  await expect(page.getByText("问题状态已更新。")).toBeVisible();

  await switchRole(page, "supervisor");
  await page.getByRole("row", { name: /E2E项目.*E2E轴承座/ }).getByRole("link", { name: "查看" }).click();
  await page.getByRole("button", { name: /轴承孔公差未标注/ }).click();
  await page.getByRole("button", { name: "复核关闭" }).click();
  await page.getByLabel("复核关闭说明").fill("复核通过。");
  await page.getByRole("button", { name: "复核关闭", exact: true }).last().click();
  await expect(page.getByText("没有高严重级阻断")).toBeVisible();
  await expect(page.getByText("复核通过。", { exact: true })).toBeVisible();
});

async function switchRole(page: Page, role: "designer" | "supervisor") {
  await page.getByRole("button", { name: "退出登录" }).click();
  await loginAs(page, role);
}
