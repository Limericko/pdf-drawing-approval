import path from "node:path";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { WebPlatformConfig } from "./config/types.ts";
import { createPlatformEmergencySink, createPlatformServer } from "./server.ts";

const keyring = { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 7)]]) };
const config: WebPlatformConfig = {
  target: "web",
  environment: "test",
  database: { connectionString: "postgresql://local.invalid/test", poolMax: 2, connectTimeoutMs: 100,
    queryTimeoutMs: 100, lockTimeoutMs: 100, transactionTimeoutMs: 100 },
  storage: { driver: "filesystem", root: path.resolve(".tmp-platform-server-test") },
  publicBaseUrl: "https://approval.example.test",
  trustedProxy: false,
  session: { cookieSecure: false, absoluteTtlMs: 60_000, idleTtlMs: 30_000, touchIntervalMs: 1_000 },
  keyrings: { totpEncryption: keyring, invitationHmac: keyring, recoveryHmac: keyring, csrfHmac: keyring }
};

function services(login = vi.fn(async () => ({ next: "mfa" as const, challengeToken: "challenge" }))) {
  return {
    authentication: { login, completeMfa: vi.fn() },
    sessions: { authenticate: vi.fn(), revokeCurrent: vi.fn() },
    invitations: { createInvitation: vi.fn(), prepare: vi.fn(), complete: vi.fn() },
    authorization: { getSessionContext: vi.fn(), listProjects: vi.fn(), getProjectAccess: vi.fn(), createProject: vi.fn() }
  };
}

function createApp(options: { trustedProxy?: WebPlatformConfig["trustedProxy"]; login?: ReturnType<typeof vi.fn>;
  logger?: { error(event: { requestId: string; code: string }): void }; emergencySink?: ReturnType<typeof createPlatformEmergencySink> } = {}) {
  const identity = services(options.login);
  return {
    identity,
    app: createPlatformServer({
      config: { ...config, trustedProxy: options.trustedProxy ?? false },
      services: identity as never,
      health: { core: { postgres: async () => undefined, schema: async () => undefined, storage: async () => undefined } },
      logger: options.logger ?? { error: vi.fn() },
      emergencySink: options.emergencySink ?? createPlatformEmergencySink()
    })
  };
}

describe("platform server", () => {
  it("applies validated trust proxy and does not trust forged forwarding headers by default", async () => {
    const untrusted = createApp();
    await request(untrusted.app).post("/api/v2/auth/login")
      .set("Origin", config.publicBaseUrl).set("Sec-Fetch-Site", "same-origin")
      .set("X-Forwarded-For", "203.0.113.97")
      .send({ email: "a@example.test", password: "long enough password" }).expect(202);
    expect(untrusted.identity.authentication.login).toHaveBeenCalledWith(expect.objectContaining({
      sourceIpPrefix: "127.0.0.0/24"
    }));

    const trusted = createApp({ trustedProxy: 1 });
    expect(trusted.app.get("trust proxy")).toBe(1);
    await request(trusted.app).post("/api/v2/auth/login")
      .set("Origin", config.publicBaseUrl).set("Sec-Fetch-Site", "same-origin")
      .set("X-Forwarded-For", "203.0.113.97")
      .send({ email: "a@example.test", password: "long enough password" }).expect(202);
    expect(trusted.identity.authentication.login).toHaveBeenCalledWith(expect.objectContaining({
      sourceIpPrefix: "203.0.113.0/24"
    }));
  });

  it("does not expose legacy login or designer self-registration in platform mode", async () => {
    const { app } = createApp();
    await request(app).post("/api/auth/login").send({}).expect(404);
    await request(app).post("/api/auth/register-designer").send({}).expect(404);
  });

  it("uses a synchronous non-throwing sanitized emergency sink when the primary logger fails", async () => {
    const written: string[] = [];
    const emergencySink = createPlatformEmergencySink({
      write(line) {
        written.push(line);
        throw new Error("emergency output unavailable with secret");
      }
    });
    const login = vi.fn(async () => { throw new Error("password=secret database URL"); });
    const { app } = createApp({ login, logger: { error: () => { throw new Error("primary logger failed"); } }, emergencySink });

    const response = await request(app).post("/api/v2/auth/login")
      .set("Origin", config.publicBaseUrl).set("Sec-Fetch-Site", "same-origin")
      .send({ email: "a@example.test", password: "long enough password" }).expect(500);

    expect(written).toHaveLength(1);
    expect(written[0]).toContain("LOGGER_FAILURE");
    expect(JSON.stringify([written, response.body])).not.toMatch(/password=|database URL|example\.test|primary logger/i);
  });

  it("keeps the platform composition root free of legacy runtime facilities", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/createDatabase|ensureDefaultUsers|watchSubmissions|maintenanceScheduler|jsonwebtoken|applyDesktopClientCors/);
    expect(source).toContain('app.set("trust proxy", options.config.trustedProxy)');
  });
});
