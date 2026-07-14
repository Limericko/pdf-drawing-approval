import { z } from "zod";
import { boundedText, idempotencyKeySchema, isoDateTimeSchema, optimisticVersionSchema,
  pageInfoSchema, paginationQuerySchema, uuidV7Schema } from "./common.ts";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nullableSha256Schema = sha256HexSchema.nullable();
const nullableRemoteText = z.string().min(1).max(1024).nullable();

export const webDavConnectionStatusSchema = z.enum(["active", "disabled", "error"]);
export const webDavMappingStatusSchema = z.enum(["active", "disabled"]);
export const webDavPublishVariantSchema = z.enum(["original", "review", "signed"]);
export const webDavSyncDirectionSchema = z.enum(["inbound", "outbound"]);
export const webDavSyncStatusSchema = z.enum([
  "discovered", "downloading", "validating", "imported", "pending_upload", "uploading", "verifying",
  "succeeded", "conflict", "remote_missing", "failed"
  , "skipped"
]);
export const webDavConflictStatusSchema = z.enum(["open", "resolved"]);
export const webDavConflictResolutionSchema = z.enum([
  "import_as_new_version", "publish_cloud_as_renamed", "keep_remote"
]);

export const webDavEndpointSchema = z.string().trim().min(1).max(2048).superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid WebDAV endpoint" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid WebDAV endpoint" });
  }
});

export const webDavCredentialRefSchema = z.string().trim().min(3).max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.split("/").some((segment) => segment === "." || segment === ".."));

export const webDavRemotePathSchema = z.string().trim().min(2).max(1024)
  .transform((value) => value.normalize("NFC"))
  .refine((value) => value.startsWith("/") && value !== "/" && !value.endsWith("/"))
  .refine((value) => !value.includes("\\") && !value.includes("//") && !/[\u0000-\u001f\u007f]/.test(value))
  .refine((value) => !value.split("/").some((segment) => segment === "." || segment === ".."));

const reasonSchema = boundedText(1, 4000);
const mutationFields = {
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema
} as const;

export const createWebDavConnectionRequestSchema = z.object({
  name: boundedText(1, 160),
  endpointUrl: webDavEndpointSchema,
  credentialRef: webDavCredentialRefSchema,
  ...mutationFields
}).strict();

export const updateWebDavConnectionRequestSchema = z.object({
  name: boundedText(1, 160),
  endpointUrl: webDavEndpointSchema,
  credentialRef: webDavCredentialRefSchema,
  status: webDavConnectionStatusSchema,
  version: optimisticVersionSchema,
  ...mutationFields
}).strict();

export const testWebDavConnectionRequestSchema = z.object({
  reason: reasonSchema
}).strict();

export const webDavCapabilitiesSchema = z.object({
  class1: z.boolean(),
  move: z.boolean(),
  rangeDownload: z.boolean()
}).strict();

export const webDavConnectionResponseSchema = z.object({
  id: uuidV7Schema,
  name: z.string().min(1).max(160),
  endpointUrl: webDavEndpointSchema,
  credentialRef: webDavCredentialRefSchema,
  credentialAvailable: z.boolean(),
  status: webDavConnectionStatusSchema,
  capabilities: webDavCapabilitiesSchema,
  lastCheckedAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().min(1).max(128).nullable(),
  version: optimisticVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const webDavConnectionListResponseSchema = z.object({
  items: z.array(webDavConnectionResponseSchema)
}).strict();

export const createWebDavMappingRequestSchema = z.object({
  connectionId: uuidV7Schema,
  projectId: uuidV7Schema,
  incomingPath: webDavRemotePathSchema,
  outgoingPath: webDavRemotePathSchema,
  publishVariant: webDavPublishVariantSchema,
  scanIntervalSeconds: z.number().int().min(30).max(86_400),
  ...mutationFields
}).strict().superRefine((value, context) => {
  if (pathsOverlap(value.incomingPath, value.outgoingPath)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outgoingPath"], message: "WebDAV paths overlap" });
  }
});

export const updateWebDavMappingRequestSchema = z.object({
  incomingPath: webDavRemotePathSchema,
  outgoingPath: webDavRemotePathSchema,
  publishVariant: webDavPublishVariantSchema,
  scanIntervalSeconds: z.number().int().min(30).max(86_400),
  status: webDavMappingStatusSchema,
  version: optimisticVersionSchema,
  ...mutationFields
}).strict().superRefine((value, context) => {
  if (pathsOverlap(value.incomingPath, value.outgoingPath)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outgoingPath"], message: "WebDAV paths overlap" });
  }
});

export const webDavMappingResponseSchema = z.object({
  id: uuidV7Schema,
  connectionId: uuidV7Schema,
  projectId: uuidV7Schema,
  projectName: z.string().min(1).max(240),
  incomingPath: webDavRemotePathSchema,
  outgoingPath: webDavRemotePathSchema,
  publishVariant: webDavPublishVariantSchema,
  scanIntervalSeconds: z.number().int().min(30).max(86_400),
  status: webDavMappingStatusSchema,
  nextScanAt: isoDateTimeSchema,
  lastScanAt: isoDateTimeSchema.nullable(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  version: optimisticVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const webDavMappingListResponseSchema = z.object({ items: z.array(webDavMappingResponseSchema) }).strict();

export const webDavSyncItemResponseSchema = z.object({
  id: uuidV7Schema,
  mappingId: uuidV7Schema,
  projectId: uuidV7Schema,
  direction: webDavSyncDirectionSchema,
  remotePath: webDavRemotePathSchema,
  remoteEtag: nullableRemoteText,
  remoteSizeBytes: z.number().int().nonnegative().nullable(),
  remoteModifiedAt: isoDateTimeSchema.nullable(),
  remoteSha256: nullableSha256Schema,
  storageObjectId: uuidV7Schema.nullable(),
  revisionId: uuidV7Schema.nullable(),
  status: webDavSyncStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().min(1).max(128).nullable(),
  version: optimisticVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable()
}).strict();

export const webDavSyncItemListQuerySchema = paginationQuerySchema.extend({
  projectId: uuidV7Schema.optional(),
  mappingId: uuidV7Schema.optional(),
  direction: webDavSyncDirectionSchema.optional(),
  status: webDavSyncStatusSchema.optional()
}).strict();

export const webDavSyncItemListResponseSchema = z.object({
  items: z.array(webDavSyncItemResponseSchema),
  page: pageInfoSchema
}).strict();

const conflictSideRemoteSchema = z.object({
  etag: nullableRemoteText,
  sizeBytes: z.number().int().nonnegative().nullable(),
  modifiedAt: isoDateTimeSchema.nullable(),
  sha256: nullableSha256Schema
}).strict();
const conflictSideCloudSchema = z.object({
  revisionId: uuidV7Schema.nullable(),
  objectId: uuidV7Schema.nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: nullableSha256Schema
}).strict();

export const webDavConflictResponseSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  mappingId: uuidV7Schema,
  syncItemId: uuidV7Schema,
  direction: webDavSyncDirectionSchema,
  remotePath: webDavRemotePathSchema,
  status: webDavConflictStatusSchema,
  resolution: webDavConflictResolutionSchema.nullable(),
  resolutionReason: z.string().min(1).max(4000).nullable(),
  renamedRemotePath: webDavRemotePathSchema.nullable(),
  version: optimisticVersionSchema,
  remote: conflictSideRemoteSchema,
  cloud: conflictSideCloudSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedByUserId: uuidV7Schema.nullable()
}).strict();

export const webDavConflictListQuerySchema = paginationQuerySchema.extend({
  projectId: uuidV7Schema.optional(),
  status: webDavConflictStatusSchema.optional()
}).strict();
export const webDavConflictListResponseSchema = z.object({
  items: z.array(webDavConflictResponseSchema), page: pageInfoSchema
}).strict();

export const resolveWebDavConflictRequestSchema = z.object({
  resolution: webDavConflictResolutionSchema,
  renamedRemotePath: webDavRemotePathSchema.nullable().default(null),
  reason: reasonSchema,
  version: optimisticVersionSchema,
  idempotencyKey: idempotencyKeySchema
}).strict().superRefine((value, context) => {
  if ((value.resolution === "publish_cloud_as_renamed") !== (value.renamedRemotePath !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["renamedRemotePath"], message: "Renamed path mismatch" });
  }
});

export const triggerWebDavScanRequestSchema = z.object({
  mappingId: uuidV7Schema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const retryWebDavSyncRequestSchema = z.object({
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

export const webDavSyncSummaryResponseSchema = z.object({
  connections: z.object({ active: z.number().int().nonnegative(), error: z.number().int().nonnegative() }).strict(),
  mappings: z.object({ active: z.number().int().nonnegative(), due: z.number().int().nonnegative() }).strict(),
  items: z.object({ pending: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    remoteMissing: z.number().int().nonnegative() }).strict(),
  openConflicts: z.number().int().nonnegative(),
  lastSuccessfulSyncAt: isoDateTimeSchema.nullable()
}).strict();

export type CreateWebDavConnectionRequest = z.infer<typeof createWebDavConnectionRequestSchema>;
export type UpdateWebDavConnectionRequest = z.infer<typeof updateWebDavConnectionRequestSchema>;
export type CreateWebDavMappingRequest = z.infer<typeof createWebDavMappingRequestSchema>;
export type UpdateWebDavMappingRequest = z.infer<typeof updateWebDavMappingRequestSchema>;
export type ResolveWebDavConflictRequest = z.infer<typeof resolveWebDavConflictRequestSchema>;

function pathsOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
