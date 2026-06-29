import { describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient } from "./apiClient.ts";

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  return {
    ok: init.ok ?? (init.status === undefined || init.status < 400),
    status: init.status ?? 200,
    json: vi.fn().mockResolvedValue(body)
  } as unknown as Response;
}

describe("createApiClient", () => {
  it("logs in with username and password", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        token: "token-1",
        user: { id: 2, username: "supervisor", displayName: "主管", role: "supervisor" }
      })
    );
    const client = createApiClient("http://127.0.0.1:8080/", fetchImpl);

    const result = await client.login("supervisor", "123456");

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8080/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "supervisor", password: "123456" })
    });
    expect(result.token).toBe("token-1");
    expect(result.user.role).toBe("supervisor");
  });

  it("fetches tray summary with bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        serverTime: "2026-06-18T00:00:00.000Z",
        user: { id: 2, username: "supervisor", displayName: "主管", role: "supervisor" },
        tasks: { pendingCount: 1, latestIds: [1], latest: [] },
        admin: null
      })
    );
    const client = createApiClient("http://127.0.0.1:8080", fetchImpl);

    const summary = await client.fetchTraySummary("token-1");

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8080/api/tray/summary", {
      headers: { Authorization: "Bearer token-1" }
    });
    expect(summary.tasks.pendingCount).toBe(1);
  });

  it("reports health status without throwing on network failures", async () => {
    const onlineClient = createApiClient("http://127.0.0.1:8080", vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    const offlineClient = createApiClient("http://127.0.0.1:8080", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(onlineClient.healthCheck()).resolves.toEqual({ ok: true });
    await expect(offlineClient.healthCheck()).resolves.toEqual({ ok: false });
  });

  it("maps 401 responses to auth_expired errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "UNAUTHORIZED" }, { status: 401, ok: false }));
    const client = createApiClient("http://127.0.0.1:8080", fetchImpl);

    await expect(client.fetchTraySummary("expired")).rejects.toMatchObject({
      code: "auth_expired"
    });
    await expect(client.fetchTraySummary("expired")).rejects.toBeInstanceOf(ApiClientError);
  });

  it("requests admin scan and restart actions with bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = createApiClient("http://127.0.0.1:8080", fetchImpl);

    await client.scanNow("token-1");
    await client.restartServer("token-1");

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8080/api/system/scan-now", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" }
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8080/api/system/restart", {
      method: "POST",
      headers: { Authorization: "Bearer token-1" }
    });
  });
});
