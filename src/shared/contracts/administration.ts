import { z } from "zod";
import { idempotencyKeySchema, isoDateTimeSchema, pageInfoSchema, paginationQuerySchema,
  uuidV7Schema } from "./common.ts";
import { projectMemberRoleSchema } from "./identity.ts";
import { backupRunResponseSchema } from "./business.ts";

export const adminUserResponseSchema = z.object({
  id: uuidV7Schema,
  emailNormalized: z.string().email().max(254),
  displayName: z.string().min(1).max(240),
  platformRole: z.enum(["admin", "member"]),
  status: z.enum(["active", "disabled"]),
  mfaStatus: z.enum(["disabled", "enabled"]),
  activeSessionCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
}).strict();

export const adminUserListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["active", "disabled"]).optional(),
  keyword: z.string().trim().max(160).optional()
}).strict();
export const adminUserListResponseSchema = z.object({ items: z.array(adminUserResponseSchema), page: pageInfoSchema }).strict();

export const setAdminUserStatusRequestSchema = z.object({
  status: z.enum(["active", "disabled"]),
  expectedUpdatedAt: isoDateTimeSchema,
  reason: z.string().trim().min(1).max(4000),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const updateAdminMembershipRequestSchema = z.object({
  role: projectMemberRoleSchema,
  status: z.enum(["active", "disabled"]),
  expectedUpdatedAt: isoDateTimeSchema,
  reason: z.string().trim().min(1).max(4000),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const revokeAdminSessionsRequestSchema = z.object({
  reason: z.string().trim().min(1).max(4000),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const retryAdminJobRequestSchema = z.object({
  reason: z.string().trim().min(1).max(4000),
  idempotencyKey: idempotencyKeySchema
}).strict();

export const adminMutationResponseSchema = z.object({
  targetId: uuidV7Schema,
  changed: z.boolean()
}).strict();

export const adminDeadJobResponseSchema = z.object({
  id: uuidV7Schema,
  jobType: z.string().min(1).max(128),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  errorCode: z.string().min(1).max(128).nullable(),
  updatedAt: isoDateTimeSchema
}).strict();

export const adminDiagnosticsResponseSchema = z.object({
  postgres: z.literal("healthy"),
  storage: z.enum(["healthy", "unhealthy"]),
  worker: z.object({ status: z.enum(["healthy", "stale", "missing"]), lastHeartbeatAt: isoDateTimeSchema.nullable() }).strict(),
  queue: z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative() }).strict(),
  deadJobs: z.array(adminDeadJobResponseSchema).max(50),
  renderFailures: z.number().int().nonnegative(),
  latestBackup: backupRunResponseSchema.nullable()
}).strict();

export const adminAuditQuerySchema = paginationQuerySchema.extend({
  actorUserId: uuidV7Schema.optional(),
  projectId: uuidV7Schema.optional(),
  action: z.string().trim().max(160).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional()
}).strict();
export const adminAuditEventResponseSchema = z.object({
  id: uuidV7Schema,
  occurredAt: isoDateTimeSchema,
  actorUserId: uuidV7Schema.nullable(),
  actorType: z.string().min(1).max(64),
  action: z.string().min(1).max(160),
  targetType: z.string().min(1).max(160),
  targetId: uuidV7Schema.nullable(),
  requestId: z.string().min(1).max(128),
  result: z.enum(["success", "failure"]),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
}).strict();
export const adminAuditListResponseSchema = z.object({ items: z.array(adminAuditEventResponseSchema), page: pageInfoSchema }).strict();
export const adminBackupListResponseSchema = z.object({ items: z.array(backupRunResponseSchema) }).strict();

export type SetAdminUserStatusRequest = z.infer<typeof setAdminUserStatusRequestSchema>;
export type UpdateAdminMembershipRequest = z.infer<typeof updateAdminMembershipRequestSchema>;
export type RevokeAdminSessionsRequest = z.infer<typeof revokeAdminSessionsRequestSchema>;
export type RetryAdminJobRequest = z.infer<typeof retryAdminJobRequestSchema>;
