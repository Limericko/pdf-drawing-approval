import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { createAdministrationRoutes } from "./administrationRoutes.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000001101",
  session: "01890f1e-9b4a-7cc2-8f00-000000001102",
  target: "01890f1e-9b4a-7cc2-8f00-000000001103",
  job: "01890f1e-9b4a-7cc2-8f00-000000001104"
} as const;
const publicBaseUrl = "https://approval.example.test";

describe("v2 administration routes", () => {
  it("parses bounded user and audit queries with the authenticated administrator", async () => {
    const harness = createHarness();
    await request(harness.app).get("/api/v2/administration/users?page=2&pageSize=40&status=disabled&keyword=工艺")
      .set("Cookie", "platform_session=valid-session").expect(200).expect("Cache-Control", "no-store");
    expect(harness.administration.listUsers).toHaveBeenCalledWith({ actorUserId: ids.user,
      page: 2, pageSize: 40, status: "disabled", keyword: "工艺" });
    await request(harness.app).get("/api/v2/administration/audit?pageSize=1000")
      .set("Cookie", "platform_session=valid-session").expect(400).expect(problem("ADMIN_INPUT_INVALID", 400));
  });

  it("requires exact origin, session and CSRF before retrying a dead job", async () => {
    const harness = createHarness();
    const target = `/api/v2/administration/jobs/${ids.job}/retry`;
    const body = { reason: "依赖服务已恢复", idempotencyKey: "admin:job:route:1" };
    await request(harness.app).post(target).send(body).expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await unsafe(request(harness.app).post(target)).send(body)
      .expect(401).expect(problem("AUTHENTICATION_REQUIRED", 401));
    await unsafe(request(harness.app).post(target)).set("Cookie", "platform_session=valid-session")
      .set("X-CSRF-Token", "wrong").send(body).expect(403).expect(problem("CSRF_INVALID", 403));
    expect(harness.administration.retryDeadJob).not.toHaveBeenCalled();
  });

  it("routes strict audited retry and user security mutations", async () => {
    const harness = createHarness();
    await authenticated(harness, request(harness.app).post(`/api/v2/administration/jobs/${ids.job}/retry`))
      .set("X-Request-ID", "admin-job-route")
      .send({ reason: "依赖服务已恢复", idempotencyKey: "admin:job:route:2" }).expect(200);
    expect(harness.administration.retryDeadJob).toHaveBeenCalledWith({ actorUserId: ids.user, jobId: ids.job,
      requestId: "admin-job-route", update: { reason: "依赖服务已恢复", idempotencyKey: "admin:job:route:2" } });

    await authenticated(harness, request(harness.app).post(`/api/v2/administration/users/${ids.target}/sessions/revoke`))
      .send({ reason: "账号交接", idempotencyKey: "admin:sessions:route:1", extra: true })
      .expect(400).expect(problem("REQUEST_BODY_INVALID", 400));
    expect(harness.administration.revokeUserSessions).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const csrf = createCsrfProtection({ keyring: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 11)]]) } });
  const page = { page: 2, pageSize: 40, total: 0, pageCount: 0 };
  const administration = {
    listUsers: vi.fn().mockResolvedValue({ items: [], page }),
    setUserStatus: vi.fn().mockResolvedValue({ targetId: ids.target, changed: true }),
    updateMembership: vi.fn().mockResolvedValue({ targetId: ids.target, changed: true }),
    revokeUserSessions: vi.fn().mockResolvedValue({ targetId: ids.target, changed: true }),
    retryDeadJob: vi.fn().mockResolvedValue({ targetId: ids.job, changed: true }),
    getDiagnostics: vi.fn().mockResolvedValue({}),
    listBackups: vi.fn().mockResolvedValue({ items: [] }),
    listAudit: vi.fn().mockResolvedValue({ items: [], page })
  };
  const sessions = { authenticate: vi.fn().mockResolvedValue({ user: { id: ids.user }, session: { id: ids.session } }) };
  const app = express();
  app.use(requestContext());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/administration", createAdministrationRoutes({ administration: administration as never,
    sessions: sessions as never, publicBaseUrl, cookie: { name: "platform_session", secure: false }, csrf }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, administration, csrf };
}

function authenticated(harness: ReturnType<typeof createHarness>, test: request.Test) {
  return unsafe(test).set("Cookie", "platform_session=valid-session")
    .set("X-CSRF-Token", harness.csrf.issue(ids.session));
}
function unsafe(test: request.Test) { return test.set("Origin", publicBaseUrl).set("Sec-Fetch-Site", "same-origin"); }
function problem(code: string, status: number) {
  return (response: request.Response) => expect(response.body).toMatchObject({ type: "about:blank", code, status,
    requestId: expect.any(String), title: expect.any(String) });
}
