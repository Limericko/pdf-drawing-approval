import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlatformSessionContext } from "../../api/identityClient.ts";
import * as platformAccessExports from "./PlatformAccessPage.tsx";
import {
  PlatformAccessPage,
  accessSuccessMessage,
  createProjectAccessLoader,
  createPlatformAccessController,
  readableCapabilityLabels,
  type PlatformAccessContext
} from "./PlatformAccessPage.tsx";

const projectId = "01890f1e-9b4a-7cc2-8f00-000000000002";
const session: PlatformSessionContext = {
  user: {
    id: "01890f1e-9b4a-7cc2-8f00-000000000001",
    emailNormalized: "admin@example.test",
    displayName: "平台管理员",
    platformRole: "admin",
    status: "active",
    mfaStatus: "enabled",
    mfaEnabledAt: "2026-07-13T00:00:00.000Z",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  },
  globalCapabilities: ["platform.security.manage", "projects.create"],
  projects: [{
    id: projectId,
    name: "发动机图纸安全评审",
    status: "active",
    role: "manager",
    capabilities: ["project.read", "project.members.manage", "project.invitations.create"]
  }]
};
const accessContext = { globalCapabilities: session.globalCapabilities, projects: session.projects };

describe("PlatformAccessPage", () => {
  it("renders short Chinese capability labels without exposing internal capability codes", () => {
    expect(readableCapabilityLabels([
      "platform.security.manage",
      "projects.create",
      "project.read",
      "unknown.internal.code"
    ])).toEqual(["安全管理", "创建项目", "查看项目"]);

    const html = renderToStaticMarkup(<PlatformAccessPage user={session.user} context={accessContext}
      onLogout={vi.fn()} />);
    expect(html).toContain("安全管理");
    expect(html).toContain("创建项目");
    expect(html).toContain("正在读取项目权限");
    expect(html).not.toContain("邀请项目成员");
    expect(html).not.toMatch(/platform\.security\.manage|projects\.create|project\.read|unknown\.internal\.code/);
  });

  it("keeps identity and projects visible while a failed logout is retryable", () => {
    const html = renderToStaticMarkup(<PlatformAccessPage user={session.user} context={accessContext}
      logoutBusy={true} logoutError="退出登录失败，请检查网络连接后重试。" onLogout={vi.fn()} />);
    expect(html).toContain("平台管理员");
    expect(html).toContain("发动机图纸安全评审");
    expect(html).toContain('role="alert"');
    expect(html).toContain("退出登录失败，请检查网络连接后重试。");
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-busy="true"[^>]*>退出登录<\/button>/);
  });

  it("rejects management calls at the controller boundary for an ordinary member", async () => {
    const createProject = vi.fn();
    const createInvitation = vi.fn();
    const memberContext: PlatformAccessContext = {
      globalCapabilities: [],
      projects: [{ ...session.projects[0]!, role: "viewer", capabilities: ["project.read"] }]
    };
    const controller = createPlatformAccessController(memberContext, {
      createProject,
      createInvitation,
      listProjects: vi.fn(),
      getProjectAccess: vi.fn()
    });

    await expect(controller.createProject({ name: "越权项目" }))
      .rejects.toMatchObject({ code: "ACCESS_ACTION_DENIED" });
    await expect(controller.createInvitation({
      email: "invitee@example.test",
      platformRole: "member",
      projectId,
      projectRole: "viewer"
    })).rejects.toMatchObject({ code: "ACCESS_ACTION_DENIED" });
    expect(createProject).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("uses stable user-facing feedback after successful project and invitation actions", () => {
    expect(accessSuccessMessage("projectCreated")).toBe("项目已创建。");
    expect(accessSuccessMessage("invitationCreated")).toBe("邀请已创建并进入发送队列。");
  });

  it("surfaces a v2 project failure without invoking another request path or clearing the session", async () => {
    const failure = new Error("v2 failed");
    const createProject = vi.fn().mockRejectedValue(failure);
    const listProjects = vi.fn();
    const getProjectAccess = vi.fn();
    const createInvitation = vi.fn();
    const controller = createPlatformAccessController(accessContext, {
      createProject,
      listProjects,
      getProjectAccess,
      createInvitation
    });

    await expect(controller.createProject({ name: "失败项目" })).rejects.toBe(failure);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();
    expect(getProjectAccess).not.toHaveBeenCalled();
    expect(createInvitation).not.toHaveBeenCalled();
    expect(session.user.emailNormalized).toBe("admin@example.test");
  });

  it("keeps project creation and invitation creation independently single-flight for direct concurrent calls", async () => {
    const created = {
      project: { id: "01890f1e-9b4a-7cc2-8f00-000000000006", name: "并发项目", status: "active" as const,
        createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
      membership: { id: "01890f1e-9b4a-7cc2-8f00-000000000007",
        projectId: "01890f1e-9b4a-7cc2-8f00-000000000006", userId: session.user.id, role: "manager" as const,
        status: "active" as const, createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z" },
      capabilities: ["project.read" as const]
    };
    const invited = { invitationId: "01890f1e-9b4a-7cc2-8f00-000000000008" };
    const projectResult = deferred<typeof created>();
    const invitationResult = deferred<typeof invited>();
    const createProject = vi.fn(() => projectResult.promise);
    const createInvitation = vi.fn(() => invitationResult.promise);
    const controller = createPlatformAccessController(accessContext, {
      createProject,
      createInvitation,
      listProjects: vi.fn(),
      getProjectAccess: vi.fn()
    });

    const projectFirst = controller.createProject({ name: "并发项目" });
    const projectDuplicate = controller.createProject({ name: "并发项目" });
    const invitation = { email: "invitee@example.test", platformRole: "member" as const, projectId,
      projectRole: "viewer" as const };
    const invitationFirst = controller.createInvitation(invitation);
    const invitationDuplicate = controller.createInvitation(invitation);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createInvitation).toHaveBeenCalledTimes(1);

    projectResult.resolve(created);
    invitationResult.resolve(invited);
    await expect(Promise.all([projectFirst, projectDuplicate])).resolves.toEqual([created, created]);
    await expect(Promise.all([invitationFirst, invitationDuplicate])).resolves.toEqual([invited, invited]);
  });

  it("clears project access immediately on A to B selection and ignores stale A resolution", async () => {
    const projectA = deferred<{ project: { name: string } }>();
    const projectB = deferred<{ project: { name: string } }>();
    const states: unknown[] = [];
    const load = vi.fn((id: string) => id === "A" ? projectA.promise : projectB.promise);
    const loader = createProjectAccessLoader(load, (state) => states.push(state));

    loader.select("A");
    loader.select("B");
    expect(states.at(-1)).toEqual({ status: "loading", projectId: "B" });
    projectA.resolve({ project: { name: "旧项目" } });
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ status: "loading", projectId: "B" });
    projectB.resolve({ project: { name: "新项目" } });
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ status: "ready", projectId: "B", access: { project: { name: "新项目" } } });
  });

  it("keeps failed project access empty and retries only the currently selected project", async () => {
    const first = deferred<{ project: { name: string } }>();
    const second = deferred<{ project: { name: string } }>();
    const states: unknown[] = [];
    const load = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const loader = createProjectAccessLoader(load, (state) => states.push(state));

    loader.select("B");
    first.reject(new Error("access failed"));
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ status: "error", projectId: "B" });
    loader.retry();
    expect(load).toHaveBeenLastCalledWith("B", expect.any(AbortSignal));
    expect(states.at(-1)).toEqual({ status: "loading", projectId: "B" });
    second.resolve({ project: { name: "新项目" } });
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ status: "ready", projectId: "B", access: { project: { name: "新项目" } } });
  });

  it("aligns refreshed project selection before requesting access", () => {
    const reconcile = (platformAccessExports as unknown as {
      reconcileProjectRefresh?: (currentId: string, projects: readonly { id: string }[],
        select: (projectId: string) => void) => string;
    }).reconcileProjectRefresh;
    expect(reconcile).toBeTypeOf("function");
    if (!reconcile) return;
    const select = vi.fn();
    const projectB = { id: "01890f1e-9b4a-7cc2-8f00-000000000010" };

    expect(reconcile(projectId, [projectB], select)).toBe(projectB.id);
    expect(select).toHaveBeenCalledWith(projectB.id);
    expect(select).not.toHaveBeenCalledWith(projectId);
    select.mockClear();
    expect(reconcile(projectB.id, [projectB], select)).toBe(projectB.id);
    expect(select).toHaveBeenCalledWith(projectB.id);
    select.mockClear();
    expect(reconcile(projectB.id, [], select)).toBe("");
    expect(select).toHaveBeenCalledWith("");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
