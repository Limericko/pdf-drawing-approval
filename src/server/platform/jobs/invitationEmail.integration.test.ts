import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../database/pool.ts";
import { createPlatformMailTransport } from "../mail/platformMailTransport.ts";
import { createMailpitHarness } from "../testing/mailpitHarness.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../testing/postgresHarness.ts";
import { createInvitationService } from "../../modules/identity/invitationService.ts";
import { createSendInvitationEmailHandler } from "./handlers/sendInvitationEmail.ts";

let database: PlatformTestDatabase;
let migration: ReturnType<PlatformTestDatabase["createPool"]>;
let web: PlatformPool;
let worker: PlatformPool;
const mailpit = createMailpitHarness({ baseUrl: "http://127.0.0.1:58025" });
const inviterId = "01890f1e-9b4a-7cc2-8f00-000000000071";
const projectId = "01890f1e-9b4a-7cc2-8f00-000000000072";
const invitationHmac = { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 1)]]) };
const stableRequestId = "invitation-email-integration-request";

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  const config = { poolMax: 4, connectTimeoutMs: 2_000, queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 };
  web = createPlatformPool({ ...config, connectionString: database.urls.web }, "invitation-email-web");
  worker = createPlatformPool({ ...config, connectionString: database.urls.worker }, "invitation-email-worker");
});
afterAll(async () => { await mailpit.clear(); await worker?.end(); await web?.end(); await database?.dispose(); });
beforeEach(async () => {
  await mailpit.clear();
  await migration.query("TRUNCATE platform.users, platform.projects CASCADE");
  await migration.query(`INSERT INTO platform.users
    (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
    VALUES ($1,'admin@example.test','Admin','$argon2id$seed','admin','active','enabled')`, [inviterId]);
  await migration.query("INSERT INTO platform.projects (id,name,status) VALUES ($1,'Project','active')", [projectId]);
  await migration.query(`INSERT INTO platform.project_members (id,project_id,user_id,role,status)
    VALUES ('01890f1e-9b4a-7cc2-8f00-000000000073',$1,$2,'manager','active')`, [projectId, inviterId]);
});
afterEach(async () => { await mailpit.clear(); });

describe("invitation email integration", () => {
  it("sends a fragment invitation through Mailpit with a stable Message-ID and supports at-least-once replay", async () => {
    const service = makeService();
    const created = await service.createInvitation({ email: "invitee@example.test", platformRole: "member",
      projectId, projectRole: "designer", invitedByUserId: inviterId });
    const transport = createPlatformMailTransport({ config: { host: "127.0.0.1", port: 51025,
      from: "pdf-approval@local.test", secure: false, requireTls: false, username: undefined, password: undefined } });
    const handler = createSendInvitationEmailHandler({ pool: worker, transport, keyring: invitationHmac,
      publicBaseUrl: "http://127.0.0.1:8080" });
    const job = { payload: { invitationId: created.invitationId } } as never;
    try {
      await handler(job);
      await handler(job);
      const messageId = `<invitation-${created.invitationId}@pdf-approval.local>`;
      const message = await waitForMessage(messageId, "invitee@example.test");
      expect(message).toBeDefined();
      expect(JSON.stringify(message)).toContain("/#/accept-invitation?token=");
      await expect(mailpit.countByMessageIdAndRecipient(messageId, "invitee@example.test")).resolves.toBe(2);
    } finally {
      transport.close();
    }
  });

  it("cannot match a stale message after cleanup", async () => {
    await expect(mailpit.findByMessageIdAndRecipient(
      "<invitation-01890f1e-9b4a-7cc2-8f00-000000000053@pdf-approval.local>", "invitee@example.test"
    )).resolves.toBeUndefined();
  });

  it("rejects a superseded invitation when its old outbox job arrives late", async () => {
    const service = makeService();
    const superseded = await service.createInvitation({ email: "late-job@example.test", platformRole: "member",
      projectId, projectRole: "viewer", invitedByUserId: inviterId });
    await service.createInvitation({ email: "LATE-JOB@example.test", platformRole: "member",
      projectId, projectRole: "designer", invitedByUserId: inviterId });
    let sends = 0;
    const handler = createSendInvitationEmailHandler({ pool: worker,
      transport: { sendInvitation: async () => { sends += 1; } },
      keyring: invitationHmac, publicBaseUrl: "http://127.0.0.1:8080" });

    await expect(handler({ payload: { invitationId: superseded.invitationId } } as never))
      .rejects.toMatchObject({ kind: "permanent", code: "INVITATION_NOT_ACTIVE" });
    expect(sends).toBe(0);
  });

  it("delivers a stored old-key invitation when retained and permanently rejects it after removal", async () => {
    const created = await makeService().createInvitation({ email: "old-key@example.test", platformRole: "member",
      projectId, projectRole: "viewer", invitedByUserId: inviterId });
    const rotatedKeyring = { currentVersion: "v2", keys: new Map([
      ["v1", Buffer.alloc(32, 1)], ["v2", Buffer.alloc(32, 4)]
    ]) };
    const transport = createPlatformMailTransport({ config: { host: "127.0.0.1", port: 51025,
      from: "pdf-approval@local.test", secure: false, requireTls: false, username: undefined, password: undefined } });
    try {
      const retained = createSendInvitationEmailHandler({ pool: worker, transport, keyring: rotatedKeyring,
        publicBaseUrl: "http://127.0.0.1:8080" });
      await retained({ payload: { invitationId: created.invitationId } } as never);
      await expect(waitForMessage(`<invitation-${created.invitationId}@pdf-approval.local>`, "old-key@example.test"))
        .resolves.toBeDefined();

      const removed = createSendInvitationEmailHandler({ pool: worker, transport,
        keyring: { currentVersion: "v2", keys: new Map([["v2", Buffer.alloc(32, 4)]]) },
        publicBaseUrl: "http://127.0.0.1:8080" });
      await expect(removed({ payload: { invitationId: created.invitationId } } as never))
        .rejects.toMatchObject({ kind: "permanent", code: "INVITATION_TOKEN_INVALID" });
    } finally {
      transport.close();
    }
  });

  it("permanently rejects invalid records and classifies SMTP failures as transient", async () => {
    const service = makeService();
    const invalid = await service.createInvitation({ email: "invalid@example.test", platformRole: "member",
      projectId, projectRole: "viewer", invitedByUserId: inviterId });
    await migration.query("UPDATE platform.invitations SET token_hash=$2 WHERE id=$1", [invalid.invitationId, Buffer.alloc(32, 9)]);
    const fakeTransport = { sendInvitation: async () => undefined };
    const handler = createSendInvitationEmailHandler({ pool: worker, transport: fakeTransport,
      keyring: invitationHmac, publicBaseUrl: "http://127.0.0.1:8080" });
    await expect(handler({ payload: { invitationId: invalid.invitationId } } as never))
      .rejects.toMatchObject({ kind: "permanent", code: "INVITATION_TOKEN_INVALID" });
    await expect(handler({ payload: { invitationId: invalid.invitationId, token: "forbidden" } } as never))
      .rejects.toMatchObject({ kind: "permanent", code: "INVITATION_EMAIL_PAYLOAD_INVALID" });

    const unknownKey = await service.createInvitation({ email: "unknown-key@example.test", platformRole: "member",
      projectId, projectRole: "viewer", invitedByUserId: inviterId });
    await migration.query("UPDATE platform.invitations SET token_key_version='missing' WHERE id=$1", [unknownKey.invitationId]);
    await expect(handler({ payload: { invitationId: unknownKey.invitationId } } as never))
      .rejects.toMatchObject({ kind: "permanent", code: "INVITATION_TOKEN_INVALID" });

    for (const [kind, email] of [["expired", "expired-email@example.test"], ["revoked", "revoked-email@example.test"]] as const) {
      const inactive = await service.createInvitation({ email, platformRole: "member",
        projectId, projectRole: "viewer", invitedByUserId: inviterId });
      if (kind === "expired") {
        await migration.query(`UPDATE platform.invitations
          SET created_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`,
        [inactive.invitationId]);
      } else {
        await migration.query("UPDATE platform.invitations SET revoked_at=clock_timestamp() WHERE id=$1", [inactive.invitationId]);
      }
      await expect(handler({ payload: { invitationId: inactive.invitationId } } as never))
        .rejects.toMatchObject({ kind: "permanent", code: "INVITATION_NOT_ACTIVE" });
    }

    const active = await service.createInvitation({ email: "smtp@example.test", platformRole: "member",
      projectId, projectRole: "viewer", invitedByUserId: inviterId });
    const smtpFailure = createSendInvitationEmailHandler({ pool: worker,
      transport: { sendInvitation: async () => { throw new Error("smtp unavailable secret"); } },
      keyring: invitationHmac, publicBaseUrl: "http://127.0.0.1:8080" });
    await expect(smtpFailure({ payload: { invitationId: active.invitationId } } as never))
      .rejects.toMatchObject({ kind: "transient", code: "INVITATION_EMAIL_SEND_FAILED",
        message: "Invitation email delivery failed" });
  });
});

function makeService() {
  const service = createInvitationService({ pool: web, keyrings: {
    invitationHmac,
    totpEncryption: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 2)]]) },
    recoveryHmac: { currentVersion: "v1", keys: new Map([["v1", Buffer.alloc(32, 3)]]) }
  }, passwordHashOptions: { memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32 } });
  type CreateInput = Parameters<typeof service.createInvitation>[0];
  return Object.freeze({
    ...service,
    createInvitation(input: Omit<CreateInput, "requestId"> & { readonly requestId?: string }) {
      return service.createInvitation({ ...input, requestId: input.requestId ?? stableRequestId });
    }
  });
}

async function waitForMessage(messageId: string, recipient: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const message = await mailpit.findByMessageIdAndRecipient(messageId, recipient);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}
