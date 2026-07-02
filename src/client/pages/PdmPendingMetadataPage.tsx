import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import {
  listPendingPdmMetadata,
  type PdmMetadataStatus,
  type PdmPendingMetadataApproval,
  type PdmPublishStatus
} from "../api.ts";

export function PdmPendingMetadataPage() {
  const [items, setItems] = useState<PdmPendingMetadataApproval[]>([]);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const normalizedKeyword = keyword.trim().toLowerCase();
  const filteredItems = useMemo(
    () => filterPendingMetadataItems(items, { keyword: normalizedKeyword, metadataStatus: status }),
    [items, normalizedKeyword, status]
  );
  const stats = buildPendingMetadataStats(items);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listPendingPdmMetadata()
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "PDM_PENDING_METADATA_FAILED");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshSeq]);

  function clearFilters() {
    setKeyword("");
    setStatus("");
  }

  return (
    <section className="pdm-pending-page">
      <header className="pdm-ledger-heading">
        <div>
          <a className="table-action-link" href="#/pdm">
            <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
            返回零件库
          </a>
          <span className="eyebrow">PDM 待补录</span>
          <h1>PDM 待补录清单</h1>
          <p>集中处理缺少物料号、体系文件号或发布失败的图纸，补齐后再进入正式零件库。</p>
        </div>
        <button type="button" className="secondary-button icon-text-button" onClick={() => setRefreshSeq((current) => current + 1)} disabled={loading}>
          <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
          刷新
        </button>
      </header>

      <section className="pdm-pending-summary" aria-label="PDM 待补录统计">
        <div>
          <span>待处理</span>
          <strong>{stats.total}</strong>
        </div>
        <div>
          <span>待补物料号</span>
          <strong>{stats.missingMaterialCode}</strong>
        </div>
        <div>
          <span>体系文件号待补</span>
          <strong>{stats.missingDocumentCode}</strong>
        </div>
        <div>
          <span>发布失败</span>
          <strong>{stats.publishFailed}</strong>
        </div>
      </section>

      <section className="pdm-filter-section" aria-label="PDM 待补录筛选">
        <label>
          关键词
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="项目、图纸名称、版本、物料号或体系文件号" />
        </label>
        <div className="pdm-filter-grid pdm-filter-grid--pending">
          <label>
            待补类型
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部</option>
              <option value="missing_material_code">待补物料号</option>
              <option value="missing_document_code">体系文件号待补</option>
              <option value="missing_required">关键信息待补</option>
            </select>
          </label>
          <div className="pdm-filter-actions">
            {(keyword.trim() || status) && (
              <button type="button" className="secondary-button clear-filter-button" onClick={clearFilters}>
                清空筛选
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="pdm-ledger-section" aria-label="PDM 待补录明细">
        <div className="table-filter-summary">
          <span>当前显示 {filteredItems.length} 条 / 共 {items.length} 条</span>
          {keyword.trim() && <span>关键词：{keyword.trim()}</span>}
          {status && <span>类型：{pdmMetadataStatusLabel(status as PdmMetadataStatus)}</span>}
        </div>
        {error && <div className="error">PDM 待补录读取失败：{error}</div>}
        {loading && <div className="empty compact-empty">正在刷新 PDM 待补录清单...</div>}
        {filteredItems.length > 0 ? (
          <div className="table-surface pdm-table-surface">
            <table className="data-table pdm-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>图纸名称</th>
                  <th>版本</th>
                  <th>管家婆物料号</th>
                  <th>体系文件号</th>
                  <th>待补类型</th>
                  <th>发布状态</th>
                  <th>提交时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={item.approvalId}>
                    <td data-label="项目">{item.projectName}</td>
                    <td data-label="图纸名称"><strong className="pdm-part-name">{item.drawingName ?? item.partName}</strong></td>
                    <td data-label="版本"><span className="version-badge">{item.version}</span></td>
                    <td data-label="管家婆物料号">{item.materialCode ?? <span className="muted-inline">待补</span>}</td>
                    <td data-label="体系文件号">{item.documentCode ?? <span className="muted-inline">待补</span>}</td>
                    <td data-label="待补类型">
                      <span className="status-chip status-chip--pending">{pdmMetadataStatusLabel(item.metadataStatus)}</span>
                    </td>
                    <td data-label="发布状态">{pdmPublishStatusLabel(item.publishStatus)}</td>
                    <td data-label="提交时间">{formatPdmPendingDate(item.submittedAt)}</td>
                    <td data-label="操作" className="row-actions">
                      <a className="table-action-link" href={`#/approvals/${item.approvalId}`}>
                        <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                        打开审批详情
                      </a>
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
              <strong>{items.length === 0 ? "暂无 PDM 待补录记录。" : "没有匹配的待补录记录。"}</strong>
            </div>
          )
        )}
      </section>
    </section>
  );
}

export function buildPendingMetadataStats(items: PdmPendingMetadataApproval[]) {
  return {
    total: items.length,
    missingMaterialCode: items.filter((item) => item.metadataStatus === "missing_material_code").length,
    missingDocumentCode: items.filter((item) => item.metadataStatus === "missing_document_code").length,
    publishFailed: items.filter((item) => item.publishStatus === "failed").length
  };
}

export function filterPendingMetadataItems(
  items: PdmPendingMetadataApproval[],
  filters: { keyword?: string; metadataStatus?: string }
) {
  const keyword = filters.keyword?.trim().toLowerCase();
  const metadataStatus = filters.metadataStatus?.trim();
  return items.filter((item) => {
    if (metadataStatus && item.metadataStatus !== metadataStatus) return false;
    if (!keyword) return true;
    return [
      item.projectName,
      item.partName,
      item.drawingName ?? "",
      item.version,
      item.materialCode ?? "",
      item.documentCode ?? ""
    ].some((value) => value.toLowerCase().includes(keyword));
  });
}

export function pdmMetadataStatusLabel(status: PdmMetadataStatus) {
  return {
    complete: "完整",
    missing_material_code: "待补物料号",
    missing_document_code: "体系文件号待补",
    missing_required: "关键信息待补"
  }[status];
}

export function pdmPublishStatusLabel(status: PdmPublishStatus) {
  return {
    not_applicable: "不适用",
    metadata_pending: "等待补录",
    pending: "待发布",
    published: "已发布",
    failed: "发布失败"
  }[status];
}

function formatPdmPendingDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
