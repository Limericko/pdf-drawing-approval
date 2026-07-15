# 阿里云中国香港可选适配层

这里仅用于存放阿里云中国香港的可选基础设施模板。它不得修改或替代根级 `Dockerfile`、`deploy/compose.production.yaml`、迁移工具和标准环境变量契约。

当前尚未提交可用 Terraform 模板；原先只包含 provider 与区域约束的初稿已移除，避免把未完成文件误认为通用部署入口。后续模板应只负责把通用运行契约映射到 ECS/ACK、RDS PostgreSQL、OSS、ALB/WAF、ACR 和 KMS，并通过与通用 Compose 相同的验收门禁。
