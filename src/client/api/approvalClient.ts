import type { z } from "zod";
import {
  approvalCaseResponseSchema,
  approvalListQuerySchema,
  approvalListResponseSchema,
  createDocumentDraftRequestSchema,
  documentDraftResponseSchema,
  reviewDecisionRequestSchema,
  reviewerRoleSchema,
  submitRevisionRequestSchema,
  type CreateDocumentDraftRequest,
  type ReviewDecisionRequest,
  type SubmitRevisionRequest
} from "../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../shared/contracts/common.ts";
import { PlatformRequestError } from "./platformRequest.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { uploadPlatformObject } from "./storageClient.ts";

export type PlatformApproval = z.infer<typeof approvalCaseResponseSchema>;

export async function uploadDocumentDraft(
  projectId: string,
  file: Blob,
  input: Omit<CreateDocumentDraftRequest, "originalObjectId">,
  signal?: AbortSignal
) {
  if (!(file instanceof Blob) || file.type !== "application/pdf") {
    throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid PDF upload");
  }
  const object = await uploadPlatformObject(file, signal);
  return createDocumentDraft(projectId, { ...input, originalObjectId: object.id }, signal);
}

export function createDocumentDraft(
  projectId: string,
  input: CreateDocumentDraftRequest,
  signal?: AbortSignal
) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/documents/drafts`, {
    method: "POST",
    json: parse(createDocumentDraftRequestSchema, input),
    responseSchema: documentDraftResponseSchema,
    signal
  });
}

export function submitDrawingRevision(
  projectId: string,
  revisionId: string,
  input: SubmitRevisionRequest,
  signal?: AbortSignal
) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/revisions/${id(revisionId)}/submit`, {
    method: "POST",
    json: parse(submitRevisionRequestSchema, input),
    responseSchema: approvalCaseResponseSchema,
    signal
  });
}

export function decideApproval(
  projectId: string,
  approvalId: string,
  reviewerRole: "supervisor" | "process",
  input: ReviewDecisionRequest,
  signal?: AbortSignal
) {
  const role = parse(reviewerRoleSchema, reviewerRole);
  return platformSessionRequest(
    `/api/v2/projects/${id(projectId)}/approvals/${id(approvalId)}/decisions/${role}`,
    {
      method: "POST",
      json: parse(reviewDecisionRequestSchema, input),
      responseSchema: approvalCaseResponseSchema,
      signal
    }
  );
}

export function getApproval(projectId: string, approvalId: string, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/approvals/${id(approvalId)}`, {
    responseSchema: approvalCaseResponseSchema,
    signal
  });
}

export function listApprovals(
  projectId: string,
  query: z.input<typeof approvalListQuerySchema> = {},
  signal?: AbortSignal
) {
  const parsed = parse(approvalListQuerySchema, query);
  const parameters = new URLSearchParams({ page: String(parsed.page), pageSize: String(parsed.pageSize),
    sort: parsed.sort });
  if (parsed.status) parameters.set("status", parsed.status);
  if (parsed.reviewerRole) parameters.set("reviewerRole", parsed.reviewerRole);
  if (parsed.keyword) parameters.set("keyword", parsed.keyword);
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/approvals?${parameters}`, {
    responseSchema: approvalListResponseSchema,
    signal
  });
}

function id(value: string) {
  return parse(uuidV7Schema, value);
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return parsed.data;
}
