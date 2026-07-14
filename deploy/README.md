# 中国香港生产运行包

本目录用于 Phase 6 阿里云中国香港部署。生产运行只有 PostgreSQL 和 OSS 两个业务真相；容器本地目录只保存可丢弃的临时数据。

## 镜像

`Dockerfile` 构建同一应用镜像，支持四个目标：

- `web`：React 静态资源和 `/api/v2`。
- `worker`：Outbox、任务、签章、存储清理和 WebDAV 同步。
- `migration`：只执行 PostgreSQL expand/contract schema migration。
- `bootstrap-admin`：仅空库首次管理员引导。

生产构建必须通过 `--build-arg NODE_IMAGE=node:24.12.0-bookworm-slim@sha256:<verified-digest>` 锁定基础镜像，并将最终镜像推入阿里云香港 ACR。部署只接受 `repository@sha256:digest`，不接受可变标签。

当前工作站无法连接 Docker Hub，因此仓库默认值暂时是固定版本标签；在 ACR 镜像缓存可用后，镜像 digest 锁定与真实容器门禁仍是上线前必做项。

## 密钥

KMS Secrets Manager 中保存一个 JSON secret bundle，结构见 `secret-bundle.example.json`。不要把真实副本写入仓库、Terraform 变量或普通磁盘。

受控主机初始化流程把 `GetSecretValue` 的 `SecretData` 直接通过标准输入传给：

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

ALB 只探测 `/health/ready`。主机 8080 端口的安全组只能接受 ALB 安全组，不得直接暴露公网。Worker 不开放端口。

## 已知外部门禁

- Docker Hub 在当前工作站不可达，基础镜像尚未取得 digest；使用阿里云 ACR 缓存后补齐。
- 正式域名、证书、阿里云账号、SMTP、WebDAV 和维护时间尚未提供。
- 未完成真实阿里云资源创建、费用确认、KMS 拉取、镜像签名、滚动发布或故障演练前，禁止把本目录视为已上线证据。
