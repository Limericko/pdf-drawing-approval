import { describe, expect, it, vi } from "vitest";
import { JobRegistry } from "../../platform/jobs/jobRegistry.ts";
import type { JsonObject } from "../../platform/jobs/jobTypes.ts";
import { webDavEventRegistrations, webDavHandlerRegistrations } from "./webDavJobRegistry.ts";

describe("WebDAV job registrations", () => {
  it("maps exact sync and PDM events to versioned jobs", () => {
    const handlers = { testConnection: vi.fn(), scanMapping: vi.fn(), processSyncItem: vi.fn(),
      enqueuePublishedRevision: vi.fn() };
    const registry = new JobRegistry(webDavEventRegistrations(5), webDavHandlerRegistrations(handlers as never));
    expect(registry.mapEvent(event("webdav.sync.retry", { syncItemId: "item" })))
      .toMatchObject({ jobType: "webdav.sync", payload: { syncItemId: "item" }, maxAttempts: 5 });
    expect(registry.mapEvent(event("pdm.revision.published", {
      projectId: "project", approvalId: "approval", revisionId: "revision"
    }))).toMatchObject({ jobType: "webdav.publish.enqueue", payload: {
      projectId: "project", approvalId: "approval", revisionId: "revision"
    } });
  });

  it("rejects malformed WebDAV outbox payloads", () => {
    const registry = new JobRegistry(webDavEventRegistrations(5), []);
    expect(() => registry.mapEvent(event("webdav.mapping.scan", { mappingId: "mapping", extra: true })))
      .toThrow("INVALID_JOB_REGISTRATION");
  });
});

function event(eventType: string, payload: JsonObject) {
  return { id: "01890f1e-9b4a-7cc2-8f00-000000003001", eventType, payloadVersion: 1, payload,
    createdAt: new Date(), dispatchedAt: null };
}
