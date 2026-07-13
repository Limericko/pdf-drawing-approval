import { useDeferredValue, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  listPdmParts,
  listPendingPdmMetadata,
  type PdmMetadataStatus,
  type PdmPartListItem,
  type PdmPartListStats,
  type PdmPendingMetadataApproval,
  type User
} from "../api.ts";
import { FilterBar } from "../patterns/FilterBar/index.tsx";
import { PageHeader } from "../patterns/PageHeader/index.tsx";
import { Button, ButtonLink } from "../ui/actions/index.tsx";
import { DataTable, KeyValueList, Pagination, StatusChip, TableFrame, type DataTableColumn, type DataTone } from "../ui/data/index.tsx";
import { InlineAlert } from "../ui/feedback/index.tsx";
import { Select, TextInput } from "../ui/forms/index.tsx";
import styles from "./PdmPages.module.css";

const pdmPageSize = 20;
const emptyPdmStats: PdmPartListStats = { totalParts: 0, currentRevisionCount: 0, commonPartCount: 0 };

const pdmPartColumns: readonly DataTableColumn<PdmPartListItem>[] = [
  { id: "materialCode", header: "管家婆物料号", cell: (item) => <ButtonLink variant="ghost" size="sm" href={`#/pdm/parts/${item.id}`}>{item.materialCode}</ButtonLink> },
  { id: "name", header: "图纸名称", cell: (item) => <strong>{item.name}</strong> },
  { id: "version", header: "当前有效版本", align: "center", cell: (item) => item.currentVersion ?? <span className={styles.muted}>待发布</span> },
  { id: "documentCode", header: "体系文件号", mobileHidden: true, cell: (item) => item.currentDocumentCode ?? <span className={styles.muted}>待补</span> },
  { id: "projects", header: "项目复用", mobileHidden: true, cell: pdmUsageProjectsText },
  { id: "status", header: "状态", cell: (item) => {
    const presentation = pdmPartStatusPresentation(item);
    return <StatusChip tone={presentation.tone}>{presentation.label}</StatusChip>;
  } },
  { id: "releasedAt", header: "最近发布", mobileHidden: true, cell: (item) => <time className={styles.time}>{formatPdmDateTime(item.currentReleasedAt)}</time> },
  { id: "actions", header: "操作", cell: (item) => <div className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
    <ButtonLink variant="secondary" size="sm" href={`#/pdm/parts/${item.id}`}>详情</ButtonLink>
    {item.currentApprovalId ? <ButtonLink variant="ghost" size="sm" href={`#/approvals/${item.currentApprovalId}`}>审批记录</ButtonLink> : null}
  </div> }
];

export function PdmPartsPage({ user }: { user: User }) {
  const [items, setItems] = useState<PdmPartListItem[]>([]);
  const [pendingMetadata, setPendingMetadata] = useState<PdmPendingMetadataApproval[]>([]);
  const [stats, setStats] = useState<PdmPartListStats>(emptyPdmStats);
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
  const libraryStats = buildPdmLibraryStats(stats, pendingMetadata.length);

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

  useEffect(() => { setPage(1); }, [hasCurrentRevision, isCommon, projectName]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    listPdmParts({ page, pageSize: pdmPageSize, keyword: committedKeyword || undefined,
      projectName: projectName.trim() || undefined, isCommon: booleanFilterValue(isCommon),
      hasCurrentRevision: booleanFilterValue(hasCurrentRevision) })
      .then((result) => {
        if (!active) return;
        setItems(result.items); setTotal(result.total); setStats(result.stats);
      })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "PDM_PART_LIST_FAILED"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [committedKeyword, hasCurrentRevision, isCommon, page, projectName, refreshSeq]);

  useEffect(() => {
    if (!canSeePendingMetadata) { setPendingMetadata([]); setPendingError(""); return; }
    let active = true;
    setPendingError("");
    listPendingPdmMetadata()
      .then((result) => { if (active) setPendingMetadata(result.items); })
      .catch((err) => { if (active) setPendingError(err instanceof Error ? err.message : "PDM_PENDING_METADATA_FAILED"); });
    return () => { active = false; };
  }, [canSeePendingMetadata, refreshSeq]);

  function clearFilters() {
    setKeywordDraft(""); setCommittedKeyword(""); setProjectName(""); setIsCommon(""); setHasCurrentRevision(""); setPage(1);
  }

  return <section className={styles.page}>
    <PageHeader title="零件库" eyebrow="PDM 工作台" description={pdmLibraryDescription(user.role)}
      actions={<Button variant="secondary" loading={loading} loadingLabel="刷新中" onClick={() => setRefreshSeq((current) => current + 1)}>
        <RefreshCw size={15} aria-hidden="true" />刷新
      </Button>} metadata={<span>筛选条件保留在本页，便于连续查询和追溯。</span>} />

    <KeyValueList aria-label="PDM 零件库概览" items={libraryStats.map((stat) => ({
      id: stat.label, label: stat.label, value: <><strong className={styles.statValue}>{stat.value}</strong><span className={styles.statNote}>{stat.note}</span></>
    }))} />

    {canSeePendingMetadata ? <aside className={styles.riskQueue} aria-label="PDM 待补录风险队列">
      <div><div><span className={styles.eyebrow}>风险队列</span><h2>PDM 待补录</h2></div><StatusChip tone="warning">{pendingMetadata.length} 项</StatusChip></div>
      <p>缺少物料号、体系文件号或发布失败的图纸，补录后才能进入正式零件库。</p>
      {pendingError ? <InlineAlert tone="danger">PDM 待补录读取失败：{pendingError}</InlineAlert> : null}
      <div className={styles.pendingList}>{pendingMetadata.slice(0, 4).map((item) => <a key={item.approvalId} href={`#/approvals/${item.approvalId}`}>
        <span>{item.projectName} / {item.drawingName ?? item.partName} {item.version}</span>
        <StatusChip tone="warning">{pdmMetadataStatusLabel(item.metadataStatus)}</StatusChip>
      </a>)}{pendingMetadata.length === 0 ? <span className={styles.muted}>暂无待补录记录</span> : null}</div>
      <ButtonLink variant="secondary" size="sm" href="#/pdm/pending-metadata">进入待补录{pendingMetadata.length > 4 ? `，还有 ${pendingMetadata.length - 4} 条` : ""}</ButtonLink>
    </aside> : null}

    <FilterBar summary={<><span>当前页 {items.length} 个 / 共 {total} 个零件</span><span>第 {page} / {pageCount} 页</span>
      {normalizedDraftKeyword ? <span>关键词：{normalizedDraftKeyword}</span> : null}
      {projectName.trim() ? <span>项目：{projectName.trim()}</span> : null}
      {keywordPending ? <span>输入完成后自动刷新</span> : null}</>}
      actions={hasActiveFilters ? <Button variant="secondary" onClick={clearFilters}>清空筛选</Button> : undefined}>
      <TextInput id="pdm-keyword" label="关键词" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)}
        placeholder="物料号、图纸名称或体系文件号" />
      <TextInput id="pdm-project" label="项目" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="按使用项目筛选" />
      <Select id="pdm-release" label="发布状态" value={hasCurrentRevision} onChange={(event) => setHasCurrentRevision(event.target.value)} options={[
        { value: "", label: "全部" }, { value: "true", label: "有当前版本" }, { value: "false", label: "待发布" }
      ]} />
      <Select id="pdm-common" label="共用件" value={isCommon} onChange={(event) => setIsCommon(event.target.value)} options={[
        { value: "", label: "全部" }, { value: "true", label: "只看共用件" }, { value: "false", label: "非共用件" }
      ]} />
    </FilterBar>

    <TableFrame title="零件主数据" description="优先按管家婆物料号查询，物料号全局唯一。"
      footer={<Pagination page={page} pageCount={pageCount} totalItems={total} disabled={loading} onPageChange={setPage} />}>
      <DataTable ariaLabel="PDM 零件主数据" columns={pdmPartColumns} rows={items} getRowKey={(item) => item.id}
        getRowLabel={(item) => `${item.materialCode} ${item.name}`} loading={loading} error={error || undefined}
        onRetry={() => setRefreshSeq((current) => current + 1)} emptyTitle={pdmLibraryEmptyText(hasActiveFilters)}
        onRowActivate={(item) => { location.hash = `/pdm/parts/${item.id}`; }} stickyHeader />
    </TableFrame>
  </section>;
}

export function buildPdmLibraryStats(stats: PdmPartListStats, pendingMetadataCount: number) {
  return [
    { label: "零件总数", value: String(stats.totalParts), note: "按当前筛选统计" },
    { label: "当前有效版本", value: String(stats.currentRevisionCount), note: "已发布当前版本" },
    { label: "待补录", value: String(pendingMetadataCount), note: "需补齐物料号或发布异常" },
    { label: "共用件数", value: String(stats.commonPartCount), note: "跨项目复用" }
  ];
}

export function pdmLibraryDescription(role: User["role"]) {
  if (role === "designer") return "查询受控图纸版本，补齐自己提交图纸的 PDM 信息。";
  if (role === "supervisor") return "查询当前有效版本、历史版本和共用项目，辅助审核判断。";
  if (role === "process") return "查询当前有效版本、历史版本和共用项目，辅助工艺审查。";
  return "维护 PDM 待补录和发布异常，追溯零件图纸版本。";
}

export function pdmLibraryEmptyText(hasActiveFilters: boolean) {
  return hasActiveFilters ? "没有匹配的零件档案，请调整关键词或筛选条件。" : "暂无 PDM 零件档案。审批通过并发布后会自动进入这里。";
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

function pdmPartStatusPresentation(item: Pick<PdmPartListItem, "isCommon" | "currentRevisionId" | "currentVersion">): { label: string; tone: DataTone } {
  return { label: pdmPartStatusLabel(item), tone: item.isCommon ? "info" : !item.currentRevisionId || !item.currentVersion ? "warning" : "success" };
}

export function pdmMetadataStatusLabel(status: PdmMetadataStatus) {
  return { complete: "完整", missing_material_code: "待补物料号", missing_document_code: "体系文件号待补", missing_required: "关键信息待补" }[status];
}

export function formatPdmDateTime(value: string | null) {
  if (!value) return "未发布";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function booleanFilterValue(value: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
