import AxeBuilder from "@axe-core/playwright";
import type { Page, Response } from "@playwright/test";
import { createPlatformMailpit } from "./support/mailpit.ts";
import { expect, test } from "./support/fixtures.ts";
import { platformE2EAdmin, platformE2EAdminTotpSecret } from "./support/seed.ts";
import { currentTotpFromBase32, currentTotpFromHex } from "./support/totp.ts";

const invitee = Object.freeze({
  email: "phase1-invitee@example.test",
  password: "Phase1-E2E-Invitee-Password-42!"
});

test("平台身份、安全激活和一次性恢复码形成完整闭环", async ({ page, platform, browserMessages }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录审批平台" })).toBeVisible();
  await expectCriticalAxeClean(page);
  await expectNoHorizontalOverflow(page);

  const loginResponse = await submitLogin(page, platform.seed.adminEmail, platformE2EAdmin.password);
  const challenge = await loginResponse.json() as { readonly challengeToken: string };
  await expect(page.getByRole("heading", { name: "完成双重验证" })).toBeVisible();
  expect((await page.context().cookies()).filter(({ name }) => name.includes("pdf_approval_session"))).toHaveLength(0);
  await expectSecretsAbsent(page, [challenge.challengeToken], browserMessages);

  const mfaResponsePromise = waitForPost(page, "/api/v2/auth/mfa/complete");
  const adminTotp = currentTotpFromHex(platformE2EAdminTotpSecret.toString("hex"));
  await page.getByLabel("6 位动态验证码").fill(adminTotp);
  await page.getByRole("button", { name: "确认并登录" }).click();
  const mfaResponse = await mfaResponsePromise;
  expectNoStore(mfaResponse);
  await expect(page.getByRole("heading", { name: "可访问项目" })).toBeVisible();
  expect((await page.context().cookies()).some(({ name, httpOnly, sameSite }) =>
    name.includes("pdf_approval_session") && httpOnly && sameSite === "Lax")).toBe(true);
  await expectCriticalAxeClean(page);
  await expectNoHorizontalOverflow(page);

  const projectName = `E2E 精密图纸 ${platform.runId.slice(0, 8)}`;
  const projectResponsePromise = waitForPost(page, "/api/v2/projects");
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const projectResponse = await projectResponsePromise;
  const project = await projectResponse.json() as { readonly project: { readonly id: string } };
  await expect(page.getByText("项目已创建。")).toBeVisible();

  const invitationResponsePromise = waitForPost(page, "/api/v2/invitations");
  await page.getByLabel("成员邮箱").fill(invitee.email);
  await page.getByLabel("项目角色").selectOption("designer");
  await page.getByRole("button", { name: "创建邀请" }).click();
  const invitationResponse = await invitationResponsePromise;
  const invitation = await invitationResponse.json() as { readonly invitationId: string };
  await expect(page.getByText("邀请已创建并进入发送队列。")).toBeVisible();

  const mailpit = createPlatformMailpit({ baseUrl: platform.mailpitUrl });
  const delivered = await mailpit.waitForInvitation({ invitationId: invitation.invitationId, recipient: invitee.email });
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录审批平台" })).toBeVisible();

  const prepareResponsePromise = waitForPost(page, "/api/v2/invitations/prepare");
  await page.goto(`${platform.webUrl}/#/accept-invitation?token=${encodeURIComponent(delivered.invitationToken)}`);
  const prepareResponse = await prepareResponsePromise;
  expectNoStore(prepareResponse);
  const prepared = await prepareResponse.json() as { readonly enrollmentToken: string; readonly otpauthUri: string };
  await expect(page.getByRole("heading", { name: "设置安全登录" })).toBeVisible();
  await expect.poll(() => page.url()).toBe(`${platform.webUrl}/`);
  const manualSecret = (await page.locator(".platform-enrollment code").textContent())?.trim() ?? "";
  expect(manualSecret).not.toBe("");
  await expectSecretsAbsent(page, [delivered.invitationToken, prepared.enrollmentToken, prepared.otpauthUri], browserMessages);

  await page.getByLabel("设置密码").fill(invitee.password);
  await page.getByLabel("确认密码").fill(invitee.password);
  const invitationTotp = currentTotpFromBase32(manualSecret);
  await page.getByLabel("动态验证码").fill(invitationTotp);
  const completeResponsePromise = waitForPost(page, "/api/v2/invitations/complete");
  await page.getByRole("button", { name: "完成激活" }).click();
  const completeResponse = await completeResponsePromise;
  expectNoStore(completeResponse);
  const completed = await completeResponse.json() as { readonly recoveryCodes: readonly string[] };
  await expect(page.getByRole("heading", { name: "保存恢复码" })).toBeVisible();
  const shownRecoveryCodes = await page.locator(".platform-recovery-codes code").allTextContents();
  expect(shownRecoveryCodes).toEqual(completed.recoveryCodes);
  expect(shownRecoveryCodes).toHaveLength(10);
  await expectSecretsAbsent(page, [prepared.enrollmentToken], browserMessages);

  await page.getByLabel("我已将恢复码保存在安全位置").check();
  await page.getByRole("button", { name: "继续登录" }).click();
  await expect(page.getByRole("heading", { name: "登录审批平台" })).toBeVisible();
  await page.goBack();
  await expectSecretsAbsent(page, [challenge.challengeToken, delivered.invitationToken, prepared.enrollmentToken,
    prepared.otpauthUri, manualSecret, adminTotp, invitationTotp, ...shownRecoveryCodes], browserMessages);
  await expect(page.locator("body")).not.toContainText(shownRecoveryCodes[0]!);
  await expect(page.locator("body")).not.toContainText(manualSecret);
  await page.goto("/");

  await completeUiLogin(page, invitee.email, invitee.password, currentTotpFromBase32(manualSecret));
  await expect(page.getByRole("button", { name: projectName })).toBeVisible();
  const access = await sameOriginJson(page, `/api/v2/projects/${project.project.id}/access`, "GET");
  expect(access.status).toBe(200);
  await page.getByRole("button", { name: "退出登录" }).click();

  await completeUiLogin(page, invitee.email, invitee.password, shownRecoveryCodes[0]!, "recovery");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expectRecoveryCodeIsOneTimeAndRateLimited(page, invitee.email, invitee.password, shownRecoveryCodes[0]!);
  await expectInvitationLimitsAreShared(page);

  await expectSecretsAbsent(page, [challenge.challengeToken, delivered.invitationToken, prepared.enrollmentToken,
    manualSecret, ...shownRecoveryCodes], browserMessages);
});

async function submitLogin(page: Page, email: string, password: string) {
  await page.getByLabel("邮箱地址").fill(email);
  await page.getByLabel("密码").fill(password);
  const response = waitForPost(page, "/api/v2/auth/login");
  await page.getByRole("button", { name: "继续验证" }).click();
  const settled = await response;
  expect(settled.status()).toBe(202);
  expectNoStore(settled);
  return settled;
}

async function completeUiLogin(page: Page, email: string, password: string, code: string,
  method: "totp" | "recovery" = "totp") {
  await expect(page.getByRole("heading", { name: "登录审批平台" })).toBeVisible();
  await submitLogin(page, email, password);
  if (method === "recovery") await page.getByLabel("恢复码", { exact: true }).check();
  await page.getByLabel(method === "totp" ? "6 位动态验证码" : "恢复码", { exact: true }).fill(code);
  const response = waitForPost(page, "/api/v2/auth/mfa/complete");
  await page.getByRole("button", { name: "确认并登录" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "可访问项目" })).toBeVisible();
}

async function expectRecoveryCodeIsOneTimeAndRateLimited(page: Page, email: string, password: string,
  consumedCode: string) {
  let blocked = false;
  for (let challengeIndex = 0; challengeIndex < 3 && !blocked; challengeIndex += 1) {
    const login = await sameOriginJson(page, "/api/v2/auth/login", "POST", { email, password });
    if (login.status === 429) break;
    expect(login.status).toBe(202);
    const challengeToken = (login.body as { readonly challengeToken: string }).challengeToken;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const completion = await sameOriginJson(page, "/api/v2/auth/mfa/complete", "POST", {
        challengeToken, factor: { method: "recovery", code: consumedCode }
      });
      if (completion.status === 429) { blocked = true; break; }
      expect(completion.status).toBe(401);
    }
  }
  expect(blocked).toBe(true);
}

async function expectInvitationLimitsAreShared(page: Page) {
  for (const [path, body] of [
    ["/api/v2/invitations/prepare", { invitationToken: "invalid.synthetic.token" }],
    ["/api/v2/invitations/complete", { enrollmentToken: "invalid-enrollment", password: invitee.password,
      totp: "000000" }]
  ] as const) {
    let blocked = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await sameOriginJson(page, path, "POST", body);
      if (response.status === 429) { blocked = true; break; }
      expect([400, 401]).toContain(response.status);
    }
    expect(blocked).toBe(true);
  }
}

async function sameOriginJson(page: Page, path: string, method: string, body?: unknown, csrfToken?: string) {
  return page.evaluate(async ({ path, method, body, csrfToken }) => {
    const response = await fetch(path, { method, credentials: "same-origin",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: Object.fromEntries(response.headers),
      body: response.status === 204 ? null : await response.json() as unknown };
  }, { path, method, body, csrfToken });
}

function waitForPost(page: Page, pathname: string) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === pathname &&
    response.request().method() === "POST");
}

function expectNoStore(response: Response) {
  expect(response.headers()["cache-control"]).toBe("no-store");
}

async function expectSecretsAbsent(page: Page, secrets: readonly string[], browserMessages: readonly string[]) {
  const snapshot = await page.evaluate(() => ({ url: location.href, local: { ...localStorage }, session: { ...sessionStorage } }));
  const exposed = `${JSON.stringify(snapshot)}\n${browserMessages.join("\n")}`;
  for (const secret of secrets.filter(Boolean)) expect(exposed).not.toContain(secret);
}

async function expectCriticalAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter(({ impact }) => impact === "critical")).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
