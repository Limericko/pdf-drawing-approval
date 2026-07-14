import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession } from "./identityClient.ts";
import { createDocumentDraft, decideApproval, listApprovals } from "./approvalClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000501",
  project: "01890f1e-9b4a-7cc2-8f00-000000000502",
  object: "01890f1e-9b4a-7cc2-8f00-000000000503",
  approval: "01890f1e-9b4a-7cc2-8f00-000000000504"
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("approvalClient", () => {
  it("uses the session CSRF token for strict same-origin mutations", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionBody(), 200))
      .mockResolvedValueOnce(jsonResponse(draftBody(), 201));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    await createDocumentDraft(ids.project, {
      documentCode: "GX-240714-001",
      name: "减速器壳体",
      revisionCode: "A01",
      originalObjectId: ids.object,
      source: "web_upload",
      materialCode: "QT450-10",
      idempotencyKey: "draft:GX-240714-001:A01"
    });
    expect(fetch).toHaveBeenLastCalledWith(`/api/v2/projects/${ids.project}/documents/drafts`,
      expect.objectContaining({ method: "POST", credentials: "same-origin",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }) }));
  });

  it("builds bounded list queries without sending CSRF on reads", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 }
    }, 200));
    vi.stubGlobal("fetch", fetch);
    await listApprovals(ids.project, { page: "2", pageSize: "40", keyword: "壳体" } as never);
    const [target, options] = fetch.mock.calls[0];
    expect(target).toContain(`page=2&pageSize=40&sort=created_desc&keyword=${encodeURIComponent("壳体")}`);
    expect(options.headers).not.toHaveProperty("X-CSRF-Token");
  });

  it("rejects invalid IDs and rejection decisions before network work", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => listApprovals("legacy-12")).toThrow(PlatformRequestError);
    expect(() => decideApproval(ids.project, ids.approval, "supervisor", {
      decision: "rejected", comment: null, version: 1, idempotencyKey: "decision:reject:1"
    })).toThrow(PlatformRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "approval-client-test-request" }
  });
}

function sessionBody() {
  const now = "2026-07-14T05:00:00.000Z";
  return {
    user: { id: ids.user, emailNormalized: "designer@example.test", displayName: "设计师",
      platformRole: "member", status: "active", mfaStatus: "enabled", mfaEnabledAt: now,
      createdAt: now, updatedAt: now },
    globalCapabilities: [],
    projects: [{ id: ids.project, name: "E2E 项目", status: "active", role: "designer",
      capabilities: ["project.read", "drawings.submit"] }],
    csrfToken: "csrf-token"
  };
}

function draftBody() {
  const now = "2026-07-14T05:00:00.000Z";
  return {
    document: { id: "01890f1e-9b4a-7cc2-8f00-000000000505", projectId: ids.project,
      documentCode: "GX-240714-001", name: "减速器壳体", version: 1, createdByUserId: ids.user,
      createdAt: now, updatedAt: now },
    revision: { id: "01890f1e-9b4a-7cc2-8f00-000000000506", projectId: ids.project,
      documentId: "01890f1e-9b4a-7cc2-8f00-000000000505", revisionCode: "A01",
      originalObjectId: ids.object, source: "web_upload", status: "draft", metadataStatus: "complete",
      materialCode: "QT450-10", version: 1, createdByUserId: ids.user,
      submittedAt: null, publishedAt: null, createdAt: now, updatedAt: now }
  };
}
