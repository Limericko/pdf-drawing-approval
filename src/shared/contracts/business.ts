import { z } from "zod";
import {
  boundedText,
  idempotencyKeySchema,
  isoDateTimeSchema,
  optimisticVersionSchema,
  pageInfoSchema,
  pageNumberSchema,
  paginationQuerySchema,
  uuidV7Schema
} from "./common.ts";

export const documentSourceSchema = z.enum(["web_upload", "webdav_import", "migration"]);
export const drawingRevisionStatusSchema = z.enum([
  "draft", "submitted", "approved", "rejected", "published", "void"
]);
export const metadataStatusSchema = z.enum([
  "complete", "missing_material_code", "missing_document_code", "missing_required"
]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "void"]);
export const reviewerRoleSchema = z.enum(["supervisor", "process"]);
export const reviewDecisionStatusSchema = z.enum(["pending", "approved", "rejected"]);
export const signerRoleSchema = z.enum(["designer", "supervisor", "process"]);
export const issueSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export const issueStatusSchema = z.enum(["open", "in_progress", "review", "closed"]);
export const pdmReleaseStatusSchema = z.enum(["pending_metadata", "pending", "published", "failed", "void"]);
export const taskKindSchema = z.enum([
  "approval_review", "issue_assigned", "issue_review", "pdm_metadata",
  "render_failure", "job_failure", "backup_warning"
]);
export const taskPrioritySchema = z.enum(["blocking", "high", "normal", "low"]);

export const projectResourceParamsSchema = z.object({ projectId: uuidV7Schema }).strict();
export const projectResourceIdParamsSchema = z.object({
  projectId: uuidV7Schema,
  resourceId: uuidV7Schema
}).strict();

export const documentResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  documentCode: boundedText(1, 160),
  name: boundedText(1, 240),
  version: optimisticVersionSchema,
  createdByUserId: uuidV7Schema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const drawingRevisionResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  documentId: uuidV7Schema,
  revisionCode: boundedText(1, 80),
  originalObjectId: uuidV7Schema,
  source: documentSourceSchema,
  status: drawingRevisionStatusSchema,
  metadataStatus: metadataStatusSchema,
  materialCode: boundedText(1, 160).nullable(),
  version: optimisticVersionSchema,
  createdByUserId: uuidV7Schema,
  submittedAt: isoDateTimeSchema.nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const reviewDecisionResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  approvalCaseId: uuidV7Schema,
  reviewerRole: reviewerRoleSchema,
  assignedUserId: uuidV7Schema,
  status: reviewDecisionStatusSchema,
  comment: boundedText(1, 4000).nullable(),
  version: optimisticVersionSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const approvalCaseResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  revisionId: uuidV7Schema,
  status: approvalStatusSchema,
  requiresSignature: z.boolean(),
  version: optimisticVersionSchema,
  createdByUserId: uuidV7Schema,
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  document: documentResponseSchema,
  revision: drawingRevisionResponseSchema,
  decisions: z.array(reviewDecisionResponseSchema).length(2),
  artifacts: z.array(z.object({
    id: uuidV7Schema,
    kind: z.enum(["annotated_review", "signed_pdf"]),
    generation: z.number().int().positive(),
    status: z.enum(["pending", "processing", "ready", "failed"]),
    objectId: uuidV7Schema.nullable(),
    errorCode: z.string().min(1).max(160).nullable(),
    readyAt: isoDateTimeSchema.nullable()
  }).strict())
}).strict();

export const documentDraftResponseSchema = z.object({
  document: documentResponseSchema,
  revision: drawingRevisionResponseSchema
}).strict();

export const signaturePlacementSchema = z.object({
  signerRole: signerRoleSchema,
  pageNumber: pageNumberSchema,
  xRatio: z.number().min(0).max(1),
  yRatio: z.number().min(0).max(1),
  widthRatio: z.number().positive().max(1),
  heightRatio: z.number().positive().max(1)
}).strict().superRefine((placement, context) => {
  if (placement.xRatio + placement.widthRatio > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["widthRatio"], message: "outside page" });
  }
  if (placement.yRatio + placement.heightRatio > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["heightRatio"], message: "outside page" });
  }
});

export const createDocumentDraftRequestSchema = z.object({
  documentCode: boundedText(1, 160),
  name: boundedText(1, 240),
  revisionCode: boundedText(1, 80),
  originalObjectId: uuidV7Schema,
  source: documentSourceSchema.default("web_upload"),
  materialCode: boundedText(1, 160).nullable().default(null),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const submitRevisionRequestSchema = z.object({
  version: optimisticVersionSchema,
  supervisorUserId: uuidV7Schema,
  processUserId: uuidV7Schema,
  requiresSignature: z.boolean(),
  placements: z.array(signaturePlacementSchema).length(3),
  idempotencyKey: idempotencyKeySchema
}).strict().superRefine((input, context) => {
  const roles = new Set(input.placements.map(({ signerRole }) => signerRole));
  for (const role of signerRoleSchema.options) {
    if (!roles.has(role)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["placements"], message: `missing ${role}` });
  }
});

export const reviewDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: boundedText(1, 4000).nullable().default(null),
  version: optimisticVersionSchema,
  idempotencyKey: idempotencyKeySchema
}).strict().superRefine((input, context) => {
  if (input.decision === "rejected" && !input.comment) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["comment"], message: "required" });
  }
});

export const approvalListQuerySchema = paginationQuerySchema.extend({
  status: approvalStatusSchema.optional(),
  reviewerRole: reviewerRoleSchema.optional(),
  keyword: z.string().trim().max(160).optional(),
  sort: z.enum(["created_desc", "created_asc", "due_asc"]).default("created_desc")
}).strict();

export const approvalListResponseSchema = z.object({
  items: z.array(approvalCaseResponseSchema),
  page: pageInfoSchema
}).strict();

export const annotationResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  approvalCaseId: uuidV7Schema,
  authorUserId: uuidV7Schema,
  kind: z.enum(["pin", "rect", "arrow", "circle", "text", "ink", "cloud"]),
  pageNumber: pageNumberSchema,
  geometry: z.record(z.unknown()),
  style: z.record(z.unknown()),
  message: boundedText(1, 4000),
  resolved: z.boolean(),
  version: optimisticVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const issueResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  approvalCaseId: uuidV7Schema,
  annotationId: uuidV7Schema.nullable(),
  annotation: annotationResponseSchema.nullable(),
  creatorUserId: uuidV7Schema,
  assigneeUserId: uuidV7Schema,
  title: boundedText(1, 240),
  description: boundedText(1, 8000),
  severity: issueSeveritySchema,
  status: issueStatusSchema,
  dueAt: isoDateTimeSchema.nullable(),
  version: optimisticVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

const annotationPayloadSchema = z.object({
  kind: z.enum(["pin", "rect", "arrow", "circle", "text", "ink", "cloud"]),
  pageNumber: pageNumberSchema,
  geometry: z.record(z.unknown()),
  style: z.record(z.unknown()).default({}),
  message: boundedText(1, 4000)
}).strict().superRefine((value, context) => {
  if (JSON.stringify(value.geometry).length > 32_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["geometry"], message: "too large" });
  }
  if (JSON.stringify(value.style).length > 8_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["style"], message: "too large" });
  }
});

export const createIssueRequestSchema = z.object({
  title: boundedText(1, 240),
  description: boundedText(1, 8000),
  severity: issueSeveritySchema,
  assigneeUserId: uuidV7Schema,
  dueAt: isoDateTimeSchema.nullable().default(null),
  annotation: annotationPayloadSchema.nullable().default(null),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const startIssueRequestSchema = z.object({
  version: optimisticVersionSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const submitIssueRequestSchema = startIssueRequestSchema.extend({
  resolutionSummary: boundedText(1, 8000)
}).strict();

export const reviewIssueRequestSchema = startIssueRequestSchema.extend({
  decision: z.enum(["closed", "returned"]),
  note: boundedText(1, 8000)
}).strict();

export const forceCloseIssueRequestSchema = startIssueRequestSchema.extend({
  reason: boundedText(1, 4000)
}).strict();

export const issueListQuerySchema = paginationQuerySchema.extend({
  approvalCaseId: uuidV7Schema.optional(),
  status: issueStatusSchema.optional(),
  severity: issueSeveritySchema.optional(),
  assigneeUserId: uuidV7Schema.optional()
}).strict();

export const issueListResponseSchema = z.object({ items: z.array(issueResponseSchema), page: pageInfoSchema }).strict();

export const partSummaryResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  partNumber: boundedText(1, 160),
  name: boundedText(1, 240),
  currentRevisionId: uuidV7Schema.nullable(),
  currentRevisionCode: boundedText(1, 80).nullable(),
  releaseStatus: pdmReleaseStatusSchema.nullable(),
  materialCode: boundedText(1, 160).nullable(),
  version: optimisticVersionSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const partRevisionResponseSchema = z.object({
  linkId: uuidV7Schema,
  revisionId: uuidV7Schema,
  revisionCode: boundedText(1, 80),
  documentId: uuidV7Schema,
  documentCode: boundedText(1, 160),
  approvalCaseId: uuidV7Schema,
  originalObjectId: uuidV7Schema,
  signedObjectId: uuidV7Schema.nullable(),
  annotatedObjectId: uuidV7Schema.nullable(),
  materialCode: boundedText(1, 160).nullable(),
  releaseStatus: pdmReleaseStatusSchema,
  voidReason: boundedText(1, 4000).nullable(),
  version: optimisticVersionSchema,
  releasedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const partDetailResponseSchema = z.object({
  part: partSummaryResponseSchema,
  revisions: z.array(partRevisionResponseSchema),
  usages: z.array(z.object({
    projectId: uuidV7Schema,
    projectName: boundedText(1, 160),
    firstApprovalCaseId: uuidV7Schema,
    lastApprovalCaseId: uuidV7Schema,
    updatedAt: isoDateTimeSchema
  }).strict())
}).strict();

export const pdmPartListQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(160).optional(),
  releaseStatus: pdmReleaseStatusSchema.optional(),
  sort: z.enum(["updated_desc", "part_number_asc"]).default("updated_desc")
}).strict();

export const pdmPartListResponseSchema = z.object({
  items: z.array(partSummaryResponseSchema),
  page: pageInfoSchema
}).strict();

export const updatePdmMetadataRequestSchema = z.object({
  materialCode: boundedText(1, 160),
  version: optimisticVersionSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const voidPdmRevisionRequestSchema = z.object({
  reason: boundedText(1, 4000),
  version: optimisticVersionSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const retryPdmPublishRequestSchema = z.object({
  version: optimisticVersionSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const taskResponseSchema = z.object({
  id: z.string().min(1).max(200),
  projectId: uuidV7Schema.nullable(),
  kind: taskKindSchema,
  priority: taskPrioritySchema,
  title: boundedText(1, 240),
  summary: boundedText(1, 500),
  dueAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  target: z.object({
    route: z.string().startsWith("/").max(500)
      .refine((route) => !route.startsWith("//") && !route.includes("\\") && !/[\r\n\0]/.test(route)),
    resourceId: uuidV7Schema.nullable()
  }).strict()
}).strict();

export const taskListResponseSchema = z.object({
  items: z.array(taskResponseSchema),
  counts: z.object({ blocking: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict()
}).strict();

export const taskListQuerySchema = z.object({
  projectId: uuidV7Schema.optional()
}).strict();

export const backupRunResponseSchema = z.object({
  id: uuidV7Schema,
  provider: z.enum(["postgres_pitr", "object_versioning", "configuration_export"]),
  status: z.enum(["running", "completed", "failed"]),
  recoveryPointAt: isoDateTimeSchema.nullable(),
  startedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  verificationStatus: z.enum(["pending", "passed", "failed"]),
  errorCode: z.string().max(160).nullable()
}).strict();

export const uploadedObjectResponseSchema = z.object({
  id: uuidV7Schema,
  mediaType: z.enum(["application/pdf", "image/png"]),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();

export const recordPrintArchiveRequestSchema = z.object({
  objectId: uuidV7Schema.nullable(),
  printerName: boundedText(1, 240).nullable().default(null),
  status: z.enum(["archived", "failed"]),
  errorCode: z.string().trim().min(1).max(160).nullable().default(null),
  idempotencyKey: idempotencyKeySchema
}).strict().superRefine((value, context) => {
  if (value.status === "archived" && (!value.objectId || value.errorCode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "invalid archive result" });
  }
  if (value.status === "failed" && !value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["errorCode"], message: "required" });
  }
});

export const printArchiveResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  approvalCaseId: uuidV7Schema,
  actorUserId: uuidV7Schema,
  objectId: uuidV7Schema.nullable(),
  printerName: boundedText(1, 240).nullable(),
  status: z.enum(["archived", "failed"]),
  errorCode: z.string().min(1).max(160).nullable(),
  createdAt: isoDateTimeSchema
}).strict();
export const printArchiveListResponseSchema = z.object({ items: z.array(printArchiveResponseSchema) }).strict();

export const setSignatureAssetRequestSchema = z.object({
  objectId: uuidV7Schema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const signatureAssetResponseSchema = z.object({
  id: uuidV7Schema,
  userId: uuidV7Schema,
  objectId: uuidV7Schema,
  kind: z.literal("handwritten_png"),
  createdAt: isoDateTimeSchema
}).strict();

export type SetSignatureAssetRequest = z.infer<typeof setSignatureAssetRequestSchema>;

export type CreateDocumentDraftRequest = z.infer<typeof createDocumentDraftRequestSchema>;
export type SubmitRevisionRequest = z.infer<typeof submitRevisionRequestSchema>;
export type ReviewDecisionRequest = z.infer<typeof reviewDecisionRequestSchema>;
export type ApprovalCaseResponse = z.infer<typeof approvalCaseResponseSchema>;
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;
export type TaskResponse = z.infer<typeof taskResponseSchema>;
export type UpdatePdmMetadataRequest = z.infer<typeof updatePdmMetadataRequestSchema>;
export type VoidPdmRevisionRequest = z.infer<typeof voidPdmRevisionRequestSchema>;
export type RetryPdmPublishRequest = z.infer<typeof retryPdmPublishRequestSchema>;
export type CreateIssueRequest = z.infer<typeof createIssueRequestSchema>;
export type StartIssueRequest = z.infer<typeof startIssueRequestSchema>;
export type SubmitIssueRequest = z.infer<typeof submitIssueRequestSchema>;
export type ReviewIssueRequest = z.infer<typeof reviewIssueRequestSchema>;
export type ForceCloseIssueRequest = z.infer<typeof forceCloseIssueRequestSchema>;
export type RecordPrintArchiveRequest = z.infer<typeof recordPrintArchiveRequestSchema>;
