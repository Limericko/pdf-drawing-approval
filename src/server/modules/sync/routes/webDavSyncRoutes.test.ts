import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { createWebDavSyncRoutes } from "./webDavSyncRoutes.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000002101",
  session: "01890f1e-9b4a-7cc2-8f00-000000002102",
  project: "01890f1e-9b4a-7cc2-8f00-000000002103",
  mapping: "01890f1e-9b4a-7cc2-8f00-000000002104",
  item: "01890f1e-9b4a-7cc2-8f00-000000002105",
  conflict: "01890f1e-9b4a-7cc2-8f00-000000002106"
} as const;
const publicBaseUrl = "https://approval.example.test";

describe("v2 WebDAV sync routes", () => {
  it("parses authenticated summary, item and conflict queries", async () => {
    const harness = createHarness();
    await authedGet(harness, "/api/v2/webdav-sync/summary").expect(200).expect("Cache-Control", "no-store");
    expect(harness.webDavSync.getSummary).toHaveBeenCalledWith({ actorUserId: ids.user });

    await authedGet(harness,
      `/api/v2/webdav-sync/items?page=2&pageSize=40&projectId=${ids.project}&mappingId=${ids.mapping}&status=failed`)
      .expect(200);
    expect(harness.webDavSync.listSyncItems).toHaveBeenCalledWith({ actorUserId: ids.user, page: 2, pageSize: 40,
      projectId: ids.project, mappingId: ids.mapping, status: "failed" });

    await authedGet(harness, "/api/v2/webdav-sync/conflicts?pageSize=101")
      .expect(400).expect(problem("WEBDAV_SYNC_INPUT_INVALID", 400));
  });

  it("requires exact origin, session and CSRF for a manual retry", async () => {
    const harness = createHarness();
    const target = `/api/v2/webdav-sync/items/${ids.item}/retry`;
    const body = { reason: "远端恢复", idempotencyKey: "webdav:retry:route:1" };
    await request(harness.app).post(target).send(body).expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await unsafe(request(harness.app).post(target)).send(body)
      .expect(401).expect(problem("AUTHENTICATION_REQUIRED", 401));
    await unsafe(request(harness.app).post(target)).set("Cookie", "platform_session=valid-session")
      .set("X-CSRF-Token", "wrong").send(body).expect(403).expect(problem("CSRF_INVALID", 403));
    expect(harness.webDavSync.retrySyncItem).not.toHaveBeenCalled();
  });

  it("routes strict audited scan and conflict decisions", async () => {
    const harness = createHarness();
    await authenticated(harness, request(harness.app).post("/api/v2/webdav-sync/scans"))
      .set("X-Request-ID", "webdav-scan-route")
      .send({ mappingId: ids.mapping, reason: "立即扫描", idempotencyKey: "webdav:scan:route:1" }).expect(202);
    expect(harness.webDavSync.triggerScan).toHaveBeenCalledWith({ actorUserId: ids.user,
      requestId: "webdav-scan-route", update: { mappingId: ids.mapping, reason: "立即扫描",
        idempotencyKey: "webdav:scan:route:1" } });

    await authenticated(harness,
      request(harness.app).post(`/api/v2/webdav-sync/conflicts/${ids.conflict}/resolve`))
      .send({ resolution: "keep_remote", renamedRemotePath: null, reason: "保留远端", version: 1,
        idempotencyKey: "webdav:conflict:route:1", extra: true })
      .expect(400).expect(problem("REQUEST_BODY_INVALID", 400));
    expect(harness.webDavSync.resolveConflict).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const csrf = createCsrfProtection({ keyring: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 13)]]) } });
  const page = { page: 1, pageSize: 20, total: 0, pageCount: 0 };
  const webDavSync = {
    getSummary: vi.fn().mockResolvedValue({}), listConnections: vi.fn().mockResolvedValue({ items: [] }),
    createConnection: vi.fn().mockResolvedValue({}), updateConnection: vi.fn().mockResolvedValue({}),
    testConnection: vi.fn().mockResolvedValue({}), listMappings: vi.fn().mockResolvedValue({ items: [] }),
    createMapping: vi.fn().mockResolvedValue({}), updateMapping: vi.fn().mockResolvedValue({}),
    triggerScan: vi.fn().mockResolvedValue({}), listSyncItems: vi.fn().mockResolvedValue({ items: [], page }),
    retrySyncItem: vi.fn().mockResolvedValue({}), listConflicts: vi.fn().mockResolvedValue({ items: [], page }),
    resolveConflict: vi.fn().mockResolvedValue({})
  };
  const sessions = { authenticate: vi.fn().mockResolvedValue({ user: { id: ids.user }, session: { id: ids.session } }) };
  const app = express();
  app.use(requestContext());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/webdav-sync", createWebDavSyncRoutes({ webDavSync: webDavSync as never, sessions: sessions as never,
    publicBaseUrl, cookie: { name: "platform_session", secure: false }, csrf }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, webDavSync, csrf };
}

function authedGet(harness: ReturnType<typeof createHarness>, path: string) {
  return request(harness.app).get(path).set("Cookie", "platform_session=valid-session");
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
