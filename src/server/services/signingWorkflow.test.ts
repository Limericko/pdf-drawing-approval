import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { SignaturePlacementRepository } from "../repositories/signaturePlacements.ts";
import { UserRepository } from "../repositories/users.ts";
import { tryGenerateSignedPdfForApproval } from "./signingWorkflow.ts";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

async function createPdf(filePath: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await fs.writeFile(filePath, await pdf.save());
}

async function setup() {
  const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-signing-"));
  const projectDir = path.join(watchRoot, "04-已通过待打印", "项目A");
  await fs.mkdir(projectDir, { recursive: true });
  const sourcePdfPath = path.join(projectDir, "签名件-a0A0.pdf");
  await createPdf(sourcePdfPath);

  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const settings = new SettingsRepository(db);
  const signatureAssets = new SignatureAssetRepository(db);
  const signaturePlacements = new SignaturePlacementRepository(db);
  const users = new UserRepository(db);
  settings.set("watch_root", watchRoot);
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const supervisor = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const process = users.create({ username: "process", password: "123456", role: "process", displayName: "工艺" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "签名件",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: sourcePdfPath,
    currentFilePath: sourcePdfPath,
    submittedByUserId: designer.id,
    source: "web_upload",
    signatureStatus: "pending"
  });
  signaturePlacements.upsertMany(approval.id, [
    { role: "designer", pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "supervisor", pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
    { role: "process", pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
  ]);

  return {
    approvals,
    operationLogs,
    settings,
    signatureAssets,
    signaturePlacements,
    users,
    approval,
    designer,
    supervisor,
    process,
    watchRoot
  };
}

async function addSignature(context: Awaited<ReturnType<typeof setup>>, userId: number, name: string) {
  const filePath = path.join(context.watchRoot, `${name}.png`);
  await fs.writeFile(filePath, pngBytes);
  return context.signatureAssets.createForUser({ userId, kind: "uploaded_png", filePath });
}

function deps(context: Awaited<ReturnType<typeof setup>>) {
  return {
    approvals: context.approvals,
    operationLogs: context.operationLogs,
    settings: context.settings,
    signatureAssets: context.signatureAssets,
    signaturePlacements: context.signaturePlacements,
    users: context.users
  };
}

describe("tryGenerateSignedPdfForApproval", () => {
  it("does nothing before both reviewers approve", async () => {
    const context = await setup();
    const afterSupervisor = context.approvals.review(context.approval.id, {
      role: "supervisor",
      decision: "approved",
      comment: "同意"
    });

    const result = await tryGenerateSignedPdfForApproval(afterSupervisor.id, deps(context));

    expect(result?.signatureStatus).toBe("pending");
    expect(result?.signedFilePath).toBeNull();
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).not.toContain(
      "signature.generated"
    );
  });

  it("generates a signed PDF after supervisor and process both approve", async () => {
    const context = await setup();
    await addSignature(context, context.designer.id, "designer");
    await addSignature(context, context.supervisor.id, "supervisor");
    await addSignature(context, context.process.id, "process");
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    const approved = context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });

    const result = await tryGenerateSignedPdfForApproval(approved.id, deps(context));

    expect(result?.signatureStatus).toBe("generated");
    expect(result?.signedFilePath).toContain("签名件-a0A0-签审.pdf");
    await expect(fs.readFile(result!.signedFilePath!, "utf8")).resolves.toContain("%PDF-");
    expect(result?.signedFileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "signature.generated"
    );
  });

  it("records a failed signature status when a required signature is missing", async () => {
    const context = await setup();
    await addSignature(context, context.designer.id, "designer");
    await addSignature(context, context.supervisor.id, "supervisor");
    context.approvals.review(context.approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    const approved = context.approvals.review(context.approval.id, { role: "process", decision: "approved", comment: "同意" });

    const result = await tryGenerateSignedPdfForApproval(approved.id, deps(context));

    expect(result?.signatureStatus).toBe("failed");
    expect(result?.signatureError).toContain("MISSING_PROCESS_SIGNATURE");
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action)).toContain(
      "signature.failed"
    );
  });
});
