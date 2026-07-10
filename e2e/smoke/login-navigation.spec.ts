import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { loginAs } from "../support/login.ts";

test("admin lands on system management and sees admin navigation", async ({ page }) => {
  await loginAs(page, "admin");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("link", { name: "系统管理" })).toHaveClass(/active/);
  await expect(navigation.getByRole("link", { name: "全部图纸" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "零件库" })).toBeVisible();
});

test("reviewer lands on the review queue", async ({ page }) => {
  await loginAs(page, "supervisor");
  await expect(page.getByRole("heading", { name: "我的待审图纸" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "待我审核" })).toHaveClass(/active/);
});

test("designer with a configured signature can open submission", async ({ page }) => {
  await loginAs(page, "designer");
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "提交图纸" })).toHaveClass(/active/);
  await expect(page.getByText("请先配置签名")).toHaveCount(0);
});

test("login has no critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  const result = await new AxeBuilder({ page }).include("main").analyze();
  const critical = result.violations.filter((item) => item.impact === "critical");
  expect(critical, JSON.stringify(critical, null, 2)).toEqual([]);
});
