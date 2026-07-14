import { describe, expect, it } from "vitest";
import {
  approvalListQuerySchema,
  issueResponseSchema,
  createDocumentDraftRequestSchema,
  reviewDecisionRequestSchema,
  signaturePlacementSchema,
  submitRevisionRequestSchema,
  taskResponseSchema
} from "./business.ts";

const ids = {
  project: "01890f1e-9b4a-7cc2-8f00-000000000201",
  object: "01890f1e-9b4a-7cc2-8f00-000000000202",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000000203",
  process: "01890f1e-9b4a-7cc2-8f00-000000000204"
} as const;

describe("Phase 4 shared business contracts", () => {
  it("normalizes bounded list queries and rejects unknown filters", () => {
    expect(approvalListQuerySchema.parse({ page: "2", pageSize: "40" })).toEqual({
      page: 2,
      pageSize: 40,
      sort: "created_desc"
    });
    expect(approvalListQuerySchema.safeParse({ page: "1", secret: "leak" }).success).toBe(false);
  });

  it("requires project-safe IDs and an idempotency key for document drafts", () => {
    expect(createDocumentDraftRequestSchema.parse({
      documentCode: " GX-240714-001 ",
      name: "减速器壳体",
      revisionCode: "A01",
      originalObjectId: ids.object,
      idempotencyKey: "draft:GX-240714-001:A01"
    })).toMatchObject({ documentCode: "GX-240714-001", source: "web_upload", materialCode: null });
    expect(createDocumentDraftRequestSchema.safeParse({
      documentCode: "GX-1",
      name: "壳体",
      revisionCode: "A01",
      originalObjectId: "legacy-12",
      idempotencyKey: "short"
    }).success).toBe(false);
  });

  it("requires all three bounded signature placements before submission", () => {
    const placement = { pageNumber: 1, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.1 };
    expect(submitRevisionRequestSchema.safeParse({
      version: 1,
      supervisorUserId: ids.supervisor,
      processUserId: ids.process,
      requiresSignature: true,
      placements: [
        { ...placement, signerRole: "designer" },
        { ...placement, signerRole: "supervisor" },
        { ...placement, signerRole: "process" }
      ],
      idempotencyKey: "submit:GX-240714-001:A01"
    }).success).toBe(true);
    expect(signaturePlacementSchema.safeParse({
      ...placement,
      signerRole: "designer",
      xRatio: 0.9,
      widthRatio: 0.2
    }).success).toBe(false);
  });

  it("requires rejection comments and keeps task targets same-origin relative", () => {
    expect(reviewDecisionRequestSchema.safeParse({
      decision: "rejected",
      comment: null,
      version: 1,
      idempotencyKey: "decision:reject:1"
    }).success).toBe(false);
    expect(taskResponseSchema.safeParse({
      id: "approval:1:supervisor",
      projectId: ids.project,
      kind: "approval_review",
      priority: "high",
      title: "待审核 · 减速器壳体",
      summary: "A01 · 主管审核",
      dueAt: null,
      createdAt: "2026-07-14T05:00:00.000Z",
      target: { route: "https://evil.example/approvals/1", resourceId: ids.object }
    }).success).toBe(false);
  });

  it("returns platform issue annotations with bounded geometry and resolution state", () => {
    const parsed = issueResponseSchema.parse({
      id: "01890f1e-9b4a-7cc2-8f00-000000001211", projectId: ids.project,
      approvalCaseId: "01890f1e-9b4a-7cc2-8f00-000000001212", annotationId: "01890f1e-9b4a-7cc2-8f00-000000001213",
      annotation: { id: "01890f1e-9b4a-7cc2-8f00-000000001213", projectId: ids.project,
        approvalCaseId: "01890f1e-9b4a-7cc2-8f00-000000001212", authorUserId: ids.supervisor,
        kind: "rect", pageNumber: 1, geometry: { xRatio: 0.1 }, style: {}, message: "检查",
        resolved: false, version: 1, createdAt: "2026-07-14T05:00:00.000Z", updatedAt: "2026-07-14T05:00:00.000Z" },
      creatorUserId: ids.supervisor, assigneeUserId: ids.supervisor, title: "检查", description: "检查",
      severity: "medium", status: "open", dueAt: null, version: 1,
      createdAt: "2026-07-14T05:00:00.000Z", updatedAt: "2026-07-14T05:00:00.000Z"
    });
    expect(parsed.annotation?.geometry).toEqual({ xRatio: 0.1 });
  });
});
