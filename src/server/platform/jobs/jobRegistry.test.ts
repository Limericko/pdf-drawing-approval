import { describe, expect, it, vi } from "vitest";
import { JobRegistry } from "./jobRegistry.ts";
import { OutboxDispatcher } from "./dispatcher.ts";

describe("JobRegistry", () => {
  it("rejects an unknown event and lets the dispatch transaction roll back", async () => {
    let committed = false;
    const registry = new JobRegistry([], []);
    const dispatcher = new OutboxDispatcher({
      transactionRunner: async (callback) => { const result = await callback({ query: vi.fn() } as never); committed = true; return result; },
      createOutboxRepository: () => ({ claimUndispatched: async () => [{ id: "018f47a0-7b90-7cc1-8d73-123456789abc", eventType: "unknown", payloadVersion: 1, payload: {}, createdAt: new Date(), dispatchedAt: null }], markDispatched: vi.fn() }),
      createJobRepository: () => ({ create: vi.fn() } as never),
      mapEvent: registry.mapEvent,
      createId: () => "018f47a0-7b90-7cc1-8d73-123456789abd",
      clock: () => new Date()
    });
    await expect(dispatcher.dispatchBatch(1)).rejects.toMatchObject({ kind: "permanent", code: "UNKNOWN_OUTBOX_EVENT" });
    expect(committed).toBe(false);
  });

  it("classifies an unknown handler as a permanent safe failure", () => {
    expect(() => new JobRegistry([], []).resolve({ jobType: "unknown", payloadVersion: 1 }))
      .toThrow(expect.objectContaining({ kind: "permanent", code: "UNKNOWN_JOB_HANDLER" }));
  });

  it("maps exact versions and rejects duplicate registrations", () => {
    const handler = vi.fn();
    const event = { eventType: "created", payloadVersion: 2, handlerVersion: "v3", jobType: "send", jobPayloadVersion: 4, maxAttempts: 5 } as const;
    const registry = new JobRegistry([event], [{ jobType: "send", payloadVersion: 4, handler }]);
    expect(registry.mapEvent({ id: "018f47a0-7b90-7cc1-8d73-123456789abc", eventType: "created", payloadVersion: 2, payload: { value: 1 }, createdAt: new Date(), dispatchedAt: null }))
      .toMatchObject({ handlerVersion: "v3", jobType: "send", payloadVersion: 4, maxAttempts: 5, payload: { value: 1 } });
    expect(registry.resolve({ jobType: "send", payloadVersion: 4 })).toBe(handler);
    expect(() => new JobRegistry([event, event], [])).toThrow("INVALID_JOB_REGISTRATION");
    expect(() => new JobRegistry([], [{ jobType: "send", payloadVersion: 4, handler }, { jobType: "send", payloadVersion: 4, handler }])).toThrow("INVALID_JOB_REGISTRATION");
  });
});
