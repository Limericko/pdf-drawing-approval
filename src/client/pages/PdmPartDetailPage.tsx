import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  getPdmPart,
  type PdmDrawingRevision,
  type PdmPartDetail,
  type PdmRevisionStatus
} from "../api.ts";

export function PdmPartDetailPage({ id }: { id: number }) {
  const [detail, setDetail] = useState<PdmPartDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
  }, [id]);

  if (loading && !detail) {
    return <div className="empty compact-empty">正在打开零件详情...</div>;
  }

  if (error) {
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

  const { part, currentRevision, revisions, usages } = detail;
  const overviewFacts = pdmDetailOverviewFacts(detail);

  return (
    <section className="pdm-detail-page">
      <header className="pdm-record-hero">
        <div>
          <a className="table-action-link" href="#/pdm">
            <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
            返回零件库
          </a>
          <span className="eyebrow">零件主档案</span>
          <h1>{part.name}</h1>
          <p>{pdmRevisionSummary(detail)}</p>
        </div>
        <div className="pdm-record-code">
          <span>管家婆物料号</span>
          <strong>{part.materialCode}</strong>
          <em>全局唯一零件主键</em>
        </div>
      </header>

      <div className="pdm-detail-rail" aria-label="PDM 零件主档案">
        {overviewFacts.map((fact) => (
          <div key={fact.label}>
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
          </div>
        ))}
      </div>

      <div className="pdm-detail-grid">
        <section className="pdm-panel pdm-current-panel">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">当前版本</span>
              <h2>当前有效版本</h2>
            </div>
            {currentRevision && (
              <a className="table-action-link" href={`#/approvals/${currentRevision.approvalId}`}>
                <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                {pdmTraceabilityLabel(currentRevision.approvalId)}
              </a>
            )}
          </div>
          {currentRevision ? (
            <RevisionFacts revision={currentRevision} />
          ) : (
            <div className="empty compact-empty">该零件还没有发布到 PDM 的当前版本。</div>
          )}
        </section>

        <aside className="pdm-panel pdm-usage-panel">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">项目复用</span>
              <h2>使用项目</h2>
            </div>
            <span className="muted-inline">{usages.length} 个项目</span>
          </div>
          {usages.length > 0 ? (
            <div className="pdm-usage-list">
              {usages.map((usage) => (
                <div key={usage.id}>
                  <strong>{usage.projectName}</strong>
                  <span>首次审批 #{usage.firstApprovalId}，最近审批 #{usage.lastApprovalId}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty compact-empty">暂无项目使用记录。</div>
          )}
        </aside>
      </div>

      <section className="pdm-panel pdm-history-panel">
        <div className="section-title-row">
          <div>
            <span className="eyebrow">版本关系</span>
            <h2>历史版本</h2>
          </div>
          <span className="muted-inline">共 {revisions.length} 个版本</span>
        </div>
        {revisions.length > 0 ? (
          <div className="table-surface pdm-table-surface">
            <table className="data-table pdm-table pdm-history-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>体系文件号</th>
                  <th>图纸名称</th>
                  <th>状态</th>
                  <th>发布时间</th>
                  <th>审批记录</th>
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
                    <td data-label="审批记录">
                      <a className="table-action-link" href={`#/approvals/${revision.approvalId}`}>
                        {pdmTraceabilityLabel(revision.approvalId)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty compact-empty">暂无历史版本。</div>
        )}
      </section>
    </section>
  );
}

function RevisionFacts({ revision }: { revision: PdmDrawingRevision }) {
  return (
    <dl className="compact-dl pdm-revision-facts">
      <div>
        <dt>版本</dt>
        <dd>{revision.version}</dd>
      </div>
      <div>
        <dt>体系文件号</dt>
        <dd>{revision.documentCode ?? "待补"}</dd>
      </div>
      <div>
        <dt>发布状态</dt>
        <dd>{pdmRevisionStatusLabel(revision.releaseStatus)}</dd>
      </div>
      <div>
        <dt>发布时间</dt>
        <dd>{formatDateTime(revision.releasedAt)}</dd>
      </div>
      <div>
        <dt>原始文件哈希</dt>
        <dd>{revision.originalFileHash ?? "未记录"}</dd>
      </div>
      <div>
        <dt>签后文件哈希</dt>
        <dd>{revision.signedFileHash ?? "未记录"}</dd>
      </div>
    </dl>
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
