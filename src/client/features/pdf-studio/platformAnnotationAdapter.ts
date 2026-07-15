import type { z } from "zod";
import type { ApprovalAnnotation, ApprovalAnnotationInput } from "./annotationTypes.ts";
import { issueResponseSchema } from "../../../shared/contracts/business.ts";

export type PlatformIssue = z.infer<typeof issueResponseSchema>;
export type PlatformAnnotation = NonNullable<PlatformIssue["annotation"]>;

export function platformAnnotationToWorkspace(annotation: PlatformAnnotation, issue: PlatformIssue): ApprovalAnnotation {
  const geometry = asRecord(annotation.geometry);
  const style = asRecord(annotation.style);
  const xRatio = numberValue(geometry, "xRatio", "x");
  const yRatio = numberValue(geometry, "yRatio", "y");
  const widthRatio = nullableNumber(geometry, "widthRatio", "w");
  const heightRatio = nullableNumber(geometry, "heightRatio", "h");
  const pointsJson = pointsJsonValue(geometry);
  return {
    id: stableNumericId(annotation.id),
    approvalId: stableNumericId(issue.approvalCaseId),
    authorUserId: stableNumericId(annotation.authorUserId),
    authorUsername: null,
    authorDisplayName: null,
    authorRole: null,
    kind: annotation.kind,
    message: annotation.message,
    pageNumber: annotation.pageNumber,
    xRatio,
    yRatio,
    widthRatio,
    heightRatio,
    endXRatio: nullableNumber(geometry, "endXRatio", "endX"),
    endYRatio: nullableNumber(geometry, "endYRatio", "endY"),
    pointsJson,
    styleJson: JSON.stringify(style),
    color: colorValue(style),
    resolved: annotation.resolved || issue.status === "closed",
    resolvedByUserId: null,
    resolvedAt: issue.status === "closed" ? issue.updatedAt : null,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    externalId: annotation.id,
    externalApprovalId: issue.approvalCaseId,
    externalAuthorUserId: annotation.authorUserId
  };
}

export function workspaceAnnotationToPlatform(annotation: ApprovalAnnotationInput) {
  const geometry: Record<string, unknown> = {
    xRatio: annotation.xRatio,
    yRatio: annotation.yRatio,
    widthRatio: annotation.widthRatio ?? null,
    heightRatio: annotation.heightRatio ?? null,
    endXRatio: annotation.endXRatio ?? null,
    endYRatio: annotation.endYRatio ?? null
  };
  if (annotation.pointsJson) geometry.pointsJson = annotation.pointsJson;
  return {
    kind: annotation.kind,
    pageNumber: annotation.pageNumber,
    geometry,
    style: parseStyle(annotation.styleJson, annotation.color),
    message: annotation.message.trim()
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function nullableNumber(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function pointsJsonValue(record: Record<string, unknown>) {
  if (typeof record.pointsJson === "string") return record.pointsJson;
  return Array.isArray(record.points) ? JSON.stringify(record.points) : null;
}

function colorValue(style: Record<string, unknown>): ApprovalAnnotation["color"] {
  return style.color === "amber" || style.color === "blue" || style.color === "green" || style.color === "custom"
    ? style.color : "red";
}

function parseStyle(styleJson: string | null | undefined, color: ApprovalAnnotationInput["color"]) {
  let style = asRecord(undefined);
  if (styleJson) {
    try { style = asRecord(JSON.parse(styleJson)); } catch { style = {}; }
  }
  if (color) style = { ...style, color };
  return style;
}

function stableNumericId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return Math.abs(hash) || 1;
}
