import type { DatabaseConnection } from "../db.ts";
import type { UserRole } from "./users.ts";

export type ApprovalAnnotationKind = "pin" | "rect" | "arrow" | "circle" | "text" | "ink" | "cloud";
export type ApprovalAnnotationColor = "red" | "amber" | "blue" | "green" | "custom";

type AnnotationPoint = {
  xRatio: number;
  yRatio: number;
};

export type ApprovalAnnotation = {
  id: number;
  approvalId: number;
  authorUserId: number;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorRole: UserRole | null;
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number | null;
  heightRatio: number | null;
  endXRatio: number | null;
  endYRatio: number | null;
  pointsJson: string | null;
  styleJson: string | null;
  color: ApprovalAnnotationColor;
  resolved: boolean;
  resolvedByUserId: number | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalAnnotationInput = {
  approvalId: number;
  authorUserId: number;
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio?: number | null;
  heightRatio?: number | null;
  endXRatio?: number | null;
  endYRatio?: number | null;
  pointsJson?: string | null;
  styleJson?: string | null;
  color?: ApprovalAnnotationColor;
};

export type UpdateApprovalAnnotationInput = Omit<ApprovalAnnotationInput, "approvalId" | "authorUserId" | "kind"> & {
  kind?: ApprovalAnnotationKind;
};

type ApprovalAnnotationRow = {
  id: number;
  approval_id: number;
  author_user_id: number;
  author_username: string | null;
  author_display_name: string | null;
  author_role: UserRole | null;
  kind: ApprovalAnnotationKind;
  message: string;
  page_number: number;
  x_ratio: number;
  y_ratio: number;
  width_ratio: number | null;
  height_ratio: number | null;
  end_x_ratio: number | null;
  end_y_ratio: number | null;
  points_json: string | null;
  style_json: string | null;
  color: ApprovalAnnotationColor;
  resolved: number;
  resolved_by_user_id: number | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

const colors = new Set<ApprovalAnnotationColor>(["red", "amber", "blue", "green", "custom"]);
const geometryKindsWithBox = new Set<ApprovalAnnotationKind>(["rect", "circle", "text", "cloud"]);
const customColorPattern = /^#[0-9a-fA-F]{6}$/;

export class ApprovalAnnotationRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: ApprovalAnnotationInput): ApprovalAnnotation {
    const normalized = normalizeAnnotationInput(input);
    const result = this.db
      .prepare(
        `INSERT INTO approval_annotations (
          approval_id, author_user_id, kind, message, page_number,
          x_ratio, y_ratio, width_ratio, height_ratio, end_x_ratio, end_y_ratio,
          points_json, style_json, color
        ) VALUES (
          @approvalId, @authorUserId, @kind, @message, @pageNumber,
          @xRatio, @yRatio, @widthRatio, @heightRatio, @endXRatio, @endYRatio,
          @pointsJson, @styleJson, @color
        )`
      )
      .run(normalized);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  getById(id: number): ApprovalAnnotation | null {
    const row = this.db
      .prepare(
        `SELECT
           approval_annotations.*,
           users.username AS author_username,
           users.display_name AS author_display_name,
           users.role AS author_role
         FROM approval_annotations
         LEFT JOIN users ON users.id = approval_annotations.author_user_id
         WHERE approval_annotations.id = ?`
      )
      .get(id) as ApprovalAnnotationRow | undefined;
    return row ? mapApprovalAnnotation(row) : null;
  }

  listForApproval(approvalId: number): ApprovalAnnotation[] {
    const rows = this.db
      .prepare(
        `SELECT
           approval_annotations.*,
           users.username AS author_username,
           users.display_name AS author_display_name,
           users.role AS author_role
         FROM approval_annotations
         LEFT JOIN users ON users.id = approval_annotations.author_user_id
         WHERE approval_annotations.approval_id = ?
         ORDER BY approval_annotations.created_at ASC, approval_annotations.id ASC`
      )
      .all(approvalId) as ApprovalAnnotationRow[];
    return rows.map(mapApprovalAnnotation);
  }

  countOpenForApproval(approvalId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM approval_annotations WHERE approval_id = ? AND resolved = 0")
      .get(approvalId) as { count: number };
    return row.count;
  }

  update(
    approvalId: number,
    annotationId: number,
    input: UpdateApprovalAnnotationInput
  ): ApprovalAnnotation {
    const existing = this.getById(annotationId);
    if (!existing || existing.approvalId !== approvalId) {
      throw new Error("ANNOTATION_NOT_FOUND");
    }
    if (existing.resolved) {
      throw new Error("ANNOTATION_ALREADY_RESOLVED");
    }

    const normalized = normalizeAnnotationInput({
      approvalId,
      authorUserId: existing.authorUserId,
      kind: input.kind ?? existing.kind,
      message: input.message,
      pageNumber: input.pageNumber,
      xRatio: input.xRatio,
      yRatio: input.yRatio,
      widthRatio: input.widthRatio ?? null,
      heightRatio: input.heightRatio ?? null,
      endXRatio: input.endXRatio ?? null,
      endYRatio: input.endYRatio ?? null,
      pointsJson: input.pointsJson ?? existing.pointsJson,
      styleJson: input.styleJson ?? existing.styleJson,
      color: input.color ?? existing.color
    });

    this.db
      .prepare(
        `UPDATE approval_annotations SET
          kind = @kind,
          message = @message,
          page_number = @pageNumber,
          x_ratio = @xRatio,
          y_ratio = @yRatio,
          width_ratio = @widthRatio,
          height_ratio = @heightRatio,
          end_x_ratio = @endXRatio,
          end_y_ratio = @endYRatio,
          points_json = @pointsJson,
          style_json = @styleJson,
          color = @color,
          updated_at = @updatedAt
         WHERE id = @annotationId AND approval_id = @approvalId`
      )
      .run({
        approvalId: normalized.approvalId,
        kind: normalized.kind,
        message: normalized.message,
        pageNumber: normalized.pageNumber,
        xRatio: normalized.xRatio,
        yRatio: normalized.yRatio,
        widthRatio: normalized.widthRatio,
        heightRatio: normalized.heightRatio,
        endXRatio: normalized.endXRatio,
        endYRatio: normalized.endYRatio,
        pointsJson: normalized.pointsJson,
        styleJson: normalized.styleJson,
        color: normalized.color,
        annotationId,
        updatedAt: new Date().toISOString()
      });

    return this.getById(annotationId)!;
  }

  resolve(approvalId: number, annotationId: number, resolvedByUserId: number): ApprovalAnnotation {
    const existing = this.getById(annotationId);
    if (!existing || existing.approvalId !== approvalId) {
      throw new Error("ANNOTATION_NOT_FOUND");
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE approval_annotations
         SET resolved = 1, resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND approval_id = ?`
      )
      .run(resolvedByUserId, now, now, annotationId, approvalId);
    return this.getById(annotationId)!;
  }

  delete(approvalId: number, annotationId: number): ApprovalAnnotation {
    const existing = this.getById(annotationId);
    if (!existing || existing.approvalId !== approvalId) {
      throw new Error("ANNOTATION_NOT_FOUND");
    }
    if (existing.resolved) {
      throw new Error("ANNOTATION_ALREADY_RESOLVED");
    }

    this.db.prepare("DELETE FROM approval_annotations WHERE id = ? AND approval_id = ?").run(annotationId, approvalId);
    return existing;
  }

  deleteForApproval(approvalId: number): number {
    const result = this.db.prepare("DELETE FROM approval_annotations WHERE approval_id = ?").run(approvalId);
    return Number(result.changes);
  }
}

function normalizeAnnotationInput(input: ApprovalAnnotationInput) {
  const message = input.message.trim();
  const color = input.color ?? "red";

  if (!message || message.length > 1000) {
    throw new Error("INVALID_ANNOTATION_MESSAGE");
  }
  if (!colors.has(color)) {
    throw new Error("INVALID_ANNOTATION_COLOR");
  }
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }
  if (!isRatio(input.xRatio) || !isRatio(input.yRatio)) {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }

  const widthRatio = input.widthRatio ?? null;
  const heightRatio = input.heightRatio ?? null;
  const endXRatio = input.endXRatio ?? null;
  const endYRatio = input.endYRatio ?? null;
  const pointsJson = input.pointsJson ?? null;
  const styleJson = color === "custom" ? normalizeCustomStyleJson(input.styleJson ?? null) : input.styleJson ?? null;

  if (geometryKindsWithBox.has(input.kind)) {
    if (!isPositiveRatio(widthRatio) || !isPositiveRatio(heightRatio)) {
      throw new Error("INVALID_ANNOTATION_GEOMETRY");
    }
    if (input.xRatio + widthRatio > 1 || input.yRatio + heightRatio > 1) {
      throw new Error("INVALID_ANNOTATION_GEOMETRY");
    }
  }

  if (input.kind === "arrow" && (!isRatio(endXRatio) || !isRatio(endYRatio))) {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }

  if (input.kind === "ink") {
    validateInkPoints(pointsJson);
  }

  return {
    approvalId: input.approvalId,
    authorUserId: input.authorUserId,
    kind: input.kind,
    message,
    pageNumber: input.pageNumber,
    xRatio: input.xRatio,
    yRatio: input.yRatio,
    widthRatio,
    heightRatio,
    endXRatio,
    endYRatio,
    pointsJson,
    styleJson,
    color
  };
}

function normalizeCustomStyleJson(styleJson: string | null) {
  if (!styleJson) {
    throw new Error("INVALID_ANNOTATION_COLOR");
  }

  try {
    const parsed = JSON.parse(styleJson) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("INVALID_ANNOTATION_COLOR");
    }
    const strokeColor = (parsed as { strokeColor?: unknown }).strokeColor;
    if (typeof strokeColor !== "string" || !customColorPattern.test(strokeColor)) {
      throw new Error("INVALID_ANNOTATION_COLOR");
    }
    return JSON.stringify({ ...(parsed as Record<string, unknown>), strokeColor: strokeColor.toLowerCase() });
  } catch (err) {
    if (err instanceof Error && err.message === "INVALID_ANNOTATION_COLOR") throw err;
    throw new Error("INVALID_ANNOTATION_COLOR");
  }
}

function validateInkPoints(pointsJson: string | null) {
  if (!pointsJson) {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }

  let points: unknown;
  try {
    points = JSON.parse(pointsJson);
  } catch {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }

  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("INVALID_ANNOTATION_GEOMETRY");
  }

  for (const point of points) {
    if (!isAnnotationPoint(point)) {
      throw new Error("INVALID_ANNOTATION_GEOMETRY");
    }
  }
}

function isAnnotationPoint(point: unknown): point is AnnotationPoint {
  if (!point || typeof point !== "object") return false;
  const candidate = point as Partial<AnnotationPoint>;
  return isRatio(candidate.xRatio) && isRatio(candidate.yRatio);
}

function isRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveRatio(value: unknown): value is number {
  return isRatio(value) && value > 0;
}

function mapApprovalAnnotation(row: ApprovalAnnotationRow): ApprovalAnnotation {
  return {
    id: row.id,
    approvalId: row.approval_id,
    authorUserId: row.author_user_id,
    authorUsername: row.author_username,
    authorDisplayName: row.author_display_name,
    authorRole: row.author_role,
    kind: row.kind,
    message: row.message,
    pageNumber: row.page_number,
    xRatio: row.x_ratio,
    yRatio: row.y_ratio,
    widthRatio: row.width_ratio,
    heightRatio: row.height_ratio,
    endXRatio: row.end_x_ratio,
    endYRatio: row.end_y_ratio,
    pointsJson: row.points_json,
    styleJson: row.style_json,
    color: row.color,
    resolved: row.resolved === 1,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
