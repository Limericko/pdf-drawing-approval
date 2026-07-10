# 工程图纸协同平台重构 Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 Windows 局域网 PDF 审批系统分阶段重构为香港云端高可用的工程图纸协同平台，并在每个阶段交付可运行、可验证、可回退的软件。

**Architecture:** 保留 React、TypeScript、Express 和 Electron，采用模块化单体、后台 Worker、PostgreSQL 和对象存储。重构按垂直业务链推进，旧系统持续服务到正式切换窗口；每条新链路通过测试和迁移门禁后删除对应旧分支。

**Tech Stack:** Node.js 24, TypeScript, React 19, Vite 6, Express 4, PostgreSQL, S3-compatible object storage, Electron, Vitest, Supertest, Playwright, Docker Compose.

---

## 1. Planning Scope

本路线图对应：

- `docs/superpowers/specs/2026-07-10-engineering-drawing-collaboration-refactor-design.md`
- `docs/superpowers/specs/2026-07-10-ui-design-system-design.md`

总规格包含七个可以独立交付的子系统。为避免一份数千行计划在前置重构后失真，详细计划按阶段生成：前一阶段验收通过后，读取真实代码和验证结果，再锁定下一阶段的文件与函数签名。

当前已完成并可直接执行的详细计划：

- `docs/superpowers/plans/2026-07-10-refactor-phase-0-quality-baseline.md`

后续计划文件在对应门禁处创建，文件名固定为：

- `2026-07-10-refactor-phase-1-cloud-data-security.md`
- `2026-07-10-refactor-phase-2-ui-system-app-shell.md`
- `2026-07-10-refactor-phase-3-pdf-review-workbench.md`
- `2026-07-10-refactor-phase-4-approval-pdm-modules.md`
- `2026-07-10-refactor-phase-5-webdav-sync.md`
- `2026-07-10-refactor-phase-6-migration-deployment-cutover.md`

这不是“以后再想”的占位方式。每份后续计划有明确输入、输出和生成门禁；只有前置代码落地后，才可能给出可靠的精确行号、类型和测试命令。

## 2. Program Invariants

所有阶段必须遵守：

- 不推翻现有业务规则后重写全部系统。
- 不在同一阶段同时替换 UI、数据库、认证和核心审批状态机。
- 新行为先写失败测试，再实现，再运行目标测试。
- 一个任务只改变一个清晰边界，并创建独立提交。
- 新旧实现共存时必须只有一个写入真相，并记录删除旧分支的条件。
- 数据库变更使用 expand/contract，不在应用切换前执行破坏性删除。
- 文件迁移先校验对象，再更新数据库引用。
- 公网关闭自注册；邀请、MFA、项目权限和审计不能作为上线后补项。
- WebDAV 冲突不能静默覆盖，删除默认不传播。
- 不引入微服务、Kubernetes、Tailwind、shadcn 或第二套 UI 框架。
- 未通过真实浏览器验证，不能声称页面已完成。

## 3. Target File Map

### 3.1 Shared contracts

- `src/shared/contracts/`: API v2 Zod 请求、响应和错误契约。
- `src/shared/presentation/`: 跨端稳定文案或枚举，不包含 React。

### 3.2 Server

- `src/server/platform/config/`: 环境变量解析和启动前校验。
- `src/server/platform/database/`: PostgreSQL pool、事务和迁移入口。
- `src/server/platform/storage/`: 对象存储接口和 S3 实现。
- `src/server/platform/jobs/`: Worker、Outbox、幂等和任务状态。
- `src/server/platform/security/`: 会话、CSRF、MFA、限流和审计中间件。
- `src/server/modules/identity/`: 邀请、用户、项目成员和权限。
- `src/server/modules/tasks/`: 统一任务投影。
- `src/server/modules/documents/`: 图纸、版本、文件和上传隔离。
- `src/server/modules/approvals/`: 审批状态机、决策和签章事件。
- `src/server/modules/issues/`: 混合批注、问题和复核关闭。
- `src/server/modules/pdm/`: 零件、版本、使用关系和发布。
- `src/server/modules/sync/`: WebDAV 连接、同步、冲突和重试。
- `src/server/modules/operations/`: 运维、备份、诊断和审计读取。

### 3.3 Client

- `src/client/styles/`: tokens、reset、globals 和 motion。
- `src/client/ui/`: 无业务基础组件。
- `src/client/patterns/`: AppShell、PageHeader、FilterBar 等组合模式。
- `src/client/features/`: identity、tasks、documents、approvals、issues、pdm、sync、administration。
- `src/client/pdf-studio/`: PDF 画布、工具、缩略图、批注和问题检查器。
- `src/client/api/`: request 基础层和按领域拆分的客户端。
- `src/client/dev/UiGallery.tsx`: 仅开发/测试启用的组件状态页。

### 3.4 Delivery and tests

- `e2e/`: Playwright 环境、fixtures、页面对象和关键流程。
- `migrations/postgres/`: PostgreSQL 迁移。
- `infra/local/`: PostgreSQL、MinIO、WebDAV、ClamAV 和 Mailpit 本地依赖。
- `deploy/`: Dockerfile、生产 Compose、健康检查和滚动发布脚本。
- `scripts/migrate/`: SQLite/文件到 PostgreSQL/对象存储的迁移与校验工具。
- `docs/runbooks/`: 部署、恢复、切换和回滚操作手册。

## 4. Phase Sequence

### Phase 0: Quality Baseline

**Detailed plan:** `2026-07-10-refactor-phase-0-quality-baseline.md`

**Deliverable:** 可重复的 Playwright 环境、固定测试数据、当前登录/导航/审批/PDF/响应式基线和真实浏览器门禁。

**Exit gate:**

- `npm test`、`npm run build`、`npm run desktop:test` 通过。
- Playwright Chromium 桌面与手机项目通过。
- PDF canvas 非空像素检查通过。
- 测试环境不读取或修改真实 `data/`、`output/`、`logs/`。

### Phase 1: Cloud, Data, and Security Foundation

**Plan creation input:** Phase 0 已提供真实关键路径和测试 fixtures；用户已选择具体香港云供应商或明确只执行本地容器阶段。

**Deliverable:**

- 本地 Docker 依赖栈。
- PostgreSQL 连接、迁移和 repository contract 测试。
- S3 对象存储接口。
- 邀请制账号、TOTP MFA、Cookie 会话、CSRF 和项目权限。
- PostgreSQL-backed Worker/Outbox。
- 现有 v1 API 在兼容模式下继续运行。

**Exit gate:** 新认证和平台能力在本地容器环境完成集成测试；旧生产数据尚未迁移，旧生产运行方式不受影响。

### Phase 2: UI Design System and App Shell

**Plan creation input:** Phase 0 浏览器基线和 Phase 1 会话/API 契约稳定。

**Deliverable:**

- DS0 至 DS4。
- 精密工业 tokens 和 CSS Modules 边界。
- 公共 actions、forms、feedback、navigation、overlays 和 data components。
- UI Gallery、Playwright screenshot 和 axe 门禁。
- 统一 AppShell、角色首页、我的任务和问题中心入口。

**Exit gate:** 新 AppShell 可使用 v2 identity/tasks 契约；旧页面可暂时嵌入壳层，但新页面不得使用旧全局组件 class。

### Phase 3: PDF Review Workbench

**Plan creation input:** Phase 2 的 SplitPane、Toolbar、Overlay、Feedback 和视觉门禁稳定；Phase 1 的 issues 数据契约可用。

**Deliverable:**

- 文档优先三栏式 PDF Studio。
- 可编辑标注、撤销/重做、连续标注和保存状态。
- 说明/正式问题混合模式。
- 待处理、处理中、待复核、已关闭闭环。
- 高严重级未关闭时阻断审批通过。
- 页面虚拟化、缩略图延迟加载和 canvas 非空验证。

**Exit gate:** 主管、工艺和设计师通过真实浏览器完成一条完整问题闭环；旧详情页对应逻辑可删除。

### Phase 4: Approval, PDM, and Administration Modules

**Plan creation input:** PDF Studio 和 v2 文档/问题契约稳定。

**Deliverable:**

- 提交、签名定位、并行审核、签章、打印归档迁入模块边界。
- PDM 零件、版本、补录和追溯迁入 v2。
- 统一任务投影和角色首页。
- 用户、权限、诊断、备份和审计页面迁入新设计系统。
- `App.tsx`、`api.ts`、`ApprovalDetailPage.tsx`、`SettingsPage.tsx` 和全局 CSS 的旧职责被拆除。

**Exit gate:** 所有当前核心角色流程在 v2 通过；v1 路由和旧客户端调用点有明确零引用证明。

### Phase 5: WebDAV Controlled Bidirectional Sync

**Plan creation input:** 文档版本、对象存储、任务队列和 PDM 发布事件稳定。

**Deliverable:**

- WebDAV 连接与目录映射。
- ETag/哈希发现、断点下载、隔离扫描和草稿导入。
- 已批准版本发布、临时名写入和校验回读。
- 冲突队列、重试、审计和同步中心 UI。
- 删除不传播规则。

**Exit gate:** WebDAV 测试服务离线、恢复、冲突和重复事件测试通过，且不存在静默覆盖。

### Phase 6: Migration, Deployment, and Cutover

**Plan creation input:** 所有 v2 业务链路完成；香港云供应商、域名、预算、WebDAV 端点和维护窗口已确定。

**Deliverable:**

- 可重复的 SQLite/PostgreSQL 与文件/对象存储迁移工具。
- 数据计数、外键、哈希、PDF 可读性和异常报告。
- 两可用区应用、负载均衡、托管 PostgreSQL、对象存储、WAF 和密钥管理。
- 签名镜像、逐实例滚动发布和回退。
- 迁移演练、故障演练、1 至 2 小时正式切换和稳定观察期。

**Exit gate:** SLO、RPO、RTO、安全、性能、恢复和角色冒烟全部达到总规格验收标准。

## 5. Cross-Phase Verification Matrix

| Gate | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Vitest unit/domain | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| PostgreSQL integration |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Object storage integration |  | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| Browser E2E | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Accessibility/visual | baseline | auth | full shell | PDF | full product | sync center | production smoke |
| Performance | baseline | API | shell | PDF | workflows | backlog | target load |
| Failure/recovery | harness | jobs/session | error boundaries | save/conflict | workflow | offline/retry | instance/DB/backup |
| Security | baseline | identity/files | UI semantics | issue auth | role/project | credentials | DAST/config |

## 6. Commit and Review Policy

每个详细计划任务必须：

1. 写失败测试。
2. 运行并确认失败原因是缺失目标行为。
3. 实现最小可用变更。
4. 运行目标测试和相邻回归。
5. 检查 diff，不保留旧分支或重复实现。
6. 创建单一目的提交。

提交前不运行打包发布、生产迁移、云资源创建或 `git push`。这些动作必须在对应阶段获得明确授权。

## 7. Program Stop Conditions

出现以下情况时停止进入下一阶段：

- Phase 0 无法稳定复现关键路径。
- 新旧数据写入边界不清楚。
- 一条业务链同时依赖未完成的两个数据模型。
- 真实浏览器与源码字符串测试结论冲突。
- 数据迁移报告存在未解释丢失。
- WebDAV 冲突策略被绕过。
- 高危安全问题未清零。
- 故障演练无法达到已确认的 RPO/RTO。

## 8. Immediate Execution

下一步只执行 `2026-07-10-refactor-phase-0-quality-baseline.md`。Phase 0 不改变业务规则、数据库类型、认证方式或生产部署，只为后续重构建立可验证底座。
