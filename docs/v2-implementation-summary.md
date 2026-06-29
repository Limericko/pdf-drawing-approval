# PDF 图纸审批系统第二版实现总结

日期：2026-06-16

## 目标

第二版在第一版可运行审批流程基础上，补齐管理端修复、审计、扫描、邮件测试和备份能力，让管理员不用直接改数据库即可处理常见异常。

## 新增状态

- `invalid_pdf`：扩展名是 PDF，但文件内容不是有效 PDF。
- `voided`：管理员确认该审批单不再参与流程。

现有异常状态仍保留：

- `filename_invalid`：文件名不符合 `零件名-a0A0.pdf` 规则。
- `file_missing`：审批中的文件在服务器上不存在。

这些异常状态不会进入主管和工艺待办队列，但会保留在全部图纸和详情页中，便于追踪和修复。

## 管理端修复流程

审批详情页新增“异常处理”区域：

- `file_missing`：可重新绑定服务器上的有效 PDF，或作废。
- `invalid_pdf`：可替换 PDF、重新校验当前文件，或作废。
- `filename_invalid`：可作废。

重新绑定会校验：

- 文件存在。
- 文件在当前 `watch_root` 目录内。
- 文件头包含 `%PDF-`。

修复成功后审批单回到 `pending`，重新进入并行审核流程。

## 操作审计

新增 `operation_logs` 表和查询页面。

已记录的关键动作包括：

- 审批单创建。
- 主管/工艺审核。
- 进入待打印。
- 标记已打印。
- 文件丢失。
- 文件重新绑定。
- PDF 重新校验。
- 作废审批。
- 用户新增、更新、重置密码。
- 手动扫描。
- SMTP 测试。
- 服务重启请求。

详情页显示当前审批单时间线；系统管理页显示全局操作日志。

## 手动扫描

系统管理页新增“立即重新扫描”：

- 补偿坚果云同步或 watcher 漏掉的新增 PDF。
- 扫描 pending 审批单的当前文件路径，标记丢失文件。
- 统计处理数、丢失数、无效 PDF 数。
- 结果写入 `scan_runs` 表。

## SMTP 测试

系统管理页新增 SMTP 测试邮件：

- 使用当前 SMTP 配置向指定收件人发送测试邮件。
- 成功和失败都会写入操作日志。
- 自动化测试中使用注入 transport，不会发送真实外部邮件。

## 备份

新增脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1
```

默认备份：

- `data\pdf-approval.sqlite`
- `data\pdf-approval.sqlite-wal`
- `data\pdf-approval.sqlite-shm`

输出目录：

```text
backups\pdf-approval-yyyyMMdd-HHmmss
```

## 主要代码位置

后端：

- `src/server/routes/approvals.ts`
- `src/server/routes/operationLogs.ts`
- `src/server/routes/settings.ts`
- `src/server/routes/system.ts`
- `src/server/repositories/approvals.ts`
- `src/server/repositories/operationLogs.ts`
- `src/server/repositories/scanRuns.ts`
- `src/server/files/watchSubmissions.ts`
- `src/server/notifications/email.ts`

前端：

- `src/client/api.ts`
- `src/client/pages/ApprovalDetailPage.tsx`
- `src/client/pages/ApprovalsPage.tsx`
- `src/client/pages/SettingsPage.tsx`
- `src/client/widgets/status.ts`
- `src/client/styles.css`

脚本与文档：

- `scripts/backup-database.ps1`
- `docs/deploy-windows-lan.md`
- `docs/verification.md`

## 验证摘要

最新全量验证：

```powershell
npm test
npm run build
powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1
```

结果：

- 自动化测试通过：15 个测试文件，66 个测试。
- 生产构建通过。
- 备份脚本生成备份目录并复制 SQLite/WAL/SHM 文件。
- 浏览器烟测覆盖登录、系统管理、操作日志、异常详情页修复面板和时间线。

## 已知限制

- 当前仍是固定主管和固定工艺并行审核模型。
- 备份脚本需要在项目目录执行，或显式传入数据库路径。
- Windows 系统弹窗选目录仍不是主推荐方式，建议使用“浏览服务器目录”。
- SMTP 测试依赖真实 SMTP 配置；自动化测试不会触发真实邮件。
