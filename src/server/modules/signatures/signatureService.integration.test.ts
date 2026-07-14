import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { createPlatformPool, type PlatformPool } from "../../platform/database/pool.ts";
import { createPlatformTestDatabase, type PlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createSignatureService } from "./signatureService.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000e01",
  png1: "01890f1e-9b4a-7cc2-8f00-000000000e02",
  png2: "01890f1e-9b4a-7cc2-8f00-000000000e03",
  pdf: "01890f1e-9b4a-7cc2-8f00-000000000e04"
} as const;

let database: PlatformTestDatabase;
let migration: Pool;
let web: PlatformPool;

beforeAll(async () => {
  database = await createPlatformTestDatabase();
  migration = database.createPool("migration");
  await runMigrations(migration);
  web = createPlatformPool({ connectionString: database.urls.web, poolMax: 3, connectTimeoutMs: 2_000,
    queryTimeoutMs: 5_000, lockTimeoutMs: 2_000, transactionTimeoutMs: 10_000 }, "signature-service-test");
});

afterAll(async () => { await web?.end(); await database?.dispose(); });

beforeEach(async () => {
  await migration.query("TRUNCATE platform.users,platform.storage_objects,platform.audit_events CASCADE");
  await migration.query(
    `INSERT INTO platform.users (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
     VALUES ($1,'designer@example.test','设计师','$argon2id$seed','member','active','enabled')`, [ids.user]
  );
  await migration.query(
    `INSERT INTO platform.storage_objects
      (id,status,driver,object_key,size_bytes,sha256,media_type,ready_at,created_at) VALUES
      ($1,'ready','filesystem','signature/one',68,decode(repeat('11',32),'hex'),'image/png',clock_timestamp(),
        clock_timestamp() - interval '1 second'),
      ($2,'ready','filesystem','signature/two',72,decode(repeat('12',32),'hex'),'image/png',clock_timestamp(),
        clock_timestamp() - interval '1 second'),
      ($3,'ready','filesystem','drawing/not-signature',200,decode(repeat('13',32),'hex'),'application/pdf',clock_timestamp(),
        clock_timestamp() - interval '1 second')`,
    [ids.png1, ids.png2, ids.pdf]
  );
});

describe("signature asset service", () => {
  it("replaces the active PNG, deduplicates retries and preserves prior assets", async () => {
    const service = createSignatureService({ pool: web });
    const first = { actorUserId: ids.user, requestId: "signature-first",
      update: { objectId: ids.png1, idempotencyKey: "signature:user:first" } };
    const created = await service.setActive(first);
    await expect(service.setActive({ ...first, requestId: "signature-first-retry" })).resolves.toEqual(created);
    const replacement = await service.setActive({ actorUserId: ids.user, requestId: "signature-second",
      update: { objectId: ids.png2, idempotencyKey: "signature:user:second" } });
    await expect(service.getActive({ actorUserId: ids.user })).resolves.toEqual(replacement);
    await expect(migration.query(
      "SELECT object_id,active FROM platform.signature_assets WHERE user_id=$1 ORDER BY created_at,id", [ids.user]
    )).resolves.toMatchObject({ rows: [{ object_id: ids.png1, active: false },
      { object_id: ids.png2, active: true }] });
  });

  it("rejects non-PNG objects and conflicting idempotency payloads", async () => {
    const service = createSignatureService({ pool: web });
    await expect(service.setActive({ actorUserId: ids.user, requestId: "signature-pdf",
      update: { objectId: ids.pdf, idempotencyKey: "signature:user:pdf" } }))
      .rejects.toMatchObject({ code: "SIGNATURE_OBJECT_NOT_READY" });
    await service.setActive({ actorUserId: ids.user, requestId: "signature-one",
      update: { objectId: ids.png1, idempotencyKey: "signature:user:conflict" } });
    await expect(service.setActive({ actorUserId: ids.user, requestId: "signature-two",
      update: { objectId: ids.png2, idempotencyKey: "signature:user:conflict" } }))
      .rejects.toMatchObject({ code: "SIGNATURE_IDEMPOTENCY_CONFLICT" });
  });
});
