import type { Approval, User } from "../api.ts";
import type { DesktopPrintResult } from "../printSettings.ts";

export function canUseNativePrintForApproval(
  user: Pick<User, "role">,
  approval: Pick<Approval, "status">,
  signedPdfReady: boolean,
  desktopClient: boolean
) {
  if (!desktopClient) return false;
  if (approval.status !== "approved_for_print") return false;
  if (!signedPdfReady) return false;
  return user.role === "designer" || user.role === "admin";
}

export function shouldArchiveAfterDesktopPrint(result: DesktopPrintResult) {
  return result.success === true;
}

export function printFailureMessage(reason?: string) {
  if (!reason) return "打印未完成，未执行归档。";
  if (reason === "INVALID_PAGE_RANGE") return "页码范围格式不正确，请输入例如 1,3,5-8。";
  if (reason === "PRINT_LOAD_TIMEOUT") return "加载签后 PDF 超时，未执行归档。";
  if (reason === "DESKTOP_PRINT_UNAVAILABLE") return "当前不是客户端原生打印环境，请打开签后 PDF 后手动打印。";
  return `打印未完成：${reason}`;
}
