import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { platformE2EAdmin, platformE2EAdminTotpSecret } from "./support/seed.ts";
import { currentTotpFromHex } from "./support/totp.ts";

test("会话绑定 CSRF 且退出后旧 Cookie 与 token 同时失效", async ({ browser, page, platform }) => {
  await login(page, platform.webUrl, platform.seed.adminEmail, platformE2EAdmin.password,
    currentTotpFromHex(platformE2EAdminTotpSecret.toString("hex")));
  const sessionA = await jsonRequest(page, "/api/v2/session", "GET");
  expect(sessionA.status).toBe(200);
  expect(sessionA.cacheControl).toBe("no-store");
  const csrfA = (sessionA.body as { readonly csrfToken: string }).csrfToken;

  const contextB = await browser.newContext({ baseURL: platform.webUrl, locale: "zh-CN" });
  const pageB = await contextB.newPage();
  try {
    await login(pageB, platform.webUrl, platform.seed.adminEmail, platformE2EAdmin.password,
      currentTotpFromHex(platformE2EAdminTotpSecret.toString("hex")));
    const sessionB = await jsonRequest(pageB, "/api/v2/session", "GET");
    const csrfB = (sessionB.body as { readonly csrfToken: string }).csrfToken;
    expect(csrfB).not.toBe(csrfA);

    const payload = { name: `CSRF 隔离项目 ${platform.runId.slice(0, 8)}` };
    expect((await jsonRequest(pageB, "/api/v2/projects", "POST", payload)).status).toBe(403);
    expect((await jsonRequest(pageB, "/api/v2/projects", "POST", payload, "wrong-token")).status).toBe(403);
    expect((await jsonRequest(pageB, "/api/v2/projects", "POST", payload, csrfA)).status).toBe(403);
    expect((await jsonRequest(pageB, "/api/v2/projects", "POST", payload, csrfB)).status).toBe(201);

    const oldCookie = (await contextB.cookies()).find(({ name }) => name === "platform_session");
    expect(oldCookie).toBeDefined();
    const logout = await jsonRequest(pageB, "/api/v2/session", "DELETE", {}, csrfB);
    expect(logout.status).toBe(204);
    expect(logout.cacheControl).toBe("no-store");
    expect((await jsonRequest(pageB, "/api/v2/session", "GET")).status).toBe(401);

    await contextB.addCookies([oldCookie!]);
    expect((await jsonRequest(pageB, "/api/v2/session", "GET")).status).toBe(401);
    expect([401, 403]).toContain((await jsonRequest(pageB, "/api/v2/projects", "POST",
      { name: "旧会话不可写" }, csrfB)).status);
  } finally {
    await contextB.close();
  }
});

async function login(page: Page, webUrl: string, email: string, password: string, totp: string) {
  await page.goto(webUrl);
  await page.getByLabel("邮箱地址").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "继续验证" }).click();
  await page.getByLabel("6 位动态验证码").fill(totp);
  await page.getByRole("button", { name: "确认并登录" }).click();
  await expect(page.getByRole("heading", { name: "可访问项目" })).toBeVisible();
}

async function jsonRequest(page: Page, path: string, method: string, body?: unknown, csrfToken?: string) {
  return page.evaluate(async ({ path, method, body, csrfToken }) => {
    const response = await fetch(path, { method, credentials: "same-origin",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, cacheControl: response.headers.get("cache-control"),
      body: response.status === 204 ? null : await response.json() as unknown };
  }, { path, method, body, csrfToken });
}
