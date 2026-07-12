import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPlatformHealthRouter } from "./health.ts";

function createApp(checks: Parameters<typeof createPlatformHealthRouter>[0]) {
  const app = express();
  app.use(createPlatformHealthRouter(checks));
  return app;
}

describe("platform health", () => {
  it("publishes only runtime and version metadata and keeps liveness dependency-free", async () => {
    const probes = {
      postgres: vi.fn(async () => undefined),
      schema: vi.fn(async () => undefined),
      storage: vi.fn(async () => undefined)
    };
    const app = createApp({ core: probes });

    const health = await request(app).get("/health").expect(200);
    expect(health.body).toEqual({
      ok: true,
      runtimeMode: "platform",
      appName: "PDF图纸审批",
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      apiCompatVersion: 1
    });
    expect(JSON.stringify(health.body)).not.toMatch(/postgres|storage|smtp|worker|credential|topology/i);

    await request(app).get("/health/live").expect(200, { ok: true });
    expect(probes.postgres).not.toHaveBeenCalled();
    expect(probes.schema).not.toHaveBeenCalled();
    expect(probes.storage).not.toHaveBeenCalled();
  });

  it("gates readiness on PostgreSQL, expected schema, and the selected storage only", async () => {
    const app = createApp({
      core: {
        postgres: vi.fn(async () => undefined),
        schema: vi.fn(async () => { throw new Error("SCHEMA_VERSION_BEHIND:secret"); }),
        storage: vi.fn(async () => undefined)
      }
    });

    const response = await request(app).get("/health/ready").expect(503);
    expect(response.body).toEqual({
      ok: false,
      dependencies: { postgres: "healthy", schema: "unhealthy", storage: "healthy" },
      advisories: { worker: "unknown", smtp: "unknown" }
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("reports worker and SMTP degradation without removing the core API from readiness", async () => {
    const app = createApp({
      core: {
        postgres: vi.fn(async () => undefined),
        schema: vi.fn(async () => undefined),
        storage: vi.fn(async () => undefined)
      },
      advisory: {
        worker: vi.fn(async () => { throw new Error("worker unavailable"); }),
        smtp: vi.fn(async () => { throw new Error("smtp unavailable"); })
      }
    });

    await request(app).get("/health/ready").expect(200, {
      ok: true,
      dependencies: { postgres: "healthy", schema: "healthy", storage: "healthy" },
      advisories: { worker: "unhealthy", smtp: "unhealthy" }
    });
  });

  it("singleflights concurrent readiness requests so storage is not continuously probed", async () => {
    let release!: () => void;
    const storage = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const app = createApp({
      core: { postgres: vi.fn(async () => undefined), schema: vi.fn(async () => undefined), storage },
      cache: { ttlMs: 1_000, timeoutMs: 100 }
    });

    const first = request(app).get("/health/ready").then((response) => response);
    const second = request(app).get("/health/ready").then((response) => response);
    await vi.waitFor(() => expect(storage).toHaveBeenCalledOnce());
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await request(app).get("/health/ready").expect(200);
    expect(storage).toHaveBeenCalledOnce();
  });

  it("does not write-probe storage on every normal load-balancer readiness interval", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const storage = vi.fn(async () => undefined);
    const app = createApp({
      core: { postgres: vi.fn(async () => undefined), schema: vi.fn(async () => undefined), storage }
    });

    await request(app).get("/health/ready").expect(200);
    now += 30_000;
    await request(app).get("/health/ready").expect(200);
    expect(storage).toHaveBeenCalledOnce();
  });
});
