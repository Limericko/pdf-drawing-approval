import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { createPdmRoutes } from "./pdmRoutes.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000901",
  session: "01890f1e-9b4a-7cc2-8f00-000000000902",
  project: "01890f1e-9b4a-7cc2-8f00-000000000903",
  part: "01890f1e-9b4a-7cc2-8f00-000000000904",
  link: "01890f1e-9b4a-7cc2-8f00-000000000905"
} as const;

const publicBaseUrl = "https://approval.example.test";

describe("v2 PDM routes", () => {
  it("parses bounded list filters and uses the authenticated actor", async () => {
    const harness = createHarness();
    await request(harness.app)
      .get(`/api/v2/projects/${ids.project}/pdm/parts?page=2&pageSize=40&keyword=阀体&releaseStatus=published&sort=part_number_asc`)
      .set("Cookie", "platform_session=valid-session")
      .expect(200).expect("Cache-Control", "no-store");
    expect(harness.pdm.listParts).toHaveBeenCalledWith({
      projectId: ids.project,
      actorUserId: ids.user,
      page: 2,
      pageSize: 40,
      keyword: "阀体",
      releaseStatus: "published",
      sort: "part_number_asc"
    });
    await request(harness.app).get(`/api/v2/projects/${ids.project}/pdm/parts?pageSize=1000`)
      .set("Cookie", "platform_session=valid-session")
      .expect(400).expect(problem("PDM_INPUT_INVALID", 400));
  });

  it("requires exact origin, session and CSRF for metadata mutation", async () => {
    const harness = createHarness();
    const target = `/api/v2/projects/${ids.project}/pdm/revisions/${ids.link}/metadata`;
    const body = { materialCode: "40Cr", version: 1, idempotencyKey: "pdm:metadata:route:1" };
    await request(harness.app).patch(target).send(body).expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await unsafe(request(harness.app).patch(target)).send(body)
      .expect(401).expect(problem("AUTHENTICATION_REQUIRED", 401));
    await unsafe(request(harness.app).patch(target)).set("Cookie", "platform_session=valid-session")
      .set("X-CSRF-Token", "wrong").send(body).expect(403).expect(problem("CSRF_INVALID", 403));
    expect(harness.pdm.updateMetadata).not.toHaveBeenCalled();
  });

  it("routes strict metadata, retry and void commands with request IDs", async () => {
    const harness = createHarness();
    const base = `/api/v2/projects/${ids.project}/pdm/revisions/${ids.link}`;
    await authenticated(harness, request(harness.app).patch(`${base}/metadata`))
      .set("X-Request-ID", "pdm-metadata-route")
      .send({ materialCode: "QT450-10", version: 3, idempotencyKey: "pdm:metadata:route:2" }).expect(200);
    expect(harness.pdm.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({
      projectId: ids.project, linkId: ids.link, actorUserId: ids.user, requestId: "pdm-metadata-route",
      update: { materialCode: "QT450-10", version: 3, idempotencyKey: "pdm:metadata:route:2" }
    }));

    await authenticated(harness, request(harness.app).post(`${base}/retry`))
      .send({ version: 4, idempotencyKey: "pdm:retry:route:1" }).expect(200);
    expect(harness.pdm.retryPublish).toHaveBeenCalledWith(expect.objectContaining({
      retry: { version: 4, idempotencyKey: "pdm:retry:route:1" }
    }));

    await authenticated(harness, request(harness.app).post(`${base}/void`))
      .send({ reason: "图号录入错误", version: 5, idempotencyKey: "pdm:void:route:1" }).expect(200);
    expect(harness.pdm.voidRevision).toHaveBeenCalledWith(expect.objectContaining({
      update: { reason: "图号录入错误", version: 5, idempotencyKey: "pdm:void:route:1" }
    }));
  });

  it("hides malformed and foreign part identifiers behind the PDM contract", async () => {
    const harness = createHarness();
    await request(harness.app).get(`/api/v2/projects/${ids.project}/pdm/parts/not-a-uuid`)
      .set("Cookie", "platform_session=valid-session")
      .expect(400).expect(problem("PDM_INPUT_INVALID", 400));
    expect(harness.pdm.getPart).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const csrf = createCsrfProtection({ keyring: {
    currentVersion: "v1",
    keys: new Map([["v1", Buffer.alloc(32, 9)]])
  } });
  const pdm = {
    listParts: vi.fn().mockResolvedValue({ items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 } }),
    getPart: vi.fn().mockResolvedValue({ part: { id: ids.part } }),
    updateMetadata: vi.fn().mockResolvedValue({ updated: true }),
    retryPublish: vi.fn().mockResolvedValue({ retried: true }),
    voidRevision: vi.fn().mockResolvedValue({ voided: true }),
    publishApprovedRevision: vi.fn()
  };
  const sessions = { authenticate: vi.fn().mockResolvedValue({
    user: { id: ids.user }, session: { id: ids.session }
  }) };
  const app = express();
  app.use(requestContext());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/projects", createPdmRoutes({ pdm: pdm as never, sessions: sessions as never,
    publicBaseUrl, cookie: { name: "platform_session", secure: false }, csrf }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, pdm, csrf };
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
