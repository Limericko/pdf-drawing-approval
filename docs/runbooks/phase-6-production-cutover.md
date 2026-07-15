# Phase 6 生产发布、恢复与切换手册

## 1. 适用边界

本手册适用于任何标准 Linux Docker/OCI 环境。云厂商可以不同，但必须提供两个故障域、HTTPS 入口、PostgreSQL、S3 兼容私有对象存储、密钥管理、集中日志和监控。

没有真实域名、目标主机、数据库、对象存储和负责人时，只能完成本地演练，不得声明正式上线。

## 2. 发布前证据

- 镜像使用 `repository@sha256:digest`，基础镜像和应用镜像 digest 均已记录。
- 镜像签名与 SBOM 验证通过，高危漏洞为零或已有书面例外。
- PostgreSQL 备份、日志备份和最近恢复点满足 RPO 5 分钟。
- S3 Bucket 私有、版本化、加密和删除保护开启。
- Secret bundle 不在仓库、镜像、日志、Terraform state 或客户端资源中。
- `migration-report.json` 中 `verification.eligibleForCutover=true`。
- 3 个缺邮箱旧账号均已有唯一、可收信的正式邮箱。
- 管理员、设计师、主管、工艺四类账号已完成邀请和 MFA 演练。

任一项缺失即为 No-Go。

## 3. 滚动发布

1. 记录上一应用镜像 digest、当前 schema 版本和当前健康实例数。
2. 运行兼容性数据库迁移；只允许 expand/contract 迁移。
3. 从流量入口摘除实例 A，等待活动连接排空。
4. 使用新 digest 启动实例 A，验证 `/health/ready`、登录、PDF 读取和 Worker 心跳。
5. 实例 A 稳定后重新加入流量，再对实例 B 重复。
6. 发布期间必须始终至少有一个旧或新实例健康。
7. 记录操作者、时间、旧/新 digest、迁移版本、检查结果和告警链接。

## 4. 应用回退

- readiness、登录、PDF、Worker 或错误率任一门禁失败，立即停止替换下一实例。
- 从流量入口摘除失败实例，切回上一应用镜像 digest。
- 数据库不执行破坏性反向迁移；新旧镜像必须通过 expand/contract 兼容。
- 如果新系统已经开放写入，不得用旧 SQLite 覆盖 PostgreSQL；先冻结新写入并导出云端增量。

## 5. 备份恢复演练

每次正式切换前必须完成一次隔离恢复：

1. 将最近 PostgreSQL 全量备份和日志恢复到新的隔离实例。
2. 使用只读校验账号检查 schema 版本、逐表计数、外键和关键业务聚合。
3. 从 S3 版本清单抽样并全量核对对象大小与 SHA-256；验证原始、标注和签后 PDF 可解析。
4. 在隔离环境启动 Web/Worker，完成四角色浏览器冒烟。
5. 记录恢复开始、数据恢复点、服务可用时间，证明 RPO ≤ 5 分钟、RTO ≤ 30 分钟。

未达到目标时不得切换。

## 6. 正式数据切换

1. 旧系统进入只读，暂停 WebDAV 入站。
2. 创建最终 SQLite 在线一致快照和同一时点文件副本。
3. 以 `PDF_APPROVAL_LEGACY_MODE=delta` 运行 `legacy-migration`。
4. 核对报告中的源指纹、baseline run、逐类计数、对象回读和所有 verify 结果。
5. 管理员、设计师、主管、工艺完成登录、任务、PDF、标注、问题、并行双审、签章、PDM、归档和 WebDAV 冒烟。
6. Go/No-Go 负责人签字后切换 DNS/HTTPS 入口，恢复 WebDAV 并开放写入。
7. 旧系统在观察期内保持只读，不删除 SQLite、文件或最终备份。

## 7. 观察期

连续观察入口 5xx 和延迟、数据库连接、S3 错误、Worker 心跳、任务积压、死信、WebDAV 冲突和 SMTP 投递。观察期结束前不得移除旧 keyring、旧镜像、旧系统只读副本或最终迁移报告。
