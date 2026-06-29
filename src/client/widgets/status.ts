export function statusLabel(status: string) {
  return (
    {
      pending: "待审",
      approved: "通过",
      rejected: "驳回",
      approved_for_print: "已通过待打印",
      printed_archived: "已打印归档",
      filename_invalid: "文件名异常",
      file_missing: "文件已丢失",
      invalid_pdf: "PDF 无效",
      voided: "已作废",
      not_required: "未启用签名",
      placement_required: "待放置签名",
      ready: "待生成签名",
      generated: "签名已生成",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      designer: "设计师",
      supervisor: "主管",
      process: "工艺",
      admin: "管理员"
    }[status] ?? status
  );
}

export function signatureStatusLabel(status: string) {
  return (
    {
      not_required: "未启用签名",
      placement_required: "待放置签名",
      pending: "等待自动签名",
      ready: "待生成签名",
      generated: "签名已生成",
      failed: "签名失败"
    }[status] ?? statusLabel(status)
  );
}
