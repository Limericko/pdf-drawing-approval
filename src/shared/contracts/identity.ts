import { z } from "zod";
import { uuidV7Schema } from "./common.ts";

const utf8Encoder = new TextEncoder();
const boundedSecret = (minimumBytes: number, maximumBytes: number) => z.string().refine((value) => {
  const bytes = utf8Encoder.encode(value).byteLength;
  return bytes >= minimumBytes && bytes <= maximumBytes && !value.includes("\0");
});

export const platformRoleSchema = z.enum(["admin", "member"]);
export const projectMemberRoleSchema = z.enum(["manager", "designer", "supervisor", "process", "viewer"]);

export const loginRequestSchema = z.object({
  email: z.string().max(254).email(),
  password: boundedSecret(1, 256)
}).strict();

export const mfaCompleteRequestSchema = z.object({
  challengeToken: boundedSecret(1, 256),
  factor: z.discriminatedUnion("method", [
    z.object({ method: z.literal("totp"), code: boundedSecret(1, 128) }).strict(),
    z.object({ method: z.literal("recovery"), code: boundedSecret(1, 128) }).strict()
  ])
}).strict();

export const createInvitationRequestSchema = z.object({
  email: z.string().max(254).email(),
  platformRole: platformRoleSchema,
  projectId: uuidV7Schema,
  projectRole: projectMemberRoleSchema
}).strict();

export const prepareInvitationRequestSchema = z.object({ invitationToken: boundedSecret(1, 512) }).strict();
export const completeInvitationRequestSchema = z.object({
  enrollmentToken: boundedSecret(1, 256),
  password: boundedSecret(12, 256),
  totp: boundedSecret(1, 128)
}).strict();

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).refine((value) => !/[\r\n\0]/.test(value))
}).strict();

export const projectIdParamsSchema = z.object({ projectId: uuidV7Schema }).strict();

export const loginResponseSchema = z.object({ next: z.literal("mfa"), challengeToken: z.string().min(1) }).strict();
export const globalCapabilitySchema = z.enum(["platform.security.manage", "projects.create"]);
export const projectCapabilitySchema = z.enum(["project.read", "project.members.manage",
  "project.invitations.create", "drawings.submit", "drawings.review", "drawings.process"]);
export const platformUserResponseSchema = z.object({
  id: uuidV7Schema,
  emailNormalized: z.string().email().max(254),
  displayName: z.string().min(1),
  platformRole: platformRoleSchema,
  status: z.enum(["active", "disabled"]),
  mfaStatus: z.enum(["disabled", "enabled"]),
  mfaEnabledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export const projectSummaryResponseSchema = z.object({
  id: uuidV7Schema,
  name: z.string().min(1).max(160),
  status: z.enum(["active", "archived"]),
  role: projectMemberRoleSchema,
  capabilities: z.array(projectCapabilitySchema)
}).strict();
export const mfaCompleteResponseSchema = z.object({ user: platformUserResponseSchema }).strict();
export const sessionResponseSchema = z.object({
  user: platformUserResponseSchema,
  globalCapabilities: z.array(globalCapabilitySchema),
  projects: z.array(projectSummaryResponseSchema),
  csrfToken: z.string().min(1).max(160)
}).strict();
export const createInvitationResponseSchema = z.object({ invitationId: uuidV7Schema }).strict();
export const invitationPrepareResponseSchema = z.object({ enrollmentToken: z.string().min(1),
  otpauthUri: z.string().startsWith("otpauth://") }).strict();
export const invitationCompleteResponseSchema = z.object({ recoveryCodes: z.array(z.string().min(1)).min(1) }).strict();
export const projectResponseSchema = z.object({ id: uuidV7Schema, name: z.string().min(1).max(160),
  status: z.enum(["active", "archived"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const projectMembershipResponseSchema = z.object({ id: uuidV7Schema, projectId: uuidV7Schema,
  userId: uuidV7Schema, role: projectMemberRoleSchema, status: z.enum(["active", "disabled"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export const createProjectResponseSchema = z.object({ project: projectResponseSchema,
  membership: projectMembershipResponseSchema, capabilities: z.array(projectCapabilitySchema) }).strict();
export const projectListResponseSchema = z.object({ projects: z.array(projectSummaryResponseSchema) }).strict();
export const projectMemberSummaryResponseSchema = z.object({
  membershipId: uuidV7Schema,
  userId: uuidV7Schema,
  emailNormalized: z.string().email().max(254),
  displayName: z.string().min(1),
  role: projectMemberRoleSchema,
  status: z.enum(["active", "disabled"]),
  updatedAt: z.string().datetime()
}).strict();
export const projectAccessResponseSchema = z.object({ project: projectResponseSchema,
  membership: projectMembershipResponseSchema, capabilities: z.array(projectCapabilitySchema),
  members: z.array(projectMemberSummaryResponseSchema).default([]) }).strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type MfaCompleteRequest = z.infer<typeof mfaCompleteRequestSchema>;
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;
export type PrepareInvitationRequest = z.infer<typeof prepareInvitationRequestSchema>;
export type CompleteInvitationRequest = z.infer<typeof completeInvitationRequestSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
