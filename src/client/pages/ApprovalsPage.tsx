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
  approvalIds,
  approvalListEmptyText,
  applyBatchApprovalActionResults,
  batchActionAvailabilityText,
  normalizeSearchKeyword,
  reconcileSelectedApprovals,
  removeDeletedApprovals,
  replaceAllSelections,
  signatureStatusFilterFromHash,
  shouldResetPageForLedgerFilters,
  statusFilterFromHash,
  toggleApprovalSelection
} from "./approvalListLogic.ts";

const approvalPageSize = 20;

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

  async function deleteOne(approval: Approval) {
    const confirmed = window.confirm(`确认删除图纸 ${approval.projectName} / ${approval.partName} ${approval.version}？此操作会删除审批记录和服务器上的受管 PDF 文件。`);
    if (!confirmed) return;

    await deleteApprovals([approval.id]);
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(`确认删除选中的 ${selectedIds.size} 张图纸？此操作会删除审批记录和服务器上的受管 PDF 文件。`);
    if (!confirmed) return;

    await deleteApprovals([...selectedIds]);
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

  async function runBatchPrintArchive() {
    if (selectedPrintArchiveIds.length === 0) return;
    const confirmed = window.confirm(`确认将 ${selectedPrintArchiveIds.length} 张图纸标记为已打印归档？`);
    if (!confirmed) return;

    setError("");
    setMessage("");
    setBatchResult(null);
    setBatchBusy("archive");
    try {
      const result = await batchMarkPrinted(selectedPrintArchiveIds);
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
      <div className="page-heading row">
        <div>
          <span className="eyebrow">DRAWING INDEX</span>
          <h1>全量图纸台账</h1>
          <p>{approvalLedgerDescription(user.role)}</p>
        </div>
        <div className="toolbar">
          <label>
            关键词
            <input
              value={keywordDraft}
              onChange={(event) => {
                setKeywordDraft(event.target.value);
              }}
              placeholder="项目、零件、版本"
            />
          </label>
          <label>
            状态
            <select
              value={status}
              onChange={(event) => {
                updateStatusFilter(event.target.value);
              }}
            >
              <option value="">全部状态</option>
              <optgroup label="流程状态">
                <option value="pending">审批中</option>
                <option value="rejected">已驳回</option>
                <option value="approved_for_print">已通过待打印</option>
                <option value="printed_archived">已打印归档</option>
              </optgroup>
              <optgroup label="异常处理">
                <option value="invalid_pdf">PDF 无效</option>
                <option value="file_missing">文件丢失</option>
                <option value="filename_invalid">文件名异常</option>
                <option value="voided">已作废</option>
              </optgroup>
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
        <span>当前页 {items.length} 张 / 共 {total} 张</span>
        <span>第 {page} / {pageCount} 页</span>
        {signatureStatus && <span>签审筛选：{signatureStatus}</span>}
        {normalizedDraftKeyword && <span>关键词：{normalizedDraftKeyword}</span>}
        {keywordPending && <span className="muted-inline">输入完成后自动刷新</span>}
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      {loading && <div className="empty compact-empty">{keywordPending ? "正在等待输入完成..." : "正在刷新当前筛选结果..."}</div>}
      {batchResult && (
        <div className="batch-action-result">
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
        </div>
      )}
      {selectable && items.length > 0 && (
        <div className="table-action-bar">
          <span>{approvalSelectionSummary(user.role, selectedCount, selectedSignedPdfIds.length, selectedPrintArchiveIds.length)}</span>
          {canBatchProcess && (
            <>
              <button type="button" onClick={runBatchSignedPdf} disabled={selectedSignedPdfIds.length === 0 || Boolean(batchBusy)}>
                {batchBusy === "sign" ? "生成中" : "批量重新生成签后 PDF"}
              </button>
              <button type="button" onClick={runBatchPrintArchive} disabled={selectedPrintArchiveIds.length === 0 || Boolean(batchBusy)}>
                {batchBusy === "archive" ? "归档中" : "批量标记打印归档"}
              </button>
            </>
          )}
          {canDelete && (
            <button
              type="button"
              className="danger"
              onClick={deleteSelected}
              disabled={selectedCount === 0 || deleting || Boolean(batchBusy)}
            >
              {deleting ? "删除中" : "删除所选"}
            </button>
          )}
        </div>
      )}
      <ApprovalTable
        approvals={items}
        emptyText={approvalListEmptyText(hasActiveFilters)}
        selectedIds={selectable ? selectedIds : undefined}
        onToggleSelection={selectable ? (approvalId) => setSelectedIds((current) => toggleApprovalSelection(current, approvalId)) : undefined}
        onToggleAll={selectable ? (selected) => setSelectedIds(replaceAllSelections(approvalIds(items), selected)) : undefined}
        onDelete={canDelete ? deleteOne : undefined}
      />
      <div className="pagination-bar">
        <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || loading}>
          上一页
        </button>
        <span>第 {page} / {pageCount} 页</span>
        <button type="button" className="secondary-button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount || loading}>
          下一页
        </button>
      </div>
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
