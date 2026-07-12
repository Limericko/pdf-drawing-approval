import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvitationResponseSchema, createProjectResponseSchema, invitationCompleteResponseSchema,
  invitationPrepareResponseSchema, loginResponseSchema, mfaCompleteResponseSchema, projectAccessResponseSchema,
  projectListResponseSchema, sessionResponseSchema } from "../../../../shared/contracts/identity.ts";
import { runMigrations } from "../../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../../platform/database/pool.ts";
import { createErrorMiddleware } from "../../../platform/http/errorMiddleware.ts";
import { requestContext } from "../../../platform/http/requestContext.ts";
import { createSessionService } from "../../../platform/security/sessionService.ts";
import { deriveInvitationToken, hashOpaqueToken } from "../../../platform/security/tokenHash.ts";
import { totpAt } from "../../../platform/security/totp.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../../platform/testing/postgresHarness.ts";
import { createAuthorizationService } from "../authorizationService.ts";
import { createInvitationService } from "../invitationService.ts";
import { PostgresProjectRepository } from "../repositories/postgres/PostgresProjectRepository.ts";
import { PostgresSessionRepository } from "../repositories/postgres/PostgresSessionRepository.ts";
import { PostgresUserRepository } from "../repositories/postgres/PostgresUserRepository.ts";
import { createIdentityRoutes, noStoreIdentityResponses } from "./identityRoutes.ts";

const passwordHashOptions = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
const csrfKeyring = { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 7)]]) };
const publicBaseUrl = "https://approval.example.test/app";
let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 6, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "identity-routes-test");
});

afterAll(async () => {
  await web?.end();
  await database?.dispose();
});

beforeEach(async () => {
  await migration.query("TRUNCATE platform.projects CASCADE");
  await migration.query("TRUNCATE platform.users CASCADE");
  await migration.query("TRUNCATE platform.audit_events");
});

describe("v2 identity routes", () => {
  it("enforces JSON, exact Origin, Fetch Metadata and strict schemas before unauthenticated login", async () => {
    const harness = await createHarness();
    await request(harness.app).post("/api/v2/auth/login").send({ email: "user@example.test", password: "secret" })
      .expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    await request(harness.app).post("/api/v2/auth/login").set("Origin", "https://evil.example")
      .send({ email: "user@example.test", password: "secret" })
      .expect(403).expect(problem("ORIGIN_FORBIDDEN", 403));
    await request(harness.app).post("/api/v2/auth/login").set("Origin", "https://approval.example.test")
      .set("Content-Type", "text/plain").send("not-json")
      .expect(415).expect(problem("JSON_CONTENT_TYPE_REQUIRED", 415));
    await request(harness.app).post("/api/v2/auth/login").set("Origin", "https://approval.example.test")
      .set("Sec-Fetch-Site", "cross-site").send({ email: "user@example.test", password: "secret" })
      .expect(403).expect(problem("CROSS_SITE_REQUEST_FORBIDDEN", 403));
    await unsafe(request(harness.app).post("/api/v2/auth/login"))
      .send({ email: "user@example.test", password: "secret", extra: true })
      .expect(400).expect(problem("REQUEST_BODY_INVALID", 400));
    expect(harness.authentication.login).not.toHaveBeenCalled();
  });

  it("correlates malformed JSON through request context, no-store and the terminal problem middleware", async () => {
    const harness = await createHarness();
    const response = await request(harness.app).post("/api/v2/auth/login")
      .set("Origin", "https://approval.example.test").set("Content-Type", "application/json")
      .set("X-Request-ID", "malformed-json-http-request").send('{"email":"user@example.test"')
      .expect(400).expect("Cache-Control", "no-store")
      .expect("X-Request-ID", "malformed-json-http-request");
    expect(response.body).toMatchObject({ code: "REQUEST_BODY_INVALID", status: 400,
      requestId: "malformed-json-http-request" });
    expect(harness.authentication.login).not.toHaveBeenCalled();
  });

  it("returns a password challenge without a cookie and correlates the request ID", async () => {
    const harness = await createHarness();
    const response = await unsafe(request(harness.app).post("/api/v2/auth/login"))
      .set("X-Request-ID", "login-request-123")
      .send({ email: "user@example.test", password: "correct horse battery staple" })
      .expect(202).expect("Cache-Control", "no-store").expect("X-Request-ID", "login-request-123");

    expect(response.body).toEqual({ next: "mfa", challengeToken: "one-time-challenge" });
    expect(loginResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(harness.authentication.login).toHaveBeenCalledWith(expect.objectContaining({
      email: "user@example.test", sourceIpPrefix: "127.0.0.0/24", requestId: "login-request-123"
    }));
  });

  it("sets only the hardened production cookie after MFA and never returns the session token", async () => {
    const harness = await createHarness({ environment: "production", cookieSecure: true });
    const response = await unsafe(request(harness.app).post("/api/v2/auth/mfa/complete"))
      .send({ challengeToken: "challenge", factor: { method: "totp", code: "123456" } })
      .expect(200).expect("Cache-Control", "no-store");

    expect(JSON.stringify(response.body)).not.toContain("raw-session-secret");
    expect(response.body.user).not.toHaveProperty("passwordHash");
    expect(mfaCompleteResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.headers["set-cookie"]).toEqual([expect.stringMatching(
      /^__Host-pdf_approval_session=raw-session-secret; Path=\/; HttpOnly; Secure; SameSite=Lax$/
    )]);
  });

  it("returns session context and enforces missing, wrong and cross-session CSRF on logout", async () => {
    const user = await createUser("session-user@example.test", "admin");
    const project = await new PostgresProjectRepository(migration).create({ name: "Session Project", status: "active",
      createdByUserId: user.id });
    await createSession(user.id, "session-token-a");
    await createSession(user.id, "session-token-b");
    const harness = await createHarness();

    const sessionA = await request(harness.app).get("/api/v2/session")
      .set("Cookie", "platform_session=session-token-a").expect(200).expect("Cache-Control", "no-store");
    const sessionB = await request(harness.app).get("/api/v2/session")
      .set("Cookie", "platform_session=session-token-b").expect(200);
    expect(sessionA.body.user).not.toHaveProperty("passwordHash");
    expect(sessionA.body.globalCapabilities).toEqual(["platform.security.manage", "projects.create"]);
    expect(sessionA.body.projects).toEqual([expect.objectContaining({ id: project.project.id, role: "manager" })]);
    expect(sessionA.body.csrfToken).toMatch(/^v1\./);
    expect(sessionResponseSchema.safeParse(sessionA.body).success).toBe(true);

    await unsafe(request(harness.app).delete("/api/v2/session"))
      .set("Content-Type", "application/json").set("Cookie", "platform_session=session-token-a")
      .expect(403).expect(problem("CSRF_INVALID", 403));
    await unsafe(request(harness.app).delete("/api/v2/session"))
      .set("Content-Type", "application/json").set("Cookie", "platform_session=session-token-a")
      .set("X-CSRF-Token", "wrong")
      .expect(403).expect(problem("CSRF_INVALID", 403));
    await unsafe(request(harness.app).delete("/api/v2/session"))
      .set("Content-Type", "application/json").set("Cookie", "platform_session=session-token-a")
      .set("X-CSRF-Token", sessionB.body.csrfToken)
      .expect(403).expect(problem("CSRF_INVALID", 403));
    const logout = await unsafe(request(harness.app).delete("/api/v2/session"))
      .set("Content-Type", "application/json").set("Cookie", "platform_session=session-token-a")
      .set("X-CSRF-Token", sessionA.body.csrfToken)
      .expect(204).expect("Cache-Control", "no-store");
    expect(logout.headers["set-cookie"]?.[0]).toMatch(/^platform_session=; Path=\/; Expires=/);
    await request(harness.app).get("/api/v2/session").set("Cookie", "platform_session=session-token-a")
      .expect(401).expect(problem("SESSION_INVALID", 401));
  });

  it("uses authenticated service calls for invitations and projects without route SQL", async () => {
    const admin = await createUser("route-admin@example.test", "admin");
    await createSession(admin.id, "route-admin-session");
    const harness = await createHarness();
    const session = await request(harness.app).get("/api/v2/session")
      .set("Cookie", "platform_session=route-admin-session").expect(200);
    const authenticated = (test: request.Test) => unsafe(test).set("Cookie", "platform_session=route-admin-session")
      .set("X-CSRF-Token", session.body.csrfToken);

    const createdProject = await authenticated(request(harness.app).post("/api/v2/projects"))
      .send({ name: "Route Project" }).expect(201);
    expect(createProjectResponseSchema.safeParse(createdProject.body).success).toBe(true);
    const projects = await request(harness.app).get("/api/v2/projects")
      .set("Cookie", "platform_session=route-admin-session").expect(200);
    expect(projects.body.projects).toEqual([expect.objectContaining({ name: "Route Project", role: "manager" })]);
    expect(projectListResponseSchema.safeParse(projects.body).success).toBe(true);
    const access = await request(harness.app).get(`/api/v2/projects/${projects.body.projects[0].id}/access`)
      .set("Cookie", "platform_session=route-admin-session").expect(200);
    expect(access.body.capabilities).toContain("project.read");
    expect(projectAccessResponseSchema.safeParse(access.body).success).toBe(true);

    const invitationResponse = await authenticated(request(harness.app).post("/api/v2/invitations"))
      .send({ email: "invitee@example.test", platformRole: "member", projectId: projects.body.projects[0].id,
        projectRole: "designer" }).expect(201);
    expect(createInvitationResponseSchema.safeParse(invitationResponse.body).success).toBe(true);
    expect(harness.invitations.createInvitation).toHaveBeenCalledWith(expect.objectContaining({
      invitedByUserId: admin.id, email: "invitee@example.test"
    }));

    await request(harness.app).get("/api/v2/projects/not-a-uuid/access")
      .set("Cookie", "platform_session=route-admin-session")
      .expect(400).expect(problem("AUTHORIZATION_INPUT_INVALID", 400));
  });

  it("protects invitation preparation and completion before their expensive service work", async () => {
    const harness = await createHarness();
    await request(harness.app).post("/api/v2/invitations/prepare")
      .send({ invitationToken: "token" }).expect(403).expect(problem("ORIGIN_REQUIRED", 403));
    const prepared = await unsafe(request(harness.app).post("/api/v2/invitations/prepare"))
      .send({ invitationToken: "token" }).expect(200, { enrollmentToken: "enrollment-token",
        otpauthUri: "otpauth://totp/PDF%20Approval" });
    expect(invitationPrepareResponseSchema.safeParse(prepared.body).success).toBe(true);
    const completed = await unsafe(request(harness.app).post("/api/v2/invitations/complete"))
      .send({ enrollmentToken: "enrollment-token", password: "correct horse battery staple", totp: "123456" })
      .expect(200, { recoveryCodes: ["recovery-code"] });
    expect(invitationCompleteResponseSchema.safeParse(completed.body).success).toBe(true);
  });

  it("persists the HTTP request ID in the real invitation success audit", async () => {
    const admin = await createUser("audit-admin@example.test", "admin");
    const project = await new PostgresProjectRepository(migration).create({ name: "Audit Project", status: "active",
      createdByUserId: admin.id });
    await createSession(admin.id, "audit-admin-session");
    const invitationHmac = { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 11)]]) };
    const totpSecret = Buffer.alloc(20, 14);
    const invitationService = createInvitationService({ pool: web, passwordHashOptions, keyrings: {
      invitationHmac,
      totpEncryption: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 12)]]) },
      recoveryHmac: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 13)]]) }
    }, generateTotpSecret: () => Buffer.from(totpSecret) });
    const harness = await createHarness({ invitationsService: invitationService });
    const session = await request(harness.app).get("/api/v2/session")
      .set("Cookie", "platform_session=audit-admin-session").expect(200);
    const requestId = "invitation-route-audit-request";

    const response = await unsafe(request(harness.app).post("/api/v2/invitations"))
      .set("Cookie", "platform_session=audit-admin-session").set("X-CSRF-Token", session.body.csrfToken)
      .set("X-Request-ID", requestId).send({ email: "audited@example.test", platformRole: "member",
        projectId: project.project.id, projectRole: "viewer" }).expect(201).expect("X-Request-ID", requestId);
    await expect(migration.query("SELECT request_id FROM platform.audit_events WHERE action='invitation.create' AND target_id=$1",
      [response.body.invitationId])).resolves.toMatchObject({ rows: [{ request_id: requestId }] });

    const invitationToken = deriveInvitationToken(response.body.invitationId, "v1", invitationHmac);
    const prepared = await unsafe(request(harness.app).post("/api/v2/invitations/prepare"))
      .set("X-Request-ID", "invitation-prepare-request").send({ invitationToken }).expect(200);
    const completeRequestId = "invitation-complete-route-audit";
    const completed = await unsafe(request(harness.app).post("/api/v2/invitations/complete"))
      .set("X-Request-ID", completeRequestId).send({ enrollmentToken: prepared.body.enrollmentToken,
        password: "correct horse battery staple", totp: totpAt(totpSecret, Date.now()) })
      .expect(200).expect("X-Request-ID", completeRequestId);
    expect(completed.body.recoveryCodes).toHaveLength(10);
    await expect(migration.query("SELECT request_id FROM platform.audit_events WHERE action='invitation.accept' AND target_id=$1",
      [response.body.invitationId])).resolves.toMatchObject({ rows: [{ request_id: completeRequestId }] });
  });

  it("returns stable sanitized problems for bad cookies, PostgreSQL failures and unknown async rejections", async () => {
    const logger = { error: vi.fn() };
    const badCookie = await createHarness({ logger });
    await request(badCookie.app).get("/api/v2/session").set("Cookie", "platform_session=missing")
      .expect(401).expect(problem("SESSION_INVALID", 401));

    for (const failure of [
      Object.assign(new Error("SELECT password_hash WHERE secret='url https://u:p@example.test'"), { code: "08006" }),
      new Error("unknown stack password secret https://u:p@example.test")
    ]) {
      const harness = await createHarness({ logger, loginFailure: failure });
      const response = await unsafe(request(harness.app).post("/api/v2/auth/login"))
        .send({ email: "user@example.test", password: "correct horse battery staple" })
        .expect(failure === (failure as { code?: string }) && "code" in failure ? 503 : 500)
        .expect("Content-Type", /application\/problem\+json/);
      expect(JSON.stringify(response.body)).not.toMatch(/SELECT|password_hash|example\.test|secret|stack/i);
    }
    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls.every(([event]) => !Object.hasOwn(event, "error"))).toBe(true);
  });

  it("uses only Express trusted req.ip when deriving the shared rate-limit prefix", async () => {
    const untrusted = await createHarness();
    await unsafe(request(untrusted.app).post("/api/v2/auth/login"))
      .set("X-Forwarded-For", "203.0.113.97").send({ email: "a@example.test", password: "long enough password" })
      .expect(202);
    expect(untrusted.authentication.login).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceIpPrefix: "127.0.0.0/24"
    }));

    const trusted = await createHarness({ trustProxy: 1 });
    await unsafe(request(trusted.app).post("/api/v2/auth/login"))
      .set("X-Forwarded-For", "203.0.113.97").send({ email: "a@example.test", password: "long enough password" })
      .expect(202);
    expect(trusted.authentication.login).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceIpPrefix: "203.0.113.0/24"
    }));
  });
});

async function createHarness(options: { environment?: "test" | "production"; cookieSecure?: boolean;
  trustProxy?: false | number; loginFailure?: Error; logger?: { error(event: Record<string, unknown>): void };
  invitationsService?: ReturnType<typeof createInvitationService> } = {}) {
  const logger = options.logger ?? { error: vi.fn() };
  const authentication = {
    login: options.loginFailure ? vi.fn().mockRejectedValue(options.loginFailure) :
      vi.fn().mockResolvedValue({ next: "mfa", challengeToken: "one-time-challenge" }),
    completeMfa: vi.fn().mockResolvedValue({ sessionToken: "raw-session-secret", user: publicUser({
      id: "01890f1e-9b4a-7cc2-8f00-000000000001", emailNormalized: "user@example.test",
      displayName: "User", platformRole: "member", status: "active", mfaStatus: "enabled",
      mfaEnabledAt: new Date(), createdAt: new Date(), updatedAt: new Date(), passwordHash: "must-not-leak"
    }) })
  };
  const invitations = {
    createInvitation: vi.fn().mockResolvedValue({ invitationId: "01890f1e-9b4a-7cc2-8f00-000000000123" }),
    prepare: vi.fn().mockResolvedValue({ enrollmentToken: "enrollment-token",
      otpauthUri: "otpauth://totp/PDF%20Approval" }),
    complete: vi.fn().mockResolvedValue({ recoveryCodes: ["recovery-code"] })
  };
  const sessions = createSessionService({ pool: web, passwordHashOptions });
  const authorization = createAuthorizationService({ pool: web });
  const app = express();
  app.set("trust proxy", options.trustProxy ?? false);
  app.use(requestContext());
  app.use("/api/v2", noStoreIdentityResponses, express.json({ limit: "64kb" }), createIdentityRoutes({
    config: { publicBaseUrl, environment: options.environment ?? "test",
      cookieName: "platform_session", cookieSecure: options.cookieSecure ?? false },
    csrfKeyring,
    services: { authentication, sessions, invitations: options.invitationsService ?? invitations, authorization },
    logger
  }));
  app.use(createErrorMiddleware({ logger, emergencySink: vi.fn() }));
  return { app, authentication, invitations };
}

function unsafe(test: request.Test) {
  return test.set("Origin", "https://approval.example.test").set("Sec-Fetch-Site", "same-origin");
}

function problem(code: string, status: number) {
  return (response: request.Response) => {
    expect(response.type).toBe("application/problem+json");
    expect(response.body).toMatchObject({ type: "about:blank", code, status,
      requestId: expect.any(String), title: expect.any(String) });
  };
}

function createUser(email: string, platformRole: "admin" | "member") {
  return new PostgresUserRepository(migration).create({ email, displayName: email.split("@")[0]!,
    passwordHash: "$argon2id$seed", platformRole, status: "active", mfaEnabledAt: new Date() });
}

function createSession(userId: string, rawToken: string) {
  return new PostgresSessionRepository(migration).create({ userId, tokenHash: hashOpaqueToken(rawToken),
    absoluteLifetimeSeconds: 12 * 60 * 60, idleLifetimeSeconds: 60 * 60,
    clientSummary: "identity-route-test" });
}

function publicUser<T extends { passwordHash: string }>(user: T) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}
