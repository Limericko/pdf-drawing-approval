import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession } from "./identityClient.ts";
import { listPdmParts, updatePdmMetadata, voidPdmRevision } from "./pdmClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000a01",
  project: "01890f1e-9b4a-7cc2-8f00-000000000a02",
  part: "01890f1e-9b4a-7cc2-8f00-000000000a03",
  link: "01890f1e-9b4a-7cc2-8f00-000000000a04",
  revision: "01890f1e-9b4a-7cc2-8f00-000000000a05",
  document: "01890f1e-9b4a-7cc2-8f00-000000000a06",
  approval: "01890f1e-9b4a-7cc2-8f00-000000000a07",
  object: "01890f1e-9b4a-7cc2-8f00-000000000a08"
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("pdmClient", () => {
  it("builds bounded project list queries without CSRF", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      items: [], page: { page: 2, pageSize: 40, total: 0, pageCount: 0 }
    }, 200));
    vi.stubGlobal("fetch", fetch);
    await listPdmParts(ids.project, { page: "2", pageSize: "40", keyword: "阀体",
      releaseStatus: "published", sort: "part_number_asc" } as never);
    const [target, options] = fetch.mock.calls[0];
    expect(target).toContain(`page=2&pageSize=40&sort=part_number_asc&keyword=${encodeURIComponent("阀体")}&releaseStatus=published`);
    expect(options.headers).not.toHaveProperty("X-CSRF-Token");
  });

  it("uses the shared session CSRF token and validates mutation responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionBody(), 200))
      .mockResolvedValueOnce(jsonResponse(partDetail(), 200));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    const result = await updatePdmMetadata(ids.project, ids.link, {
      materialCode: "40Cr", version: 2, idempotencyKey: "pdm:metadata:client:1"
    });
    expect(result.part.id).toBe(ids.part);
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/v2/projects/${ids.project}/pdm/revisions/${ids.link}/metadata`,
      expect.objectContaining({ method: "PATCH", credentials: "same-origin",
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }) })
    );
  });

  it("rejects malformed IDs and invalid void commands before network work", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => listPdmParts("legacy-project")).toThrow(PlatformRequestError);
    expect(() => voidPdmRevision(ids.project, ids.link, {
      reason: "", version: 1, idempotencyKey: "pdm:void:client:1"
    })).toThrow(PlatformRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "pdm-client-test" } });
}

function sessionBody() {
  const now = "2026-07-14T06:00:00.000Z";
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

function partDetail() {
  const now = "2026-07-14T06:00:00.000Z";
  return {
    part: { id: ids.part, projectId: ids.project, partNumber: "GX-240714-010", name: "液压阀体",
      currentRevisionId: ids.revision, currentRevisionCode: "A01", releaseStatus: "published",
      materialCode: "40Cr", version: 2, updatedAt: now },
    revisions: [{ linkId: ids.link, revisionId: ids.revision, revisionCode: "A01",
      documentId: ids.document, documentCode: "GX-240714-010", approvalCaseId: ids.approval,
      originalObjectId: ids.object, signedObjectId: null, annotatedObjectId: null, materialCode: "40Cr",
      releaseStatus: "published", voidReason: null, version: 2, releasedAt: now,
      createdAt: now, updatedAt: now }],
    usages: [{ projectId: ids.project, projectName: "E2E 项目", firstApprovalCaseId: ids.approval,
      lastApprovalCaseId: ids.approval, updatedAt: now }]
  };
}
