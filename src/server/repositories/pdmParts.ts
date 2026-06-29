import type { SQLInputValue } from "node:sqlite";
import type { DatabaseConnection } from "../db.ts";

export type PdmMetadataStatus = "complete" | "missing_material_code" | "missing_document_code" | "missing_required";
export type PdmPublishStatus = "not_applicable" | "metadata_pending" | "pending" | "published" | "failed";
export type PdmRevisionStatus = "released" | "superseded" | "voided";

export type PdmPart = {
  id: number;
  materialCode: string;
  name: string;
  isCommon: boolean;
  currentRevisionId: number | null;
  createdFromApprovalId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PdmDrawingRevision = {
  id: number;
  partId: number;
  materialCode: string;
  documentCode: string | null;
  drawingName: string;
  version: string;
  minorVersion: string;
  majorVersion: string;
  approvalId: number;
  releaseStatus: PdmRevisionStatus;
  originalFilePath: string;
  originalFileHash: string | null;
  signedFilePath: string | null;
  signedFileHash: string | null;
  annotatedFilePath: string | null;
  releasedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PdmPartUsage = {
  id: number;
  partId: number;
  materialCode: string;
  projectName: string;
  firstApprovalId: number;
  lastApprovalId: number;
  createdAt: string;
  updatedAt: string;
};

export type PdmPendingMetadataApproval = {
  approvalId: number;
  projectName: string;
  partName: string;
  version: string;
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string | null;
  metadataStatus: PdmMetadataStatus;
  publishStatus: PdmPublishStatus;
  publishError: string | null;
  submittedByUserId: number | null;
  submittedAt: string;
};

export type PdmPartListItem = PdmPart & {
  currentVersion: string | null;
  currentDocumentCode: string | null;
  currentApprovalId: number | null;
  currentReleasedAt: string | null;
  usageProjectCount: number;
  usageProjects: string[];
};

type PdmPartRow = {
  id: number;
  material_code: string;
  name: string;
  is_common: number;
  current_revision_id: number | null;
  created_from_approval_id: number | null;
  created_at: string;
  updated_at: string;
};

type PdmDrawingRevisionRow = {
  id: number;
  part_id: number;
  material_code: string;
  document_code: string | null;
  drawing_name: string;
  version: string;
  minor_version: string;
  major_version: string;
  approval_id: number;
  release_status: PdmRevisionStatus;
  original_file_path: string;
  original_file_hash: string | null;
  signed_file_path: string | null;
  signed_file_hash: string | null;
  annotated_file_path: string | null;
  released_at: string;
  created_at: string;
  updated_at: string;
};

type PdmPartUsageRow = {
  id: number;
  part_id: number;
  material_code: string;
  project_name: string;
  first_approval_id: number;
  last_approval_id: number;
  created_at: string;
  updated_at: string;
};

type PdmPendingMetadataRow = {
  approval_id: number;
  project_name: string;
  part_name: string;
  version: string;
  document_code: string | null;
  material_code: string | null;
  drawing_name: string | null;
  pdm_metadata_status: PdmMetadataStatus;
  pdm_publish_status: PdmPublishStatus;
  pdm_publish_error: string | null;
  submitted_by_user_id: number | null;
  submitted_at: string;
};

type PdmPartListRow = PdmPartRow & {
  current_version: string | null;
  current_document_code: string | null;
  current_approval_id: number | null;
  current_released_at: string | null;
  usage_project_count: number;
  usage_projects: string | null;
};

export class PdmPartRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createOrUpdatePart(input: { materialCode: string; name: string; createdFromApprovalId?: number | null }): PdmPart {
    const materialCode = normalizeRequired(input.materialCode, "PDM_MATERIAL_CODE_REQUIRED");
    const name = normalizeRequired(input.name, "PDM_PART_NAME_REQUIRED");

    const existing = this.findPartByMaterialCode(materialCode);
    if (existing) {
      this.db
        .prepare("UPDATE pdm_parts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND name != ?")
        .run(name, existing.id, name);
      return this.getPartById(existing.id)!;
    }

    const result = this.db
      .prepare(
        `INSERT INTO pdm_parts (material_code, name, created_from_approval_id)
         VALUES (?, ?, ?)`
      )
      .run(materialCode, name, input.createdFromApprovalId ?? null);

    return this.getPartById(Number(result.lastInsertRowid))!;
  }

  findPartByMaterialCode(materialCode: string): PdmPart | null {
    const row = this.db.prepare("SELECT * FROM pdm_parts WHERE material_code = ?").get(materialCode.trim()) as PdmPartRow | undefined;
    return row ? mapPart(row) : null;
  }

  getPartById(id: number): PdmPart | null {
    const row = this.db.prepare("SELECT * FROM pdm_parts WHERE id = ?").get(id) as PdmPartRow | undefined;
    return row ? mapPart(row) : null;
  }

  listParts(
    filters: {
      keyword?: string;
      projectName?: string;
      isCommon?: boolean;
      hasCurrentRevision?: boolean;
      page?: number;
      pageSize?: number;
    } = {}
  ): { items: PdmPartListItem[]; total: number; page: number; pageSize: number } {
    const pageSize = clampInteger(filters.pageSize ?? 20, 1, 100, 20);
    const page = clampInteger(filters.page ?? 1, 1, 100000, 1);
    const { where, params } = buildPartListWhere(filters);
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM pdm_parts p
         LEFT JOIN pdm_drawing_revisions current_revision ON current_revision.id = p.current_revision_id
         ${where}`
      )
      .get(params) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT
          p.*,
          current_revision.version AS current_version,
          current_revision.document_code AS current_document_code,
          current_revision.approval_id AS current_approval_id,
          current_revision.released_at AS current_released_at,
          COUNT(u.id) AS usage_project_count,
          GROUP_CONCAT(u.project_name, '||') AS usage_projects
        FROM pdm_parts p
        LEFT JOIN pdm_drawing_revisions current_revision ON current_revision.id = p.current_revision_id
        LEFT JOIN pdm_part_usages u ON u.part_id = p.id
        ${where}
        GROUP BY p.id
        ORDER BY current_revision.released_at DESC, p.updated_at DESC, p.id DESC
        LIMIT @limit OFFSET @offset`
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (page - 1) * pageSize
      }) as PdmPartListRow[];

    return { items: rows.map(mapPartListItem), total: totalRow.total, page, pageSize };
  }

  publishRevision(input: {
    partId: number;
    materialCode: string;
    documentCode?: string | null;
    drawingName: string;
    version: string;
    minorVersion: string;
    majorVersion: string;
    approvalId: number;
    originalFilePath: string;
    originalFileHash?: string | null;
    signedFilePath?: string | null;
    signedFileHash?: string | null;
    annotatedFilePath?: string | null;
  }): PdmDrawingRevision {
    const materialCode = normalizeRequired(input.materialCode, "PDM_MATERIAL_CODE_REQUIRED");
    const drawingName = normalizeRequired(input.drawingName, "PDM_DRAWING_NAME_REQUIRED");
    const version = normalizeRequired(input.version, "PDM_VERSION_REQUIRED");
    const existing = this.findRevisionByMaterialVersion(materialCode, version);
    if (existing) {
      throw new Error("PDM_REVISION_EXISTS");
    }

    const result = this.db
      .prepare(
        `INSERT INTO pdm_drawing_revisions (
          part_id, material_code, document_code, drawing_name, version, minor_version, major_version,
          approval_id, release_status, original_file_path, original_file_hash,
          signed_file_path, signed_file_hash, annotated_file_path
        ) VALUES (
          @partId, @materialCode, @documentCode, @drawingName, @version, @minorVersion, @majorVersion,
          @approvalId, 'released', @originalFilePath, @originalFileHash,
          @signedFilePath, @signedFileHash, @annotatedFilePath
        )`
      )
      .run({
        partId: input.partId,
        materialCode,
        documentCode: blankToNull(input.documentCode),
        drawingName,
        version,
        minorVersion: normalizeRequired(input.minorVersion, "PDM_MINOR_VERSION_REQUIRED"),
        majorVersion: normalizeRequired(input.majorVersion, "PDM_MAJOR_VERSION_REQUIRED"),
        approvalId: input.approvalId,
        originalFilePath: normalizeRequired(input.originalFilePath, "PDM_ORIGINAL_FILE_REQUIRED"),
        originalFileHash: input.originalFileHash ?? null,
        signedFilePath: input.signedFilePath ?? null,
        signedFileHash: input.signedFileHash ?? null,
        annotatedFilePath: input.annotatedFilePath ?? null
      });

    const revision = this.getRevisionById(Number(result.lastInsertRowid))!;
    this.db
      .prepare(
        `UPDATE pdm_drawing_revisions
         SET release_status = 'superseded', updated_at = CURRENT_TIMESTAMP
         WHERE part_id = ? AND id != ? AND release_status = 'released'`
      )
      .run(input.partId, revision.id);
    this.db
      .prepare("UPDATE pdm_parts SET current_revision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(revision.id, input.partId);

    return this.getRevisionById(revision.id)!;
  }

  findRevisionByMaterialVersion(materialCode: string, version: string): PdmDrawingRevision | null {
    const row = this.db
      .prepare("SELECT * FROM pdm_drawing_revisions WHERE material_code = ? AND version = ?")
      .get(materialCode.trim(), version.trim()) as PdmDrawingRevisionRow | undefined;
    return row ? mapRevision(row) : null;
  }

  getRevisionById(id: number): PdmDrawingRevision | null {
    const row = this.db.prepare("SELECT * FROM pdm_drawing_revisions WHERE id = ?").get(id) as PdmDrawingRevisionRow | undefined;
    return row ? mapRevision(row) : null;
  }

  listRevisions(partId: number): PdmDrawingRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM pdm_drawing_revisions WHERE part_id = ? ORDER BY released_at DESC, id DESC")
      .all(partId) as PdmDrawingRevisionRow[];
    return rows.map(mapRevision);
  }

  recordUsage(input: { materialCode: string; projectName: string; approvalId: number }): PdmPartUsage {
    const materialCode = normalizeRequired(input.materialCode, "PDM_MATERIAL_CODE_REQUIRED");
    const projectName = normalizeRequired(input.projectName, "PDM_PROJECT_NAME_REQUIRED");
    const part = this.findPartByMaterialCode(materialCode);
    if (!part) {
      throw new Error("PDM_PART_NOT_FOUND");
    }

    this.db
      .prepare(
        `INSERT INTO pdm_part_usages (
          part_id, material_code, project_name, first_approval_id, last_approval_id
        ) VALUES (
          @partId, @materialCode, @projectName, @approvalId, @approvalId
        )
        ON CONFLICT(material_code, project_name) DO UPDATE SET
          last_approval_id = excluded.last_approval_id,
          updated_at = CURRENT_TIMESTAMP`
      )
      .run({ partId: part.id, materialCode, projectName, approvalId: input.approvalId });

    this.refreshCommonFlag(part.id);
    return this.getUsage(materialCode, projectName)!;
  }

  listUsages(partId: number): PdmPartUsage[] {
    const rows = this.db
      .prepare("SELECT * FROM pdm_part_usages WHERE part_id = ? ORDER BY project_name ASC, id ASC")
      .all(partId) as PdmPartUsageRow[];
    return rows.map(mapUsage);
  }

  listPendingMetadata(filters: { submittedByUserId?: number } = {}): PdmPendingMetadataApproval[] {
    const conditions = [
      "(pdm_metadata_status != 'complete' OR pdm_publish_status IN ('metadata_pending', 'failed'))"
    ];
    const params: Record<string, SQLInputValue> = {};
    if (filters.submittedByUserId !== undefined) {
      conditions.push("submitted_by_user_id = @submittedByUserId");
      params.submittedByUserId = filters.submittedByUserId;
    }

    const rows = this.db
      .prepare(
        `SELECT
          id AS approval_id, project_name, part_name, version,
          document_code, material_code, drawing_name,
          pdm_metadata_status, pdm_publish_status, pdm_publish_error,
          submitted_by_user_id, submitted_at
        FROM approvals
        WHERE ${conditions.join(" AND ")}
        ORDER BY submitted_at DESC, id DESC`
      )
      .all(params) as PdmPendingMetadataRow[];
    return rows.map(mapPendingMetadata);
  }

  private getUsage(materialCode: string, projectName: string): PdmPartUsage | null {
    const row = this.db
      .prepare("SELECT * FROM pdm_part_usages WHERE material_code = ? AND project_name = ?")
      .get(materialCode, projectName) as PdmPartUsageRow | undefined;
    return row ? mapUsage(row) : null;
  }

  private refreshCommonFlag(partId: number) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM pdm_part_usages WHERE part_id = ?").get(partId) as { count: number };
    this.db.prepare("UPDATE pdm_parts SET is_common = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.count > 1 ? 1 : 0, partId);
  }
}

function buildPartListWhere(filters: {
  keyword?: string;
  projectName?: string;
  isCommon?: boolean;
  hasCurrentRevision?: boolean;
}) {
  const conditions: string[] = [];
  const params: Record<string, SQLInputValue> = {};
  const keyword = filters.keyword?.trim();
  if (keyword) {
    conditions.push("(p.material_code LIKE @keyword OR p.name LIKE @keyword OR current_revision.document_code LIKE @keyword)");
    params.keyword = `%${keyword}%`;
  }
  const projectName = filters.projectName?.trim();
  if (projectName) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM pdm_part_usages usage_filter
        WHERE usage_filter.part_id = p.id AND usage_filter.project_name = @projectName
      )`
    );
    params.projectName = projectName;
  }
  if (filters.isCommon !== undefined) {
    conditions.push("p.is_common = @isCommon");
    params.isCommon = filters.isCommon ? 1 : 0;
  }
  if (filters.hasCurrentRevision !== undefined) {
    conditions.push(filters.hasCurrentRevision ? "p.current_revision_id IS NOT NULL" : "p.current_revision_id IS NULL");
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

function mapPart(row: PdmPartRow): PdmPart {
  return {
    id: row.id,
    materialCode: row.material_code,
    name: row.name,
    isCommon: row.is_common === 1,
    currentRevisionId: row.current_revision_id,
    createdFromApprovalId: row.created_from_approval_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPartListItem(row: PdmPartListRow): PdmPartListItem {
  return {
    ...mapPart(row),
    currentVersion: row.current_version,
    currentDocumentCode: row.current_document_code,
    currentApprovalId: row.current_approval_id,
    currentReleasedAt: row.current_released_at,
    usageProjectCount: row.usage_project_count,
    usageProjects: row.usage_projects ? row.usage_projects.split("||").filter(Boolean).sort((left, right) => left.localeCompare(right, "zh-Hans-CN")) : []
  };
}

function mapRevision(row: PdmDrawingRevisionRow): PdmDrawingRevision {
  return {
    id: row.id,
    partId: row.part_id,
    materialCode: row.material_code,
    documentCode: row.document_code,
    drawingName: row.drawing_name,
    version: row.version,
    minorVersion: row.minor_version,
    majorVersion: row.major_version,
    approvalId: row.approval_id,
    releaseStatus: row.release_status,
    originalFilePath: row.original_file_path,
    originalFileHash: row.original_file_hash,
    signedFilePath: row.signed_file_path,
    signedFileHash: row.signed_file_hash,
    annotatedFilePath: row.annotated_file_path,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUsage(row: PdmPartUsageRow): PdmPartUsage {
  return {
    id: row.id,
    partId: row.part_id,
    materialCode: row.material_code,
    projectName: row.project_name,
    firstApprovalId: row.first_approval_id,
    lastApprovalId: row.last_approval_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPendingMetadata(row: PdmPendingMetadataRow): PdmPendingMetadataApproval {
  return {
    approvalId: row.approval_id,
    projectName: row.project_name,
    partName: row.part_name,
    version: row.version,
    documentCode: row.document_code,
    materialCode: row.material_code,
    drawingName: row.drawing_name,
    metadataStatus: row.pdm_metadata_status,
    publishStatus: row.pdm_publish_status,
    publishError: row.pdm_publish_error,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.submitted_at
  };
}

function normalizeRequired(value: string, errorCode: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(errorCode);
  }
  return normalized;
}

function blankToNull(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function clampInteger(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
