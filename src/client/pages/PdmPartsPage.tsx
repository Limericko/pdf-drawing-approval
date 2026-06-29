import { useDeferredValue, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, Search } from "lucide-react";
import {
  listPdmParts,
  listPendingPdmMetadata,
  type PdmMetadataStatus,
  type PdmPartListItem,
  type PdmPendingMetadataApproval,
  type User
} from "../api.ts";

const pdmPageSize = 20;

export function PdmPartsPage({ user }: { user: User }) {
  const [items, setItems] = useState<PdmPartListItem[]>([]);
  const [pendingMetadata, setPendingMetadata] = useState<PdmPendingMetadataApproval[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [committedKeyword, setCommittedKeyword] = useState("");
  const [projectName, setProjectName] = useState("");
  const [isCommon, setIsCommon] = useState("");
  const [hasCurrentRevision, setHasCurrentRevision] = useState("");
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingError, setPendingError] = useState("");
  const deferredKeywordDraft = useDeferredValue(keywordDraft);
  const normalizedDraftKeyword = keywordDraft.trim();
  const keywordPending = normalizedDraftKeyword !== committedKeyword;
  const canSeePendingMetadata = user.role === "admin" || user.role === "designer";
  const hasActiveFilters = Boolean(committedKeyword || normalizedDraftKeyword || projectName.trim() || isCommon || hasCurrentRevision);
  const pageCount = Math.max(1, Math.ceil(total / pdmPageSize));

  useEffect(() => {
    const nextKeyword = deferredKeywordDraft.trim();
    const timer = window.setTimeout(() => {
      setCommittedKeyword((current) => {
        if (current === nextKeyword) return current;
        setPage(1);
        return nextKeyword;
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [deferredKeywordDraft]);

  useEffect(() => {
    setPage(1);
  }, [hasCurrentRevision, isCommon, projectName]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listPdmParts({
      page,
      pageSize: pdmPageSize,
      keyword: committedKeyword || undefined,
      projectName: projectName.trim() || undefined,
      isCommon: booleanFilterValue(isCommon),
      hasCurrentRevision: booleanFilterValue(hasCurrentRevision)
    })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "PDM_PART_LIST_FAILED");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [committedKeyword, hasCurrentRevision, isCommon, page, projectName, refreshSeq]);

  useEffect(() => {
    if (!canSeePendingMetadata) {
      setPendingMetadata([]);
      setPendingError("");
      return;
    }
    let active = true;
    setPendingError("");
    listPendingPdmMetadata()
      .then((result) => {
        if (active) setPendingMetadata(result.items);
      })
      .catch((err) => {
        if (active) setPendingError(err instanceof Error ? err.message : "PDM_PENDING_METADATA_FAILED");
      });
    return () => {
      active = false;
    };
  }, [canSeePendingMetadata]);

  function clearFilters() {
    setKeywordDraft("");
    setCommittedKeyword("");
    setProjectName("");
    setIsCommon("");
    setHasCurrentRevision("");
    setPage(1);
  }

  return (
    <section className="pdm-page">
      <div className="page-heading row">
        <div>
          <span className="eyebrow">PDM LIBRARY</span>
          <h1>零件库</h1>
          <p>{pdmLibraryDescription(user.role)}</p>
        </div>
        <div className="toolbar pdm-filter-toolbar">
          <label>
            关键词
            <span className="input-with-icon">
              <Search size={16} strokeWidth={2} aria-hidden="true" />
              <input
                value={keywordDraft}
                onChange={(event) => setKeywordDraft(event.target.value)}
                placeholder="物料号、图纸名称、体系文件号"
              />
            </span>
          </label>
          <label>
            项目
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="按使用项目筛选" />
          </label>
          <label>
            发布状态
            <select value={hasCurrentRevision} onChange={(event) => setHasCurrentRevision(event.target.value)}>
              <option value="">全部</option>
              <option value="true">有当前版本</option>
              <option value="false">待发布</option>
            </select>
          </label>
          <label>
            共用件
            <select value={isCommon} onChange={(event) => setIsCommon(event.target.value)}>
              <option value="">全部</option>
              <option value="true">只看共用件</option>
              <option value="false">非共用件</option>
            </select>
          </label>
          {hasActiveFilters && (
            <button type="button" className="secondary-button clear-filter-button" onClick={clearFilters}>
              清空筛选
            </button>
          )}
        </div>
      </div>

      <div className="table-filter-summary">
        <span>当前页 {items.length} 个 / 共 {total} 个零件</span>
        <span>第 {page} / {pageCount} 页</span>
        {normalizedDraftKeyword && <span>关键词：{normalizedDraftKeyword}</span>}
        {projectName.trim() && <span>项目：{projectName.trim()}</span>}
        {keywordPending && <span className="muted-inline">输入完成后自动刷新</span>}
      </div>

      {canSeePendingMetadata && (
        <section className="pdm-pending-strip" aria-label="PDM 待补录">
          <div>
            <span className="eyebrow">PDM 待补录</span>
            <h2>PDM 待补录</h2>
            <p>缺少物料号、体系文件号或发布失败的图纸，补录后才能进入正式零件库。</p>
          </div>
          <div className="pdm-pending-list">
            {pendingMetadata.slice(0, 4).map((item) => (
              <a key={item.approvalId} className="pdm-pending-item" href={`#/approvals/${item.approvalId}`}>
                <span>{item.projectName} / {item.drawingName ?? item.partName} {item.version}</span>
                <strong>{pdmMetadataStatusLabel(item.metadataStatus)}</strong>
              </a>
            ))}
            {pendingMetadata.length === 0 && <span className="muted-inline">暂无待补录记录</span>}
            {pendingMetadata.length > 4 && <span className="muted-inline">还有 {pendingMetadata.length - 4} 条，请在详情页处理</span>}
          </div>
        </section>
      )}

      {pendingError && <div className="error">PDM 待补录读取失败：{pendingError}</div>}
      {error && <div className="error">{error}</div>}
      {loading && <div className="empty compact-empty">{keywordPending ? "正在等待输入完成..." : "正在刷新零件库..."}</div>}

      {items.length > 0 ? (
        <div className="table-surface pdm-table-surface">
          <table className="data-table pdm-table">
            <thead>
              <tr>
                <th>管家婆物料号</th>
                <th>图纸名称</th>
                <th>当前有效版本</th>
                <th>体系文件号</th>
                <th>使用项目</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="管家婆物料号">
                    <a className="table-action-link pdm-material-link" href={`#/pdm/parts/${item.id}`}>
                      {item.materialCode}
                    </a>
                  </td>
                  <td data-label="图纸名称">{item.name}</td>
                  <td data-label="当前有效版本">
                    {item.currentVersion ? <span className="version-badge">{item.currentVersion}</span> : <span className="muted-inline">待发布</span>}
                  </td>
                  <td data-label="体系文件号">{item.currentDocumentCode ?? <span className="muted-inline">待补</span>}</td>
                  <td data-label="使用项目">{pdmUsageProjectsText(item)}</td>
                  <td data-label="状态">
                    <span className={`status-chip status-chip--${pdmPartStatusTone(item)}`}>{pdmPartStatusLabel(item)}</span>
                  </td>
                  <td data-label="操作" className="row-actions">
                    <a className="table-action-link" href={`#/pdm/parts/${item.id}`}>
                      <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                      详情
                    </a>
                    {item.currentApprovalId && (
                      <a className="table-action-link" href={`#/approvals/${item.currentApprovalId}`}>
                        审批记录
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !loading && (
          <div className="empty-state">
            <AlertTriangle size={24} strokeWidth={2} aria-hidden="true" />
            <strong>{pdmLibraryEmptyText(hasActiveFilters)}</strong>
          </div>
        )
      )}

      <div className="pagination-bar">
        <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loading}>
          上一页
        </button>
        <span>第 {page} / {pageCount} 页</span>
        <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || loading}>
          下一页
        </button>
        <button type="button" className="secondary-button icon-text-button" onClick={() => setRefreshSeq((current) => current + 1)} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
          刷新
        </button>
      </div>
    </section>
  );
}

export function pdmLibraryDescription(role: User["role"]) {
  if (role === "designer") return "查询受控图纸版本，补齐自己提交图纸的 PDM 信息。";
  if (role === "supervisor") return "查询当前有效版本、历史版本和共用项目，辅助审核判断。";
  if (role === "process") return "查询当前有效版本、历史版本和共用项目，辅助工艺审查。";
  return "维护 PDM 待补录和发布异常，追溯零件图纸版本。";
}

export function pdmLibraryEmptyText(hasActiveFilters: boolean) {
  return hasActiveFilters
    ? "没有匹配的零件档案，请调整关键词或筛选条件。"
    : "暂无 PDM 零件档案。审批通过并发布后会自动进入这里。";
}

export function pdmUsageProjectsText(item: Pick<PdmPartListItem, "usageProjectCount" | "usageProjects">) {
  if (item.usageProjects.length === 0) return "未记录";
  const text = item.usageProjects.join("、");
  return item.usageProjectCount > item.usageProjects.length ? `${text} 等 ${item.usageProjectCount} 个项目` : text;
}

export function pdmPartStatusLabel(item: Pick<PdmPartListItem, "isCommon" | "currentRevisionId" | "currentVersion">) {
  if (item.isCommon) return "共用件";
  if (!item.currentRevisionId || !item.currentVersion) return "待发布";
  return "当前有效";
}

export function pdmPartStatusTone(item: Pick<PdmPartListItem, "isCommon" | "currentRevisionId" | "currentVersion">) {
  if (item.isCommon) return "approved";
  if (!item.currentRevisionId || !item.currentVersion) return "pending";
  return "print";
}

export function pdmMetadataStatusLabel(status: PdmMetadataStatus) {
  return {
    complete: "完整",
    missing_material_code: "待补物料号",
    missing_document_code: "体系文件号待补",
    missing_required: "关键信息待补"
  }[status];
}

function booleanFilterValue(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
