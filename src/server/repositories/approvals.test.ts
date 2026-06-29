import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "./approvals.ts";

function repo() {
  return new ApprovalRepository(createDatabase(":memory:"));
}

function createSample(repository: ApprovalRepository) {
  return repository.create({
    projectName: "项目A",
    partName: "轴承座",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "01-待提交/项目A/轴承座-a0A0.pdf",
    currentFilePath: "02-审批中/项目A/轴承座-a0A0.pdf"
  });
}

describe("ApprovalRepository", () => {
  it("creates and queries approvals by status", () => {
    const repository = repo();
    createSample(repository);

    expect(repository.list({ status: "pending" })).toHaveLength(1);
    expect(repository.list({ status: "rejected" })).toHaveLength(0);
  });

  it("lists approvals by page with keyword and total count", () => {
    const repository = repo();
    createSample(repository);
    repository.create({
      projectName: "项目B",
      partName: "端盖",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目B/端盖-a1A0.pdf",
      currentFilePath: "02-审批中/项目B/端盖-a1A0.pdf"
    });
    repository.create({
      projectName: "项目C",
      partName: "支架",
      version: "a2A0",
      minorVersion: "a2",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目C/支架-a2A0.pdf",
      currentFilePath: "02-审批中/项目C/支架-a2A0.pdf"
    });

    const page = repository.listPaged({ keyword: "项目", page: 2, pageSize: 2 });

    expect(page.total).toBe(3);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(2);
    expect(page.items).toHaveLength(1);

    const keyword = repository.listPaged({ keyword: "端盖", page: 1, pageSize: 20 });
    expect(keyword.total).toBe(1);
    expect(keyword.items[0].partName).toBe("端盖");
  });

  it("stores v3 submission and signature metadata", () => {
    const repository = repo();

    const approval = repository.create({
      projectName: "项目A",
      partName: "签名件",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "02-审批中/项目A/签名件-a0A0.pdf",
      currentFilePath: "02-审批中/项目A/签名件-a0A0.pdf",
      submittedBy: "designer",
      submittedByUserId: 4,
      source: "web_upload",
      originalFileHash: "original-hash",
      signatureStatus: "pending"
    });

    expect(approval.submittedByUserId).toBe(4);
    expect(approval.source).toBe("web_upload");
    expect(approval.originalFileHash).toBe("original-hash");
    expect(approval.signatureStatus).toBe("pending");
    expect(approval.signedFilePath).toBeNull();
    expect(approval.signatureError).toBeNull();

    const failed = repository.setSignatureStatus(approval.id, "failed", "缺少主管签名");
    expect(failed.signatureStatus).toBe("failed");
    expect(failed.signatureError).toBe("缺少主管签名");

    const signed = repository.setSignedFile(approval.id, "04-已通过待打印/项目A/签名件-a0A0-签审.pdf", "signed-hash");
    expect(signed.signatureStatus).toBe("generated");
    expect(signed.signedFilePath).toBe("04-已通过待打印/项目A/签名件-a0A0-签审.pdf");
    expect(signed.signedFileHash).toBe("signed-hash");
    expect(signed.signedAt).toBeTruthy();
    expect(signed.signatureError).toBeNull();
  });

  it("defaults legacy approval records to folder watch and not required signing", () => {
    const repository = repo();

    const approval = createSample(repository);

    expect(approval.submittedByUserId).toBeNull();
    expect(approval.source).toBe("folder_watch");
    expect(approval.originalFileHash).toBeNull();
    expect(approval.signatureStatus).toBe("not_required");
    expect(approval.signedFilePath).toBeNull();
    expect(approval.signedFileHash).toBeNull();
    expect(approval.signedAt).toBeNull();
    expect(approval.signatureError).toBeNull();
  });

  it("stores invalid PDF and voided approvals without adding them to reviewer queues", () => {
    const repository = repo();
    repository.create({
      projectName: "项目A",
      partName: "坏PDF",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/坏PDF-a0A0.pdf",
      currentFilePath: "01-待提交/项目A/坏PDF-a0A0.pdf",
      status: "invalid_pdf" as never
    });
    repository.create({
      projectName: "项目A",
      partName: "作废件",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/作废件-a0A0.pdf",
      currentFilePath: "02-审批中/项目A/作废件-a0A0.pdf",
      status: "voided" as never
    });
    createSample(repository);

    expect(repository.list({ status: "invalid_pdf" as never })).toHaveLength(1);
    expect(repository.list({ status: "voided" as never })).toHaveLength(1);
    expect(repository.list({ reviewerRole: "supervisor" }).map((item) => item.status)).toEqual(["pending"]);
    expect(repository.list({ reviewerRole: "process" }).map((item) => item.status)).toEqual(["pending"]);
  });

  it("lists historical versions by project and part", () => {
    const repository = repo();
    createSample(repository);
    repository.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/轴承座-a1A0.pdf",
      currentFilePath: "02-审批中/项目A/轴承座-a1A0.pdf"
    });

    expect(repository.listHistory("项目A", "轴承座").map((item) => item.version)).toEqual(["a1A0", "a0A0"]);
  });

  it("lists related versions by project and part while excluding the current approval", () => {
    const db = createDatabase(":memory:");
    const repository = new ApprovalRepository(db);
    const current = repository.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/轴承座-a0A0.pdf",
      currentFilePath: "02-审批中/项目A/轴承座-a0A0.pdf"
    });
    const older = repository.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a1A0",
      minorVersion: "a1",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/轴承座-a1A0.pdf",
      currentFilePath: "02-审批中/项目A/轴承座-a1A0.pdf"
    });
    const newer = repository.create({
      projectName: "项目A",
      partName: "轴承座",
      version: "a2A0",
      minorVersion: "a2",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/轴承座-a2A0.pdf",
      currentFilePath: "02-审批中/项目A/轴承座-a2A0.pdf"
    });
    repository.create({
      projectName: "项目B",
      partName: "轴承座",
      version: "a3A0",
      minorVersion: "a3",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目B/轴承座-a3A0.pdf",
      currentFilePath: "02-审批中/项目B/轴承座-a3A0.pdf"
    });
    repository.create({
      projectName: "项目A",
      partName: "端盖",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/端盖-a0A0.pdf",
      currentFilePath: "02-审批中/项目A/端盖-a0A0.pdf"
    });
    db.prepare("UPDATE approvals SET submitted_at = ? WHERE id = ?").run("2026-06-17T09:00:00.000Z", older.id);
    db.prepare("UPDATE approvals SET submitted_at = ? WHERE id = ?").run("2026-06-17T11:00:00.000Z", newer.id);

    expect(repository.listVersions("项目A", "轴承座", current.id).map((item) => item.version)).toEqual(["a2A0", "a1A0"]);
  });

  it("requires both reviewers to approve before printable", () => {
    const repository = repo();
    const approval = createSample(repository);

    const afterSupervisor = repository.review(approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    expect(afterSupervisor.status).toBe("pending");

    const afterProcess = repository.review(approval.id, { role: "process", decision: "approved", comment: "同意" });
    expect(afterProcess.status).toBe("approved_for_print");
  });

  it("rejects reviews after the approval leaves the pending state", () => {
    const repository = repo();
    const approval = createSample(repository);

    repository.review(approval.id, { role: "supervisor", decision: "approved", comment: "同意" });
    const approved = repository.review(approval.id, { role: "process", decision: "approved", comment: "同意" });

    expect(approved.status).toBe("approved_for_print");
    expect(() => repository.review(approval.id, { role: "supervisor", decision: "rejected", comment: "重新驳回" })).toThrow(
      "APPROVAL_NOT_REVIEWABLE"
    );
    expect(repository.getById(approval.id)?.status).toBe("approved_for_print");
  });

  it("rejects when either reviewer rejects and requires a comment", () => {
    const repository = repo();
    const approval = createSample(repository);

    expect(() => repository.review(approval.id, { role: "process", decision: "rejected" })).toThrow("REJECT_COMMENT_REQUIRED");

    const rejected = repository.review(approval.id, { role: "process", decision: "rejected", comment: "孔距需调整" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.processComment).toBe("孔距需调整");
  });
});
