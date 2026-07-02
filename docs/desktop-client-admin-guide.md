# Electron 客户端管理员说明

## 部署结构

一台 Windows 电脑作为审批服务器，团队电脑安装 Electron 客户端。

服务器负责 Express API、SQLite、坚果云目录监听和 PDF 签名。客户端只负责加载本地前端并通过 HTTP 调用服务器。

## 开发运行

```powershell
npm install --registry=https://registry.npmmirror.com
npm run build
npm run desktop:test
npm run desktop:dev
```

`npm run desktop:dev` 需要先执行 `npm run build`，因为 Electron 会加载 `dist/client`。

## Windows 安装包

推荐给普通用户分发安装包：

```powershell
npm run installer:package
```

输出：

```text
dist\installers\client\PDF图纸审批客户端-安装包-0.9.2.exe
dist\installers\server\PDF图纸审批服务端-安装包-0.9.2.exe
```

分发规则：

- 服务器电脑安装服务端安装包。
- 设计师、主管、工艺和管理员电脑安装客户端安装包。
- 安装包会创建桌面快捷方式和开始菜单快捷方式。
- 当前安装包是 NSIS 安装包，不是 MSI。
- 当前服务端安装包不是 Windows Service；服务端窗口关闭时会隐藏到系统托盘，服务继续运行。
- 当前安装包未配置企业代码签名，Windows 可能显示安全提醒。

## 版本更新

`npm run installer:package` 会同时输出 `dist\updates\latest.json`、`dist\updates\latest.yml`、`dist\updates\CHANGELOG.md`、客户端安装包和 `.blockmap`，并在真实运行目录存在时自动同步到 `E:\PDF服务端\pdf-approval\releases`。

推荐做法：

1. 打开服务端窗口里的“更新”目录。
2. 把 `dist\updates` 内文件放到 `releases\updates`。
3. 把客户端安装包放到 `releases\installers\client`，把服务端安装包放到 `releases\installers\server`。
4. 服务端会自动通过当前访问地址提供 `http://服务器IP:端口/updates/latest.json` 和 `http://服务器IP:端口/updates/latest.yml`，无需在管理端填写更新清单地址。
5. 管理员在“运维追溯 → 版本更新”点击“检查更新”，查看新版本、更新日志和安装包下载地址。
6. Electron 客户端保存审批服务器地址后会通过 `/updates/latest.yml` 自动检查客户端新版；首次未配置服务器地址时不会检查更新。发现新版后自动下载并显示进度，下载完成后提示用户打开安装包并按 Windows 安装向导升级。

特殊部署如果要使用独立更新服务器，可在服务端启动环境中设置 `PDF_APPROVAL_UPDATE_MANIFEST_URL` 覆盖默认清单地址；常规局域网部署不要设置。

当前更新能力是“自动检查、自动下载客户端安装包、手动执行安装向导”，不会静默覆盖安装，也不会自动更新服务端。服务端升级前仍建议先做一次数据库备份。

注意：`0.9.0` 及更早客户端没有内置 `electron-updater`，不能自动升级到新版。需要给这些电脑手动安装一次 `PDF图纸审批客户端-安装包-0.9.2.exe`；从 `0.9.1` 及以后客户端开始，启动时才会自动检查、下载后续新版。

从 `0.8.7` 开始，服务端安装器升级时会保留安装目录下的 `data`、`backups`、`logs`、`releases` 和 `server-config.json`。如果旧版本安装后发现更新清单 404，先重新发布一次安装包或执行 `npm run release:sync-runtime` 恢复 `releases` 目录。

## 便携版打包

便携版仍作为备用输出，适合不想安装、只想复制文件夹试用的场景：

```powershell
npm run desktop:package
```

输出目录：

```text
dist\desktop-client\PDF图纸审批客户端
```

把整个 `PDF图纸审批客户端` 文件夹复制到团队电脑，双击：

```text
PDF图纸审批客户端.exe
```

注意：不要只复制 exe，必须复制整个文件夹，因为 Electron 运行时、前端资源和 app 文件都在同级目录中。

## 服务端发布包

推荐给新手部署的方式是生成免 Node 服务端 exe：

```powershell
npm run server:exe
```

输出目录：

```text
dist\server-exe\PDF图纸审批服务端
```

把整个 `PDF图纸审批服务端` 文件夹复制到审批服务器电脑，双击：

```text
PDF图纸审批服务端.exe
```

服务端窗口会显示运行状态、本机地址、局域网地址、启动设置、数据目录、备份目录和日志目录。保持窗口打开，其他电脑访问窗口中的局域网地址。该方式不要求目标电脑安装 Node.js，也不需要执行 `npm install`。

端口设置：

- 默认端口是 `8080`。
- 在服务端窗口“启动设置”里修改 HTTP 端口。
- 点击“保存并重启”后生效。
- 配置保存到服务端目录下的 `server-config.json`。
- 如果启动前设置了环境变量 `PORT`，会优先使用环境变量。

仍可生成源码服务端发布包：

```powershell
npm run server:package
```

输出目录：

```text
dist\server-package\PDF图纸审批服务端
```

把整个 `PDF图纸审批服务端` 文件夹复制到审批服务器电脑。首次部署在该目录执行：

```powershell
npm install --omit=dev --registry=https://registry.npmmirror.com
powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1
```

开机启动：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1
```

服务端包不包含 `node_modules`，目标电脑需要安装 Node.js 并执行一次 `npm install`。

两种服务端包都必须复制整个文件夹，不能只复制 exe 或脚本文件。

## 服务端检查

在客户端电脑上执行：

```powershell
Invoke-WebRequest -UseBasicParsing http://服务器IP:8080/health
```

返回 `{"ok":true}` 表示服务可达。

## V6.1 批注功能检查

V6.1 的图纸批注数据保存在审批服务器数据库，客户端只负责展示和编辑。上线前建议用一张测试 PDF 检查：

1. 主管或工艺账号能新增定位、箭头、矩形、圆形、文字、画笔和云线批注。
2. 选中批注后能移动、缩放、改颜色和删除。
3. 右侧批注列表点击后，PDF 预览能自动定位到对应标记。
4. 设计师账号只能查看批注并标记处理完成，不能新增审核批注。
5. 审查版 PDF 能显示批注。
6. 签后 PDF 不包含审核批注，只保留正式签名。

## 上线检查

1. 服务端固定局域网 IP 或电脑名。
2. 服务端防火墙放行 8080。
3. 服务端已配置坚果云审批根目录。
4. 管理员修改默认账号密码。
5. 每台客户端首次启动填写同一个服务器地址。
6. 用设计师、主管、工艺、管理员账号各完成一次登录验证。
7. 验证 PDF 预览、签后 PDF 打开、上传图纸和系统管理页都能访问。

## 回滚

Electron 客户端异常时，团队可以临时改用浏览器访问：

```text
http://服务器IP:8080
```

服务端数据和审批流程不依赖 Electron 客户端，因此回滚不需要迁移数据库。

## V7 连接诊断与运维增强

服务端窗口会显示真实局域网地址，并提供“复制客户端地址”。给团队电脑配置客户端时，复制服务端窗口里的局域网地址，不要分发 `127.0.0.1`。

客户端提供连接自检，管理员排障时先确认：

1. 自检能访问 `/health`。
2. 服务端版本与客户端 API 兼容版本一致。
3. 地址不是 `localhost` 或 `127.0.0.1`。
4. Windows 防火墙已放行服务端端口。

“系统管理 -> 运维追溯”新增自动维护和备份目录校验：

- 自动备份用于每天固定时间生成 SQLite 备份。
- 自动清理用于清理临时上传、旧失败批量提交记录和未引用旧签后 PDF。
- 备份目录校验用于恢复前快速确认备份是否可读。

Tauri 托盘助手仅保留为历史实验说明；当前正式部署路径是 Electron 客户端加 Electron 服务端安装包。

