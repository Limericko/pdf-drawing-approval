import { useEffect, useState } from "react";
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
import { PageHeader } from "../patterns/PageHeader/index.tsx";
import { Button, ButtonLink } from "../ui/actions/index.tsx";
import { DataTable, FileLink, HashValue, KeyValueList, StatusChip, TableFrame, Timeline, type DataTableColumn } from "../ui/data/index.tsx";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "../ui/feedback/index.tsx";
import { TextInput } from "../ui/forms/index.tsx";
import { Tabs } from "../ui/navigation/index.tsx";
import { ConfirmDialog } from "../ui/overlays/index.tsx";
import styles from "./PdmPartDetailPage.module.css";

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
  const [pendingVoidRevision, setPendingVoidRevision] = useState<PdmDrawingRevision | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    getPdmPart(id)
      .then((result) => { if (active) setDetail(result); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "PDM_PART_DETAIL_FAILED"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, refreshSeq]);

  function requestVoidRevision(revision: PdmDrawingRevision) {
    const reason = (voidReasonByRevisionId[revision.id] ?? "").trim();
    if (!reason) { setError("请先填写版本作废原因。"); return; }
    setPendingVoidRevision(revision);
  }

  async function confirmVoidRevision() {
    const revision = pendingVoidRevision;
    if (!revision) return;
    const reason = (voidReasonByRevisionId[revision.id] ?? "").trim();
    setError(""); setMessage(""); setBusyRevisionId(revision.id);
    try {
      await voidPdmRevision(revision.id, reason);
      setMessage("PDM 图纸版本已作废，当前有效版本已重新计算。");
      setVoidReasonByRevisionId((current) => ({ ...current, [revision.id]: "" }));
      setRefreshSeq((current) => current + 1);
      setPendingVoidRevision(null);
    } catch (err) { setError(err instanceof Error ? err.message : "PDM_REVISION_VOID_FAILED"); }
    finally { setBusyRevisionId(null); }
  }

  if (loading && !detail) return <TableFrame><div className={styles.initialState}><Skeleton lines={5} label="正在打开零件详情" /></div></TableFrame>;
  if (error && !detail) return <section className={styles.page}>
    <ButtonLink variant="ghost" href="#/pdm">返回零件库</ButtonLink>
    <ErrorState title="零件详情读取失败" onRetry={() => setRefreshSeq((current) => current + 1)}>{error}</ErrorState>
  </section>;
  if (!detail) return <EmptyState title="未找到零件档案" />;

  const { part, currentRevision, revisions, usages, traceLogs } = detail;
  const relationTabs = buildPdmRelationTabs(revisions.length, usages.length, traceLogs.length);
  const canVoidRevision = user?.role === "admin";

  return <section className={styles.page}>
    <PageHeader title={part.name} eyebrow="零件主档案" description={pdmRevisionSummary(detail)}
      breadcrumbs={<ButtonLink variant="ghost" size="sm" href="#/pdm">返回零件库</ButtonLink>}
      metadata={<StatusChip tone={part.isCommon ? "info" : "neutral"}>{part.isCommon ? "共用件" : "普通零件"}</StatusChip>} />

    <KeyValueList aria-label="PDM 零件主档案" items={pdmDetailOverviewFacts(detail)} />

    <TableFrame title="当前有效版本" description={currentRevision ? currentRevision.documentCode ?? "体系文件号待补" : "该零件还没有发布到 PDM 的当前版本。"}>
      {currentRevision ? <div className={styles.currentRevision}>
        <StatusChip tone="success">{currentRevision.version}</StatusChip>
        <ButtonLink variant="secondary" size="sm" href={`#/approvals/${currentRevision.approvalId}`}>{pdmTraceabilityLabel(currentRevision.approvalId)}</ButtonLink>
        <RevisionFileActions revision={currentRevision} />
      </div> : <EmptyState title="待发布">审批通过并发布后会生成当前有效版本。</EmptyState>}
    </TableFrame>

    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
    {error ? <InlineAlert tone="danger">PDM 操作失败：{error}</InlineAlert> : null}

    <Tabs label="零件版本关系" activeId={activeTab} onChange={(value) => setActiveTab(value as PdmDetailTab)}
      items={relationTabs.map((tab) => ({ id: tab.key, label: `${tab.label} ${tab.count}` }))} />

    {activeTab === "history" ? <RevisionHistoryTable revisions={revisions} canVoid={canVoidRevision}
      busyRevisionId={busyRevisionId} voidReasonByRevisionId={voidReasonByRevisionId}
      onVoidReasonChange={(revisionId, reason) => setVoidReasonByRevisionId((current) => ({ ...current, [revisionId]: reason }))}
      onVoidRevision={requestVoidRevision} /> : null}

    {activeTab === "projects" ? <UsageProjectList usages={usages} /> : null}

    {activeTab === "approvals" ? <TableFrame title="审批记录" description="按版本发布时间倒序">
      {revisions.length > 0 ? <div className={styles.linkList}>{revisions.map((revision) => <ButtonLink key={revision.id}
        variant="secondary" href={`#/approvals/${revision.approvalId}`}>{revision.version} · {revision.drawingName} · {pdmTraceabilityLabel(revision.approvalId)}</ButtonLink>)}</div>
        : <EmptyState title="暂无关联审批记录" />}
    </TableFrame> : null}

    {activeTab === "hashes" ? <RevisionHashGrid revisions={revisions} /> : null}

    {activeTab === "trace" ? <TableFrame title="操作时间线" description="来自该零件所有版本的审批与 PDM 操作">
      <PdmTraceTimeline logs={traceLogs} />
    </TableFrame> : null}

    <ConfirmDialog open={Boolean(pendingVoidRevision)} title="确认作废版本"
      description={pendingVoidRevision ? `确认作废 ${pendingVoidRevision.drawingName} / ${pendingVoidRevision.version}？作废后会重新计算当前有效版本。` : ""}
      confirmLabel="确认作废" danger busy={Boolean(busyRevisionId)} onClose={() => setPendingVoidRevision(null)}
      onConfirm={() => { void confirmVoidRevision(); }} />
  </section>;
}

function RevisionHistoryTable({ revisions, canVoid, busyRevisionId, voidReasonByRevisionId, onVoidReasonChange, onVoidRevision }: {
  readonly revisions: readonly PdmDrawingRevision[];
  readonly canVoid: boolean;
  readonly busyRevisionId: number | null;
  readonly voidReasonByRevisionId: Readonly<Record<number, string>>;
  readonly onVoidReasonChange: (revisionId: number, reason: string) => void;
  readonly onVoidRevision: (revision: PdmDrawingRevision) => void;
}) {
  const columns: DataTableColumn<PdmDrawingRevision>[] = [
    { id: "version", header: "版本", align: "center", cell: (revision) => <strong>{revision.version}</strong> },
    { id: "document", header: "体系文件号", mobileHidden: true, cell: (revision) => revision.documentCode ?? "待补" },
    { id: "drawing", header: "图纸名称", cell: (revision) => revision.drawingName },
    { id: "status", header: "状态", cell: (revision) => <StatusChip tone={revision.releaseStatus === "released" ? "success" : "neutral"}>{pdmRevisionStatusLabel(revision.releaseStatus)}</StatusChip> },
    { id: "released", header: "发布时间", mobileHidden: true, cell: (revision) => <time className={styles.time}>{formatDateTime(revision.releasedAt)}</time> },
    { id: "files", header: "PDF 文件", cell: (revision) => <RevisionFileActions revision={revision} /> },
    { id: "approval", header: "审批记录", mobileHidden: true, cell: (revision) => <ButtonLink variant="ghost" size="sm" href={`#/approvals/${revision.approvalId}`}>{pdmTraceabilityLabel(revision.approvalId)}</ButtonLink> }
  ];
  if (canVoid) columns.push({ id: "maintenance", header: "版本维护", cell: (revision) => revision.releaseStatus === "voided"
    ? <span className={styles.muted}>已作废</span>
    : <div className={styles.maintenance}>
      <TextInput id={`void-reason-${revision.id}`} label="作废原因" hideLabel value={voidReasonByRevisionId[revision.id] ?? ""}
        onChange={(event) => onVoidReasonChange(revision.id, event.target.value)} placeholder="填写作废原因" />
      <Button size="sm" variant="danger" loading={busyRevisionId === revision.id} loadingLabel="作废中" onClick={() => onVoidRevision(revision)}>作废版本</Button>
    </div> });
  return <TableFrame title="历史版本" description={`共 ${revisions.length} 个版本`}>
    <DataTable ariaLabel="PDM 历史版本" columns={columns} rows={revisions} getRowKey={(revision) => revision.id}
      emptyTitle="暂无历史版本" stickyHeader />
  </TableFrame>;
}

function RevisionFileActions({ revision }: { readonly revision: PdmDrawingRevision }) {
  const annotatedCacheKey = revision.annotatedFilePath ? revision.updatedAt : null;
  return <div className={styles.fileActions} onClick={(event) => event.stopPropagation()}>
    <FileLink href={getApprovalFileUrl(revision.approvalId)} target="_blank" rel="noreferrer">原始 PDF</FileLink>
    {revision.signedFilePath ? <FileLink href={getSignedFileUrl(revision.approvalId, revision.signedFileHash)} target="_blank" rel="noreferrer">签后 PDF</FileLink>
      : <span className={styles.disabledFile}>签后 PDF</span>}
    {revision.annotatedFilePath ? <FileLink href={getAnnotatedFileUrl(revision.approvalId, annotatedCacheKey)} target="_blank" rel="noreferrer">审查版 PDF</FileLink>
      : <span className={styles.disabledFile}>审查版 PDF</span>}
  </div>;
}

function PdmTraceTimeline({ logs }: { readonly logs: readonly OperationLog[] }) {
  if (logs.length === 0) return <EmptyState title="暂无操作时间线" />;
  return <Timeline items={logs.map((log) => ({ id: log.id, title: operationLogActionLabel(log.action),
    timestamp: formatDateTime(log.createdAt), description: <>{log.message}<span className={styles.actor}>{log.actorUsername ? `操作人：${log.actorUsername}` : "系统记录"}</span></>,
    tone: log.action.includes("failed") || log.action.includes("voided") ? "danger" : log.action.includes("published") ? "success" : "info" }))} />;
}

function UsageProjectList({ usages }: { readonly usages: readonly PdmPartUsage[] }) {
  return <TableFrame title="使用项目" description={`${usages.length} 个项目`}>
    {usages.length > 0 ? <KeyValueList items={usages.map((usage) => ({ id: String(usage.id), label: usage.projectName,
      value: `首次审批 #${usage.firstApprovalId}，最近审批 #${usage.lastApprovalId}` }))} /> : <EmptyState title="暂无项目使用记录" />}
  </TableFrame>;
}

function RevisionHashGrid({ revisions }: { readonly revisions: readonly PdmDrawingRevision[] }) {
  return <TableFrame title="文件哈希" description="用于追溯原始 PDF、签后 PDF 和批注版 PDF。">
    {revisions.length > 0 ? <div className={styles.hashList}>{revisions.map((revision) => <section key={revision.id}>
      <header><StatusChip tone={revision.releaseStatus === "released" ? "success" : "neutral"}>{revision.version}</StatusChip><strong>{pdmRevisionStatusLabel(revision.releaseStatus)}</strong></header>
      <KeyValueList items={[
        { label: "原始文件哈希", value: revision.originalFileHash ? <HashValue value={revision.originalFileHash} /> : "未记录", wide: true },
        { label: "签后文件哈希", value: revision.signedFileHash ? <HashValue value={revision.signedFileHash} /> : "未记录", wide: true },
        { label: "批注版文件", value: revision.annotatedFilePath ? "已归档" : "未归档" }
      ]} />
    </section>)}</div> : <EmptyState title="暂无文件哈希记录" />}
  </TableFrame>;
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
    { key: "history", label: "版本历史", count: revisionCount }, { key: "projects", label: "使用项目", count: usageCount },
    { key: "approvals", label: "关联审批", count: revisionCount }, { key: "hashes", label: "文件哈希", count: revisionCount },
    { key: "trace", label: "操作时间线", count: traceCount }
  ];
}

export function pdmRevisionSummary(detail: PdmPartDetail) {
  return detail.currentRevision ? `当前 ${detail.currentRevision.version} / 体系文件号 ${detail.currentRevision.documentCode ?? "待补"}` : "尚未发布当前有效版本";
}

export function pdmRevisionStatusLabel(status: PdmRevisionStatus) {
  return { released: "当前有效", superseded: "历史版本", voided: "已作废" }[status];
}

export function pdmTraceabilityLabel(approvalId: number) { return `查看审批 #${approvalId}`; }

function formatDateTime(value: string | null) {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function operationLogActionLabel(action: string) {
  const labels: Record<string, string> = { "pdm.revision_voided": "PDM 版本作废", "pdm.revision_published": "发布到 PDM",
    "pdm.metadata_repaired": "PDM 信息补录", "pdm.published": "发布到 PDM", "pdm.backfill_requested": "PDM 历史回填",
    "approval.reviewed": "审核处理", "approval.signed": "签后 PDF", "approval.printed": "打印归档" };
  return labels[action] ?? action;
}
