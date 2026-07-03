import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { PdmPartRepository } from "./pdmParts.ts";

function createRepo() {
  const db = createDatabase(":memory:");
  return { db, repository: new PdmPartRepository(db) };
}

function publishInput(overrides: Partial<Parameters<PdmPartRepository["publishRevision"]>[0]> = {}) {
  return {
    partId: 1,
    materialCode: "0102A00700883",
    documentCode: "MP300A000072",
    drawingName: "400A按键",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    approvalId: 10,
    originalFilePath: "02-审批中/项目A/MP300A000072 《0102A00700883 400A按键》 a0A0.pdf",
    originalFileHash: "original-hash-a0A0",
    signedFilePath: "04-已通过待打印/项目A/MP300A000072 《0102A00700883 400A按键》 a0A0-签审.pdf",
    signedFileHash: "signed-hash-a0A0",
    annotatedFilePath: null,
    ...overrides
  };
}

describe("PdmPartRepository", () => {
  it("creates and finds a part by globally unique material code", () => {
    const { repository } = createRepo();

    const created = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });

    expect(created.materialCode).toBe("0102A00700883");
    expect(created.name).toBe("400A按键");
    expect(created.currentRevisionId).toBeNull();
    expect(repository.findPartByMaterialCode("0102A00700883")?.id).toBe(created.id);
  });

  it("publishes a unique material-version revision and makes it current", () => {
    const { repository } = createRepo();
    const part = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });

    const revision = repository.publishRevision(publishInput({ partId: part.id }));

    expect(revision.materialCode).toBe("0102A00700883");
    expect(revision.version).toBe("a0A0");
    expect(revision.releaseStatus).toBe("released");
    expect(repository.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBe(revision.id);
    expect(repository.listRevisions(part.id).map((item) => item.version)).toEqual(["a0A0"]);
  });

  it("supersedes the previous current revision when a newer version is published", () => {
    const { repository } = createRepo();
    const part = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });
    const first = repository.publishRevision(publishInput({ partId: part.id, approvalId: 10, version: "a0A0" }));

    const second = repository.publishRevision(
      publishInput({
        partId: part.id,
        approvalId: 11,
        documentCode: "MP300A000073",
        version: "a1A0",
        minorVersion: "a1",
        originalFileHash: "original-hash-a1A0",
        signedFileHash: "signed-hash-a1A0"
      })
    );

    expect(repository.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBe(second.id);
    expect(repository.listRevisions(part.id).map((item) => [item.id, item.version, item.releaseStatus])).toEqual([
      [second.id, "a1A0", "released"],
      [first.id, "a0A0", "superseded"]
    ]);
  });

  it("voids a current revision and restores the latest non-voided history as current", () => {
    const { repository } = createRepo();
    const part = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });
    const first = repository.publishRevision(publishInput({ partId: part.id, approvalId: 10, version: "a0A0" }));
    const second = repository.publishRevision(
      publishInput({
        partId: part.id,
        approvalId: 11,
        version: "a1A0",
        minorVersion: "a1",
        originalFileHash: "original-hash-a1A0",
        signedFileHash: "signed-hash-a1A0"
      })
    );

    const result = repository.voidRevision(second.id);

    expect(result.voided).toEqual(expect.objectContaining({ id: second.id, releaseStatus: "voided" }));
    expect(result.currentRevision).toEqual(expect.objectContaining({ id: first.id, releaseStatus: "released" }));
    expect(repository.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBe(first.id);
    expect(repository.listRevisions(part.id).map((item) => [item.id, item.releaseStatus])).toEqual([
      [second.id, "voided"],
      [first.id, "released"]
    ]);
  });

  it("clears the current revision when the last non-voided revision is voided", () => {
    const { repository } = createRepo();
    const part = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });
    const revision = repository.publishRevision(publishInput({ partId: part.id, approvalId: 10, version: "a0A0" }));

    const result = repository.voidRevision(revision.id);

    expect(result.currentRevision).toBeNull();
    expect(repository.findPartByMaterialCode("0102A00700883")?.currentRevisionId).toBeNull();
    expect(repository.getRevisionById(revision.id)?.releaseStatus).toBe("voided");
  });

  it("rejects duplicate revisions for the same material code and version", () => {
    const { repository } = createRepo();
    const part = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });
    repository.publishRevision(publishInput({ partId: part.id, approvalId: 10, version: "a0A0" }));

    expect(() => repository.publishRevision(publishInput({ partId: part.id, approvalId: 11, version: "a0A0" }))).toThrow(
      "PDM_REVISION_EXISTS"
    );
    expect(repository.listRevisions(part.id)).toHaveLength(1);
  });

  it("records project usage once for the same shared material code", () => {
    const { repository } = createRepo();
    const part = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });

    const first = repository.recordUsage({ materialCode: "0102A00700883", projectName: "项目A", approvalId: 10 });
    const second = repository.recordUsage({ materialCode: "0102A00700883", projectName: "项目A", approvalId: 11 });
    repository.recordUsage({ materialCode: "0102A00700883", projectName: "项目B", approvalId: 12 });

    expect(second.id).toBe(first.id);
    expect(second.lastApprovalId).toBe(11);
    expect(repository.listUsages(part.id).map((item) => [item.projectName, item.firstApprovalId, item.lastApprovalId])).toEqual([
      ["项目A", 10, 11],
      ["项目B", 12, 12]
    ]);
  });

  it("returns filtered ledger stats for total parts, released current revisions, and common parts", () => {
    const { repository } = createRepo();
    const button = repository.createOrUpdatePart({
      materialCode: "0102A00700883",
      name: "400A按键",
      createdFromApprovalId: 10
    });
    const cover = repository.createOrUpdatePart({
      materialCode: "0102A00700999",
      name: "端盖",
      createdFromApprovalId: 11
    });
    repository.publishRevision(publishInput({ partId: button.id, materialCode: button.materialCode, approvalId: 10 }));
    repository.recordUsage({ materialCode: button.materialCode, projectName: "项目A", approvalId: 10 });
    repository.recordUsage({ materialCode: button.materialCode, projectName: "项目B", approvalId: 12 });
    repository.recordUsage({ materialCode: cover.materialCode, projectName: "项目B", approvalId: 11 });

    expect(repository.listParts().stats).toEqual({
      totalParts: 2,
      currentRevisionCount: 1,
      commonPartCount: 1
    });
    expect(repository.listParts({ projectName: "项目A" }).stats).toEqual({
      totalParts: 1,
      currentRevisionCount: 1,
      commonPartCount: 1
    });
  });

  it("lists approval records that still need PDM metadata repair", () => {
    const { db, repository } = createRepo();
    db.prepare(
      `INSERT INTO approvals (
        project_name, part_name, version, minor_version, major_version,
        original_file_path, current_file_path, status, submitted_by_user_id,
        document_code, material_code, drawing_name, pdm_metadata_status, pdm_publish_status
      ) VALUES (
        @projectName, @partName, @version, @minorVersion, @majorVersion,
        @originalFilePath, @currentFilePath, @status, @submittedByUserId,
        @documentCode, @materialCode, @drawingName, @metadataStatus, @publishStatus
      )`
    ).run({
      projectName: "项目A",
      partName: "400A按键",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      originalFilePath: "01-待提交/项目A/400A按键-a0A0.pdf",
      currentFilePath: "02-审批中/项目A/400A按键-a0A0.pdf",
      status: "approved_for_print",
      submittedByUserId: 4,
      documentCode: null,
      materialCode: null,
      drawingName: "400A按键",
      metadataStatus: "missing_material_code",
      publishStatus: "metadata_pending"
    });
    db.prepare(
      `INSERT INTO approvals (
        project_name, part_name, version, minor_version, major_version,
        original_file_path, current_file_path, status, submitted_by_user_id,
        document_code, material_code, drawing_name, pdm_metadata_status, pdm_publish_status
      ) VALUES (
        '项目B', '端盖', 'a0A0', 'a0', 'A0',
        '01-待提交/项目B/端盖-a0A0.pdf', '02-审批中/项目B/端盖-a0A0.pdf',
        'approved_for_print', 5, 'MP300A000080', '0102A00700999', '端盖', 'complete', 'published'
      )`
    ).run();

    expect(repository.listPendingMetadata({ submittedByUserId: 4 })).toMatchObject([
      {
        projectName: "项目A",
        drawingName: "400A按键",
        materialCode: null,
        metadataStatus: "missing_material_code",
        publishStatus: "metadata_pending"
      }
    ]);
    expect(repository.listPendingMetadata({ submittedByUserId: 5 })).toEqual([]);
  });
});
