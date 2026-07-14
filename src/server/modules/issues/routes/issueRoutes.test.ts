import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { createIssueRoutes } from "./issueRoutes.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000001401", session: "01890f1e-9b4a-7cc2-8f00-000000001402",
  project: "01890f1e-9b4a-7cc2-8f00-000000001403", approval: "01890f1e-9b4a-7cc2-8f00-000000001404",
  issue: "01890f1e-9b4a-7cc2-8f00-000000001405", assignee: "01890f1e-9b4a-7cc2-8f00-000000001406"
} as const;
const publicBaseUrl = "https://approval.example.test";

describe("v2 issue routes", () => {
  it("parses approval-scoped filters and never trusts an actor from query input", async () => {
    const harness = createHarness();
    await request(harness.app).get(`/api/v2/projects/${ids.project}/issues?page=2&pageSize=40&approvalCaseId=${ids.approval}&severity=high&status=open`)
      .set("Cookie", "platform_session=valid-session").expect(200).expect("Cache-Control", "no-store");
    expect(harness.issues.listIssues).toHaveBeenCalledWith({ projectId: ids.project, actorUserId: ids.user,
      page: 2, pageSize: 40, approvalCaseId: ids.approval, severity: "high", status: "open" });
  });

  it("requires origin, session and CSRF before creating a formal issue", async () => {
    const harness = createHarness();
    const target = `/api/v2/projects/${ids.project}/approvals/${ids.approval}/issues`;
    await request(harness.app).post(target).send(issueBody()).expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await unsafe(request(harness.app).post(target)).send(issueBody())
      .expect(401).expect(problem("AUTHENTICATION_REQUIRED", 401));
    await unsafe(request(harness.app).post(target)).set("Cookie", "platform_session=valid-session")
      .set("X-CSRF-Token", "wrong").send(issueBody()).expect(403).expect(problem("CSRF_INVALID", 403));
    expect(harness.issues.createIssue).not.toHaveBeenCalled();
  });

  it("routes strict issue transitions with the request identity and optimistic version", async () => {
    const harness = createHarness();
    await authenticated(harness, request(harness.app)
      .post(`/api/v2/projects/${ids.project}/issues/${ids.issue}/review`))
      .set("X-Request-ID", "issue-review-route")
      .send({ decision: "returned", note: "请补充尺寸链说明", version: 3,
        idempotencyKey: "issue:review:route:1" }).expect(200);
    expect(harness.issues.reviewIssue).toHaveBeenCalledWith({ projectId: ids.project, issueId: ids.issue,
      actorUserId: ids.user, requestId: "issue-review-route", update: { decision: "returned",
        note: "请补充尺寸链说明", version: 3, idempotencyKey: "issue:review:route:1" } });
    await authenticated(harness, request(harness.app)
      .post(`/api/v2/projects/${ids.project}/issues/${ids.issue}/start`))
      .send({ version: 3, idempotencyKey: "issue:start:route:1", extra: true })
      .expect(400).expect(problem("REQUEST_BODY_INVALID", 400));
  });
});

function createHarness() {
  const csrf = createCsrfProtection({ keyring: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 14)]]) } });
  const issues = { createIssue: vi.fn().mockResolvedValue({ id: ids.issue }),
    listIssues: vi.fn().mockResolvedValue({ items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 } }),
    getIssue: vi.fn().mockResolvedValue({ id: ids.issue }), startIssue: vi.fn().mockResolvedValue({ id: ids.issue }),
    submitIssue: vi.fn().mockResolvedValue({ id: ids.issue }), reviewIssue: vi.fn().mockResolvedValue({ id: ids.issue }),
    forceCloseIssue: vi.fn().mockResolvedValue({ id: ids.issue }) };
  const sessions = { authenticate: vi.fn().mockResolvedValue({ user: { id: ids.user }, session: { id: ids.session } }) };
  const app = express(); app.use(requestContext()); app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/projects", createIssueRoutes({ issues: issues as never, sessions: sessions as never,
    publicBaseUrl, cookie: { name: "platform_session", secure: false }, csrf }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, issues, csrf };
}
function issueBody() { return { title: "尺寸链冲突", description: "装配间隙不满足要求", severity: "high",
  assigneeUserId: ids.assignee, dueAt: null, annotation: null, idempotencyKey: "issue:create:route:1" }; }
function authenticated(harness: ReturnType<typeof createHarness>, test: request.Test) { return unsafe(test)
  .set("Cookie", "platform_session=valid-session").set("X-CSRF-Token", harness.csrf.issue(ids.session)); }
function unsafe(test: request.Test) { return test.set("Origin", publicBaseUrl).set("Sec-Fetch-Site", "same-origin"); }
function problem(code: string, status: number) { return (response: request.Response) =>
  expect(response.body).toMatchObject({ type: "about:blank", code, status, requestId: expect.any(String) }); }
