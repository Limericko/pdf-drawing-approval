# Phase 6 迁移演练记录

## 2026-07-14 第一次真实只读盘点

来源：`E:\PDF服务端\pdf-approval\data\pdf-approval.sqlite` 的在线 SQLite backup API 一致副本。运行服务未停止，源数据库未修改。

- 快照大小：245,760 字节。
- 快照 SHA-256：`95f848fd6bb6807b2220d46a4922f4726379825eeb24e3a148bc156967650a7f`。
- SQLite `quick_check`：通过。
- 外键违规：0。
- 用户：4 个，全部处于活动状态。
- 重复规范化邮箱：0。
- 活动账号缺少邮箱：3 个，属于正式公网邀请和 MFA 前的阻断项。
- 项目/审批：当前快照为 0。
- 去重后的文件引用：1 个，为签名资产引用；文件存在性和内容哈希将在文件 preflight 阶段验证。
- `approval_issues`、`approval_issue_events` 未出现在旧库中。二者属于后续新增且当前无历史数据的功能表，按零数据警告处理，不伪造记录。

首次盘点报告保存在工作区忽略目录 `.cache/phase6-drill/`，不进入 Git。报告只含计数、问题代码、数字 ID 样本和哈希，不含密码哈希、SMTP 密码、签名图像或 PDF 内容。

文件 preflight 已对 E 盘数据目录的只读副本执行：1 个引用、1 个唯一文件、4,726 字节，路径边界、普通文件、大小、SHA-256 和 PNG 解码全部通过，阻断项为 0。当前数据库没有 PDF 引用，因此本轮没有可执行的 PDF 页面渲染证据；正式迁移样本出现 PDF 后，除 `pdf-lib` 解析外还必须使用 Poppler 对首末页及抽样页渲染检查。

## 必须整改

1. 为 3 个缺邮箱的活动账号确认唯一、可收信的正式邮箱；迁移工具不会猜测或自动生成公网身份。
2. 旧 SQLite 配置中存在明文 SMTP 应用密码。正式上线前必须在邮件服务商侧撤销旧密码、生成新应用密码，并只写入 KMS Secrets Manager。
3. 正式切换前重新创建在线快照并执行 `inventory`、文件 `preflight`、全量 `import`、`verify` 和最终 `delta`；本次结果只是演练基线。

## 2026-07-14 迁移闭环实现进展

- PostgreSQL 已增加迁移运行、稳定旧 ID 映射和文件版本映射表。
- `legacy-migration` 容器入口已串联 `inventory → file preflight → import/delta → verify`。
- 文件导入在登记数据库前执行写入结果、HEAD 大小和 GET 全量 SHA-256 回读校验。
- 同一快照重复导入会复用稳定对象与业务 ID；本地 PostgreSQL + 文件对象存储的 `import → delta` 集成演练已通过。
- 旧密码只用于生成不可登录的禁用标记，不作为公网密码迁移；账号以 `disabled`、MFA 未启用状态进入新平台。

真实旧库仍因 3 个活动账号缺少已确认邮箱而禁止正式 import。代码和本地脱敏演练完成不等于真实数据迁移完成。

## 命令

```powershell
npm run migration:legacy:snapshot -- --source "<absolute-live-sqlite>" --target "<absolute-new-snapshot>"
npm run migration:legacy:inventory -- --database "<absolute-snapshot>" --source-id legacy-production-e-drive --output "<absolute-new-report.json>"
npm run migration:legacy:files -- --database "<absolute-snapshot>" --roots "<absolute-root-mapping.json>" --output "<absolute-new-file-report.json>"
```

快照和报告目标必须不存在；工具拒绝覆盖，避免把上一轮证据静默替换。
