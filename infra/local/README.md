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

## 停止与重置

```powershell
npm run infra:down
node scripts/platform-deps.mjs reset --confirm-local-data-loss
```

普通停止保留命名卷。重置只删除 `pdf-approval-phase1-postgres-data` 和 `pdf-approval-phase1-minio-data`，会永久清除本地平台测试数据，缺少确认参数时命令拒绝执行。

测试不会自动启动 Docker。先运行 `infra:up`，再显式执行对应的 platform integration test。
