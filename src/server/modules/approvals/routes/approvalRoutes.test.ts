import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { createApprovalRoutes } from "./approvalRoutes.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000401",
  project: "01890f1e-9b4a-7cc2-8f00-000000000402",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000403",
  approval: "01890f1e-9b4a-7cc2-8f00-000000000404",
  object: "01890f1e-9b4a-7cc2-8f00-000000000405",
  supervisor: "01890f1e-9b4a-7cc2-8f00-000000000406",
  process: "01890f1e-9b4a-7cc2-8f00-000000000407",
  session: "01890f1e-9b4a-7cc2-8f00-000000000408"
} as const;

const publicBaseUrl = "https://approval.example.test";

describe("v2 approval routes", () => {
  it("requires a session, exact origin and matching CSRF before draft service work", async () => {
    const harness = createHarness();
    const target = `/api/v2/projects/${ids.project}/documents/drafts`;
    await request(harness.app).post(target).send(draftBody()).expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await request(harness.app).post(target).set("Origin", "https://evil.example")
      .send(draftBody()).expect(403).expect(problem("ORIGIN_FORBIDDEN", 403));
    await unsafe(request(harness.app).post(target)).send(draftBody())
      .expect(401).expect(problem("AUTHENTICATION_REQUIRED", 401));
    await unsafe(request(harness.app).post(target)).set("Cookie", "platform_session=valid-session")
      .set("X-CSRF-Token", "wrong").send(draftBody()).expect(403).expect(problem("CSRF_INVALID", 403));
    expect(harness.approvals.createDraft).not.toHaveBeenCalled();
  });

  it("passes only parsed project, actor, request ID and strict draft input to the service", async () => {
    const harness = createHarness();
    const target = `/api/v2/projects/${ids.project}/documents/drafts`;
    const response = await authenticated(harness, request(harness.app).post(target))
      .set("X-Request-ID", "approval-draft-route-request")
      .send(draftBody()).expect(201).expect("Cache-Control", "no-store");
    expect(response.body).toEqual({ created: true });
    expect(harness.approvals.createDraft).toHaveBeenCalledWith({
      projectId: ids.project,
      actorUserId: ids.user,
      requestId: "approval-draft-route-request",
      draft: expect.objectContaining({ documentCode: "GX-240714-001", source: "web_upload" })
    });
    await authenticated(harness, request(harness.app).post(target))
      .send({ ...draftBody(), extra: true }).expect(400).expect(problem("REQUEST_BODY_INVALID", 400));
  });

  it("parses list paging and hides malformed resource identifiers before service calls", async () => {
    const harness = createHarness();
    const response = await request(harness.app)
      .get(`/api/v2/projects/${ids.project}/approvals?page=2&pageSize=40`)
      .set("Cookie", "platform_session=valid-session").expect(200);
    expect(response.body).toEqual({ items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 } });
    expect(harness.approvals.listApprovals).toHaveBeenCalledWith({
      projectId: ids.project, actorUserId: ids.user, page: 2, pageSize: 40
    });
    await request(harness.app).get("/api/v2/projects/not-a-uuid/approvals")
      .set("Cookie", "platform_session=valid-session")
      .expect(400).expect(problem("APPROVAL_INPUT_INVALID", 400));
  });

  it("routes strict parallel decisions with the authenticated reviewer identity", async () => {
    const harness = createHarness();
    const target = `/api/v2/projects/${ids.project}/approvals/${ids.approval}/decisions/supervisor`;
    await authenticated(harness, request(harness.app).post(target)).send({
      decision: "approved",
      comment: "审核通过",
      version: 1,
      idempotencyKey: "decision:supervisor:route"
    }).expect(200);
    expect(harness.approvals.decide).toHaveBeenCalledWith(expect.objectContaining({
      projectId: ids.project,
      approvalId: ids.approval,
      reviewerRole: "supervisor",
      actorUserId: ids.user
    }));
    await authenticated(harness, request(harness.app).post(target.replace("supervisor", "designer")))
      .send({ decision: "approved", comment: "审核通过", version: 1,
        idempotencyKey: "decision:designer:route" })
      .expect(400).expect(problem("APPROVAL_INPUT_INVALID", 400));
  });
});

function createHarness() {
  const csrf = createCsrfProtection({ keyring: {
    currentVersion: "v1",
    keys: new Map([["v1", Buffer.alloc(32, 4)]])
  } });
  const approvals = {
    createDraft: vi.fn().mockResolvedValue({ created: true }),
    submitRevision: vi.fn().mockResolvedValue({ submitted: true }),
    decide: vi.fn().mockResolvedValue({ decided: true }),
    getApproval: vi.fn().mockResolvedValue({ id: ids.approval }),
    listApprovals: vi.fn().mockResolvedValue({ items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 } })
  };
  const sessions = {
    authenticate: vi.fn().mockResolvedValue({
      user: { id: ids.user },
      session: { id: ids.session }
    })
  };
  const app = express();
  app.use(requestContext());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/projects", createApprovalRoutes({
    approvals: approvals as never,
    sessions: sessions as never,
    publicBaseUrl,
    cookie: { name: "platform_session", secure: false },
    csrf
  }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, approvals, csrf };
}

function draftBody() {
  return {
    documentCode: "GX-240714-001",
    name: "减速器壳体",
    revisionCode: "A01",
    originalObjectId: ids.object,
    source: "web_upload",
    materialCode: "QT450-10",
    idempotencyKey: "draft:GX-240714-001:A01"
  };
}

function authenticated(harness: ReturnType<typeof createHarness>, test: request.Test) {
  return unsafe(test).set("Cookie", "platform_session=valid-session")
    .set("X-CSRF-Token", harness.csrf.issue(ids.session));
}

function unsafe(test: request.Test) {
  return test.set("Origin", publicBaseUrl).set("Sec-Fetch-Site", "same-origin");
}

function problem(code: string, status: number) {
  return (response: request.Response) => {
    expect(response.type).toBe("application/problem+json");
    expect(response.body).toMatchObject({ type: "about:blank", code, status,
      requestId: expect.any(String), title: expect.any(String) });
  };
}
