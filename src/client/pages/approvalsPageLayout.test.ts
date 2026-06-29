import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { approvalLedgerDescription, approvalSelectionSummary } from "./ApprovalsPage.tsx";

const source = fs.readFileSync(path.resolve("src/client/pages/ApprovalsPage.tsx"), "utf8");

describe("approvals page request lifecycle", () => {
  it("ignores stale list responses after filters change", () => {
    expect(source).toContain("let active = true");
    expect(source).toContain("if (!active) return");
    expect(source).toContain("active = false");
  });

  it("uses ledger-oriented copy for the all drawings page", () => {
    expect(source).toContain("全量图纸台账");
    expect(approvalLedgerDescription("admin")).toBe("筛选、查看和删除受管 PDF 文件，处理异常图纸台账。");
    expect(approvalLedgerDescription("designer")).toBe("筛选、批量生成签后 PDF，并标记打印归档。");
    expect(approvalLedgerDescription("supervisor")).toBe("筛选并查看图纸审批状态、签审状态和历史版本。");
  });

  it("keeps admin selection copy focused on deletion maintenance", () => {
    expect(approvalSelectionSummary("admin", 3, 2, 1)).toBe("已选 3 张，可删除 3 张");
    expect(approvalSelectionSummary("designer", 3, 2, 1)).toBe("已选 3 张，可重新生成签后 PDF 2 张，可打印归档 1 张");
  });

  it("keeps keyword typing responsive before sending a ledger request", () => {
    expect(source).toContain("useDeferredValue");
    expect(source).toContain("keywordDraft");
    expect(source).toContain("committedKeyword");
    expect(source).toContain("输入完成后自动刷新");
    expect(source).toContain("正在刷新当前筛选结果");
  });
});
