import { useDeferredValue, useEffect, useState } from "react";
import {
  batchGenerateSignedPdf,
  batchMarkPrinted,
  deleteApproval,
  listApprovalsPage,
  type Approval,
  type BatchApprovalActionResult,
  type User
} from "../api.ts";
import { ApprovalTable } from "../widgets/ApprovalTable.tsx";
import {
  approvalIdsEligibleForBatchPrintArchive,
  approvalIdsEligibleForBatchSignedPdf,
  approvalListEmptyText,
  applyBatchApprovalActionResults,
  batchActionAvailabilityText,
  normalizeSearchKeyword,
  reconcileSelectedApprovals,
  removeDeletedApprovals,
  signatureStatusFilterFromHash,
  shouldResetPageForLedgerFilters,
  statusFilterFromHash
} from "./approvalListLogic.ts";
import { PageHeader } from "../patterns/PageHeader/index.tsx";
import { FilterBar } from "../patterns/FilterBar/index.tsx";
import { Button } from "../ui/actions/index.tsx";
import { BatchActionBar, Pagination } from "../ui/data/index.tsx";
import { InlineAlert } from "../ui/feedback/index.tsx";
import { Select, TextInput } from "../ui/forms/index.tsx";
import { ConfirmDialog } from "../ui/overlays/index.tsx";
import styles from "./ApprovalsPage.module.css";

const approvalPageSize = 20;

type PendingConfirmation =
  | { readonly kind: "delete"; readonly ids: readonly number[]; readonly description: string }
  | { readonly kind: "archive"; readonly ids: readonly number[]; readonly description: string }
  | null;

export function ApprovalsPage({ user }: { user: User }) {
  const [items, setItems] = useState<Approval[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(() => statusFilterFromHash(location.hash));
  const [signatureStatus, setSignatureStatus] = useState(() => signatureStatusFilterFromHash(location.hash));
  const [keywordDraft, setKeywordDraft] = useState("");
  const [committedKeyword, setCommittedKeyword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [batchBusy, setBatchBusy] = useState<"sign" | "archive" | "">("");
  const [batchResult, setBatchResult] = useState<BatchApprovalActionResult | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>(null);
  const deferredKeywordDraft = useDeferredValue(keywordDraft);
  const normalizedDraftKeyword = normalizeSearchKeyword(keywordDraft);
  const keywordPending = normalizedDraftKeyword !== committedKeyword;

  useEffect(() => {
    const nextKeyword = normalizeSearchKeyword(deferredKeywordDraft);
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
    let active = true;
    setLoading(true);
    setError("");
    listApprovalsPage({
      page,
      pageSize: approvalPageSize,
      keyword: committedKeyword || undefined,
      status: status || undefined,
      signatureStatus: signatureStatus || undefined
    })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setSelectedIds((current) => reconcileSelectedApprovals(current, result.items));
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message);
      })
      .finally(() => {
      if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [committedKeyword, page, signatureStatus, status]);

  const canDelete = user.role === "admin";
  const canBatchProcess = user.role === "designer";
  const selectable = canDelete || canBatchProcess;
  const hasActiveFilters = Boolean(status || signatureStatus || normalizedDraftKeyword || committedKeyword);
  const selectedCount = selectedIds.size;
  const selectedSignedPdfIds = approvalIdsEligibleForBatchSignedPdf(items, selectedIds);
  const selectedPrintArchiveIds = approvalIdsEligibleForBatchPrintArchive(items, selectedIds);
  const pageCount = Math.max(1, Math.ceil(total / approvalPageSize));

  useEffect(() => {
    setSelectedIds((current) => reconcileSelectedApprovals(current, items));
  }, [items]);

  function deleteOne(approval: Approval) {
    setPendingConfirmation({ kind: "delete", ids: [approval.id],
      description: `确认删除图纸 ${approval.projectName} / ${approval.partName} ${approval.version}？此操作会删除审批记录和服务器上的受管 PDF 文件。` });
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    setPendingConfirmation({ kind: "delete", ids: [...selectedIds],
      description: `确认删除选中的 ${selectedIds.size} 张图纸？此操作会删除审批记录和服务器上的受管 PDF 文件。` });
  }

  async function deleteApprovals(ids: number[]) {
    setError("");
    setMessage("");
    setBatchResult(null);
    setDeleting(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteApproval(id)));
      const deletedIds = ids.filter((_, index) => results[index].status === "fulfilled");
      if (deletedIds.length > 0) {
        setItems((current) => removeDeletedApprovals(current, deletedIds));
        setTotal((current) => Math.max(0, current - deletedIds.length));
        setSelectedIds((current) => {
          const next = new Set(current);
          deletedIds.forEach((id) => next.delete(id));
          return next;
        });
        setMessage(`已删除 ${deletedIds.length} 张图纸。`);
      }
      if (deletedIds.length !== ids.length) {
        setError(`有 ${ids.length - deletedIds.length} 张图纸删除失败，请稍后重试或查看服务日志。`);
      }
    } finally {
      setDeleting(false);
    }
  }

  async function runBatchSignedPdf() {
    if (selectedSignedPdfIds.length === 0) return;
    setError("");
    setMessage("");
    setBatchResult(null);
    setBatchBusy("sign");
    try {
      const result = await batchGenerateSignedPdf(selectedSignedPdfIds);
      applyBatchResult(result, `批量重新生成签后 PDF：成功 ${result.success}，失败 ${result.failed}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批量重新生成签后 PDF 失败");
    } finally {
      setBatchBusy("");
    }
  }

  function runBatchPrintArchive() {
    if (selectedPrintArchiveIds.length === 0) return;
    setPendingConfirmation({ kind: "archive", ids: selectedPrintArchiveIds,
      description: `确认将 ${selectedPrintArchiveIds.length} 张图纸标记为已打印归档？` });
  }

  async function confirmPendingAction() {
    const pending = pendingConfirmation;
    if (!pending) return;
    setPendingConfirmation(null);
    if (pending.kind === "delete") {
      await deleteApprovals([...pending.ids]);
      return;
    }
    setError("");
    setMessage("");
    setBatchResult(null);
    setBatchBusy("archive");
    try {
      const result = await batchMarkPrinted([...pending.ids]);
      applyBatchResult(result, `批量打印归档：成功 ${result.success}，失败 ${result.failed}。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "批量打印归档失败");
    } finally {
      setBatchBusy("");
    }
  }

  function applyBatchResult(result: BatchApprovalActionResult, successMessage: string) {
    setBatchResult(result);
    setItems((current) => {
      const next = applyBatchApprovalActionResults(current, result);
      setSelectedIds((selected) => reconcileSelectedApprovals(selected, next));
      return next;
    });
    setMessage(successMessage);
  }

  function clearFilters() {
    setStatus("");
    setSignatureStatus("");
    setKeywordDraft("");
    setCommittedKeyword("");
    setPage(1);
  }

  function updateStatusFilter(nextStatus: string) {
    if (shouldResetPageForLedgerFilters({ status, signatureStatus, keyword: committedKeyword }, { status: nextStatus, signatureStatus, keyword: committedKeyword })) {
      setPage(1);
    }
    setStatus(nextStatus);
  }

  return (
    <section>
      <PageHeader title="全量图纸台账" eyebrow="DRAWING INDEX" description={approvalLedgerDescription(user.role)}
        metadata={<><span>当前页 <strong>{items.length}</strong> 张</span><span>共 <strong>{total}</strong> 张</span></>} />
      <FilterBar summary={<><span>第 {page} / {pageCount} 页</span>
        {signatureStatus ? <span>签审筛选：{signatureStatus}</span> : null}
        {normalizedDraftKeyword ? <span>关键词：{normalizedDraftKeyword}</span> : null}
        {keywordPending ? <span>输入完成后自动刷新</span> : null}</>}
        actions={hasActiveFilters ? <Button variant="secondary" onClick={clearFilters}>清空筛选</Button> : undefined}>
        <TextInput id="approval-keyword" label="关键词" value={keywordDraft}
          onChange={(event) => setKeywordDraft(event.target.value)} placeholder="项目、零件、版本" />
        <Select id="approval-status" label="状态" value={status} onChange={(event) => updateStatusFilter(event.target.value)} options={[
          { value: "", label: "全部状态" }, { value: "pending", label: "审批中" },
          { value: "rejected", label: "已驳回" }, { value: "approved_for_print", label: "已通过待打印" },
          { value: "printed_archived", label: "已打印归档" }, { value: "invalid_pdf", label: "PDF 无效" },
          { value: "file_missing", label: "文件丢失" }, { value: "filename_invalid", label: "文件名异常" },
          { value: "voided", label: "已作废" }
        ]} />
      </FilterBar>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
      {loading ? <InlineAlert tone="info">{keywordPending ? "正在等待输入完成..." : "正在刷新当前筛选结果..."}</InlineAlert> : null}
      {batchResult && (
        <InlineAlert tone={batchResult.failed > 0 ? "warning" : "success"}>
          <strong>批量处理结果：成功 {batchResult.success}，失败 {batchResult.failed}</strong>
          {batchResult.failed > 0 && (
            <ul>
              {batchResult.items
                .filter((item) => item.status === "failed")
                .map((item) => (
                  <li key={item.approvalId}>
                    #{item.approvalId}：{item.error ?? "处理失败"}
                  </li>
                ))}
            </ul>
          )}
        </InlineAlert>
      )}
      {selectable && selectedCount > 0 && (
        <BatchActionBar selectedCount={selectedCount} onClearSelection={() => setSelectedIds(new Set())}>
          <span className={styles.selectionSummary}>{approvalSelectionSummary(user.role, selectedCount, selectedSignedPdfIds.length, selectedPrintArchiveIds.length)}</span>
          {canBatchProcess && (
            <>
              <Button size="sm" onClick={runBatchSignedPdf} disabled={selectedSignedPdfIds.length === 0 || Boolean(batchBusy)}
                loading={batchBusy === "sign"} loadingLabel="生成中">批量重新生成签后 PDF</Button>
              <Button size="sm" onClick={runBatchPrintArchive} disabled={selectedPrintArchiveIds.length === 0 || Boolean(batchBusy)}
                loading={batchBusy === "archive"} loadingLabel="归档中">批量标记打印归档</Button>
            </>
          )}
          {canDelete && (
            <Button size="sm" variant="danger" onClick={deleteSelected} disabled={deleting || Boolean(batchBusy)}
              loading={deleting} loadingLabel="删除中">删除所选</Button>
          )}
        </BatchActionBar>
      )}
      <ApprovalTable
        approvals={items}
        emptyText={approvalListEmptyText(hasActiveFilters)}
        loading={loading}
        selectedIds={selectable ? selectedIds : undefined}
        onSelectionChange={selectable ? (keys) => setSelectedIds(new Set(keys)) : undefined}
        onDelete={canDelete ? deleteOne : undefined}
        footer={<Pagination page={page} pageCount={pageCount} totalItems={total} disabled={loading}
          onPageChange={setPage} />}
      />
      <ConfirmDialog open={Boolean(pendingConfirmation)} title={pendingConfirmation?.kind === "archive" ? "确认打印归档" : "确认删除图纸"}
        description={pendingConfirmation?.description ?? ""} danger={pendingConfirmation?.kind === "delete"}
        confirmLabel={pendingConfirmation?.kind === "archive" ? "确认归档" : "确认删除"}
        busy={deleting || batchBusy === "archive"} onClose={() => setPendingConfirmation(null)} onConfirm={() => { void confirmPendingAction(); }} />
    </section>
  );
}

export function approvalLedgerDescription(role: User["role"]) {
  if (role === "admin") return "筛选、查看和删除受管 PDF 文件，处理异常图纸台账。";
  if (role === "designer") return "筛选、批量生成签后 PDF，并标记打印归档。";
  return "筛选并查看图纸审批状态、签审状态和历史版本。";
}

export function approvalSelectionSummary(role: User["role"], selectedCount: number, signedPdfCount: number, archiveCount: number) {
  if (role === "admin") return `已选 ${selectedCount} 张，可删除 ${selectedCount} 张`;
  return batchActionAvailabilityText(selectedCount, signedPdfCount, archiveCount);
}
