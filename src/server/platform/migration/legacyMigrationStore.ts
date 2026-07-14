import type { QueryExecutor } from "../database/queryExecutor.ts";
import { deriveLegacyUuidV7 } from "./legacyIdentity.ts";

export type LegacyMigrationMode = "import" | "verify" | "delta";
export type LegacyMigrationRun = {
  readonly id: string;
  readonly sourceId: string;
  readonly mode: LegacyMigrationMode;
  readonly sourceFingerprintSha256: string;
  readonly startedAt: Date;
};

export class LegacyMigrationStore {
  constructor(private readonly executor: QueryExecutor) {}

  async startRun(input: {
    readonly sourceId: string;
    readonly mode: LegacyMigrationMode;
    readonly sourceFingerprintSha256: string;
    readonly baselineRunId?: string;
    readonly startedAt: Date;
  }): Promise<LegacyMigrationRun> {
    const id = deriveLegacyUuidV7(
      input.sourceId,
      "migration_run",
      `${input.mode}:${input.sourceFingerprintSha256}:${input.startedAt.toISOString()}`
    );
    const result = await this.executor.query<{
      id: string; source_id: string; mode: LegacyMigrationMode; source_fingerprint_sha256: string; started_at: Date;
    }>(
      `INSERT INTO platform.legacy_migration_runs(
         id, source_id, mode, source_fingerprint_sha256, baseline_run_id, status, started_at
       ) VALUES ($1,$2,$3,$4,$5,'running',$6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id,source_id,mode,source_fingerprint_sha256,started_at`,
      [id, input.sourceId, input.mode, input.sourceFingerprintSha256, input.baselineRunId ?? null, input.startedAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error("LEGACY_MIGRATION_ALREADY_RUNNING");
    return { id: row.id, sourceId: row.source_id, mode: row.mode,
      sourceFingerprintSha256: row.source_fingerprint_sha256, startedAt: new Date(row.started_at) };
  }

  async completeRun(runId: string, input: {
    readonly status: "succeeded" | "failed";
    readonly completedAt: Date;
    readonly report: Readonly<Record<string, unknown>>;
  }) {
    const result = await this.executor.query(
      `UPDATE platform.legacy_migration_runs
       SET status=$2,completed_at=$3,report=$4::jsonb
       WHERE id=$1 AND status='running'`,
      [runId, input.status, input.completedAt, JSON.stringify(input.report)]
    );
    if (result.rowCount !== 1) throw new Error("LEGACY_MIGRATION_RUN_STATE_CONFLICT");
  }

  async findLatestSuccessfulImport(sourceId: string) {
    const result = await this.executor.query<{ id: string; source_fingerprint_sha256: string; completed_at: Date }>(
      `SELECT id,source_fingerprint_sha256,completed_at
       FROM platform.legacy_migration_runs
       WHERE source_id=$1 AND mode='import' AND status='succeeded'
       ORDER BY completed_at DESC,id DESC LIMIT 1`,
      [sourceId]
    );
    const row = result.rows[0];
    return row ? { id: row.id, sourceFingerprintSha256: row.source_fingerprint_sha256,
      completedAt: new Date(row.completed_at) } : undefined;
  }

  async recordIdMapping(input: {
    readonly runId: string;
    readonly sourceId: string;
    readonly entityType: string;
    readonly legacyId: string | number;
    readonly targetTable: string;
    readonly sourceRowSha256: string;
    readonly observedAt: Date;
  }) {
    const legacyId = String(input.legacyId);
    const targetId = deriveLegacyUuidV7(input.sourceId, input.entityType, legacyId);
    const result = await this.executor.query<{ target_id: string }>(
      `INSERT INTO platform.legacy_id_mappings(
         source_id,entity_type,legacy_id,target_table,target_id,source_row_sha256,
         first_run_id,last_seen_run_id,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8)
       ON CONFLICT (source_id,entity_type,legacy_id) DO UPDATE SET
         source_row_sha256=EXCLUDED.source_row_sha256,
         last_seen_run_id=EXCLUDED.last_seen_run_id,
         updated_at=EXCLUDED.updated_at
       WHERE platform.legacy_id_mappings.target_table=EXCLUDED.target_table
         AND platform.legacy_id_mappings.target_id=EXCLUDED.target_id
       RETURNING target_id`,
      [input.sourceId, input.entityType, legacyId, input.targetTable, targetId,
        input.sourceRowSha256, input.runId, input.observedAt]
    );
    if (result.rows[0]?.target_id !== targetId) throw new Error("LEGACY_ID_MAPPING_CONFLICT");
    return targetId;
  }

  async findFileMapping(sourceId: string, sourcePathSha256: string, sourceContentSha256: string) {
    const result = await this.executor.query<{
      source_content_sha256: string; size_bytes: string; media_type: string; storage_object_id: string;
      status: string; driver: string; object_key: string;
    }>(
      `SELECT mapping.source_content_sha256,mapping.size_bytes,mapping.media_type,mapping.storage_object_id,
              object.status,object.driver,object.object_key
       FROM platform.legacy_file_mappings mapping
       JOIN platform.storage_objects object ON object.id=mapping.storage_object_id
       WHERE mapping.source_id=$1 AND mapping.source_path_sha256=$2 AND mapping.source_content_sha256=$3`,
      [sourceId, sourcePathSha256, sourceContentSha256]
    );
    const row = result.rows[0];
    return row ? { sourceContentSha256: row.source_content_sha256, sizeBytes: Number(row.size_bytes),
      mediaType: row.media_type, storageObjectId: row.storage_object_id, status: row.status,
      driver: row.driver, objectKey: row.object_key } : undefined;
  }

  async findLatestFileMapping(sourceId: string, sourcePathSha256: string) {
    const result = await this.executor.query<{
      source_content_sha256: string; size_bytes: string; media_type: string; storage_object_id: string;
      status: string; driver: string; object_key: string;
    }>(
      `SELECT mapping.source_content_sha256,mapping.size_bytes,mapping.media_type,mapping.storage_object_id,
              object.status,object.driver,object.object_key
       FROM platform.legacy_file_mappings mapping
       JOIN platform.storage_objects object ON object.id=mapping.storage_object_id
       WHERE mapping.source_id=$1 AND mapping.source_path_sha256=$2
       ORDER BY mapping.verified_at DESC, mapping.source_content_sha256 DESC LIMIT 1`,
      [sourceId, sourcePathSha256]
    );
    const row = result.rows[0];
    return row ? { sourceContentSha256: row.source_content_sha256, sizeBytes: Number(row.size_bytes),
      mediaType: row.media_type, storageObjectId: row.storage_object_id, status: row.status,
      driver: row.driver, objectKey: row.object_key } : undefined;
  }

  async recordFileMapping(input: {
    readonly runId: string;
    readonly sourceId: string;
    readonly sourcePathSha256: string;
    readonly sourceContentSha256: string;
    readonly sizeBytes: number;
    readonly mediaType: string;
    readonly storageObjectId: string;
    readonly verifiedAt: Date;
  }) {
    const result = await this.executor.query<{ storage_object_id: string }>(
      `INSERT INTO platform.legacy_file_mappings(
         source_id,source_path_sha256,source_content_sha256,size_bytes,media_type,storage_object_id,
         first_run_id,last_seen_run_id,verified_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)
       ON CONFLICT (source_id,source_path_sha256,source_content_sha256) DO UPDATE SET
         last_seen_run_id=EXCLUDED.last_seen_run_id,
         verified_at=EXCLUDED.verified_at
       WHERE platform.legacy_file_mappings.size_bytes=EXCLUDED.size_bytes
         AND platform.legacy_file_mappings.media_type=EXCLUDED.media_type
         AND platform.legacy_file_mappings.storage_object_id=EXCLUDED.storage_object_id
       RETURNING storage_object_id`,
      [input.sourceId, input.sourcePathSha256, input.sourceContentSha256, input.sizeBytes,
        input.mediaType, input.storageObjectId, input.runId, input.verifiedAt]
    );
    if (result.rows[0]?.storage_object_id !== input.storageObjectId) {
      throw new Error("LEGACY_FILE_MAPPING_CONFLICT");
    }
  }

  async ensureReadyStorageObject(input: {
    readonly id: string;
    readonly driver: "filesystem" | "s3";
    readonly objectKey: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly mediaType: string;
    readonly readyAt: Date;
  }) {
    await this.executor.query(
      `INSERT INTO platform.storage_objects(
         id,status,driver,object_key,size_bytes,sha256,media_type,created_at,updated_at,ready_at
       ) VALUES ($1,'ready',$2,$3,$4,decode($5,'hex'),$6,$7,$7,$7)
       ON CONFLICT (id) DO NOTHING`,
      [input.id, input.driver, input.objectKey, input.sizeBytes, input.sha256, input.mediaType, input.readyAt]
    );
    const result = await this.executor.query<{
      status: string; driver: string; object_key: string; size_bytes: string; sha256: string; media_type: string;
    }>(
      `SELECT status,driver,object_key,size_bytes,encode(sha256,'hex') AS sha256,media_type
       FROM platform.storage_objects WHERE id=$1`,
      [input.id]
    );
    const row = result.rows[0];
    if (
      !row || row.status !== "ready" || row.driver !== input.driver || row.object_key !== input.objectKey ||
      Number(row.size_bytes) !== input.sizeBytes || row.sha256 !== input.sha256 || row.media_type !== input.mediaType
    ) {
      throw new Error("LEGACY_STORAGE_OBJECT_CONFLICT");
    }
  }
}
