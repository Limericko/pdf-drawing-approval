# Phase 1 本地平台运行手册

本手册只用于本机 Phase 1 集成验证。它不会迁移正式 SQLite 数据，不创建或连接收费云资源，不执行生产切换，也不替代现有 legacy 局域网服务。Platform 和 legacy 通过运行模式隔离；Windows server-exe 仍为 legacy-only。

## 1. 初始化本地环境

先安装锁文件中的依赖，再启动固定版本的 PostgreSQL、MinIO 和 Mailpit：

```powershell
npm ci
npm run infra:up
npm run infra:status
```

本地地址：

- PostgreSQL：`127.0.0.1:55432`
- MinIO API / Console：`127.0.0.1:59000` / `127.0.0.1:59001`
- Mailpit SMTP / Web：`127.0.0.1:51025` / `127.0.0.1:58025`

`infra:up` 只做幂等角色授权和私有 Bucket 初始化，不重置命名卷。测试不会自动启动 Docker，也不会自动删除持久卷。

复制本地示例并只在未跟踪文件中调整配置：

```powershell
Copy-Item infra/local/.env.example infra/local/.env.local
```

`.env.local` 已由 `.gitignore` 的 `.env.*` 规则排除。不得把数据库密码、S3 凭据或 keyring 提交到 Git。

## 2. 选择唯一权威存储

Platform 每次只能选择 filesystem 或 S3，不双写、不隐藏降级。

filesystem 示例：

```dotenv
PDF_APPROVAL_STORAGE_DRIVER=filesystem
PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT=G:\PDF审批-平台存储
```

使用 filesystem 时，从 `.env.local` 删除全部 `PDF_APPROVAL_STORAGE_S3_*` 字段。根目录必须是服务进程可读写的绝对路径，并纳入主机级备份。

本地 MinIO / S3 示例：

```dotenv
PDF_APPROVAL_STORAGE_DRIVER=s3
PDF_APPROVAL_STORAGE_S3_ENDPOINT=http://127.0.0.1:59000
PDF_APPROVAL_STORAGE_S3_REGION=us-east-1
PDF_APPROVAL_STORAGE_S3_BUCKET=pdf-approval
PDF_APPROVAL_STORAGE_S3_ACCESS_KEY=local-only-minio-access
PDF_APPROVAL_STORAGE_S3_SECRET_KEY=local-only-minio-secret
PDF_APPROVAL_STORAGE_S3_FORCE_PATH_STYLE=true
```

使用 S3 时删除 `PDF_APPROVAL_STORAGE_FILESYSTEM_ROOT`。本地 Bucket 必须保持私有；Phase 1 不生成公共对象 URL。生产环境必须换成密钥管理中的凭据，配置校验会拒绝 `local-only` 值、HTTP 公网地址和不安全 Cookie。

## 3. 迁移、首管理员、Web 和 Worker

先在独立终端执行迁移。正式的本地 npm 入口如下，它们读取仓库提供的 `infra/local/.env.example` 本地基线：

```powershell
npm run platform:db:migrate
npm run platform:bootstrap-admin
```

迁移器使用 PostgreSQL advisory lock 串行化，并校验所有历史文件 SHA-256；历史缺失、顺序改变或 checksum 不匹配都会 fail-closed，禁止改写已应用迁移来绕过检查。

需要使用未跟踪的 `infra/local/.env.local` 覆盖存储或端口时，不要修改 npm 脚本或提交环境文件；改用等价的显式 Node 入口：

```powershell
node --env-file=infra/local/.env.local --import tsx src/server/platform/database/migrateCli.ts
node --env-file=infra/local/.env.local --import tsx src/server/commands/bootstrapAdmin.ts
```

首管理员命令只在 `users` 为空时成功，密码使用隐藏输入，完成 TOTP 后一次性显示恢复码。不要截图、记录或重复传播 TOTP secret 与恢复码。

启动 Platform Web：

```powershell
$env:PDF_APPROVAL_RUNTIME_MODE = "platform"
node --env-file=infra/local/.env.local --import tsx src/server/index.ts
```

另开终端启动独立 Worker：

```powershell
npm run platform:worker
# 使用 .env.local 覆盖时：
node --env-file=infra/local/.env.local --import tsx src/server/platform/jobs/workerMain.ts
```

Web 和 Worker 必须使用各自受限数据库角色。任一配置、Schema 或当前存储健康门禁失败时进程会退出，不回退 SQLite 或另一种存储。

## 4. 健康检查与 Task 19 注意事项

- `GET /health`：公开版本、`runtimeMode: "platform"` 和规范 `basePath`。反向代理挂载路径必须与 `PDF_APPROVAL_PUBLIC_BASE_URL` 的路径一致，例如公网地址为 `https://example.com/approval` 时 `basePath` 为 `/approval/`。
- `GET /health/live`：只证明进程可响应，不访问 PostgreSQL、对象存储或 SMTP。
- `GET /health/ready`：核心 readiness 只由 PostgreSQL、预期迁移和当前唯一 StorageAdapter 决定；检查具有短超时、TTL 和 singleflight。
- Worker 与 SMTP 是 advisory 状态，邮件短暂失败不会把核心 API 摘除，但必须告警和处理。

迁移 `0007_worker_health.sql` 提供有界的 `platform.worker_health` 视图，只暴露最近 Worker heartbeat 与 SMTP 健康时间，不保存无界历史或错误秘密。部署时必须先应用到 `0007`，否则 Platform Web/Worker 会拒绝启动。

HTTP 关闭、Pool 关闭和 Storage 销毁都有硬期限；收到终止信号后先停止新请求/领取，再让短任务收束并关闭资源。若有界关闭失败，进程返回稳定、脱敏错误，运维不得无限等待或直接忽略。

## 5. 四类 keyring 轮换

四个用途必须使用互不重复的密钥材料：

- `PDF_APPROVAL_TOTP_KEYRING`
- `PDF_APPROVAL_INVITATION_HMAC_KEYRING`
- `PDF_APPROVAL_RECOVERY_HMAC_KEYRING`
- `PDF_APPROVAL_CSRF_HMAC_KEYRING`

非本地 keyring 使用版本化 JSON：`{"currentVersion":"v2","keys":{"v1":"<32字节以上Base64>","v2":"<32字节以上Base64>"}}`。轮换顺序固定为：先加入新 key，部署所有读者，再切换 `currentVersion`，确认旧版本不再被引用后才删除旧 key。

- TOTP 加密旧 key：保留到所有旧版本凭据完成重加密或被撤销。
- 邀请 HMAC 旧 key：至少保留到“最长邀请有效期 24 小时 + 当前最大 Job 重试窗口”结束。Worker 会按邀请记录中的 key version 重建 fragment 链接；提前删除会让仍有效邀请永久失败。
- 恢复码 HMAC 旧 key：保留到对应版本的未使用恢复码全部消费、替换或撤销。
- CSRF HMAC 旧 key：保留到旧版本绑定的最长存活 Session 结束，或先显式撤销全部相关 Session。

邀请邮件是 at-least-once：Job 重试可能产生重复邮件，稳定 Message-ID 不代表 exactly-once。重新邀请会撤销同项目、同归一化邮箱的旧活跃邀请。

## 6. 停止与清理

先在 Web 和 Worker 终端发送 `Ctrl+C`，等待有界关闭完成，再停止依赖：

```powershell
npm run infra:down
```

普通 `infra:down` 保留命名卷。只有明确决定永久删除本机 Phase 1 测试数据后，才可人工执行：

```powershell
node scripts/platform-deps.mjs reset --confirm-local-data-loss
```

`reset` 会核对本项目 label 和卷名；它不是日常停止步骤，不得用于正式数据、共享环境或未确认的机器。本阶段不包含生产数据迁移、云资源创建、域名切换或 legacy 下线。
