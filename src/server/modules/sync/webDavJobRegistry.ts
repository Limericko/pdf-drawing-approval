import type { EventRegistration, HandlerRegistration } from "../../platform/jobs/jobRegistry.ts";
import type { JsonObject, OutboxEvent } from "../../platform/jobs/jobTypes.ts";
import type { createWebDavWorkerHandlers } from "./webDavWorkerHandlers.ts";

export function webDavEventRegistrations(maxAttempts: number): readonly EventRegistration[] {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("INVALID_JOB_REGISTRATION");
  }
  return [
    event("webdav.connection.test", "webdav.connection.test", maxAttempts, (source) =>
      exactIdPayload(source, "connectionId")),
    event("webdav.mapping.scan", "webdav.mapping.scan", maxAttempts, (source) =>
      exactIdPayload(source, "mappingId")),
    event("webdav.sync.requested", "webdav.sync", maxAttempts, (source) =>
      exactIdPayload(source, "syncItemId")),
    event("webdav.sync.retry", "webdav.sync", maxAttempts, (source) =>
      exactIdPayload(source, "syncItemId")),
    event("webdav.conflict.resolve", "webdav.sync", maxAttempts, (source) => {
      const conflictId = source.payload.conflictId;
      if (typeof conflictId !== "string" || typeof source.payload.resolution !== "string") invalid();
      return { conflictId };
    }),
    event("pdm.revision.published", "webdav.publish.enqueue", maxAttempts, (source) => {
      const { projectId, approvalId, revisionId } = source.payload;
      if (Object.keys(source.payload).sort().join(",") !== "approvalId,projectId,revisionId" ||
          typeof projectId !== "string" || typeof approvalId !== "string" || typeof revisionId !== "string") invalid();
      return { projectId, approvalId, revisionId };
    })
  ];
}

export function webDavHandlerRegistrations(
  handlers: ReturnType<typeof createWebDavWorkerHandlers>
): readonly HandlerRegistration[] {
  return [
    { jobType: "webdav.connection.test", payloadVersion: 1, handler: handlers.testConnection },
    { jobType: "webdav.mapping.scan", payloadVersion: 1, handler: handlers.scanMapping },
    { jobType: "webdav.sync", payloadVersion: 1, handler: handlers.processSyncItem },
    { jobType: "webdav.publish.enqueue", payloadVersion: 1, handler: handlers.enqueuePublishedRevision }
  ];
}

function event(eventType: string, jobType: string, maxAttempts: number,
  mapPayload: (event: OutboxEvent) => JsonObject): EventRegistration {
  return { eventType, payloadVersion: 1, handlerVersion: "v1", jobType, jobPayloadVersion: 1,
    maxAttempts, mapPayload };
}

function exactIdPayload(event: OutboxEvent, field: string) {
  const value = event.payload[field];
  if (Object.keys(event.payload).length !== 1 || typeof value !== "string") invalid();
  return { [field]: value };
}
function invalid(): never { throw new Error("INVALID_JOB_REGISTRATION"); }
