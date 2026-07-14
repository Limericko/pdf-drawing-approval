import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeIdentityClient, getSession } from "./identityClient.ts";
import { createIssue, listIssues } from "./issueClient.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000001301",
  project: "01890f1e-9b4a-7cc2-8f00-000000001302",
  approval: "01890f1e-9b4a-7cc2-8f00-000000001303",
  issue: "01890f1e-9b4a-7cc2-8f00-000000001304",
  annotation: "01890f1e-9b4a-7cc2-8f00-000000001305"
} as const;

afterEach(() => { disposeIdentityClient(); vi.unstubAllGlobals(); });

describe("issueClient", () => {
  it("filters the project issue register by approval without sending CSRF", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ items: [], page: { page: 1, pageSize: 100, total: 0, pageCount: 0 } }));
    vi.stubGlobal("fetch", fetch);
    await listIssues(ids.project, { approvalCaseId: ids.approval, page: 1, pageSize: 100 });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v2/projects/${ids.project}/issues?page=1&pageSize=100&approvalCaseId=${ids.approval}`);
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-CSRF-Token");
  });

  it("creates an issue and preserves the returned annotation geometry", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(session())).mockResolvedValueOnce(json(issue(), 201));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    const result = await createIssue(ids.project, ids.approval, {
      title: "尺寸复核", description: "请核对孔距", severity: "high", assigneeUserId: ids.user, dueAt: null,
      annotation: { kind: "rect", pageNumber: 2, geometry: { xRatio: 0.2, yRatio: 0.3 },
        style: { color: "red" }, message: "请核对孔距" }, idempotencyKey: "issue:client:create:1"
    });
    expect(result.annotation).toMatchObject({ id: ids.annotation, pageNumber: 2,
      geometry: { xRatio: 0.2, yRatio: 0.3 } });
    expect(fetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST",
      headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }) }));
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "issue-client-test" } });
}

function session() {
  const now = "2026-07-14T06:00:00.000Z";
  return { user: { id: ids.user, emailNormalized: "designer@example.test", displayName: "设计师",
    platformRole: "member", status: "active", mfaStatus: "enabled", mfaEnabledAt: now, createdAt: now, updatedAt: now },
    globalCapabilities: [], projects: [{ id: ids.project, name: "项目", status: "active", role: "designer",
      capabilities: ["project.read", "drawings.submit"] }], csrfToken: "csrf-token" };
}

function issue() {
  const now = "2026-07-14T06:00:00.000Z";
  const annotation = { id: ids.annotation, projectId: ids.project, approvalCaseId: ids.approval,
    authorUserId: ids.user, kind: "rect", pageNumber: 2, geometry: { xRatio: 0.2, yRatio: 0.3 },
    style: { color: "red" }, message: "请核对孔距", resolved: false, version: 1, createdAt: now, updatedAt: now };
  return { id: ids.issue, projectId: ids.project, approvalCaseId: ids.approval, annotationId: ids.annotation,
    annotation, creatorUserId: ids.user, assigneeUserId: ids.user, title: "尺寸复核", description: "请核对孔距",
    severity: "high", status: "open", dueAt: null, version: 1, createdAt: now, updatedAt: now };
}
