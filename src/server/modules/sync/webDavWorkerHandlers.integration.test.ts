import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { PDFDocument } from "pdf-lib";
import type { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../platform/database/migrationRunner.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import { withPlatformTestDatabase } from "../../platform/testing/postgresHarness.ts";
import { createStorage } from "../../platform/storage/createStorage.ts";
import { StorageObjectService } from "../../platform/storage/storageObjectService.ts";
import { PostgresStorageObjectRepository } from "../../platform/storage/postgres/PostgresStorageObjectRepository.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { PostgresOutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";
import { createWebDavCredentialProvider } from "./webDavCredentialProvider.ts";
import { createWebDavEndpointPolicy } from "./webDavEndpointPolicy.ts";
import { createWebDavWorkerHandlers } from "./webDavWorkerHandlers.ts";
import { WebDavScanScheduler } from "./webDavScanScheduler.ts";

const ids = {
  admin: "01890f1e-9b4a-7cc2-8f00-000000004001",
  project: "01890f1e-9b4a-7cc2-8f00-000000004002",
  connection: "01890f1e-9b4a-7cc2-8f00-000000004003",
  mapping: "01890f1e-9b4a-7cc2-8f00-000000004004",
  document: "01890f1e-9b4a-7cc2-8f00-000000004005",
  revision: "01890f1e-9b4a-7cc2-8f00-000000004006",
  approval: "01890f1e-9b4a-7cc2-8f00-000000004007"
} as const;
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("Phase 5 WebDAV worker real HTTP loop", () => {
  it("records a connection check even when the application clock is behind the database row", async () => {
    await withHarness(async ({ migration, handlers }) => {
      await migration.query(
        `UPDATE platform.webdav_connections
         SET created_at=clock_timestamp()+interval '1 second',
             updated_at=clock_timestamp()+interval '1 second'
         WHERE id=$1`,
        [ids.connection]
      );

      await handlers.testConnection(job({ connectionId: ids.connection }));

      await expect(migration.query(
        `SELECT last_checked_at>=created_at AS valid_checked_at,
                updated_at>=created_at AS valid_updated_at
         FROM platform.webdav_connections WHERE id=$1`,
        [ids.connection]
      )).resolves.toMatchObject({ rows: [{ valid_checked_at: true, valid_updated_at: true }] });
    });
  });

  it("resumes an inbound PDF, imports once, and never propagates remote deletion", async () => {
    await withHarness(async ({ migration, handlers, fixture, stagingRoot, scheduler }) => {
      const pdf = await pdfBytes("inbound");
      const remotePath = "/Incoming/GX/MP300A000072《M-100 阀体》a0A0.pdf";
      fixture.files.set(remotePath, pdf);

      await handlers.testConnection(job({ connectionId: ids.connection }));
      expect((await migration.query<{ credential_available: boolean; move: boolean }>(
        "SELECT credential_available,(capabilities->>'move')::boolean AS move FROM platform.webdav_connections WHERE id=$1",
        [ids.connection]
      )).rows[0]).toMatchObject({ credential_available: true, move: true });
      await expect(scheduler.runOnce(new AbortController().signal)).resolves.toEqual({ scheduled: 1 });
      await expect(scheduler.runOnce(new AbortController().signal)).resolves.toEqual({ scheduled: 0 });
      await handlers.scanMapping(job({ mappingId: ids.mapping }));
      const discovered = await migration.query<{ id: string }>(
        "SELECT id FROM platform.webdav_sync_items WHERE direction='inbound'"
      );
      const syncItemId = discovered.rows[0]!.id;
      await mkdir(stagingRoot, { recursive: true });
      await writeFile(path.join(stagingRoot, `${syncItemId}.partial`), pdf.subarray(0, 24));

      await handlers.processSyncItem(job({ syncItemId }));
      expect(fixture.ranges).toContain("bytes=24-");
      const imported = await migration.query<{ status: string; source: string; revision_count: number }>(
        `SELECT item.status,revision.source,
          (SELECT count(*)::int FROM platform.drawing_revisions WHERE source='webdav_import') AS revision_count
         FROM platform.webdav_sync_items item
         INNER JOIN platform.drawing_revisions revision ON revision.id=item.revision_id WHERE item.id=$1`, [syncItemId]
      );
      expect(imported.rows[0]).toMatchObject({ status: "imported", source: "webdav_import", revision_count: 1 });

      await handlers.scanMapping(job({ mappingId: ids.mapping }));
      expect((await migration.query("SELECT 1 FROM platform.webdav_sync_items WHERE direction='inbound'")).rowCount).toBe(1);
      fixture.files.delete(remotePath);
      await handlers.scanMapping(job({ mappingId: ids.mapping }));
      expect((await migration.query<{ status: string }>(
        "SELECT status FROM platform.webdav_sync_items WHERE id=$1", [syncItemId]
      )).rows[0]?.status).toBe("remote_missing");
      expect((await migration.query("SELECT 1 FROM platform.drawing_revisions WHERE source='webdav_import'")).rowCount)
        .toBe(1);
    });
  });

  it("recovers from offline state and publishes by temporary PUT, MOVE, and hash readback", async () => {
    await withHarness(async ({ migration, handlers, fixture, createObject }) => {
      const pdf = await pdfBytes("outbound");
      const objectId = await createObject(pdf);
      await seedPublished(migration, objectId);
      await handlers.enqueuePublishedRevision(job({ projectId: ids.project, approvalId: ids.approval,
        revisionId: ids.revision }));
      const item = await migration.query<{ id: string; remote_path: string }>(
        "SELECT id,remote_path FROM platform.webdav_sync_items WHERE direction='outbound'"
      );
      const syncItemId = item.rows[0]!.id;

      fixture.offline = true;
      await expect(handlers.processSyncItem(job({ syncItemId }))).rejects.toMatchObject({
        kind: "transient", code: "WEBDAV_REMOTE_UNAVAILABLE"
      });
      fixture.offline = false;
      await handlers.processSyncItem(job({ syncItemId }));

      const final = fixture.files.get(item.rows[0]!.remote_path);
      expect(final).toEqual(pdf);
      expect(fixture.methods).toEqual(expect.arrayContaining(["PUT", "MOVE", "GET"]));
      expect([...fixture.files.keys()].some((key) => key.includes(".partial-"))).toBe(false);
      expect((await migration.query<{ status: string; remote_sha256: Buffer }>(
        "SELECT status,remote_sha256 FROM platform.webdav_sync_items WHERE id=$1", [syncItemId]
      )).rows[0]).toMatchObject({ status: "succeeded", remote_sha256: createHash("sha256").update(pdf).digest() });
    });
  });

  it("queues a conflict instead of overwriting a different remote published path", async () => {
    await withHarness(async ({ migration, handlers, fixture, createObject }) => {
      const cloud = await pdfBytes("cloud");
      const objectId = await createObject(cloud);
      await seedPublished(migration, objectId);
      await handlers.enqueuePublishedRevision(job({ projectId: ids.project, approvalId: ids.approval,
        revisionId: ids.revision }));
      const item = (await migration.query<{ id: string; remote_path: string }>(
        "SELECT id,remote_path FROM platform.webdav_sync_items WHERE direction='outbound'"
      )).rows[0]!;
      const remote = await pdfBytes("remote-different");
      fixture.files.set(item.remote_path, remote);

      await handlers.processSyncItem(job({ syncItemId: item.id }));
      expect(fixture.files.get(item.remote_path)).toEqual(remote);
      expect(fixture.methods).not.toContain("PUT");
      expect((await migration.query<{ status: string; conflicts: number }>(
        `SELECT item.status,(SELECT count(*)::int FROM platform.webdav_sync_conflicts WHERE sync_item_id=item.id)
          AS conflicts FROM platform.webdav_sync_items item WHERE item.id=$1`, [item.id]
      )).rows[0]).toMatchObject({ status: "conflict", conflicts: 1 });
    });
  });
});

async function withHarness(run: (value: {
  migration: Pool;
  handlers: ReturnType<typeof createWebDavWorkerHandlers>;
  fixture: Awaited<ReturnType<typeof startWebDavFixture>>;
  stagingRoot: string;
  scheduler: WebDavScanScheduler;
  createObject(bytes: Buffer): Promise<string>;
}) => Promise<void>) {
  await withPlatformTestDatabase(async (database) => {
    const fixture = await startWebDavFixture();
    const root = await mkdtemp(path.join(tmpdir(), "pdf-approval-webdav-worker-")); cleanup.push(root);
    const storageRoot = path.join(root, "objects"); const stagingRoot = path.join(root, "staging");
    const migration = database.createPool("migration"); await runMigrations(migration);
    await seedBase(migration, fixture.endpointUrl);
    const worker = database.createPool("worker") as PlatformPool;
    Object.defineProperty(worker, "transactionTimeouts", { value: Object.freeze({
      queryTimeoutMs: 30_000, lockTimeoutMs: 5_000, transactionTimeoutMs: 60_000
    }) });
    const storage = createStorage({ driver: "filesystem", root: storageRoot });
    const publisher = new PostgresOutboxPublisher({ createId: uuidv7, clock: () => new Date() });
    const handlers = createWebDavWorkerHandlers({ pool: worker, storage,
      credentials: createWebDavCredentialProvider({ driver: "inline", entries: new Map([["secret/test", {
        username: "tester", password: "password"
      }]]) }), publisher, endpointPolicy: createWebDavEndpointPolicy({ environment: "test", allowedHosts: [] }),
      stagingRoot });
    const scheduler = new WebDavScanScheduler({ pool: worker, publisher });
    const objectService = new StorageObjectService({ storage,
      transactionRunner: (callback) => withTransaction(worker, callback),
      createRepository: (executor) => new PostgresStorageObjectRepository(executor) });
    try {
      await run({ migration, handlers, fixture, stagingRoot, scheduler,
        createObject: async (bytes) => (await objectService.create({ body: Readable.from(bytes),
          mediaType: "application/pdf" })).id });
    } finally {
      await fixture.close();
      if ("destroy" in storage && typeof storage.destroy === "function") storage.destroy();
    }
  });
}

async function seedBase(pool: Pool, endpointUrl: string) {
  await pool.query(`INSERT INTO platform.users
    (id,email_normalized,display_name,password_hash,platform_role,status,mfa_status)
    VALUES($1,'admin@example.test','管理员','$argon2id$seed','admin','active','enabled')`, [ids.admin]);
  await pool.query("INSERT INTO platform.projects(id,name,status) VALUES($1,'项目 A','active')", [ids.project]);
  await pool.query(`INSERT INTO platform.webdav_connections
    (id,name,endpoint_url,credential_ref,credential_available,status,capabilities,created_by_user_id)
    VALUES($1,'测试 WebDAV',$2,'secret/test',true,'active','{"class1":true,"move":true,"rangeDownload":true}',$3)`,
  [ids.connection, endpointUrl, ids.admin]);
  await pool.query(`INSERT INTO platform.webdav_directory_mappings
    (id,connection_id,project_id,incoming_path,outgoing_path,publish_variant,status,scan_interval_seconds,
      created_by_user_id)
    VALUES($1,$2,$3,'/Incoming/GX','/Published/GX','original','active',300,$4)`,
  [ids.mapping, ids.connection, ids.project, ids.admin]);
}

async function seedPublished(pool: Pool, objectId: string) {
  const now = new Date();
  await pool.query(`INSERT INTO platform.documents
    (id,project_id,document_code,name,created_by_user_id) VALUES($1,$2,'MP300A000072','阀体',$3)`,
  [ids.document, ids.project, ids.admin]);
  await pool.query(`INSERT INTO platform.drawing_revisions
    (id,project_id,document_id,revision_code,original_object_id,source,status,metadata_status,material_code,
      created_by_user_id,published_at,created_at,updated_at)
    VALUES($1,$2,$3,'a0A0',$4,'web_upload','published','complete','M-100',$5,$6,$6,$6)`,
  [ids.revision, ids.project, ids.document, objectId, ids.admin, now]);
  await pool.query(`INSERT INTO platform.approval_cases
    (id,project_id,revision_id,status,requires_signature,created_by_user_id,completed_at,created_at,updated_at)
    VALUES($1,$2,$3,'approved',false,$4,$5,$5,$5)`, [ids.approval, ids.project, ids.revision, ids.admin, now]);
}

async function pdfBytes(text: string) {
  const pdf = await PDFDocument.create(); pdf.addPage().drawText(text);
  return Buffer.from(await pdf.save());
}

function job(payload: Record<string, string>) { return { payload } as never; }

async function startWebDavFixture() {
  const files = new Map<string, Buffer>(); const methods: string[] = []; const ranges: string[] = [];
  const state = { offline: false };
  const server = createServer(async (request, response) => {
    methods.push(request.method ?? "");
    if (state.offline) { response.statusCode = 503; response.end(); return; }
    if (request.headers.authorization !== `Basic ${Buffer.from("tester:password").toString("base64")}`) {
      response.statusCode = 401; response.end(); return;
    }
    const remotePath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
      .replace(/^\/root/, "") || "/";
    if (request.method === "OPTIONS") {
      response.writeHead(204, { DAV: "1", Allow: "OPTIONS, PROPFIND, HEAD, GET, PUT, MOVE, DELETE",
        "Accept-Ranges": "bytes" }); response.end(); return;
    }
    if (request.method === "PROPFIND") {
      const children = [...files.entries()].filter(([entry]) => entry.startsWith(`${remotePath}/`));
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/root${remotePath}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
        ${children.map(([entry, bytes]) => `<d:response><d:href>/root${encodePath(entry)}</d:href><d:propstat><d:prop>
          <d:getetag>${escapeXml(etag(bytes))}</d:getetag><d:getcontentlength>${bytes.length}</d:getcontentlength>
          <d:getlastmodified>${new Date("2026-07-14T10:00:00Z").toUTCString()}</d:getlastmodified><d:resourcetype/>
          </d:prop></d:propstat></d:response>`).join("")}</d:multistatus>`;
      response.writeHead(207, { "Content-Type": "application/xml" }); response.end(xml); return;
    }
    const bytes = files.get(remotePath);
    if (request.method === "HEAD") { head(response, bytes); return; }
    if (request.method === "GET") {
      if (!bytes) { response.statusCode = 404; response.end(); return; }
      const range = request.headers.range; if (range) ranges.push(range);
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const body = bytes.subarray(start);
      response.writeHead(range ? 206 : 200, { "Content-Length": body.length, ETag: etag(bytes),
        ...(range ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) });
      response.end(body); return;
    }
    if (request.method === "PUT") {
      if (files.has(remotePath)) { response.statusCode = 412; response.end(); return; }
      const body = await readRequest(request); files.set(remotePath, body);
      response.writeHead(201, { ETag: etag(body) }); response.end(); return;
    }
    if (request.method === "MOVE") {
      const source = files.get(remotePath); const destination = request.headers.destination;
      if (!source || !destination) { response.statusCode = 409; response.end(); return; }
      const target = decodeURIComponent(new URL(Array.isArray(destination) ? destination[0]! : destination).pathname)
        .replace(/^\/root/, "");
      if (files.has(target)) { response.statusCode = 412; response.end(); return; }
      files.set(target, source); files.delete(remotePath); response.statusCode = 201; response.end(); return;
    }
    if (request.method === "DELETE") {
      const removed = files.delete(remotePath); response.statusCode = removed ? 204 : 404; response.end(); return;
    }
    response.statusCode = 405; response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture failed");
  return {
    files, methods, ranges,
    get offline() { return state.offline; }, set offline(value: boolean) { state.offline = value; },
    endpointUrl: `http://127.0.0.1:${address.port}/root/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function head(response: ServerResponse, bytes: Buffer | undefined) {
  if (!bytes) { response.statusCode = 404; response.end(); return; }
  response.writeHead(200, { "Content-Length": bytes.length, ETag: etag(bytes),
    "Last-Modified": new Date("2026-07-14T10:00:00Z").toUTCString() }); response.end();
}
function etag(bytes: Buffer) { return `"${createHash("sha256").update(bytes).digest("hex")}"`; }
function escapeXml(value: string) { return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;"); }
function encodePath(value: string) { return value.split("/").map(encodeURIComponent).join("/"); }
async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
