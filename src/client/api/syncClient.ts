import type { z } from "zod";
import {
  createWebDavConnectionRequestSchema,
  createWebDavMappingRequestSchema,
  resolveWebDavConflictRequestSchema,
  retryWebDavSyncRequestSchema,
  testWebDavConnectionRequestSchema,
  triggerWebDavScanRequestSchema,
  updateWebDavConnectionRequestSchema,
  updateWebDavMappingRequestSchema,
  webDavConflictListQuerySchema,
  webDavConflictListResponseSchema,
  webDavConflictResponseSchema,
  webDavConnectionListResponseSchema,
  webDavConnectionResponseSchema,
  webDavMappingListResponseSchema,
  webDavMappingResponseSchema,
  webDavSyncItemListQuerySchema,
  webDavSyncItemListResponseSchema,
  webDavSyncItemResponseSchema,
  webDavSyncSummaryResponseSchema,
  type CreateWebDavConnectionRequest,
  type CreateWebDavMappingRequest,
  type ResolveWebDavConflictRequest,
  type UpdateWebDavConnectionRequest,
  type UpdateWebDavMappingRequest
} from "../../shared/contracts/webdav.ts";
import { uuidV7Schema } from "../../shared/contracts/common.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

export type WebDavConnection = z.infer<typeof webDavConnectionResponseSchema>;
export type WebDavMapping = z.infer<typeof webDavMappingResponseSchema>;
export type WebDavSyncItem = z.infer<typeof webDavSyncItemResponseSchema>;
export type WebDavConflict = z.infer<typeof webDavConflictResponseSchema>;
export type WebDavSyncSummary = z.infer<typeof webDavSyncSummaryResponseSchema>;

const base = "/api/v2/webdav-sync";

export function getWebDavSyncSummary(signal?: AbortSignal) {
  return platformSessionRequest(`${base}/summary`, { responseSchema: webDavSyncSummaryResponseSchema, signal });
}
export function listWebDavConnections(signal?: AbortSignal) {
  return platformSessionRequest(`${base}/connections`, { responseSchema: webDavConnectionListResponseSchema, signal });
}
export function createWebDavConnection(input: CreateWebDavConnectionRequest, signal?: AbortSignal) {
  return mutation(`${base}/connections`, "POST", createWebDavConnectionRequestSchema, input,
    webDavConnectionResponseSchema, signal);
}
export function updateWebDavConnection(connectionId: string, input: UpdateWebDavConnectionRequest,
  signal?: AbortSignal) {
  return mutation(`${base}/connections/${id(connectionId)}`, "PATCH", updateWebDavConnectionRequestSchema, input,
    webDavConnectionResponseSchema, signal);
}
export function testWebDavConnection(connectionId: string, reason: string, signal?: AbortSignal) {
  return mutation(`${base}/connections/${id(connectionId)}/test`, "POST", testWebDavConnectionRequestSchema,
    { reason }, webDavConnectionResponseSchema, signal);
}
export function listWebDavMappings(projectId?: string, signal?: AbortSignal) {
  const query = projectId ? `?projectId=${encodeURIComponent(id(projectId))}` : "";
  return platformSessionRequest(`${base}/mappings${query}`, { responseSchema: webDavMappingListResponseSchema, signal });
}
export function createWebDavMapping(input: CreateWebDavMappingRequest, signal?: AbortSignal) {
  return mutation(`${base}/mappings`, "POST", createWebDavMappingRequestSchema, input,
    webDavMappingResponseSchema, signal);
}
export function updateWebDavMapping(mappingId: string, input: UpdateWebDavMappingRequest, signal?: AbortSignal) {
  return mutation(`${base}/mappings/${id(mappingId)}`, "PATCH", updateWebDavMappingRequestSchema, input,
    webDavMappingResponseSchema, signal);
}
export function triggerWebDavScan(mappingId: string, reason: string, signal?: AbortSignal) {
  return mutation(`${base}/scans`, "POST", triggerWebDavScanRequestSchema,
    { mappingId: id(mappingId), reason, idempotencyKey: key("scan", mappingId) },
    webDavMappingResponseSchema, signal);
}
export function listWebDavSyncItems(query: z.input<typeof webDavSyncItemListQuerySchema> = {}, signal?: AbortSignal) {
  return platformSessionRequest(`${base}/items?${queryString(webDavSyncItemListQuerySchema, query)}`,
    { responseSchema: webDavSyncItemListResponseSchema, signal });
}
export function retryWebDavSyncItem(syncItemId: string, reason: string, signal?: AbortSignal) {
  return mutation(`${base}/items/${id(syncItemId)}/retry`, "POST", retryWebDavSyncRequestSchema,
    { reason, idempotencyKey: key("retry", syncItemId) }, webDavSyncItemResponseSchema, signal);
}
export function listWebDavConflicts(query: z.input<typeof webDavConflictListQuerySchema> = {}, signal?: AbortSignal) {
  return platformSessionRequest(`${base}/conflicts?${queryString(webDavConflictListQuerySchema, query)}`,
    { responseSchema: webDavConflictListResponseSchema, signal });
}
export function resolveWebDavConflict(conflictId: string, input: ResolveWebDavConflictRequest,
  signal?: AbortSignal) {
  return mutation(`${base}/conflicts/${id(conflictId)}/resolve`, "POST", resolveWebDavConflictRequestSchema, input,
    webDavConflictResponseSchema, signal);
}

function mutation<T extends z.ZodTypeAny, R extends z.ZodTypeAny>(target: string, method: "POST" | "PATCH", schema: T,
  input: z.input<T>, responseSchema: R, signal?: AbortSignal) {
  return platformSessionRequest(target, { method, json: parse(schema, input), responseSchema, signal });
}
function queryString<T extends z.ZodTypeAny>(schema: T, value: unknown) {
  const parsed = parse(schema, value) as Record<string, unknown>;
  const search = new URLSearchParams();
  for (const [name, candidate] of Object.entries(parsed)) if (candidate !== undefined) search.set(name, String(candidate));
  return search;
}
function key(action: string, target: string) { return `webdav:${action}:${target}:${crypto.randomUUID()}`; }
function id(value: string) { return parse(uuidV7Schema, value); }
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return parsed.data;
}
