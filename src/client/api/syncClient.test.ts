import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession } from "./identityClient.ts";
import { createWebDavConnection, listWebDavSyncItems, resolveWebDavConflict } from "./syncClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000005001",
  project: "01890f1e-9b4a-7cc2-8f00-000000005002",
  conflict: "01890f1e-9b4a-7cc2-8f00-000000005003",
  mapping: "01890f1e-9b4a-7cc2-8f00-000000005004",
  item: "01890f1e-9b4a-7cc2-8f00-000000005005"
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("syncClient", () => {
  it("builds bounded v2 sync queries without legacy authorization", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 } }));
    vi.stubGlobal("fetch", fetch);
    await listWebDavSyncItems({ page: 2, pageSize: 40, projectId: ids.project, status: "failed" });
    expect(fetch.mock.calls[0]?.[0]).toContain(`/api/v2/webdav-sync/items?page=2&pageSize=40&projectId=${ids.project}&status=failed`);
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });

  it("uses session CSRF for strict connection and conflict mutations", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(session())).mockResolvedValueOnce(json(connection()))
      .mockResolvedValueOnce(json(conflict()));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    await createWebDavConnection({ name: "坚果云", endpointUrl: "https://dav.company.com/root/",
      credentialRef: "secret/webdav/company", reason: "接入生产交换目录", idempotencyKey: "webdav:create:client:1" });
    await resolveWebDavConflict(ids.conflict, { resolution: "keep_remote", renamedRemotePath: null,
      reason: "确认远端文件独立保留", version: 1, idempotencyKey: "webdav:conflict:client:1" });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin",
      headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }) });
    expect(fetch.mock.calls[2]?.[0]).toBe(`/api/v2/webdav-sync/conflicts/${ids.conflict}/resolve`);
  });

  it("rejects secrets in endpoints and malformed conflict IDs before network work", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => createWebDavConnection({ name: "错误", endpointUrl: "https://user:password@dav.company.com/",
      credentialRef: "secret/webdav/company", reason: "错误", idempotencyKey: "webdav:create:client:2" }))
      .toThrow(PlatformRequestError);
    expect(() => resolveWebDavConflict("legacy-id", { resolution: "keep_remote", renamedRemotePath: null,
      reason: "错误", version: 1, idempotencyKey: "webdav:conflict:client:2" })).toThrow(PlatformRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200,
  headers: { "Content-Type": "application/json", "X-Request-ID": "sync-client-test" } }); }
function session() { const now = "2026-07-14T10:00:00.000Z"; return { user: { id: ids.user,
  emailNormalized: "admin@example.test", displayName: "管理员", platformRole: "admin", status: "active",
  mfaStatus: "enabled", mfaEnabledAt: now, createdAt: now, updatedAt: now }, globalCapabilities: ["platform.security.manage"],
  projects: [{ id: ids.project, name: "项目 A", status: "active", role: "manager", capabilities: ["project.read"] }],
  csrfToken: "csrf-token" }; }
function connection() { const now = "2026-07-14T10:00:00.000Z"; return { id: ids.user, name: "坚果云",
  endpointUrl: "https://dav.company.com/root/", credentialRef: "secret/webdav/company", credentialAvailable: true,
  status: "active", capabilities: { class1: true, move: true, rangeDownload: true }, lastCheckedAt: now,
  lastErrorCode: null, version: 1, createdAt: now, updatedAt: now }; }
function conflict() { const now = "2026-07-14T10:00:00.000Z"; return { id: ids.conflict, projectId: ids.project,
  mappingId: ids.mapping, syncItemId: ids.item, direction: "outbound", remotePath: "/Published/A.pdf",
  status: "resolved", resolution: "keep_remote", resolutionReason: "确认远端文件独立保留", renamedRemotePath: null,
  version: 2, remote: { etag: null, sizeBytes: 10, modifiedAt: now, sha256: "1".repeat(64) },
  cloud: { revisionId: null, objectId: null, sizeBytes: null, sha256: null }, createdAt: now, updatedAt: now,
  resolvedAt: now, resolvedByUserId: ids.user }; }
