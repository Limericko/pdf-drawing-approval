import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./apiClient.ts";
import { nextPollDelayMs, pollTraySummaryOnce } from "./poller.ts";
import type { TraySession } from "./authStore.ts";
import type { TraySummary } from "./types.ts";

const session: TraySession = {
  serverUrl: "http://127.0.0.1:8080",
  username: "supervisor",
  role: "supervisor",
  token: "token-1"
};

function summary(latestIds: number[]): TraySummary {
  return {
    serverTime: "2026-06-18T00:00:00.000Z",
    user: { id: 2, username: "supervisor", displayName: "主管", role: "supervisor" },
    tasks: {
      pendingCount: latestIds.length,
      latestIds,
      latest: latestIds.map((id) => ({
        id,
        projectName: "300A",
        partName: `支架${id}`,
        version: "a0A0",
        submittedAt: "2026-06-18T00:00:00.000Z",
        href: `#/approvals/${id}`
      }))
    },
    admin: null
  };
}

function store(initialSession: TraySession | null, notifiedIds: number[] = []) {
  return {
    load: vi.fn(() => initialSession),
    clear: vi.fn(),
    loadNotifiedIds: vi.fn(() => notifiedIds),
    saveNotifiedIds: vi.fn()
  };
}

describe("nextPollDelayMs", () => {
  it("uses normal interval when online and longer interval when offline", () => {
    expect(nextPollDelayMs("online")).toBe(30_000);
    expect(nextPollDelayMs("offline")).toBe(60_000);
    expect(nextPollDelayMs("auth_expired")).toBeNull();
  });
});

describe("pollTraySummaryOnce", () => {
  it("notifies only new approval ids and persists them", async () => {
    const authStore = store(session, [1]);
    const notify = vi.fn().mockResolvedValue(undefined);
    const client = {
      fetchTraySummary: vi.fn().mockResolvedValue(summary([1, 2]))
    };

    const result = await pollTraySummaryOnce({
      authStore,
      createClient: () => client,
      notify
    });

    expect(result.status).toBe("online");
    expect(notify).toHaveBeenCalledWith({
      id: 2,
      title: "有 1 张图纸待审核",
      body: "300A / 支架2-a0A0",
      targetUrl: "http://127.0.0.1:8080/#/approvals/2"
    });
    expect(authStore.saveNotifiedIds).toHaveBeenCalledWith([1, 2]);
  });

  it("does not poll authenticated endpoints when signed out", async () => {
    const authStore = store(null);
    const createClient = vi.fn();

    const result = await pollTraySummaryOnce({
      authStore,
      createClient,
      notify: vi.fn()
    });

    expect(result.status).toBe("signed_out");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("clears local session when the server rejects the token", async () => {
    const authStore = store(session);
    const client = {
      fetchTraySummary: vi.fn().mockRejectedValue(new ApiClientError("auth_expired", "expired"))
    };

    const result = await pollTraySummaryOnce({
      authStore,
      createClient: () => client,
      notify: vi.fn()
    });

    expect(result.status).toBe("auth_expired");
    expect(authStore.clear).toHaveBeenCalledOnce();
  });
});
