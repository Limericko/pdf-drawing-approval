import { Readable } from "node:stream";
import { PDFDocument } from "pdf-lib";
import type { QueryResultRow } from "pg";
import { v7 as uuidV7 } from "uuid";
import { uuidV7Schema } from "../../../../shared/contracts/common.ts";
import type { createPdmService } from "../../../modules/pdm/pdmService.ts";
import type { PlatformPool } from "../../database/pool.ts";
import { withTransaction } from "../../database/transaction.ts";
import { PostgresStorageObjectRepository } from "../../storage/postgres/PostgresStorageObjectRepository.ts";
import type { StorageAdapter } from "../../storage/storageAdapter.ts";
import { createStorageKey } from "../../storage/storageKey.ts";
import { JobHandlerError, type JobHandler } from "../jobRegistry.ts";

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024 * 1024;
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;

type ApprovalSourceRow = QueryResultRow & {
  project_id: string;
  approval_id: string;
  status: string;
  requires_signature: boolean;
  source_driver: StorageAdapter["driver"];
  source_key: string;
  source_media_type: string | null;
};

type SignatureRow = QueryResultRow & {
  signer_role: "designer" | "supervisor" | "process";
  page_number: number;
  x_ratio: number;
  y_ratio: number;
  width_ratio: number;
  height_ratio: number;
  signature_driver: StorageAdapter["driver"] | null;
  signature_key: string | null;
  signature_media_type: string | null;
};

type ArtifactRow = QueryResultRow & { id: string; object_id: string | null; status: string; generation: number };

export function createFinalizeApprovedDrawingHandler(options: {
  readonly pool: PlatformPool;
  readonly storage: StorageAdapter;
  readonly pdm: ReturnType<typeof createPdmService>;
  readonly createId?: () => string;
  readonly clock?: () => Date;
}): JobHandler {
  if (!options?.pool || !options.storage || !options.pdm) throw new Error("FINALIZE_HANDLER_OPTIONS_INVALID");
  const createId = options.createId ?? uuidV7;
  const clock = options.clock ?? (() => new Date());
  return async (job) => {
    const payload = parsePayload(job.payload);
    const source = await loadSource(options.pool, payload.projectId, payload.approvalId);
    if (!source || source.status !== "approved") throw permanent("APPROVAL_NOT_READY");

    if (!source.requires_signature) {
      await publish(options.pdm, payload, job.id);
      return;
    }

    const existing = await readyArtifact(options.pool, payload.projectId, payload.approvalId);
    if (existing) {
      await publish(options.pdm, payload, job.id);
      return;
    }

    const artifact = await reserveArtifact(options.pool, payload, createId());
    if (artifact.status === "ready") {
      await publish(options.pdm, payload, job.id);
      return;
    }
    try {
      const signatures = await loadSignatures(options.pool, payload.projectId, payload.approvalId);
      validateRenderInputs(source, signatures, options.storage.driver);
      const sourceBytes = await readBounded(
        await options.storage.openRead(source.source_key), MAX_PDF_BYTES, "PDF_SOURCE_TOO_LARGE"
      );
      const stampBytes = await Promise.all(signatures.map(async (signature) => ({
        signature,
        bytes: await readBounded(
          await options.storage.openRead(signature.signature_key!), MAX_SIGNATURE_BYTES, "SIGNATURE_TOO_LARGE"
        )
      })));
      const output = await renderSignedPdf(sourceBytes, stampBytes);
      const objectId = createId();
      const objectKey = createStorageKey("rendered/signed-pdf", objectId);
      const createdAt = clock();
      const repository = new PostgresStorageObjectRepository(options.pool);
      await repository.createStaging({ id: objectId, driver: options.storage.driver, objectKey, createdAt,
        uploadExpiresAt: new Date(createdAt.getTime() + UPLOAD_WINDOW_MS) });
      const written = await options.storage.write(objectKey, Readable.from(output), "application/pdf");
      const readyAt = clock();
      await repository.markReady(objectId, { sizeBytes: written.sizeBytes, sha256: written.sha256,
        mediaType: "application/pdf", readyAt });
      await markArtifactReady(options.pool, artifact.id, objectId, readyAt);
      await publish(options.pdm, payload, job.id);
    } catch (error) {
      const owned = ownRenderError(error);
      await markArtifactFailed(options.pool, artifact.id, owned.code).catch(() => undefined);
      throw owned;
    }
  };
}

async function loadSource(pool: PlatformPool, projectId: string, approvalId: string) {
  const result = await pool.query<ApprovalSourceRow>(
    `SELECT approval.project_id,approval.id AS approval_id,approval.status,approval.requires_signature,
       object.driver AS source_driver,object.object_key AS source_key,object.media_type AS source_media_type
     FROM platform.approval_cases approval
     INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
     INNER JOIN platform.storage_objects object
       ON object.id=revision.original_object_id AND object.status='ready'
     WHERE approval.project_id=$1 AND approval.id=$2`,
    [projectId, approvalId]
  );
  return result.rows[0];
}

async function loadSignatures(pool: PlatformPool, projectId: string, approvalId: string) {
  const result = await pool.query<SignatureRow>(
    `SELECT placement.signer_role,placement.page_number,placement.x_ratio,placement.y_ratio,
       placement.width_ratio,placement.height_ratio,object.driver AS signature_driver,
       object.object_key AS signature_key,object.media_type AS signature_media_type
     FROM platform.signature_placements placement
     INNER JOIN platform.approval_cases approval ON approval.id=placement.approval_case_id
     INNER JOIN platform.drawing_revisions revision ON revision.id=approval.revision_id
     LEFT JOIN platform.review_decisions decision
       ON decision.approval_case_id=approval.id AND decision.reviewer_role=placement.signer_role
     LEFT JOIN platform.signature_assets asset ON asset.user_id=CASE placement.signer_role
       WHEN 'designer' THEN revision.created_by_user_id ELSE decision.assigned_user_id END AND asset.active=true
     LEFT JOIN platform.storage_objects object ON object.id=asset.object_id AND object.status='ready'
     WHERE placement.project_id=$1 AND placement.approval_case_id=$2
     ORDER BY placement.signer_role`,
    [projectId, approvalId]
  );
  return result.rows;
}

async function readyArtifact(pool: PlatformPool, projectId: string, approvalId: string) {
  const result = await pool.query<ArtifactRow>(
    `SELECT id,object_id,status,generation FROM platform.render_artifacts
     WHERE project_id=$1 AND approval_case_id=$2 AND kind='signed_pdf' AND status='ready'
     ORDER BY generation DESC LIMIT 1`, [projectId, approvalId]
  );
  return result.rows[0];
}

async function reserveArtifact(pool: PlatformPool, payload: FinalizePayload, id: string) {
  return withTransaction(pool, async (transaction) => {
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [payload.approvalId]);
    const existing = await transaction.query<ArtifactRow>(
      `SELECT id,object_id,status,generation FROM platform.render_artifacts
       WHERE approval_case_id=$1 AND kind='signed_pdf' AND status='ready'
       ORDER BY generation DESC LIMIT 1`, [payload.approvalId]
    );
    if (existing.rows[0]) return existing.rows[0];
    const generation = await transaction.query<{ next_generation: number }>(
      `SELECT coalesce(max(generation),0)::int + 1 AS next_generation
       FROM platform.render_artifacts WHERE approval_case_id=$1 AND kind='signed_pdf'`, [payload.approvalId]
    );
    const next = generation.rows[0]!.next_generation;
    const inserted = await transaction.query<ArtifactRow>(
      `INSERT INTO platform.render_artifacts
        (id,project_id,approval_case_id,kind,generation,status,idempotency_key)
       VALUES ($1,$2,$3,'signed_pdf',$4,'processing',$5)
       RETURNING id,object_id,status,generation`,
      [id, payload.projectId, payload.approvalId, next, `render:signed:${payload.approvalId}:${next}`]
    );
    return inserted.rows[0]!;
  });
}

async function markArtifactReady(pool: PlatformPool, artifactId: string, objectId: string, readyAt: Date) {
  const result = await pool.query(
    `UPDATE platform.render_artifacts SET status='ready',object_id=$2,error_code=NULL,ready_at=$3,updated_at=$3
     WHERE id=$1 AND status='processing'`, [artifactId, objectId, readyAt]
  );
  if (result.rowCount !== 1) throw transient("RENDER_STATE_CONFLICT");
}

async function markArtifactFailed(pool: PlatformPool, artifactId: string, code: string) {
  await pool.query(
    `UPDATE platform.render_artifacts SET status='failed',object_id=NULL,error_code=$2,ready_at=NULL,
       updated_at=clock_timestamp() WHERE id=$1 AND status IN ('pending','processing')`,
    [artifactId, code]
  );
}

async function publish(pdm: ReturnType<typeof createPdmService>, payload: FinalizePayload, jobId: string) {
  try {
    await pdm.publishApprovedRevision({ projectId: payload.projectId, approvalId: payload.approvalId,
      requestId: `job:${jobId}` });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "PDM_DEPENDENCY_UNAVAILABLE") throw transient("PDM_DEPENDENCY_UNAVAILABLE");
    throw permanent("PDM_PUBLISH_REJECTED");
  }
}

function validateRenderInputs(source: ApprovalSourceRow, signatures: readonly SignatureRow[], driver: string) {
  if (source.source_driver !== driver || source.source_media_type !== "application/pdf") {
    throw permanent("PDF_SOURCE_NOT_READY");
  }
  if (signatures.length !== 3 || new Set(signatures.map(({ signer_role }) => signer_role)).size !== 3) {
    throw permanent("SIGNATURE_CONFIGURATION_MISSING");
  }
  for (const signature of signatures) {
    if (signature.signature_driver !== driver || signature.signature_media_type !== "image/png" ||
        !signature.signature_key) throw permanent("SIGNATURE_CONFIGURATION_MISSING");
  }
}

async function renderSignedPdf(source: Buffer, stamps: readonly { signature: SignatureRow; bytes: Buffer }[]) {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(source);
  } catch {
    throw permanent("PDF_RENDER_INVALID");
  }
  const pages = pdf.getPages();
  for (const { signature, bytes } of stamps) {
    const page = pages[signature.page_number - 1];
    if (!page) throw permanent("SIGNATURE_PAGE_INVALID");
    let image;
    try { image = await pdf.embedPng(bytes); } catch { throw permanent("SIGNATURE_IMAGE_INVALID"); }
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const width = pageWidth * signature.width_ratio;
    const height = pageHeight * signature.height_ratio;
    page.drawImage(image, { x: pageWidth * signature.x_ratio,
      y: pageHeight - pageHeight * signature.y_ratio - height, width, height });
  }
  return Buffer.from(await pdf.save());
}

async function readBounded(stream: NodeJS.ReadableStream, maximum: number, code: string) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk
      : typeof chunk === "string" ? Buffer.from(chunk)
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximum) throw permanent(code);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

type FinalizePayload = { projectId: string; approvalId: string };

function parsePayload(payload: unknown): FinalizePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw permanent("JOB_PAYLOAD_INVALID");
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "approvalId,projectId") throw permanent("JOB_PAYLOAD_INVALID");
  const projectId = uuidV7Schema.safeParse(value.projectId);
  const approvalId = uuidV7Schema.safeParse(value.approvalId);
  if (!projectId.success || !approvalId.success) throw permanent("JOB_PAYLOAD_INVALID");
  return { projectId: projectId.data, approvalId: approvalId.data };
}

function ownRenderError(error: unknown) {
  if (error instanceof JobHandlerError) return error;
  const owned = transient("PDF_RENDER_DEPENDENCY_UNAVAILABLE");
  Object.defineProperty(owned, "cause", { value: error, enumerable: false });
  return owned;
}

function permanent(code: string) {
  return new JobHandlerError("permanent", code, safeMessage(code));
}

function transient(code: string) {
  return new JobHandlerError("transient", code, safeMessage(code));
}

function safeMessage(code: string) {
  return code.toLowerCase().replaceAll("_", " ");
}
