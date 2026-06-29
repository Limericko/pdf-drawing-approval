# PDF 图纸审批系统第三版实现总结

日期：2026-06-16

## 版本目标

第三版把系统从“可用的局域网审批工具”推进到“可上线试运行的签审闭环系统”。

核心目标：

- 设计师通过网页上传 PDF，不再依赖手工放入目录作为唯一入口。
- 设计师提交时在 PDF 预览上一次性放置设计、主管、工艺三个签名框。
- 主管和工艺并行审核通过后，系统自动生成带三方手写签名的签后 PDF。
- 签后 PDF 生成新文件，不覆盖原审批 PDF。
- 管理员可查看评论、问题、操作日志、CSV 追溯报表、运行诊断和备份记录。

## 保留的系统边界

- 仍然只在公司局域网内部使用。
- 仍然以坚果云本地同步目录作为文件底座，不使用坚果云 API。
- 仍然是固定主管 + 固定工艺并行审核。
- 仍然以 Windows 电脑作为审批服务器优先目标。
- 签名是内部可视手写签名盖章，不是 CA/证书数字签名。

## 主要功能

### 网页上传

新增“提交图纸”页面，设计师和管理员可上传 PDF。

流程：

1. 上传 `零件名-a0A0.pdf`。
2. 系统校验 PDF 文件头。
3. 系统解析零件名和版本。
4. 设计师填写或修正项目名、零件名、版本。
5. 页面加载 PDF 预览。
6. 设计师拖拽和缩放三个签名框。
7. 提交后，系统把文件写入坚果云标准目录 `02-审批中\项目名\`。

后端接口：

```text
POST /api/submissions/upload
POST /api/submissions
```

### 签名资产

新增“我的签名”页面。

每个用户可以：

- 上传 PNG 签名图片。
- 在浏览器中手写签名并保存为 PNG。
- 查看当前生效签名。

管理员可在“系统管理 -> 运维追溯”查看关键用户签名配置状态。

后端接口：

```text
GET /api/signatures/me
GET /api/signatures/me/file
POST /api/signatures/me/upload
POST /api/signatures/me/draw
GET /api/signatures/status
```

### 签名框定位

签名框按归一化比例保存：

- `pageNumber`
- `xRatio`
- `yRatio`
- `widthRatio`
- `heightRatio`

这样可以避免直接保存浏览器像素导致不同缩放比例下错位。系统提交时要求设计、主管、工艺三个签名框齐全。

目录监听提交的历史兼容流程不会在提交瞬间定位签名框。第三版补齐了详情页补录能力：设计师或管理员可在审批详情页打开原始 PDF，补充或调整设计、主管、工艺三个签名框；如果该审批已经通过双审并进入待打印，保存位置后会立即尝试生成签后 PDF。

相关接口：

```text
GET /api/approvals/:id/signature-placements
PUT /api/approvals/:id/signature-placements
```

### 自动生成签后 PDF

主管和工艺都通过后，系统会尝试生成签后 PDF：

1. 检查审批单状态。
2. 检查三个签名框。
3. 检查设计师、主管、工艺三类签名图片。
4. 使用 `pdf-lib` 把 PNG 签名盖到 PDF 指定位置。
5. 生成新 PDF 文件。
6. 计算签后 PDF SHA-256。
7. 写入审批单签名状态和操作日志。

签名失败时：

- `signatureStatus` 变为 `failed`。
- 记录 `signatureError`。
- 管理员可在详情页重试生成。
- 如果失败原因是缺少签名框位置，设计师或管理员可在详情页保存位置后触发重新生成。

相关接口：

```text
GET /api/approvals/:id/signed-file
POST /api/approvals/:id/generate-signed-pdf
```

### 审批详情与打印

审批详情页新增：

- 签名状态。
- 签后 PDF 路径。
- 签后 PDF 打开入口。
- 签名失败原因。
- 管理员签名重试按钮。
- 设计师/管理员签名位置补录和调整入口。
- 评论和问题记录。
- 操作时间线。

打印归档由设计师或管理员执行，优先使用签后 PDF。签名未生成或失败时，页面会显示明确提示，避免误打印未签名版本。归档时系统会把签后 PDF 移动到 `05-已打印归档\项目名\` 并更新审批记录中的签后文件路径；原审批 PDF 不会被签后文件覆盖。历史 `printer` 角色仅保留为旧数据兼容，不再作为新流程入口或默认账号。

### 角色权限

当前第三版角色入口：

- 设计师：提交图纸、查看全部图纸、维护自己的签名、对待打印图纸标记打印归档。
- 主管/工艺：查看待我审核、全部图纸、维护自己的签名。
- 管理员：提交图纸、全部图纸、我的签名、系统管理和异常处理。

设计师不显示“待我审核”，主管和工艺不显示“提交图纸”，系统管理仅管理员可见。

### 评论和问题

审批详情页新增协同记录：

- 普通评论。
- 问题记录。
- 问题解决。

后端接口：

```text
GET /api/approvals/:id/comments
POST /api/approvals/:id/comments
POST /api/approvals/:id/comments/:commentId/resolve
```

相关动作会写入操作日志。

### CSV 追溯报表

管理员可在“系统管理 -> 运维追溯”导出 CSV。

支持筛选：

- 项目名。
- 审批状态。
- 提交起始日期。
- 提交截止日期。

导出字段覆盖：

- 审批基础信息。
- 提交来源和提交人。
- 主管/工艺审核状态与时间。
- 签名状态。
- 原始文件哈希。
- 签后文件哈希。
- 签后文件路径。
- 打印归档时间。
- 最近问题/评论摘要。

接口：

```text
GET /api/reports/approvals.csv
```

### 运维诊断与备份

管理员在“系统管理 -> 运维追溯”可查看：

- 数据库读写状态。
- 监听根目录状态。
- 五个标准目录状态。
- 标准目录写入权限。
- 最近扫描记录。
- 最近备份记录。
- 签名配置概览。
- 服务启动时间。
- 服务日志可读状态。

新增数据库备份入口：

```text
POST /api/system/backup
GET /api/system/backups
```

备份会复制：

```text
data\pdf-approval.sqlite
data\pdf-approval.sqlite-wal
data\pdf-approval.sqlite-shm
```

输出目录：

```text
backups\pdf-approval-yyyyMMdd-HHmmss
```

## 数据库变化

第三版新增或扩展：

- `approvals`：提交人、提交来源、原始哈希、签后文件、签名状态、签名错误。
- `signature_assets`：用户签名资产。
- `signature_placements`：审批单签名框位置。
- `approval_comments`：评论和问题。
- `backup_runs`：备份执行记录。

历史 V1/V2 数据通过 `db.ts` 中的迁移逻辑兼容升级。

## 关键代码位置

后端：

- `src/server/routes/submissions.ts`
- `src/server/routes/signatures.ts`
- `src/server/routes/approvals.ts`
- `src/server/routes/approvalComments.ts`
- `src/server/routes/reports.ts`
- `src/server/routes/system.ts`
- `src/server/services/signingWorkflow.ts`
- `src/server/services/diagnostics.ts`
- `src/server/services/backupService.ts`
- `src/server/pdf/signPdf.ts`

前端：

- `src/client/pages/SubmitDrawingPage.tsx`
- `src/client/widgets/SignaturePlacementEditor.tsx`
- `src/client/pages/MySignaturePage.tsx`
- `src/client/pages/ApprovalDetailPage.tsx`
- `src/client/pages/SettingsPage.tsx`
- `src/client/api.ts`

文档：

- `docs/plans/2026-06-16-v3-design.md`
- `docs/plans/2026-06-16-v3-implementation-plan.md`
- `docs/deploy-windows-lan.md`
- `docs/verification.md`

## 上线前检查

管理员上线前应至少完成：

1. 修改默认账号密码。
2. 设置坚果云审批根目录。
3. 创建标准目录。
4. 重启服务确认监听生效。
5. 配置设计师、主管、工艺用户。
6. 让设计师、主管、工艺分别配置自己的签名。
7. 在“运维追溯”确认系统健康诊断正常。
8. 手动执行一次备份。
9. 完成一张真实 PDF 的端到端签审测试。

## 已知限制

- 未实现 CA/证书数字签名。
- 未实现项目级动态审核人配置。
- 未实现管理员代管他人签名。
- 在线手写签名质量取决于鼠标、触控板或触摸屏。
- 真实坚果云同步仍建议现场按实际网络和同步客户端做一次新增、删除、归档验证。
- 第三版自动化测试覆盖核心链路，但签名视觉位置仍需要用真实图纸人工确认。

## 2026-06-17 后续加固

第三版初步可用后，根据试用反馈继续补齐了一批上线前硬化项。

### 权限与入口

- 设计师默认进入“提交图纸”，不再显示“待我审核”。
- 主管和工艺默认进入“待我审核”，不再显示“提交图纸”。
- 打印归档由设计师或管理员执行，不再使用独立打印角色。
- 用户管理不再允许新增或分配 `printer` 角色，历史 `printer` 仅保留兼容。

### PDF 预览与签名框

- 提交页 PDF 预览区改为可滚动，避免大图纸超出屏幕后看不全。
- 签名框最小尺寸和标签字号下调，便于放置到较小图框签字栏。
- 签名框位置跟随 PDF 页面滚动，不再出现 PDF 滚动后签名框留在原屏幕位置的问题。
- 签名框支持多页 PDF 页码切换，位置继续按页面归一化比例保存。
- 协同、时间线和历史版本拆为可移动浮窗，右侧栏保留主要操作按钮，避免时间线挤占图纸阅读空间。

### 签名与归档

- 设计师和管理员可在审批通过后重新生成签后 PDF，用于调整签名位置后重新出图。
- 重新生成签后 PDF 会使用最新签名框位置和当前用户签名资产。
- 标记打印归档时，签后 PDF 会移动到 `05-已打印归档\项目名\`，并更新审批记录中的 `signed_file_path`。
- 签名失败会保留失败原因，并要求管理员或设计师补齐签名、签名框或文件状态后再重试。

### 删除图纸与文件清理

- 管理员可在“全部图纸”中单个或批量删除图纸。
- 删除会清理审批记录、签名框、评论、原始 PDF、当前流转 PDF 和签后 PDF。
- 同一图纸版本的历史签后文件也会清理，例如：

```text
零件名-a0A0-签审.pdf
零件名-a0A0-签审-2.pdf
零件名-a0A0-签审-10.pdf
```

- 删除只匹配同一零件名和同一版本，不会误删其它版本如 `a1A0`。
- 删除文件成功后才删除数据库记录，避免记录已删但文件残留。
- 如果项目文件夹已经为空，会删除对应的 `状态目录\项目名` 空文件夹；如果目录中还有其它文件或其它版本，则保留。

### 运维追溯

- CSV 追溯报表增加最近问题/评论摘要。
- 系统诊断增加服务启动时间和服务日志可读状态。
- 管理端兼容旧诊断响应，服务未重启时不会因为缺少新字段导致页面白屏。

### 当前验证基线

截至 2026-06-17，本地验证结果：

```text
npm test      -> 42 个测试文件，180 个测试通过
npm run build -> TypeScript 与 Vite 生产构建通过
GET /health   -> {"ok": true}
```

第三版仍需要在真实坚果云同步目录和真实机械图纸上完成一次现场端到端试运行，重点确认签名视觉位置、打印流程和文件同步延迟。
