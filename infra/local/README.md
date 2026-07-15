# Phase 1 本地依赖

此目录只用于本机 Phase 1 开发和测试，不是生产部署配置。所有示例密码和密钥都带有 `local-only` 标记，后续生产配置校验必须拒绝这些值。

Compose 使用经过本机验证的 Phase 1 固定基线，并同时锁定版本和镜像内容 digest：PostgreSQL 17.5、MinIO `RELEASE.2025-09-07T16-13-09Z`、MinIO Client `RELEASE.2025-08-13T08-35-41Z`、Mailpit 1.20.4。这里的本地测试基线不限制生产环境选用托管 PostgreSQL 或托管对象存储服务。

## 启动与检查

```powershell
npm run infra:up
npm run infra:status
```

- PostgreSQL：`127.0.0.1:55432`
- MinIO API/Console：`127.0.0.1:59000` / `127.0.0.1:59001`
- Mailpit SMTP/Web：`127.0.0.1:51025` / `127.0.0.1:58025`

`infra:up` 每次都会重新执行幂等 PostgreSQL 角色授权，并确认私有 `pdf-approval` Bucket 存在。

S3 上传在超时或连接中断后可能出现远端结果不确定。平台会故意保留这类对象的
`delete_pending` tombstone，并按 `PDF_APPROVAL_STORAGE_CLEANUP_REAP_INTERVAL_MS`
（默认 6 小时，最小 1 分钟）持续执行 generation-fenced 删除复核。该元数据不是泄漏，
不得手工改成 `deleted`；它保证进程重启或迟到 PUT 后仍有持久清理所有权。

## 停止与重置

```powershell
npm run infra:down
node scripts/platform-deps.mjs reset --confirm-local-data-loss
```

普通停止保留命名卷。重置仅允许连接本机 Docker named pipe；它会先按 `pdf-approval-phase1` project label 核对并列出真实容器和卷，再移除这些容器以及 `pdf-approval-phase1-postgres-data`、`pdf-approval-phase1-minio-data`。该操作会永久清除本地平台测试数据，缺少确认参数或资源标签不匹配时命令拒绝执行。

测试不会自动启动 Docker。先运行 `infra:up`，再显式执行对应的 platform integration test。
