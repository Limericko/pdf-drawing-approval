import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession } from "./identityClient.ts";
import { listPrintArchive, recordPrintArchive } from "./printArchiveClient.ts";
import { setMySignature } from "./signatureClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000001301",
  project: "01890f1e-9b4a-7cc2-8f00-000000001302",
  approval: "01890f1e-9b4a-7cc2-8f00-000000001303",
  object: "01890f1e-9b4a-7cc2-8f00-000000001304",
  signature: "01890f1e-9b4a-7cc2-8f00-000000001305",
  archive: "01890f1e-9b4a-7cc2-8f00-000000001306"
} as const;
const now = "2026-07-14T08:00:00.000Z";

afterEach(() => vi.unstubAllGlobals());

describe("signature and print archive clients", () => {
  it("mutates signature and print archive through Cookie and CSRF v2 requests", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(sessionBody(), 200))
      .mockResolvedValueOnce(jsonResponse({ id: ids.signature, userId: ids.user, objectId: ids.object,
        kind: "handwritten_png", createdAt: now }, 200))
      .mockResolvedValueOnce(jsonResponse(archiveBody(), 201));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    await setMySignature({ objectId: ids.object, idempotencyKey: "signature:client:1" });
    await recordPrintArchive(ids.project, ids.approval, { objectId: ids.object, printerName: "云端归档",
      status: "archived", errorCode: null, idempotencyKey: "print:client:1" });
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v2/signature");
    expect(fetch.mock.calls[2]?.[0]).toBe(`/api/v2/projects/${ids.project}/approvals/${ids.approval}/print-archive`);
    for (const call of fetch.mock.calls.slice(1)) expect(call[1]).toEqual(expect.objectContaining({
      credentials: "same-origin", headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }) }));
  });

  it("keeps archive reads CSRF-free and rejects invalid archive combinations locally", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ items: [archiveBody()] }, 200));
    vi.stubGlobal("fetch", fetch);
    await listPrintArchive(ids.project, ids.approval);
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-CSRF-Token");
    expect(() => recordPrintArchive(ids.project, ids.approval, { objectId: null, printerName: null,
      status: "archived", errorCode: null, idempotencyKey: "print:client:invalid" })).toThrow(PlatformRequestError);
  });
});

function archiveBody() { return { id: ids.archive, projectId: ids.project, approvalCaseId: ids.approval,
  actorUserId: ids.user, objectId: ids.object, printerName: "云端归档", status: "archived",
  errorCode: null, createdAt: now }; }
function jsonResponse(body: unknown, status: number) { return new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", "X-Request-ID": "signature-print-client-test" } }); }
function sessionBody() { return { user: { id: ids.user, emailNormalized: "admin@example.test", displayName: "管理员",
  platformRole: "admin", status: "active", mfaStatus: "enabled", mfaEnabledAt: now, createdAt: now, updatedAt: now },
  globalCapabilities: [], projects: [{ id: ids.project, name: "项目A", status: "active", role: "manager",
    capabilities: ["project.read"] }], csrfToken: "csrf-token" }; }
