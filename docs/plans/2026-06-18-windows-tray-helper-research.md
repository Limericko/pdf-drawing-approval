# Windows 托盘助手调研与文档清单

## 背景

当前审批系统已经形成 V4 版 Web 工作台，部署目标仍是一台办公室 Windows 电脑作为审批服务器，团队成员在局域网内通过浏览器访问。早期方案中明确把真正的 Windows 系统桌面弹窗放在第二阶段，通过托盘小助手实现。

托盘助手不应替代 Web 审批系统。它的价值是补齐 Windows 使用便捷性：

- 常驻托盘，显示审批系统是否可用。
- 有新待办时弹出 Windows 桌面通知。
- 点击通知或菜单直接打开对应网页。
- 管理员在审批服务器上可快速打开系统、重启服务、查看日志入口。
- 对主管和工艺减少“必须一直打开网页才有提醒”的依赖。

## 结论

用户已确认 V5 第一阶段使用 Tauri 做轻量 Windows 托盘助手，不做完整桌面审批端。

Tauri 路线的产品理由：

- 托盘助手需要长期常驻，Tauri 相比 Electron 更轻，适合只做提醒、菜单和快捷入口。
- Tauri v2 支持系统托盘、通知、开机启动和本地存储插件，能覆盖第一阶段需求。
- 审批主界面仍在浏览器中打开，托盘助手不需要内嵌完整 Web 审批系统。
- 后续如果要做一个小型设置窗口，Tauri 也可以复用现有前端能力。

实施前必须接受的工程约束：

- Windows 开发机需要准备 Rust、Microsoft C++ Build Tools 和 WebView2 运行环境。
- 打包链路会引入 Rust 工具链，和当前纯 Node/TypeScript 服务端不同。
- 不能把 Tauri 托盘助手做成第二套审批系统，只能作为本机提醒和入口。

推荐定位：

- 第一阶段：Tauri 托盘提醒助手。
- 第二阶段：根据现场反馈再决定是否加入设置小窗口、自动更新和更完善的安装包。

## 技术路线比较

| 方案 | 能力 | 优点 | 风险 | 建议 |
| --- | --- | --- | --- | --- |
| Tauri 托盘助手 | 托盘、通知、自动启动、本地存储、WebView 小窗口 | 体积小，运行轻，适合长期常驻 | Windows 开发依赖 C++ Build Tools、WebView2、Rust，打包链路更复杂 | 已选第一阶段 |
| Electron 托盘助手 | 托盘菜单、通知、登录态存储、打开浏览器、开机启动、安装包 | 与现有 Node/TypeScript 技术栈一致，开发最快，官方 API 覆盖完整 | 安装包和内存占用较大 | 备用方案 |
| .NET WinForms/WPF 小助手 | NotifyIcon、Windows 原生菜单、单文件发布 | Windows 原生体验好，体积可控 | 第二套技术栈，通知点击、安装、自启和凭据管理要单独设计 | 可作为后续稳定版候选 |
| 继续仅用浏览器通知 | 浏览器授权后通知 | 无安装成本 | 浏览器关闭或未授权时不可用，提醒不稳定 | 不满足桌面助手目标 |

## 第一阶段功能边界

### 主管和工艺模式

安装在主管和工艺自己的 Windows 电脑上。

- 首次运行填写审批系统地址，例如 `http://192.168.1.20:8080`。
- 用户输入账号和密码登录。
- 后台定时轮询 `/api/approvals?mine=1`。
- 发现新的待审核图纸时弹通知。
- 点击通知打开 `#/approvals/:id`。
- 托盘菜单显示：
  - 审批系统：在线 / 离线。
  - 待我审核：N 张。
  - 打开待审核。
  - 重新登录。
  - 开机启动开关。
  - 退出。

### 设计师模式

设计师不需要审核提醒，第一阶段只提供便捷入口。

- 托盘菜单显示：
  - 打开提交图纸。
  - 打开全部图纸。
  - 打开我的签名。
  - 审批系统：在线 / 离线。
  - 开机启动开关。
  - 退出。

### 管理员/服务器模式

安装在审批服务器电脑上，重点是运维入口。

- 显示服务健康状态。
- 显示监听目录、最近扫描、最近备份、系统风险数量。
- 打开系统管理页面。
- 打开服务日志页面。
- 触发服务重启。
- 可选执行立即扫描。

第一阶段不建议托盘助手直接操作 Windows 进程或文件系统。重启、扫描、日志读取都优先通过现有 HTTP API 完成，避免托盘助手和服务端产生双重控制源。

## 不做范围

第一阶段不做：

- 内嵌完整审批页面。
- PDF 预览和签名框编辑。
- 图纸上传。
- 自动打印。
- 本地文件监听。
- 离线审批。
- 替代邮件通知。
- 替代 Windows 计划任务启动审批服务。
- 企业微信、飞书或外网推送。

这些能力仍由 Web 工作台或后续版本处理。

## 现有接口复用

当前后端已有可复用接口：

- `GET /health`：无需登录，检查服务是否在线。
- `POST /api/auth/login`：账号密码登录，返回 JWT 和用户信息。
- `GET /api/approvals?mine=1`：主管和工艺获取待我审核。
- `GET /api/approvals`：管理员和设计师查看全部图纸。
- `GET /api/system/diagnostics`：管理员查看系统诊断。
- `GET /api/system/risks`：管理员查看风险。
- `GET /api/system/logs?lines=120`：管理员读取服务日志。
- `POST /api/system/restart`：管理员请求重启。
- `POST /api/system/scan-now`：管理员手动扫描。

注意：当前 JWT 有效期是 12 小时。托盘助手必须处理 401：

- 不在后台反复弹错误。
- 托盘菜单显示“需要重新登录”。
- 用户点击后打开登录设置窗口或打开浏览器登录页。

## 建议新增接口

为了降低轮询成本和前端耦合，建议新增托盘专用接口：

### `GET /api/tray/summary`

权限：登录用户。

返回建议：

```json
{
  "serverTime": "2026-06-18T11:30:00.000Z",
  "user": {
    "id": 2,
    "username": "supervisor",
    "role": "supervisor",
    "displayName": "主管"
  },
  "health": {
    "ok": true
  },
  "tasks": {
    "pendingCount": 3,
    "latestIds": [12, 15, 18],
    "latest": [
      {
        "id": 18,
        "projectName": "300A",
        "partName": "固定支持支架",
        "version": "a0A0",
        "submittedAt": "2026-06-18T09:20:00.000Z",
        "href": "#/approvals/18"
      }
    ]
  },
  "admin": {
    "riskCount": 1,
    "overallStatus": "warn"
  }
}
```

设计原则：

- 主管和工艺只返回自己的待办。
- 设计师不返回审核任务。
- 管理员可返回风险和诊断摘要。
- 不返回 PDF 文件内容、签名图片或敏感 SMTP 配置。

### `POST /api/tray/client-events`

权限：登录用户。

用途：可选，记录托盘助手行为，便于后续排障。

事件建议：

- `tray.started`
- `tray.login_success`
- `tray.login_failed`
- `tray.notification_shown`
- `tray.notification_clicked`
- `tray.open_web`
- `tray.health_failed`

第一阶段如果要控制范围，可以先不做这个接口，只写本地日志。

## 通知策略

轮询频率建议：

- 服务在线且登录有效：每 30 秒。
- 服务离线：每 60 秒。
- 用户刚点击“刷新”：立即轮询一次。
- 连续失败 3 次后托盘图标改为警告态，但不连续弹通知。

去重策略：

- 本地保存已通知审批 ID，和 Web 端 `localStorage` 的思路一致。
- 只对新出现的 ID 弹通知。
- 待办消失后不删除已通知记录，避免同一审批反复提醒。
- 可在托盘菜单提供“清除通知记录”，用于测试或重新提醒。

通知点击：

- 默认打开系统浏览器，而不是内嵌 Electron 窗口。
- 主管/工艺打开 `http://server:8080/#/approvals/:id`。
- 如果没有详情 ID，则打开 `http://server:8080/#/`。

## 登录和本机数据

托盘助手本机配置建议保存：

```json
{
  "serverUrl": "http://192.168.1.20:8080",
  "username": "supervisor",
  "role": "supervisor",
  "token": "encrypted-token",
  "notifiedApprovalIds": [12, 15, 18],
  "pollIntervalSeconds": 30,
  "openAtLogin": true
}
```

凭据原则：

- 不保存明文密码。
- 可保存 JWT，但必须用 Electron `safeStorage` 加密后落盘。
- JWT 过期后要求重新输入密码。
- 如果 `safeStorage` 不可用，降级为不保存 token，只保存服务器地址和用户名。

## 托盘菜单草案

### 主管 / 工艺

```text
PDF 图纸审批
状态：在线
待我审核：3 张

打开待审核
打开全部图纸
立即刷新

账号：主管
重新登录
开机启动：已开启
退出
```

### 设计师

```text
PDF 图纸审批
状态：在线

提交图纸
全部图纸
我的签名
立即刷新

账号：设计师
重新登录
开机启动：已开启
退出
```

### 管理员

```text
PDF 图纸审批
状态：在线
系统风险：1 项

打开系统管理
打开服务日志
立即扫描
重启服务

账号：管理员
重新登录
开机启动：已开启
退出
```

## 文件结构建议

第一阶段在同一仓库中新增独立 Tauri 子应用：

```text
apps/tray-helper/
  package.json
  src/
    main.ts
    config.ts
    apiClient.ts
    notifications.ts
    trayMenu.ts
    polling.ts
    links.ts
    types.ts
    __tests__/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/
      main.rs
assets/tray/
  tray-ok.ico
  tray-warn.ico
  tray-offline.ico
docs/
  tray-helper-user-guide.md
  tray-helper-admin-guide.md
```

采用 `apps/tray-helper` 的原因是 Tauri 有独立 Rust 工程、插件配置和打包流程，和现有 Web 前端生命周期不同。

## 需要整理的文档

### 1. 设计文档

路径建议：

```text
docs/plans/2026-06-18-windows-tray-helper-design.md
```

内容：

- 目标和非目标。
- 角色差异。
- 技术选型。
- 托盘菜单。
- 通知去重。
- 登录和 token 存储。
- 错误处理。

### 2. 实施计划

路径建议：

```text
docs/plans/2026-06-18-windows-tray-helper-implementation-plan.md
```

内容：

- 后端托盘摘要接口。
- Electron 主进程。
- 本机配置和安全存储。
- 轮询和通知。
- 托盘菜单。
- 打包脚本。
- 测试和冒烟。

### 3. 用户使用说明

路径建议：

```text
docs/tray-helper-user-guide.md
```

内容：

- 安装。
- 首次配置服务器地址。
- 登录。
- 开机启动。
- 收到通知后打开审批。
- 重新登录。
- 常见问题。

### 4. 管理员部署说明

路径建议：

```text
docs/tray-helper-admin-guide.md
```

内容：

- 在主管、工艺、设计师电脑安装。
- 在审批服务器安装管理员模式。
- 局域网地址配置。
- 防火墙注意事项。
- 升级和卸载。
- 日志位置。

### 5. 验证清单

路径建议：

```text
docs/tray-helper-verification.md
```

内容：

- 服务在线和离线。
- 登录成功和失败。
- token 过期。
- 新待办提醒。
- 通知点击打开正确图纸。
- 同一待办不重复通知。
- 开机自启。
- 管理员重启服务。
- 卸载后不残留开机启动项。

## 验收标准

第一阶段验收建议：

- 托盘助手能在 Windows 登录后自动启动。
- 服务在线时托盘显示在线，离线时 60 秒内变为离线。
- 主管和工艺有新待办时能收到 Windows 通知。
- 同一个待办不重复弹通知。
- 点击通知能打开默认浏览器并进入对应图纸详情。
- 设计师不会收到审核提醒。
- 管理员可从托盘打开系统管理和服务日志。
- JWT 过期后不刷屏报错，提示重新登录。
- 打包后的安装和卸载路径明确。

## 风险和决策点

- Electron 包体积较大，但对当前小团队局域网工具影响可接受。
- 如果公司电脑禁止安装 Electron 应用，需要退回 .NET 单文件小助手。
- 如果公司安全策略禁止本地加密存储 token，则第一阶段不保存 token，要求每日登录。
- 如果后续需要真正后台推送，可新增 Server-Sent Events 或 WebSocket，但第一阶段轮询更稳。
- 托盘助手不应直接读 SQLite 或坚果云目录，所有业务状态通过 HTTP API 获取。

## 官方资料索引

- Tauri System Tray：https://v2.tauri.app/learn/system-tray/
- Tauri Notifications：https://v2.tauri.app/plugin/notification/
- Tauri Autostart：https://v2.tauri.app/plugin/autostart/
- Tauri Store：https://v2.tauri.app/plugin/store/
- Tauri Windows prerequisites：https://v2.tauri.app/start/prerequisites/
- Electron `Tray`：https://www.electronjs.org/docs/latest/api/tray
- Electron `Notification`：https://www.electronjs.org/docs/latest/api/notification
- Electron `app.setLoginItemSettings`：https://www.electronjs.org/docs/latest/api/app
- Electron `shell.openExternal`：https://www.electronjs.org/docs/latest/api/shell
- Electron `safeStorage`：https://www.electronjs.org/docs/latest/api/safe-storage
- Electron Forge Squirrel.Windows：https://www.electronforge.io/config/makers/squirrel.windows
- Microsoft WinForms `NotifyIcon`：https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon
- Microsoft .NET single-file deployment：https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview
- Microsoft Windows App SDK notifications：https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-quickstart
