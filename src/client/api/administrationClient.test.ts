import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession } from "./identityClient.ts";
import { getAdminDiagnostics, listAdminAudit, retryAdminJob } from "./administrationClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000001201",
  project: "01890f1e-9b4a-7cc2-8f00-000000001202",
  job: "01890f1e-9b4a-7cc2-8f00-000000001203"
} as const;
const now = "2026-07-14T08:00:00.000Z";

afterEach(() => vi.unstubAllGlobals());

describe("administrationClient", () => {
  it("reads bounded dead-job diagnostics without exposing failure messages", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ postgres: "healthy", storage: "healthy",
      worker: { status: "healthy", lastHeartbeatAt: now }, queue: { pending: 0, running: 0, dead: 1 },
      deadJobs: [{ id: ids.job, jobType: "approval.finalize", attemptCount: 5, maxAttempts: 5,
        errorCode: "DEPENDENCY_UNAVAILABLE", updatedAt: now }], renderFailures: 0, latestBackup: null }, 200));
    vi.stubGlobal("fetch", fetch);
    const diagnostics = await getAdminDiagnostics();
    expect(diagnostics).toMatchObject({ deadJobs: [{ id: ids.job,
      jobType: "approval.finalize", errorCode: "DEPENDENCY_UNAVAILABLE" }] });
    expect(JSON.stringify(diagnostics)).not.toContain("errorMessage");
  });

  it("uses the session CSRF token for an audited dead-job retry", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(sessionBody(), 200))
      .mockResolvedValueOnce(jsonResponse({ targetId: ids.job, changed: true }, 200));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    await retryAdminJob(ids.job, { reason: "依赖已恢复", idempotencyKey: "admin:job:client:1" });
    expect(fetch).toHaveBeenLastCalledWith(`/api/v2/administration/jobs/${ids.job}/retry`,
      expect.objectContaining({ method: "POST", credentials: "same-origin",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }) }));
  });

  it("validates audit filters and identifiers before network work", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => listAdminAudit({ page: 1, pageSize: 1000 })).toThrow(PlatformRequestError);
    expect(() => retryAdminJob("legacy-job", { reason: "重试", idempotencyKey: "admin:job:client:2" }))
      .toThrow(PlatformRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "administration-client-test" } });
}
function sessionBody() {
  return { user: { id: ids.user, emailNormalized: "admin@example.test", displayName: "管理员",
    platformRole: "admin", status: "active", mfaStatus: "enabled", mfaEnabledAt: now, createdAt: now, updatedAt: now },
    globalCapabilities: ["platform.security.manage"], projects: [{ id: ids.project, name: "项目A", status: "active",
      role: "manager", capabilities: ["project.read"] }], csrfToken: "csrf-token" };
}
