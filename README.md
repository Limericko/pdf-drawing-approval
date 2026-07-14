# 工程图纸协同平台

面向中型工程团队的云端 PDF 审阅、标注、并行审批与 PDM 协同平台。办公室和异地用户通过同一 HTTPS 域名登录；生产业务数据由 PostgreSQL 与 S3 兼容对象存储统一承载，WebDAV 只作为受控文件交换端。

仓库同时保留原 Windows 局域网运行模式，作为迁移来源、兼容基线和可回退路径；公网生产入口使用独立的 platform 运行模式、邀请制账号、TOTP MFA、Cookie/CSRF 会话和项目权限，不能使用 legacy 默认账号或自注册链路。

当前固化版本：`0.9.2`

## 主要能力

- 文档优先三栏式 PDF 工作台，支持缩略图、连续标注、撤销/重做、正式问题和响应式审阅。
- 设计师、主管、工艺并行双审，支持高严重级问题阻断、签章、打印归档和完整审计。
- PDM 零件、版本、补录、发布、作废与文件追溯。
- PostgreSQL、S3 兼容对象存储、后台 Worker/Outbox 和项目级权限。
- 云端与 WebDAV 受控双向同步，包含哈希校验、冲突队列、重试和删除不传播。
- 单一 Docker/OCI 镜像提供 Web、Worker、数据库迁移、旧数据迁移和首管理员引导入口。
- 保留 Electron 客户端和 Windows 局域网兼容运行方式，供迁移前及必要回退使用。

## 技术栈

- Node.js 24
- TypeScript
- Express
- React + Vite
- PostgreSQL + S3 兼容对象存储（platform）
- 内置 `node:sqlite`（legacy 兼容与迁移来源）
- Electron
- Vitest / Supertest / Playwright
- Docker Compose / OCI

## 本地开发

```powershell
npm install --registry=https://registry.npmmirror.com
npm run dev
```

默认访问：

- Web/API：`http://127.0.0.1:8080`

## 常用验证

```powershell
npm test
npm run test:platform:integration
npm run build
npm run desktop:test
npm run e2e:ui
npm run e2e
npm run e2e:platform
```

本地 PostgreSQL、MinIO 和 Mailpit 依赖见 `infra/local/README.md`。

## 云端生产镜像

根级 `Dockerfile` 与 `deploy/compose.production.yaml` 是云厂商无关的生产入口，可部署到任何标准 Linux Docker/OCI 环境。部署必须使用 Registry 中的不可变镜像 digest；正式域名、数据库、对象存储、SMTP、WebDAV、密钥和维护窗口由目标环境提供。

本地构建示例：

```powershell
docker build --pull=false -t pdf-approval:0.9.2-refactor .
```

完整配置、密钥注入、迁移和切换步骤见 `deploy/README.md` 与 `docs/runbooks/phase-6-production-cutover.md`。

## 打包发布

```powershell
npm run installer:package
```

打包流程会生成客户端、服务端安装包和更新清单。当前真实运行服务端的发布同步目录为：

```text
E:\PDF服务端\pdf-approval\releases
```

## 仓库边界

首次提交只保留源码、测试、文档、脚本和图标资源。以下内容不进入 Git：

- `node_modules/`
- `dist/`
- `data/`
- `backups/`
- `logs/`
- 根目录 `test/` 图纸工作区
- 本地配置、数据库、安装包、缓存、运行日志和 PID 文件

## 关键文档

- `docs/refactor-completion-audit.md`：Phase 0–6 最终完成矩阵与生产外部门禁
- `deploy/README.md`：通用 Docker/OCI 生产运行包
- `docs/runbooks/phase-6-production-cutover.md`：迁移、切换和回退手册
- `docs/user-manual.md`：各角色使用说明书
- `docs/deploy-windows-lan.md`：Windows 局域网部署说明
- `docs/desktop-client-admin-guide.md`：客户端/更新管理说明
- `docs/verification.md`：阶段验证记录
- `docs/plans/2026-06-29-pdm-plm-roadmap.md`：PDM/PLM 后续路线图
