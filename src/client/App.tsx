import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  Download,
  FileText,
  LogOut,
  PackageSearch,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Settings as SettingsIcon,
  UploadCloud,
  UserRound,
  X,
  type LucideIcon
} from "lucide-react";
import { clearToken, getClientUpdateInfo, getMySignature, getToken, type ClientUpdateInfo, type MySignature, type User } from "./api.ts";
import {
  checkDesktopUpdates,
  getDesktopClientVersion,
  getDesktopUpdateStatus,
  getServerBaseUrl,
  initializeServerBaseUrl,
  isDesktopClient,
  onDesktopUpdateStatus,
  openDownloadedUpdateInstaller,
  type DesktopUpdateStatus
} from "./clientConfig.ts";
import { LoginPage } from "./pages/LoginPage.tsx";
import { ServerConnectionPage } from "./pages/ServerConnectionPage.tsx";
import { defaultRouteForRole, navigationForRole, routeAllowedForRole, routePath, type AppRouteName } from "./roleAccess.ts";
import { RoleFlowGuide } from "./widgets/RoleFlowGuide.tsx";
import { Button } from "./ui/actions/index.tsx";
import { Dialog } from "./ui/overlays/index.tsx";

type Route =
  | { name: "tasks" }
  | { name: "submit" }
  | { name: "signature" }
  | { name: "profile" }
  | { name: "approvals" }
  | { name: "settings" }
  | { name: "pdm" }
  | { name: "pdmPending" }
  | { name: "pdmDetail"; id: number }
  | { name: "detail"; id: number };

const pageLoaders = {
  tasks: () => import("./pages/MyTasksPage.tsx"),
  submit: () => import("./pages/SubmitDrawingPage.tsx"),
  signature: () => import("./pages/MySignaturePage.tsx"),
  profile: () => import("./pages/ProfilePage.tsx"),
  approvals: () => import("./pages/ApprovalsPage.tsx"),
  settings: () => import("./pages/SettingsPage.tsx"),
  pdm: () => import("./pages/PdmPartsPage.tsx"),
  pdmPending: () => import("./pages/PdmPendingMetadataPage.tsx"),
  pdmDetail: () => import("./pages/PdmPartDetailPage.tsx"),
  detail: () => import("./pages/ApprovalDetailPage.tsx")
};

const MyTasksPage = lazy(() => pageLoaders.tasks().then((module) => ({ default: module.MyTasksPage })));
const SubmitDrawingPage = lazy(() => pageLoaders.submit().then((module) => ({ default: module.SubmitDrawingPage })));
const MySignaturePage = lazy(() => pageLoaders.signature().then((module) => ({ default: module.MySignaturePage })));
const ProfilePage = lazy(() => pageLoaders.profile().then((module) => ({ default: module.ProfilePage })));
const ApprovalsPage = lazy(() => pageLoaders.approvals().then((module) => ({ default: module.ApprovalsPage })));
const SettingsPage = lazy(() => pageLoaders.settings().then((module) => ({ default: module.SettingsPage })));
const PdmPartsPage = lazy(() => pageLoaders.pdm().then((module) => ({ default: module.PdmPartsPage })));
const PdmPendingMetadataPage = lazy(() => pageLoaders.pdmPending().then((module) => ({ default: module.PdmPendingMetadataPage })));
const PdmPartDetailPage = lazy(() => pageLoaders.pdmDetail().then((module) => ({ default: module.PdmPartDetailPage })));
const ApprovalDetailPage = lazy(() => pageLoaders.detail().then((module) => ({ default: module.ApprovalDetailPage })));

export function preloadRoute(route: AppRouteName) {
  void pageLoaders[route]?.();
}

function decodeUserFromToken(): User | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as User;
  } catch {
    return null;
  }
}

export function routeFromHash(hashValue: string): Route {
  const hash = hashValue.replace(/^#/, "").split("?")[0];
  const detail = /^\/approvals\/(\d+)$/.exec(hash);
  const pdmDetail = /^\/pdm\/parts\/(\d+)$/.exec(hash);
  if (detail) return { name: "detail", id: Number(detail[1]) };
  if (pdmDetail) return { name: "pdmDetail", id: Number(pdmDetail[1]) };
  if (hash === "/pdm/pending-metadata") return { name: "pdmPending" };
  if (hash === "/settings") return { name: "settings" };
  if (hash === "/submit") return { name: "submit" };
  if (hash === "/signature") return { name: "signature" };
  if (hash === "/profile") return { name: "profile" };
  if (hash === "/approvals") return { name: "approvals" };
  if (hash === "/pdm") return { name: "pdm" };
  return { name: "tasks" };
}

export function passwordResetTokenFromHash(hashValue: string) {
  const hash = hashValue.replace(/^#/, "");
  const [pathValue, queryValue = ""] = hash.split("?");
  if (pathValue !== "/reset-password") return null;
  return new URLSearchParams(queryValue).get("token");
}

function currentRoute(): Route {
  return routeFromHash(location.hash);
}

export function requiresServerConnectionSetup(input: {
  desktopClient: boolean;
  configLoaded: boolean;
  serverBaseUrl: string | null;
}) {
  return input.desktopClient && input.configLoaded && !input.serverBaseUrl;
}

export const sidebarCollapsedStorageKey = "pdf_approval_sidebar_collapsed";
export const clientUpdateDismissedStorageKey = "pdf_approval_client_update_dismissed_version";

export function readSidebarCollapsed(storage: Storage | null) {
  try {
    return storage?.getItem(sidebarCollapsedStorageKey) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage: Storage | null, collapsed: boolean) {
  try {
    storage?.setItem(sidebarCollapsedStorageKey, collapsed ? "1" : "0");
  } catch {
    // Local storage can be unavailable in locked-down desktop/webview modes.
  }
}

export function readDismissedClientUpdateVersion(storage: Storage | null) {
  try {
    return storage?.getItem(clientUpdateDismissedStorageKey) ?? "";
  } catch {
    return "";
  }
}

export function writeDismissedClientUpdateVersion(storage: Storage | null, version: string) {
  try {
    storage?.setItem(clientUpdateDismissedStorageKey, version);
  } catch {
    // Local storage can be unavailable in locked-down desktop/webview modes.
  }
}

export function signatureSetupRequired(user: Pick<User, "role">) {
  return user.role !== "admin";
}

export function shouldBlockForMissingSignature(input: {
  user: Pick<User, "role">;
  signatureConfigured: boolean | null;
  routeName: AppRouteName;
}) {
  return (
    signatureSetupRequired(input.user) &&
    input.signatureConfigured === false &&
    input.routeName !== "signature" &&
    input.routeName !== "profile"
  );
}

export function App() {
  const desktopClient = isDesktopClient();
  const [user, setUser] = useState<User | null>(() => decodeUserFromToken());
  const [route, setRoute] = useState<Route>(() => currentRoute());
  const [serverConfigLoaded, setServerConfigLoaded] = useState(() => !desktopClient);
  const [serverBaseUrl, setServerBaseUrlState] = useState<string | null>(() => getServerBaseUrl());
  const [signatureConfigured, setSignatureConfigured] = useState<boolean | null>(null);
  const [signatureCheckError, setSignatureCheckError] = useState("");
  const [signaturePromptOpen, setSignaturePromptOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed(browserStorage()));
  const [clientUpdateInfo, setClientUpdateInfo] = useState<ClientUpdateInfo | null>(null);
  const [desktopUpdateStatus, setDesktopUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const [desktopUpdateDismissed, setDesktopUpdateDismissed] = useState(false);

  useEffect(() => {
    if (!desktopClient) return;
    let active = true;

    initializeServerBaseUrl()
      .then((nextServerBaseUrl) => {
        if (!active) return;
        setServerBaseUrlState(nextServerBaseUrl);
      })
      .finally(() => {
        if (active) setServerConfigLoaded(true);
      });

    return () => {
      active = false;
    };
  }, [desktopClient]);

  useEffect(() => {
    if (!desktopClient) return;
    let active = true;
    getDesktopUpdateStatus().then((status) => {
      if (active && status) setDesktopUpdateStatus(status);
    });
    const unsubscribe = onDesktopUpdateStatus((status) => {
      setDesktopUpdateStatus(status);
      if (status.status === "downloading" || status.status === "downloaded") {
        setDesktopUpdateDismissed(false);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktopClient]);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const nav = useMemo(() => (user ? navigationForRole(user) : []), [user]);

  useEffect(() => {
    if (!user) {
      setSignatureConfigured(null);
      setSignatureCheckError("");
      setSignaturePromptOpen(false);
      return;
    }

    if (!signatureSetupRequired(user)) {
      setSignatureConfigured(true);
      setSignatureCheckError("");
      setSignaturePromptOpen(false);
      return;
    }

    let active = true;
    setSignatureConfigured(null);
    setSignatureCheckError("");
    getMySignature()
      .then((signature) => {
        if (!active) return;
        setSignatureConfigured(signature.configured);
        setSignaturePromptOpen(!signature.configured);
      })
      .catch((err) => {
        if (!active) return;
        setSignatureCheckError(err instanceof Error ? err.message : "SIGNATURE_STATUS_FAILED");
      });

    return () => {
      active = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user) {
      setClientUpdateInfo(null);
      return;
    }

    let active = true;
    async function checkClientUpdate() {
      const installedClientVersion = desktopClient ? await getDesktopClientVersion() : null;
      if (!active) return;
      const info = await getClientUpdateInfo(installedClientVersion);
      if (!active) return;
      const latestVersion = info.latest?.version ?? "";
      const clientInstaller = info.latest?.downloads?.clientInstaller;
      const dismissedVersion = readDismissedClientUpdateVersion(browserStorage());
      if (info.updateAvailable && latestVersion && clientInstaller && latestVersion !== dismissedVersion) {
        setClientUpdateInfo(info);
        return;
      }
      setClientUpdateInfo(null);
    }
    checkClientUpdate().catch(() => {
      if (active) setClientUpdateInfo(null);
    });

    return () => {
      active = false;
    };
  }, [desktopClient, user]);

  useEffect(() => {
    if (!user) return;
    if (!routeAllowedForRole(user, route.name)) {
      location.hash = routePath(defaultRouteForRole(user));
      return;
    }
    if (shouldBlockForMissingSignature({ user, signatureConfigured, routeName: route.name })) {
      setSignaturePromptOpen(true);
      location.hash = routePath("signature");
    }
  }, [route.name, signatureConfigured, user]);

  function applySignatureState(signature: MySignature) {
    setSignatureConfigured(signature.configured);
    if (signature.configured) {
      setSignaturePromptOpen(false);
      setSignatureCheckError("");
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsed(browserStorage(), next);
      return next;
    });
  }

  const desktopUpdateDialog = desktopClient && desktopUpdateStatus && !desktopUpdateDismissed ? (
    <DesktopUpdateDialog
      status={desktopUpdateStatus}
      onRetry={() => {
        setDesktopUpdateDismissed(false);
        void checkDesktopUpdates();
      }}
      onOpenInstaller={() => {
        void openDownloadedUpdateInstaller();
      }}
      onDismiss={() => setDesktopUpdateDismissed(true)}
    />
  ) : null;

  if (desktopClient && !serverConfigLoaded) {
    return (
      <>
        <main className="login-layout">
          <div className="empty">正在读取客户端配置...</div>
        </main>
        {desktopUpdateDialog}
      </>
    );
  }

  if (requiresServerConnectionSetup({ desktopClient, configLoaded: serverConfigLoaded, serverBaseUrl })) {
    return (
      <>
        <ServerConnectionPage
          initialServerUrl={serverBaseUrl}
          onConfigured={(nextServerBaseUrl) => {
            clearToken();
            setUser(null);
            setServerBaseUrlState(nextServerBaseUrl);
          }}
        />
        {desktopUpdateDialog}
      </>
    );
  }

  if (!user) {
    return (
      <>
        <LoginPage onLogin={setUser} resetToken={passwordResetTokenFromHash(location.hash)} />
        {desktopUpdateDialog}
      </>
    );
  }

  const showSignatureRequiredDialog = signatureSetupRequired(user) && signatureConfigured === false && signaturePromptOpen;
  const routeAllowed = routeAllowedForRole(user, route.name);
  const SidebarToggleIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className={sidebarCollapsed ? "app-layout app-layout--sidebar-collapsed" : "app-layout"}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark">
            <img className="brand__logo" src="/app-icon.png" alt="PDF 图纸审批" />
          </span>
          <div className="brand__text">
            <strong>PDF 图纸审批</strong>
            <span>局域网审批工作台</span>
          </div>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-pressed={sidebarCollapsed}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          onClick={toggleSidebar}
        >
          <SidebarToggleIcon className="sidebar-toggle__icon" size={18} strokeWidth={2} aria-hidden="true" />
          <span className="sidebar-toggle__text">{sidebarCollapsed ? "展开侧栏" : "收起侧栏"}</span>
        </button>
        <nav className="side-nav" aria-label="主导航">
          {nav.map((item) => {
            const Icon = navIconForRoute(item.route);
            return (
              <a
                key={item.href}
                className={route.name === item.route ? "active" : ""}
                href={item.href}
                title={item.label}
                aria-label={item.label}
                onMouseEnter={() => preloadRoute(item.route)}
                onFocus={() => preloadRoute(item.route)}
              >
                <span className="side-nav__icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={2} />
                </span>
                <span className="side-nav__full-label">{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="user-panel">
          <div>
            <strong>{user.displayName}</strong>
            <span>{roleLabel(user.role)}</span>
            <span className="user-panel__compact" aria-hidden="true">{roleCompactLabel(user.role)}</span>
          </div>
          <button
            type="button"
            className="ghost-button"
            aria-label="退出登录"
            title="退出登录"
            onClick={() => {
              clearToken();
              setUser(null);
            }}
          >
            <LogOut className="ghost-button__icon" size={16} strokeWidth={2} aria-hidden="true" />
            <span className="user-panel__logout-text">退出</span>
          </button>
        </div>
      </aside>
      <div className="content-area">
        <main id="main-content" className="app-shell">
          {desktopUpdateDialog}
          {clientUpdateInfo && (
            <ClientUpdateBanner
              info={clientUpdateInfo}
              onDismiss={(version) => {
                writeDismissedClientUpdateVersion(browserStorage(), version);
                setClientUpdateInfo(null);
              }}
            />
          )}
          {signatureCheckError && signatureSetupRequired(user) && (
            <div className="error">签名状态检查失败：{signatureCheckError}</div>
          )}
          <RoleFlowGuide user={user} />
          <Suspense fallback={<PageLoadingFallback routeName={route.name} />}>
            {routeAllowed && route.name === "tasks" && <MyTasksPage user={user} />}
            {routeAllowed && route.name === "submit" && <SubmitDrawingPage />}
            {routeAllowed && route.name === "approvals" && <ApprovalsPage user={user} />}
            {routeAllowed && route.name === "detail" && <ApprovalDetailPage id={route.id} user={user} />}
            {routeAllowed && route.name === "pdm" && <PdmPartsPage user={user} />}
            {routeAllowed && route.name === "pdmPending" && <PdmPendingMetadataPage />}
            {routeAllowed && route.name === "pdmDetail" && <PdmPartDetailPage id={route.id} user={user} />}
            {routeAllowed && route.name === "signature" && <MySignaturePage onSignatureUpdated={applySignatureState} />}
            {routeAllowed && route.name === "profile" && <ProfilePage onUserUpdated={setUser} />}
            {routeAllowed && route.name === "settings" && <SettingsPage />}
          </Suspense>
        </main>
      </div>
      {showSignatureRequiredDialog && (
        <SignatureRequiredDialog
          onGoSignature={() => {
            setSignaturePromptOpen(false);
            location.hash = routePath("signature");
          }}
        />
      )}
    </div>
  );
}

function DesktopUpdateDialog({
  status,
  onRetry,
  onOpenInstaller,
  onDismiss
}: {
  status: DesktopUpdateStatus;
  onRetry: () => void;
  onOpenInstaller: () => void;
  onDismiss: () => void;
}) {
  if (status.status === "idle" || status.status === "not_available" || status.status === "config_missing" || status.status === "installer_opened") {
    return null;
  }

  const percent = Math.max(0, Math.min(100, Math.round(status.percent ?? 0)));
  const latestVersion = status.latestVersion ? ` ${status.latestVersion}` : "";
  const downloading = status.status === "checking" || status.status === "downloading";
  const downloaded = status.status === "downloaded";
  const failed = status.status === "error";

  const title = downloaded ? `客户端新版${latestVersion}已下载` : failed ? "客户端更新检查失败" : `正在准备客户端新版${latestVersion}`;
  const description = downloaded
    ? "安装包已下载完成。请保存当前工作后打开安装包，按安装向导完成升级。"
    : failed
      ? status.message ?? "无法读取局域网更新清单，请确认服务端正在运行。"
      : status.message ?? "正在连接服务端更新目录并下载客户端安装包。";
  return (
    <Dialog open title={title} description={description} onClose={onDismiss} closeLabel="关闭更新提示"
      footer={<>{failed && <Button onClick={onRetry}>重新检查</Button>}
        {downloaded && <Button onClick={onOpenInstaller}>打开安装包</Button>}
        <Button variant="secondary" onClick={onDismiss}>{downloaded ? "稍后安装" : "后台处理"}</Button></>}>
      <div>
        {downloading && (
          <div className="desktop-update-progress" aria-label="客户端下载进度">
            <div className="desktop-update-progress__bar">
              <span style={{ width: `${status.status === "checking" ? 12 : percent}%` }} />
            </div>
            <div className="desktop-update-progress__meta">
              <span>{status.status === "checking" ? "检查中" : `${percent}%`}</span>
              {status.total ? <span>{formatBytes(status.transferred ?? 0)} / {formatBytes(status.total)}</span> : <span>等待下载信息</span>}
            </div>
          </div>
        )}

        {downloaded && (
          <ol className="desktop-update-steps">
            <li>保存当前正在编辑或审核的内容。</li>
            <li>点击“打开安装包”，Windows 会显示安装向导。</li>
            <li>按向导完成安装；如果提示客户端正在运行，请关闭当前客户端窗口。</li>
            <li>安装结束后重新打开客户端。</li>
          </ol>
        )}

        {status.releaseNotes && status.releaseNotes.length > 0 && (
          <ul className="desktop-update-notes">
            {status.releaseNotes.slice(0, 3).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function ClientUpdateBanner({ info, onDismiss }: { info: ClientUpdateInfo; onDismiss: (version: string) => void }) {
  const latest = info.latest;
  const clientInstaller = latest?.downloads?.clientInstaller;
  if (!latest || !clientInstaller) return null;

  return (
    <section className="client-update-banner" aria-label="客户端版本更新">
      <div className="client-update-banner__body">
        <span className="eyebrow">CLIENT UPDATE</span>
        <strong>客户端有新版本 {latest.version}</strong>
        <p>{latest.notes?.[0] ?? "检测到新的客户端安装包，建议在空闲时下载并安装。"}</p>
      </div>
      <div className="client-update-banner__actions">
        <a className="button-link primary" href={clientInstaller} target="_blank" rel="noreferrer">
          <Download size={16} strokeWidth={2} aria-hidden="true" />
          下载客户端
        </a>
        <button type="button" className="icon-button" aria-label="稍后提醒" title="稍后提醒" onClick={() => onDismiss(latest.version)}>
          <X size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function PageLoadingFallback({ routeName }: { routeName: AppRouteName }) {
  return <div className="empty compact-empty">正在打开{routeLabel(routeName)}...</div>;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function navIconForRoute(route: AppRouteName): LucideIcon {
  return {
    tasks: ClipboardCheck,
    submit: UploadCloud,
    signature: PenLine,
    profile: UserRound,
    approvals: FileText,
    settings: SettingsIcon,
    pdm: PackageSearch,
    pdmPending: PackageSearch,
    detail: FileText,
    pdmDetail: PackageSearch
  }[route];
}

function SignatureRequiredDialog({ onGoSignature }: { onGoSignature: () => void }) {
  return (
    <Dialog open title="必须先添加签名"
      description="当前账号尚未配置手写签名。请先在“我的签名”中上传 PNG 或在线手写签名，再继续提交、审核或打印归档。"
      onClose={onGoSignature} closeLabel="前往添加签名"
      footer={<Button onClick={onGoSignature}>去添加签名</Button>}>
      <span className="eyebrow">SIGNATURE REQUIRED</span>
    </Dialog>
  );
}

function roleLabel(role: User["role"]) {
  return {
    designer: "设计师",
    supervisor: "主管",
    process: "工艺",
    admin: "管理员"
  }[role];
}

function routeLabel(routeName: AppRouteName) {
  return {
    tasks: "待办",
    submit: "提交图纸",
    signature: "我的签名",
    profile: "我的资料",
    approvals: "全部图纸",
    settings: "系统管理",
    pdm: "零件库",
    pdmPending: "PDM 待补录",
    detail: "图纸详情",
    pdmDetail: "零件详情"
  }[routeName];
}

function roleCompactLabel(role: User["role"]) {
  return {
    designer: "设",
    supervisor: "主",
    process: "工",
    admin: "管"
  }[role];
}
