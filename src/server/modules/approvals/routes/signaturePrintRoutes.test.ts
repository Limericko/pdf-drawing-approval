import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createCsrfProtection } from "../../../platform/security/csrf.ts";
import { createSignatureRoutes } from "../../signatures/routes/signatureRoutes.ts";
import { createPrintArchiveRoutes } from "./printArchiveRoutes.ts";

const ids = { user: "01890f1e-9b4a-7cc2-8f00-000000001501", session: "01890f1e-9b4a-7cc2-8f00-000000001502",
  project: "01890f1e-9b4a-7cc2-8f00-000000001503", approval: "01890f1e-9b4a-7cc2-8f00-000000001504",
  object: "01890f1e-9b4a-7cc2-8f00-000000001505" } as const;
const publicBaseUrl = "https://approval.example.test";

describe("v2 signature and print archive routes", () => {
  it("allows authenticated reads but protects both mutations with origin and CSRF", async () => {
    const harness = createHarness();
    await request(harness.app).get("/api/v2/signature").set("Cookie", "platform_session=valid-session")
      .expect(200).expect("Cache-Control", "no-store");
    await request(harness.app).get(`/api/v2/projects/${ids.project}/approvals/${ids.approval}/print-archive`)
      .set("Cookie", "platform_session=valid-session").expect(200).expect("Cache-Control", "no-store");
    await request(harness.app).put("/api/v2/signature").send(signatureBody())
      .expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await unsafe(request(harness.app).post(`/api/v2/projects/${ids.project}/approvals/${ids.approval}/print-archive`))
      .set("Cookie", "platform_session=valid-session").set("X-CSRF-Token", "wrong").send(printBody())
      .expect(403).expect(problem("CSRF_INVALID", 403));
  });

  it("routes strict signature and archive results with the authenticated actor", async () => {
    const harness = createHarness();
    await authenticated(harness, request(harness.app).put("/api/v2/signature"))
      .set("X-Request-ID", "signature-route").send(signatureBody()).expect(200);
    expect(harness.signatures.setActive).toHaveBeenCalledWith({ actorUserId: ids.user, requestId: "signature-route",
      update: signatureBody() });
    await authenticated(harness, request(harness.app)
      .post(`/api/v2/projects/${ids.project}/approvals/${ids.approval}/print-archive`))
      .set("X-Request-ID", "print-route").send(printBody()).expect(201);
    expect(harness.printArchive.record).toHaveBeenCalledWith({ projectId: ids.project, approvalId: ids.approval,
      actorUserId: ids.user, requestId: "print-route", result: printBody() });
  });
});

function createHarness() {
  const csrf = createCsrfProtection({ keyring: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 15)]]) } });
  const signatures = { getActive: vi.fn().mockResolvedValue(null), setActive: vi.fn().mockResolvedValue({}) };
  const printArchive = { list: vi.fn().mockResolvedValue({ items: [] }), record: vi.fn().mockResolvedValue({}) };
  const sessions = { authenticate: vi.fn().mockResolvedValue({ user: { id: ids.user }, session: { id: ids.session } }) };
  const app = express(); app.use(requestContext()); app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/signature", createSignatureRoutes({ signatures: signatures as never, sessions: sessions as never,
    publicBaseUrl, cookie: { name: "platform_session", secure: false }, csrf }));
  app.use("/api/v2/projects", createPrintArchiveRoutes({ printArchive: printArchive as never, sessions: sessions as never,
    publicBaseUrl, cookie: { name: "platform_session", secure: false }, csrf }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, signatures, printArchive, csrf };
}
function signatureBody() { return { objectId: ids.object, idempotencyKey: "signature:route:1" }; }
function printBody() { return { objectId: ids.object, printerName: "云端归档", status: "archived",
  errorCode: null, idempotencyKey: "print:route:1" }; }
function authenticated(harness: ReturnType<typeof createHarness>, test: request.Test) { return unsafe(test)
  .set("Cookie", "platform_session=valid-session").set("X-CSRF-Token", harness.csrf.issue(ids.session)); }
function unsafe(test: request.Test) { return test.set("Origin", publicBaseUrl).set("Sec-Fetch-Site", "same-origin"); }
function problem(code: string, status: number) { return (response: request.Response) =>
  expect(response.body).toMatchObject({ type: "about:blank", code, status, requestId: expect.any(String) }); }
