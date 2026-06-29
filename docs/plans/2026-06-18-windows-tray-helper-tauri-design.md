# Windows 托盘助手 Tauri 方案设计

## 目标

使用 Tauri v2 做一个轻量 Windows 托盘助手，为局域网 PDF 图纸审批系统补齐本机提醒和快捷入口。

托盘助手只做三件事：

- 监控审批系统在线状态和当前账号待办。
- 新待办出现时弹出 Windows 通知。
- 从托盘菜单或通知点击打开浏览器中的 Web 审批页面。

它不替代现有 Web 工作台，不内嵌完整审批系统，不直接读 SQLite、不监听坚果云目录、不处理 PDF。

## 角色范围

### 主管和工艺

核心使用者。登录后轮询自己的待审核图纸。

能力：

- 新待审核图纸提醒。
- 点击通知进入图纸详情。
- 托盘菜单打开待我审核、全部图纸。
- token 过期后提示重新登录。

### 设计师

设计师不需要审核提醒，只需要便捷入口。

能力：

- 打开提交图纸。
- 打开全部图纸。
- 打开我的签名。
- 查看系统在线状态。

### 管理员

管理员重点是服务器运维入口。

能力：

- 打开系统管理。
- 打开服务日志。
- 查看风险数量和在线状态。
- 触发立即扫描。
- 请求重启服务。

## 技术选型

采用 Tauri v2。

建议插件：

- `@tauri-apps/plugin-notification`：系统通知。
- `@tauri-apps/plugin-autostart`：开机启动。
- `@tauri-apps/plugin-store`：保存服务器地址、用户名、通知去重记录和加密后的 token。
- `@tauri-apps/plugin-opener`：用默认浏览器打开 Web 审批链接。

开发前置条件：

- Rust 稳定版。
- Microsoft C++ Build Tools。
- WebView2 Runtime。
- Node.js 和 npm。

项目此前因为 Windows 原生依赖构建成本避开了 `better-sqlite3`，这次选择 Tauri 意味着要接受 Rust/MSVC 工具链。实施前应先在当前 Windows 电脑完成 Tauri 空壳构建验证。

## 架构

建议新增独立目录：

```text
apps/tray-helper/
  package.json
  src/
    main.ts
    apiClient.ts
    authStore.ts
    linkBuilder.ts
    notificationState.ts
    poller.ts
    trayMenu.ts
    roles.ts
    types.ts
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/
      main.rs
  tests/
```

采用独立 `apps/tray-helper` 而不是塞进 `src/client`，原因：

- Tauri 有自己的 Rust 工程和配置目录。
- 托盘助手和 Web 前端生命周期不同。
- 后续可以单独打包和发布。

Web 审批系统继续保持当前结构，不因 Tauri 改造主应用。

## 数据流

启动流程：

1. 读取本机配置。
2. 如果没有服务器地址，打开设置窗口。
3. 调用 `GET /health` 检查服务。
4. 如果有 token，调用托盘摘要接口。
5. 如果 token 失效，托盘显示需要登录。
6. 创建托盘菜单并启动轮询。

轮询流程：

1. 每 30 秒调用 `GET /api/tray/summary`。
2. 如果接口不存在，第一阶段可降级调用现有 `GET /api/approvals?mine=1`。
3. 比较返回的待办 ID 和本机已通知 ID。
4. 对新 ID 弹通知。
5. 写入已通知 ID。
6. 更新托盘菜单状态。

离线流程：

1. `GET /health` 或摘要接口失败。
2. 状态改为离线。
3. 轮询间隔改为 60 秒。
4. 连续失败不重复弹通知。

## 后端接口

第一阶段建议新增：

### `GET /api/tray/summary`

权限：登录用户。

返回：

```json
{
  "serverTime": "2026-06-18T12:00:00.000Z",
  "user": {
    "id": 2,
    "username": "supervisor",
    "role": "supervisor",
    "displayName": "主管"
  },
  "tasks": {
    "pendingCount": 2,
    "latestIds": [18, 19],
    "latest": [
      {
        "id": 19,
        "projectName": "300A",
        "partName": "固定支持支架",
        "version": "a0A0",
        "submittedAt": "2026-06-18T09:20:00.000Z",
        "href": "#/approvals/19"
      }
    ]
  },
  "admin": {
    "overallStatus": "ok",
    "riskCount": 0
  }
}
```

规则：

- 主管只返回主管待办。
- 工艺只返回工艺待办。
- 设计师返回空待办。
- 管理员返回运维摘要。
- 不返回 PDF 文件、签名图片、SMTP 密码等敏感数据。

### 复用现有接口

- `GET /health`
- `POST /api/auth/login`
- `GET /api/approvals?mine=1`
- `GET /api/system/diagnostics`
- `GET /api/system/risks`
- `POST /api/system/scan-now`
- `POST /api/system/restart`

## 本机配置

保存字段：

```json
{
  "serverUrl": "http://192.168.1.20:8080",
  "username": "supervisor",
  "role": "supervisor",
  "token": "encrypted-token",
  "notifiedApprovalIds": [18, 19],
  "openAtLogin": true,
  "pollIntervalSeconds": 30
}
```

原则：

- 不保存明文密码。
- token 过期后要求重新登录。
- 如果 token 加密能力不稳定，第一版可只保存服务器地址和用户名。
- 清除通知记录只清空 `notifiedApprovalIds`，不清空登录信息。

## 托盘菜单

### 主管 / 工艺

```text
PDF 图纸审批
状态：在线
待我审核：2 张

打开待我审核
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
系统风险：0 项

打开系统管理
打开服务日志
立即扫描
重启服务

账号：管理员
重新登录
开机启动：已开启
退出
```

## 通知规则

- 只对新出现的待办 ID 弹通知。
- 同一待办不重复弹。
- 点击通知打开默认浏览器中的图纸详情。
- 服务离线、登录过期、接口异常不弹重复错误通知，只更新托盘状态。
- 可在菜单中提供“清除通知记录”，便于测试。

通知文案：

```text
有新的待审核图纸
300A / 固定支持支架 / a0A0
```

多张图纸同时出现：

```text
有 3 张新图纸待审核
点击打开待我审核
```

## 设置窗口

第一阶段保留一个很小的设置窗口即可。

字段：

- 审批系统地址。
- 用户名。
- 密码。
- 登录按钮。
- 开机启动开关。
- 清除通知记录。

成功后关闭窗口，回到托盘常驻。

不在设置窗口中做审批、上传或 PDF 预览。

## 错误处理

- `ECONNREFUSED` 或超时：显示离线。
- `401`：显示需要重新登录。
- `403`：显示当前账号无权限。
- 返回非 JSON：显示服务异常。
- 服务器地址格式错误：设置窗口内提示，不进入轮询。
- 通知权限失败：菜单显示通知不可用，仍保留打开网页入口。

## 打包和部署

第一阶段目标：

- 生成 Windows 安装包或便携 exe。
- 支持开机自启。
- 支持卸载。
- 支持配置服务器地址。

部署方式：

1. 管理员确认审批服务器地址，例如 `http://192.168.1.20:8080`。
2. 在主管、工艺、需要的设计师电脑上安装托盘助手。
3. 首次运行填写服务器地址并登录。
4. 打开开机启动。
5. 放入测试 PDF，确认主管和工艺能收到通知。

## 验收标准

- Tauri 空壳能在当前 Windows 电脑完成构建。
- 托盘图标能常驻。
- 设置窗口能保存服务器地址。
- 登录成功后能保存用户名和 token。
- 服务在线时显示在线。
- 服务关闭后 60 秒内显示离线。
- 主管和工艺新待办能弹通知。
- 同一个待办不会重复通知。
- 点击通知能打开正确图纸详情。
- 设计师不收到审核提醒。
- 管理员能从托盘打开系统管理。
- token 过期后提示重新登录，不反复弹错误。
- 开机启动开关生效。

## 关键风险

- Tauri Windows 构建依赖 Rust 和 Microsoft C++ Build Tools，首次配置可能比 Electron 更慢。
- 部分公司电脑可能没有 WebView2 Runtime，需要安装。
- Windows 通知点击回调需要在真实系统环境验证，不能只依赖单元测试。
- 如果公司策略限制托盘程序或开机启动，需要改为浏览器通知加邮件。

## 下一步

1. 先做 Tauri 环境验证：空壳项目能否构建和启动托盘。
2. 后端补 `/api/tray/summary`。
3. 实现 Tauri 托盘菜单和设置窗口。
4. 实现轮询和通知去重。
5. 打包 Windows 安装包。
6. 编写用户和管理员说明。
