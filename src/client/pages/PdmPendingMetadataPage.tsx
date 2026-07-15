import { useEffect, useMemo, useState } from "react";
import { PencilLine, RefreshCw, Send } from "lucide-react";
import {
  listPendingPdmMetadata,
  publishApprovalToPdm,
  repairApprovalPdmMetadata,
  type PdmMetadataStatus,
  type PdmPendingMetadataApproval,
  type PdmPublishStatus
} from "../api.ts";
import { FilterBar } from "../patterns/FilterBar/index.tsx";
import { PageHeader } from "../patterns/PageHeader/index.tsx";
import { Button, ButtonLink } from "../ui/actions/index.tsx";
import { DataTable, KeyValueList, StatusChip, TableFrame, type DataTableColumn, type DataTone } from "../ui/data/index.tsx";
import { InlineAlert } from "../ui/feedback/index.tsx";
import { Select, TextInput } from "../ui/forms/index.tsx";
import { Drawer } from "../ui/overlays/index.tsx";
import styles from "./PdmPages.module.css";

type PdmRepairDraft = { documentCode: string; materialCode: string; drawingName: string };

export function PdmPendingMetadataPage() {
  const [items, setItems] = useState<PdmPendingMetadataApproval[]>([]);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("");
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingApprovalId, setEditingApprovalId] = useState<number | null>(null);
  const [repairDrafts, setRepairDrafts] = useState<Record<number, PdmRepairDraft>>({});
  const [busyApprovalId, setBusyApprovalId] = useState<number | null>(null);
  const normalizedKeyword = keyword.trim().toLowerCase();
  const filteredItems = useMemo(() => filterPendingMetadataItems(items, { keyword: normalizedKeyword, metadataStatus: status }),
    [items, normalizedKeyword, status]);
  const stats = buildPendingMetadataStats(items);
  const editingItem = items.find((item) => item.approvalId === editingApprovalId) ?? null;
  const editingDraft = editingItem ? repairDrafts[editingItem.approvalId] ?? draftFor(editingItem) : null;

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    listPendingPdmMetadata()
      .then((result) => { if (active) setItems(result.items); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "PDM_PENDING_METADATA_FAILED"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshSeq]);

  function clearFilters() { setKeyword(""); setStatus(""); }
  function reloadQueue() { setRefreshSeq((current) => current + 1); }

  function startRepair(item: PdmPendingMetadataApproval) {
    setEditingApprovalId(item.approvalId);
    setRepairDrafts((current) => ({ ...current, [item.approvalId]: draftFor(item) }));
  }

  function updateRepairDraft(approvalId: number, field: keyof PdmRepairDraft, value: string) {
    setRepairDrafts((current) => ({ ...current,
      [approvalId]: { ...(current[approvalId] ?? { documentCode: "", materialCode: "", drawingName: "" }), [field]: value } }));
  }

  async function saveRepair(item: PdmPendingMetadataApproval) {
    const draft = repairDrafts[item.approvalId] ?? draftFor(item);
    if (!draft.drawingName.trim()) { setError("图纸名称不能为空。"); return; }
    setError(""); setMessage(""); setBusyApprovalId(item.approvalId);
    try {
      await repairApprovalPdmMetadata(item.approvalId, { documentCode: nullableTrim(draft.documentCode),
        materialCode: nullableTrim(draft.materialCode), drawingName: draft.drawingName.trim() });
      setMessage("PDM 信息已保存。"); setEditingApprovalId(null); reloadQueue();
    } catch (err) { setError(err instanceof Error ? err.message : "PDM_METADATA_REPAIR_FAILED"); }
    finally { setBusyApprovalId(null); }
  }

  async function publishItem(item: PdmPendingMetadataApproval) {
    setError(""); setMessage(""); setBusyApprovalId(item.approvalId);
    try {
      const result = await publishApprovalToPdm(item.approvalId);
      setMessage(result.status === "published" ? "已发布到 PDM 零件库。" : result.error ?? result.reason ?? "PDM 发布已提交。");
      reloadQueue();
    } catch (err) { setError(err instanceof Error ? err.message : "PDM_PUBLISH_FAILED"); }
    finally { setBusyApprovalId(null); }
  }

  const columns: readonly DataTableColumn<PdmPendingMetadataApproval>[] = [
    { id: "project", header: "项目", mobileHidden: true, cell: (item) => item.projectName },
    { id: "drawing", header: "图纸名称", cell: (item) => <strong>{item.drawingName ?? item.partName}</strong> },
    { id: "version", header: "版本", align: "center", cell: (item) => item.version },
    { id: "material", header: "管家婆物料号", cell: (item) => item.materialCode ?? <span className={styles.muted}>待补</span> },
    { id: "document", header: "体系文件号", cell: (item) => item.documentCode ?? <span className={styles.muted}>待补</span> },
    { id: "metadata", header: "待补类型", cell: (item) => <StatusChip tone="warning">{pdmMetadataStatusLabel(item.metadataStatus)}</StatusChip> },
    { id: "publish", header: "发布状态", mobileHidden: true, cell: (item) => {
      const presentation = publishStatusPresentation(item.publishStatus);
      return <StatusChip tone={presentation.tone}>{presentation.label}</StatusChip>;
    } },
    { id: "submitted", header: "提交时间", mobileHidden: true, cell: (item) => <time className={styles.time}>{formatPdmPendingDate(item.submittedAt)}</time> },
    { id: "actions", header: "操作", cell: (item) => <div className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={() => startRepair(item)}><PencilLine size={14} aria-hidden="true" />快速补录</Button>
      <Button size="sm" disabled={busyApprovalId === item.approvalId} loading={busyApprovalId === item.approvalId}
        loadingLabel="发布中" onClick={() => { void publishItem(item); }}><Send size={14} aria-hidden="true" />发布到 PDM</Button>
      <ButtonLink size="sm" variant="ghost" href={`#/approvals/${item.approvalId}`}>打开审批详情</ButtonLink>
    </div> }
  ];

  return <section className={styles.page}>
    <PageHeader title="PDM 待补录清单" eyebrow="PDM 待补录"
      description="集中处理缺少物料号、体系文件号或发布失败的图纸，补齐后再进入正式零件库。"
      actions={<Button variant="secondary" loading={loading} loadingLabel="刷新中" onClick={reloadQueue}><RefreshCw size={15} aria-hidden="true" />刷新</Button>}
      breadcrumbs={<ButtonLink variant="ghost" size="sm" href="#/pdm">返回零件库</ButtonLink>} />

    <KeyValueList aria-label="PDM 待补录统计" items={[
      { label: "待处理", value: stats.total }, { label: "待补物料号", value: stats.missingMaterialCode },
      { label: "体系文件号待补", value: stats.missingDocumentCode }, { label: "发布失败", value: stats.publishFailed }
    ]} />

    <FilterBar summary={<><span>当前显示 {filteredItems.length} 条 / 共 {items.length} 条</span>
      {keyword.trim() ? <span>关键词：{keyword.trim()}</span> : null}
      {status ? <span>类型：{pdmMetadataStatusLabel(status as PdmMetadataStatus)}</span> : null}</>}
      actions={keyword.trim() || status ? <Button variant="secondary" onClick={clearFilters}>清空筛选</Button> : undefined}>
      <TextInput id="pdm-pending-keyword" label="关键词" value={keyword} onChange={(event) => setKeyword(event.target.value)}
        placeholder="项目、图纸、版本、物料号或体系文件号" />
      <Select id="pdm-pending-status" label="待补类型" value={status} onChange={(event) => setStatus(event.target.value)} options={[
        { value: "", label: "全部" }, { value: "missing_material_code", label: "待补物料号" },
        { value: "missing_document_code", label: "体系文件号待补" }, { value: "missing_required", label: "关键信息待补" }
      ]} />
    </FilterBar>

    {error ? <InlineAlert tone="danger">PDM 待补录处理失败：{error}</InlineAlert> : null}
    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
    <TableFrame title="待补录明细">
      <DataTable ariaLabel="PDM 待补录明细" columns={columns} rows={filteredItems} getRowKey={(item) => item.approvalId}
        getRowLabel={(item) => item.drawingName ?? item.partName} loading={loading} error={error || undefined}
        onRetry={reloadQueue} emptyTitle={items.length === 0 ? "暂无 PDM 待补录记录。" : "没有匹配的待补录记录。"} stickyHeader />
    </TableFrame>

    <Drawer open={Boolean(editingItem)} title="快速补录 PDM 信息" description={editingItem ? `${editingItem.projectName} / ${editingItem.drawingName ?? editingItem.partName} ${editingItem.version}` : undefined}
      onClose={() => setEditingApprovalId(null)} footer={editingItem ? <>
        <Button variant="secondary" onClick={() => setEditingApprovalId(null)} disabled={busyApprovalId === editingItem.approvalId}>取消</Button>
        <Button loading={busyApprovalId === editingItem.approvalId} loadingLabel="保存中" onClick={() => { void saveRepair(editingItem); }}>保存补录</Button>
      </> : undefined}>
      {editingItem && editingDraft ? <div className={styles.drawerForm} aria-label={`${editingItem.drawingName ?? editingItem.partName} 快速补录`}>
        <TextInput id="pdm-repair-material" label="管家婆物料号" value={editingDraft.materialCode}
          onChange={(event) => updateRepairDraft(editingItem.approvalId, "materialCode", event.target.value)} placeholder="例如 0102A00700883" />
        <TextInput id="pdm-repair-document" label="体系文件号" value={editingDraft.documentCode}
          onChange={(event) => updateRepairDraft(editingItem.approvalId, "documentCode", event.target.value)} placeholder="例如 MP300A000072" />
        <TextInput id="pdm-repair-drawing" label="图纸名称" value={editingDraft.drawingName}
          onChange={(event) => updateRepairDraft(editingItem.approvalId, "drawingName", event.target.value)} />
      </div> : null}
    </Drawer>
  </section>;
}

function draftFor(item: PdmPendingMetadataApproval): PdmRepairDraft {
  return { documentCode: item.documentCode ?? "", materialCode: item.materialCode ?? "", drawingName: item.drawingName ?? item.partName };
}

export function buildPendingMetadataStats(items: PdmPendingMetadataApproval[]) {
  return { total: items.length,
    missingMaterialCode: items.filter((item) => item.metadataStatus === "missing_material_code").length,
    missingDocumentCode: items.filter((item) => item.metadataStatus === "missing_document_code").length,
    publishFailed: items.filter((item) => item.publishStatus === "failed").length };
}

export function filterPendingMetadataItems(items: PdmPendingMetadataApproval[], filters: { keyword?: string; metadataStatus?: string }) {
  const keyword = filters.keyword?.trim().toLowerCase();
  const metadataStatus = filters.metadataStatus?.trim();
  return items.filter((item) => {
    if (metadataStatus && item.metadataStatus !== metadataStatus) return false;
    if (!keyword) return true;
    return [item.projectName, item.partName, item.drawingName ?? "", item.version, item.materialCode ?? "", item.documentCode ?? ""]
      .some((value) => value.toLowerCase().includes(keyword));
  });
}

export function pdmMetadataStatusLabel(status: PdmMetadataStatus) {
  return { complete: "完整", missing_material_code: "待补物料号", missing_document_code: "体系文件号待补", missing_required: "关键信息待补" }[status];
}

export function pdmPublishStatusLabel(status: PdmPublishStatus) {
  return { not_applicable: "不适用", metadata_pending: "等待补录", pending: "待发布", published: "已发布", failed: "发布失败" }[status];
}

function publishStatusPresentation(status: PdmPublishStatus): { label: string; tone: DataTone } {
  return { label: pdmPublishStatusLabel(status), tone: status === "published" ? "success" : status === "failed" ? "danger"
    : status === "pending" || status === "metadata_pending" ? "warning" : "neutral" };
}

function formatPdmPendingDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function nullableTrim(value: string) { const trimmed = value.trim(); return trimmed || null; }
