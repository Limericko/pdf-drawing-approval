import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createErrorMiddleware } from "../http/errorMiddleware.ts";
import { requestContext } from "../http/requestContext.ts";
import { createCsrfProtection } from "../security/csrf.ts";
import { createStorageRoutes } from "./storageRoutes.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000c01",
  session: "01890f1e-9b4a-7cc2-8f00-000000000c02",
  object: "01890f1e-9b4a-7cc2-8f00-000000000c03"
} as const;
const publicBaseUrl = "https://approval.example.test";

describe("v2 storage routes", () => {
  it("requires origin, session and CSRF before consuming upload bytes", async () => {
    const harness = createHarness();
    await request(harness.app).post("/api/v2/storage/objects").send(Buffer.from("pdf"))
      .set("Content-Type", "application/pdf").expect(403);
    await unsafe(request(harness.app).post("/api/v2/storage/objects"))
      .send(Buffer.from("pdf")).set("Content-Type", "application/pdf").expect(401);
    expect(harness.storageObjects.create).not.toHaveBeenCalled();
  });

  it("streams bounded PDF bytes and returns owned object metadata", async () => {
    const harness = createHarness();
    const payload = Buffer.from("%PDF-1.7\nfixture");
    const response = await authenticated(harness, request(harness.app).post("/api/v2/storage/objects"))
      .send(payload).set("Content-Type", "application/pdf").expect(201).expect("Cache-Control", "no-store");
    expect(response.body).toEqual({ id: ids.object, mediaType: "application/pdf", sizeBytes: payload.length,
      sha256: "ab".repeat(32) });
    expect(harness.received()).toEqual(payload);
  });

  it("rejects unsupported, empty and declared oversized bodies", async () => {
    const harness = createHarness();
    await authenticated(harness, request(harness.app).post("/api/v2/storage/objects"))
      .send("drawing").set("Content-Type", "text/plain").expect(415);
    await authenticated(harness, request(harness.app).post("/api/v2/storage/objects"))
      .send(Buffer.from("x")).set("Content-Type", "image/png")
      .set("Content-Length", String(8 * 1024 * 1024 + 1)).expect(413);
  });
});

function createHarness() {
  let received = Buffer.alloc(0);
  const storageObjects = { create: vi.fn(async ({ body, mediaType }: { body: NodeJS.ReadableStream; mediaType: string }) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    received = Buffer.concat(chunks);
    return { id: ids.object, mediaType, sizeBytes: received.length, sha256: Buffer.from("ab".repeat(32), "hex") };
  }) };
  const sessions = { authenticate: vi.fn().mockResolvedValue({
    user: { id: ids.user }, session: { id: ids.session }
  }) };
  const csrf = createCsrfProtection({ keyring: { currentVersion: "v1",
    keys: new Map([["v1", Buffer.alloc(32, 12)]]) } });
  const app = express();
  app.use(requestContext());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v2/storage", createStorageRoutes({ storageObjects: storageObjects as never,
    storageAccess: { open: vi.fn() } as never, sessions: sessions as never, publicBaseUrl,
    cookie: { name: "platform_session", secure: false }, csrf }));
  app.use(createErrorMiddleware({ logger: { error: vi.fn() }, emergencySink: vi.fn() }));
  return { app, storageObjects, csrf, received: () => received };
}

function authenticated(harness: ReturnType<typeof createHarness>, test: request.Test) {
  return unsafe(test).set("Cookie", "platform_session=valid-session")
    .set("X-CSRF-Token", harness.csrf.issue(ids.session));
}

function unsafe(test: request.Test) {
  return test.set("Origin", publicBaseUrl).set("Sec-Fetch-Site", "same-origin");
}
