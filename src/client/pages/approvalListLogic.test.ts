import { describe, expect, it } from "vitest";
import * as approvalListLogic from "./approvalListLogic.ts";
import {
  approvalIdsEligibleForBatchPrintArchive,
  approvalIdsEligibleForBatchSignedPdf,
  approvalIds,
  applyBatchApprovalActionResults,
  reconcileSelectedApprovals,
  removeDeletedApprovals,
  replaceAllSelections,
  normalizeSearchKeyword,
  signatureStatusFilterFromHash,
  shouldResetPageForLedgerFilters,
  statusFilterFromHash,
  toggleApprovalSelection
} from "./approvalListLogic.ts";

const approvals = [
  { id: 1, partName: "轴承座" },
  { id: 2, partName: "前面板" },
  { id: 3, partName: "后支架" }
];

describe("approval list selection logic", () => {
  it("selects individual approvals and supports selecting all visible approvals", () => {
    const selected = toggleApprovalSelection(new Set<number>(), 2);

    expect([...selected]).toEqual([2]);
    expect([...toggleApprovalSelection(selected, 2)]).toEqual([]);
    expect([...replaceAllSelections(approvalIds(approvals), true)]).toEqual([1, 2, 3]);
    expect([...replaceAllSelections(approvalIds(approvals), false)]).toEqual([]);
  });

  it("removes deleted approvals and clears stale selections", () => {
    const remaining = removeDeletedApprovals(approvals, [1, 3]);
    const selected = reconcileSelectedApprovals(new Set([1, 2, 3]), remaining);

    expect(remaining.map((approval) => approval.id)).toEqual([2]);
    expect([...selected]).toEqual([2]);
  });

  it("selects only approved-for-print records for batch signed PDF regeneration", () => {
    const selected = new Set([1, 2, 3, 4]);
    const candidates = [
      { id: 1, status: "approved_for_print", signatureStatus: "failed" },
      { id: 2, status: "approved_for_print", signatureStatus: "generated" },
      { id: 3, status: "approved_for_print", signatureStatus: "not_required" },
      { id: 4, status: "pending", signatureStatus: "failed" }
    ];

    expect(approvalIdsEligibleForBatchSignedPdf(candidates, selected)).toEqual([1, 2]);
  });

  it("requires generated signed PDF before batch print archive when signing is required", () => {
    const selected = new Set([1, 2, 3, 4]);
    const candidates = [
      { id: 1, status: "approved_for_print", signatureStatus: "generated", signedFilePath: "signed.pdf" },
      { id: 2, status: "approved_for_print", signatureStatus: "generated", signedFilePath: null },
      { id: 3, status: "approved_for_print", signatureStatus: "not_required", signedFilePath: null },
      { id: 4, status: "printed_archived", signatureStatus: "generated", signedFilePath: "archived.pdf" }
    ];

    expect(approvalIdsEligibleForBatchPrintArchive(candidates, selected)).toEqual([1, 3]);
  });

  it("updates batch action results without clearing still-visible selections", () => {
    const current = [
      { id: 1, status: "approved_for_print", partName: "轴承座" },
      { id: 2, status: "approved_for_print", partName: "前面板" }
    ];
    const updated = applyBatchApprovalActionResults(current, {
      items: [
        { approvalId: 1, status: "completed", approval: { id: 1, status: "printed_archived", partName: "轴承座" } },
        { approvalId: 2, status: "failed", error: "SIGNED_PDF_REQUIRED" }
      ]
    });

    expect(updated.map((approval) => approval.status)).toEqual(["printed_archived", "approved_for_print"]);
    expect([...reconcileSelectedApprovals(new Set([1, 2]), updated)]).toEqual([1, 2]);
  });

  it("reads status filters from risk dashboard hash links", () => {
    expect(statusFilterFromHash("#/approvals?status=file_missing")).toBe("file_missing");
    expect(statusFilterFromHash("#/approvals?signatureStatus=failed")).toBe("");
    expect(signatureStatusFilterFromHash("#/approvals?signatureStatus=failed")).toBe("failed");
  });

  it("filters approvals by project, part, version, and path keywords", () => {
    const filterApprovalsByKeyword = (
      approvalListLogic as unknown as {
        filterApprovalsByKeyword?: <T extends { projectName: string; partName: string; version: string; currentFilePath?: string }>(
          approvals: T[],
          keyword: string
        ) => T[];
      }
    ).filterApprovalsByKeyword;
    const candidates = [
      { id: 1, projectName: "300A", partName: "固定支持支架", version: "a0A0", currentFilePath: "G:\\test\\固定支持支架-a0A0.pdf" },
      { id: 2, projectName: "200B", partName: "前面板玻璃", version: "a1A0", currentFilePath: "G:\\test\\前面板玻璃-a1A0.pdf" },
      { id: 3, projectName: "300A", partName: "后盖", version: "b0A0", currentFilePath: "G:\\test\\后盖-b0A0.pdf" }
    ];

    expect(filterApprovalsByKeyword).toBeTypeOf("function");
    expect(filterApprovalsByKeyword!(candidates, " 300a ")).toEqual([candidates[0], candidates[2]]);
    expect(filterApprovalsByKeyword!(candidates, "玻璃")).toEqual([candidates[1]]);
    expect(filterApprovalsByKeyword!(candidates, "A1a0")).toEqual([candidates[1]]);
  });

  it("summarizes active list filters and batch action availability", () => {
    const emptyText = (approvalListLogic as unknown as { approvalListEmptyText?: (hasFilters: boolean) => string }).approvalListEmptyText;
    const batchHint = (
      approvalListLogic as unknown as {
        batchActionAvailabilityText?: (selectedCount: number, signedPdfCount: number, archiveCount: number) => string;
      }
    ).batchActionAvailabilityText;

    expect(emptyText).toBeTypeOf("function");
    expect(batchHint).toBeTypeOf("function");
    expect(emptyText!(false)).toBe("暂无图纸记录");
    expect(emptyText!(true)).toBe("没有符合条件的图纸");
    expect(batchHint!(0, 0, 0)).toBe("已选 0 张");
    expect(batchHint!(3, 2, 1)).toBe("已选 3 张，可重新生成签后 PDF 2 张，可打印归档 1 张");
  });

  it("normalizes search keywords before requesting paged ledger data", () => {
    expect(normalizeSearchKeyword("  300A   固定 支架  ")).toBe("300A 固定 支架");
    expect(normalizeSearchKeyword("\t前面板玻璃\n")).toBe("前面板玻璃");
    expect(normalizeSearchKeyword("   ")).toBe("");
  });

  it("resets the ledger page only when committed filters actually change", () => {
    const current = { status: "pending", signatureStatus: "failed", keyword: "300A 支架" };

    expect(shouldResetPageForLedgerFilters(current, { ...current, keyword: " 300A   支架 " })).toBe(false);
    expect(shouldResetPageForLedgerFilters(current, { ...current, keyword: "300B 支架" })).toBe(true);
    expect(shouldResetPageForLedgerFilters(current, { ...current, status: "approved_for_print" })).toBe(true);
    expect(shouldResetPageForLedgerFilters(current, { ...current, signatureStatus: "" })).toBe(true);
  });
});
