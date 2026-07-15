# 通用生产运行包

只有一台 Linux 云服务器并希望降低维护复杂度时，使用 [单机完整版](single-node/README.md)。它内置 PostgreSQL、MinIO、自动 migration、备份和统一运维命令；Web 监听端口可配置，HTTPS 证书和反向代理由宝塔/Nginx 等现有入口管理。本文件描述的外部 PostgreSQL/S3 方案继续作为高可用和托管基础设施部署入口。

本目录是 Phase 6 的云厂商无关部署入口，可运行在任何符合标准的 Linux Docker/OCI 容器环境，包括普通云服务器、托管容器平台和 Kubernetes。中国香港仍可作为首选部署区域，阿里云只是可选适配方案，不是应用依赖。

生产业务真相由 PostgreSQL 和 S3 兼容对象存储承载；容器本地目录只保存可丢弃的临时数据。SMTP、WebDAV 和 HTTPS 通过标准协议接入。

GitHub 代码仓库和 GitHub Container Registry 中的 `ghcr.io/limericko/pdf-drawing-approval` 容器包均已公开。云服务器无需 Registry 登录即可按不可变 digest 拉取镜像。

当前 `main` 构建的不可变镜像为 `ghcr.io/limericko/pdf-drawing-approval@sha256:3b8bf7ecb5376aa67a6e486ebac20464bf59369e70088d9627d1fd917e3820c0`。部署时使用完整 digest，不使用可变标签 `0.9.2-refactor`。2026-07-15 已通过匿名 GHCR token 验证：manifest 返回 HTTP 200，且 `Docker-Content-Digest` 与上述 digest 一致。

## 可移植性边界

运行环境只需提供：

- 支持只读根文件系统、非 root 用户和健康检查的 Docker/OCI 运行时。
- PostgreSQL 兼容数据库。
- 具有 HTTPS 端点的 S3 兼容私有对象存储。
- SMTP 服务、可选 WebDAV 服务及 HTTPS 入口。
- 能把秘密以只读文件或标准输入交给容器的密钥管理方案。

应用不要求阿里云 SDK、OSS 专属 API、ACR、KMS 或特定负载均衡。云厂商专属模板只允许放在 `deploy/providers/`，不得成为 Compose、镜像或迁移工具的必需路径。

## 镜像

`Dockerfile` 构建同一应用镜像，支持四个目标：

- `web`：React 静态资源和 `/api/v2`。
- `worker`：Outbox、任务、签章、存储清理和 WebDAV 同步。
- `migration`：只执行 PostgreSQL expand/contract schema migration。
- `bootstrap-admin`：仅空库首次管理员引导。

生产构建必须通过 `--build-arg NODE_IMAGE=node:24.12.0-bookworm-slim@sha256:<verified-digest>` 锁定基础镜像，并将最终镜像推入任意 OCI Registry。部署只接受 `repository@sha256:digest`，不接受可变标签。

默认 Node 基础镜像已经锁定到 2026-07-14 验证的 digest。生产镜像已在本地 Docker Desktop 完成真实构建，并验证 Web、Worker 和 migration 入口以 UID 10001、只读根文件系统、capability 全删除方式运行。正式发布仍须把应用镜像推送到可信 Registry、签名并以最终应用镜像 digest 部署；Registry 不限定 ACR。

## 对象存储

`PDF_APPROVAL_STORAGE_S3_ENDPOINT`、`REGION`、`BUCKET` 和 `FORCE_PATH_STYLE` 都必须按实际 S3 兼容服务填写。AWS S3 与阿里云 OSS 公网域名内置识别；其他供应商必须把端点的精确 DNS 主机名加入 `PDF_APPROVAL_STORAGE_S3_ALLOWED_HOSTS`。

白名单只接受逗号分隔的精确公网 DNS 主机名，不接受通配符、URL、端口、路径、IP 地址、重复项或带额外空格的条目。生产端点始终要求 HTTPS。

## 密钥

在任意 Secrets Manager、Vault、KMS 配套密钥服务或受控主机流程中保存一个 JSON secret bundle，结构见 `secret-bundle.example.json`。不要把真实副本写入仓库、基础设施变量、普通磁盘或 Terraform state。

将秘密 JSON 通过标准输入传给：

```sh
node deploy/materialize-secrets.mjs --root /run/pdf-approval-secrets --uid 10001 --gid 10001
```

脚本只输出文件数量，不输出秘密。生成的 `web`、`worker`、`migration`、`bootstrap` 目录互相隔离；应用只挂载自身所需目录。秘密轮换后依次重启实例，旧 keyring 版本必须保留到观察期结束。

## Compose 预检

复制 `deploy/production.env.example` 到主机受保护路径，填写非秘密参数，然后执行：

```sh
docker compose --env-file /etc/pdf-approval/production.env -f deploy/compose.production.yaml config --quiet
docker compose --env-file /etc/pdf-approval/production.env -f deploy/compose.production.yaml --profile tools run --rm migration
docker compose --env-file /etc/pdf-approval/production.env -f deploy/compose.production.yaml up -d web worker
```

反向代理或负载均衡只探测 `/health/ready`。主机 8080 端口只允许来自受控入口网络，不得直接暴露公网；Worker 不开放端口。

## 旧系统迁移容器

生产迁移使用同一镜像的 `legacy-migration` 入口。准备四个受控目录：

- `database/legacy.sqlite`：在线一致快照，目录只读挂载。
- `files/`：与快照同一时点的旧文件副本，目录只读挂载。
- `config/roots.json`：旧绝对路径到容器 `/migration/input/files` 的映射。
- `config/emails.json`：以旧用户数字 ID 为键的已确认正式邮箱；不得猜测或生成占位邮箱。
- 每次运行使用一个新的空 `reports/run-NNN/` 输出目录。

`roots.json` 示例：

```json
[{"legacyRoot":"E:\\PDF服务端\\pdf-approval","snapshotRoot":"/migration/input/files"}]
```

确认 `production.env` 中 `PDF_APPROVAL_LEGACY_*` 路径和稳定 `SOURCE_ID` 后执行：

```sh
docker compose --env-file /etc/pdf-approval/production.env -f deploy/compose.production.yaml --profile tools run --rm legacy-migration
```

首次使用 `PDF_APPROVAL_LEGACY_MODE=import`；最终停写快照使用 `delta`。工具会执行 SQLite 盘点、文件解析、上传、HEAD/GET 哈希回读、稳定 ID 映射、PostgreSQL 导入和计数校验。报告未显示 `eligibleForCutover=true` 时禁止切换。

## 编排平台映射

- 普通云服务器：直接使用本目录的 Compose。
- Kubernetes、Nomad、云厂商托管容器：把同一镜像、四个进程入口、环境变量和只读秘密挂载映射到平台原生对象。
- 高可用生产：至少两个无状态 Web 实例、独立 Worker、托管 PostgreSQL、高可用 S3 兼容存储和 HTTPS 入口。

应用镜像和数据库迁移不因编排平台或云厂商变化而改变。

## 已知外部门禁

- 正式域名、证书、容器平台、PostgreSQL、S3、SMTP、WebDAV 和维护时间尚未提供。
- 未完成目标环境资源创建、费用确认、秘密拉取、镜像签名、滚动发布或故障演练前，禁止把本目录视为已上线证据。
