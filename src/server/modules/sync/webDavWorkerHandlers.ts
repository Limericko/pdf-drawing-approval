import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PDFDocument } from "pdf-lib";
import type { QueryResultRow } from "pg";
import { v7 as uuidv7 } from "uuid";
import { uuidV7Schema } from "../../../shared/contracts/common.ts";
import { parseDrawingFileName } from "../../files/parseDrawingFileName.ts";
import type { PlatformPool } from "../../platform/database/pool.ts";
import type { QueryExecutor } from "../../platform/database/queryExecutor.ts";
import { withTransaction } from "../../platform/database/transaction.ts";
import { JobHandlerError, type JobHandler } from "../../platform/jobs/jobRegistry.ts";
import type { OutboxPublisher } from "../../platform/jobs/outboxPublisher.ts";
import { PostgresAuditRepository } from "../identity/repositories/postgres/PostgresAuditRepository.ts";
import { PostgresStorageObjectRepository } from "../../platform/storage/postgres/PostgresStorageObjectRepository.ts";
import type { StorageAdapter } from "../../platform/storage/storageAdapter.ts";
import { StorageObjectService } from "../../platform/storage/storageObjectService.ts";
import { createWebDavClient, WebDavClientError } from "./webDavClient.ts";
import { WebDavCredentialError, type WebDavCredentialProvider } from "./webDavCredentialProvider.ts";
import { WebDavNetworkGuardError } from "./webDavNetworkGuard.ts";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const SCAN_LEASE_MS = 5 * 60 * 1000;

type MappingConnectionRow = QueryResultRow & {
  mapping_id: string; project_id: string; incoming_path: string; outgoing_path: string;
  publish_variant: "original" | "review" | "signed"; mapping_status: "active" | "disabled";
  created_by_user_id: string; connection_id: string; endpoint_url: string; credential_ref: string;
  connection_status: "active" | "disabled" | "error"; capabilities: Record<string, unknown>;
};
type SyncRow = MappingConnectionRow & {
  id: string; direction: "inbound" | "outbound"; remote_path: string; discovery_key: string;
  remote_etag: string | null; remote_size_bytes: string | number | null; remote_modified_at: Date | null;
  remote_sha256: Buffer | null; storage_object_id: string | null; revision_id: string | null;
  status: string; version: number; object_key: string | null; object_driver: StorageAdapter["driver"] | null;
  object_size_bytes: string | number | null; object_sha256: Buffer | null; object_media_type: string | null;
};
type ExistingRevisionRow = QueryResultRow & {
  revision_id: string; revision_code: string; object_id: string; size_bytes: string | number; sha256: Buffer;
};
type PublishedMappingRow = QueryResultRow & {
  mapping_id: string; project_id: string; outgoing_path: string; publish_variant: "original" | "review" | "signed";
  document_code: string; document_name: string; revision_code: string; material_code: string | null;
  object_id: string | null;
};

export function createWebDavWorkerHandlers(options: {
  readonly pool: PlatformPool;
  readonly storage: StorageAdapter;
  readonly credentials: WebDavCredentialProvider;
  readonly publisher: OutboxPublisher;
  readonly endpointPolicy: (url: URL) => boolean;
  readonly stagingRoot: string;
  readonly createId?: () => string;
  readonly clock?: () => Date;
  readonly fetch?: typeof fetch;
  readonly validateEndpoint?: (url: URL) => Promise<void>;
}) {
  if (!options?.pool || !options.storage || !options.credentials || !options.publisher ||
      typeof options.endpointPolicy !== "function" || !path.isAbsolute(options.stagingRoot)) {
    throw new Error("WEBDAV_WORKER_OPTIONS_INVALID");
  }
  const createId = options.createId ?? uuidv7;
  const clock = options.clock ?? (() => new Date());
  const storageObjects = new StorageObjectService({ storage: options.storage,
    transactionRunner: (callback) => withTransaction(options.pool, callback),
    createRepository: (executor) => new PostgresStorageObjectRepository(executor), createId, clock });

  const testConnection: JobHandler = async (job) => {
    const connectionId = payloadId(job.payload, "connectionId");
    const row = await oneConnection(options.pool, connectionId);
    try {
      const client = await clientFor(options, row);
      const capabilities = await client.probe();
      await options.pool.query(
        `UPDATE platform.webdav_connections SET credential_available=true,status='active',capabilities=$2,
          last_checked_at=$3,last_error_code=NULL,version=version+1,updated_at=$3 WHERE id=$1`,
        [connectionId, capabilities, ownDate(clock())]
      );
    } catch (error) {
      const owned = asJobError(error, "WEBDAV_CONNECTION_TEST_FAILED");
      await options.pool.query(
        `UPDATE platform.webdav_connections SET credential_available=$2,status='error',last_checked_at=$3,
          last_error_code=$4,version=version+1,updated_at=$3 WHERE id=$1`,
        [connectionId, !(error instanceof WebDavCredentialError), ownDate(clock()), owned.code]
      ).catch(() => undefined);
      throw owned;
    }
  };

  const scanMapping: JobHandler = async (job) => {
    const mappingId = payloadId(job.payload, "mappingId");
    const leaseToken = ownCreatedId(createId());
    const mapping = await claimMapping(options.pool, mappingId, leaseToken, ownDate(clock()));
    if (!mapping) return;
    try {
      const client = await clientFor(options, mapping);
      const entries = await client.list(mapping.incoming_path);
      await persistScan(options, mapping, entries, leaseToken, ownDate(clock()), createId);
    } catch (error) {
      await releaseMapping(options.pool, mappingId, leaseToken, ownDate(clock()), false).catch(() => undefined);
      throw asJobError(error, "WEBDAV_SCAN_FAILED");
    }
  };

  const processSyncItem: JobHandler = async (job) => {
    const syncItemId = await syncItemIdFromPayload(options.pool, job.payload);
    const item = await oneSyncItem(options.pool, syncItemId);
    if (["imported", "succeeded", "skipped"].includes(item.status)) return;
    try {
      if (item.direction === "inbound") {
        await processInbound(options, storageObjects, item, createId, clock);
      } else {
        await processOutbound(options, item, clock);
      }
    } catch (error) {
      if (!(error instanceof SyncTerminalState)) {
        const owned = asJobError(error, "WEBDAV_SYNC_FAILED");
        await markFailed(options.pool, item.id, owned.code, ownDate(clock())).catch(() => undefined);
        throw owned;
      }
    }
  };

  const enqueuePublishedRevision: JobHandler = async (job) => {
    const payload = exactIds(job.payload, ["projectId", "approvalId", "revisionId"] as const);
    await enqueuePublished(options, payload, createId, ownDate(clock()));
  };

  return Object.freeze({ testConnection, scanMapping, processSyncItem, enqueuePublishedRevision });
}

async function persistScan(options: Parameters<typeof createWebDavWorkerHandlers>[0], mapping: MappingConnectionRow,
  entries: readonly { path: string; etag: string | null; sizeBytes: number | null; modifiedAt: Date | null }[],
  leaseToken: string, at: Date, createId: () => string) {
  await withTransaction(options.pool, async (transaction) => {
    const visiblePaths: string[] = [];
    for (const entry of entries) {
      if (!entry.path.startsWith(`${mapping.incoming_path}/`) || !entry.path.toLowerCase().endsWith(".pdf")) continue;
      visiblePaths.push(entry.path);
      const discoveryKey = discovery(entry);
      const inserted = await transaction.query<{ id: string }>(
        `INSERT INTO platform.webdav_sync_items
          (id,mapping_id,project_id,direction,remote_path,discovery_key,remote_etag,remote_size_bytes,
            remote_modified_at,status,created_at,updated_at)
         VALUES($1,$2,$3,'inbound',$4,$5,$6,$7,$8,'discovered',$9,$9)
         ON CONFLICT DO NOTHING RETURNING id`,
        [ownCreatedId(createId()), mapping.mapping_id, mapping.project_id, entry.path, discoveryKey, entry.etag,
          entry.sizeBytes, entry.modifiedAt, at]
      );
      let syncItemId = inserted.rows[0]?.id;
      if (!syncItemId) {
        const active = await transaction.query<{ id: string; discovery_key: string; status: string }>(
          `SELECT id,discovery_key,status FROM platform.webdav_sync_items
           WHERE mapping_id=$1 AND direction='inbound' AND remote_path=$2
             AND status IN ('discovered','downloading','validating','pending_upload','uploading','verifying',
               'conflict','remote_missing','failed') FOR UPDATE`, [mapping.mapping_id, entry.path]
        );
        const current = active.rows[0];
        if (current?.status === "remote_missing" && current.discovery_key === discoveryKey) {
          await transaction.query(
            `UPDATE platform.webdav_sync_items SET status='discovered',last_error_code=NULL,version=version+1,
              updated_at=$2 WHERE id=$1`, [current.id, at]
          );
          syncItemId = current.id;
        } else if (current && current.discovery_key !== discoveryKey) {
          await openConflict(transaction, current.id, mapping.project_id, mapping.mapping_id, "inbound", entry.path,
            { etag: entry.etag, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt, sha256: null }, null, at, createId);
          continue;
        }
      }
      if (syncItemId) {
        await options.publisher.publishIdempotent(transaction, {
          eventType: "webdav.sync.requested", payloadVersion: 1, payload: { syncItemId }
        }, `webdav-sync-requested:${syncItemId}:1`);
      }
    }
    await transaction.query(
      `UPDATE platform.webdav_sync_items SET status='remote_missing',completed_at=NULL,
        last_error_code='WEBDAV_REMOTE_MISSING',version=version+1,updated_at=$3
       WHERE mapping_id=$1 AND direction='inbound' AND status IN ('imported','succeeded')
         AND NOT (remote_path=ANY($2::text[]))`, [mapping.mapping_id, visiblePaths, at]
    );
    const released = await transaction.query(
      `UPDATE platform.webdav_directory_mappings SET scan_lease_token=NULL,scan_lease_expires_at=NULL,
        last_scan_at=$3,last_success_at=$3,updated_at=$3 WHERE id=$1 AND scan_lease_token=$2`,
      [mapping.mapping_id, leaseToken, at]
    );
    if (released.rowCount !== 1) throw new Error("WEBDAV_SCAN_LEASE_LOST");
  });
}

async function processInbound(options: Parameters<typeof createWebDavWorkerHandlers>[0],
  storageObjects: StorageObjectService, item: SyncRow, createId: () => string, clock: () => Date) {
  const client = await clientFor(options, item);
  const at = ownDate(clock());
  await setItemState(options.pool, item.id, ["discovered", "failed", "remote_missing"], "downloading", at);
  const before = await client.head(item.remote_path);
  if (!before) {
    await markRemoteMissing(options.pool, item.id, ownDate(clock()));
    throw new SyncTerminalState();
  }
  if (metadataChanged(item, before)) {
    await conflictForChangedRemote(options.pool, item, before, null, ownDate(clock()), createId);
    throw new SyncTerminalState();
  }
  const temporary = quarantinePath(options.stagingRoot, item.id);
  await mkdir(options.stagingRoot, { recursive: true });
  await downloadResumable(client, item.remote_path, temporary, before.sizeBytes);
  const after = await client.head(item.remote_path);
  if (!after || changedBetween(before, after)) {
    await conflictForChangedRemote(options.pool, item, after ?? before, null, ownDate(clock()), createId);
    throw new SyncTerminalState();
  }
  await setItemState(options.pool, item.id, ["downloading"], "validating", ownDate(clock()));
  const bytes = await readFile(temporary);
  await validatePdf(bytes);
  const sha256 = createHash("sha256").update(bytes).digest();
  const parsed = parseDrawingFileName(item.remote_path);
  if (!parsed) throw permanent("WEBDAV_FILENAME_INVALID");
  const documentCode = (parsed.documentCode ?? parsed.partName).slice(0, 160);
  const existing = await findRevision(options.pool, item.project_id, documentCode, parsed.version);
  if (existing && existing.sha256.equals(sha256)) {
    await markImported(options.pool, item.id, existing.object_id, existing.revision_id, sha256, bytes.length,
      after, ownDate(clock()));
    await safeUnlink(temporary);
    return;
  }
  const importOverride = existing ? await allowsImportAsNew(options.pool, item.id) : false;
  if (existing && !importOverride) {
    await openInboundConflict(options.pool, item, after, sha256, bytes.length, existing, ownDate(clock()), createId);
    throw new SyncTerminalState();
  }
  const object = await storageObjects.create({ body: Readable.from(bytes), mediaType: "application/pdf" });
  if (!object.sha256?.equals(sha256)) throw transient("WEBDAV_STORAGE_HASH_MISMATCH");
  const revisionCode = existing ? await nextRevisionCode(options.pool, existing.revision_id, parsed.version) : parsed.version;
  const revisionId = await importDraft(options, item, { documentCode, name: parsed.drawingName,
    revisionCode, materialCode: parsed.materialCode, metadataStatus: parsed.metadataStatus, objectId: object.id },
  createId, ownDate(clock()));
  await markImported(options.pool, item.id, object.id, revisionId, sha256, bytes.length, after, ownDate(clock()));
  await safeUnlink(temporary);
}

async function processOutbound(options: Parameters<typeof createWebDavWorkerHandlers>[0], item: SyncRow,
  clock: () => Date) {
  if (!item.storage_object_id || !item.object_key || !item.object_sha256 || item.object_size_bytes === null ||
      item.object_driver !== options.storage.driver || item.object_media_type !== "application/pdf") {
    throw permanent("WEBDAV_OUTBOUND_OBJECT_NOT_READY");
  }
  const client = await clientFor(options, item);
  const finalPath = await resolvedOutboundPath(options.pool, item);
  await setItemState(options.pool, item.id, ["pending_upload", "failed", "remote_missing"], "uploading", ownDate(clock()));
  const existing = await client.head(finalPath);
  if (existing) {
    const remoteSha = await remoteHash(client, finalPath, existing.sizeBytes);
    if (remoteSha.equals(item.object_sha256)) {
      await markSucceeded(options.pool, item.id, finalPath, existing, remoteSha, ownDate(clock()));
      return;
    }
    await openOutboundConflict(options, item, finalPath, existing, remoteSha, ownDate(clock()));
    throw new SyncTerminalState();
  }
  if (item.capabilities.move !== true) throw permanent("WEBDAV_MOVE_UNSUPPORTED");
  const temporaryPath = outboundTemporaryPath(finalPath, item.id);
  await client.removeTemporary(temporaryPath);
  const source = await options.storage.openRead(item.object_key);
  await client.put(temporaryPath, Readable.toWeb(source) as unknown as BodyInit);
  try {
    await client.move(temporaryPath, finalPath);
  } catch (error) {
    await client.removeTemporary(temporaryPath).catch(() => undefined);
    throw error;
  }
  await setItemState(options.pool, item.id, ["uploading"], "verifying", ownDate(clock()));
  const verified = await client.head(finalPath);
  if (!verified) throw transient("WEBDAV_VERIFY_MISSING");
  const remoteSha = await remoteHash(client, finalPath, verified.sizeBytes);
  if (verified.sizeBytes !== Number(item.object_size_bytes) || !remoteSha.equals(item.object_sha256)) {
    await openOutboundConflict(options, item, finalPath, verified, remoteSha, ownDate(clock()));
    throw new SyncTerminalState();
  }
  await markSucceeded(options.pool, item.id, finalPath, verified, remoteSha, ownDate(clock()));
}

async function enqueuePublished(options: Parameters<typeof createWebDavWorkerHandlers>[0],
  payload: { projectId: string; approvalId: string; revisionId: string }, createId: () => string, at: Date) {
  const mappings = await options.pool.query<PublishedMappingRow>(
    `SELECT mapping.id AS mapping_id,mapping.project_id,mapping.outgoing_path,mapping.publish_variant,
       document.document_code,document.name AS document_name,revision.revision_code,revision.material_code,
       CASE mapping.publish_variant WHEN 'original' THEN revision.original_object_id
         WHEN 'review' THEN annotated.object_id WHEN 'signed' THEN signed.object_id END AS object_id
     FROM platform.webdav_directory_mappings mapping
     INNER JOIN platform.webdav_connections connection ON connection.id=mapping.connection_id AND connection.status='active'
     INNER JOIN platform.drawing_revisions revision ON revision.id=$2 AND revision.project_id=mapping.project_id
     INNER JOIN platform.documents document ON document.id=revision.document_id
     LEFT JOIN LATERAL (SELECT object_id FROM platform.render_artifacts WHERE approval_case_id=$3
       AND kind='annotated_review' AND status='ready' ORDER BY generation DESC LIMIT 1) annotated ON true
     LEFT JOIN LATERAL (SELECT object_id FROM platform.render_artifacts WHERE approval_case_id=$3
       AND kind='signed_pdf' AND status='ready' ORDER BY generation DESC LIMIT 1) signed ON true
     WHERE mapping.project_id=$1 AND mapping.status='active'`,
    [payload.projectId, payload.revisionId, payload.approvalId]
  );
  await withTransaction(options.pool, async (transaction) => {
    for (const mapping of mappings.rows) {
      const remotePath = `${mapping.outgoing_path}/${publishedFileName(mapping)}`;
      const status = mapping.object_id ? "pending_upload" : "failed";
      const id = ownCreatedId(createId());
      const inserted = await transaction.query<{ id: string }>(
        `INSERT INTO platform.webdav_sync_items
          (id,mapping_id,project_id,direction,remote_path,discovery_key,storage_object_id,revision_id,status,
            last_error_code,created_at,updated_at)
         VALUES($1,$2,$3,'outbound',$4,$5,$6,$7,$8,$9,$10,$10)
         ON CONFLICT (mapping_id,direction,discovery_key) DO NOTHING RETURNING id`,
        [id, mapping.mapping_id, mapping.project_id, remotePath,
          `pdm:${payload.revisionId}:${mapping.publish_variant}`, mapping.object_id, payload.revisionId, status,
          mapping.object_id ? null : "WEBDAV_OUTBOUND_OBJECT_NOT_READY", at]
      );
      if (inserted.rows[0] && mapping.object_id) {
        await options.publisher.publishIdempotent(transaction, {
          eventType: "webdav.sync.requested", payloadVersion: 1, payload: { syncItemId: id }
        }, `webdav-sync-requested:${id}:1`);
      }
    }
  });
}

async function importDraft(options: Parameters<typeof createWebDavWorkerHandlers>[0], item: SyncRow,
  input: { documentCode: string; name: string; revisionCode: string; materialCode: string | null;
    metadataStatus: string; objectId: string }, createId: () => string, at: Date) {
  return withTransaction(options.pool, async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`webdav-import:${item.project_id}:${input.documentCode}:${input.revisionCode}`]);
    await transaction.query(
      `INSERT INTO platform.documents(id,project_id,document_code,name,created_by_user_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(project_id,document_code) DO NOTHING`,
      [ownCreatedId(createId()), item.project_id, input.documentCode, input.name, item.created_by_user_id, at]
    );
    const document = await transaction.query<{ id: string }>(
      "SELECT id FROM platform.documents WHERE project_id=$1 AND document_code=$2",
      [item.project_id, input.documentCode]
    );
    if (!document.rows[0]) throw new Error("WEBDAV_IMPORT_DOCUMENT_MISSING");
    const revisionId = ownCreatedId(createId());
    const inserted = await transaction.query<{ id: string }>(
      `INSERT INTO platform.drawing_revisions
        (id,project_id,document_id,revision_code,original_object_id,source,status,metadata_status,material_code,
          client_request_id,created_by_user_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,'webdav_import','draft',$6,$7,$8,$9,$10,$10)
       ON CONFLICT DO NOTHING RETURNING id`,
      [revisionId, item.project_id, document.rows[0].id, input.revisionCode, input.objectId, input.metadataStatus,
        input.materialCode, `webdav-import:${item.id}`, item.created_by_user_id, at]
    );
    const winner = inserted.rows[0] ?? (await transaction.query<{ id: string }>(
      "SELECT id FROM platform.drawing_revisions WHERE client_request_id=$1", [`webdav-import:${item.id}`]
    )).rows[0];
    if (!winner) throw new Error("WEBDAV_IMPORT_REVISION_MISSING");
    if (inserted.rows[0]) {
      await new PostgresAuditRepository(transaction).appendOnly({ actorUserId: null, actorType: "worker",
        action: "webdav.draft.imported", targetType: "drawing_revision", targetId: winner.id,
        requestId: `job:webdav:${item.id}`, result: "success",
        metadata: { projectId: item.project_id, revisionId: winner.id, mappingId: item.mapping_id,
          syncItemId: item.id, remotePath: item.remote_path } });
    }
    return winner.id;
  });
}

async function openConflict(executor: QueryExecutor, syncItemId: string, projectId: string, mappingId: string,
  direction: "inbound" | "outbound", remotePath: string,
  remote: { etag: string | null; sizeBytes: number | null; modifiedAt: Date | null; sha256: Buffer | null },
  cloud: { revisionId: string | null; objectId: string | null; sizeBytes: number | null; sha256: Buffer | null } | null,
  at: Date, createId: () => string) {
  await executor.query(
    `UPDATE platform.webdav_sync_items SET status='conflict',completed_at=NULL,remote_etag=$2,
      remote_size_bytes=$3,remote_modified_at=$4,remote_sha256=$5,version=version+1,updated_at=$6 WHERE id=$1`,
    [syncItemId, remote.etag, remote.sizeBytes, remote.modifiedAt, remote.sha256, at]
  );
  await executor.query(
    `INSERT INTO platform.webdav_sync_conflicts
      (id,mapping_id,project_id,sync_item_id,direction,remote_path,remote_etag,remote_size_bytes,
        remote_modified_at,remote_sha256,cloud_revision_id,cloud_object_id,cloud_size_bytes,cloud_sha256,
        status,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$15)
     ON CONFLICT(sync_item_id) DO UPDATE SET remote_path=EXCLUDED.remote_path,remote_etag=EXCLUDED.remote_etag,
       remote_size_bytes=EXCLUDED.remote_size_bytes,remote_modified_at=EXCLUDED.remote_modified_at,
       remote_sha256=EXCLUDED.remote_sha256,cloud_revision_id=EXCLUDED.cloud_revision_id,
       cloud_object_id=EXCLUDED.cloud_object_id,cloud_size_bytes=EXCLUDED.cloud_size_bytes,
       cloud_sha256=EXCLUDED.cloud_sha256,status='open',resolution=NULL,resolution_reason=NULL,
       renamed_remote_path=NULL,resolved_by_user_id=NULL,resolved_at=NULL,version=webdav_sync_conflicts.version+1,
       updated_at=EXCLUDED.updated_at`,
    [ownCreatedId(createId()), mappingId, projectId, syncItemId, direction, remotePath, remote.etag,
      remote.sizeBytes, remote.modifiedAt, remote.sha256, cloud?.revisionId ?? null, cloud?.objectId ?? null,
      cloud?.sizeBytes ?? null, cloud?.sha256 ?? null, at]
  );
}

async function openInboundConflict(pool: PlatformPool, item: SyncRow,
  remote: { etag: string | null; sizeBytes: number | null; modifiedAt: Date | null }, sha: Buffer, size: number,
  existing: ExistingRevisionRow, at: Date, createId: () => string) {
  await withTransaction(pool, (transaction) => openConflict(transaction, item.id, item.project_id, item.mapping_id,
    "inbound", item.remote_path, { ...remote, sizeBytes: remote.sizeBytes ?? size, sha256: sha },
    { revisionId: existing.revision_id, objectId: existing.object_id, sizeBytes: Number(existing.size_bytes),
      sha256: existing.sha256 }, at, createId));
}

async function openOutboundConflict(options: Parameters<typeof createWebDavWorkerHandlers>[0], item: SyncRow,
  remotePath: string, remote: { etag: string | null; sizeBytes: number | null; modifiedAt: Date | null },
  remoteSha: Buffer, at: Date) {
  await withTransaction(options.pool, (transaction) => openConflict(transaction, item.id, item.project_id,
    item.mapping_id, "outbound", remotePath, { ...remote, sha256: remoteSha },
    { revisionId: item.revision_id, objectId: item.storage_object_id,
      sizeBytes: item.object_size_bytes === null ? null : Number(item.object_size_bytes), sha256: item.object_sha256 },
  at, options.createId ?? uuidv7));
}

async function conflictForChangedRemote(pool: PlatformPool, item: SyncRow,
  remote: { etag: string | null; sizeBytes: number | null; modifiedAt: Date | null }, sha: Buffer | null,
  at: Date, createId: () => string) {
  await withTransaction(pool, (transaction) => openConflict(transaction, item.id, item.project_id, item.mapping_id,
    item.direction, item.remote_path, { ...remote, sha256: sha }, null, at, createId));
}

async function downloadResumable(client: ReturnType<typeof createWebDavClient>, remotePath: string,
  localPath: string, expectedSize: number | null) {
  let offset = await fileSize(localPath);
  if (expectedSize !== null && offset > expectedSize) { await safeUnlink(localPath); offset = 0; }
  try {
    await appendDownload(client, remotePath, localPath, offset);
  } catch (error) {
    if (!(error instanceof WebDavClientError && error.code === "WEBDAV_RANGE_NOT_HONORED" && offset > 0)) throw error;
    await safeUnlink(localPath);
    await appendDownload(client, remotePath, localPath, 0);
  }
  const size = await fileSize(localPath);
  if (size > MAX_PDF_BYTES) throw permanent("WEBDAV_PDF_TOO_LARGE");
  if (expectedSize !== null && size !== expectedSize) throw transient("WEBDAV_DOWNLOAD_SIZE_MISMATCH");
}

async function appendDownload(client: ReturnType<typeof createWebDavClient>, remotePath: string,
  localPath: string, offset: number) {
  const response = await client.download(remotePath, { rangeStart: offset });
  if (!response.body) throw transient("WEBDAV_DOWNLOAD_BODY_MISSING");
  let total = offset;
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    total += Buffer.byteLength(chunk);
    callback(total > MAX_PDF_BYTES ? permanent("WEBDAV_PDF_TOO_LARGE") : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as never), bounded, createWriteStream(localPath, { flags: offset ? "a" : "w" }));
}

async function remoteHash(client: ReturnType<typeof createWebDavClient>, remotePath: string, expectedSize: number | null) {
  if (expectedSize !== null && expectedSize > MAX_PDF_BYTES) throw permanent("WEBDAV_REMOTE_FILE_TOO_LARGE");
  const response = await client.download(remotePath);
  if (!response.body) throw transient("WEBDAV_DOWNLOAD_BODY_MISSING");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
    if (size > MAX_PDF_BYTES) throw permanent("WEBDAV_REMOTE_FILE_TOO_LARGE");
    hash.update(bytes);
  }
  if (expectedSize !== null && size !== expectedSize) throw transient("WEBDAV_DOWNLOAD_SIZE_MISMATCH");
  return hash.digest();
}

async function validatePdf(bytes: Buffer) {
  if (bytes.length < 8 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw permanent("WEBDAV_PDF_INVALID");
  try { await PDFDocument.load(bytes); } catch { throw permanent("WEBDAV_PDF_INVALID"); }
}

async function oneConnection(pool: PlatformPool, connectionId: string) {
  const result = await pool.query<MappingConnectionRow>(
    `SELECT id AS connection_id,endpoint_url,credential_ref,status AS connection_status,capabilities,
      id AS mapping_id,id AS project_id,'/' AS incoming_path,'/' AS outgoing_path,'original' AS publish_variant,
      'active' AS mapping_status,created_by_user_id FROM platform.webdav_connections WHERE id=$1`, [connectionId]
  );
  if (!result.rows[0]) throw permanent("WEBDAV_CONNECTION_NOT_FOUND");
  return result.rows[0];
}

async function claimMapping(pool: PlatformPool, mappingId: string, leaseToken: string, at: Date) {
  return withTransaction(pool, async (transaction) => {
    const claimed = await transaction.query(
      `UPDATE platform.webdav_directory_mappings SET scan_lease_token=$2,scan_lease_expires_at=$3,updated_at=$4
       WHERE id=$1 AND status='active' AND (scan_lease_token IS NULL OR scan_lease_expires_at<=$4) RETURNING id`,
      [mappingId, leaseToken, new Date(at.getTime() + SCAN_LEASE_MS), at]
    );
    if (claimed.rowCount !== 1) return null;
    return oneMappingConnection(transaction, mappingId);
  });
}

async function releaseMapping(pool: PlatformPool, mappingId: string, leaseToken: string, at: Date, success: boolean) {
  await pool.query(
    `UPDATE platform.webdav_directory_mappings SET scan_lease_token=NULL,scan_lease_expires_at=NULL,
      last_scan_at=$3,last_success_at=CASE WHEN $4 THEN $3 ELSE last_success_at END,updated_at=$3
     WHERE id=$1 AND scan_lease_token=$2`, [mappingId, leaseToken, at, success]
  );
}

async function oneMappingConnection(executor: QueryExecutor, mappingId: string) {
  const result = await executor.query<MappingConnectionRow>(
    `SELECT mapping.id AS mapping_id,mapping.project_id,mapping.incoming_path,mapping.outgoing_path,
       mapping.publish_variant,mapping.status AS mapping_status,mapping.created_by_user_id,
       connection.id AS connection_id,connection.endpoint_url,connection.credential_ref,
       connection.status AS connection_status,connection.capabilities
     FROM platform.webdav_directory_mappings mapping
     INNER JOIN platform.webdav_connections connection ON connection.id=mapping.connection_id
     WHERE mapping.id=$1`, [mappingId]
  );
  if (!result.rows[0]) throw permanent("WEBDAV_MAPPING_NOT_FOUND");
  return result.rows[0];
}

async function oneSyncItem(pool: PlatformPool, syncItemId: string) {
  const result = await pool.query<SyncRow>(
    `SELECT item.id,item.mapping_id,item.project_id,item.direction,item.remote_path,item.discovery_key,
       item.remote_etag,item.remote_size_bytes,item.remote_modified_at,item.remote_sha256,item.storage_object_id,
       item.revision_id,item.status,item.version,mapping.incoming_path,mapping.outgoing_path,mapping.publish_variant,
       mapping.status AS mapping_status,mapping.created_by_user_id,connection.id AS connection_id,
       connection.endpoint_url,connection.credential_ref,connection.status AS connection_status,connection.capabilities,
       object.object_key,object.driver AS object_driver,object.size_bytes AS object_size_bytes,
       object.sha256 AS object_sha256,object.media_type AS object_media_type
     FROM platform.webdav_sync_items item
     INNER JOIN platform.webdav_directory_mappings mapping ON mapping.id=item.mapping_id
     INNER JOIN platform.webdav_connections connection ON connection.id=mapping.connection_id
     LEFT JOIN platform.storage_objects object ON object.id=item.storage_object_id AND object.status='ready'
     WHERE item.id=$1`, [syncItemId]
  );
  if (!result.rows[0]) throw permanent("WEBDAV_SYNC_ITEM_NOT_FOUND");
  return result.rows[0];
}

async function clientFor(options: Parameters<typeof createWebDavWorkerHandlers>[0], row: MappingConnectionRow) {
  let endpoint: URL;
  try { endpoint = new URL(row.endpoint_url); } catch { throw permanent("WEBDAV_ENDPOINT_FORBIDDEN"); }
  if (!options.endpointPolicy(endpoint)) throw permanent("WEBDAV_ENDPOINT_FORBIDDEN");
  const credential = await options.credentials.get(row.credential_ref);
  return createWebDavClient({ endpointUrl: row.endpoint_url, credential, fetch: options.fetch,
    validateTarget: options.validateEndpoint });
}

async function findRevision(pool: PlatformPool, projectId: string, documentCode: string, revisionCode: string) {
  const result = await pool.query<ExistingRevisionRow>(
    `SELECT revision.id AS revision_id,revision.revision_code,object.id AS object_id,object.size_bytes,object.sha256
     FROM platform.drawing_revisions revision
     INNER JOIN platform.documents document ON document.id=revision.document_id
     INNER JOIN platform.storage_objects object ON object.id=revision.original_object_id AND object.status='ready'
     WHERE revision.project_id=$1 AND document.document_code=$2 AND revision.revision_code=$3`,
    [projectId, documentCode, revisionCode]
  );
  return result.rows[0] ?? null;
}

async function allowsImportAsNew(pool: PlatformPool, syncItemId: string) {
  const result = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM platform.webdav_sync_conflicts WHERE sync_item_id=$1 AND status='resolved'
      AND resolution='import_as_new_version') AS allowed`, [syncItemId]
  );
  return result.rows[0]?.allowed === true;
}

async function nextRevisionCode(pool: PlatformPool, existingRevisionId: string, fallback: string) {
  const result = await pool.query<{ revision_code: string }>(
    `SELECT candidate.revision_code FROM platform.drawing_revisions existing
     INNER JOIN platform.drawing_revisions candidate ON candidate.document_id=existing.document_id
     WHERE existing.id=$1`, [existingRevisionId]
  );
  let maximum = -1; let major = 0;
  for (const row of result.rows) {
    const match = /^a(\d+)A(\d+)$/.exec(row.revision_code);
    if (match && Number(match[1]) > maximum) { maximum = Number(match[1]); major = Number(match[2]); }
  }
  if (maximum < 0) {
    const match = /^a(\d+)A(\d+)$/.exec(fallback);
    if (!match) throw permanent("WEBDAV_REVISION_CODE_INVALID");
    return `a${Number(match[1]) + 1}A${Number(match[2])}`;
  }
  return `a${maximum + 1}A${major}`;
}

async function setItemState(pool: PlatformPool, id: string, from: string[], to: string, at: Date) {
  const result = await pool.query(
    `UPDATE platform.webdav_sync_items SET status=$3,last_error_code=NULL,completed_at=NULL,
      version=version+1,updated_at=$4 WHERE id=$1 AND status=ANY($2::text[])`, [id, from, to, at]
  );
  if (result.rowCount !== 1) {
    const current = await pool.query<{ status: string }>("SELECT status FROM platform.webdav_sync_items WHERE id=$1", [id]);
    if (["imported", "succeeded", "skipped", "conflict"].includes(current.rows[0]?.status ?? "")) throw new SyncTerminalState();
    throw transient("WEBDAV_SYNC_STATE_CONFLICT");
  }
}

async function markFailed(pool: PlatformPool, id: string, code: string, at: Date) {
  await pool.query(
    `UPDATE platform.webdav_sync_items SET status='failed',completed_at=NULL,last_error_code=$2,
      attempt_count=attempt_count+1,version=version+1,updated_at=$3
     WHERE id=$1 AND status NOT IN ('imported','succeeded','skipped','conflict')`, [id, code, at]
  );
}
async function markRemoteMissing(pool: PlatformPool, id: string, at: Date) {
  await pool.query(
    `UPDATE platform.webdav_sync_items SET status='remote_missing',completed_at=NULL,
      last_error_code='WEBDAV_REMOTE_MISSING',version=version+1,updated_at=$2 WHERE id=$1`, [id, at]
  );
}
async function markImported(pool: PlatformPool, id: string, objectId: string, revisionId: string, sha: Buffer,
  size: number, remote: { etag: string | null; modifiedAt: Date | null }, at: Date) {
  await pool.query(
    `UPDATE platform.webdav_sync_items SET status='imported',storage_object_id=$2,revision_id=$3,
      remote_sha256=$4,remote_size_bytes=$5,remote_etag=$6,remote_modified_at=$7,completed_at=$8,
      last_error_code=NULL,version=version+1,updated_at=$8 WHERE id=$1`,
    [id, objectId, revisionId, sha, size, remote.etag, remote.modifiedAt, at]
  );
}
async function markSucceeded(pool: PlatformPool, id: string, remotePath: string,
  remote: { etag: string | null; sizeBytes: number | null; modifiedAt: Date | null }, sha: Buffer, at: Date) {
  await pool.query(
    `UPDATE platform.webdav_sync_items SET status='succeeded',remote_path=$2,remote_etag=$3,
      remote_size_bytes=$4,remote_modified_at=$5,remote_sha256=$6,completed_at=$7,last_error_code=NULL,
      version=version+1,updated_at=$7 WHERE id=$1`, [id, remotePath, remote.etag, remote.sizeBytes, remote.modifiedAt, sha, at]
  );
}

async function resolvedOutboundPath(pool: PlatformPool, item: SyncRow) {
  const result = await pool.query<{ renamed_remote_path: string | null }>(
    `SELECT renamed_remote_path FROM platform.webdav_sync_conflicts WHERE sync_item_id=$1 AND status='resolved'
      AND resolution='publish_cloud_as_renamed'`, [item.id]
  );
  return result.rows[0]?.renamed_remote_path ?? item.remote_path;
}

function payloadId(payload: unknown, field: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1) {
    throw permanent("JOB_PAYLOAD_INVALID");
  }
  return ownId((payload as Record<string, unknown>)[field]);
}
async function syncItemIdFromPayload(pool: PlatformPool, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw permanent("JOB_PAYLOAD_INVALID");
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).join(",") === "syncItemId") return ownId(value.syncItemId);
  if (typeof value.conflictId === "string") {
    const conflictId = ownId(value.conflictId);
    const result = await pool.query<{ sync_item_id: string }>(
      "SELECT sync_item_id FROM platform.webdav_sync_conflicts WHERE id=$1", [conflictId]
    );
    if (!result.rows[0]) throw permanent("WEBDAV_CONFLICT_NOT_FOUND");
    return result.rows[0].sync_item_id;
  }
  throw permanent("JOB_PAYLOAD_INVALID");
}
function exactIds<T extends readonly string[]>(payload: unknown, fields: T): { [K in T[number]]: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw permanent("JOB_PAYLOAD_INVALID");
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) throw permanent("JOB_PAYLOAD_INVALID");
  return Object.fromEntries(fields.map((field) => [field, ownId(value[field])])) as { [K in T[number]]: string };
}
function ownId(value: unknown) { const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw permanent("JOB_PAYLOAD_INVALID"); return parsed.data; }
function ownCreatedId(value: string) { const parsed = uuidV7Schema.safeParse(value);
  if (!parsed.success) throw transient("WEBDAV_ID_GENERATOR_INVALID"); return parsed.data; }
function ownDate(value: Date) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
  throw transient("WEBDAV_CLOCK_INVALID"); } return new Date(value); }

function discovery(entry: { path: string; etag: string | null; sizeBytes: number | null; modifiedAt: Date | null }) {
  return createHash("sha256").update(JSON.stringify([entry.path, entry.etag, entry.sizeBytes,
    entry.modifiedAt?.toISOString() ?? null])).digest("hex");
}
function metadataChanged(item: SyncRow, remote: { etag: string | null; sizeBytes: number | null }) {
  return (item.remote_etag !== null && remote.etag !== null && item.remote_etag !== remote.etag) ||
    (item.remote_size_bytes !== null && remote.sizeBytes !== null && Number(item.remote_size_bytes) !== remote.sizeBytes);
}
function changedBetween(left: { etag: string | null; sizeBytes: number | null },
  right: { etag: string | null; sizeBytes: number | null }) {
  return (left.etag !== null && right.etag !== null && left.etag !== right.etag) || left.sizeBytes !== right.sizeBytes;
}
function publishedFileName(mapping: PublishedMappingRow) {
  const name = mapping.material_code
    ? `${mapping.document_code}《${mapping.material_code} ${mapping.document_name}》${mapping.revision_code}.pdf`
    : `${mapping.document_code}-${mapping.document_name}-${mapping.revision_code}.pdf`;
  return name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").slice(0, 240);
}
function outboundTemporaryPath(finalPath: string, id: string) {
  const suffix = `.partial-${id.slice(0, 8)}`;
  return `${finalPath.slice(0, 1024 - suffix.length)}${suffix}`;
}
function quarantinePath(root: string, id: string) {
  const target = path.resolve(root, `${id}.partial`);
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw permanent("WEBDAV_STAGING_PATH_INVALID");
  return target;
}
async function fileSize(file: string) { try { return (await stat(file)).size; } catch { return 0; } }
async function safeUnlink(file: string) { try { await unlink(file); } catch { /* absent quarantine is already clean */ } }

function asJobError(error: unknown, fallback: string) {
  if (error instanceof JobHandlerError) return error;
  if (error instanceof WebDavClientError) return new JobHandlerError(error.kind, error.code, safeMessage(error.code));
  if (error instanceof WebDavCredentialError) {
    const kind = error.code === "WEBDAV_CREDENTIAL_SOURCE_UNAVAILABLE" ? "transient" : "permanent";
    return new JobHandlerError(kind, error.code, safeMessage(error.code));
  }
  if (error instanceof WebDavNetworkGuardError) {
    const kind = error.code === "WEBDAV_DNS_UNAVAILABLE" ? "transient" : "permanent";
    return new JobHandlerError(kind, error.code, safeMessage(error.code));
  }
  return transient(fallback, error);
}
function permanent(code: string) { return new JobHandlerError("permanent", code, safeMessage(code)); }
function transient(code: string, cause?: unknown) {
  const error = new JobHandlerError("transient", code, safeMessage(code));
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}
function safeMessage(code: string) { return code.toLowerCase().replaceAll("_", " "); }
class SyncTerminalState extends Error {}
