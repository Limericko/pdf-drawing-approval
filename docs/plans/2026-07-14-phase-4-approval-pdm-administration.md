# Phase 4 审批、PDM 与管理模块实施计划

- 日期：2026-07-14
- 状态：已完成，待提交/评审
- 分支：`codex/phase-4-approval-pdm-admin`
- 基线提交：`e2fe81c`
- 前置门禁：Phase 0–3 已完成
- 产品方向：统一云端、文档优先、精密工业、高密度、安静、可扫描

## 目标

把仍运行在 legacy SQLite、单体 `api.ts` 和巨型页面中的审批、PDM、任务投影与系统管理能力迁入 PostgreSQL `/api/v2` 模块边界和统一平台工作区。迁移必须保留提交、签名定位、主管/工艺并行审核、签章、打印归档、PDM 发布/补录/追溯、用户权限、诊断、备份和审计能力，并为 Phase 5 WebDAV 与 Phase 6 数据迁移/切换提供稳定契约。

## 当前状态审计

### 已有基础

- PostgreSQL 平台已具备邀请制账号、TOTP、恢复码、Cookie/CSRF 会话、项目成员与能力、审计、Outbox、Job、Worker、对象存储和健康检查。
- Phase 2 已交付 DS0–DS4、统一 AppShell、公共表单/反馈/导航/数据组件和五视口 Gallery 门禁。
- Phase 3 已交付 PDF Studio、正式问题闭环、高严重级阻断、长文档按需渲染和 DS5。
- legacy 仍完整保留现有业务能力和回归测试，可作为迁移期行为基线。

### 已证实缺口

| 范围 | 当前证据 | Phase 4 要求 |
| --- | --- | --- |
| PostgreSQL schema | migration 仅有 `0001–0007` 身份/存储/任务基础表 | 增加文档、版本、审批、决策、签名、产物、归档、问题、PDM 与备份记录 |
| `/api/v2` | 平台服务只挂载 identity routes | 增加 tasks/documents/approvals/issues/parts/administration 路由 |
| 前端数据访问 | `api.ts` 1278 行，业务页直接依赖 | 按领域拆为共享 request + domain clients |
| 平台工作区 | 登录后仅有项目访问/邀请演示页 | 统一角色首页、任务、图纸、PDM、管理导航和路由 |
| 审批详情 | `ApprovalDetailPage.tsx` 1832 行 | PDF Studio 外职责拆入 approval/signature/print/PDM feature |
| 系统管理 | `SettingsPage.tsx` 968 行、状态与动作集中 | 拆成 users/access/operations/backup/audit/settings 模块 |
| 应用装配 | `App.tsx` 597 行并持有 legacy token、路由、更新和签名门禁 | 平台装配与 legacy compatibility entry 分离 |
| PDM | 仅 SQLite `pdm_*` 表和 legacy routes | PostgreSQL 权威版本关系、不可变发布和补录/追溯 API |
| 任务投影 | `MyTasksPage` 只查询待审 approval | 汇总审核、问题、PDM 补录、失败任务和管理告警 |

## 阶段边界

- Phase 4 包含审批、PDM、角色任务与管理模块，不包含 WebDAV 协议实现；WebDAV 连接、冲突和双向同步属于 Phase 5。
- Phase 4 不执行正式 SQLite/文件迁移和生产域名切换；迁移工具、演练和切换属于 Phase 6。
- legacy 运行时在迁移期作为显式 compatibility entry 保留，但 platform runtime 不得再引用 legacy token、legacy `/api` 或单体 `api.ts`。
- PostgreSQL 中发布后的图纸版本不可原地修改；对象内容只通过 `storage_objects` 引用。
- 主管和工艺继续并行审核；两个决定都通过后才可进入签章/PDM 发布。

## Task 1：验收矩阵与 RED 门禁

1. 固化设计师、主管、工艺、管理员四类角色的当前核心路径。
2. 为数据库约束、项目隔离、并行审核、版本发布、任务排序、管理危险操作和旧引用清理建立 RED 测试。
3. 把每个路线图交付项映射到代码、测试和真实浏览器证据。

退出条件：没有只靠源码字符串或单一快照证明的核心流程。

## Task 2：PostgreSQL 业务 schema 与共享契约

新增 migration，建立：

- `documents`、`drawing_revisions`、`approval_cases`、`review_decisions`。
- `signature_placements`、`render_artifacts`、`print_archive_events`。
- `annotations`、`issues`、`issue_events`，补齐 Phase 3 的平台持久化前置。
- `parts`、`part_revision_links`、`part_usages` 与 current/effective revision 约束。
- `backup_runs` 与管理状态投影所需视图。

共享 Zod 契约统一分页、排序、错误码、项目 ID、幂等键、版本号和日期格式。所有业务表带项目边界、不可变历史或乐观并发字段；权限只授予 `platform_web` 必要列。

退出条件：migration、schema、权限、并发和跨项目访问集成测试通过。

## Task 3：文档提交与对象存储模块

- `modules/documents` 提供项目内图纸草稿、文件校验、对象登记、元数据确认和提交。
- 上传先进入隔离对象；PDF 头、大小、哈希和文件名校验通过后才创建 revision。
- 提交使用幂等键，文档编号+版本在项目内唯一。
- 签名位置在提交前验证三角色完整性和标准化坐标。
- 批量提交返回逐项结果，不因单项失败回滚其他合法项。

退出条件：单项/批量、重复、伪 PDF、超限、跨项目和失败清理测试通过。

## Task 4：并行审批、签章与打印归档模块

- `modules/approvals` 建立 supervisor/process 两条独立 decision。
- 审核写入不可变事件与统一 audit；拒绝说明和高严重级阻断规则保持一致。
- 双审通过后通过 Outbox 触发签章/PDM 发布，不在 HTTP 请求内执行重型 PDF 工作。
- render artifact 明确 pending/ready/failed；重试幂等且不可覆盖历史对象。
- Electron 打印桥接只提交受控归档结果，服务端记录对象、操作者、打印机和时间。

退出条件：状态机、并发双审、重复请求、失败重试、签章产物和打印归档边界通过领域/集成测试。

## Task 5：问题平台化与统一任务投影

- 把 Phase 3 问题/批注契约迁入 PostgreSQL 模块，保持原子创建、幂等、乐观锁和复核闭环。
- `modules/tasks` 统一投影待审核、待处理问题、待复核、PDM 补录、失败产物、失败任务和管理告警。
- 任务按阻塞程度、严重级、到期时间和创建时间稳定排序。
- 角色首页只查询与当前项目成员能力相符的任务，不泄漏其他项目计数。

退出条件：四角色任务集合、排序、项目隔离和空/错误/加载状态测试通过。

## Task 6：PDM 零件、版本、补录和追溯模块

- `modules/pdm` 管理 parts、revision links、usages、current/effective revision 和 approval source link。
- 只有已批准且对象已就绪的 revision 可发布；已发布版本不可原地修改或替换对象。
- 缺失物料号/图号进入补录任务，保存后可幂等重试发布。
- 零件详情提供当前版本、完整版本历史、使用项目、原始/审查/签后对象入口和审计时间线。
- 管理员作废版本必须填写原因并保留历史，不能静默删除。

退出条件：发布唯一性、补录、重试、追溯、作废、跨项目可见性和并发测试通过。

## Task 7：Administration v2 模块

- 用户与访问：邀请、禁用、项目成员角色、会话撤销和 MFA 状态；不恢复公开注册。
- 诊断：数据库、对象存储、Worker、邮件、队列积压、失败任务和版本信息。
- 备份：记录托管 PostgreSQL/PITR 与对象存储备份检查结果；危险操作带原因、二次确认和审计。
- 审计：按操作者、项目、动作、结果、时间筛选，敏感值脱敏。
- 系统设置：只保留云端运行所需非密钥配置；密钥不进入普通设置表或响应。

退出条件：管理员权限、最后管理员保护、并发禁用、重试、审计和脱敏测试通过。

## Task 8：前端领域客户端与平台工作区

- 新增 `taskClient`、`documentClient`、`approvalClient`、`annotationClient`、`pdmClient`、`adminClient`。
- `platformRequest` 继续统一 Cookie、CSRF、request ID、取消、响应上限和 Problem Details。
- 登录后进入统一 AppShell；导航由 global/project capabilities 计算。
- 项目切换是稳定工作上下文，路由切换取消旧请求并清除项目敏感状态。
- 角色首页、任务中心、问题中心、图纸中心、PDM 和管理页共享 PageHeader、FilterBar、DataTable、StatusChip、Skeleton、EmptyState 和 ErrorState。

退出条件：platform runtime 对 legacy `api.ts`、Bearer token 与 `/api` 为零引用。

## Task 9：审批/PDM/管理页面垂直迁移

- 提交页迁移上传、元数据、签名定位和批量提交。
- 审批列表迁移服务端分页、筛选、排序和批量动作。
- PDF Studio 接 v2 approval/annotation/issue clients，保持 Phase 3 交互与性能门禁。
- PDM 列表、详情、补录迁移 v2 数据与对象入口。
- 管理端拆分为用户与访问、运行状态、备份、审计和系统设置独立 feature。

退出条件：每条迁移链路完成“新调用点 → 浏览器验证 → 删除旧调用点”，不保留双写或两套真相。

## Task 10：巨型文件与旧样式职责拆除

- `App.tsx` 只保留 legacy compatibility 装配；平台路由独立。
- 单体 `api.ts` 只供 compatibility runtime，platform build 无引用。
- `ApprovalDetailPage.tsx` 拆除提交/签名/打印/PDM/问题数据编排职责。
- `SettingsPage.tsx` 拆成独立管理 feature，不再持有全部状态和动作。
- 删除迁移完成后的旧全局业务 class、硬编码颜色、任意 z-index、重复状态映射和无引用组件。

退出条件：依赖边界测试、静态扫描和 bundle 扫描证明 platform runtime 不包含 legacy 业务分支。

## Task 11：真实角色闭环与最终门禁

真实浏览器闭环至少覆盖：

1. 管理员创建项目、邀请四类项目成员并查看安全/运行状态。
2. 设计师上传 PDF、确认元数据和签名位置并提交。
3. 主管与工艺从统一任务入口并行审核，包含正式问题退回/复核。
4. 双审通过后 Worker 生成产物并发布 PDM 版本。
5. 设计师补录缺失元数据并重试发布。
6. 管理员查看审计、失败任务、备份状态并执行受审计的恢复性操作。
7. Electron 打印桥接记录归档事件。

固定视口：1440×900、1280×800、1024×768、768×1024、390×844。验证控制台、溢出、遮挡、键盘焦点、reduced motion、axe 和 PDF 非空 canvas。

最终命令至少包含：

```powershell
npm test -- --run src/client src/server/modules src/server/platform src/shared/contracts
npm run test:platform:integration
npm run e2e:typecheck
npm run build
npm run desktop:test
npm run e2e:ui
npm run e2e
npm run e2e:platform
git diff --check
```

最终扫描：

- platform runtime 对 legacy `/api` 和 `api.ts` 引用为 0。
- 新代码硬编码颜色、任意数值 z-index、调试输出为 0。
- 已迁移旧页面/路由/选择器引用为 0。
- PostgreSQL schema、对象引用和项目边界有直接集成证据。
- 文档记录真实测试数量、截图、性能数据和未完成边界。

## 完成判定

只有 Task 1–11 均有当前代码、数据库、自动化测试和真实浏览器证据，且不存在双写、跨项目泄漏、静默覆盖或未审计高风险操作时，Phase 4 才可标记完成。

## 验收证据（2026-07-14）

### 已交付闭环

| 范围 | 当前实现与证据 |
| --- | --- |
| PostgreSQL 业务模型 | `0008_business_approval_pdm_admin.sql` 建立审批、问题、签名、产物、打印归档、PDM 与备份关系；schema、权限、跨项目外键和不可变发布约束均有真实 PostgreSQL 集成测试。 |
| 文档与审批 | 平台工作区完成 PDF 上传、对象登记、三角色签名定位、提交、正式问题、高严重级阻断、主管/工艺并行双审与 Worker 签章。 |
| PDM | 双审后自动发布；支持缺失物料信息补录、失败重试、版本作废、版本历史以及原始/审查/签后 PDF 入口。 |
| 管理模块 | 用户状态、会话撤销、项目成员、诊断、失败任务原因化重试、备份记录和审计查询全部走 `/api/v2`。 |
| 打印归档 | Windows 桌面客户端打印签后 PDF，并由 v2 服务记录打印归档事件和历史。 |
| 对象生命周期 | 业务表只能引用 ready 对象；24 小时未引用 ready 对象由 Worker 转入 `delete_pending`，覆盖图纸、签名、产物与打印归档引用。 |
| 移动端可用性 | 390×844 下账户身份与“退出登录”入口保持可发现、可键盘操作；桌面侧栏用户卡片不变，并更新两张有意变化的移动端视觉基线。 |

### 自动化门禁

- `npm test`：191 个测试文件，1402 通过，1 个按既定策略跳过。
- `npm run test:platform:integration`：31 个测试文件，350 通过。
- `npm run desktop:test`：3 个测试文件，12 通过。
- `npm run e2e:typecheck`：通过。
- `npm run build`：通过，1953 个模块完成生产构建。
- `npm run e2e:ui`：1440×900、1280×800、1024×768、768×1024、390×844 五视口全部通过。
- `npm run e2e`：26 通过，6 个按桌面/移动能力策略跳过；PDF 非空 canvas、无障碍、溢出和视觉基线通过。
- `npm run e2e:platform`：桌面身份、项目/会话/业务以及移动端身份共 5 条真实闭环全部通过；真实业务链路覆盖三角色登录、上传、问题处理、并行双审、签章、PDM 发布和打印归档。

### 边界扫描

- 以 `PlatformIdentityApp.tsx` 为入口的独立 import graph：legacy `api.ts` 输入 0，legacy `App.tsx` 输入 0。
- 平台入口 Bearer/Authorization 运行时字符串 0；25 个 API 路径全部属于 `/api/v2`。
- 新平台客户端、身份和工作区代码：硬编码颜色 0、数字 z-index 0、调试输出 0。

### 后续阶段边界

- Phase 5：WebDAV 云端双向同步、冲突策略与同步运维面。
- Phase 6：旧 SQLite/文件正式迁移、香港云服务器演练、灰度切换与持续可用部署。
- 本阶段未同步或部署到 `E:\PDF服务端`，也未执行生产数据迁移。
