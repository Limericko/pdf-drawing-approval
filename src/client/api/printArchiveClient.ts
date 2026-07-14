import { printArchiveListResponseSchema, printArchiveResponseSchema, recordPrintArchiveRequestSchema,
  type RecordPrintArchiveRequest } from "../../shared/contracts/business.ts";
import { uuidV7Schema } from "../../shared/contracts/common.ts";
import { platformSessionRequest } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

export function recordPrintArchive(projectId: string, approvalId: string, input: RecordPrintArchiveRequest,
  signal?: AbortSignal) {
  return platformSessionRequest(target(projectId, approvalId), { method: "POST",
    json: parse(recordPrintArchiveRequestSchema, input), responseSchema: printArchiveResponseSchema, signal });
}
export function listPrintArchive(projectId: string, approvalId: string, signal?: AbortSignal) {
  return platformSessionRequest(target(projectId, approvalId), { responseSchema: printArchiveListResponseSchema, signal });
}
function target(projectId: string, approvalId: string) {
  return `/api/v2/projects/${parse(uuidV7Schema, projectId)}/approvals/${parse(uuidV7Schema, approvalId)}/print-archive`;
}
function parse<T extends typeof uuidV7Schema | typeof recordPrintArchiveRequestSchema>(schema: T, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PlatformRequestError(0, "REQUEST_INPUT_INVALID", "", "Invalid request input");
  return parsed.data;
}
