import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { platformE2EAdmin, platformE2EAdminTotpSecret } from "./support/seed.ts";
import { currentTotpFromHex } from "./support/totp.ts";

test("项目访问只接受 active membership，未授权项目统一 404", async ({ page, platform }) => {
  await login(page, platform);
  const session = await jsonRequest(page, "/api/v2/session", "GET");
  const csrfToken = (session.body as { readonly csrfToken: string }).csrfToken;
  const created = await jsonRequest(page, "/api/v2/projects", "POST",
    { name: `项目权限门禁 ${platform.runId.slice(0, 8)}` }, csrfToken);
  expect(created.status).toBe(201);
  const projectId = (created.body as { readonly project: { readonly id: string } }).project.id;

  const allowed = await jsonRequest(page, `/api/v2/projects/${projectId}/access`, "GET");
  expect(allowed.status).toBe(200);
  expect((allowed.body as { readonly membership: { readonly role: string; readonly status: string } }).membership)
    .toEqual(expect.objectContaining({ role: "manager", status: "active" }));

  const denied = await jsonRequest(page, `/api/v2/projects/${platform.seed.unauthorizedProjectId}/access`, "GET");
  expect(denied.status).toBe(404);
  expect((denied.body as { readonly code: string }).code).toBe("PROJECT_NOT_FOUND");

  const projects = await jsonRequest(page, "/api/v2/projects", "GET");
  const ids = (projects.body as { readonly projects: readonly { readonly id: string }[] }).projects.map(({ id }) => id);
  expect(ids).toContain(projectId);
  expect(ids).not.toContain(platform.seed.unauthorizedProjectId);
});

async function login(page: Page, platform: {
  readonly webUrl: string;
  readonly seed: { readonly adminEmail: string };
}) {
  await page.goto(platform.webUrl);
  await page.getByLabel("邮箱地址").fill(platform.seed.adminEmail);
  await page.getByLabel("密码").fill(platformE2EAdmin.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  await page.getByLabel("6 位动态验证码").fill(currentTotpFromHex(platformE2EAdminTotpSecret.toString("hex")));
  await page.getByRole("button", { name: "确认并登录" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
}

async function jsonRequest(page: Page, path: string, method: string, body?: unknown, csrfToken?: string) {
  return page.evaluate(async ({ path, method, body, csrfToken }) => {
    const response = await fetch(path, { method, credentials: "same-origin",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as unknown };
  }, { path, method, body, csrfToken });
}
