import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeInvitation,
  completeMfa,
  createInvitation,
  createProject,
  disposeIdentityClient,
  getProjectAccess,
  getSession,
  listProjects,
  login,
  logout,
  prepareInvitation,
  refreshSession
} from "./identityClient.ts";

const user = {
  id: "01890f1e-9b4a-7cc2-8f00-000000000001",
  emailNormalized: "user@example.test",
  displayName: "User",
  platformRole: "admin",
  status: "active",
  mfaStatus: "enabled",
  mfaEnabledAt: "2026-07-13T00:00:00.000Z",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z"
} as const;
const projectId = "01890f1e-9b4a-7cc2-8f00-000000000002";
const membershipId = "01890f1e-9b4a-7cc2-8f00-000000000003";
const session = { user, globalCapabilities: ["platform.security.manage", "projects.create"], projects: [],
  csrfToken: "csrf-memory-only" };

beforeEach(() => disposeIdentityClient());

describe("identityClient", () => {
  it("uses the Task18 login endpoint and shared strict request/response contracts", async () => {
    const fetchMock = mockResponses(json({ next: "mfa", challengeToken: "challenge-secret" }, 202));

    await expect(login({ email: "USER@example.test", password: "correct horse battery staple" })).resolves.toEqual({
      next: "mfa",
      challengeToken: "challenge-secret"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/auth/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ email: "USER@example.test", password: "correct horse battery staple" })
    }));
    await expect(login({ email: "not-an-email", password: "secret" })).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps CSRF only in module memory and sends it on authenticated mutations", async () => {
    const localSet = vi.fn();
    const sessionSet = vi.fn();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("localStorage", { setItem: localSet });
    vi.stubGlobal("sessionStorage", { setItem: sessionSet });
    const fetchMock = mockResponses(
      json(session),
      json({ project: project(), membership: membership(), capabilities: ["project.read"] }, 201)
    );

    await getSession();
    await createProject({ name: "安全项目" });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v2/projects", expect.anything());
    const headers = new Headers(fetchMock.mock.calls[1]![1]!.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-memory-only");
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("waits for MFA cookie creation before refreshing session and obtaining a new CSRF", async () => {
    let resolveMfa!: (response: Response) => void;
    const mfaResponse = new Promise<Response>((resolve) => { resolveMfa = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => mfaResponse)
      .mockResolvedValueOnce(json({ ...session, csrfToken: "csrf-after-mfa" }));
    vi.stubGlobal("fetch", fetchMock);

    const completion = completeMfa({ challengeToken: "challenge-secret",
      factor: { method: "totp", code: "123456" } });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveMfa(json({ user }));
    const refreshed = await completion;
    expect(refreshed).not.toHaveProperty("csrfToken");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v2/auth/mfa/complete", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v2/session", expect.anything());
  });

  it("clears CSRF before refresh, on 401, logout and module disposal", async () => {
    const fetchMock = mockResponses(
      json(session),
      problem(401, "SESSION_INVALID"),
      json(session),
      new Response(null, { status: 204 }),
      json(session)
    );
    await getSession();
    await expect(refreshSession()).rejects.toMatchObject({ status: 401, code: "SESSION_INVALID" });
    await expect(createProject({ name: "must not send" })).rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await getSession();
    await logout();
    await expect(createProject({ name: "must not send" })).rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });

    await getSession();
    disposeIdentityClient();
    await expect(createProject({ name: "must not send" })).rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("matches invitation and project endpoints and response schemas", async () => {
    const fetchMock = mockResponses(
      json(session),
      json({ invitationId: "01890f1e-9b4a-7cc2-8f00-000000000004" }, 201),
      json({ enrollmentToken: "enrollment-secret", otpauthUri: "otpauth://totp/PDF%20Approval?secret=TOTPSECRET" }),
      json({ recoveryCodes: ["RECOVERY-SECRET"] }),
      json({ projects: [{ id: projectId, name: "项目", status: "active", role: "manager",
        capabilities: ["project.read"] }] }),
      json({ project: project(), membership: membership(), capabilities: ["project.read"] })
    );
    await getSession();
    await createInvitation({ email: "invitee@example.test", platformRole: "member", projectId, projectRole: "viewer" });
    await prepareInvitation({ invitationToken: "invitation-secret" });
    await completeInvitation({ enrollmentToken: "enrollment-secret",
      password: "correct horse battery staple", totp: "123456" });
    await listProjects();
    await getProjectAccess(projectId);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v2/session",
      "/api/v2/invitations",
      "/api/v2/invitations/prepare",
      "/api/v2/invitations/complete",
      "/api/v2/projects",
      `/api/v2/projects/${projectId}/access`
    ]);
  });
});

function project() {
  return { id: projectId, name: "项目", status: "active", createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z" };
}

function membership() {
  return { id: membershipId, projectId, userId: user.id, role: "manager", status: "active",
    createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function problem(status: number, code: string) {
  return new Response(JSON.stringify({ type: "about:blank", status, code, requestId: "request-401",
    title: "Authentication required" }), { status, headers: { "Content-Type": "application/problem+json" } });
}

function mockResponses(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
