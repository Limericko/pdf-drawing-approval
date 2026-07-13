import { expect, type Page } from "@playwright/test";
import { e2eUsers } from "./fixtures.ts";

export type E2eRole = keyof typeof e2eUsers;

export async function loginAs(page: Page, role: E2eRole) {
  const account = e2eUsers[role];
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill(account.username);
  await page.getByLabel("密码").fill(account.password);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  const expectedUrl = account.landingPath === "/"
    ? new URL("/", page.url()).toString()
    : new RegExp(`#${account.landingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  await expect(page).toHaveURL(expectedUrl);
}
