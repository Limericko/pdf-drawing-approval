import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.ts";
import { platformE2EBusinessUsers } from "./support/seed.ts";
import { currentTotpFromHex } from "./support/totp.ts";

test.setTimeout(240_000);

test("图纸提交、正式问题、并行双审、签章、PDM 与打印归档形成真实闭环", async ({ browser, platform }) => {
  const designer = await rolePage(browser, platform.webUrl, platformE2EBusinessUsers.designer);
  const supervisor = await rolePage(browser, platform.webUrl, platformE2EBusinessUsers.supervisor);
  const process = await rolePage(browser, platform.webUrl, platformE2EBusinessUsers.process);
  try {
    await Promise.all([uploadSignature(designer), uploadSignature(supervisor), uploadSignature(process)]);

    await designer.getByRole("link", { name: "图纸中心" }).click();
    await expect(designer.getByRole("heading", { name: "图纸中心" })).toBeVisible();
    await designer.getByLabel("图号").fill(`E2E-${platform.runId.slice(0, 8)}`);
    await designer.getByLabel("图纸名称").fill("精密减速器壳体");
    await designer.getByLabel("版本").fill("A01");
    await designer.getByLabel("材料牌号").fill("QT450-10");
    await designer.getByLabel("PDF 文件").setInputFiles({ name: "precision-drawing.pdf",
      mimeType: "application/pdf", buffer: await drawingPdf() });
    await designer.getByRole("button", { name: "上传并创建草稿" }).click();
    await expect(designer.getByRole("heading", { name: "提交审核" })).toBeVisible();
    await expect(designer.getByLabel("主管审阅人")).not.toHaveValue("");
    await expect(designer.getByLabel("工艺复核人")).not.toHaveValue("");
    const submittedResponse = designer.waitForResponse((response) =>
      response.request().method() === "POST" && /\/revisions\/[0-9a-f-]+\/submit$/.test(new URL(response.url()).pathname));
    await designer.getByRole("button", { name: "提交审核" }).click();
    const submitted = await (await submittedResponse).json() as { readonly id: string };
    await expect(designer.getByText("图纸已提交，主管与工艺将并行审核。")).toBeVisible();

    const access = await json(supervisor, `/api/v2/projects/${platform.seed.businessProjectId}/access`, "GET");
    const designerUserId = (access.body as { members: Array<{ role: string; userId: string }> }).members
      .find(({ role }) => role === "designer")!.userId;
    const session = await json(supervisor, "/api/v2/session", "GET");
    const csrf = (session.body as { csrfToken: string }).csrfToken;
    const createdIssue = await json(supervisor,
      `/api/v2/projects/${platform.seed.businessProjectId}/approvals/${submitted.id}/issues`, "POST", {
        title: "关键配合尺寸需复核", description: "轴承孔与端面尺寸链可能干涉，请补充说明。", severity: "high",
        assigneeUserId: designerUserId, dueAt: null, annotation: null,
        idempotencyKey: `e2e:issue:${platform.runId}`
      }, csrf);
    expect(createdIssue.status).toBe(201);
    const issueId = (createdIssue.body as { id: string }).id;

    await supervisor.goto(`${platform.webUrl}/#/workspace/approvals/${submitted.id}`);
    await expect(supervisor.getByText("审批被问题阻断")).toBeVisible();
    await expect(supervisor.getByRole("button", { name: "通过" })).toBeDisabled();

    await designer.goto(`${platform.webUrl}/#/workspace/issues/${issueId}`);
    await expect(designer.getByRole("heading", { name: "问题处理" })).toBeVisible();
    await designer.getByRole("button", { name: "开始处理" }).click();
    await expect(designer.getByRole("button", { name: "提交复核" })).toBeVisible();
    await designer.getByLabel("解决说明").fill("已核算尺寸链并补充公差说明，确认无干涉。");
    await designer.getByRole("button", { name: "提交复核" }).click();
    await expect(designer.getByRole("button", { name: "提交复核" })).toBeHidden();

    await supervisor.goto(`${platform.webUrl}/#/workspace/issues/${issueId}`);
    await expect(supervisor.getByRole("button", { name: "复核通过" })).toBeVisible();
    await supervisor.getByLabel("处理意见").fill("尺寸链说明完整，问题关闭。");
    await supervisor.getByRole("button", { name: "复核通过" }).click();
    await expect(supervisor.getByText("已关闭")).toBeVisible();

    await approve(supervisor, platform.webUrl, submitted.id, "主管审核通过");
    await approve(process, platform.webUrl, submitted.id, "工艺审核通过");

    const approval = await pollJson(designer,
      `/api/v2/projects/${platform.seed.businessProjectId}/approvals/${submitted.id}`,
      (body) => Boolean((body as { artifacts?: Array<{ kind: string; status: string; objectId: string | null }> }).artifacts
        ?.some((artifact) => artifact.kind === "signed_pdf" && artifact.status === "ready" && artifact.objectId)));
    const signedObjectId = (approval as { artifacts: Array<{ kind: string; status: string; objectId: string | null }> }).artifacts
      .find((artifact) => artifact.kind === "signed_pdf" && artifact.status === "ready")!.objectId!;
    const parts = await pollJson(designer,
      `/api/v2/projects/${platform.seed.businessProjectId}/pdm/parts?page=1&pageSize=20&sort=updated_desc`,
      (body) => (body as { items?: Array<{ releaseStatus: string }> }).items?.some(({ releaseStatus }) => releaseStatus === "published") === true);
    expect((parts as { items: Array<{ releaseStatus: string }> }).items[0]?.releaseStatus).toBe("published");

    const designerSession = await json(designer, "/api/v2/session", "GET");
    const archived = await json(designer,
      `/api/v2/projects/${platform.seed.businessProjectId}/approvals/${submitted.id}/print-archive`, "POST", {
        objectId: signedObjectId, printerName: "E2E 虚拟打印机", status: "archived", errorCode: null,
        idempotencyKey: `e2e:print:${platform.runId}`
      }, (designerSession.body as { csrfToken: string }).csrfToken);
    expect(archived.status).toBe(201);
    await designer.goto(`${platform.webUrl}/#/workspace/approvals/${submitted.id}`);
    await expect(designer.getByText("E2E 虚拟打印机")).toBeVisible();
    await expect(designer.getByText("在 Windows 桌面客户端中打开后可打印并自动归档。")).toBeVisible();
  } finally {
    await Promise.allSettled([designer.context().close(), supervisor.context().close(), process.context().close()]);
  }
});

async function rolePage(browser: Browser, webUrl: string,
  account: { email: string; password: string; secret: Buffer }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN",
    timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  await page.goto(webUrl);
  await page.getByLabel("邮箱地址").fill(account.email);
  await page.getByLabel("密码").fill(account.password);
  await page.getByRole("button", { name: "继续验证" }).click();
  await page.getByLabel("6 位动态验证码").fill(currentTotpFromHex(account.secret.toString("hex")));
  await page.getByRole("button", { name: "确认并登录" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  return page;
}

async function uploadSignature(page: Page) {
  await page.getByRole("link", { name: "我的签名" }).click();
  await page.getByLabel("PNG 签名图片").setInputFiles({ name: "signature.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw1hAAAAAElFTkSuQmCC", "base64") });
  await page.getByRole("button", { name: "保存为当前签名" }).click();
  await expect(page.getByText("签名已更新，后续签章将使用新版本。")).toBeVisible();
}

async function approve(page: Page, webUrl: string, approvalId: string, comment: string) {
  await page.goto(`${webUrl}/#/workspace/approvals/${approvalId}`);
  await expect(page.getByRole("heading", { name: "图纸审阅" })).toBeVisible();
  await page.getByLabel("审核意见").fill(comment);
  const response = page.waitForResponse((candidate) => candidate.request().method() === "POST" &&
    /\/decisions\/(supervisor|process)$/.test(new URL(candidate.url()).pathname));
  await page.getByRole("button", { name: "通过" }).click();
  expect((await response).status()).toBe(200);
}

async function drawingPdf() {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([842, 595]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("PHASE 4 PRECISION DRAWING E2E", { x: 48, y: 535, size: 18, font });
  page.drawRectangle({ x: 48, y: 80, width: 746, height: 420, borderWidth: 1 });
  return Buffer.from(await pdf.save());
}

async function pollJson(page: Page, path: string, accepted: (body: unknown) => boolean) {
  const deadline = Date.now() + 45_000; let last: unknown;
  do { const response = await json(page, path, "GET"); last = response.body; if (response.status === 200 && accepted(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500)); } while (Date.now() < deadline);
  throw new Error(`E2E_POLL_TIMEOUT:${JSON.stringify(last)}`);
}

async function json(page: Page, path: string, method: string, body?: unknown, csrfToken?: string) {
  return page.evaluate(async ({ path, method, body, csrfToken }) => {
    const response = await fetch(path, { method, credentials: "same-origin",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as unknown };
  }, { path, method, body, csrfToken });
}
