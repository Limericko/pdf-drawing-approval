import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import { withPlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { PostgresOutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import { createWebDavSyncService } from "./webDavSyncService.ts";

const ids = {
  admin: "01890f1e-9b4a-7cc2-8f00-000000000501",
  member: "01890f1e-9b4a-7cc2-8f00-000000000502",
  project: "01890f1e-9b4a-7cc2-8f00-000000000503",
  storage: "01890f1e-9b4a-7cc2-8f00-000000000504",
  connection: "01890f1e-9b4a-7cc2-8f00-000000000505",
  mapping: "01890f1e-9b4a-7cc2-8f00-000000000506",
  item: "01890f1e-9b4a-7cc2-8f00-000000000507",
  conflict: "01890f1e-9b4a-7cc2-8f00-000000000508"
  ,failedItem: "01890f1e-9b4a-7cc2-8f00-00000000050d"
} as const;
const now = new Date("2026-07-14T11:00:00.000Z");

describe("Phase 5 WebDAV sync administration service", () => {
  it("creates idempotent connections without returning secrets and denies non-admin actors", async () => {
    await withHarness(async ({ migration, service }) => {
      const input = { actorUserId: ids.admin, requestId: "request-create-connection", connectionId: ids.connection,
        update: { name: "坚果云", endpointUrl: "https://dav.example.test/root/",
          credentialRef: "secret/webdav/test", reason: "首次接入",
          idempotencyKey: "webdav:connection:create:integration" } };
      const first = await service.createConnection(input);
      const retry = await service.createConnection(input);
      expect(retry).toEqual(first);
      expect(first).toMatchObject({ id: ids.connection, credentialRef: "secret/webdav/test",
        credentialAvailable: false, status: "active", version: 1 });
      expect(JSON.stringify(first)).not.toMatch(/password|authorization/i);
      await expect(service.createConnection({ ...input, actorUserId: ids.member }))
        .rejects.toMatchObject({ code: "WEBDAV_SYNC_FORBIDDEN" });
      const rows = await migration.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM platform.webdav_connections WHERE id=$1", [ids.connection]
      );
      expect(rows.rows[0]?.count).toBe(1);
    });
  });

  it("creates project mappings while rejecting directory overlap across the connection", async () => {
    await withHarness(async ({ service }) => {
      await createConnection(service);
      const created = await service.createMapping({ actorUserId: ids.admin, requestId: "request-create-mapping",
        mappingId: ids.mapping, update: { connectionId: ids.connection, projectId: ids.project,
          incomingPath: "/Incoming/GX", outgoingPath: "/Published/GX", publishVariant: "signed",
          scanIntervalSeconds: 300, reason: "项目接入", idempotencyKey: "webdav:mapping:create:integration" } });
      expect(created).toMatchObject({ id: ids.mapping, projectId: ids.project, projectName: "项目 A" });
      await expect(service.createMapping({ actorUserId: ids.admin, requestId: "request-overlap",
        mappingId: "01890f1e-9b4a-7cc2-8f00-000000000509", update: {
          connectionId: ids.connection, projectId: ids.project, incomingPath: "/Incoming/GX/Sub",
          outgoingPath: "/Published/Other", publishVariant: "original", scanIntervalSeconds: 300,
          reason: "错误重叠", idempotencyKey: "webdav:mapping:create:overlap" } }))
        .rejects.toMatchObject({ code: "WEBDAV_SYNC_PATH_OVERLAP" });
    });
  });

  it("queues connection tests and manual scans once with auditable reasons", async () => {
    await withHarness(async ({ migration, service }) => {
      await createConnection(service); await createMapping(service);
      await service.testConnection({ actorUserId: ids.admin, connectionId: ids.connection,
        requestId: "request-test", update: { reason: "验证凭据" } });
      await service.triggerScan({ actorUserId: ids.admin, requestId: "request-scan", update: {
        mappingId: ids.mapping, reason: "立即检查 Incoming", idempotencyKey: "webdav:scan:manual:integration" } });
      const events = await migration.query<{ event_type: string; payload: Record<string, string> }>(
        `SELECT event_type,payload FROM platform.outbox_events
         WHERE event_type LIKE 'webdav.%' ORDER BY created_at,id`
      );
      expect(events.rows).toMatchObject([
        { event_type: "webdav.connection.test", payload: { connectionId: ids.connection } },
        { event_type: "webdav.mapping.scan", payload: { mappingId: ids.mapping } }
      ]);
      const audits = await migration.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT action,metadata FROM platform.audit_events WHERE action LIKE 'webdav.%' ORDER BY occurred_at,id`
      );
      expect(audits.rows.some(({ action, metadata }) => action === "webdav.mapping.scan.requested" &&
        metadata.reason === "立即检查 Incoming")).toBe(true);
    });
  });

  it("resolves conflicts with optimistic concurrency and queues non-destructive follow-up", async () => {
    await withHarness(async ({ migration, service }) => {
      await createConnection(service); await createMapping(service); await seedConflict(migration);
      const resolved = await service.resolveConflict({ actorUserId: ids.admin, conflictId: ids.conflict,
        requestId: "request-resolve", update: { resolution: "publish_cloud_as_renamed",
          renamedRemotePath: "/Published/GX/A01-cloud.pdf", reason: "保留两端内容", version: 1,
          idempotencyKey: "webdav:conflict:resolve:integration" } });
      expect(resolved).toMatchObject({ id: ids.conflict, status: "resolved",
        resolution: "publish_cloud_as_renamed", version: 2 });
      await expect(service.resolveConflict({ actorUserId: ids.admin, conflictId: ids.conflict,
        requestId: "request-stale", update: { resolution: "keep_remote", renamedRemotePath: null,
          reason: "过期决定", version: 1, idempotencyKey: "webdav:conflict:resolve:stale" } }))
        .rejects.toMatchObject({ code: "WEBDAV_SYNC_STATE_CONFLICT" });
      const event = await migration.query<{ event_type: string }>(
        "SELECT event_type FROM platform.outbox_events WHERE event_type='webdav.conflict.resolve'"
      );
      expect(event.rowCount).toBe(1);
    });
  });

  it("lists diagnostics and safely retries failed items without changing cloud content", async () => {
    await withHarness(async ({ migration, service }) => {
      await createConnection(service); await createMapping(service); await seedConflict(migration);
      await migration.query(`INSERT INTO platform.webdav_sync_items
        (id,mapping_id,project_id,direction,remote_path,discovery_key,remote_size_bytes,status,last_error_code,
          created_at,updated_at)
        VALUES($1,$2,$3,'inbound','/Incoming/GX/retry.pdf','retry:event',10,'failed','WEBDAV_REMOTE_UNAVAILABLE',$4,$4)`,
      [ids.failedItem, ids.mapping, ids.project, now]);

      const conflicts = await service.listConflicts({ actorUserId: ids.admin, page: 1, pageSize: 20, status: "open" });
      expect(conflicts).toMatchObject({ page: { total: 1, pageCount: 1 }, items: [{ id: ids.conflict }] });
      const items = await service.listSyncItems({ actorUserId: ids.admin, page: 1, pageSize: 20, status: "failed" });
      expect(items).toMatchObject({ page: { total: 1 }, items: [{ id: ids.failedItem, status: "failed" }] });
      const summary = await service.getSummary({ actorUserId: ids.admin });
      expect(summary).toMatchObject({ connections: { active: 1, error: 0 }, mappings: { active: 1 },
        items: { failed: 1 }, openConflicts: 1 });

      const retried = await service.retrySyncItem({ actorUserId: ids.admin, syncItemId: ids.failedItem,
        requestId: "request-retry", update: { reason: "服务恢复",
          idempotencyKey: "webdav:sync:retry:integration" } });
      expect(retried).toMatchObject({ id: ids.failedItem, status: "discovered", lastErrorCode: null, version: 2 });
      const event = await migration.query<{ event_type: string }>(
        "SELECT event_type FROM platform.outbox_events WHERE event_type='webdav.sync.retry'"
      );
      expect(event.rowCount).toBe(1);
    });
  });
});

async function withHarness(run: (value: { migration: Pool; service: ReturnType<typeof createWebDavSyncService> }) => Promise<void>) {
  await withPlatformTestDatabase(async (database) => {
    const migration = database.createPool("migration"); await runMigrations(migration); await seed(migration);
    const web = database.createPool("web") as PlatformPool;
    Object.defineProperty(web, "transactionTimeouts", { value: Object.freeze({
      queryTimeoutMs: 30_000, lockTimeoutMs: 5_000, transactionTimeoutMs: 60_000
    }) });
    const idsToCreate = [ids.connection, ids.mapping, "01890f1e-9b4a-7cc2-8f00-00000000050a",
      "01890f1e-9b4a-7cc2-8f00-00000000050b", "01890f1e-9b4a-7cc2-8f00-00000000050c"];
    const createId = vi.fn(() => idsToCreate.shift() ?? (() => { throw new Error("id exhausted"); })());
    const service = createWebDavSyncService({ pool: web,
      publisher: new PostgresOutboxPublisher({ createId, clock: () => now }), createId, clock: () => now,
      allowEndpoint: (url) => url.protocol === "https:" && url.hostname === "dav.example.test" });
    await run({ migration, service });
  });
}

async function createConnection(service: ReturnType<typeof createWebDavSyncService>) {
  return service.createConnection({ actorUserId: ids.admin, requestId: "request-connection", connectionId: ids.connection,
    update: { name: "坚果云", endpointUrl: "https://dav.example.test/root/", credentialRef: "secret/webdav/test",
      reason: "接入", idempotencyKey: "webdav:connection:create:helper" } });
}
async function createMapping(service: ReturnType<typeof createWebDavSyncService>) {
  return service.createMapping({ actorUserId: ids.admin, requestId: "request-mapping", mappingId: ids.mapping,
    update: { connectionId: ids.connection, projectId: ids.project, incomingPath: "/Incoming/GX",
      outgoingPath: "/Published/GX", publishVariant: "signed", scanIntervalSeconds: 300,
      reason: "接入", idempotencyKey: "webdav:mapping:create:helper" } });
}
async function seed(pool: Pool) {
  await pool.query(`INSERT INTO platform.users
    (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status) VALUES
    ($1,'admin@example.test','管理员','$argon2id$seed','admin','active','enabled'),
    ($2,'member@example.test','成员','$argon2id$seed','member','active','enabled')`, [ids.admin, ids.member]);
  await pool.query("INSERT INTO platform.projects(id,name,status) VALUES($1,'项目 A','active')", [ids.project]);
  await pool.query(`INSERT INTO platform.storage_objects
    (id,status,driver,object_key,size_bytes,sha256,media_type,created_at,ready_at)
    VALUES($1,'ready','filesystem','phase5/cloud.pdf',4,decode(repeat('42',32),'hex'),'application/pdf',$2,$2)`,
    [ids.storage, now]);
}
async function seedConflict(pool: Pool) {
  await pool.query(`INSERT INTO platform.webdav_sync_items
    (id,mapping_id,project_id,direction,remote_path,discovery_key,remote_size_bytes,remote_sha256,
      storage_object_id,status,created_at,updated_at)
    VALUES($1,$2,$3,'outbound','/Published/GX/A01.pdf','publish:A01',8,decode(repeat('11',32),'hex'),
      $4,'conflict',$5,$5)`, [ids.item, ids.mapping, ids.project, ids.storage, now]);
  await pool.query(`INSERT INTO platform.webdav_sync_conflicts
    (id,mapping_id,project_id,sync_item_id,direction,remote_path,remote_size_bytes,remote_sha256,
      cloud_object_id,cloud_size_bytes,cloud_sha256,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'outbound','/Published/GX/A01.pdf',8,decode(repeat('11',32),'hex'),
      $5,4,decode(repeat('42',32),'hex'),'open',$6,$6)`,
    [ids.conflict, ids.mapping, ids.project, ids.item, ids.storage, now]);
}
