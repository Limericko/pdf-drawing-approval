import type {
  BackupValidationResult,
  BackupRun,
  BatchSubmission,
  CleanupResult,
  MaintenanceSettings,
  OperationLog,
  PdmBackfillResult,
  SystemDiagnostics,
  SystemRisk,
  SystemUpdateInfo,
  UserSignatureStatus
} from "../../api.ts";
import { statusLabel } from "../../widgets/status.ts";
import { Button } from "../../ui/actions/index.tsx";
import { DataTable, TableFrame, type DataTableColumn } from "../../ui/data/index.tsx";
import styles from "./OperationsTab.module.css";

type CleanupBusy = "preview" | "execute" | "";
type ReportFilters = { projectName: string; status: string; from: string; to: string };
type MaintenanceRunSummaryItem = {
  key: "autoBackup" | "autoCleanup" | "backupValidation";
  label: string;
  tone: "ok" | "warn";
  message: string;
  timeLabel: string;
};

export function OperationsTab({
  risks,
  diagnostics,
  backups,
  backingUp,
  signatureStatuses,
  batchSubmissions,
  cleanupResult,
  cleaning,
  maintenanceSettings,
  savingMaintenance,
  backupValidationPath,
  backupValidationResult,
  validatingBackup,
  reportFilters,
  operationLogs,
  updateInfo,
  checkingUpdate,
  pdmBackfillResult,
  backfillingPdm,
  onRefreshRisks,
  onRefreshDiagnostics,
  onRunBackup,
  onRefreshSignatureStatuses,
  onRefreshBatchSubmissions,
  onCleanupPreview,
  onCleanupExecute,
  onMaintenanceChange,
  onBackupValidationPathChange,
  onSaveMaintenance,
  onValidateBackup,
  onReportFiltersChange,
  onExportReport,
  onRefreshOperationLogs,
  onCheckUpdate,
  onRunPdmBackfill
}: {
  risks: SystemRisk[];
  diagnostics: SystemDiagnostics | null;
  backups: BackupRun[];
  backingUp: boolean;
  signatureStatuses: UserSignatureStatus[];
  batchSubmissions: BatchSubmission[];
  cleanupResult: CleanupResult | null;
  cleaning: CleanupBusy;
  maintenanceSettings: MaintenanceSettings;
  savingMaintenance: boolean;
  backupValidationPath: string;
  backupValidationResult: BackupValidationResult | null;
  validatingBackup: boolean;
  reportFilters: ReportFilters;
  operationLogs: OperationLog[];
  updateInfo: SystemUpdateInfo | null;
  checkingUpdate: boolean;
  pdmBackfillResult: PdmBackfillResult | null;
  backfillingPdm: boolean;
  onRefreshRisks: () => void;
  onRefreshDiagnostics: () => void;
  onRunBackup: () => void;
  onRefreshSignatureStatuses: () => void;
  onRefreshBatchSubmissions: () => void;
  onCleanupPreview: () => void;
  onCleanupExecute: () => void;
  onMaintenanceChange: (settings: MaintenanceSettings) => void;
  onBackupValidationPathChange: (path: string) => void;
  onSaveMaintenance: () => void;
  onValidateBackup: () => void;
  onReportFiltersChange: (filters: ReportFilters) => void;
  onExportReport: () => void;
  onRefreshOperationLogs: () => void;
  onCheckUpdate: () => void;
  onRunPdmBackfill: () => void;
}) {
  return (
    <div className="admin-panel">
      <RiskDashboard risks={risks} onRefresh={onRefreshRisks} />
      <VersionUpdatePanel updateInfo={updateInfo} checking={checkingUpdate} onCheck={onCheckUpdate} />
      <DiagnosticsPanel diagnostics={diagnostics} onRefresh={onRefreshDiagnostics} />
      <PdmBackfillPanel result={pdmBackfillResult} running={backfillingPdm} onRun={onRunPdmBackfill} />
      <div className="ops-grid">
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h2>数据库备份</h2>
              <span>创建 SQLite 数据库与 WAL/SHM 文件快照</span>
            </div>
            <button type="button" onClick={onRunBackup} disabled={backingUp}>
              {backingUp ? "备份中" : "立即备份"}
            </button>
          </div>
          <BackupRunList runs={backups} />
        </section>
        <SignatureStatusPanel statuses={signatureStatuses} onRefresh={onRefreshSignatureStatuses} />
      </div>
      <BatchSubmissionHistoryPanel batches={batchSubmissions} onRefresh={onRefreshBatchSubmissions} />
      <MaintenancePanel
        settings={maintenanceSettings}
        saving={savingMaintenance}
        validationPath={backupValidationPath}
        validationResult={backupValidationResult}
        validating={validatingBackup}
        onChange={onMaintenanceChange}
        onValidationPathChange={onBackupValidationPathChange}
        onSave={onSaveMaintenance}
        onValidate={onValidateBackup}
      />
      <MaintenanceRunSummaryPanel logs={operationLogs} />
      <CleanupPanel result={cleanupResult} busy={cleaning} onPreview={onCleanupPreview} onExecute={onCleanupExecute} />
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h2>追溯报表</h2>
            <span>导出审批、审核、签名、哈希与归档字段</span>
          </div>
          <button type="button" onClick={onExportReport}>
            导出 CSV
          </button>
        </div>
        <div className="report-filter-grid">
          <label>
            项目
            <input
              value={reportFilters.projectName}
              onChange={(event) => onReportFiltersChange({ ...reportFilters, projectName: event.target.value })}
              placeholder="留空导出全部项目"
            />
          </label>
          <label>
            状态
            <select value={reportFilters.status} onChange={(event) => onReportFiltersChange({ ...reportFilters, status: event.target.value })}>
              <option value="">全部状态</option>
              <option value="pending">待审</option>
              <option value="rejected">驳回</option>
              <option value="approved_for_print">已通过待打印</option>
              <option value="printed_archived">已打印归档</option>
              <option value="file_missing">文件已丢失</option>
              <option value="invalid_pdf">PDF 无效</option>
              <option value="voided">已作废</option>
            </select>
          </label>
          <label>
            提交起始
            <input type="date" value={reportFilters.from} onChange={(event) => onReportFiltersChange({ ...reportFilters, from: event.target.value })} />
          </label>
          <label>
            提交截止
            <input type="date" value={reportFilters.to} onChange={(event) => onReportFiltersChange({ ...reportFilters, to: event.target.value })} />
          </label>
        </div>
      </section>
      <OperationLogPanel logs={operationLogs} onRefresh={onRefreshOperationLogs} />
    </div>
  );
}

function PdmBackfillPanel(props: { result: PdmBackfillResult | null; running: boolean; onRun: () => void }) {
  const summary = buildPdmBackfillSummary(props.result);
  return (
    <section className="management-panel pdm-backfill-panel">
      <div className="panel-heading">
        <div>
          <h2>PDM 历史回填</h2>
          <span>将已通过或已归档的历史 PDF 按标准文件名补发布到零件库</span>
        </div>
        <button type="button" onClick={props.onRun} disabled={props.running}>
          {props.running ? "回填中" : "回填已通过图纸"}
        </button>
      </div>
      <div className="cleanup-summary-grid">
        <DiagnosticItem label="扫描记录" value={`${props.result?.scanned ?? 0} 条`} ok />
        <DiagnosticItem label="已发布" value={`${props.result?.published ?? 0} 条`} ok={(props.result?.failed ?? 0) === 0} />
        <DiagnosticItem label="已跳过" value={`${props.result?.skipped ?? 0} 条`} ok={(props.result?.skipped ?? 0) === 0} />
        <DiagnosticItem label="失败" value={`${props.result?.failed ?? 0} 条`} ok={(props.result?.failed ?? 0) === 0} />
      </div>
      {props.result ? (
        <div className="cleanup-file-list pdm-backfill-result-list">
          <strong>{summary.headline}</strong>
          {summary.rows.slice(0, 8).map((row) => (
            <span key={row} title={row}>{row}</span>
          ))}
          {summary.rows.length > 8 && <span>还有 {summary.rows.length - 8} 条明细未显示</span>}
        </div>
      ) : (
        <div className="empty compact-empty">用于上线初期把历史审批记录补入 PDM；重复物料版本会被跳过并记录原因。</div>
      )}
    </section>
  );
}

export function buildPdmBackfillSummary(result: PdmBackfillResult | null) {
  if (!result) return { headline: "尚未执行历史回填", rows: [] };
  return {
    headline: `扫描 ${result.scanned} / 发布 ${result.published} / 跳过 ${result.skipped} / 失败 ${result.failed}`,
    rows: result.items.map((item) => {
      const parts = [`审批 #${item.approvalId}`, pdmBackfillStatusLabel(item.status)];
      if (item.reason) parts.push(pdmBackfillReasonLabel(item.reason));
      if (item.materialCode) parts.push(item.materialCode);
      if (item.version) parts.push(item.version);
      return parts.join(" · ");
    })
  };
}

function pdmBackfillStatusLabel(status: PdmBackfillResult["items"][number]["status"]) {
  return {
    published: "已发布",
    skipped: "已跳过",
    failed: "失败"
  }[status];
}

export function pdmBackfillReasonLabel(reason: string) {
  return (
    {
      already_published: "已发布过",
      filename_not_standard_pdm: "文件名不是完整 PDM 格式",
      file_missing: "PDF 文件丢失",
      invalid_pdf: "PDF 文件无效",
      duplicate_material_version: "物料版本已存在",
      pdm_publish_failed: "PDM 发布失败"
    }[reason] ?? reason
  );
}

function VersionUpdatePanel(props: { updateInfo: SystemUpdateInfo | null; checking: boolean; onCheck: () => void }) {
  const info = props.updateInfo;
  const latest = info?.latest;
  const downloads = latest?.downloads ?? {};
  return (
    <section className="management-panel version-update-panel">
      <div className="panel-heading">
        <div>
          <h2>版本更新</h2>
          <span>通过服务端内置更新目录检查新版安装包</span>
        </div>
        <div className="actions">
          {info && <span className={info.updateAvailable ? "risk-count risk-count--warning" : "health-badge health-badge--ok"}>{info.updateAvailable ? "发现新版" : "当前版本"}</span>}
          <button type="button" className="secondary-button" onClick={props.onCheck} disabled={props.checking}>
            {props.checking ? "检查中" : "检查更新"}
          </button>
        </div>
      </div>
      <div className="diagnostic-grid">
        <DiagnosticItem label="服务端当前版本" value={info?.currentVersion ?? "读取中"} ok={Boolean(info)} />
        <DiagnosticItem label="最新版本" value={latest?.version ?? "未获取"} ok={!info?.updateAvailable} />
        <DiagnosticItem label="接口兼容" value={`API ${info?.currentApiCompatVersion ?? 1}`} ok />
        <DiagnosticItem label="更新源" value={info?.updateSourceUrl ? "服务端内置" : "待检查"} ok={Boolean(info?.updateSourceUrl)} />
      </div>
      {info?.updateSourceUrl && <p className="update-source" title={info.updateSourceUrl}>服务端更新清单：{info.updateSourceUrl}</p>}
      {info?.error && <div className="error-box">更新检查失败：{info.error}</div>}
      {latest?.notes?.length ? (
        <div className="release-note-list">
          <strong>{latest.version} 更新说明</strong>
          {latest.notes.map((note) => <span key={note}>{note}</span>)}
        </div>
      ) : null}
      {(downloads.clientInstaller || downloads.serverInstaller || latest?.changelogUrl) && (
        <div className="download-link-list">
          {downloads.clientInstaller && <a href={downloads.clientInstaller} target="_blank" rel="noreferrer">下载客户端安装包</a>}
          {downloads.serverInstaller && <a href={downloads.serverInstaller} target="_blank" rel="noreferrer">下载服务端安装包</a>}
          {latest?.changelogUrl && <a href={latest.changelogUrl} target="_blank" rel="noreferrer">查看在线更新日志</a>}
        </div>
      )}
    </section>
  );
}

function RiskDashboard(props: { risks: SystemRisk[]; onRefresh: () => void }) {
  const normalized = normalizeSystemRisks(props.risks);
  const errorCount = normalized.filter((risk) => risk.level === "error").length;
  const warningCount = normalized.filter((risk) => risk.level === "warning").length;

  return (
    <section className="management-panel risk-dashboard">
      <div className="panel-heading">
        <div>
          <h2>风险看板</h2>
          <span>集中查看影响审批、签名和归档的待处理事项</span>
        </div>
        <div className="actions">
          <span className="risk-count risk-count--error">{errorCount} 异常</span>
          <span className="risk-count risk-count--warning">{warningCount} 提醒</span>
          <button type="button" className="secondary-button" onClick={props.onRefresh}>
            刷新
          </button>
        </div>
      </div>
      {normalized.length === 0 ? (
        <div className="empty compact-empty">{riskDashboardEmptyText}</div>
      ) : (
        <div className="risk-list">
          {normalized.map((risk) => (
            <div key={risk.key} className={`risk-row risk-row--${risk.level}`}>
              <div>
                <strong>{risk.title}</strong>
                <span>{risk.message}</span>
              </div>
              <div className="risk-row__meta">
                <span>{risk.levelLabel}</span>
                {risk.countLabel && <span>{risk.countLabel}</span>}
                {risk.href && <a href={risk.href}>{risk.actionLabel}</a>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export const riskDashboardEmptyText = "暂无需要处理的风险";

export function normalizeSystemRisks(risks: SystemRisk[]) {
  return risks.map((risk) => ({
    ...risk,
    levelLabel: riskLevelLabel(risk.level),
    countLabel: typeof risk.count === "number" ? `${risk.count} 项` : null,
    actionLabel: risk.href ? "去处理" : ""
  }));
}

export function riskLevelLabel(level: SystemRisk["level"]) {
  return {
    ok: "正常",
    warning: "提醒",
    error: "异常"
  }[level];
}

function BatchSubmissionHistoryPanel(props: { batches: BatchSubmission[]; onRefresh: () => void }) {
  const normalized = normalizeBatchSubmissions(props.batches);
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h2>批量提交记录</h2>
          <span>追踪网页批量上传的逐项成功、失败和签名框来源</span>
        </div>
        <button type="button" className="secondary-button" onClick={props.onRefresh}>
          刷新
        </button>
      </div>
      {normalized.length === 0 ? (
        <div className="empty compact-empty">暂无批量提交记录</div>
      ) : (
        <div className="batch-history-list">
          {normalized.slice(0, 8).map((batch) => (
            <div key={batch.id} className={`batch-history-row batch-history-row--${batch.status}`}>
              <div className="batch-history-row__main">
                <div>
                  <strong>{batch.projectName}</strong>
                  <span>#{batch.id} · {batch.statusLabel} · {formatTime(batch.createdAt)}</span>
                </div>
                <span>{batch.resultText}</span>
              </div>
              <div className="batch-history-row__items">
                {batch.itemSummary.map((item) => (
                  <span key={item} title={item}>{item}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function normalizeBatchSubmissions(batches: BatchSubmission[]) {
  return batches.map((batch) => ({
    ...batch,
    statusLabel: batchSubmissionStatusLabel(batch.status),
    resultText: `成功 ${batch.successCount} / 失败 ${batch.failedCount} / 总计 ${batch.totalCount}`,
    itemSummary: batch.items.slice(0, 6).map((item) =>
      [item.fileName, batchSubmissionItemStatusLabel(item.status), placementStateLabel(item.placementState), item.errorMessage]
        .filter(Boolean)
        .join(" · ")
    )
  }));
}

export function batchSubmissionStatusLabel(status: BatchSubmission["status"]) {
  return {
    running: "处理中",
    completed: "已完成",
    partial: "部分成功",
    failed: "失败"
  }[status];
}

export function batchSubmissionItemStatusLabel(status: BatchSubmission["items"][number]["status"]) {
  return {
    pending: "待处理",
    completed: "已完成",
    failed: "失败"
  }[status];
}

export function placementStateLabel(state: BatchSubmission["items"][number]["placementState"]) {
  if (!state) return "";
  return {
    template: "模板",
    manual: "手动",
    missing: "缺失"
  }[state];
}

function MaintenancePanel(props: {
  settings: MaintenanceSettings;
  saving: boolean;
  validationPath: string;
  validationResult: BackupValidationResult | null;
  validating: boolean;
  onChange: (settings: MaintenanceSettings) => void;
  onValidationPathChange: (path: string) => void;
  onSave: () => void;
  onValidate: () => void;
}) {
  const updateSchedule = (key: keyof MaintenanceSettings, patch: Partial<MaintenanceSettings[keyof MaintenanceSettings]>) => {
    props.onChange({
      ...props.settings,
      [key]: { ...props.settings[key], ...patch }
    });
  };

  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h2>自动维护</h2>
          <span>按服务端时间自动执行数据库备份和清理维护</span>
        </div>
        <button type="button" onClick={props.onSave} disabled={props.saving}>
          {props.saving ? "保存中" : "保存计划"}
        </button>
      </div>
      <div className="report-filter-grid">
        <label className="inline-check">
          <input type="checkbox" checked={props.settings.autoBackup.enabled} onChange={(event) => updateSchedule("autoBackup", { enabled: event.target.checked })} />
          自动备份
        </label>
        <label>
          备份时间
          <input type="time" value={props.settings.autoBackup.time} onChange={(event) => updateSchedule("autoBackup", { time: event.target.value })} />
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={props.settings.autoCleanup.enabled} onChange={(event) => updateSchedule("autoCleanup", { enabled: event.target.checked })} />
          自动清理
        </label>
        <label>
          清理时间
          <input type="time" value={props.settings.autoCleanup.time} onChange={(event) => updateSchedule("autoCleanup", { time: event.target.value })} />
        </label>
      </div>
      <div className="backup-validation-row">
        <label>
          校验备份目录
          <input
            value={props.validationPath}
            onChange={(event) => props.onValidationPathChange(event.target.value)}
            placeholder="例如 D:\\PDF审批\\backups\\pdf-approval-20260623-010000"
          />
        </label>
        <button type="button" className="secondary-button" onClick={props.onValidate} disabled={props.validating}>
          {props.validating ? "校验中" : "校验备份目录"}
        </button>
      </div>
      {props.validationResult && (
        <div className={props.validationResult.ok ? "notice" : "error-box"}>
          {props.validationResult.message}
          {props.validationResult.files.length > 0 && <small>包含文件：{props.validationResult.files.join("、")}</small>}
        </div>
      )}
    </section>
  );
}

function MaintenanceRunSummaryPanel(props: { logs: OperationLog[] }) {
  const items = buildMaintenanceRunSummary(props.logs);
  return (
    <section className="management-panel maintenance-run-summary-panel">
      <div className="panel-heading">
        <div>
          <h2>维护执行结果</h2>
          <span>查看自动备份、自动清理和备份校验的最近一次结果</span>
        </div>
      </div>
      <div className="maintenance-run-summary-grid">
        {items.map((item) => (
          <div key={item.key} className={`maintenance-run-card maintenance-run-card--${item.tone}`}>
            <div>
              <span>{item.label}</span>
              <strong>{item.tone === "ok" ? "正常" : "需检查"}</strong>
            </div>
            <p title={item.message}>{item.message}</p>
            <small>{item.timeLabel}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function OperationLogPanel(props: { logs: OperationLog[]; onRefresh: () => void }) {
  const columns: readonly DataTableColumn<OperationLog>[] = [
    { id: "time", header: "时间", cell: (log) => <time className={styles.time}>{new Date(log.createdAt).toLocaleString()}</time> },
    { id: "actor", header: "人员", cell: (log) => log.actorUsername ?? "system" },
    { id: "action", header: "动作", cell: (log) => operationActionLabel(log.action) },
    { id: "target", header: "对象", mobileHidden: true, cell: (log) => <span className={styles.target}>{log.targetType}{log.targetId ? ` #${log.targetId}` : ""}</span> },
    { id: "message", header: "说明", cell: (log) => <span className={styles.message}>{log.message}</span> }
  ];
  return <TableFrame title="操作日志" description="最近 100 条，更多记录保留在数据库中"
    actions={<Button variant="secondary" onClick={props.onRefresh}>刷新操作日志</Button>}>
    <DataTable ariaLabel="操作日志" columns={columns} rows={props.logs} getRowKey={(log) => log.id}
      emptyTitle="暂无操作日志" stickyHeader />
  </TableFrame>;
}

export function buildMaintenanceRunSummary(logs: OperationLog[]): MaintenanceRunSummaryItem[] {
  const autoBackup = findLatestMaintenanceLog(logs, ["system.backup_completed", "system.backup_failed"], true);
  const autoCleanup = findLatestMaintenanceLog(logs, ["system.cleanup_executed", "system.cleanup_failed"], true);
  const backupValidation = findLatestMaintenanceLog(logs, ["system.backup_validated"], false);

  return [
    summarizeMaintenanceLog("autoBackup", "自动备份", autoBackup, "暂无自动备份记录"),
    summarizeMaintenanceLog("autoCleanup", "自动清理", autoCleanup, "暂无自动清理记录"),
    summarizeMaintenanceLog("backupValidation", "备份校验", backupValidation, "暂无备份校验记录")
  ];
}

function summarizeMaintenanceLog(
  key: MaintenanceRunSummaryItem["key"],
  label: string,
  log: OperationLog | null,
  emptyMessage: string
): MaintenanceRunSummaryItem {
  if (!log) {
    return {
      key,
      label,
      tone: "warn",
      message: emptyMessage,
      timeLabel: "暂无记录"
    };
  }

  const validationResult = key === "backupValidation" ? readBackupValidationResult(log.metadata) : null;
  const failed = log.action.endsWith("_failed") || validationResult?.ok === false;
  return {
    key,
    label,
    tone: failed ? "warn" : "ok",
    message: validationResult?.message ?? log.message,
    timeLabel: formatTime(log.createdAt)
  };
}

function findLatestMaintenanceLog(logs: OperationLog[], actions: string[], systemOnly: boolean) {
  return (
    logs
      .filter((log) => actions.includes(log.action))
      .filter((log) => !systemOnly || log.actorUsername === "system")
      .sort((a, b) => maintenanceLogTime(b) - maintenanceLogTime(a) || b.id - a.id)[0] ?? null
  );
}

function maintenanceLogTime(log: OperationLog) {
  const time = Date.parse(log.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function readBackupValidationResult(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return null;
  const result = (metadata as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const ok = (result as { ok?: unknown }).ok;
  const message = (result as { message?: unknown }).message;
  return {
    ok: typeof ok === "boolean" ? ok : undefined,
    message: typeof message === "string" && message.trim() ? message : undefined
  };
}

function CleanupPanel(props: { result: CleanupResult | null; busy: CleanupBusy; onPreview: () => void; onExecute: () => void }) {
  const result = props.result;
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h2>清理维护</h2>
          <span>清理临时上传、旧失败批量提交和未引用的旧签审 PDF</span>
        </div>
        <div className="actions">
          <button type="button" className="secondary-button" onClick={props.onPreview} disabled={Boolean(props.busy)}>
            {props.busy === "preview" ? "预览中" : "预览清理项"}
          </button>
          <button type="button" className="danger" onClick={props.onExecute} disabled={Boolean(props.busy)}>
            {props.busy === "execute" ? "清理中" : "执行清理"}
          </button>
        </div>
      </div>
      <div className="cleanup-summary-grid">
        <DiagnosticItem label="临时上传" value={`${result?.tempUploads.count ?? 0} 项`} ok={(result?.tempUploads.count ?? 0) === 0} />
        <DiagnosticItem label="失败批量提交" value={`${result?.failedBatchSubmissions.count ?? 0} 项`} ok={(result?.failedBatchSubmissions.count ?? 0) === 0} />
        <DiagnosticItem label="旧签审 PDF" value={`${result?.oldSignedPdfs.count ?? 0} 个`} ok={(result?.oldSignedPdfs.count ?? 0) === 0} />
        <DiagnosticItem label="模式" value={result?.executed ? "已执行" : "仅预览"} ok={!result?.executed} />
      </div>
      {result?.oldSignedPdfs.files.length ? (
        <div className="cleanup-file-list">
          {result.oldSignedPdfs.files.slice(0, 5).map((filePath) => (
            <span key={filePath} title={filePath}>{filePath}</span>
          ))}
          {result.oldSignedPdfs.files.length > 5 && <span>还有 {result.oldSignedPdfs.files.length - 5} 个文件未显示</span>}
        </div>
      ) : (
        <div className="empty compact-empty">点击“预览清理项”查看可清理内容。</div>
      )}
    </section>
  );
}

function DiagnosticsPanel(props: { diagnostics: SystemDiagnostics | null; onRefresh: () => void }) {
  const diagnostics = props.diagnostics;
  const normalized = diagnostics ? normalizeDiagnostics(diagnostics) : null;
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h2>系统健康诊断</h2>
          <span>数据库、监听目录、标准目录和写入权限</span>
        </div>
        <div className="actions">
          {diagnostics && <span className={`health-badge health-badge--${diagnostics.overallStatus}`}>{diagnostics.overallStatus === "ok" ? "运行正常" : "需要检查"}</span>}
          <button type="button" className="secondary-button" onClick={props.onRefresh}>
            刷新
          </button>
        </div>
      </div>
      {!diagnostics ? (
        <div className="empty compact-empty">正在读取诊断信息</div>
      ) : (
        <>
          <div className="diagnostic-grid">
            <DiagnosticItem label="数据库" value={diagnostics.database.ok ? "可读写" : diagnostics.database.error ?? "异常"} ok={diagnostics.database.ok} />
            <DiagnosticItem label="监听根目录" value={diagnostics.watchRoot.path ?? "未配置"} ok={diagnostics.watchRoot.configured && diagnostics.watchRoot.exists} />
            <DiagnosticItem
              label="标准目录"
              value={`${diagnostics.standardFolders.filter((folder) => folder.exists).length}/${diagnostics.standardFolders.length}`}
              ok={diagnostics.standardFolders.every((folder) => folder.exists)}
            />
            <DiagnosticItem
              label="写入权限"
              value={`${diagnostics.writePermissions.filter((item) => item.writable).length}/${diagnostics.writePermissions.length}`}
              ok={diagnostics.writePermissions.length > 0 && diagnostics.writePermissions.every((item) => item.writable)}
            />
            <DiagnosticItem
              label="服务启动"
              value={normalized?.service.startedAt === "未知" ? "未知" : formatTime(normalized?.service.startedAt ?? "")}
              ok={Boolean(normalized?.service.startedAt && normalized.service.startedAt !== "未知")}
            />
            <DiagnosticItem
              label="服务日志"
              value={`${normalized?.logs.filter((log) => log.readable).length ?? 0}/${normalized?.logs.length ?? 0}`}
              ok={Boolean(normalized?.logs.length && normalized.logs.every((log) => log.readable))}
            />
          </div>
          <div className="folder-checklist">
            {diagnostics.standardFolders.map((folder) => (
              <span key={folder.name} className={folder.exists ? "folder-ok" : "folder-missing"} title={folder.path ?? ""}>
                {folder.exists ? "已存在" : "缺失"} · {folder.name}
              </span>
            ))}
          </div>
          <div className="ops-meta-row">
            <span>最近扫描：{diagnostics.latestScan ? `${statusLabel(diagnostics.latestScan.status)} · ${formatTime(diagnostics.latestScan.startedAt)}` : "暂无"}</span>
            <span>最近备份：{diagnostics.latestBackup ? `${statusLabel(diagnostics.latestBackup.status)} · ${formatTime(diagnostics.latestBackup.startedAt)}` : "暂无"}</span>
          </div>
        </>
      )}
    </section>
  );
}

export function normalizeDiagnostics(diagnostics: SystemDiagnostics) {
  return {
    ...diagnostics,
    logs: diagnostics.logs ?? [],
    service: diagnostics.service ?? { startedAt: "未知", uptimeSeconds: 0 }
  };
}

function DiagnosticItem(props: { label: string; value: string; ok: boolean }) {
  return (
    <div className={props.ok ? "diagnostic-item diagnostic-item--ok" : "diagnostic-item diagnostic-item--warn"}>
      <span>{props.label}</span>
      <strong title={props.value}>{props.value}</strong>
    </div>
  );
}

function BackupRunList({ runs }: { runs: BackupRun[] }) {
  if (runs.length === 0) return <div className="empty compact-empty">暂无备份记录</div>;
  return (
    <div className="backup-run-list">
      {runs.slice(0, 6).map((run) => (
        <div key={run.id} className="backup-run-row">
          <div>
            <strong>{statusLabel(run.status)}</strong>
            <span>{formatTime(run.startedAt)} · {run.triggeredBy}</span>
          </div>
          <small title={run.backupPath ?? run.errorMessage ?? ""}>{run.backupPath ?? run.errorMessage ?? "处理中"}</small>
        </div>
      ))}
    </div>
  );
}

function SignatureStatusPanel(props: { statuses: UserSignatureStatus[]; onRefresh: () => void }) {
  const required = props.statuses.filter((user) => ["designer", "supervisor", "process"].includes(user.role));
  const configured = required.filter((user) => user.hasSignature).length;
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h2>签名配置</h2>
          <span>设计、主管、工艺签名素材就绪状态</span>
        </div>
        <button type="button" className="secondary-button" onClick={props.onRefresh}>
          刷新
        </button>
      </div>
      <div className="signature-status-summary">
        <strong>{configured}/{required.length}</strong>
        <span>关键签名已配置</span>
      </div>
      <div className="signature-status-list">
        {required.map((user) => (
          <div key={user.userId} className={user.hasSignature ? "signature-status-row signature-status-row--ok" : "signature-status-row signature-status-row--warn"}>
            <div>
              <strong>{user.displayName}</strong>
              <span>{statusLabel(user.role)} · {user.username}</span>
            </div>
            <span>{user.hasSignature ? "已配置" : "未配置"}</span>
          </div>
        ))}
        {required.length === 0 && <div className="empty compact-empty">暂无关键角色用户</div>}
      </div>
    </section>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString();
}

function operationActionLabel(action: string) {
  return (
    {
      "approval.created": "创建审批",
      "approval.reviewed": "提交审核",
      "approval.approved_for_print": "进入待打印",
      "approval.printed": "打印归档",
      "approval.file_missing": "文件丢失",
      "approval.file_rebound": "重新绑定",
      "approval.validation_retried": "重新校验",
      "approval.validation_failed": "校验失败",
      "approval.voided": "作废审批",
      "approval.comment_created": "新增评论",
      "approval.issue_created": "新增问题",
      "approval.issue_resolved": "解决问题",
      "approval.annotation_created": "新增图纸批注",
      "approval.annotation_updated": "更新图纸批注",
      "approval.annotation_resolved": "处理图纸批注",
      "approval.annotations_reset": "回退批注",
      "approval.annotated_pdf_opened": "打开审查版 PDF",
      "signature.template_created_from_approval": "保存签名模板",
      "pdm.backfill_requested": "触发 PDM 回填",
      "pdm.backfill_prepared": "准备 PDM 回填",
      "pdm.backfill_skipped": "跳过 PDM 回填",
      "pdm.metadata_pending": "PDM 待补录",
      "pdm.metadata_repaired": "PDM 补录信息",
      "pdm.revision_published": "发布 PDM 版本",
      "pdm.publish_failed": "PDM 发布失败",
      "settings.smtp_test_sent": "SMTP 测试成功",
      "settings.smtp_test_failed": "SMTP 测试失败",
      "system.scan_completed": "扫描完成",
      "system.scan_failed": "扫描失败",
      "system.backup_completed": "备份完成",
      "system.backup_failed": "备份失败",
      "system.backup_validated": "校验备份",
      "system.maintenance_updated": "更新维护计划",
      "system.cleanup_failed": "清理失败",
      "system.cleanup_executed": "执行清理",
      "system.cleanup_previewed": "预览清理",
      "system.restart_requested": "请求重启",
      "user.created": "新增用户",
      "user.updated": "更新用户",
      "user.password_reset": "重置密码",
      "user.profile_updated": "更新个人资料",
      "user.profile_test_email_sent": "个人测试邮件成功",
      "user.profile_test_email_failed": "个人测试邮件失败"
    }[action] ?? action
  );
}
