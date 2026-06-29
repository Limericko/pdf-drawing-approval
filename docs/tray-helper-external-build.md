# V5 托盘助手外部构建说明

本说明用于在不改动当前审批服务器/开发机工具链的前提下，产出 Tauri Windows 托盘助手安装包。

当前约束：

- 当前机器不安装 Rust、Visual Studio Build Tools 或其他 Tauri 打包环境。
- 当前机器只做 Web、后端和托盘前端的可验证开发。
- Windows 安装包由外部构建机、CI、临时虚拟机或已准备好的专用打包电脑产出。

## 架构边界

托盘助手仍只通过 HTTP API 访问审批系统：

- 登录：`POST /api/auth/login`
- 托盘摘要：`GET /api/tray/summary`
- 管理动作：`POST /api/system/scan-now`、`POST /api/system/restart`

托盘助手不直接读取：

- SQLite 数据库。
- 坚果云同步目录。
- PDF 原文件。

## 当前机器验证

当前机器可以执行：

```powershell
npm test
npm run build
.\scripts\build-tray-frontend-only.ps1
.\scripts\check-tauri-prereqs.ps1
```

说明：

- `build-tray-frontend-only.ps1` 只运行托盘单元测试和 Vite 前端构建。
- `check-tauri-prereqs.ps1` 只读检查当前环境，不创建目录、不安装、不下载。
- 当前机器不运行 `npm run tray:build`，除非后续明确允许在该机器安装并使用 Tauri 打包环境。

## 外部构建机要求

构建机需要预先具备：

- Node.js / npm。
- Rust stable。
- Rust target `x86_64-pc-windows-msvc`。
- Visual Studio Build Tools，包含 C++ 桌面开发工具链。
- Microsoft Edge WebView2 Runtime。
- 可访问 npm registry 和 Rust crates 源，或已配置公司内部镜像。

这些工具链由外部构建机管理员维护，不由当前审批系统仓库脚本安装。

## 外部构建步骤

在外部构建机上进入仓库根目录，执行：

```powershell
npm install --registry=https://registry.npmmirror.com
npm --prefix apps/tray-helper install --registry=https://registry.npmmirror.com
npm test
npm run build
npm run tray:test
npm --prefix apps/tray-helper run build
npm run tray:build
```

成功后安装包位于：

```text
apps\tray-helper\src-tauri\target\release\bundle
```

当前 Tauri 配置目标包含：

- `nsis`
- `msi`

## 交付回传

构建完成后，将以下内容回传到审批服务器或共享发布目录：

- `apps\tray-helper\src-tauri\target\release\bundle\msi\*.msi`
- `apps\tray-helper\src-tauri\target\release\bundle\nsis\*.exe`
- 本次构建对应的提交包、压缩包或版本说明。
- 构建命令输出摘要。

推荐发布目录：

```text
审批根目录\_release\tray-helper\v5\
```

## 发布前验收

安装包回传后，至少完成：

1. 主管账号登录托盘助手，确认待审核图纸只提醒一次。
2. 工艺账号登录托盘助手，确认待审核图纸只提醒一次。
3. 设计师账号登录托盘助手，确认不会收到审核提醒。
4. 管理员账号登录托盘助手，确认系统管理、服务日志、立即扫描、重启服务入口可用。
5. 断开审批服务后确认托盘显示离线，恢复后能自动回到在线。
6. 点击通知可打开 Web 审批详情或待办列表。

详细清单见 `docs/tray-helper-verification.md`。

## 回滚

托盘助手回滚不影响审批数据。

回滚方式：

1. 卸载当前托盘助手。
2. 安装上一版托盘助手安装包。
3. 重新登录。

如果同时更新了后端，需确认旧托盘助手仍兼容 `/api/tray/summary`。
