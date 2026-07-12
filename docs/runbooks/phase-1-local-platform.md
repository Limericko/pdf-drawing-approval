# Phase 1 本地平台运行手册

## 邀请 HMAC 轮换

`PDF_APPROVAL_INVITATION_HMAC_KEYRING` 轮换时，先加入新 key 并把 `currentVersion` 切换到新版本，不要立即删除旧 key。Worker 会按邀请记录中的 key version 重建链接，因此旧 key 至少要保留“最长邀请有效期 24 小时 + 当前部署的最大 Job 重试窗口”。重试窗口必须根据实际 Worker 重试配置计算，不得使用未验证的固定时长。

邀请邮件是 at-least-once 投递：Job 重试可能产生重复邮件，稳定 Message-ID 不等于 exactly-once。重新邀请会撤销同项目、同归一化邮箱的旧活跃邀请，晚到的旧 Job 必须永久拒绝发送。

完整的生产轮换、观察和回滚步骤在 Task 22 及之后扩展；本节不记录尚未执行的部署或验证结果。
