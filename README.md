# 工程图纸协同平台

面向中型工程团队的云端 PDF 审阅、标注、并行审批与 PDM 协同平台。办公室和异地用户通过同一 HTTPS 域名登录；生产业务数据统一存放在 PostgreSQL 与 S3 兼容对象存储中，WebDAV 仅作为受控文件交换端。

> 最新完整重构代码位于 [`codex/phase-6-hk-cloud-deployment`](https://github.com/Limericko/pdf-drawing-approval/tree/codex/phase-6-hk-cloud-deployment)。默认 `main` 暂时保留 0.9.2 局域网基线，正式合并前请使用 Phase 6 分支和下方不可变镜像。

## 当前状态

| 范围 | 状态 |
| --- | --- |
| Phase 0–5：质量、安全、UI、PDF、审批/PDM、WebDAV | 已完成并通过自动化与浏览器验收 |
| Phase 6：通用 Docker/OCI、密钥注入、旧数据迁移工具 | 仓库实现和本地容器验收已完成 |
| 正式生产切换 | 等待域名、正式账号邮箱、云资源和恢复演练 |

完整证据见 [重构完成审计](https://github.com/Limericko/pdf-drawing-approval/blob/codex/phase-6-hk-cloud-deployment/docs/refactor-completion-audit.md)。

## 核心能力

- 文档优先三栏式 PDF 工作台：缩略图、连续标注、撤销/重做、正式问题和响应式审阅。
- 设计师、主管、工艺并行双审：高严重级问题阻断、签章、打印归档和完整审计。
- PDM：零件、版本、补录、发布、作废与原始/审阅/签后文件追溯。
- 公网安全登录：邀请制账号、TOTP MFA、Cookie/CSRF 会话和项目级权限。
- 云端与 WebDAV 受控双向同步：哈希校验、冲突队列、有限重试和删除不传播。
- PostgreSQL、S3 兼容对象存储、后台 Worker/Outbox，以及云厂商无关的 Docker/OCI 运行包。
- 保留 Windows 局域网兼容模式，作为迁移来源与必要回退路径。

## 拉取生产镜像

镜像位于私有 GitHub Container Registry。登录令牌需要 `read:packages` 权限，并且账号必须有本仓库访问权。

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u Limericko --password-stdin

docker pull ghcr.io/limericko/pdf-drawing-approval@sha256:70844d80005dd1360e8db4f655e45c36d24b9d4d6b22541a208f5b435a6cf1b4
```

生产环境使用不可变 digest：

```text
PDF_APPROVAL_IMAGE=ghcr.io/limericko/pdf-drawing-approval@sha256:70844d80005dd1360e8db4f655e45c36d24b9d4d6b22541a208f5b435a6cf1b4
```

镜像由 [GitHub Actions 发布流程](https://github.com/Limericko/pdf-drawing-approval/actions/workflows/publish-container.yml) 构建，并附带 SBOM 与 provenance。

## 获取完整重构代码

```bash
git clone git@github.com:Limericko/pdf-drawing-approval.git
cd pdf-drawing-approval
git switch codex/phase-6-hk-cloud-deployment
```

生产部署入口：

- [通用 Docker/OCI 运行说明](https://github.com/Limericko/pdf-drawing-approval/blob/codex/phase-6-hk-cloud-deployment/deploy/README.md)
- [生产 Compose](https://github.com/Limericko/pdf-drawing-approval/blob/codex/phase-6-hk-cloud-deployment/deploy/compose.production.yaml)
- [生产迁移与切换手册](https://github.com/Limericko/pdf-drawing-approval/blob/codex/phase-6-hk-cloud-deployment/docs/runbooks/phase-6-production-cutover.md)

## 技术栈

- Node.js 24、TypeScript、Express、React 19、Vite
- PostgreSQL、S3 兼容对象存储、WebDAV、SMTP
- Electron 与 Windows legacy 兼容运行模式
- Vitest、Supertest、Playwright
- Docker Compose / OCI

## 开发与验证

切换到 Phase 6 分支后：

```powershell
npm ci
npm run infra:up
npm test
npm run test:platform:integration
npm run build
npm run e2e:ui
npm run e2e
npm run e2e:platform
```

本地依赖栈包含 PostgreSQL、MinIO 和 Mailpit。真实生产配置和秘密不得提交到 Git。

## 部署边界

本项目支持普通 Linux 云服务器、托管容器平台、Nomad 或 Kubernetes 等标准 Docker/OCI 环境。中国香港可以作为部署区域，但应用不依赖阿里云 SDK、Registry、OSS、KMS 或特定负载均衡产品。

本地镜像和测试环境的成功不等于正式上线。完成生产切换前仍必须取得正式迁移、镜像签名、滚动发布、故障切换、备份恢复、RPO/RTO 和角色冒烟证据。
