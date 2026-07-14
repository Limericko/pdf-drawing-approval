import type { z } from "zod";
import {
  partDetailResponseSchema,
  pdmPartListQuerySchema,
  pdmPartListResponseSchema,
  retryPdmPublishRequestSchema,
  updatePdmMetadataRequestSchema,
  voidPdmRevisionRequestSchema,
  type RetryPdmPublishRequest,
  type UpdatePdmMetadataRequest,
  type VoidPdmRevisionRequest
} from "../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../shared/contracts/common.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

export type PlatformPartDetail = z.infer<typeof partDetailResponseSchema>;

export function listPdmParts(
  projectId: string,
  query: z.input<typeof pdmPartListQuerySchema> = {},
  signal?: AbortSignal
) {
  const parsed = parse(pdmPartListQuerySchema, query);
  const parameters = new URLSearchParams({ page: String(parsed.page), pageSize: String(parsed.pageSize),
    sort: parsed.sort });
  if (parsed.keyword) parameters.set("keyword", parsed.keyword);
  if (parsed.releaseStatus) parameters.set("releaseStatus", parsed.releaseStatus);
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/pdm/parts?${parameters}`, {
    responseSchema: pdmPartListResponseSchema,
    signal
  });
}

export function getPdmPart(projectId: string, partId: string, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/pdm/parts/${id(partId)}`, {
    responseSchema: partDetailResponseSchema,
    signal
  });
}

export function updatePdmMetadata(
  projectId: string,
  linkId: string,
  input: UpdatePdmMetadataRequest,
  signal?: AbortSignal
) {
  return mutate(projectId, linkId, "metadata", "PATCH", updatePdmMetadataRequestSchema, input, signal);
}

export function retryPdmPublish(
  projectId: string,
  linkId: string,
  input: RetryPdmPublishRequest,
  signal?: AbortSignal
) {
  return mutate(projectId, linkId, "retry", "POST", retryPdmPublishRequestSchema, input, signal);
}

export function voidPdmRevision(
  projectId: string,
  linkId: string,
  input: VoidPdmRevisionRequest,
  signal?: AbortSignal
) {
  return mutate(projectId, linkId, "void", "POST", voidPdmRevisionRequestSchema, input, signal);
}

function mutate<T extends z.ZodTypeAny>(projectId: string, linkId: string, action: string,
  method: "PATCH" | "POST", schema: T, input: z.input<T>, signal?: AbortSignal) {
  return platformSessionRequest(`/api/v2/projects/${id(projectId)}/pdm/revisions/${id(linkId)}/${action}`, {
    method,
    json: parse(schema, input),
    responseSchema: partDetailResponseSchema,
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
