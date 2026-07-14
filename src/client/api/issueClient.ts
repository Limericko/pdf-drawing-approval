import type { z } from "zod";
import { createIssueRequestSchema, forceCloseIssueRequestSchema, issueListQuerySchema, issueListResponseSchema,
  issueResponseSchema, reviewIssueRequestSchema, startIssueRequestSchema, submitIssueRequestSchema,
  type CreateIssueRequest, type ForceCloseIssueRequest, type ReviewIssueRequest,
  type StartIssueRequest, type SubmitIssueRequest } from "../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../shared/contracts/common.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

export function createIssue(projectId: string, approvalId: string, input: CreateIssueRequest, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/approvals/${id(approvalId)}/issues`, {
    method: "POST", json: parse(createIssueRequestSchema, input), responseSchema: issueResponseSchema, signal
  });
}
export function getIssue(projectId: string, issueId: string, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/issues/${id(issueId)}`,
    { responseSchema: issueResponseSchema, signal });
}
export function listIssues(projectId: string, query: z.input<typeof issueListQuerySchema> = {}, signal?: AbortSignal) {
  const parsed = parse(issueListQuerySchema, query);
  const search = new URLSearchParams({ page: String(parsed.page), pageSize: String(parsed.pageSize) });
  if (parsed.approvalCaseId) search.set("approvalCaseId", parsed.approvalCaseId);
  if (parsed.status) search.set("status", parsed.status);
  if (parsed.severity) search.set("severity", parsed.severity);
  if (parsed.assigneeUserId) search.set("assigneeUserId", parsed.assigneeUserId);
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/issues?${search}`,
    { responseSchema: issueListResponseSchema, signal });
}
export function startIssue(projectId: string, issueId: string, input: StartIssueRequest, signal?: AbortSignal) {
  return command(projectId, issueId, "start", startIssueRequestSchema, input, signal);
}
export function submitIssue(projectId: string, issueId: string, input: SubmitIssueRequest, signal?: AbortSignal) {
  return command(projectId, issueId, "submit", submitIssueRequestSchema, input, signal);
}
export function reviewIssue(projectId: string, issueId: string, input: ReviewIssueRequest, signal?: AbortSignal) {
  return command(projectId, issueId, "review", reviewIssueRequestSchema, input, signal);
}
export function forceCloseIssue(projectId: string, issueId: string, input: ForceCloseIssueRequest, signal?: AbortSignal) {
  return command(projectId, issueId, "force-close", forceCloseIssueRequestSchema, input, signal);
}
function command<T extends z.ZodTypeAny>(projectId: string, issueId: string, action: string, schema: T,
  input: z.input<T>, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/issues/${id(issueId)}/${action}`, {
    method: "POST", json: parse(schema, input), responseSchema: issueResponseSchema, signal
  });
}
function id(value: string) { return parse(uuidV7Schema, value); }
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return parsed.data;
}
