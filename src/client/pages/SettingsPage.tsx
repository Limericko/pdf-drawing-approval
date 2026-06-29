import { FormEvent, useEffect, useState } from "react";
import {
  createUser,
  deleteSignatureTemplate,
  getMaintenanceSettings,
  getApprovalReportCsvUrl,
  getSettings,
  getSystemLogs,
  getSystemDiagnostics,
  getSystemRisks,
  getSystemUpdateInfo,
  getWatchRootStatus,
  listBackups,
  listBatchSubmissions,
  listOperationLogs,
  listScanRuns,
  listServerDirectories,
  listSignatureStatuses,
  listSignatureTemplates,
  listUsers,
  pollWatchRootFolder,
  prepareStandardFolders,
  resetUserPassword,
  restartServer,
  runSystemCleanup,
  saveMaintenanceSettings,
  saveSettings,
  scanNow,
  selectWatchRootFolder,
  testSmtp,
  updateUser,
  updateSignatureTemplate,
  validateBackupDirectory,
  runBackup,
  type BackupValidationResult,
  type BatchSubmission,
  type BackupRun,
  type CleanupResult,
  type DirectoryListing,
  type SignatureTemplate,
  type OperationLog,
  type MaintenanceSettings,
  type ScanRun,
  type SystemDiagnostics,
  type SystemRisk,
  type SystemUpdateInfo,
  type User,
  type UserSignatureStatus,
  type WatchRootStatus
} from "../api.ts";
import { apiUrl } from "../clientConfig.ts";
import { statusLabel } from "../widgets/status.ts";
import { OperationsTab } from "./settings/OperationsTab.tsx";
export {
  batchSubmissionStatusLabel,
  buildMaintenanceRunSummary,
  normalizeBatchSubmissions,
  normalizeDiagnostics,
  normalizeSystemRisks,
  placementStateLabel,
  riskDashboardEmptyText,
  riskLevelLabel
} from "./settings/OperationsTab.tsx";

const fields = [
  ["watch_root", "坚果云图纸审批根目录"],
  ["app_base_url", "系统访问地址"],
  ["smtp_host", "SMTP 服务器"],
  ["smtp_port", "SMTP 端口"],
  ["smtp_user", "邮箱账号"],
  ["smtp_password", "邮箱密码/授权码"],
  ["smtp_from", "发件人"],
  ["supervisor_email", "主管邮箱"],
  ["process_email", "工艺邮箱"]
] as const;
type SettingKey = (typeof fields)[number][0];

const roles: Array<{ value: User["role"]; label: string }> = [
  { value: "designer", label: "设计师" },
  { value: "supervisor", label: "主管" },
  { value: "process", label: "工艺" },
  { value: "admin", label: "管理员" }
];

type Tab = "settings" | "users" | "templates" | "operations" | "logs";
const tabs: Tab[] = ["settings", "users", "templates", "operations", "logs"];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>(() => settingsTabFromHash(location.hash));
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<WatchRootStatus | null>(null);
  const [message, setMessage] = useState("");
  const [picking, setPicking] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [logs, setLogs] = useState<Array<{ name: string; exists: boolean; content: string }>>([]);
  const [scanRuns, setScanRuns] = useState<ScanRun[]>([]);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [risks, setRisks] = useState<SystemRisk[]>([]);
  const [backups, setBackups] = useState<BackupRun[]>([]);
  const [batchSubmissions, setBatchSubmissions] = useState<BatchSubmission[]>([]);
  const [signatureStatuses, setSignatureStatuses] = useState<UserSignatureStatus[]>([]);
  const [signatureTemplates, setSignatureTemplates] = useState<SignatureTemplate[]>([]);
  const [templateDrafts, setTemplateDrafts] = useState<Record<number, { name: string; projectName: string }>>({});
  const [scanning, setScanning] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [cleaning, setCleaning] = useState<"preview" | "execute" | "">("");
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [maintenanceSettings, setMaintenanceSettings] = useState<MaintenanceSettings>({
    autoBackup: { enabled: false, time: "01:00" },
    autoCleanup: { enabled: false, time: "03:30" }
  });
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [backupValidationPath, setBackupValidationPath] = useState("");
  const [backupValidationResult, setBackupValidationResult] = useState<BackupValidationResult | null>(null);
  const [validatingBackup, setValidatingBackup] = useState(false);
  const [smtpTestTo, setSmtpTestTo] = useState("");
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([]);
  const [updateInfo, setUpdateInfo] = useState<SystemUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [newUser, setNewUser] = useState({ username: "", password: "", displayName: "", email: "", role: "designer" as User["role"] });
  const [reportFilters, setReportFilters] = useState({ projectName: "", status: "", from: "", to: "" });

  useEffect(() => {
    refreshSettings();
  }, []);

  useEffect(() => {
    void refreshTab(tab);
  }, [tab]);

  useEffect(() => {
    const onHashChange = () => setTab(settingsTabFromHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function refreshSettings() {
    const [nextSettings, nextStatus] = await Promise.all([getSettings(), getWatchRootStatus()]);
    setSettings(nextSettings);
    setStatus(nextStatus);
  }

  async function refreshUsers() {
    setUsers(await listUsers());
  }

  async function refreshLogs() {
    const result = await getSystemLogs(240);
    setLogs(result.logs);
  }

  async function refreshScanRuns() {
    setScanRuns(await listScanRuns());
  }

  async function refreshDiagnostics() {
    setDiagnostics(await getSystemDiagnostics());
  }

  async function refreshRisks() {
    setRisks(await getSystemRisks());
  }

  async function refreshBackups() {
    setBackups(await listBackups());
  }

  async function refreshBatchSubmissions() {
    setBatchSubmissions(await listBatchSubmissions());
  }

  async function refreshSignatureStatuses() {
    setSignatureStatuses(await listSignatureStatuses());
  }

  async function refreshSignatureTemplates() {
    const templates = await listSignatureTemplates();
    setSignatureTemplates(templates);
    setTemplateDrafts(
      Object.fromEntries(
        templates.map((template) => [template.id, { name: template.name, projectName: template.projectName ?? "" }])
      )
    );
  }

  async function refreshOperationLogs() {
    setOperationLogs(await listOperationLogs());
  }

  async function refreshMaintenanceSettings() {
    setMaintenanceSettings(await getMaintenanceSettings());
  }

  async function refreshUpdateInfo() {
    setUpdateInfo(await getSystemUpdateInfo());
  }

  async function refreshOperationsTab() {
    await Promise.all([
      refreshRisks(),
      refreshDiagnostics(),
      refreshBackups(),
      refreshBatchSubmissions(),
      refreshSignatureStatuses(),
      refreshMaintenanceSettings(),
      refreshOperationLogs(),
      refreshUpdateInfo()
    ]);
  }

  async function refreshTab(nextTab: Tab) {
    if (nextTab === "settings") {
      await refreshScanRuns();
      return;
    }

    if (nextTab === "users") {
      await refreshUsers();
      return;
    }

    if (nextTab === "templates") {
      await refreshSignatureTemplates();
      return;
    }

    if (nextTab === "operations") {
      await refreshOperationsTab();
      return;
    }

    await refreshLogs();
  }

  function switchTab(nextTab: Tab) {
    location.hash = settingsHashForTab(nextTab);
    setTab(nextTab);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await saveSettings(pickEditableSettings(settings));
    setMessage("配置已保存。修改监听目录后请点击“重启服务”生效。");
    await refreshSettings();
  }

  async function chooseFolder() {
    setPicking(true);
    setMessage("正在打开服务器电脑上的文件夹选择窗口；如果没有看到，请检查是否被其他窗口遮挡。");
    try {
      const started = await selectWatchRootFolder();
      const deadline = Date.now() + 120_000;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const result = await pollWatchRootFolder(started.pickerId);

        if (result.status === "selected") {
          await useSelectedWatchRoot(result.path);
          return;
        }

        if (result.status === "cancelled") {
          setMessage("已取消选择");
          return;
        }

        if (result.status === "error") {
          setMessage(result.message);
          return;
        }
      }

      setMessage("未收到文件夹选择结果。请使用“浏览服务器目录”或直接手动填写路径。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法打开文件夹选择窗口");
    } finally {
      setPicking(false);
    }
  }

  async function chooseWithFileSystemAccess() {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<{ name: string }> }).showDirectoryPicker;
    if (!picker) {
      setMessage("当前浏览器不支持 File System Access API，请使用 Chrome/Edge 或“浏览服务器目录”。");
      return;
    }

    try {
      const handle = await picker();
      setMessage(`已选择浏览器本机目录“${handle.name}”。浏览器不会暴露 Windows 绝对路径，后端监听仍需填写服务器可访问路径。`);
    } catch {
      setMessage("已取消浏览器目录选择。");
    }
  }

  async function useSelectedWatchRoot(path: string) {
    setSettings((current) => ({ ...current, watch_root: path }));
    const confirmed = window.confirm(`是否在以下目录创建标准审批目录？\n\n${path}`);
    if (confirmed) {
      const result = await prepareStandardFolders(path);
      const created = result.folders.filter((folder) => folder.status === "created").length;
      setMessage(`已填入目录并完成标准目录检查：新建 ${created} 个，已有 ${result.folders.length - created} 个。保存并重启后监听生效。`);
    } else {
      setMessage("已填入目录。保存配置并重启服务后监听生效。");
    }
    await refreshSettings();
  }

  async function createFolders() {
    const root = settings.watch_root?.trim();
    if (!root) {
      setMessage("请先填写审批根目录。");
      return;
    }
    if (!window.confirm(`将在该目录下创建 01-待提交 等标准目录：\n\n${root}`)) return;
    const result = await prepareStandardFolders(root);
    const created = result.folders.filter((folder) => folder.status === "created").length;
    setMessage(`标准目录已就绪：新建 ${created} 个，已有 ${result.folders.length - created} 个。`);
    await refreshSettings();
  }

  async function openDirectoryBrowser(path?: string) {
    setBrowserOpen(true);
    setMessage("");
    try {
      setListing(await listServerDirectories(path));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法读取服务器目录");
    }
  }

  function useCurrentDirectory() {
    if (!listing?.currentPath) return;
    void useSelectedWatchRoot(listing.currentPath);
  }

  async function restart() {
    setRestarting(true);
    setMessage("正在重启服务，请稍候...");
    try {
      await restartServer();
    } catch {
      // The request can be interrupted if the process exits quickly; continue polling health.
    }

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const response = await fetch(apiUrl("/health"), { cache: "no-store" });
      if (response.ok) {
        setMessage("服务已重启，监听目录配置已生效。");
        setRestarting(false);
        await Promise.all([refreshSettings(), refreshLogs(), refreshDiagnostics(), refreshRisks(), refreshBatchSubmissions()]);
        return;
      }
      } catch {
        // Service is still restarting.
      }
    }

    setMessage("服务重启请求已发送，但尚未确认恢复。请稍后刷新页面或检查服务日志。");
    setRestarting(false);
  }

  async function runManualScan() {
    setScanning(true);
    setMessage("正在扫描审批目录...");
    try {
      const result = await scanNow();
      setMessage(`扫描完成：处理 ${result.processedCount} 个，丢失 ${result.missingCount} 个，无效 PDF ${result.invalidCount} 个。`);
      await Promise.all([refreshScanRuns(), refreshRisks(), refreshDiagnostics(), refreshOperationLogs()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描失败");
    } finally {
      setScanning(false);
    }
  }

  async function runDatabaseBackupNow() {
    setBackingUp(true);
    setMessage("正在创建数据库备份...");
    try {
      const result = await runBackup();
      setMessage(`数据库备份已完成：${result.backupPath}`);
      await Promise.all([refreshBackups(), refreshRisks(), refreshDiagnostics(), refreshOperationLogs()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "数据库备份失败");
      await Promise.all([refreshBackups(), refreshRisks(), refreshDiagnostics(), refreshOperationLogs()]);
    } finally {
      setBackingUp(false);
    }
  }

  async function runCleanupPreview() {
    setCleaning("preview");
    setMessage("正在预览可清理项目...");
    try {
      const result = await runSystemCleanup(false);
      setCleanupResult(result);
      setMessage("清理预览已更新。");
      await refreshOperationLogs();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清理预览失败");
    } finally {
      setCleaning("");
    }
  }

  async function executeCleanupNow() {
    if (!window.confirm("确认执行清理？系统只会清理临时上传、旧失败批量提交记录和未被当前记录引用的旧签审 PDF。")) return;
    setCleaning("execute");
    setMessage("正在执行清理...");
    try {
      const result = await runSystemCleanup(true);
      setCleanupResult(result);
      setMessage("清理已完成。");
      await Promise.all([refreshBatchSubmissions(), refreshOperationLogs(), refreshRisks(), refreshDiagnostics()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "执行清理失败");
    } finally {
      setCleaning("");
    }
  }

  async function saveMaintenance() {
    setSavingMaintenance(true);
    setMessage("正在保存自动维护计划...");
    try {
      const saved = await saveMaintenanceSettings(maintenanceSettings);
      setMaintenanceSettings(saved);
      setMessage("自动维护计划已保存。");
      await refreshOperationLogs();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "自动维护计划保存失败");
    } finally {
      setSavingMaintenance(false);
    }
  }

  async function checkUpdateNow() {
    setCheckingUpdate(true);
    setMessage("正在检查版本更新...");
    try {
      const result = await getSystemUpdateInfo();
      setUpdateInfo(result);
      if (!result.updateSourceUrl) {
        setMessage("服务端会默认使用当前访问地址的 /updates/latest.json。请确认服务端更新目录已有发布文件。");
      } else if (result.error) {
        setMessage(`更新检查失败：${result.error}`);
      } else if (result.updateAvailable) {
        setMessage(`发现新版本 ${result.latest?.version}。`);
      } else {
        setMessage("当前已经是最新版本。");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新检查失败");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function runBackupValidation() {
    const path = backupValidationPath.trim();
    if (!path) {
      setMessage("请先填写要校验的备份目录。");
      return;
    }

    setValidatingBackup(true);
    setBackupValidationResult(null);
    setMessage("正在校验备份目录...");
    try {
      const result = await validateBackupDirectory(path);
      setBackupValidationResult(result);
      setMessage(result.message);
      await refreshOperationLogs();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "备份目录校验失败");
    } finally {
      setValidatingBackup(false);
    }
  }

  async function sendSmtpTest() {
    setTestingSmtp(true);
    setMessage("正在发送测试邮件...");
    try {
      await testSmtp(smtpTestTo);
      setMessage("测试邮件已发送。");
      await refreshOperationLogs();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试邮件发送失败");
      await refreshOperationLogs();
    } finally {
      setTestingSmtp(false);
    }
  }

  function clearNotificationRecords() {
    localStorage.removeItem("pdf_approval_notified_task_ids");
    setMessage("本机通知记录已清除。");
  }

  function exportApprovalReport() {
    window.open(getApprovalReportCsvUrl(reportFilters), "_blank", "noopener,noreferrer");
  }

  async function submitNewUser(event: FormEvent) {
    event.preventDefault();
    await createUser(newUser);
    setNewUser({ username: "", password: "", displayName: "", email: "", role: "designer" });
    setMessage("用户已创建。");
    await refreshUsers();
  }

  async function saveUser(user: User) {
    await updateUser(user.id, {
      role: user.role,
      displayName: user.displayName,
      email: user.email ?? "",
      active: user.active ?? true
    });
    setMessage("用户已更新。");
    await refreshUsers();
  }

  async function resetPassword(user: User) {
    const password = window.prompt(`请输入 ${user.displayName} 的新密码，至少 6 位：`);
    if (!password) return;
    await resetUserPassword(user.id, password);
    setMessage("密码已重置。");
  }

  function updateTemplateDraft(id: number, field: "name" | "projectName", value: string) {
    setTemplateDrafts((current) => ({
      ...current,
      [id]: {
        name: current[id]?.name ?? "",
        projectName: current[id]?.projectName ?? "",
        [field]: value
      }
    }));
  }

  async function saveTemplate(template: SignatureTemplate) {
    const draft = templateDrafts[template.id] ?? { name: template.name, projectName: template.projectName ?? "" };
    await updateSignatureTemplate(template.id, {
      name: draft.name,
      projectName: draft.projectName.trim() || null,
      placements: template.placements
    });
    setMessage("签名模板已保存。");
    await refreshSignatureTemplates();
  }

  async function removeTemplate(template: SignatureTemplate) {
    if (!window.confirm(`确认删除签名模板“${template.name}”？`)) return;
    await deleteSignatureTemplate(template.id);
    setMessage("签名模板已删除。");
    await refreshSignatureTemplates();
  }

  return (
    <section>
      <div className="section-title">
        <span className="eyebrow">ADMIN CONSOLE</span>
        <h1>系统运维控制台</h1>
        <p>配置目录、用户、签名模板、日志和追溯报表。</p>
      </div>

      <div className="admin-status-grid">
        <StatusTile label="监听根目录" value={status?.watchRoot ?? "未配置"} tone={status?.rootExists ? "ok" : "warn"} />
        <StatusTile label="标准目录" value={status?.ready ? "已就绪" : "需检查"} tone={status?.ready ? "ok" : "warn"} />
        <StatusTile label="配置生效" value="重启后生效" tone="neutral" />
      </div>

      <div className="admin-tabs">
        <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => switchTab("settings")}>目录与通知</button>
        <button type="button" className={tab === "users" ? "active" : ""} onClick={() => switchTab("users")}>用户管理</button>
        <button type="button" className={tab === "templates" ? "active" : ""} onClick={() => switchTab("templates")}>签名模板</button>
        <button type="button" className={tab === "operations" ? "active" : ""} onClick={() => switchTab("operations")}>运维追溯</button>
        <button type="button" className={tab === "logs" ? "active" : ""} onClick={() => switchTab("logs")}>服务日志</button>
      </div>

      {message && <div className="success">{message}</div>}

      {tab === "settings" && (
        <>
          <div className="notice">
            优先使用“浏览服务器目录”选择坚果云目录，确保服务端能监听到真实路径。
          </div>
          <form className="settings-form" onSubmit={onSubmit}>
            {fields.map(([key, label]) => (
              <label key={key}>
                {label}
                {key === "watch_root" ? (
                  <div className="path-picker">
                    <input
                      type="text"
                      autoComplete={settingInputAutocomplete(key)}
                      value={settings[key] ?? ""}
                      onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
                      placeholder={key === "watch_root" ? "例如 D:\\Nutstore\\图纸审批" : undefined}
                    />
                    <button type="button" className="secondary-button" onClick={chooseFolder} disabled={picking}>
                      {picking ? "选择中" : "系统弹窗"}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => openDirectoryBrowser(settings.watch_root || undefined)}>
                      浏览服务器目录
                    </button>
                    <button type="button" className="secondary-button" onClick={chooseWithFileSystemAccess}>
                      浏览器选择
                    </button>
                  </div>
                ) : (
                  <input
                    type={key === "smtp_password" ? "password" : "text"}
                    autoComplete={settingInputAutocomplete(key)}
                    value={settings[key] ?? ""}
                    onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
                  />
                )}
              </label>
            ))}
            <div className="folder-checklist">
              {(status?.folders ?? []).map((folder) => (
                <span key={folder.name} className={folder.exists ? "folder-ok" : "folder-missing"}>
                  {folder.exists ? "已存在" : "缺失"} · {folder.name}
                </span>
              ))}
            </div>
            <div className="form-actions">
              <button type="submit">保存配置</button>
              <button type="button" className="secondary-button" onClick={createFolders}>
                创建标准目录
              </button>
              <button type="button" className="secondary-button" onClick={restart} disabled={restarting}>
                {restarting ? "重启中" : "重启服务"}
              </button>
            </div>
          </form>
          <DirectoryBrowser
            open={browserOpen}
            listing={listing}
            onClose={() => setBrowserOpen(false)}
            onOpen={openDirectoryBrowser}
            onUse={useCurrentDirectory}
          />
          <div className="management-grid">
            <section className="management-panel">
              <div className="panel-heading">
                <div>
                  <h2>目录扫描</h2>
                  <span>补偿漏监听、同步延迟和文件丢失状态</span>
                </div>
                <button type="button" onClick={runManualScan} disabled={scanning}>
                  {scanning ? "扫描中" : "立即重新扫描"}
                </button>
              </div>
              <ScanRunList runs={scanRuns} />
            </section>
            <section className="management-panel">
              <div className="panel-heading">
                <div>
                  <h2>邮件测试</h2>
                  <span>使用当前 SMTP 配置发送一次测试邮件</span>
                </div>
              </div>
              <div className="inline-form">
                <input autoComplete="email" value={smtpTestTo} onChange={(event) => setSmtpTestTo(event.target.value)} placeholder="test@example.com" />
                <button type="button" onClick={sendSmtpTest} disabled={testingSmtp || !smtpTestTo.trim()}>
                  {testingSmtp ? "发送中" : "发送测试邮件"}
                </button>
              </div>
              <div className="form-actions">
                <button type="button" className="secondary-button" onClick={clearNotificationRecords}>
                  清除本机通知记录
                </button>
              </div>
            </section>
          </div>
        </>
      )}

      {tab === "users" && (
        <div className="admin-panel">
          <form className="user-create-row" onSubmit={submitNewUser}>
            <input autoComplete="username" placeholder="用户名" value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} />
            <input autoComplete="name" placeholder="姓名" value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} />
            <input autoComplete="email" placeholder="邮箱" value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} />
            <input type="password" autoComplete="new-password" placeholder="初始密码" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} />
            <select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as User["role"] })}>
              {roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
            </select>
            <button type="submit">新增用户</button>
          </form>
          <div className="table-surface">
            <table className="data-table user-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>姓名</th>
                  <th>邮箱</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.username}</td>
                    <td><input value={user.displayName} onChange={(event) => setUsers((current) => current.map((item) => item.id === user.id ? { ...item, displayName: event.target.value } : item))} /></td>
                    <td><input value={user.email ?? ""} onChange={(event) => setUsers((current) => current.map((item) => item.id === user.id ? { ...item, email: event.target.value } : item))} /></td>
                    <td>
                      <select value={user.role} onChange={(event) => setUsers((current) => current.map((item) => item.id === user.id ? { ...item, role: event.target.value as User["role"] } : item))}>
                        {roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <label className="inline-check">
                        <input type="checkbox" checked={user.active ?? true} onChange={(event) => setUsers((current) => current.map((item) => item.id === user.id ? { ...item, active: event.target.checked } : item))} />
                        启用
                      </label>
                    </td>
                    <td className="actions">
                      <button type="button" className="secondary-button" onClick={() => saveUser(user)}>保存</button>
                      <button type="button" className="ghost-light-button" onClick={() => resetPassword(user)}>重置密码</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "logs" && (
        <div className="admin-panel">
          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={refreshLogs}>刷新日志</button>
            <button type="button" className="secondary-button" onClick={restart} disabled={restarting}>{restarting ? "重启中" : "重启服务"}</button>
          </div>
          <div className="log-grid">
            {logs.map((log) => (
              <section className="log-panel" key={log.name}>
                <div className="log-panel__header">
                  <strong>{log.name}</strong>
                  <span>{log.exists ? "可读取" : "未生成"}</span>
                </div>
                <pre>{log.content || "暂无日志内容"}</pre>
              </section>
            ))}
          </div>
        </div>
      )}
      {tab === "templates" && (
        <div className="admin-panel">
          <section className="management-panel">
            <div className="panel-heading">
              <div>
                <h2>签名模板</h2>
                <span>维护提交页可套用的设计、主管、工艺签名框位置</span>
              </div>
              <button type="button" className="secondary-button" onClick={refreshSignatureTemplates}>
                刷新
              </button>
            </div>
            <div className="table-surface">
              <table className="data-table template-table">
                <thead>
                  <tr>
                    <th>模板名称</th>
                    <th>适用项目</th>
                    <th>位置</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {signatureTemplates.map((template) => (
                    <tr key={template.id}>
                      <td>
                        <input
                          value={templateDrafts[template.id]?.name ?? template.name}
                          onChange={(event) => updateTemplateDraft(template.id, "name", event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          value={templateDrafts[template.id]?.projectName ?? template.projectName ?? ""}
                          onChange={(event) => updateTemplateDraft(template.id, "projectName", event.target.value)}
                          placeholder="留空为通用"
                        />
                      </td>
                      <td>{template.placements.length} 个签名框</td>
                      <td>{formatTime(template.updatedAt)}</td>
                      <td className="actions">
                        <button type="button" className="secondary-button" onClick={() => saveTemplate(template)}>
                          保存
                        </button>
                        <button type="button" className="ghost-light-button" onClick={() => removeTemplate(template)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                  {signatureTemplates.length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty-cell">暂无签名模板</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {tab === "operations" && (
        <OperationsTab
          risks={risks}
          diagnostics={diagnostics}
          backups={backups}
          backingUp={backingUp}
          signatureStatuses={signatureStatuses}
          batchSubmissions={batchSubmissions}
          cleanupResult={cleanupResult}
          cleaning={cleaning}
          maintenanceSettings={maintenanceSettings}
          savingMaintenance={savingMaintenance}
          backupValidationPath={backupValidationPath}
          backupValidationResult={backupValidationResult}
          validatingBackup={validatingBackup}
          reportFilters={reportFilters}
          operationLogs={operationLogs}
          updateInfo={updateInfo}
          checkingUpdate={checkingUpdate}
          onRefreshRisks={refreshRisks}
          onRefreshDiagnostics={refreshDiagnostics}
          onRunBackup={runDatabaseBackupNow}
          onRefreshSignatureStatuses={refreshSignatureStatuses}
          onRefreshBatchSubmissions={refreshBatchSubmissions}
          onCleanupPreview={runCleanupPreview}
          onCleanupExecute={executeCleanupNow}
          onMaintenanceChange={setMaintenanceSettings}
          onBackupValidationPathChange={setBackupValidationPath}
          onSaveMaintenance={saveMaintenance}
          onValidateBackup={runBackupValidation}
          onReportFiltersChange={setReportFilters}
          onExportReport={exportApprovalReport}
          onRefreshOperationLogs={refreshOperationLogs}
          onCheckUpdate={checkUpdateNow}
        />
      )}
    </section>
  );
}

export function settingsTabFromHash(hashValue: string): Tab {
  const query = hashValue.split("?")[1] ?? "";
  const tab = new URLSearchParams(query).get("tab");
  return tabs.includes(tab as Tab) ? (tab as Tab) : "settings";
}

export function settingsHashForTab(tab: Tab) {
  return tab === "settings" ? "#/settings" : `#/settings?tab=${tab}`;
}

export function settingInputAutocomplete(key: SettingKey) {
  return (
    {
      watch_root: "off",
      app_base_url: "url",
      smtp_host: "off",
      smtp_port: "off",
      smtp_user: "username",
      smtp_password: "current-password",
      smtp_from: "email",
      supervisor_email: "email",
      process_email: "email"
    } satisfies Record<SettingKey, string>
  )[key];
}

function pickEditableSettings(settings: Record<string, string>) {
  return Object.fromEntries(fields.map(([key]) => [key, settings[key] ?? ""]));
}

function StatusTile(props: { label: string; value: string; tone: "ok" | "warn" | "neutral" }) {
  return (
    <div className={`status-tile status-tile--${props.tone}`}>
      <span>{props.label}</span>
      <strong title={props.value}>{props.value}</strong>
    </div>
  );
}

function ScanRunList({ runs }: { runs: ScanRun[] }) {
  if (runs.length === 0) {
    return <div className="empty compact-empty">暂无扫描记录</div>;
  }

  return (
    <div className="scan-run-list">
      {runs.slice(0, 5).map((run) => (
        <div key={run.id} className="scan-run-row">
          <div>
            <strong>{statusLabel(run.status)}</strong>
            <span>{new Date(run.startedAt).toLocaleString()}</span>
          </div>
          <div className="scan-counts">
            <span>处理 {run.processedCount}</span>
            <span>丢失 {run.missingCount}</span>
            <span>无效 {run.invalidCount}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DirectoryBrowser(props: {
  open: boolean;
  listing: DirectoryListing | null;
  onClose: () => void;
  onOpen: (path?: string) => void;
  onUse: () => void;
}) {
  if (!props.open || !props.listing) return null;
  return (
    <div className="directory-browser">
      <div className="directory-browser__header">
        <div>
          <strong>{props.listing.currentPath ?? "选择磁盘"}</strong>
          <span>在服务器电脑上浏览目录</span>
        </div>
        <div className="actions">
          {props.listing.parentPath && (
            <button type="button" className="secondary-button" onClick={() => props.onOpen(props.listing!.parentPath!)}>
              上一级
            </button>
          )}
          {props.listing.currentPath && (
            <button type="button" onClick={props.onUse}>
              使用当前目录
            </button>
          )}
          <button type="button" className="ghost-light-button" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
      <div className="directory-list">
        {props.listing.entries.map((entry) => (
          <button key={entry.path} type="button" onClick={() => props.onOpen(entry.path)}>
            <span>{entry.name}</span>
            <small>{entry.path}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}
