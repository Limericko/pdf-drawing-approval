import type { z } from "zod";
import { adminAuditListResponseSchema, adminAuditQuerySchema, adminBackupListResponseSchema,
  adminDiagnosticsResponseSchema, adminMutationResponseSchema, adminUserListQuerySchema,
  adminUserListResponseSchema, retryAdminJobRequestSchema, revokeAdminSessionsRequestSchema,
  setAdminUserStatusRequestSchema, updateAdminMembershipRequestSchema,
  adminSmtpSettingsResponseSchema, updateAdminSmtpSettingsRequestSchema,
  type RetryAdminJobRequest, type RevokeAdminSessionsRequest, type SetAdminUserStatusRequest,
  type UpdateAdminMembershipRequest, type UpdateAdminSmtpSettingsRequest } from "../../shared/contracts/administration.ts";
import { uuidV7Schema } from "../../shared/contracts/common.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

export function listAdminUsers(query: z.input<typeof adminUserListQuerySchema> = {}, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/administration/users?${queryString(adminUserListQuerySchema, query)}`,
    { responseSchema: adminUserListResponseSchema, signal });
}
export function setAdminUserStatus(userId: string, input: SetAdminUserStatusRequest, signal?: AbortSignal) {
  return mutate(`/api/v2/administration/users/${id(userId)}/status`, "PATCH", setAdminUserStatusRequestSchema, input, signal);
}
export function revokeAdminUserSessions(userId: string, input: RevokeAdminSessionsRequest, signal?: AbortSignal) {
  return mutate(`/api/v2/administration/users/${id(userId)}/sessions/revoke`, "POST",
    revokeAdminSessionsRequestSchema, input, signal);
}
export function updateAdminMembership(projectId: string, membershipId: string,
  input: UpdateAdminMembershipRequest, signal?: AbortSignal) {
  return mutate(`/api/v2/administration/projects/${id(projectId)}/memberships/${id(membershipId)}`, "PATCH",
    updateAdminMembershipRequestSchema, input, signal);
}
export function retryAdminJob(jobId: string, input: RetryAdminJobRequest, signal?: AbortSignal) {
  return mutate(`/api/v2/administration/jobs/${id(jobId)}/retry`, "POST", retryAdminJobRequestSchema, input, signal);
}
export function getAdminDiagnostics(signal?: AbortSignal) {
  return platformSessionRequest("/api/v2/administration/diagnostics", { responseSchema: adminDiagnosticsResponseSchema, signal });
}
export function listAdminBackups(signal?: AbortSignal) {
  return platformSessionRequest("/api/v2/administration/backups", { responseSchema: adminBackupListResponseSchema, signal });
}
export function listAdminAudit(query: z.input<typeof adminAuditQuerySchema> = {}, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/administration/audit?${queryString(adminAuditQuerySchema, query)}`,
    { responseSchema: adminAuditListResponseSchema, signal });
}
export function getAdminSmtpSettings(signal?: AbortSignal) {
  return platformSessionRequest("/api/v2/administration/settings/smtp",
    { responseSchema: adminSmtpSettingsResponseSchema, signal });
}
export function updateAdminSmtpSettings(input: UpdateAdminSmtpSettingsRequest, signal?: AbortSignal) {
  return platformSessionRequest("/api/v2/administration/settings/smtp", { method: "PUT",
    json: parse(updateAdminSmtpSettingsRequestSchema, input), responseSchema: adminSmtpSettingsResponseSchema, signal });
}

function mutate<T extends z.ZodTypeAny>(target: string, method: "POST" | "PATCH" | "PUT", schema: T,
  input: z.input<T>, signal?: AbortSignal) {
  return platformSessionRequest(target, { method, json: parse(schema, input),
    responseSchema: adminMutationResponseSchema, signal });
}
function queryString<T extends z.ZodTypeAny>(schema: T, value: unknown) {
  const parsed = parse(schema, value) as Record<string, unknown>;
  const search = new URLSearchParams();
  for (const [key, candidate] of Object.entries(parsed)) if (candidate !== undefined) search.set(key, String(candidate));
  return search;
}
function id(value: string) { return parse(uuidV7Schema, value); }
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return parsed.data;
}
