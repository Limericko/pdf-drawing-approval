import { useEffect, useState } from "react";
import { ArrowLeft, Ban, Download, ExternalLink, FileCheck2, FileText, History } from "lucide-react";
import {
  getAnnotatedFileUrl,
  getApprovalFileUrl,
  getPdmPart,
  getSignedFileUrl,
  voidPdmRevision,
  type OperationLog,
  type PdmDrawingRevision,
  type PdmPartDetail,
  type PdmPartUsage,
  type PdmRevisionStatus,
  type User
} from "../api.ts";

type PdmDetailTab = "history" | "projects" | "approvals" | "hashes" | "trace";

export function PdmPartDetailPage({ id, user }: { id: number; user?: Pick<User, "role"> }) {
  const [detail, setDetail] = useState<PdmPartDetail | null>(null);
  const [activeTab, setActiveTab] = useState<PdmDetailTab>("history");
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [voidReasonByRevisionId, setVoidReasonByRevisionId] = useState<Record<number, string>>({});
  const [busyRevisionId, setBusyRevisionId] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    getPdmPart(id)
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "PDM_PART_DETAIL_FAILED");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, refreshSeq]);

  async function handleVoidRevision(revision: PdmDrawingRevision) {
    const reason = (voidReasonByRevisionId[revision.id] ?? "").trim();
    if (!reason) {
      setError("请先填写版本作废原因。");
      return;
    }
    const confirmed = window.confirm(`确认作废 ${revision.drawingName} / ${revision.version}？作废后会重新计算当前有效版本。`);
    if (!confirmed) return;

    setError("");
    setMessage("");
    setBusyRevisionId(revision.id);
    try {
      await voidPdmRevision(revision.id, reason);
      setMessage("PDM 图纸版本已作废，当前有效版本已重新计算。");
      setVoidReasonByRevisionId((current) => ({ ...current, [revision.id]: "" }));
      setRefreshSeq((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDM_REVISION_VOID_FAILED");
    } finally {
      setBusyRevisionId(null);
    }
  }

  if (loading && !detail) {
    return <div className="empty compact-empty">正在打开零件详情...</div>;
  }

  if (error && !detail) {
    return (
      <section>
        <a className="table-action-link" href="#/pdm">
          <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
          返回零件库
        </a>
        <div className="error">零件详情读取失败：{error}</div>
      </section>
    );
  }

  if (!detail) {
    return <div className="empty compact-empty">未找到零件档案</div>;
  }

  const { part, currentRevision, revisions, usages, traceLogs } = detail;
  const overviewFacts = pdmDetailOverviewFacts(detail);
  const relationTabs = buildPdmRelationTabs(revisions.length, usages.length, traceLogs.length);
  const canVoidRevision = user?.role === "admin";

  return (
    <section className="pdm-detail-page pdm-detail-shell">
      <header className="pdm-detail-nav">
        <a className="table-action-link" href="#/pdm">
          <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
          返回零件库
        </a>
      </header>

      <section className="pdm-master-card" aria-label="PDM 零件主档案">
        <div className="pdm-master-card__body">
          <div>
            <span className="eyebrow">零件主档案</span>
            <h1>{part.name}</h1>
            <p>{pdmRevisionSummary(detail)}</p>
          </div>
          <div className="pdm-master-facts">
            {overviewFacts.map((fact) => (
              <div key={fact.label}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </div>
        </div>
        <aside className="pdm-current-version-pin" aria-label="当前有效版本">
          <span>当前有效版本</span>
          {currentRevision ? (
            <>
              <strong>{currentRevision.version}</strong>
              <em>{currentRevision.documentCode ?? "体系文件号待补"}</em>
              <a className="table-action-link" href={`#/approvals/${currentRevision.approvalId}`}>
                <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                {pdmTraceabilityLabel(currentRevision.approvalId)}
              </a>
              <RevisionFileActions revision={currentRevision} compact />
            </>
          ) : (
            <>
              <strong>待发布</strong>
              <em>该零件还没有发布到 PDM 的当前版本。</em>
            </>
          )}
        </aside>
      </section>

      {message && <div className="success">{message}</div>}
      {error && <div className="error">PDM 操作失败：{error}</div>}

      <section className="pdm-relation-tabs" aria-label="PDM 版本关系">
        <div className="pdm-tab-list" role="tablist" aria-label="零件版本关系">
          {relationTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={activeTab === tab.key ? "active" : ""}
              onClick={() => setActiveTab(tab.key)}
              aria-selected={activeTab === tab.key}
            >
              <span>{tab.label}</span>
              <strong>{tab.count}</strong>
            </button>
          ))}
        </div>

        {activeTab === "history" && (
          <section className="pdm-panel pdm-history-panel">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">版本关系</span>
                <h2>历史版本</h2>
              </div>
              <span className="muted-inline">共 {revisions.length} 个版本</span>
            </div>
            {revisions.length > 0 ? (
              <RevisionHistoryTable
                revisions={revisions}
                canVoid={canVoidRevision}
                busyRevisionId={busyRevisionId}
                voidReasonByRevisionId={voidReasonByRevisionId}
                onVoidReasonChange={(revisionId, reason) =>
                  setVoidReasonByRevisionId((current) => ({ ...current, [revisionId]: reason }))
                }
                onVoidRevision={handleVoidRevision}
              />
            ) : (
              <div className="empty compact-empty">暂无历史版本。</div>
            )}
          </section>
        )}

        {activeTab === "projects" && (
          <section className="pdm-panel pdm-usage-panel">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">项目复用</span>
                <h2>使用项目</h2>
              </div>
              <span className="muted-inline">{usages.length} 个项目</span>
            </div>
            <UsageProjectList usages={usages} />
          </section>
        )}

        {activeTab === "approvals" && (
          <section className="pdm-panel">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">关联审批</span>
                <h2>审批记录</h2>
              </div>
              <span className="muted-inline">按版本发布时间倒序</span>
            </div>
            {revisions.length > 0 ? (
              <div className="pdm-approval-link-list">
                {revisions.map((revision) => (
                  <a key={revision.id} className="pdm-approval-link" href={`#/approvals/${revision.approvalId}`}>
                    <span>
                      <strong>{revision.version}</strong>
                      {revision.drawingName}
                    </span>
                    <em>{pdmTraceabilityLabel(revision.approvalId)}</em>
                  </a>
                ))}
              </div>
            ) : (
              <div className="empty compact-empty">暂无关联审批记录。</div>
            )}
          </section>
        )}

        {activeTab === "hashes" && (
          <section className="pdm-panel">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">文件校验</span>
                <h2>文件哈希</h2>
              </div>
              <span className="muted-inline">用于追溯原始 PDF、签后 PDF 和批注版 PDF。</span>
            </div>
            <RevisionHashGrid revisions={revisions} />
          </section>
        )}

        {activeTab === "trace" && (
          <section className="pdm-panel pdm-trace-panel">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">追溯记录</span>
                <h2>操作时间线</h2>
              </div>
              <span className="muted-inline">来自该零件所有版本的审批与 PDM 操作</span>
            </div>
            <PdmTraceTimeline logs={traceLogs} />
          </section>
        )}
      </section>
    </section>
  );
}

function RevisionHistoryTable({
  revisions,
  canVoid,
  busyRevisionId,
  voidReasonByRevisionId,
  onVoidReasonChange,
  onVoidRevision
}: {
  revisions: PdmDrawingRevision[];
  canVoid: boolean;
  busyRevisionId: number | null;
  voidReasonByRevisionId: Record<number, string>;
  onVoidReasonChange: (revisionId: number, reason: string) => void;
  onVoidRevision: (revision: PdmDrawingRevision) => void;
}) {
  return (
    <div className="table-surface pdm-table-surface">
      <table className="data-table pdm-table pdm-history-table">
        <thead>
          <tr>
            <th>版本</th>
            <th>体系文件号</th>
            <th>图纸名称</th>
            <th>状态</th>
            <th>发布时间</th>
            <th>PDF 文件</th>
            <th>审批记录</th>
            {canVoid && <th>版本维护</th>}
          </tr>
        </thead>
        <tbody>
          {revisions.map((revision) => (
            <tr key={revision.id}>
              <td data-label="版本"><span className="version-badge">{revision.version}</span></td>
              <td data-label="体系文件号">{revision.documentCode ?? <span className="muted-inline">待补</span>}</td>
              <td data-label="图纸名称">{revision.drawingName}</td>
              <td data-label="状态">
                <span className={`status-chip status-chip--${revision.releaseStatus === "released" ? "print" : "archived"}`}>
                  {pdmRevisionStatusLabel(revision.releaseStatus)}
                </span>
              </td>
              <td data-label="发布时间">{formatDateTime(revision.releasedAt)}</td>
              <td data-label="PDF 文件">
                <RevisionFileActions revision={revision} />
              </td>
              <td data-label="审批记录">
                <a className="table-action-link" href={`#/approvals/${revision.approvalId}`}>
                  <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                  {pdmTraceabilityLabel(revision.approvalId)}
                </a>
              </td>
              {canVoid && (
                <td data-label="版本维护">
                  {revision.releaseStatus === "voided" ? (
                    <span className="muted-inline">已作废</span>
                  ) : (
                    <div className="pdm-revision-admin">
                      <input
                        value={voidReasonByRevisionId[revision.id] ?? ""}
                        onChange={(event) => onVoidReasonChange(revision.id, event.target.value)}
                        placeholder="填写作废原因"
                      />
                      <button
                        type="button"
                        className="danger icon-text-button"
                        disabled={busyRevisionId === revision.id}
                        onClick={() => onVoidRevision(revision)}
                      >
                        <Ban size={14} strokeWidth={2} aria-hidden="true" />
                        作废版本
                      </button>
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevisionFileActions({ revision, compact = false }: { revision: PdmDrawingRevision; compact?: boolean }) {
  const annotatedCacheKey = revision.annotatedFilePath ? revision.updatedAt : null;
  return (
    <div className={compact ? "pdm-file-action-list pdm-file-action-list--compact" : "pdm-file-action-list"}>
      <a className="table-action-link" href={getApprovalFileUrl(revision.approvalId)} target="_blank" rel="noreferrer">
        <FileText size={14} strokeWidth={2} aria-hidden="true" />
        原始 PDF
      </a>
      {revision.signedFilePath ? (
        <a className="table-action-link" href={getSignedFileUrl(revision.approvalId, revision.signedFileHash)} target="_blank" rel="noreferrer">
          <FileCheck2 size={14} strokeWidth={2} aria-hidden="true" />
          签后 PDF
        </a>
      ) : (
        <span className="pdm-file-action-disabled">
          <FileCheck2 size={14} strokeWidth={2} aria-hidden="true" />
          签后 PDF
        </span>
      )}
      {revision.annotatedFilePath ? (
        <a className="table-action-link" href={getAnnotatedFileUrl(revision.approvalId, annotatedCacheKey)} target="_blank" rel="noreferrer">
          <Download size={14} strokeWidth={2} aria-hidden="true" />
          审查版 PDF
        </a>
      ) : (
        <span className="pdm-file-action-disabled">
          <Download size={14} strokeWidth={2} aria-hidden="true" />
          审查版 PDF
        </span>
      )}
    </div>
  );
}

function PdmTraceTimeline({ logs }: { logs: OperationLog[] }) {
  if (logs.length === 0) return <div className="empty compact-empty">暂无操作时间线。</div>;
  return (
    <ol className="pdm-trace-list">
      {logs.map((log) => (
        <li key={log.id}>
          <span className="pdm-trace-list__icon" aria-hidden="true">
            <History size={15} strokeWidth={2} />
          </span>
          <div>
            <time>{formatDateTime(log.createdAt)}</time>
            <strong>{operationLogActionLabel(log.action)}</strong>
            <span>{log.message}</span>
            <em>{log.actorUsername ? `操作人：${log.actorUsername}` : "系统记录"}</em>
          </div>
        </li>
      ))}
    </ol>
  );
}

function UsageProjectList({ usages }: { usages: PdmPartUsage[] }) {
  if (usages.length === 0) return <div className="empty compact-empty">暂无项目使用记录。</div>;
  return (
    <div className="pdm-usage-list">
      {usages.map((usage) => (
        <div key={usage.id}>
          <strong>{usage.projectName}</strong>
          <span>首次审批 #{usage.firstApprovalId}，最近审批 #{usage.lastApprovalId}</span>
        </div>
      ))}
    </div>
  );
}

function RevisionHashGrid({ revisions }: { revisions: PdmDrawingRevision[] }) {
  if (revisions.length === 0) return <div className="empty compact-empty">暂无文件哈希记录。</div>;
  return (
    <div className="pdm-hash-grid">
      {revisions.map((revision) => (
        <article key={revision.id} className="pdm-hash-card">
          <header>
            <span className="version-badge">{revision.version}</span>
            <strong>{pdmRevisionStatusLabel(revision.releaseStatus)}</strong>
          </header>
          <dl className="compact-dl pdm-revision-facts">
            <div>
              <dt>原始文件哈希</dt>
              <dd>{revision.originalFileHash ?? "未记录"}</dd>
            </div>
            <div>
              <dt>签后文件哈希</dt>
              <dd>{revision.signedFileHash ?? "未记录"}</dd>
            </div>
            <div>
              <dt>批注版文件</dt>
              <dd>{revision.annotatedFilePath ? "已归档" : "未归档"}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

export function pdmDetailOverviewFacts(detail: PdmPartDetail) {
  return [
    { label: "管家婆物料号", value: detail.part.materialCode },
    { label: "当前有效版本", value: detail.currentRevision?.version ?? "待发布" },
    { label: "体系文件号", value: detail.currentRevision?.documentCode ?? "待补" },
    { label: "共用状态", value: detail.part.isCommon ? "共用件" : "普通零件" },
    { label: "使用项目", value: detail.usages.length > 0 ? detail.usages.map((usage) => usage.projectName).join("、") : "未记录" }
  ];
}

function buildPdmRelationTabs(revisionCount: number, usageCount: number, traceCount: number): Array<{ key: PdmDetailTab; label: string; count: number }> {
  return [
    { key: "history", label: "版本历史", count: revisionCount },
    { key: "projects", label: "使用项目", count: usageCount },
    { key: "approvals", label: "关联审批", count: revisionCount },
    { key: "hashes", label: "文件哈希", count: revisionCount },
    { key: "trace", label: "操作时间线", count: traceCount }
  ];
}

export function pdmRevisionSummary(detail: PdmPartDetail) {
  if (!detail.currentRevision) return "尚未发布当前有效版本";
  return `当前 ${detail.currentRevision.version} / 体系文件号 ${detail.currentRevision.documentCode ?? "待补"}`;
}

export function pdmRevisionStatusLabel(status: PdmRevisionStatus) {
  return {
    released: "当前有效",
    superseded: "历史版本",
    voided: "已作废"
  }[status];
}

export function pdmTraceabilityLabel(approvalId: number) {
  return `查看审批 #${approvalId}`;
}

function formatDateTime(value: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function operationLogActionLabel(action: string) {
  const labels: Record<string, string> = {
    "pdm.revision_voided": "PDM 版本作废",
    "pdm.revision_published": "发布到 PDM",
    "pdm.metadata_repaired": "PDM 信息补录",
    "pdm.published": "发布到 PDM",
    "pdm.backfill_requested": "PDM 历史回填",
    "approval.reviewed": "审核处理",
    "approval.signed": "签后 PDF",
    "approval.printed": "打印归档"
  };
  return labels[action] ?? action;
}
