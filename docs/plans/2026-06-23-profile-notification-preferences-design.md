# 用户资料与角色通知偏好设计

## 目标

为每个登录用户增加可自行维护的个人资料，包含显示名、邮箱和通知偏好；设计师、主管、工艺额外维护常用项目；同时按设计师、主管、工艺、管理员的不同职责，在关键审批进度变化时发送合适的提醒。

## 范围

本次只做局域网审批系统内部所需的轻量资料与通知能力：

- 所有角色可进入“我的资料”页面。
- 用户可修改自己的显示名、邮箱和通知偏好。
- 设计师、主管、工艺可维护常用项目；管理员不显示、不保存常用项目。
- 管理员仍可在“系统管理”维护用户基础信息。
- 设计师提交图纸时可快速选择常用项目。
- 邮件通知尊重用户邮箱与通知偏好；SMTP 未配置时不阻断审批。
- 通知失败写入操作日志，便于管理员排查。

不在本次范围内：

- 站内消息中心、未读角标、已读状态。
- 企业微信、飞书、短信等外部推送。
- 按项目动态分配主管/工艺审核人。

## 角色与通知事件

### 设计师

设计师关注自己提交的图纸进度：

- `approval_rejected`：图纸被主管或工艺驳回。
- `approval_approved_for_print`：主管和工艺均通过，进入待打印。
- `signature_failed`：自动生成签后 PDF 失败。
- `approval_printed`：图纸已标记打印归档。

### 主管

主管关注待自己审核以及工艺进度：

- `review_task_created`：有新图纸待审核。
- `peer_review_completed`：工艺已完成审核，但主管仍需处理或图纸状态已变化。
- `approval_rejected`：图纸被驳回。
- `approval_approved_for_print`：图纸进入待打印。

### 工艺

工艺与主管对称：

- `review_task_created`：有新图纸待审核。
- `peer_review_completed`：主管已完成审核，但工艺仍需处理或图纸状态已变化。
- `approval_rejected`：图纸被驳回。
- `approval_approved_for_print`：图纸进入待打印。

### 管理员

管理员关注系统运维风险：

- `signature_failed`：自动签名失败。
- `system_risk`：文件缺失、无效 PDF、备份过期、标准目录异常等风险。

第一版管理员风险仍优先在系统管理页展示；邮件只覆盖签名失败这种需要立即处理的事件，避免邮件噪音。

## 数据模型

继续使用 `users` 保存基础字段：

- `display_name`
- `email`

新增用户偏好表 `user_preferences`：

- `user_id INTEGER PRIMARY KEY`
- `common_projects_json TEXT NOT NULL DEFAULT '[]'`
- `notification_preferences_json TEXT NOT NULL DEFAULT '{}'`
- `updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

偏好 JSON 使用稳定结构：

```json
{
  "email": {
    "review_task_created": true,
    "peer_review_completed": true,
    "approval_rejected": true,
    "approval_approved_for_print": true,
    "signature_failed": true,
    "approval_printed": true,
    "system_risk": false
  }
}
```

后端按角色提供默认值。不存在偏好记录时自动返回默认值，不要求初始化所有用户。

## 后端接口

新增个人资料接口：

- `GET /api/profile`
  - 登录用户可访问。
  - 返回当前用户基础资料、通知偏好和按角色可配置的通知项。
  - 设计师、主管、工艺额外返回常用项目；管理员固定返回空常用项目。

- `PUT /api/profile`
  - 登录用户可访问。
  - 可修改 `displayName`、`email`、`commonProjects`、`notificationPreferences`。
  - 不允许修改用户名、角色、启用状态。
  - 邮箱可为空；非空必须是合法邮箱。
  - 常用项目去重、trim、限制数量。
  - 管理员提交的 `commonProjects` 会被忽略并清空。

新增或复用服务：

- `UserPreferenceRepository`
  - `getForUser(user)`
  - `upsertForUser(userId, input)`

- `notificationPreference.ts`
  - 根据角色生成默认通知偏好。
  - 判断某个用户是否应接收某个事件。

- `approvalNotifications.ts`
  - 封装审批状态变化邮件。
  - 复用 `sendEmail` 和现有 SMTP 设置。
  - 发送失败写入 `operation_logs`。

## 通知触发点

### 新图纸创建

文件夹监听和网页上传都触发 `review_task_created`：

- 文件夹监听已有 `notifyApprovalCreated`。
- 网页上传确认后也调用同一通知入口。
- 收件人是主管和工艺角色用户，尊重各自偏好和邮箱。

### 审核完成

`POST /api/approvals/:id/review` 后：

- 若仍处于 `pending`，通知另一审核角色 `peer_review_completed`。
- 若进入 `rejected`，通知设计师和另一审核角色 `approval_rejected`。
- 若进入 `approved_for_print`，通知设计师、主管、工艺 `approval_approved_for_print`。

### 签名失败

自动签名流程设置 `signatureStatus = failed` 后：

- 通知设计师和管理员 `signature_failed`。

### 打印归档

设计师或管理员标记打印归档后：

- 通知设计师 `approval_printed`。

## 前端设计

### 导航

所有角色新增“我的资料”：

- 设计师：提交图纸、全部图纸、我的签名、我的资料。
- 主管/工艺：待我审核、全部图纸、我的签名、我的资料。
- 管理员：系统管理、全部图纸、我的资料；不提供上传和签名入口，“全部图纸”仅用于台账维护、异常处理和删除受管文件。

### 我的资料页面

页面内容：

- 基础资料：用户名只读、角色只读、显示名可编辑、邮箱可编辑。
- 常用项目：设计师、主管、工艺显示标签式列表，可添加、删除、排序简单化为添加顺序；管理员不显示该区块。
- 通知偏好：按当前角色显示开关。
- 保存反馈：成功、失败、校验错误。

### 提交图纸页

设计师进入提交页时读取个人资料：

- 项目输入框旁显示常用项目快捷按钮或下拉列表。
- 点击常用项目直接填入项目名。
- 如果没有常用项目，不显示额外控件。

## 错误处理

- SMTP 未配置：通知函数直接返回 `sent: false`，写操作日志，不影响审批动作。
- 用户没有邮箱：跳过该用户通知。
- 偏好 JSON 损坏：后端回退默认值，并在下一次保存时修复。
- 通知失败：写 `notification.email_failed` 日志，审批接口仍返回成功。

## 验证

自动化验证：

- 用户偏好仓库测试：默认值、保存、常用项目清洗、偏好回显。
- 个人资料接口测试：读取、更新、权限、校验。
- 通知服务测试：按角色筛选、按偏好跳过、SMTP 未配置不阻断。
- 审批路由测试：创建、审核、签名失败、归档触发对应通知。
- 前端 API 测试：profile 接口。
- 前端页面/路由测试：导航包含“我的资料”，提交页支持常用项目。

回归验证：

- `npm test`
- `npm run build`

## 风险

- 通知过多可能打扰用户，所以默认值要保守：主管/工艺默认开启新任务；设计师默认开启驳回和通过；管理员默认开启签名失败。
- 邮箱依赖 SMTP，必须保持“发送失败不阻断审批”。
- 用户资料更新会改变 JWT 中旧的 `displayName` 显示，保存后前端需要刷新用户状态或提示重新登录。第一版优先在接口响应中返回最新用户并更新本地状态。
