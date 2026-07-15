# 工程图纸协同平台重构完成审计

- 审计日期：2026-07-14；公开仓库与主分支整合复核：2026-07-15
- 审计分支：`main`（已累计包含 Phase 0–6）
- 审计范围：Phase 0–6、UI 设计系统、PDF 工作台、业务模块、WebDAV、迁移、Docker/OCI 运行包
- 判定原则：仓库实现、本地容器验收和真实生产上线分别判定，不用本地演练替代生产证据

## 总结

Phase 0–5 的计划内代码、自动化测试和浏览器闭环已完成。Phase 6 的仓库内交付物已经完成：生产配置与文件密钥注入、单一非 root 镜像、通用 Compose、Web/Worker/migration/bootstrap/legacy-migration 入口、SQLite 与文件迁移工具、校验和增量迁移链路。

GitHub 代码仓库已经公开，Phase 0–6 已整合到 `main`。GHCR 镜像已由 GitHub Actions 推送并附带 SBOM/provenance，但容器包当前仍为私有可见性。仓库与镜像可以用于部署准备，但不能声称已经完成正式生产切换；生产完成仍依赖真实域名、正式账号邮箱、目标容器平台、PostgreSQL、S3、SMTP、WebDAV、密钥管理、维护窗口以及故障/恢复证据。

## Phase 0–6 完成矩阵

| 阶段 | 仓库状态 | 直接证据 | 剩余边界 |
| --- | --- | --- | --- |
| Phase 0 质量基线 | 已完成 | 隔离 Playwright 运行时、固定数据、PDF 非空 canvas、桌面/手机、axe 与视觉基线 | 无仓库内阻断 |
| Phase 1 云数据与安全基础 | 已完成 | PostgreSQL、S3、邀请、TOTP、Cookie/CSRF、项目权限、Worker/Outbox 及真实集成测试 | 正式端点与密钥由生产环境提供 |
| Phase 2 UI 设计系统与 AppShell | 已完成 | DS0–DS4、语义令牌、公共组件、统一导航、五视口 Gallery 和无障碍门禁 | 无仓库内阻断 |
| Phase 3 PDF 审阅与标注工作台 | 已完成 | 文档优先三栏、混合批注/问题、撤销重做、长文档按需渲染、问题闭环和审批阻断 | legacy 单实例 SSE 仅属于兼容运行树；platform 生产链路不依赖该入口 |
| Phase 4 审批、PDM 与管理 | 已完成 | `/api/v2` 图纸、并行双审、签章、打印归档、PDM、任务和管理模块闭环 | 无仓库内阻断 |
| Phase 5 WebDAV 受控双向同步 | 已完成 | 真实 HTTP WebDAV、断点下载、哈希回读、冲突队列、删除不传播、重试和同步中心 | 正式凭据与允许主机由生产环境提供 |
| Phase 6 迁移与部署 | 仓库实现和本地容器验收已完成 | 通用 Dockerfile/Compose、只读秘密、迁移五阶段、幂等 delta/verify、非 root 容器和 readiness | 真实生产部署、正式迁移和切换未执行 |

## UI 与用户体验审计

- 视觉方向保持“精密工业、文档优先、高密度、安静、可扫描”，没有引入 Tailwind、shadcn 或第二套 UI 框架。
- DS0–DS5 已覆盖令牌、Actions、Forms、Feedback、Overlay、导航、数据组件和 PDF Studio 专用组件。
- AppShell 当前页、焦点、键盘、reduced motion、错误/空/加载状态和 390px 触控布局都有自动化门禁。
- PDF 工作台在 1440、1100、800、680、390px 下验证画布、缩略图、检查器、问题定位和操作降级；长文档仅渲染有限窗口。
- UI Gallery 固定覆盖 1440×900、1280×800、1024×768、768×1024、390×844，检查横向溢出、控制台错误和 axe serious/critical。

## 当前验证结果

| 门禁 | 结果 |
| --- | --- |
| `npm test -- --run` | 208 个文件，1482 通过，3 项按平台策略跳过 |
| `npm run test:platform:integration` | 35 个文件，365 项全部通过 |
| `npm run e2e:typecheck` | 通过；补齐生产密钥脚本的 `.mjs` 类型声明 |
| `npm run desktop:test` | 3 个文件，12 项全部通过 |
| `npm run build` | 通过，1957 个模块；仅保留既有 PDF.js 531.35 kB chunk 警告 |
| `npm run e2e:ui` | 五个固定视口 5/5 通过 |
| `npm run e2e` | 26 项通过，6 项按桌面/手机能力策略跳过 |
| `npm run e2e:platform` | 5/5 真实 platform 浏览器闭环通过 |
| 生产 Compose 展开 | Web、Worker、migration、legacy-migration、bootstrap-admin 五个入口通过 |
| 最终 OCI 镜像 | `pdf-approval:0.9.2-refactor`，本地镜像 ID `sha256:fde1703fae851623666d55770ab3970b097425a6580a4b49dc92042bc6ac50c4` |
| GHCR 发布 | 已推送 `ghcr.io/limericko/pdf-drawing-approval` 并生成 SBOM/provenance；容器包仍为私有，匿名拉取返回 401 |
| 容器冒烟 | 新库迁移 10/10；Web/Worker 为 UID/GID 10001、只读根、capability 全删除、`no-new-privileges`；readiness 依赖全部 healthy |

## 生产外部门禁

以下输入或证据不在仓库内，缺失时不得标记“Phase 6 正式上线完成”：

1. 旧账号 ID 1 `admin`、ID 2 `supervisor`、ID 3 `process` 的已确认正式邮箱；迁移工具禁止猜测或填占位邮箱。
2. 正式域名、DNS 管理权限、TLS 证书和公网入口。
3. 至少两个故障域的 Docker/OCI 运行资源，以及正式 PostgreSQL、S3、SMTP、WebDAV 和密钥管理参数。
4. GHCR 推送与 SBOM/provenance 已完成；仍需完成正式镜像签名、高危漏洞扫描清零，以及以不可变 digest 部署的证据。
5. 两次脱敏全量迁移演练、最终 delta、逐表/对象/PDF verify 和 Go/No-Go 报告。
6. 真实滚动发布、单实例故障、数据库 PITR、对象恢复、告警送达及 RPO/RTO 证据。
7. 维护窗口、用户公告、Go/No-Go 负责人和回退负责人。

## 提交与镜像结论

仓库内重构任务已达到合并条件。`git diff --check`、Compose 展开、最终镜像构建以及 Web、Worker、migration 容器冒烟已经通过，Phase 0–6 已累计进入 `main`。正式上线仍须完成镜像签名与高危扫描、生产资源部署、正式迁移和恢复演练，并始终使用 GHCR 返回的不可变 digest。
