# Phase 1 Cloud Data and Security Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不改变 legacy 局域网运行方式的前提下，交付可本地集成验证的 PostgreSQL、选择式对象存储、邀请制账号、强制 TOTP、Cookie/CSRF 安全会话以及 PostgreSQL Worker/Outbox 平台基础。

**Architecture:** 保留现有同步 SQLite/v1 组合根，新增通过运行模式动态加载的异步 platform 组合根。Platform Web、Worker 和迁移进程使用独立受限 PostgreSQL 角色，通过窄 Repository、StorageAdapter 和 Outbox/Job 契约协作；filesystem 与 S3 只能选择一个权威存储，不双写、不隐藏降级。

**Tech Stack:** Node.js 24、TypeScript、Express 4、React 19、PostgreSQL、`pg`、MinIO/S3、`@node-rs/argon2`、OTPAuth、Nodemailer、Vitest、Supertest、Playwright、Docker Compose。

---

## 执行上下文

- 工作树：`C:\Users\Administrator\.config\superpowers\worktrees\PDF审批\phase-1-cloud-data-security`
- 分支：`codex/phase-1-cloud-data-security`
- 起点提交：`104ae77`
- 设计规格：`docs/superpowers/specs/2026-07-10-phase-1-cloud-data-security-design.md`
- 总路线图：`docs/superpowers/plans/2026-07-10-engineering-platform-refactor-roadmap.md`
- Phase 0 验证：客户端 223、后端 283、Electron 12、Playwright 20 项均通过；构建只保留已知 PDF.js `531.35 kB` 警告。

执行约束：

1. 每项任务使用 TDD：先写失败测试，确认失败原因正确，再写最小实现。
2. `src/server/server.ts`、`src/server/startServer.ts` 和 `startPdfApprovalServer()` 保持 legacy 同步契约。
3. Platform 依赖必须动态导入，不能污染现有 Windows server-exe 的 legacy 依赖图。
4. `*.integration.test.ts` 不进入默认 `npm test`；平台后端集成测试按 database、identity、storage、jobs 分组，每条命令设置 60 秒硬超时。
5. 不访问正式 `data/`、`output/`、`logs/`、`backups/`，不创建收费云资源，不 Push。
6. 每个任务单独提交；提交前运行针对性测试和 `git diff --check`。

### Task 1: 建立 legacy/platform 运行模式边界

**Files:**

- Create: `src/server/runtimeMode.ts`
- Create: `src/server/runtimeMode.test.ts`
- Create: `src/server/startConfiguredServer.ts`
- Create: `src/server/startConfiguredServer.test.ts`
- Modify: `src/server/index.ts`
- Verify unchanged API: `src/server/startServer.ts`
- Verify unchanged API: `src/server/serverExeEntry.ts`

**Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeMode } from "./runtimeMode.ts";
import { startConfiguredServer } from "./startConfiguredServer.ts";

it("defaults to legacy", () => {
  expect(resolveRuntimeMode({})).toBe("legacy");
});

it("rejects unknown modes", () => {
  expect(() => resolveRuntimeMode({ PDF_APPROVAL_RUNTIME_MODE: "hybrid" })).toThrow("INVALID_RUNTIME_MODE");
});

it("does not load platform dependencies in legacy mode", async () => {
  const startLegacy = vi.fn(() => "legacy-server");
  const loadPlatform = vi.fn();
  await startConfiguredServer({ env: {}, startLegacy, loadPlatform });
  expect(startLegacy).toHaveBeenCalledOnce();
  expect(loadPlatform).not.toHaveBeenCalled();
});
```

**Step 2: 运行并确认 RED**

Run: `npm test -- --run src/server/runtimeMode.test.ts src/server/startConfiguredServer.test.ts`

Expected: FAIL，提示模块不存在。

**Step 3: 写最小实现**

```ts
export type RuntimeMode = "legacy" | "platform";

export function resolveRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const value = env.PDF_APPROVAL_RUNTIME_MODE?.trim() || "legacy";
  if (value !== "legacy" && value !== "platform") throw new Error("INVALID_RUNTIME_MODE");
  return value;
}
```

`startConfiguredServer()` 接受可注入依赖供测试；生产默认：

```ts
if (resolveRuntimeMode(options.env ?? process.env) === "legacy") {
  return (options.startLegacy ?? startPdfApprovalServer)();
}
const module = await (options.loadPlatform ?? (() => import("./platform/startPlatformWebServer.ts")))();
return module.startPlatformWebServer();
```

`src/server/index.ts` 改为顶层 `await startConfiguredServer()`。不得修改 `startPdfApprovalServer()` 的同步返回类型，也不得在该文件静态 import `pg`、Argon2 或 AWS SDK。

**Step 4: 验证 GREEN 与 legacy 打包边界**

Run:

```powershell
npm test -- --run src/server/runtimeMode.test.ts src/server/startConfiguredServer.test.ts src/server/startServer.test.ts src/server/serverPackage.test.ts src/server/serverExePackage.test.ts
npm run build
```

Expected: PASS；默认模式仍为 legacy，平台 loader 未调用。

**Step 5: Commit**

```powershell
git add src/server/runtimeMode.ts src/server/runtimeMode.test.ts src/server/startConfiguredServer.ts src/server/startConfiguredServer.test.ts src/server/index.ts
git commit -m "feat: isolate platform runtime mode"
```

### Task 2: 建立本地依赖栈和隔离集成测试入口

**Files:**

- Create: `infra/local/compose.yaml`
- Create: `infra/local/.env.example`
- Create: `infra/local/postgres/init/001-roles.sql`
- Create: `infra/local/README.md`
- Create: `scripts/platform-deps.mjs`
- Create: `scripts/run-with-timeout.mjs`
- Create: `src/server/platform/testing/runWithTimeout.test.ts`
- Create: `vitest.platform.integration.config.ts`
- Create: `src/server/platform/testing/postgresHarness.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: 写基础设施失败检查**

Run: `docker compose --env-file infra/local/.env.example -f infra/local/compose.yaml config --quiet`

Expected: FAIL，因为 compose 文件不存在。

**Step 2: 安装明确依赖**

Run:

```powershell
npm install pg uuid cookie-parser @node-rs/argon2 otpauth qrcode @inquirer/prompts @aws-sdk/client-s3
npm install -D @types/pg @types/cookie-parser @types/qrcode
```

不得添加 Redis、BullMQ、Kafka、Agenda、阿里云 OSS SDK、WebDAV 或 ClamAV 依赖。

**Step 3: 创建 Compose 与本地角色**

Compose 只包含：

- PostgreSQL：绑定 `127.0.0.1:55432`，数据库 `pdf_approval_platform`。
- MinIO API/Console：绑定 `127.0.0.1:59000/59001`。
- MinIO 初始化一次性容器：创建私有 `pdf-approval` Bucket。
- Mailpit SMTP/Web：绑定 `127.0.0.1:51025/58025`。

所有服务使用固定版本、命名卷和健康检查。`001-roles.sql` 创建：

- `platform_migration`：拥有 platform schema 和迁移权限。
- `platform_web`：运行 v2 Web，后续只获业务所需权限。
- `platform_worker`：运行 Dispatcher/Worker。
- `platform_bootstrap`：只允许首管理员所需的身份写入和审计追加，无 DDL 权限。

示例密码和密钥必须明确标注 `local-only`；生产配置校验必须拒绝这些值。

**Step 4: 隔离测试配置与脚本**

`vitest.config.ts` 增加：

```ts
exclude: ["**/*.integration.test.ts", "node_modules/**", "dist/**"]
```

`vitest.platform.integration.config.ts` 只收集 `**/*.integration.test.ts`，设置 `fileParallelism: false`、`testTimeout: 20_000`、`hookTimeout: 20_000`。外层命令仍使用 60 秒硬超时。

`scripts/platform-deps.mjs` 负责 `up|down|status|reset`，其中 `up` 在容器 healthy 后每次执行幂等角色/授权 provision；不能只依赖仅首次初始化卷时运行的 `docker-entrypoint-initdb.d`。MinIO Bucket 初始化使用 `--ignore-existing` 等幂等语义。`reset` 只能删除本项目命名卷，必须打印目标并要求显式 `--confirm-local-data-loss`。

`scripts/run-with-timeout.mjs` 使用子进程 watchdog 在 60 秒时终止完整进程树，并原样传播 stdout、stderr 和退出码；Windows 要正确解析 `npm.cmd`。先写测试证明快速成功、非零退出和超时终止。

在 `package.json` 增加：

```json
{
  "infra:up": "node scripts/platform-deps.mjs up",
  "infra:down": "node scripts/platform-deps.mjs down",
  "infra:status": "node scripts/platform-deps.mjs status",
  "platform:db:migrate": "node --env-file=infra/local/.env.example --import tsx src/server/platform/database/migrateCli.ts",
  "platform:worker": "node --env-file=infra/local/.env.example --import tsx src/server/platform/jobs/workerMain.ts",
  "platform:bootstrap-admin": "node --env-file=infra/local/.env.example --import tsx src/server/commands/bootstrapAdmin.ts",
  "platform:jobs": "node --env-file=infra/local/.env.example --import tsx src/server/platform/jobs/jobDiagnosticsCli.ts",
  "test:platform:unit": "node scripts/run-with-timeout.mjs 60000 npm test -- --run src/server/platform src/server/modules/identity src/shared/contracts",
  "test:platform:integration": "node scripts/run-with-timeout.mjs 60000 node --env-file=infra/local/.env.example node_modules/vitest/vitest.mjs run --config vitest.platform.integration.config.ts"
}
```

所有后续集成命令使用 `npm run test:platform:integration -- <精确测试文件...>`，不能用逐渐膨胀的目录级大组冒充 60 秒门禁。

Harness 使用 test admin URL 为每个 suite 创建唯一临时数据库，数据库内仍使用固定 `platform` schema；迁移后以 web/worker/bootstrap 受限角色连接。`finally` 先关闭全部 Pool，再通过 admin 连接 `drop database ... with (force)`。测试不自动启动 Docker，不能让多个 suite 共享长期脏数据库。

**Step 5: 验证基础设施**

Run:

```powershell
npm test -- --run src/server/platform/testing/runWithTimeout.test.ts
npm test -- --run src/server/runtimeMode.test.ts
npm run infra:up
npm run infra:status
```

Expected: Compose 配置有效；PostgreSQL、MinIO、Mailpit healthy。若 Docker daemon 未运行，先启动 Docker Desktop，再重跑，不绕过集成门禁。

**Step 6: Commit**

```powershell
git add package.json package-lock.json vitest.config.ts vitest.platform.integration.config.ts infra/local scripts/platform-deps.mjs scripts/run-with-timeout.mjs src/server/platform/testing/runWithTimeout.test.ts src/server/platform/testing/postgresHarness.ts
git commit -m "chore: add Phase 1 local dependencies"
```

### Task 3: 实现平台配置、进程角色和脱敏

**Files:**

- Create: `src/server/platform/config/types.ts`
- Create: `src/server/platform/config/loadPlatformConfig.ts`
- Create: `src/server/platform/config/loadPlatformConfig.test.ts`
- Create: `src/server/platform/config/redaction.ts`
- Create: `src/server/platform/config/redaction.test.ts`

**Step 1: 写失败测试**

覆盖以下断言：

```ts
expect(loadPlatformConfig(filesystemEnv, "web").storage.driver).toBe("filesystem");
expect(loadPlatformConfig(s3Env, "worker").storage.driver).toBe("s3");
expect(() => loadPlatformConfig({ PDF_APPROVAL_STORAGE_DRIVER: "s3" }, "web")).toThrow("PLATFORM_CONFIG_INVALID");
expect(() => loadPlatformConfig(localSecretsInProduction, "web")).toThrow("INSECURE_PRODUCTION_CONFIG");
expect(redactConfigError(error)).not.toContain("local-only-password");
```

**Step 2: 运行 RED**

Run: `npm test -- --run src/server/platform/config`

Expected: FAIL，配置模块不存在。

**Step 3: 实现单一配置解析器**

`loadPlatformConfig(env, target)` 中 `target` 必须是 `web | worker | migration | bootstrap-admin`。不同进程只读取所需 URL：

- `PDF_APPROVAL_PLATFORM_WEB_DATABASE_URL`
- `PDF_APPROVAL_PLATFORM_WORKER_DATABASE_URL`
- `PDF_APPROVAL_PLATFORM_MIGRATION_DATABASE_URL`
- `PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL`
- `PDF_APPROVAL_PLATFORM_TEST_DATABASE_URL`
- `PDF_APPROVAL_PLATFORM_TEST_ADMIN_DATABASE_URL`（只允许本地测试 harness 创建/删除临时数据库）

条件配置：

- `PDF_APPROVAL_STORAGE_DRIVER=filesystem`：必须有绝对 root。
- `PDF_APPROVAL_STORAGE_DRIVER=s3`：必须有 endpoint、region、bucket、access key、secret、forcePathStyle。
- Cookie/会话：Secure、绝对 12 小时、空闲 60 分钟、活动 touch 最小间隔。
- 版本化密钥环：TOTP 加密、邀请 HMAC、恢复码 HMAC、CSRF HMAC；每个用途使用独立 keyring，解析为 `{ currentVersion, keys: Map<string, Buffer> }`，禁止跨用途复用密钥。
- SMTP、可信代理、公开 base URL、Worker 并发/租约/最大重试。

生产拒绝：默认密钥、local-only 凭据、非 Secure Cookie、HTTP base URL、Mailpit 端口和无认证本地 SMTP。错误消息统一脱敏 PostgreSQL URL 密码、S3 secret、密钥 JSON 和 SMTP 密码。

**Step 4: 运行 GREEN**

Run: `npm test -- --run src/server/platform/config`

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/config
git commit -m "feat: validate platform process configuration"
```

### Task 4: 实现 PostgreSQL Pool、QueryExecutor 和事务

**Files:**

- Create: `src/server/platform/database/queryExecutor.ts`
- Create: `src/server/platform/database/pool.ts`
- Create: `src/server/platform/database/pool.test.ts`
- Create: `src/server/platform/database/transaction.ts`
- Create: `src/server/platform/database/transaction.test.ts`
- Create: `src/server/platform/database/databaseErrors.ts`
- Create: `src/server/platform/database/database.integration.test.ts`

**Step 1: 写失败单元和集成测试**

核心接口：

```ts
export interface QueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

const result = await withTransaction(pool, async (tx) => {
  await tx.query("insert into test_items(name) values ($1)", ["committed"]);
  return "ok";
});
```

测试 commit、rollback、回调异常后 client release、statement timeout 后连接仍能复用。使用参数数组证明无字符串 SQL 拼接。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/database/pool.test.ts src/server/platform/database/transaction.test.ts
npm run test:platform:integration -- src/server/platform/database/database.integration.test.ts
```

Expected: FAIL，模块不存在。

**Step 3: 实现最小数据库层**

- `createPlatformPool()` 配置 `max`、连接超时、idle timeout、application name。
- `withTransaction()` 必须从 Pool 获取单一 `PoolClient`，`BEGIN` 后设置本地 statement/lock/idle-in-transaction timeout。
- callback 只接收同一 client 的 `QueryExecutor`；任意异常 rollback；`finally` release。
- `classifyDatabaseError()` 只标记明确的连接/序列化/死锁临时错误，未知错误不自动重试。

**Step 4: 运行 GREEN**

Run:

```powershell
npm test -- --run src/server/platform/database/pool.test.ts src/server/platform/database/transaction.test.ts
npm run test:platform:integration -- src/server/platform/database/database.integration.test.ts
```

Expected: PASS，单条集成命令低于 60 秒。

**Step 5: Commit**

```powershell
git add src/server/platform/database
git commit -m "feat: add PostgreSQL transaction boundary"
```

### Task 5: 实现带校验和和 advisory lock 的迁移器

**Files:**

- Create: `src/server/platform/database/migrationFiles.ts`
- Create: `src/server/platform/database/migrationRunner.ts`
- Create: `src/server/platform/database/migrationRunner.test.ts`
- Create: `src/server/platform/database/schemaVersion.ts`
- Create: `src/server/platform/database/schemaVersion.test.ts`
- Create: `src/server/platform/database/migrateCli.ts`
- Create: `src/server/platform/database/migrations.integration.test.ts`
- Create: `src/server/platform/database/__fixtures__/migrations/0001_first.sql`
- Create: `src/server/platform/database/__fixtures__/migrations/0002_second.sql`

**Step 1: 写失败测试**

测试：按文件名排序、拒绝编号重复、SHA-256 基于原始 bytes、首次执行、重复执行无变化、历史文件被修改后拒绝、失败迁移 rollback、两个 runner 不能并发执行。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/database/migrationRunner.test.ts src/server/platform/database/schemaVersion.test.ts
npm run test:platform:integration -- src/server/platform/database/migrations.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现 runner**

关键算法：

```ts
const client = await pool.connect();
try {
  await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  await client.query("create schema if not exists platform authorization current_user");
  await ensureMigrationTable(client);
  for (const migration of migrations) await applyOrVerify(client, migration);
} finally {
  await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
  client.release();
}
```

本地 provision 必须让 `platform_migration` 成为数据库 owner 或明确拥有创建固定 `platform` schema 的权限。`ensureMigrationTable()`、`applyOrVerify()` 和 `assertExpectedSchema()` 始终读写完全限定的 `platform.schema_migrations`，不得落入 `public`。迁移目录从 `import.meta.url` 或显式参数解析，禁止依赖 `process.cwd()`。Web/Worker 只调用 `assertExpectedSchema()`；落后、超前、缺记录、checksum 不符全部拒绝启动，不自动迁移。fresh database 集成测试必须实际使用 migration 受限角色。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/database
git commit -m "feat: add checked PostgreSQL migrations"
```

### Task 6: 创建 Phase 1 PostgreSQL Schema 和数据库权限

**Files:**

- Create: `migrations/postgres/0001_identity_projects.sql`
- Create: `migrations/postgres/0002_security_sessions_audit.sql`
- Create: `migrations/postgres/0003_storage_outbox_jobs.sql`
- Create: `src/server/platform/database/platformSchema.integration.test.ts`

**Step 1: 写 Schema 失败测试**

测试 fresh migration 后表、约束、外键索引、部分索引和受限角色权限。至少断言：

```ts
expect(await tableExists("users")).toBe(true);
expect(await hasUniqueConstraint("users", "email_normalized")).toBe(true);
expect(await hasPartialIndex("jobs", "status = 'pending'" )).toBe(true);
await expect(web.query("delete from platform.audit_events")).rejects.toMatchObject({ code: "42501" });
```

**Step 2: 运行 RED**

Run: `npm run test:platform:integration -- src/server/platform/database/platformSchema.integration.test.ts`

Expected: FAIL，正式迁移不存在。

**Step 3: 写正式迁移**

所有 ID 为应用生成 UUIDv7；时间为 `timestamptz`；状态为 `text + check`；哈希/密文为 `bytea`。

`0001_identity_projects.sql` 创建：

- `users`：`email_normalized` 唯一、`platform_role in ('admin','member')`、`status in ('active','disabled')`、Argon2 hash。
- `projects`：名称、状态、时间戳。
- `project_members`：项目/用户组合唯一，角色为 `manager|designer|supervisor|process|viewer`，所有 FK 有索引。
- `invitations`：token hash、key version、邮箱、项目/项目角色、邀请人、24 小时过期、撤销/接受时间。

`0002_security_sessions_audit.sql` 创建：

- `totp_credentials`、`recovery_codes`；两者都保存各自 key version，恢复码使用独立版本化 HMAC keyring。
- `mfa_challenges` 保存挑战 token hash、期限、尝试次数和原子完成时间。
- `mfa_enrollments` 必须以 `invitation_id` 外键绑定邀请，保存 enrollment token hash、加密 TOTP secret、期限、尝试次数、`invalidated_at` 和 `completed_at`；部分唯一索引保证每个邀请最多一个“未作废且未完成”的 enrollment。再次 prepare 在同一事务先作废旧记录再创建新记录。
- `sessions`：session token hash、绝对/空闲过期、节流活动时间、撤销时间。
- `security_rate_limit_buckets`。
- append-only `audit_events`，稳定字段不藏在 JSON；元数据仅为受控 `jsonb`。

`0003_storage_outbox_jobs.sql` 创建：

- `storage_objects`：`staging|ready|delete_pending|deleted|failed`、driver/key 唯一、32-byte SHA-256、大小、媒体类型、错误摘要和生命周期时间。
- `outbox_events`：事件类型、版本、payload、创建/派发时间。
- `jobs`：`pending|running|succeeded|dead`、幂等键唯一、attempt、next run、lease expiry、不可复用的 `lease_token`、worker、错误摘要。
- `worker_heartbeats`。

部分索引覆盖：活跃邀请、活跃会话、待派发 Outbox、待执行/租约过期/死信 Job、旧 staging、delete_pending。最后执行最小权限 GRANT：Web 无权更新/删除审计；Worker 不能修改身份凭据；Bootstrap 只能检查空用户表、插入首管理员/TOTP/恢复码和追加审计；Migration 才拥有 DDL。集成测试分别用四个真实角色证明允许和拒绝矩阵。

**Step 4: 迁移和验证**

Run:

```powershell
npm run platform:db:migrate
npm run test:platform:integration -- src/server/platform/database/platformSchema.integration.test.ts
```

Expected: PASS；重复 migrate 无变化。

**Step 5: Commit**

```powershell
git add migrations/postgres src/server/platform/database/platformSchema.integration.test.ts
git commit -m "feat: add Phase 1 platform schema"
```

### Task 7: 实现密码、令牌、TOTP、密钥加密和恢复码原语

**Files:**

- Create: `src/server/platform/security/passwords.ts`
- Create: `src/server/platform/security/passwords.test.ts`
- Create: `src/server/platform/security/tokenHash.ts`
- Create: `src/server/platform/security/tokenHash.test.ts`
- Create: `src/server/platform/security/secretEncryption.ts`
- Create: `src/server/platform/security/secretEncryption.test.ts`
- Create: `src/server/platform/security/totp.ts`
- Create: `src/server/platform/security/totp.test.ts`
- Create: `src/server/platform/security/recoveryCodes.ts`
- Create: `src/server/platform/security/recoveryCodes.test.ts`

**Step 1: 写失败测试**

```ts
const hash = await hashPassword("correct horse battery staple", testArgonOptions);
expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
expect(await verifyPassword(hash, "wrong")).toBe(false);

const token = deriveInvitationToken(invitationId, "v1", inviteKeys);
expect(hashOpaqueToken(token)).toEqual(hashOpaqueToken(deriveInvitationToken(invitationId, "v1", inviteKeys)));
expect(() => verifyInvitationToken(tamperedToken, storedHash, inviteKeys)).toThrow("INVALID_TOKEN");

const sealed = encryptSecret(Buffer.from("totp-secret"), keyring);
expect(decryptSecret(sealed, keyring).toString()).toBe("totp-secret");
expect(verifyTotp(secret, totpAt(secret, fixedTime), fixedTime)).toBe(true);
```

邀请 token 测试还要覆盖篡改 ID/tag、未知或错误 key version、常量时间比较、stored token hash、旧 key 保留期间验证。恢复码测试必须覆盖高熵、展示格式、独立 keyring 的 HMAC hash/key version；并发消费留给 Repository contract。

**Step 2: 运行 RED**

Run: `npm test -- --run src/server/platform/security/passwords.test.ts src/server/platform/security/tokenHash.test.ts src/server/platform/security/secretEncryption.test.ts src/server/platform/security/totp.test.ts src/server/platform/security/recoveryCodes.test.ts`

Expected: FAIL。

**Step 3: 实现安全原语**

- Argon2id 必须异步；生产参数从已校验配置注入，测试使用低成本参数。
- opaque token 使用 `randomBytes(32)`；数据库只保存 SHA-256 或带 pepper 的 HMAC。
- 邀请 token 为 `<invitation-id>.<HMAC>`，HMAC key 由记录中的版本选择；Outbox 只需 invitation ID 即可重建。
- TOTP 使用 30 秒、6 位、允许前后一个时间步。
- TOTP secret 使用 AES-256-GCM，保存 key version、nonce、ciphertext、auth tag；解密验证 tag。
- 一次生成 10 个恢复码，原始值只返回一次；hash 使用恢复码专用版本化 HMAC keyring，记录 key version 以支持轮换。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS；测试不得打印原始密钥或恢复码。

**Step 5: Commit**

```powershell
git add src/server/platform/security
git commit -m "feat: add platform identity cryptography"
```

### Task 8: 实现用户、邀请、项目和项目成员 Repository contract

**Files:**

- Create: `src/server/modules/identity/models.ts`
- Create: `src/server/modules/identity/email.ts`
- Create: `src/server/modules/identity/ids.ts`
- Create: `src/server/modules/identity/repositories/userRepository.ts`
- Create: `src/server/modules/identity/repositories/invitationRepository.ts`
- Create: `src/server/modules/identity/repositories/projectRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresUserRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresInvitationRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresProjectRepository.ts`
- Create: `src/server/modules/identity/repositories/contracts/identityRepository.contract.ts`
- Create: `src/server/modules/identity/repositories/postgresIdentityRepositories.integration.test.ts`

**Step 1: 写失败 contract**

Contract 接受 Repository factory，在真实 PostgreSQL 隔离 schema 上运行。覆盖：

- 应用生成 UUIDv7。
- 邮箱 Unicode normalize、trim、小写和唯一约束。
- 用户/项目状态 CHECK。
- 项目成员组合唯一和 FK。
- 邀请 24 小时过期、撤销、重复消费。
- 两个并发消费者只允许一个 `UPDATE ... RETURNING` 成功。
- 创建项目时管理员自动成为 manager；管理员未成为成员时也不能读取该项目。

**Step 2: 运行 RED**

Run: `npm run test:platform:integration -- src/server/modules/identity/repositories/postgresIdentityRepositories.integration.test.ts`

Expected: FAIL。

**Step 3: 实现窄 Repository**

Repository 只依赖 `QueryExecutor`，不依赖 `Pool`。不要创建万能 BaseRepository。行映射集中且显式；事务内由 service 使用绑定同一 `PoolClient` 的 Repository 实例。

邀请消费必须类似：

```sql
update platform.invitations
set accepted_at = now(), accepted_by_user_id = $2
where id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
returning *;
```

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS，低于 60 秒。

**Step 5: Commit**

```powershell
git add src/server/modules/identity
git commit -m "feat: add platform identity repositories"
```

### Task 9: 实现 MFA、会话、限流和审计 Repository contract

**Files:**

- Create: `src/server/modules/identity/repositories/mfaRepository.ts`
- Create: `src/server/modules/identity/repositories/sessionRepository.ts`
- Create: `src/server/modules/identity/repositories/rateLimitRepository.ts`
- Create: `src/server/modules/identity/repositories/auditRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresMfaRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresSessionRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresRateLimitRepository.ts`
- Create: `src/server/modules/identity/repositories/postgres/PostgresAuditRepository.ts`
- Create: `src/server/modules/identity/repositories/contracts/securityRepositories.contract.ts`
- Create: `src/server/modules/identity/repositories/postgresSecurityRepositories.integration.test.ts`

**Step 1: 写失败 contract**

覆盖：

- MFA challenge/enrollment 过期、尝试次数和原子完成。
- 恢复码两个并发请求只能消费一次。
- session token hash 查询、绝对/空闲过期、撤销、活动时间最多每 5 分钟 touch 一次。
- 限流 bucket 原子 upsert，并按账号 hash + IP prefix 区分。
- 审计只允许白名单元数据，数据库 Web role 的 UPDATE/DELETE 得到 `42501`。

**Step 2: 运行 RED**

Run: `npm run test:platform:integration -- src/server/modules/identity/repositories/postgresSecurityRepositories.integration.test.ts`

Expected: FAIL。

**Step 3: 实现原子 SQL**

所有“消费”方法使用条件 `UPDATE ... RETURNING`，禁止复制 legacy 的 SELECT 后 UPDATE。审计 Repository 只暴露 `append()` 和受限查询，不暴露 update/delete。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS，低于 60 秒。

**Step 5: Commit**

```powershell
git add src/server/modules/identity/repositories
git commit -m "feat: add platform session security repositories"
```

### Task 10: 定义 StorageAdapter 并实现 filesystem contract

**Files:**

- Create: `src/server/platform/storage/storageAdapter.ts`
- Create: `src/server/platform/storage/storageKey.ts`
- Create: `src/server/platform/storage/storageErrors.ts`
- Create: `src/server/platform/storage/storageAdapterContract.ts`
- Create: `src/server/platform/storage/storageKey.test.ts`
- Create: `src/server/platform/storage/filesystemStorage.ts`
- Create: `src/server/platform/storage/filesystemStorage.test.ts`

**Step 1: 写失败 contract**

```ts
export interface StorageAdapter {
  readonly driver: "filesystem" | "s3";
  write(key: string, body: Readable, contentType: string): Promise<{ sizeBytes: number; sha256: Buffer }>;
  openRead(key: string): Promise<Readable>;
  head(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
  checkHealth(): Promise<void>;
}
```

共用 contract 覆盖：流式写读、哈希/大小、不可覆盖、缺失对象、失败流清理、重复删除幂等。key 单测拒绝用户文件名、`..`、绝对路径、反斜线和空段。

**Step 2: 运行 RED**

Run: `npm test -- --run src/server/platform/storage/storageKey.test.ts src/server/platform/storage/filesystemStorage.test.ts`

Expected: FAIL。

**Step 3: 实现 filesystem**

- key 只能由 `createStorageKey(prefix, uuidv7)` 生成。
- 每次操作先 resolve 规范路径并证明位于 root 内。
- 写入同一 root 下的临时 `.partial-*`，完成 hash/size 后使用 `fs.link(partial, final)` 做排他、原子且不可覆盖的提交，再 unlink partial；目标已存在时明确返回 `OBJECT_EXISTS`。不得使用会在 Windows 覆盖目标的普通 rename。任意流错误清理 partial。
- 拒绝目录符号链接逃逸；Windows 无权限创建 symlink 时测试明确 skip，但生产检查不能删除。
- `checkHealth()` 在专用 health 前缀完成可清理的小对象探测，使用短超时。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/storage
git commit -m "feat: add filesystem storage contract"
```

### Task 11: 实现 S3/MinIO StorageAdapter 和选择式工厂

**Files:**

- Create: `src/server/platform/storage/s3Storage.ts`
- Create: `src/server/platform/storage/s3Storage.integration.test.ts`
- Create: `src/server/platform/storage/createStorage.ts`
- Create: `src/server/platform/storage/createStorage.test.ts`

**Step 1: 写失败测试**

- 对 `createStorage()` 断言 filesystem 与 s3 只选一个，未知 driver 明确失败。
- 在 MinIO 上复用 Task 10 的完整 StorageAdapter contract。
- 断言 Bucket 保持私有、两个并发 writer 对同一 key 只有一个成功、`head` 不存在返回 `null`、失败流不留下可读对象。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/storage/createStorage.test.ts
npm run test:platform:integration -- src/server/platform/storage/s3Storage.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现 S3 adapter**

- Phase 1 使用 `@aws-sdk/client-s3` 的单次 `PutObject` 流式条件写，不引入阿里云专属 SDK，也不使用无法在完成阶段可靠保留条件语义的 multipart helper。
- endpoint、region、path style 由已校验配置注入。
- `PutObject` 必须携带 `If-None-Match: *` 防止覆盖；MinIO contract 必须用并发 writer 实际证明原子排他。Phase 1 对象上限明确为小于 5 GiB，超过上限在边界校验拒绝；真正的大对象 multipart 需要在后续阶段单独设计条件完成语义。
- body 全程 streaming，经 hash transform 统计 SHA-256/size；不把完整 PDF 读入内存。
- `checkHealth()` 使用固定私有前缀且清理探测对象；Task 19 在 HTTP readiness 外层增加短 TTL、短超时和 singleflight，负载均衡不能每次探测都写 OSS。
- S3 错误映射不得把 secret、完整 endpoint credential 或对象内容写入日志。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: filesystem 与 MinIO contract 均 PASS，Storage 分组低于 60 秒。

**Step 5: Commit**

```powershell
git add src/server/platform/storage
git commit -m "feat: add S3 compatible storage"
```

### Task 12: 实现 storage_objects 生命周期和一致性服务

**Files:**

- Create: `src/server/platform/storage/storageObjectRepository.ts`
- Create: `src/server/platform/storage/postgres/PostgresStorageObjectRepository.ts`
- Create: `src/server/platform/storage/storageObjectRepository.integration.test.ts`
- Create: `src/server/platform/storage/storageObjectService.ts`
- Create: `src/server/platform/storage/storageObjectService.integration.test.ts`
- Create: `src/server/platform/storage/cleanupIntentPublisher.ts`
- Create: `src/server/platform/storage/storageReconciler.ts`
- Create: `src/server/platform/storage/storageReconciler.integration.test.ts`

**Step 1: 写失败测试**

覆盖以下顺序和故障窗口：

1. 短事务创建 `staging`。
2. 事务外写对象。
3. `head` 校验大小。
4. 条件更新 `ready`。
5. 只有 `ready` 可以 `openRead()`。

注入对象写失败、head 不匹配、数据库 final update 失败和进程中断。数据库失败后必须保留可诊断 staging，不允许偷偷切换存储或报告成功。

**Step 2: 运行 RED**

Run: `npm run test:platform:integration -- src/server/platform/storage/storageObjectRepository.integration.test.ts src/server/platform/storage/storageObjectService.integration.test.ts src/server/platform/storage/storageReconciler.integration.test.ts`

Expected: FAIL。

**Step 3: 实现状态机**

- Repository 方法使用条件状态转换，禁止 `ready -> staging`。
- `delete_pending` 只在业务引用解除后的同一事务中标记。
- 先定义窄 `CleanupIntentPublisher` 端口；Task 12 测试注入 fake，Task 13 的 OutboxPublisher 再提供正式 adapter。Reconciler 对过期 staging 和 delete_pending 只通过该端口生成稳定幂等清理意图，不直接写 jobs 表，也不在 Web 请求中物理删除。
- 业务模块未来执行删除时，必须在同一数据库事务中完成“解除引用 + 标记 delete_pending + 发布 Outbox”；Phase 1 contract 用测试引用表证明三者一同提交或回滚。
- 对象不存在的删除视为成功；其他存储错误保留重试信息。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/storage
git commit -m "feat: add managed storage object lifecycle"
```

### Task 13: 实现 Outbox 和 Job PostgreSQL contract

**Files:**

- Create: `src/server/platform/jobs/jobTypes.ts`
- Create: `src/server/platform/jobs/outboxPublisher.ts`
- Create: `src/server/platform/jobs/outboxRepository.ts`
- Create: `src/server/platform/jobs/jobRepository.ts`
- Create: `src/server/platform/jobs/postgres/PostgresOutboxRepository.ts`
- Create: `src/server/platform/jobs/postgres/PostgresJobRepository.ts`
- Create: `src/server/platform/jobs/dispatcher.ts`
- Create: `src/server/platform/jobs/jobRepositories.integration.test.ts`
- Create: `src/server/platform/jobs/retryPolicy.ts`
- Create: `src/server/platform/jobs/retryPolicy.test.ts`

**Step 1: 写失败 contract**

测试：

- 业务状态与 Outbox 使用同一 `QueryExecutor` 事务提交/回滚。
- Dispatcher 事务将 event 转为 `outbox:<event-id>:<handler-version>` 幂等 Job 并标记 dispatched。
- 并发 Dispatcher 使用 `FOR UPDATE SKIP LOCKED`，不重复创建 Job。
- Job 原子领取、lease 过期回收、续租、成功、临时失败、永久失败、最大尝试进入 dead。
- 每次领取生成新的 lease token；旧 Worker 的续租、成功或失败回写因 fencing 条件不匹配而被拒绝。
- 相同幂等键 `ON CONFLICT DO NOTHING`。
- retry policy 为带抖动指数退避；测试注入随机源和时钟。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/jobs/retryPolicy.test.ts
npm run test:platform:integration -- src/server/platform/jobs/jobRepositories.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现原子队列 SQL**

领取使用单条 CTE/update returning：

```sql
with next_job as (
  select id from platform.jobs
  where (status = 'pending' and next_run_at <= now())
     or (status = 'running' and lease_expires_at <= now() and attempt_count < max_attempts)
  order by next_run_at, created_at, id
  for update skip locked
  limit 1
)
update platform.jobs j
set status = 'running', worker_id = $1, lease_expires_at = $2,
    lease_token = $3, attempt_count = attempt_count + 1
from next_job
where j.id = next_job.id
returning j.*;
```

在领取前或同一原子流程中，把 `running + lease expired + attempt_count >= max_attempts` 标记 dead。续租、成功、失败更新都必须匹配 `id + worker_id + lease_token + status='running'`；旧 lease 的晚到写入返回 `STALE_LEASE`，不能覆盖新 Worker。事务中只领取/更新状态；外部 SMTP/S3 调用绝不放入事务。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS，Jobs 分组低于 60 秒。

**Step 5: Commit**

```powershell
git add src/server/platform/jobs
git commit -m "feat: add PostgreSQL outbox and jobs"
```

### Task 14: 实现 Dispatcher、独立 Worker 和存储清理 handler

**Files:**

- Create: `src/server/platform/jobs/jobRegistry.ts`
- Create: `src/server/platform/jobs/worker.ts`
- Create: `src/server/platform/jobs/worker.integration.test.ts`
- Create: `src/server/platform/jobs/workerHeartbeatRepository.ts`
- Create: `src/server/platform/jobs/jobDiagnostics.ts`
- Create: `src/server/platform/jobs/jobDiagnosticsCli.ts`
- Create: `src/server/platform/jobs/jobDiagnosticsCli.test.ts`
- Create: `src/server/platform/jobs/handlers/deleteStorageObject.ts`
- Create: `src/server/platform/jobs/storageCleanup.integration.test.ts`
- Create: `src/server/platform/jobs/workerMain.ts`

**Step 1: 写失败测试**

使用可注入 clock、sleep、registry 和 AbortSignal，覆盖：

- 两个 Worker 不重复领取。
- handler 运行时不持有数据库事务。
- 崩溃/过期 lease 被另一 Worker 回收。
- transient error 退避；permanent error 直接 dead；超限 dead。
- SIGTERM/AbortSignal 停止领取，允许当前短任务收束并关闭 Pool。
- 删除对象 handler 对“对象不存在”幂等成功。
- Worker 按注入时钟定期调用 StorageReconciler，把过期 staging/delete_pending 通过 Outbox adapter 转成可重入清理 Job。
- 诊断 CLI 可列出队列/死信；重试单个死信必须指定 job ID 和人工原因，条件更新后追加审计，禁止批量无理由重放。

**Step 2: 运行 RED**

Run: `npm run test:platform:integration -- src/server/platform/jobs/worker.integration.test.ts src/server/platform/jobs/storageCleanup.integration.test.ts`

Expected: FAIL。

**Step 3: 实现 Worker loop**

不要写不可测试的裸 `while (true)`；实现 `runWorkerIteration()` 和接受 AbortSignal 的 `runWorker()`。每次迭代：派发有限批 Outbox、按到期时间运行一次 Reconciler、领取一个 Job、在事务外执行 handler、使用 lease token fencing 写结果/重试。Heartbeat 和诊断返回 Worker 最近活动、队列深度、最老任务年龄和死信数。

`workerMain.ts` 必须独立加载 worker 目标配置、创建 worker Pool、验证迁移版本、创建当前唯一 StorageAdapter 和 handler registry；任一门禁失败立即退出且关闭 Pool，不启动 Web，也不回退 legacy。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/jobs
git commit -m "feat: run leased platform jobs"
```

### Task 15: 实现一次性首管理员命令

**Files:**

- Create: `src/server/modules/identity/bootstrapAdminService.ts`
- Create: `src/server/modules/identity/bootstrapAdminService.integration.test.ts`
- Create: `src/server/commands/bootstrapAdmin.ts`
- Create: `src/server/commands/bootstrapAdmin.test.ts`

**Step 1: 写失败测试**

测试：

- 空 users 表才允许执行。
- 两个并发 bootstrap 只有一个成功。
- 密码不通过策略、TOTP 错误时不创建半成品管理员。
- 命令通过注入 prompt/output 测试，密码不出现在 argv、日志或错误中。
- 使用隐藏输入，终端和捕获输出都不能回显密码。
- TOTP 验证后同一事务创建 admin、TOTP credential、恢复码 hash 和审计。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/commands/bootstrapAdmin.test.ts
npm run test:platform:integration -- src/server/modules/identity/bootstrapAdminService.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现 CLI 和 service**

命令只使用 `PDF_APPROVAL_PLATFORM_BOOTSTRAP_DATABASE_URL` 对应的 `platform_bootstrap` 受限角色，不得使用 migration 角色。流程：通过 `@inquirer/prompts` 隐藏输入邮箱/姓名/密码 → 生成 TOTP secret 和 `otpauth://` URI → 操作者输入当前 TOTP → advisory transaction lock 再检查空库 → 保存完整管理员与同事务审计 → 一次性输出 10 个恢复码。任何失败都不留下用户。

禁止增加公网 bootstrap endpoint，禁止固定默认账号和密码。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/modules/identity/bootstrapAdminService.ts src/server/modules/identity/bootstrapAdminService.integration.test.ts src/server/commands
git commit -m "feat: bootstrap the first platform administrator"
```

### Task 16: 实现邀请、Outbox 邮件和 MFA 激活

**Files:**

- Create: `src/server/platform/mail/platformMailTransport.ts`
- Create: `src/server/platform/mail/platformMailTransport.test.ts`
- Create: `src/server/platform/mail/invitationEmail.ts`
- Create: `src/server/platform/jobs/handlers/sendInvitationEmail.ts`
- Create: `src/server/platform/jobs/invitationEmail.integration.test.ts`
- Create: `src/server/platform/testing/mailpitHarness.ts`
- Create: `src/server/modules/identity/invitationService.ts`
- Create: `src/server/modules/identity/invitationService.integration.test.ts`

**Step 1: 写失败测试**

覆盖：

- 管理员在项目内创建 24 小时邀请，业务记录、审计和 Outbox 同事务。
- Outbox payload 只有 `{ invitationId }`，不含邮箱、原始 token、密码或 TOTP secret。
- Worker 用 invitation ID + 记录的 key version 重建 token，生成 `/#/accept-invitation?token=...` fragment 链接。
- 篡改 token、未知 key version、stored hash 不匹配、邀请已撤销/过期时拒绝发送或激活；旧 key 在保留期内仍可验证。
- SMTP 使用稳定 Message-ID；Mailpit 无认证本地 SMTP 可以工作。
- prepare 返回短期 enrollment token 和 TOTP URI；complete 原子验证 TOTP、创建用户/项目成员/恢复码、消费邀请。
- 邀请过期、撤销、重复/并发 complete 只有一次成功。
- prepare/complete 都在 Argon2 或 TOTP 验证前执行 PostgreSQL 共享限流，维度包含来源 IP 和 invitation token hash。
- Mailpit harness 每次测试前后清空消息，按稳定 Message-ID + recipient 查询，禁止命中旧邮件假通过。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/mail/platformMailTransport.test.ts
npm run test:platform:integration -- src/server/modules/identity/invitationService.integration.test.ts
npm run test:platform:integration -- src/server/platform/jobs/invitationEmail.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现邀请服务**

公开原始 token 只存在于邮件/浏览器内存。数据库保存：token hash、HMAC key version；Job 只保存 invitation ID。邀请 token 放 URL fragment，浏览器再通过 JSON body 提交，避免进入访问日志和 Referer。

`prepare` 不创建用户；它创建 FK 绑定 invitation 的短期 `mfa_enrollments`，保存加密 TOTP secret 和 enrollment token hash。每个邀请最多一个有效 enrollment；再次 prepare 原子作废旧 enrollment。`complete` 只信任数据库 invitation 的邮箱、项目和角色，重新检查未过期/未撤销/未消费，并提交 enrollment token、密码、TOTP，在一个事务内完成所有身份记录、项目成员、审计和邀请消费。

SMTP 至少一次投递可能重复，文档和审计不得声称 exactly-once。

运行手册要求邀请 HMAC 旧 key 至少保留到“最长邀请有效期 + 最大 Job 重试窗口”结束。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/mail src/server/platform/jobs/handlers/sendInvitationEmail.ts src/server/platform/jobs/invitationEmail.integration.test.ts src/server/modules/identity/invitationService.ts src/server/modules/identity/invitationService.integration.test.ts
git commit -m "feat: deliver invitation activation through outbox"
```

### Task 17: 实现密码登录、MFA challenge、恢复码和 Cookie session

**Files:**

- Create: `src/server/platform/security/rateLimitService.ts`
- Create: `src/server/platform/security/rateLimitService.integration.test.ts`
- Create: `src/server/platform/security/sessionService.ts`
- Create: `src/server/platform/security/sessionService.integration.test.ts`
- Create: `src/server/modules/identity/authenticationService.ts`
- Create: `src/server/modules/identity/authenticationService.integration.test.ts`

**Step 1: 写失败测试**

测试：

- 限流在昂贵 Argon2 前执行，账号不存在和密码错误响应一致。
- 未知邮箱也验证固定、合法参数的 dummy Argon2id hash；通过注入 password verifier 的确定性测试证明未知账号和已知账号错误密码都恰好执行一次同参数级别 Argon2id 校验，避免依赖易波动的墙钟断言。
- 密码在进入 Argon2 前执行合理最大字节长度限制，避免超长输入放大 CPU/内存消耗。
- 密码成功只创建 5 分钟 MFA challenge，不创建 session。
- TOTP/恢复码通过才创建高熵 session token，DB 只存 hash。
- 恢复码并发只能消费一次。
- session 绝对 12 小时、空闲 60 分钟；touch 最多每 5 分钟写一次。
- 修改密码/禁用用户后撤销全部 session。
- 登录成功/失败、MFA、恢复码、撤销都写审计且不含秘密。
- 所有成功状态修改与审计在同一事务，审计失败则业务失败；失败登录审计用独立事务，写入失败时返回脱敏的安全依赖不可用错误并记录高优先级服务日志。

**Step 2: 运行 RED**

Run: `npm run test:platform:integration -- src/server/platform/security/rateLimitService.integration.test.ts src/server/platform/security/sessionService.integration.test.ts src/server/modules/identity/authenticationService.integration.test.ts`

Expected: FAIL。

**Step 3: 实现服务**

服务返回领域结果，不直接操作 Express：

```ts
type LoginResult = { next: "mfa"; challengeToken: string };
type CompleteMfaResult = { sessionToken: string; user: PlatformUser; recoveryCodes?: string[] };
```

原始 challenge/session token 只返回一次。任何日志只记录 request ID、用户 ID（已知时）和稳定错误码。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/security/rateLimitService.ts src/server/platform/security/rateLimitService.integration.test.ts src/server/platform/security/sessionService.ts src/server/platform/security/sessionService.integration.test.ts src/server/modules/identity/authenticationService.ts src/server/modules/identity/authenticationService.integration.test.ts
git commit -m "feat: authenticate platform sessions with MFA"
```

### Task 18: 实现 v2 HTTP 安全、会话、邀请和项目权限路由

**Files:**

- Create: `src/shared/contracts/problem.ts`
- Create: `src/shared/contracts/identity.ts`
- Create: `src/server/platform/http/requestContext.ts`
- Create: `src/server/platform/http/problemResponse.ts`
- Create: `src/server/platform/http/asyncRoute.ts`
- Create: `src/server/platform/http/asyncRoute.test.ts`
- Create: `src/server/platform/http/errorMiddleware.ts`
- Create: `src/server/platform/http/errorMiddleware.test.ts`
- Create: `src/server/platform/security/originGuard.ts`
- Create: `src/server/platform/security/originGuard.test.ts`
- Create: `src/server/platform/security/csrf.ts`
- Create: `src/server/platform/security/csrf.test.ts`
- Create: `src/server/platform/security/sessionMiddleware.ts`
- Create: `src/server/platform/security/sessionMiddleware.test.ts`
- Create: `src/server/platform/security/clientAddress.ts`
- Create: `src/server/platform/security/clientAddress.test.ts`
- Create: `src/server/modules/identity/capabilities.ts`
- Create: `src/server/modules/identity/capabilities.test.ts`
- Create: `src/server/modules/identity/authorizationService.ts`
- Create: `src/server/modules/identity/authorizationService.integration.test.ts`
- Create: `src/server/modules/identity/routes/authRoutes.ts`
- Create: `src/server/modules/identity/routes/sessionRoutes.ts`
- Create: `src/server/modules/identity/routes/invitationRoutes.ts`
- Create: `src/server/modules/identity/routes/projectAccessRoutes.ts`
- Create: `src/server/modules/identity/routes/identityRoutes.integration.test.ts`

**Step 1: 写失败测试**

API 契约：

- `POST /api/v2/auth/login`
- `POST /api/v2/auth/mfa/complete`
- `GET /api/v2/session`
- `DELETE /api/v2/session`
- `POST /api/v2/invitations`
- `POST /api/v2/invitations/prepare`
- `POST /api/v2/invitations/complete`
- `POST /api/v2/projects`
- `GET /api/v2/projects`
- `GET /api/v2/projects/:id/access`

测试 Cookie 属性、problem+json、request ID、Origin/JSON Content-Type、缺失/错误/跨会话 CSRF、权限矩阵、非成员统一 404、成员/角色变更审计。额外覆盖 Express 4 async route rejection、PG 异常和未知异常均进入同一终端错误中间件，响应不泄露堆栈、SQL、URL 密码或秘密。

客户端地址测试覆盖：未受信客户端伪造 `X-Forwarded-For` 被忽略、受信代理链正确解析、IPv4/IPv6 prefix 规范化后再进入限流 bucket。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/http/asyncRoute.test.ts src/server/platform/http/errorMiddleware.test.ts src/server/platform/security/originGuard.test.ts src/server/platform/security/csrf.test.ts src/server/platform/security/sessionMiddleware.test.ts src/server/platform/security/clientAddress.test.ts src/server/modules/identity/capabilities.test.ts
npm run test:platform:integration -- src/server/modules/identity/routes/identityRoutes.integration.test.ts src/server/modules/identity/authorizationService.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现中间件和路由**

- v2 使用 `application/problem+json`，不返回 legacy `{ error }`。
- 所有 Promise handler 必须由 `asyncRoute()` 包装；终端 `errorMiddleware` 做稳定错误映射、脱敏和 request ID 关联，禁止悬挂 Promise 或宽泛 catch 后继续成功响应。
- Platform auth context 使用独立 `res.locals.platformAuth` 类型，不能复用数值 ID 的 legacy `req.user`。
- `GET /session` 设置 `Cache-Control: no-store`，返回用户、capabilities、项目摘要和会话绑定 CSRF token。
- CSRF token 由 session ID + 版本化 HMAC 派生；前端不持久化。
- Cookie：生产 `__Host-pdf_approval_session` + HttpOnly/Secure/SameSite=Lax/Path=/；非生产显式配置可使用无 `__Host-` 名称。
- 未认证修改入口要求 JSON、可信 Origin、`Sec-Fetch-Site` 非 cross-site。
- 登录、MFA、邀请 prepare/complete 分别使用 PostgreSQL 共享限流；任何 Argon2/TOTP 工作前先检查限流。
- 管理员拥有安全管理能力，但项目数据仍要求有效成员关系；创建项目时自动成为 manager。
- 路由只调用 service，不写 SQL。
- 所有身份端点统一返回 `Cache-Control: no-store`；TOTP URI、enrollment/challenge token、恢复码响应也不允许被浏览器或代理缓存。
- 创建/消费邀请、创建/撤销 session、消费恢复码、创建项目/成员和角色变更都必须与成功审计同一事务。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同。

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/shared/contracts src/server/platform/http src/server/platform/security/originGuard.ts src/server/platform/security/originGuard.test.ts src/server/platform/security/csrf.ts src/server/platform/security/csrf.test.ts src/server/platform/security/sessionMiddleware.ts src/server/platform/security/sessionMiddleware.test.ts src/server/platform/security/clientAddress.ts src/server/platform/security/clientAddress.test.ts src/server/modules/identity/capabilities.ts src/server/modules/identity/capabilities.test.ts src/server/modules/identity/authorizationService.ts src/server/modules/identity/authorizationService.integration.test.ts src/server/modules/identity/routes
git commit -m "feat: expose secure v2 identity routes"
```

### Task 19: 组装 Platform Web、健康检查和关闭生命周期

**Files:**

- Create: `src/server/platform/server.ts`
- Create: `src/server/platform/server.test.ts`
- Create: `src/server/platform/health.ts`
- Create: `src/server/platform/health.test.ts`
- Create: `src/server/platform/dependencyHealthCache.ts`
- Create: `src/server/platform/dependencyHealthCache.test.ts`
- Create: `src/server/platform/startPlatformWebServer.ts`
- Create: `src/server/platform/startPlatformWebServer.integration.test.ts`
- Create: `src/server/legacyPackageIsolation.test.ts`
- Modify: `src/server/services/publicHealth.ts`
- Modify: `src/server/services/publicHealth.test.ts`
- Modify: `src/server/server.test.ts`

**Step 1: 写失败测试**

覆盖：

- legacy `/health` 增加 `runtimeMode: "legacy"`，其余 v1 字段不变。
- platform `/health` 返回 `runtimeMode: "platform"` 和公开版本信息，供同一前端 bundle 选择入口；该端点不暴露依赖、凭据或内部拓扑。
- platform `/health/live` 只证明进程可响应。
- platform `/health/ready` 检查 PostgreSQL、预期迁移和当前唯一 StorageAdapter。
- Worker/SMTP 不健康单独报告，不让核心 API readiness 因邮件短暂失败而摘除。
- readiness 的 PostgreSQL/storage 检查使用短超时、短 TTL 和 singleflight；并发探测只触发一次依赖 I/O，`/health/live` 绝不访问外部依赖。
- `/api/auth/login` 和 `/api/auth/register-designer` 在 platform 为 404。
- schema 落后/超前、PG/storage 失败明确拒绝 ready/start，不回退 SQLite。
- 启动失败和 HTTP close 都释放 Pool/Storage 资源。
- 已校验 trusted proxy 配置实际应用到 Express；未受信来源不能借伪造 `X-Forwarded-For` 绕过限流。
- 从真实 `src/server/index.ts` 和 `serverExeEntry.ts` 递归遍历静态 import graph，legacy-only 图不得到达 `src/server/platform` 或 platform-only 第三方依赖；动态 platform import 明确排除。Windows server package 文档明确为 legacy-only。

**Step 2: 运行 RED**

Run:

```powershell
npm test -- --run src/server/platform/server.test.ts src/server/platform/health.test.ts src/server/platform/dependencyHealthCache.test.ts src/server/services/publicHealth.test.ts src/server/server.test.ts src/server/legacyPackageIsolation.test.ts
npm run test:platform:integration -- src/server/platform/startPlatformWebServer.integration.test.ts
```

Expected: FAIL。

**Step 3: 实现独立组合根**

Platform 组合根依次：加载 web config → 创建 web Pool → assert schema → 创建唯一 StorageAdapter → 创建 Repository/service → `app.set("trust proxy", validatedTrustedProxy)` → 挂载 request context/JSON/origin/session/CSRF/v2 routes → 终端 problem error middleware → 静态客户端 → health。

readiness 通过 `dependencyHealthCache` 合并并发检查、施加有界 TTL/超时；storage probe 不得因负载均衡频率持续写 OSS。

不得调用：`createDatabase()`、`users.ensureDefaultUsers()`、legacy auth/JWT/CORS、文件 watcher 或 legacy maintenance scheduler。

**Step 4: 运行 GREEN 和 legacy 回归**

Run:

```powershell
npm test -- --run src/server/platform/server.test.ts src/server/platform/health.test.ts src/server/platform/dependencyHealthCache.test.ts src/server/services/publicHealth.test.ts src/server/server.test.ts src/server/legacyPackageIsolation.test.ts src/server/startConfiguredServer.test.ts src/server/startServer.test.ts
npm run test:platform:integration -- src/server/platform/startPlatformWebServer.integration.test.ts
npm run build
```

Expected: PASS。

**Step 5: Commit**

```powershell
git add src/server/platform/server.ts src/server/platform/server.test.ts src/server/platform/health.ts src/server/platform/health.test.ts src/server/platform/dependencyHealthCache.ts src/server/platform/dependencyHealthCache.test.ts src/server/platform/startPlatformWebServer.ts src/server/platform/startPlatformWebServer.integration.test.ts src/server/legacyPackageIsolation.test.ts src/server/services/publicHealth.ts src/server/services/publicHealth.test.ts src/server/server.test.ts
git commit -m "feat: assemble the platform web runtime"
```

### Task 20: 新增独立 platform 客户端 API 和身份状态机

**Files:**

- Create: `src/client/api/platformRequest.ts`
- Create: `src/client/api/platformRequest.test.ts`
- Create: `src/client/api/identityClient.ts`
- Create: `src/client/api/identityClient.test.ts`
- Create: `src/client/features/identity/identityRoutes.ts`
- Create: `src/client/features/identity/identityRoutes.test.ts`
- Create: `src/client/features/identity/identityState.ts`
- Create: `src/client/features/identity/identityState.test.ts`
- Create: `src/client/RuntimeApp.tsx`
- Create: `src/client/runtimeApp.test.ts`
- Modify: `src/client/main.tsx`
- Modify: `src/client/api.ts`

**Step 1: 写失败测试**

测试：

- browser 通过 `/health.runtimeMode` 选择 legacy `App` 或 platform identity；探测失败显示错误，不默认 legacy。
- Electron 保持现有 server address/legacy 流程。
- platform request 固定 `credentials: "same-origin"`，解析 problem+json。
- CSRF 只保存在模块内存；刷新后从 `/api/v2/session` 重新获得。
- challenge、invitation、enrollment token、TOTP secret/URI、recovery codes 不写 localStorage/sessionStorage，不进入 console、遥测或错误上报。
- legacy `src/client/api.ts` 的 JWT/localStorage 行为完全不变。

**Step 2: 运行 RED**

Run: `npm test -- --run src/client/api/platformRequest.test.ts src/client/api/identityClient.test.ts src/client/features/identity/identityRoutes.test.ts src/client/features/identity/identityState.test.ts src/client/runtimeApp.test.ts src/client/api.test.ts`

Expected: FAIL。

**Step 3: 实现隔离状态机**

身份状态明确为：`loading | signedOut | mfaChallenge | acceptingInvitation | showingRecoveryCodes | signedIn | fatalError`。完成、取消、异常、logout 和组件卸载时显式清空 challenge、invitation、enrollment、TOTP 和恢复码内存。`RuntimeApp` 只负责选择入口；不得把 platform Cookie 逻辑塞进 legacy `App.tsx`。

**Step 4: 运行 GREEN**

Run: 与 Step 2 相同，再运行 `npm run build`。

Expected: PASS；构建仅允许既有 PDF.js chunk 警告。

**Step 5: Commit**

```powershell
git add src/client/api/platformRequest.ts src/client/api/platformRequest.test.ts src/client/api/identityClient.ts src/client/api/identityClient.test.ts src/client/features/identity/identityRoutes.ts src/client/features/identity/identityRoutes.test.ts src/client/features/identity/identityState.ts src/client/features/identity/identityState.test.ts src/client/RuntimeApp.tsx src/client/runtimeApp.test.ts src/client/main.tsx src/client/api.ts
git commit -m "feat: add platform identity client state"
```

### Task 21: 实现最小可用的邀请、MFA 和项目访问界面

**Files:**

- Create: `src/client/features/identity/PlatformIdentityApp.tsx`
- Create: `src/client/features/identity/PlatformLoginPage.tsx`
- Create: `src/client/features/identity/MfaChallengePage.tsx`
- Create: `src/client/features/identity/InvitationAcceptancePage.tsx`
- Create: `src/client/features/identity/RecoveryCodesPage.tsx`
- Create: `src/client/features/identity/PlatformAccessPage.tsx`
- Create: `src/client/features/identity/platformIdentity.css`
- Modify: `src/client/RuntimeApp.tsx`

**Step 1: 先写可浏览器验证的验收清单**

Phase 1 UI 只覆盖安全闭环，不提前实施 Phase 2 AppShell/设计系统：

- 邮箱+密码登录后明确进入 MFA，不显示已登录状态。
- 支持 TOTP 和恢复码两种 MFA 方法。
- 邀请 fragment token 自动读入内存并立即从地址栏移除。
- 邀请用户设置密码、扫描/复制 TOTP、确认验证码。
- 恢复码只展示一次，用户确认保存后才能继续。
- 管理员可创建最小项目、邀请项目成员；普通用户只能看到授权项目。
- loading、空态、错误、成功反馈、键盘焦点、移动布局和基本可访问性完整。

**Step 2: 创建组件并让 TypeScript 首先失败**

Run: `npm run build`

Expected: 在组件尚未完成时 FAIL，缺少明确 props/状态分支。

**Step 3: 实现最小 UI**

使用语义化 `main/form/label/button`，不复制 legacy 自注册、快捷账号和密码找回。样式只在 `platformIdentity.css` 内，视觉保持克制的“精密工业”方向，但不新建通用 UI 组件或重构全局 CSS。

使用 `qrcode` 在浏览器内把 `otpauth://` URI 渲染为二维码，同时提供可复制的手工密钥；二维码生成失败必须显示可操作错误，不能把 secret 发给第三方二维码服务。

敏感值规则：

- 密码/TOTP 不进 URL。
- invitation fragment 读取后 `history.replaceState` 清除。
- recovery codes 不记录 console，不持久化。
- 收到 `Cache-Control: no-store`；浏览器后退/bfcache 不能重新展示 TOTP secret 或恢复码。
- 网络错误保留重试入口，不隐藏 fallback 到 v1。

**Step 4: 验证构建和现有客户端测试**

Run:

```powershell
npm run build
npm test -- --run src/client
```

Expected: PASS，legacy 客户端 223 项不回归。

**Step 5: Commit**

```powershell
git add src/client/features/identity src/client/RuntimeApp.tsx
git commit -m "feat: add platform identity activation UI"
```

### Task 22: 建立平台浏览器 E2E、故障门禁和最终验证

**Files:**

- Create: `playwright.platform.config.ts`
- Create: `e2e/platform/support/fixtures.ts`
- Create: `e2e/platform/support/server.ts`
- Create: `e2e/platform/support/worker.ts`
- Create: `e2e/platform/support/seed.ts`
- Create: `e2e/platform/support/totp.ts`
- Create: `e2e/platform/support/mailpit.ts`
- Create: `e2e/platform/identity-security.spec.ts`
- Create: `e2e/platform/session-csrf.spec.ts`
- Create: `e2e/platform/project-access.spec.ts`
- Modify: `package.json`
- Modify: `tsconfig.e2e.json`
- Modify: `vite.config.ts`
- Modify: `docs/verification.md`
- Create: `docs/runbooks/phase-1-local-platform.md`

**Step 1: 写失败 E2E**

关键路径：

1. 已完成 MFA 的首管理员 fixture 输入密码后仍停在 MFA。
2. 输入当前 TOTP 后建立 Cookie session。
3. 管理员创建项目和邀请。
4. 从 Mailpit API 读取邮件，提取 fragment token。
5. 被邀请用户设置密码、绑定 TOTP、一次性查看恢复码。
6. 新用户重新登录并访问授权项目。
7. 未授权项目返回 404。
8. 缺失/错误/另一 session 的 CSRF 被拒绝。
9. 恢复码只能使用一次；失败尝试触发 PostgreSQL 共享限流。
10. 退出后旧 Cookie 和 CSRF 失效。
11. 邀请 prepare/complete 的失败尝试同样触发共享限流。
12. TOTP secret、enrollment/challenge token、恢复码不残留在 URL、localStorage、sessionStorage、console 或后退导航，敏感响应均为 `Cache-Control: no-store`。

先运行 desktop identity spec，Expected: FAIL，因为 harness/spec 尚未完成。

**Step 2: 实现独立 platform harness**

- 使用独立测试数据库 schema、MinIO 前缀和 Mailpit 清理，不接触 legacy `.cache/e2e/runtime`。
- 测试启动 platform Web 和 Worker，退出时关闭 HTTP/Pool/Worker 并确认端口释放。
- `playwright.platform.config.ts` 使用独立端口和 desktop/mobile 项目，不改现有 `playwright.config.ts`。
- `vite.config.ts` 只增加 platform 测试目标解析，legacy 默认代理不变。

在 `package.json` 增加 `e2e:platform`。

**Step 3: 分组运行平台门禁**

Run:

```powershell
npm run e2e:platform -- --project=desktop-chromium e2e/platform/identity-security.spec.ts
npm run e2e:platform -- --project=desktop-chromium e2e/platform/session-csrf.spec.ts e2e/platform/project-access.spec.ts
npm run e2e:platform -- --project=mobile-chromium e2e/platform/identity-security.spec.ts
npm run e2e:typecheck
```

Expected: 全部 PASS；登录页和主要已登录面板 Axe critical 为 0；无横向溢出；后台端口全部释放。

**Step 4: 运行全部 platform 单元与分组后端门禁**

每条命令由执行器设置 60 秒硬超时：

```powershell
npm run test:platform:unit
npm run test:platform:integration -- src/server/platform/database/database.integration.test.ts src/server/platform/database/migrations.integration.test.ts src/server/platform/database/platformSchema.integration.test.ts
npm run test:platform:integration -- src/server/modules/identity/repositories/postgresIdentityRepositories.integration.test.ts src/server/modules/identity/repositories/postgresSecurityRepositories.integration.test.ts
npm run test:platform:integration -- src/server/modules/identity/bootstrapAdminService.integration.test.ts src/server/modules/identity/invitationService.integration.test.ts
npm run test:platform:integration -- src/server/platform/security/rateLimitService.integration.test.ts src/server/platform/security/sessionService.integration.test.ts src/server/modules/identity/authenticationService.integration.test.ts
npm run test:platform:integration -- src/server/modules/identity/routes/identityRoutes.integration.test.ts src/server/modules/identity/authorizationService.integration.test.ts src/server/platform/startPlatformWebServer.integration.test.ts
npm run test:platform:integration -- src/server/platform/storage/s3Storage.integration.test.ts src/server/platform/storage/storageObjectRepository.integration.test.ts
npm run test:platform:integration -- src/server/platform/storage/storageObjectService.integration.test.ts src/server/platform/storage/storageReconciler.integration.test.ts
npm run test:platform:integration -- src/server/platform/jobs/jobRepositories.integration.test.ts src/server/platform/jobs/invitationEmail.integration.test.ts
npm run test:platform:integration -- src/server/platform/jobs/worker.integration.test.ts src/server/platform/jobs/storageCleanup.integration.test.ts
```

Expected: 全部 PASS；任一分组接近 60 秒时继续拆分，禁止提高 watchdog 掩盖超时。

**Step 5: 运行 Phase 0 legacy 门禁**

```powershell
npm test -- --run src/client
npm test -- --run src/server/auth.test.ts src/server/domain src/server/repositories src/server/services src/server/files src/server/pdf
npm test -- --run src/server/routes/auth.test.ts src/server/routes/submissions.test.ts src/server/routes/approvals.test.ts src/server/routes/approvalAnnotations.test.ts src/server/routes/approvalComments.test.ts src/server/routes/pdm.test.ts
npm test -- --run src/server/routes/settings.test.ts src/server/routes/system.test.ts src/server/routes/users.test.ts src/server/routes/profile.test.ts src/server/routes/signatures.test.ts src/server/routes/signatureTemplates.test.ts src/server/routes/operationLogs.test.ts src/server/routes/reports.test.ts src/server/routes/tray.test.ts src/server/server.test.ts src/server/startServer.test.ts src/server/dbIndexes.test.ts
npm test -- --run src/server/serverPackage.test.ts src/server/serverExePackage.test.ts
npm run desktop:test
npm run build
npm run e2e
git diff --check
```

Expected: 客户端 223、legacy 后端 283、Electron 12、Playwright 20 项至少保持 Phase 0 基线；构建只保留已知 PDF.js chunk 警告。

**Step 6: 写验证与本地运行手册**

`docs/runbooks/phase-1-local-platform.md` 必须给出：

- `npm ci`
- `npm run infra:up`
- `npm run platform:db:migrate`
- `npm run platform:bootstrap-admin`
- platform Web/Worker 启动命令
- filesystem/S3 两种配置示例
- TOTP/邀请/恢复码/CSRF keyring 轮换说明；邀请旧 key 至少保留到最长邀请期限加最大 Job 重试窗口结束
- 健康检查、Mailpit/MinIO 地址
- 停止和清理命令
- 明确“不迁移正式数据、不创建云资源、不替代 legacy”的范围说明

`docs/verification.md` 记录每组实际命令、用例数量、墙钟、失败恢复证据、端口释放和已知警告。不要预填未经执行的 PASS 数量。

**Step 7: Commit**

```powershell
git add playwright.platform.config.ts e2e/platform package.json package-lock.json tsconfig.e2e.json vite.config.ts docs/verification.md docs/runbooks/phase-1-local-platform.md
git commit -m "test: close Phase 1 platform foundation"
```

## 完成定义

只有以下条件全部满足才能声称 Phase 1 完成：

- platform 新能力通过 PostgreSQL、filesystem、MinIO、Mailpit 真实集成测试。
- 邀请、TOTP、恢复码、Cookie、CSRF、限流、权限、审计在浏览器关键路径中可用。
- Worker 的并发领取、崩溃恢复、幂等、重试、死信和存储清理有故障证据。
- platform 配置或依赖错误明确失败，无 SQLite/本地文件隐藏 fallback。
- legacy v1、SQLite、本地文件、Electron 和现有 Playwright 基线无回归。
- 正式数据、生产服务和收费云资源未被访问或修改。
- 工作树只包含已审阅的 Phase 1 提交，`git status --short` 为空。

## 执行方式

用户已选择在当前会话采用 Subagent-Driven 方式。计划提交后，使用 `superpowers:subagent-driven-development`：每个 Task 分配新的实现代理，随后分别做规格复核和质量复核；主代理负责最终 diff、测试和完成判断。
