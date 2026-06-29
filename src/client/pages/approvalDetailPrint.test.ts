import { describe, expect, it } from "vitest";
import {
  canUseNativePrintForApproval,
  printFailureMessage,
  shouldArchiveAfterDesktopPrint
} from "./approvalDetailPrint.ts";
import type { Approval, User } from "../api.ts";

describe("approval detail native print flow", () => {
  const approval = {
    status: "approved_for_print",
    signatureStatus: "generated",
    signedFilePath: "G:\\approval\\04-已通过待打印\\part-签审.pdf"
  } as Approval;

  it("allows only designers and admins to use native print before archive", () => {
    expect(canUseNativePrintForApproval({ role: "designer" } as User, approval, true, true)).toBe(true);
    expect(canUseNativePrintForApproval({ role: "admin" } as User, approval, true, true)).toBe(true);
    expect(canUseNativePrintForApproval({ role: "supervisor" } as User, approval, true, true)).toBe(false);
    expect(canUseNativePrintForApproval({ role: "process" } as User, approval, true, true)).toBe(false);
  });

  it("requires Electron mode and a generated signed PDF", () => {
    expect(canUseNativePrintForApproval({ role: "designer" } as User, approval, true, false)).toBe(false);
    expect(canUseNativePrintForApproval({ role: "designer" } as User, approval, false, true)).toBe(false);
    expect(canUseNativePrintForApproval({ role: "designer" } as User, { ...approval, status: "printed_archived" } as Approval, true, true)).toBe(false);
  });

  it("archives only after a successful desktop print callback", () => {
    expect(shouldArchiveAfterDesktopPrint({ success: true })).toBe(true);
    expect(shouldArchiveAfterDesktopPrint({ success: false, failureReason: "cancelled" })).toBe(false);
  });

  it("uses Chinese failure messages for common print failures", () => {
    expect(printFailureMessage("INVALID_PAGE_RANGE")).toBe("页码范围格式不正确，请输入例如 1,3,5-8。");
    expect(printFailureMessage("PRINT_LOAD_TIMEOUT")).toBe("加载签后 PDF 超时，未执行归档。");
    expect(printFailureMessage("cancelled")).toBe("打印未完成：cancelled");
    expect(printFailureMessage()).toBe("打印未完成，未执行归档。");
  });
});
