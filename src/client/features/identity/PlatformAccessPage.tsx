import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createInvitation as requestInvitation,
  createProject as requestProject,
  getProjectAccess as requestProjectAccess,
  listProjects as requestProjects,
  type PlatformSessionContext
} from "../../api/identityClient.ts";
import type { CreateInvitationRequest, CreateProjectRequest } from "../../../shared/contracts/identity.ts";
import { createSingleFlight } from "./singleFlight.ts";
import { focusPlatformError } from "./platformFocus.ts";

type ProjectSummary = PlatformSessionContext["projects"][number];
type ProjectAccess = Awaited<ReturnType<typeof requestProjectAccess>>;
export type PlatformAccessContext = Pick<PlatformSessionContext, "globalCapabilities" | "projects">;

export type ProjectAccessLoadState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly projectId: string }
  | { readonly status: "ready"; readonly projectId: string; readonly access: T }
  | { readonly status: "error"; readonly projectId: string };

export function createProjectAccessLoader<T>(
  load: (projectId: string, signal: AbortSignal) => Promise<T>,
  onChange: (state: ProjectAccessLoadState<T>) => void
) {
  let generation = 0;
  let controller: AbortController | undefined;
  let selectedProjectId = "";

  function select(projectId: string) {
    selectedProjectId = projectId;
    controller?.abort();
    const ownedGeneration = ++generation;
    if (!projectId) {
      controller = undefined;
      onChange({ status: "idle" });
      return;
    }
    const ownedController = new AbortController();
    controller = ownedController;
    onChange({ status: "loading", projectId });
    void load(projectId, ownedController.signal).then(
      (access) => {
        if (generation === ownedGeneration && controller === ownedController && !ownedController.signal.aborted) {
          onChange({ status: "ready", projectId, access });
        }
      },
      () => {
        if (generation === ownedGeneration && controller === ownedController && !ownedController.signal.aborted) {
          onChange({ status: "error", projectId });
        }
      }
    );
  }

  return Object.freeze({
    select,
    retry() {
      if (selectedProjectId) select(selectedProjectId);
    },
    dispose() {
      generation += 1;
      controller?.abort();
      controller = undefined;
    }
  });
}

type AccessDependencies = {
  readonly createProject: typeof requestProject;
  readonly createInvitation: typeof requestInvitation;
  readonly listProjects: typeof requestProjects;
  readonly getProjectAccess: typeof requestProjectAccess;
};

const defaultDependencies: AccessDependencies = {
  createProject: requestProject,
  createInvitation: requestInvitation,
  listProjects: requestProjects,
  getProjectAccess: requestProjectAccess
};

const capabilityLabels: Readonly<Record<string, string>> = Object.freeze({
  "platform.security.manage": "安全管理",
  "projects.create": "创建项目",
  "project.read": "查看项目",
  "project.members.manage": "管理成员",
  "project.invitations.create": "邀请成员",
  "drawings.submit": "提交图纸",
  "drawings.review": "审阅图纸",
  "drawings.process": "工艺复核"
});

const projectRoleLabels: Readonly<Record<ProjectSummary["role"], string>> = Object.freeze({
  manager: "项目经理",
  designer: "设计人员",
  supervisor: "主管审阅",
  process: "工艺复核",
  viewer: "只读成员"
});

export class AccessActionDeniedError extends Error {
  readonly code = "ACCESS_ACTION_DENIED" as const;

  constructor() {
    super("当前身份无权执行此操作");
    this.name = "AccessActionDeniedError";
  }
}

export function readableCapabilityLabels(capabilities: readonly string[]) {
  return capabilities.flatMap((capability) => capabilityLabels[capability] ? [capabilityLabels[capability]] : []);
}

export function accessSuccessMessage(action: "projectCreated" | "invitationCreated") {
  return action === "projectCreated" ? "项目已创建。" : "邀请已创建并进入发送队列。";
}

export function reconcileProjectRefresh(
  currentProjectId: string,
  projects: readonly { readonly id: string }[],
  select: (projectId: string) => void
) {
  const nextProjectId = projects.some((project) => project.id === currentProjectId)
    ? currentProjectId : projects[0]?.id ?? "";
  select(nextProjectId);
  return nextProjectId;
}

export function createPlatformAccessController(
  context: PlatformAccessContext,
  dependencies: AccessDependencies = defaultDependencies
) {
  const projectCapabilities = new Map(context.projects.map((project) => [project.id, new Set(project.capabilities)]));
  const globalCapabilities = new Set(context.globalCapabilities);
  const projectCreation = createSingleFlight();
  const invitationCreation = createSingleFlight();

  return Object.freeze({
    async listProjects(signal?: AbortSignal) {
      const result = await dependencies.listProjects(signal);
      projectCapabilities.clear();
      for (const project of result.projects) projectCapabilities.set(project.id, new Set(project.capabilities));
      return result;
    },
    async getProjectAccess(projectId: string, signal?: AbortSignal) {
      const result = await dependencies.getProjectAccess(projectId, signal);
      projectCapabilities.set(projectId, new Set(result.capabilities));
      return result;
    },
    async createProject(input: CreateProjectRequest, signal?: AbortSignal) {
      if (!globalCapabilities.has("projects.create")) throw new AccessActionDeniedError();
      return projectCreation.run(async () => {
        const result = await dependencies.createProject(input, signal);
        projectCapabilities.set(result.project.id, new Set(result.capabilities));
        return result;
      });
    },
    async createInvitation(input: CreateInvitationRequest, signal?: AbortSignal) {
      const capabilities = projectCapabilities.get(input.projectId);
      if (!globalCapabilities.has("platform.security.manage") ||
          !capabilities?.has("project.invitations.create")) throw new AccessActionDeniedError();
      return invitationCreation.run(() => dependencies.createInvitation(input, signal));
    }
  });
}

export function PlatformAccessPage({
  user,
  context,
  logoutBusy = false,
  logoutError = "",
  onLogout
}: {
  readonly user: PlatformSessionContext["user"];
  readonly context: PlatformAccessContext;
  readonly logoutBusy?: boolean;
  readonly logoutError?: string;
  readonly onLogout: () => void | Promise<void>;
}) {
  const controller = useMemo(() => createPlatformAccessController(context), [context]);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>(context.projects);
  const [selectedProjectId, setSelectedProjectId] = useState(context.projects[0]?.id ?? "");
  const [accessView, setAccessView] = useState<ProjectAccessLoadState<ProjectAccess>>({ status: "idle" });
  const accessLoader = useMemo(() => createProjectAccessLoader(
    (projectId, signal) => controller.getProjectAccess(projectId, signal),
    setAccessView
  ), [controller]);
  const [loading, setLoading] = useState(context.projects.length === 0);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [invitationBusy, setInvitationBusy] = useState(false);
  const accessRoot = useRef<HTMLElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void controller.listProjects(abort.signal).then(({ projects: loadedProjects }) => {
      setProjects(loadedProjects);
      setSelectedProjectId(reconcileProjectRefresh(selectedProjectId, loadedProjects, accessLoader.select));
      setLoading(false);
    }, () => {
      if (!abort.signal.aborted) {
        setError("项目列表加载失败，请重试。");
        setLoading(false);
      }
    });
    return () => abort.abort();
  }, [controller, accessLoader]);

  useEffect(() => {
    return () => accessLoader.dispose();
  }, [accessLoader]);

  const selectedSummary = projects.find((project) => project.id === selectedProjectId);
  const access = accessView.status === "ready" && accessView.projectId === selectedProjectId
    ? accessView.access : undefined;
  const accessLoading = Boolean(selectedProjectId) && (accessView.status === "idle" ||
    (accessView.status === "loading" && accessView.projectId === selectedProjectId));
  const accessError = accessView.status === "error" && accessView.projectId === selectedProjectId;
  useEffect(() => {
    if (error || accessError || logoutError) focusPlatformError(accessRoot.current);
  }, [error, accessError, logoutError]);
  const globalLabels = readableCapabilityLabels(context.globalCapabilities);
  const projectLabels = readableCapabilityLabels(access?.capabilities ?? []);
  const canCreate = context.globalCapabilities.includes("projects.create");
  const canInvite = context.globalCapabilities.includes("platform.security.manage") &&
    Boolean(access?.capabilities.includes("project.invitations.create"));

  function selectProject(projectId: string) {
    accessLoader.select(projectId);
    setSelectedProjectId(projectId);
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFeedback("");
    setProjectBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const created = await controller.createProject({ name: String(data.get("projectName") ?? "") });
      const loaded = await controller.listProjects();
      setProjects(loaded.projects);
      selectProject(created.project.id);
      setFeedback(accessSuccessMessage("projectCreated"));
      form.reset();
    } catch {
      setError("项目创建失败，请检查名称后重试。");
    } finally {
      setProjectBusy(false);
    }
  }

  async function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setFeedback("");
    setInvitationBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await controller.createInvitation({
        email: String(data.get("inviteEmail") ?? ""),
        platformRole: "member",
        projectId: selectedProjectId,
        projectRole: String(data.get("projectRole") ?? "viewer") as CreateInvitationRequest["projectRole"]
      });
      setFeedback(accessSuccessMessage("invitationCreated"));
      form.reset();
    } catch {
      setError("邀请创建失败，请检查邮箱和项目权限后重试。");
    } finally {
      setInvitationBusy(false);
    }
  }

  return <section className="platform-access" aria-labelledby="platform-access-heading" ref={accessRoot}>
    <header className="platform-access__header">
      <div>
        <p className="platform-kicker">项目访问 · 03</p>
        <h1 id="platform-access-heading" tabIndex={-1}>可访问项目</h1>
        <p>当前身份：{user.displayName} · {user.emailNormalized}</p>
      </div>
      <button className="platform-button platform-button--secondary" type="button" disabled={logoutBusy}
        aria-busy={logoutBusy} onClick={() => void onLogout()}>
        退出登录
      </button>
    </header>

    {logoutError ? <p className="platform-error" role="alert" tabIndex={-1}>{logoutError}</p> : null}

    <dl className="platform-access__identity">
      <div><dt>平台角色</dt><dd>{user.platformRole === "admin" ? "管理员" : "成员"}</dd></div>
      <div><dt>可执行操作</dt><dd>{globalLabels.length ? globalLabels.join(" · ") : "使用已授权项目"}</dd></div>
    </dl>

    {feedback ? <p className="platform-feedback" role="status">{feedback}</p> : null}
    {error ? <div className="platform-error" role="alert" tabIndex={-1}><span>{error}</span>
      <button type="button" onClick={() => location.reload()}>重试</button></div> : null}

    <div className="platform-section-heading">
      <div><p className="platform-eyebrow">授权范围</p><h2>项目清单</h2></div>
      <span>{projects.length} 个项目</span>
    </div>
    {loading ? <p aria-busy="true">正在读取项目…</p> : projects.length === 0 ?
      <div className="platform-empty"><h3>暂无可访问项目</h3><p>请联系项目管理员分配访问权限。</p></div> :
      <div className="platform-projects">
        <nav aria-label="项目清单">
          {projects.map((project) => <button key={project.id} type="button"
            aria-current={project.id === selectedProjectId ? "page" : undefined}
            onClick={() => selectProject(project.id)}>
            <strong>{project.name}</strong><span>{projectRoleLabels[project.role]}</span>
          </button>)}
        </nav>
        <article aria-live="polite">
          {accessLoading ? <p aria-busy="true">正在读取项目权限…</p> : accessError ?
            <div className="platform-project-access-error" role="alert" tabIndex={-1}>
              <p>项目权限加载失败，请重试。</p>
              <button className="platform-button platform-button--secondary" type="button"
                onClick={() => accessLoader.retry()}>重试当前项目</button>
            </div> : access && selectedSummary ? <>
            <p className="platform-eyebrow">当前项目</p>
            <h3>{access.project.name}</h3>
            <p>成员角色：{projectRoleLabels[selectedSummary.role]}</p>
            <ul className="platform-capability-list">
              {projectLabels.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </> : <p>请选择项目。</p>}
        </article>
      </div>}

    {canCreate || canInvite ? <div className="platform-management">
      {canCreate ? <form onSubmit={(event) => void submitProject(event)} aria-busy={projectBusy}>
        <h2>创建项目</h2>
        <label htmlFor="platform-project-name">项目名称</label>
        <input id="platform-project-name" name="projectName" maxLength={160} required disabled={projectBusy} />
        <button className="platform-button" type="submit" disabled={projectBusy}>创建项目</button>
      </form> : null}
      {canInvite ? <form onSubmit={(event) => void submitInvitation(event)} aria-busy={invitationBusy}>
        <h2>邀请项目成员</h2>
        <label htmlFor="platform-invite-email">成员邮箱</label>
        <input id="platform-invite-email" name="inviteEmail" type="email" maxLength={254} required disabled={invitationBusy} />
        <label htmlFor="platform-project-role">项目角色</label>
        <select id="platform-project-role" name="projectRole" defaultValue="viewer" disabled={invitationBusy}>
          <option value="viewer">只读成员</option><option value="designer">设计人员</option>
          <option value="supervisor">主管审阅</option><option value="process">工艺复核</option>
          <option value="manager">项目经理</option>
        </select>
        <button className="platform-button" type="submit" disabled={invitationBusy}>创建邀请</button>
      </form> : null}
    </div> : null}
  </section>;
}
