# PDF 图纸审批托盘助手管理员指南

适用对象：系统管理员、负责上线维护的设计团队成员。

托盘助手是 V5 的 Windows 本机配套程序。它只通过 HTTP API 访问审批服务，不直接读取 SQLite、坚果云目录或 PDF 文件。

## 架构边界

服务端仍是唯一数据源：

- 审批数据：Express + SQLite。
- 图纸文件：坚果云同步目录下的标准审批目录。
- 审批操作：浏览器 Web 系统。
- 本机提醒：Tauri 托盘助手。

托盘助手本地只保存：

- 服务器地址。
- 当前账号名、角色和 token。
- 已提醒过的审批 ID。

## 构建前置条件

当前审批服务器/开发机不安装 Tauri 打包环境。V5 托盘助手安装包由外部构建机、CI、临时虚拟机或已准备好的专用打包电脑产出。

本机只保留只读检查命令：

```powershell
.\scripts\check-tauri-prereqs.ps1
```

该脚本不会创建目录、下载依赖或安装工具链。

外部构建机需要：

- Node.js / npm。
- Rust stable。
- Rust target `x86_64-pc-windows-msvc`。
- Visual Studio Build Tools，包含 C++ 桌面开发工具链。
- Microsoft Edge WebView2 Runtime。
- 可访问 npm registry 和 Rust crates 源，或配置可用的公司内部镜像。

完整外部构建流程见 `docs/tray-helper-external-build.md`。

## 构建命令

当前机器验证 Web 和托盘前端：

```powershell
npm test
npm run build
npm run tray:test
npm --prefix apps/tray-helper run build
```

也可以使用封装脚本：

```powershell
.\scripts\build-tray-frontend-only.ps1
```

安装包构建只在外部构建机执行：

```powershell
npm install --registry=https://registry.npmmirror.com
npm --prefix apps/tray-helper install --registry=https://registry.npmmirror.com
npm test
npm run build
npm run tray:test
npm --prefix apps/tray-helper run build
npm run tray:build
```

构建成功后，Windows 安装包应位于：

```text
apps\tray-helper\src-tauri\target\release\bundle
```

当前配置会优先生成 Windows `nsis` 和 `msi` 目标。

## 服务端地址规范

推荐使用固定局域网 IP：

```text
http://192.168.1.20:8080
```

不建议在普通用户电脑上填写：

```text
http://127.0.0.1:8080
```

除非审批服务就运行在这台电脑上。

## 服务端网络要求

审批服务器需要允许团队电脑访问端口 `8080`。

验证方式：

```powershell
Invoke-WebRequest http://服务器IP:8080/health
```

返回应包含：

```json
{"ok":true}
```

如果失败，检查：

- 服务是否启动。
- Windows 防火墙是否允许入站。
- 服务器 IP 是否变化。
- 用户电脑是否在同一局域网。

## 安装到用户电脑

推荐顺序：

1. 先在管理员电脑完成构建和冒烟。
2. 在一台主管电脑安装测试。
3. 在一台工艺电脑安装测试。
4. 确认通知和跳转无误后，再分发给其他成员。

首次登录建议使用个人账号，不要多人共用管理员账号。

## 管理员托盘菜单

管理员登录托盘助手后可使用：

- `打开系统管理`：打开 Web 系统管理页面。
- `打开服务日志`：打开 Web 系统服务日志页。
- `立即扫描`：调用 `POST /api/system/scan-now`。
- `重启服务`：调用 `POST /api/system/restart`。

这些动作都通过后端权限校验。非管理员不会显示扫描和重启动作。

## 更新流程

建议更新步骤：

1. 备份服务端数据库。
2. 构建新版本托盘安装包。
3. 在测试电脑安装覆盖。
4. 完成 `docs/tray-helper-verification.md` 中的检查。
5. 分发给正式用户。

如果只更新托盘助手，通常不需要停止审批服务。

如果同时更新后端和 Web，按 `docs/deploy-windows-lan.md` 的服务更新流程执行。

## 日志与排障

服务端日志入口：

- Web 系统：`系统管理` -> `服务日志`。
- 托盘管理员菜单：`打开服务日志`。

运维追溯入口：

- Web 系统：`系统管理` -> `运维追溯`。

托盘助手本身当前未单独落盘日志。排查托盘问题时，先记录：

- 用户账号角色。
- 服务器地址。
- 托盘菜单显示的状态。
- 操作时间。
- Web 系统中对应审批单状态。

## 回滚

托盘助手回滚不影响服务端数据。

回滚方式：

1. 卸载当前托盘助手。
2. 安装上一版托盘助手。
3. 重新登录。

如果新版本后端也已上线，应确认旧托盘仍兼容 `/api/tray/summary`、`/api/auth/login`、`/api/system/scan-now` 和 `/api/system/restart`。
