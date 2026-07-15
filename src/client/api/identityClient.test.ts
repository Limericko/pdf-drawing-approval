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

  it("reuses the MFA lease signal for session refresh and never stores CSRF after cancellation", async () => {
    const controller = new AbortController();
    let resolveSession!: (response: Response) => void;
    const sessionResponse = new Promise<Response>((resolve) => { resolveSession = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ user }))
      .mockImplementationOnce(() => sessionResponse);
    vi.stubGlobal("fetch", fetchMock);

    const completion = completeMfa({ challengeToken: "challenge-secret",
      factor: { method: "totp", code: "123456" } }, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    controller.abort();
    resolveSession(json({ ...session, csrfToken: "must-not-survive-cancellation" }));

    await expect(completion).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(fetchMock.mock.calls[0]![1]!.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[1]![1]!.signal).toBe(controller.signal);
    await expect(createProject({ name: "must not send" })).rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rechecks the lease after platformRequest settles before storing CSRF", async () => {
    const controller = new AbortController();
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        if (abortChecks === 8) queueMicrotask(() => controller.abort());
        return controller.signal.aborted;
      },
      addEventListener: controller.signal.addEventListener.bind(controller.signal),
      removeEventListener: controller.signal.removeEventListener.bind(controller.signal)
    } as AbortSignal;
    const body = JSON.stringify({ ...session, csrfToken: "must-not-cross-await-boundary" });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: null,
      text: async () => body
    } as Response)));

    await expect(getSession(signal)).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    await expect(createProject({ name: "must not send" })).rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });
  });

  it.each(["resolve", "reject", "401"] as const)(
    "does not let a stale logout %s clear CSRF from a newer session generation",
    async (completionMode) => {
      let resolveLogout!: (response: Response) => void;
      let rejectLogout!: (error: unknown) => void;
      const logoutResponse = new Promise<Response>((resolve, reject) => {
        resolveLogout = resolve;
        rejectLogout = reject;
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json({ ...session, csrfToken: "csrf-before-logout" }))
        .mockImplementationOnce(() => logoutResponse)
        .mockResolvedValueOnce(json({ ...session, csrfToken: "csrf-new-session" }))
        .mockResolvedValueOnce(json({ project: project(), membership: membership(), capabilities: ["project.read"] }, 201));
      vi.stubGlobal("fetch", fetchMock);

      await getSession();
      const staleLogout = logout();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      disposeIdentityClient();
      await getSession();
      if (completionMode === "resolve") resolveLogout(new Response(null, { status: 204 }));
      else if (completionMode === "401") resolveLogout(problem(401, "SESSION_INVALID"));
      else rejectLogout(new Error("token=stale-logout-network-secret"));
      const logoutResult = await staleLogout.catch((error) => error);
      if (completionMode === "resolve") expect(logoutResult).toBeUndefined();
      else {
        expect(logoutResult).toMatchObject({ code: completionMode === "401" ? "SESSION_INVALID" : "NETWORK_ERROR" });
        expect(JSON.stringify(logoutResult)).not.toContain("stale-logout-network-secret");
        expect(JSON.stringify(logoutResult)).not.toContain("csrf-new-session");
      }

      await createProject({ name: "new session remains usable" });
      const headers = new Headers(fetchMock.mock.calls[3]![1]!.headers);
      expect(headers.get("x-csrf-token")).toBe("csrf-new-session");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  );

  it.each(["mutation", "session"] as const)(
    "does not let a stale %s 401 clear CSRF from a newer session generation",
    async (requestKind) => {
      let resolveStale!: (response: Response) => void;
      const staleResponse = new Promise<Response>((resolve) => { resolveStale = resolve; });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json({ ...session, csrfToken: "csrf-before-stale-request" }))
        .mockImplementationOnce(() => staleResponse)
        .mockResolvedValueOnce(json({ ...session, csrfToken: "csrf-new-session" }))
        .mockResolvedValueOnce(json({ project: project(), membership: membership(), capabilities: ["project.read"] }, 201));
      vi.stubGlobal("fetch", fetchMock);

      await getSession();
      const staleRequest = requestKind === "mutation" ? createProject({ name: "stale mutation" }) : refreshSession();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      disposeIdentityClient();
      await getSession();
      resolveStale(problem(401, "SESSION_INVALID"));
      const staleError = await staleRequest.catch((error) => error);
      expect(staleError).toMatchObject({ status: 401, code: "SESSION_INVALID" });
      expect(JSON.stringify(staleError)).not.toContain("csrf-new-session");

      await createProject({ name: "new session remains usable" });
      const headers = new Headers(fetchMock.mock.calls[3]![1]!.headers);
      expect(headers.get("x-csrf-token")).toBe("csrf-new-session");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  );

  it("keeps the current CSRF after a logout network failure so mutation and logout retry remain possible", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...session, csrfToken: "csrf-retryable-logout" }))
      .mockRejectedValueOnce(new Error("password=offline-logout-secret"))
      .mockResolvedValueOnce(json({ project: project(), membership: membership(), capabilities: ["project.read"] }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await getSession();
    const failure = await logout().catch((error) => error);
    expect(failure).toMatchObject({ code: "NETWORK_ERROR" });
    expect(JSON.stringify(failure)).not.toContain("offline-logout-secret");
    await createProject({ name: "still authenticated" });
    const mutationHeaders = new Headers(fetchMock.mock.calls[2]![1]!.headers);
    expect(mutationHeaders.get("x-csrf-token")).toBe("csrf-retryable-logout");
    await logout();
    await expect(createProject({ name: "must not send after successful retry" }))
      .rejects.toMatchObject({ code: "CSRF_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
