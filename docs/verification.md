# 验证记录

## 当前状态

已完成第一版代码搭建，并在本机完成依赖安装、自动化测试、构建和服务启动验证。

## 已尝试命令

```powershell
npm install
```

结果：命令超时。

随后按权限规则请求联网安装依赖，被当时的沙箱策略拒绝。

用户在本机执行安装时，`better-sqlite3` 因 Windows 缺少 Visual Studio C++ 构建工具失败。已将数据库层改为 Node 24 内置 `node:sqlite`，移除 `better-sqlite3` 原生依赖。

```powershell
npm install --registry=https://registry.npmmirror.com
```

结果：安装成功。

```powershell
npm test
```

结果：

```text
> pdf-approval@0.1.0 test
> vitest run

Test Files  8 passed (8)
Tests       24 passed (24)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8080/health'
```

结果：

```json
{"ok":true}
```

```powershell
POST http://127.0.0.1:8080/api/auth/login
```

使用 `admin / admin123` 登录，结果：HTTP 200，返回管理员用户。

服务监听：

```text
0.0.0.0:8080
```

## 待执行人工验收

手工验证：

1. 使用 `admin / admin123` 登录。
2. 配置坚果云本地根目录。
3. 放入 `图纸审批\01-待提交\测试项目\测试零件-a0A0.pdf`。
4. 确认系统生成审批单，并移动到 `02-审批中`。
5. 主管和工艺分别登录审批。
6. 两人通过后确认移动到 `04-已通过待打印`。
7. 提交 `测试零件-a1A0.pdf` 并驳回，确认移动到 `03-已驳回` 且保留意见。

## 风险

- 邮件通知需要有效 SMTP 和审核人邮箱数据。

## 2026-06-16 可用性增强验证

改动：

- 配置页新增“选择文件夹”按钮。
- 后端新增 `POST /api/settings/select-folder`，在运行审批服务的 Windows 电脑上弹出本地文件夹选择窗口。
- 页面布局优化为左侧导航 + 工作台内容区。
- 待办页增加待处理数量。
- 详情页增加主管/工艺状态摘要。
- 配置页增加服务器本地选择说明。

验证：

```powershell
npm test
```

结果：

```text
Test Files  9 passed (9)
Tests       25 passed (25)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8080/health'
```

结果：

```json
{"ok":true}
```

当前服务监听：

```text
0.0.0.0:8080
```

当前监听进程：

```text
2060
```

## 2026-06-16 前端设计方向重构验证

背景：

- 用户要求阅读 LobeHub 技能 `affaan-m-everything-claude-code-frontend-design` 并安装后遵循。
- `https://lobehub.com/skills/affaan-m-everything-claude-code-frontend-design/skill.md` 被 Vercel 安全检查拦截。
- `@lobehub/market-cli` 安装路径要求凭据，未继续注册或使用凭据。
- 使用公开仓库安装器安装同源技能集合中的 `frontend-design-direction`：

```powershell
npx -y skills add affaan-m/everything-claude-code --skill frontend-design-direction --agent codex
```

安装位置：

```text
.agents\skills\frontend-design-direction\SKILL.md
```

设计方向：

- 目的：机械图纸 PDF 审批工作台。
- 受众：设计师、主管、工艺、打印人员，重复高频使用。
- 语气：工业化、安静、密集、可扫描。
- 记忆点：工程蓝图感的左侧导航、状态芯片、版本徽标、图纸元信息条。
- 约束：不引入新 UI 依赖；沿用 React + CSS；保持局域网工具的低维护成本。

改动：

- 新增 `StatusChip` 状态芯片组件。
- 表格增加状态芯片、版本徽标、空态说明和外层表格容器。
- 登录页从单表单改成产品化登录面板。
- 工作台导航增加当前页面高亮。
- 待审页增加双指标摘要。
- 图纸详情页增加图纸元信息条、状态摘要和更清晰的审核区。
- CSS 调整为更稳定的内部工具布局，包含桌面和移动端约束。

验证：

```powershell
npm test
```

结果：

```text
Test Files  9 passed (9)
Tests       25 passed (25)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8080/health'
```

结果：

```json
{"ok":true}
```

当前服务监听：

```text
0.0.0.0:8080
```

当前监听进程：

```text
28828
```

## 2026-06-16 文件夹选择排查与修复

问题：

- 配置页点击“选择文件夹”后，Windows 文件夹选择窗口未弹出。

排查结论：

- 前端按钮和认证链路正常。
- 旧接口 `POST /api/settings/select-folder` 会同步等待 PowerShell `FolderBrowserDialog` 返回。
- 通过接口调用时，请求会超时，服务端 PowerShell 选择进程停留在 pending。
- 根因是：从后台启动的服务进程再启动 WinForms 文件夹窗口，在 Windows 桌面会话中不可靠，窗口可能无法显示到前台，且旧实现会导致 HTTP 请求一直等待。

修复：

- 将文件夹选择接口改为非阻塞：
  - `POST /api/settings/select-folder` 只启动独立选择进程并立即返回 `pickerId`。
  - `GET /api/settings/select-folder/:pickerId` 轮询选择结果。
  - PowerShell 弹窗增加 TopMost owner 窗口，尽量置顶显示。
- 增加稳定备用方案：
  - 新增 `GET /api/settings/directories`，由服务端列出服务器电脑上的盘符和目录。
  - 配置页新增“浏览服务器目录”，可从盘符开始逐级进入目录，并用“使用当前目录”填入 `watch_root`。
  - 该方案不依赖 Windows 系统弹窗，远程浏览器访问也可用。

验证：

```powershell
npm test
```

结果：

```text
Test Files  9 passed (9)
Tests       26 passed (26)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
GET http://127.0.0.1:8080/api/settings/directories
```

结果：可返回服务器盘符：

```json
["C:\\", "D:\\", "E:\\", "G:\\"]
```

当前服务监听：

```text
0.0.0.0:8080
```

当前监听进程：

```text
7828
```

## 2026-06-16 配置重启按钮验证

背景：

- Windows 文件夹选择弹窗在后台服务模型下仍可能不显示到前台。
- 配置 `watch_root` 后需要重启服务才会重新建立目录监听。

改动：

- 配置页提示改为推荐使用“浏览服务器目录”，不再把系统弹窗作为主路径。
- 配置页新增“重启服务”按钮。
- 后端新增 `POST /api/system/restart`，管理员可触发应用重启。
- `npm run dev` 改为运行 `scripts/dev-server.mjs` supervisor。
- 应用进程以退出码 `42` 退出时，supervisor 会自动拉起新的服务进程。

验证：

```powershell
npm test
```

结果：

```text
Test Files  10 passed (10)
Tests       27 passed (27)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
POST http://127.0.0.1:8080/api/system/restart
```

结果：

```json
{"restarting":true}
```

随后轮询：

```powershell
GET http://127.0.0.1:8080/health
```

结果：

```text
HEALTH_OK
```

当前服务监听：

```text
0.0.0.0:8080
```

当前监听进程：

```text
29972
```

## 2026-06-16 监听根目录 PDF 排查与修复

问题：

- 用户设置审批根目录为：

```text
G:\Personal documents\code\PDF审批\test
```

- 直接放入：

```text
G:\Personal documents\code\PDF审批\test\301新光纤-a0A0.pdf
```

- 系统未生成审批单。

排查结论：

- `watch_root` 已正确保存为测试目录。
- 审批列表为空。
- 文件命名符合 `零件名-a数字A数字.pdf`。
- 第一层原因：旧业务规则只接收 `01-待提交\项目名\*.pdf`，不接收根目录直接 PDF。
- 第二层原因：项目使用 `chokidar@4.0.3`，旧的 `**/*.pdf` glob 监听方式不可靠，需监听根目录后在代码中过滤 PDF。

修复：

- 支持两种提交方式：
  - 标准方式：`审批根目录\01-待提交\项目名\零件名-a0A0.pdf`
  - 简化方式：`审批根目录\零件名-a0A0.pdf`
- 简化方式自动归入“默认项目”。
- watcher 改为监听整个审批根目录，并在 `add` 事件中按 `.pdf` 后缀过滤。
- 已管理状态目录中的文件不会被重复处理。

验证：

```powershell
npm test
```

结果：

```text
Test Files  10 passed (10)
Tests       29 passed (29)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

重启后审批列表返回：

```json
{
  "projectName": "默认项目",
  "partName": "301新光纤",
  "version": "a0A0",
  "status": "pending",
  "currentFilePath": "G:\\Personal documents\\code\\PDF审批\\test\\02-审批中\\默认项目\\301新光纤-a0A0.pdf"
}
```

文件已移动到：

```text
G:\Personal documents\code\PDF审批\test\02-审批中\默认项目\301新光纤-a0A0.pdf
```

## 2026-06-16 管理端与目录标准化验证

改动：

- 设置页升级为“系统管理”，包含目录与通知、用户管理、服务日志三个标签页。
- 新增目录健康状态：监听根目录、标准目录是否就绪、配置生效提示。
- 新增 `POST /api/settings/prepare-folders`，可在审批根目录下幂等创建：
  - `01-待提交`
  - `02-审批中`
  - `03-已驳回`
  - `04-已通过待打印`
  - `05-已打印归档`
- 新增 `GET /api/settings/watch-root/status`，用于页面检查根目录和标准目录状态。
- 新增前端“浏览器选择”按钮，使用 File System Access API 做本机目录辅助选择，并明确提示该 API 不返回后端监听所需的 Windows 绝对路径。
- 新增 `GET /api/system/logs`，管理员可查看 `server.log` 和 `server.err.log` 尾部内容。
- 新增 `/api/users` 管理接口和页面：
  - 用户列表
  - 新增用户
  - 编辑姓名、邮箱、角色、启用状态
  - 重置密码
  - 防止停用最后一个管理员
- watcher 启动和处理 PDF 时增加服务日志输出。

验证：

```powershell
npm test
```

结果：

```text
Test Files  11 passed (11)
Tests       32 passed (32)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

接口验证：

```text
GET /health -> ok
GET /api/settings/watch-root/status -> rootExists=True
POST /api/settings/prepare-folders -> created=4, existing=1, ready=True
GET /api/users -> users=4
GET /api/system/logs?lines=20 -> logs=2
```

浏览器验证：

- 使用 `admin / admin123` 登录。
- 系统管理页正常渲染，中文无乱码。
- 目录状态显示“已就绪”。
- 用户管理标签页显示用户表和新增用户表单。
- 服务日志标签页显示 `server.log` 与 `server.err.log`。
- 浏览器控制台无 error。

## 2026-06-16 PDF 预览加载错误排查与修复

问题：

- 图纸详情页 PDF 预览区域显示加载错误，无法加载 PDF。

排查结论：

- 后端文件接口地址和鉴权正常。
- 当前审批单文件路径存在：

```text
G:\Personal documents\code\PDF审批\test\02-审批中\默认项目\301新光纤-a0A0.pdf
```

- 文件接口原先返回 HTTP 200 和 `application/pdf`。
- 但磁盘文件头不是标准 PDF 头 `%PDF-`，实际开头字节为：

```text
18-1B-03-1A-15-10-19-7C
```

- 根因：系统只按 `.pdf` 扩展名判断文件类型，导致扩展名为 PDF、但内容不是有效 PDF 的文件进入预览。

修复：

- 新增 PDF 文件头校验。
- `/api/approvals/:id/file` 在文件内容不是有效 PDF 时返回：

```json
{
  "error": "INVALID_PDF_FILE",
  "message": "文件扩展名是 PDF，但文件内容不是有效 PDF。请检查坚果云是否已完成同步，或重新导出 PDF。"
}
```

- 详情页加载 iframe 前先用 `HEAD` 检查文件状态。
- 无效文件不再直接进入浏览器 PDF 预览器，而是显示中文诊断和服务器文件路径。

验证：

```powershell
npm test
```

结果：

```text
Test Files  11 passed (11)
Tests       33 passed (33)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

接口验证：

```text
GET /api/approvals/1/file -> 422 INVALID_PDF_FILE
```

浏览器验证：

- 详情页显示“文件不是有效 PDF，无法预览”。
- 显示当前文件路径，便于排查坚果云同步或 CAD 导出问题。
- 浏览器控制台无 error。

## 2026-06-16 删除同步、漏检兜底与通知去重验证

问题：

- 已进入审核中的 PDF 被手动删除后，审批单仍留在“待我审核”。
- 新加入监听目录的文件偶发没有检测到。
- 每次进入待审核页面都会弹一次桌面通知。

排查结论：

- watcher 原先只处理 `add` 事件，没有处理 `unlink`，文件删除不会反映到数据库。
- 只依赖 chokidar 对坚果云同步目录不够稳，新增文件事件可能被同步客户端行为影响。
- 待办页每次加载只要有待办就调用 `new Notification(...)`，没有按审批 ID 去重。

修复：

- 新增审批状态 `file_missing`，保留记录但不再进入审核队列。
- watcher 新增 `unlink` 处理：待审文件被删除时标记为 `file_missing`。
- watcher 新增 10 秒兜底扫描：
  - 扫描未处理的 PDF，补偿漏掉的 add 事件。
  - 扫描 pending 审批单的当前文件路径，补偿服务离线期间的删除。
- 待办页通知按审批 ID 使用 `localStorage` 去重，同一浏览器内只对新增待办弹通知。

验证：

```powershell
npm test
```

结果：

```text
Test Files  12 passed (12)
Tests       39 passed (39)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

现场验证：

```text
当前监听目录：G:\Personal documents\code\PDF审批\test
新增文件：01-待提交\现场验证\现场验证141035-a0A0.pdf
检测结果：已生成审批单并移动到 02-审批中\现场验证
删除移动后的文件：状态变为 file_missing
```

## 2026-06-16 第二版功能验证

范围：

- 新增异常状态：`invalid_pdf`、`voided`。
- 新增操作日志和审批详情时间线。
- 新增手动修复 API：作废、重新绑定文件、重新校验 PDF。
- 提交时识别无效 PDF。
- 新增手动扫描 API 和扫描记录。
- 新增 SMTP 测试 API。
- 系统管理页新增扫描维护、SMTP 测试、操作日志。
- 新增数据库备份脚本。

自动化测试：

```powershell
npm test
```

结果：

```text
Test Files  15 passed (15)
Tests       66 passed (66)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built in 1.02s
```

备份脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1
```

结果：

```text
Backup created: backups\pdf-approval-20260616-160059
Files: pdf-approval.sqlite, pdf-approval.sqlite-wal, pdf-approval.sqlite-shm
```

服务健康与重启验证：

```text
临时端口：18081
GET /health -> ok
POST /api/system/restart -> restarting
重启后 GET /health -> RESTART_HEALTH_OK
```

浏览器烟测：

- 使用默认管理员登录。
- 系统管理页可显示目录扫描、邮件测试、清除本机通知记录。
- 操作日志页可显示日志表头和刷新按钮。
- 异常审批详情页可显示异常处理面板、替换 PDF、重新校验、作废和操作时间线。
- 浏览器控制台无 error。

人工/自动化验收覆盖：

1. 正常 PDF 提交流程：由 watcher 测试覆盖。
2. 主管审批：由审批路由测试覆盖。
3. 工艺审批：由审批路由测试覆盖。
4. 双人通过后进入待打印：由审批路由测试覆盖。
5. 打印归档：由审批路由测试覆盖。
6. 无效 PDF 创建 `invalid_pdf`：由 watcher 测试覆盖。
7. 无效 PDF 重新绑定为有效 PDF 后回到 `pending`：由审批路由测试覆盖。
8. 删除 pending 文件后变为 `file_missing`：由 watcher 测试覆盖。
9. `file_missing` 重新绑定：由审批路由测试覆盖。
10. 作废审批：由审批路由测试覆盖。
11. 操作时间线：由浏览器烟测覆盖。
12. 手动扫描和扫描记录：由系统路由测试覆盖。
13. SMTP 测试成功/失败：由设置路由和邮件 helper 测试覆盖。
14. 备份脚本创建备份文件：由脚本命令验证覆盖。

剩余限制：

- 本次未连接真实 SMTP 服务发送外部邮件；自动化测试使用注入 transport 验证成功和失败路径。
- 浏览器烟测使用临时本地数据库，不影响实际生产数据。
- 真实坚果云同步行为仍建议在现场部署后按实际目录做一次提交和删除文件验证。

## 2026-06-16 第三版运维增强验证

范围：

- 新增系统健康诊断服务与管理员接口：
  - 数据库读写检查。
  - 监听根目录存在性。
  - 五个标准目录存在性。
  - 标准目录写入权限。
  - 最近扫描记录。
  - 最近备份记录。
- 新增 `backup_runs` 表、备份仓库、备份服务与管理员接口：
  - 复制 `pdf-approval.sqlite`。
  - 复制可选 `pdf-approval.sqlite-wal`、`pdf-approval.sqlite-shm`。
  - 记录成功与失败备份。
  - 操作日志记录备份成功/失败。
- 系统管理页“运维追溯”新增：
  - 系统健康诊断面板。
  - 数据库备份面板。
  - 签名配置概览。
  - 保留追溯报表和全局操作日志。

后端目标测试：

```powershell
npm test -- src/server/services/diagnostics.test.ts src/server/repositories/backups.test.ts src/server/services/backupService.test.ts src/server/routes/system.test.ts
```

结果：

```text
Test Files  4 passed (4)
Tests       12 passed (12)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built in 984ms
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  30 passed (30)
Tests       124 passed (124)
```

服务启动验证：

```powershell
GET http://127.0.0.1:8080/health
```

结果：

```json
{"ok":true}
```

当前监听：

```text
0.0.0.0:8080
```

浏览器烟测：

- 使用现有管理员登录态打开 `http://127.0.0.1:8080/#/settings`。
- 切换到“运维追溯”。
- 页面显示“系统健康诊断”，当前状态为“运行正常”。
- 数据库显示“可读写”。
- 监听根目录显示 `G:\Personal documents\code\PDF审批\test`。
- 标准目录显示 `5/5`。
- 写入权限显示 `5/5`。
- 页面显示“数据库备份”“签名配置”“追溯报表”“操作日志”模块。
- 浏览器控制台无 error。

说明：

- 浏览器烟测未点击“立即备份”，避免在人工查看页面时额外制造备份记录。
- 备份创建、备份文件复制、备份记录列表和操作日志由自动化测试覆盖。

## 2026-06-16 第三版收尾回归验证

范围：

- 第三版实现总结文档。
- Windows 局域网部署文档 V3 上线说明。
- 全量自动化测试。
- 生产构建。
- 服务健康检查。
- 管理端、提交图纸页、我的签名页浏览器冒烟。
- 运维诊断、数据库备份、CSV 报表接口验证。

文档更新：

- 新增 `docs/v3-implementation-summary.md`。
- 更新 `docs/deploy-windows-lan.md`，补充：
  - 第三版上线检查。
  - 网页提交图纸。
  - 签名配置。
  - 自动签名。
  - 打印归档。
  - 运维追溯。
  - 备份恢复。
  - 常见问题。

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  30 passed (30)
Tests       124 passed (124)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built in 1.07s
```

服务健康：

```powershell
GET http://127.0.0.1:8080/health
```

结果：

```json
{"ok":true}
```

当前监听：

```text
0.0.0.0:8080
```

当前服务进程：

```text
node.exe ...node_modules\tsx...
```

浏览器冒烟：

- 打开 `http://127.0.0.1:8080/#/settings`。
- 当前为管理员登录态。
- “运维追溯”显示：
  - 系统健康诊断。
  - 数据库可读写。
  - 监听根目录。
  - 标准目录 `5/5`。
  - 写入权限 `5/5`。
  - 数据库备份。
  - 签名配置。
  - 追溯报表。
  - 操作日志。
- 打开 `#/submit`，页面显示“提交图纸”和 PDF 上传相关控件。
- 打开 `#/signature`，页面显示“我的签名”和上传/手写相关控件。
- 浏览器控制台无 error。

运维接口验证：

```powershell
POST /api/auth/login
GET /api/system/diagnostics
POST /api/system/backup
GET /api/reports/approvals.csv
```

结果：

```json
{
  "diagnosticsStatus": "ok",
  "backupStatus": "completed",
  "backupPath": "G:\\Personal documents\\code\\PDF审批\\backups\\pdf-approval-20260616-205212",
  "csvStatus": 200,
  "csvContentType": "text/csv; charset=utf-8",
  "csvFirstLine": "审批单ID,项目,零件,版本,状态,提交人,提交时间,主管状态,主管时间,工艺状态,工艺时间,签名状态,签后文件,原始哈希,签后哈希,归档时间"
}
```

未做的现场项：

- 未用真实机械图纸完成一次人工端到端签审。
- 未现场确认三方签名在真实图框中的最终视觉位置。
- 未连接真实 SMTP 向外部邮箱发送通知。
- 未在真实坚果云同步目录中做多人并发试运行。

这些项目需要在正式上线前由管理员按 `docs/deploy-windows-lan.md` 的第三版上线检查执行。

## 2026-06-16 第三版签名位置补录验证

范围：

- 新增审批详情页签名位置加载、编辑、重置和保存入口。
- 新增审批单签名位置查询和保存 API。
- 目录监听提交的审批单可由设计师或管理员后补签名框。
- 已通过双审的审批单在保存签名框后会立即尝试生成签后 PDF。
- 更新第三版实现总结和 Windows 局域网部署说明。

回归测试先确认红灯：

```powershell
npm test -- src/server/routes/approvals.test.ts
```

结果：新增场景 `generates a signed PDF after placements are saved on an already approved approval` 先失败，返回 `pending` 而不是 `generated`。

局部验证：

```powershell
npm test -- src/client/pages/approvalDetailLogic.test.ts src/server/routes/approvals.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       26 passed (26)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  31 passed (31)
Tests       132 passed (132)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built in 1.05s
```

服务重启与健康检查：

```powershell
POST /api/system/restart -> {"restarting":true}
GET  /health -> HEALTH_OK
```

浏览器冒烟：

- 打开 `http://127.0.0.1:8080/#/approvals/1`。
- 审批详情页正常渲染，标题为 `PDF 图纸审批`。
- 当前本机数据库没有 `placement_required` 记录，因此未额外创建业务数据。
- 浏览器控制台 error 数量为 0。

## 2026-06-17 权限拆分、提交预览滚动和打印角色调整验证

范围：

- 按角色拆分前端导航和后端接口权限。
- 设计师不再显示“待我审核”，主管/工艺不再显示“提交图纸”。
- 打印归档改为设计师或管理员执行。
- 新增和修改用户时不再允许选择 `printer`，历史 `printer` 仅兼容旧数据。
- 提交页 PDF 预览容器改为可滚动，避免上传后预览超出屏幕看不全。
- 签名框最小宽高和标签字号下调，支持更小位置框。

局部回归：

```powershell
npm test -- src/client/roleAccess.test.ts src/client/widgets/SignaturePlacementEditor.test.ts src/server/routes/approvals.test.ts src/server/routes/users.test.ts
```

结果：

```text
Test Files  4 passed (4)
Tests       33 passed (33)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  33 passed (33)
Tests       141 passed (141)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built in 1.37s
```

服务重启与健康检查：

```powershell
npm run dev
GET /health -> {"ok":true}
```

运行日志显示：

```text
PDF approval watcher active: G:\Personal documents\code\PDF审批\test
PDF approval server listening on http://0.0.0.0:8080
```

浏览器冒烟：

- 打开 `http://127.0.0.1:8080/#/approvals`，当前管理员会话正常渲染。
- 打开 `#/submit`，页面正常显示“提交图纸”。
- 已加载样式确认 `.placement-stage` 为 `overflow: auto`。
- 已加载样式确认 `.signature-placement-layer` 不拦截空白区滚动，`.signature-box` 自身仍可拖拽。
- 已加载样式确认签名框最小尺寸为 `18px x 14px`，标签字号为 `9px`。

未覆盖项：

- 本次未重新上传真实机械图纸做人工端到端签审。
- 未使用账号密码重新登录所有角色逐个截图确认；角色权限由新增自动化测试覆盖。

## 2026-06-17 第三版缺口补齐验证

范围：

- 打印归档时移动签后 PDF 到 `05-已打印归档` 并更新 `signed_file_path`。
- CSV 追溯报表增加“最近问题/评论摘要”字段。
- 系统诊断增加服务启动时间和服务日志可读状态。
- PDF 签名框增加多页 PDF 的页码选择能力。
- 前端兼容旧诊断响应：服务未重启时，旧后端未返回 `service/logs` 也不会导致运维追溯页白屏。

红灯验证：

```powershell
npm test -- src/server/routes/approvals.test.ts
npm test -- src/server/routes/reports.test.ts src/server/services/diagnostics.test.ts src/client/widgets/SignaturePlacementEditor.test.ts
npm test -- src/client/pages/settingsDiagnostics.test.ts
```

结果：新增用例先失败，分别暴露签后 PDF 未归档、CSV 缺少摘要列、诊断缺少日志/启动时间字段、签名框缺少页码切换函数。

局部回归：

```powershell
npm test -- src/server/routes/approvals.test.ts
npm test -- src/server/routes/reports.test.ts src/server/services/diagnostics.test.ts src/client/widgets/SignaturePlacementEditor.test.ts
npm test -- src/client/pages/settingsDiagnostics.test.ts
```

结果：

```text
Test Files  5 passed (5)
Tests       44 passed (44)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  40 passed (40)
Tests       173 passed (173)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

服务重启与浏览器烟测：

```powershell
POST /api/system/restart -> {"restarting":true}
GET  /health -> HEALTH_OK
```

浏览器验证：

- 打开 `http://127.0.0.1:8080/#/submit`，提交图纸页正常渲染。
- 打开 `#/settings` 并切换到“运维追溯”，页面显示系统健康诊断。
- 运维诊断卡片显示数据库、监听根目录、标准目录、写入权限、服务启动、服务日志。
- 服务重启后显示服务启动时间，服务日志显示 `2/2`。
- 刷新后的浏览器控制台无新增 error。

仍需现场验证：

- 用真实机械图纸确认三方签名视觉位置。
- 在真实坚果云同步目录做上传、审核、签名、打印归档完整试运行。

## 2026-06-17 V4.1 签名模板验证

范围：

- 新增签名模板表、仓库和 API。
- 审批详情页支持将当前设计、主管、工艺三类签名框保存为模板。
- 提交图纸页支持选择并套用签名模板。
- 系统管理页增加签名模板管理表，可维护模板名称、适用项目并删除模板。

红灯验证：

```powershell
npm test -- --run src/server/routes/approvals.test.ts
npm test -- --run src/client/api.test.ts src/client/pages/submitDrawingLayout.test.ts src/client/pages/approvalDetailLogic.test.ts
npm test -- --run src/server/routes/signatureTemplates.test.ts
```

结果：新增用例先失败，分别暴露审批详情另存模板接口缺失、前端模板 API/套用逻辑缺失、管理端无法列出全部项目模板。

阶段聚焦测试：

```powershell
npm test -- --run src/server/repositories/signatureTemplates.test.ts src/server/routes/signatureTemplates.test.ts src/server/routes/approvals.test.ts src/client/pages/submitDrawingLayout.test.ts src/client/pages/approvalDetailLogic.test.ts
```

结果：

```text
Test Files  5 passed (5)
Tests       61 passed (61)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  44 passed (44)
Tests       197 passed (197)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

仍需现场验证：

- 在真实图纸详情页保存一个常用图框模板。
- 在提交页套用该模板后检查 PDF 预览中的三类签名框位置。

## 2026-06-17 V4.2 批量上传验证

范围：

- 新增批量提交表、仓库和接口。
- 提交图纸页支持一次选择多个 PDF。
- 批量上传后每张图纸保留独立签名框位置。
- 签名模板可批量套用为初始位置，也可只套用到当前图纸。
- 批量提交返回逐项成功/失败结果，单项失败不阻塞其它有效图纸。

阶段聚焦测试：

```powershell
npm test -- --run src/server/repositories/batchSubmissions.test.ts src/server/routes/submissions.test.ts src/client/pages/submitDrawingLayout.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       21 passed (21)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  45 passed (45)
Tests       208 passed (208)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

仍需现场验证：

- 选择多张真实图纸后逐张检查签名框位置是否独立保存。
- 用真实坚果云同步目录确认批量提交后文件进入 `02-审批中\项目名\`。

## 2026-06-17 V4.3 批量签后 PDF 处理验证

范围：

- 新增批量重新生成签后 PDF 接口。
- 新增批量标记打印归档接口。
- 批量操作返回逐项成功/失败结果。
- 设计师和管理员可批量处理，主管和工艺不可执行批量签后处理。
- “全部图纸”页增加批量重新生成签后 PDF、批量标记打印归档和逐项结果展示。

红灯验证：

```powershell
npm test -- --run src/server/routes/approvals.test.ts
npm test -- --run src/client/pages/approvalListLogic.test.ts
```

结果：新增用例先失败，分别暴露批量审批后处理接口缺失、前端批量候选规则函数缺失。

阶段聚焦测试：

```powershell
npm test -- --run src/server/routes/approvals.test.ts src/client/pages/approvalListLogic.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       46 passed (46)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  45 passed (45)
Tests       213 passed (213)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

浏览器烟测：

- 打开 `http://127.0.0.1:8080/#/approvals`。
- 退出旧登录态后使用管理员重新登录。
- “全部图纸”页面正常渲染，浏览器控制台无 error。
- 当前运行库无图纸记录，批量操作栏未出现；批量按钮显示和可用性由自动化测试覆盖，真实数据下仍需现场试跑。

仍需现场验证：

- 在“全部图纸”筛选“已通过待打印”，勾选多张图纸批量重新生成签后 PDF。
- 对包含签名失败或未生成签后 PDF 的图纸执行批量归档，确认失败项逐项提示。

## 2026-06-18 V4.4 运维风险看板验证

范围：

- 新增系统风险识别服务和管理员风险接口。
- 系统管理页“运维追溯”新增风险看板。
- 风险项支持跳转到异常图纸筛选入口。
- `#/approvals?status=...` 与 `#/approvals?signatureStatus=...` 路由可正确进入全部图纸页。

阶段聚焦测试：

```powershell
npm test -- --run src/server/services/systemRisks.test.ts src/server/routes/system.test.ts src/server/routes/approvals.test.ts src/client/pages/settingsDiagnostics.test.ts src/client/pages/approvalListLogic.test.ts src/client/appRouting.test.ts
```

结果：

```text
Test Files  6 passed (6)
Tests       69 passed (69)
```

浏览器烟测：

- `POST /api/system/restart -> {"restarting":true}`。
- `GET /health -> {"ok":true}`。
- 打开 `http://127.0.0.1:8080/#/settings` 并切换到“运维追溯”。
- 页面显示“风险看板”和“系统健康诊断”。
- 打开 `#/approvals?status=file_missing` 可进入“全部图纸”。
- 浏览器控制台无 error。

## 2026-06-18 V4.5 轻量版本追溯验证

范围：

- 审批仓库新增同项目、同零件版本查询。
- 审批详情返回 `relatedVersions`，详情页“其它版本”浮窗排除当前图纸。
- 提交页上传解析和项目/零件变化后都能刷新“同零件已有版本”提醒。
- 追溯 CSV 增加“同零件版本数”字段。

红灯验证：

```powershell
npm test -- --run src/server/repositories/approvals.test.ts src/server/routes/approvals.test.ts src/server/routes/submissions.test.ts src/server/routes/reports.test.ts src/client/pages/approvalDetailLogic.test.ts src/client/pages/submitDrawingLayout.test.ts
npm test -- --run src/server/routes/submissions.test.ts src/client/api.test.ts src/client/pages/submitDrawingLayout.test.ts
```

结果：新增用例先失败，分别暴露 `listVersions` 缺失、详情缺少 `relatedVersions`、上传预览缺少 `existingVersions`、CSV 缺少版本数字段、提交页缺少项目变更后的版本提醒刷新。

阶段聚焦测试：

```powershell
npm test -- --run src/server/repositories/approvals.test.ts src/server/routes/approvals.test.ts src/server/routes/submissions.test.ts src/server/routes/reports.test.ts src/client/api.test.ts src/client/pages/approvalDetailLogic.test.ts src/client/pages/submitDrawingLayout.test.ts
```

结果：

```text
Test Files  7 passed (7)
Tests       90 passed (90)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  47 passed (47)
Tests       234 passed (234)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

服务重启与浏览器烟测：

```powershell
POST /api/system/restart -> {"restarting":true}
GET  /health -> {"ok":true}
```

浏览器验证：

- 打开 `http://127.0.0.1:8080/#/submit`，提交页正常渲染，包含 PDF 文件入口和签名模板入口。
- 打开 `#/approvals?status=file_missing`，进入“全部图纸”，确认带查询参数的路由正常。
- 打开 `#/settings` 并切换“运维追溯”，风险看板和系统健康诊断正常渲染。
- 浏览器控制台无 error。

仍需现场验证：

- 用真实同项目、同零件多版本图纸确认提交页提醒和详情页“其它版本”入口符合设计师习惯。
- 导出 CSV 后用现场常用表格软件打开，确认“同零件版本数”列显示正常。

## 2026-06-18 V4.6 文档与发布回归验证

范围：

- 新增第四版实现总结。
- 更新 Windows 局域网部署说明，覆盖第四版上线检查、签名模板、批量上传、批量签后 PDF 处理、风险看板和轻量版本追溯。
- 执行第四版收尾发布回归。

文档更新：

```text
docs/v4-implementation-summary.md
docs/deploy-windows-lan.md
```

文档检索：

```powershell
rg -n "V4|第四版|签名框模板|批量上传|风险看板" docs
```

结果：可检索到新增 V4 总结、部署说明、V4.1-V4.5 验证记录和 V4 方案文档。

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  47 passed (47)
Tests       234 passed (234)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

服务重启与健康检查：

```powershell
POST /api/system/restart -> {"restarting":true}
GET  /health -> {"ok":true}
```

浏览器烟测：

- 登录管理员账号后打开 `http://127.0.0.1:8080/#/submit`。
- 提交页显示“提交图纸”“PDF 文件”“签名模板”“套用模板”。
- 打开 `#/approvals`，进入“全部图纸”。
- 打开 `#/settings`，确认“签名模板”和“运维追溯”入口存在。
- 切换到“签名模板”，页面正常渲染。
- 切换到“运维追溯”，页面显示“风险看板”“系统健康诊断”“数据库备份”。
- 浏览器控制台无 error。

仍需现场验证：

- 用真实坚果云同步目录执行多 PDF 批量上传，确认文件同步和服务器目录写入符合现场网络条件。
- 用真实机械图纸逐张检查模板套用后的签名视觉位置，尤其是不同图框和多页 PDF。
- 在真实已通过待打印数据上执行批量重新生成签后 PDF 和批量打印归档，确认逐项结果提示符合现场操作习惯。

## 2026-06-18 V4.7 批量提交历史追溯验证

范围：

- 系统管理页“运维追溯”新增“批量提交记录”面板。
- 面板展示最近批量上传批次的项目、批次号、状态、成功数、失败数、总数和逐项结果。
- 批量提交逐项结果显示文件名、处理状态、签名框来源和失败原因。
- 更新第四版总结和 Windows 局域网部署说明。

红灯验证：

```powershell
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

结果：新增用例先失败，暴露 `batchSubmissionStatusLabel`、`placementStateLabel` 和 `normalizeBatchSubmissions` 尚未实现。

聚焦测试：

```powershell
npm test -- --run src/client/api.test.ts src/client/pages/settingsDiagnostics.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       10 passed (10)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

服务重启与健康检查：

```powershell
POST /api/system/restart -> {"restarting":true}
GET  /health -> {"ok":true}
```

浏览器烟测：

- 登录管理员账号后打开 `http://127.0.0.1:8080/#/settings`。
- 切换到“运维追溯”。
- 页面显示“风险看板”和“批量提交记录”。
- 当前没有批量记录时显示“暂无批量提交记录”。
- 浏览器控制台无 error。

仍需现场验证：

- 用真实多 PDF 批量提交生成一条批量记录，确认成功项、失败项和错误原因符合现场操作习惯。

## 2026-06-18 V5.1 托盘摘要接口与 Tauri 前置检查

范围：

- 新增托盘助手摘要服务 `getTraySummary`。
- 新增 `/api/tray/summary`，供 Tauri 托盘助手轮询当前账号待办和管理员风险摘要。
- 新增 `scripts/check-tauri-prereqs.ps1`，用于检查 Tauri Windows 构建前置环境。
- 更新 Windows 局域网部署说明中的 V5 托盘助手前置条件。

红灯验证：

```powershell
npm test -- --run src/server/services/traySummary.test.ts
```

结果：先失败，原因是 `src/server/services/traySummary.ts` 不存在。

```powershell
npm test -- --run src/server/routes/tray.test.ts
```

结果：先失败，请求 `/api/tray/summary` 落到前端静态回退，未返回托盘摘要数据。

聚焦测试：

```powershell
npm test -- --run src/server/services/traySummary.test.ts src/server/routes/tray.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       5 passed (5)
```

全量测试：

```powershell
npm test
```

结果：

```text
Test Files  50 passed (50)
Tests       248 passed (248)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

Tauri 前置检查：

```powershell
.\scripts\check-tauri-prereqs.ps1
```

结果：

```text
Node v24.15.0
npm 11.12.1
rustc 1.96.0
cargo 1.96.0
stable-x86_64-pc-windows-msvc
x86_64-pc-windows-msvc
WebView2 found
cl.exe missing
vswhere.exe missing
```

结论：

- 后端托盘摘要接口第一批测试通过。
- Tauri 构建前还需要补齐或确认 Microsoft C++ Build Tools。

## 2026-06-18 V5.2 Tauri 子应用骨架与登录基础逻辑

范围：

- 新增 `apps/tray-helper` Tauri v2 子应用骨架。
- 根项目新增 `tray:dev`、`tray:build`、`tray:test` 脚本。
- 子应用新增设置窗口初始页面。
- 新增托盘端纯逻辑模块：
  - `linkBuilder`
  - `notificationState`
  - `roles`
- 新增托盘端 API 客户端：
  - 登录 `/api/auth/login`
  - 摘要 `/api/tray/summary`
  - 健康检查 `/health`
  - 401 转换为 `auth_expired`
- 新增本机登录状态存储封装 `authStore`。

Tauri 依赖版本确认：

```text
@tauri-apps/cli 2.11.2
@tauri-apps/api 2.11.1
@tauri-apps/plugin-notification 2.3.3
@tauri-apps/plugin-autostart 2.5.1
@tauri-apps/plugin-store 2.4.3
@tauri-apps/plugin-opener 2.5.4
```

红灯验证：

```powershell
npm run tray:test
```

结果：

- 纯逻辑测试先失败，原因是 `linkBuilder.ts`、`notificationState.ts`、`roles.ts` 不存在。
- API 客户端测试先失败，原因是 `apiClient.ts` 不存在。
- 登录存储测试先失败，原因是 `authStore.ts` 不存在。

托盘端测试：

```powershell
npm run tray:test
```

结果：

```text
Test Files  5 passed (5)
Tests       8 passed (8)
```

托盘端前端构建：

```powershell
npm --prefix apps/tray-helper run build
```

结果：

```text
tsc && vite build
✓ built
```

根项目全量测试：

```powershell
npm test
```

结果：

```text
Test Files  50 passed (50)
Tests       248 passed (248)
```

根项目生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

未执行：

- `npm run tray:dev`
- `npm run tray:build`

原因：当前 PowerShell 中仍未确认 Microsoft C++ Build Tools，`cl.exe` 和 `vswhere.exe` 未检测到。需补齐 MSVC 环境后再进入 Tauri Rust 编译和托盘运行验证。

## 2026-06-18 V5.3 托盘轮询、通知、菜单和管理员动作

范围：

- 托盘端新增轮询状态机：
  - 在线轮询间隔 30 秒
  - 离线/错误退避 60 秒
  - 未登录和登录过期停止认证轮询
  - 401 自动清理本地登录态
- 托盘端新增系统通知逻辑：
  - 新待审图纸按审批 ID 去重
  - 已提醒 ID 本地持久化，避免重启后重复提醒
  - 单张图纸打开明细，多张图纸打开待办列表
  - 通知携带 `open-approval` 动作和目标 URL，供 Windows 通知点击/打开动作回到审批页面
- 托盘端新增角色化菜单模型：
  - 主管/工艺显示待审核入口
  - 设计师显示提交图纸和我的签名入口
  - 管理员显示系统管理、服务日志、立即扫描、重启服务
  - 非管理员不显示扫描和重启动作
- 托盘端接入 Tauri：
  - 创建/更新系统托盘菜单
  - 通过系统浏览器打开审批工作台链接
  - 系统通知点击回到对应 URL
  - 设置窗口关闭时隐藏，托盘菜单可重新打开
  - 登录成功后刷新托盘状态并隐藏设置窗口
  - 已登录启动时默认隐藏设置窗口
- 后端已有管理员接口被托盘复用：
  - `POST /api/system/scan-now`
  - `POST /api/system/restart`
- Web 设置页支持 `#/settings?tab=logs` 和 `#/settings?tab=operations`，便于托盘直达服务日志/运维追溯。
- Rust/Tauri 配置更新：
  - 启用 `tray-icon`
  - 注册 notification、opener、store、autostart 插件
  - 增加 Tauri capability 权限文件
  - 增加 `quit_app` 命令

红灯验证：

```powershell
npm run tray:test
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

结果：

- 托盘测试先失败，原因是 `notifications.ts`、`poller.ts`、`trayMenu.ts` 不存在，且 `apiClient`/`authStore` 缺少新增方法。
- 设置页测试先失败，原因是 `settingsTabFromHash` 不存在。

托盘端测试：

```powershell
npm run tray:test
```

结果：

```text
Test Files  8 passed (8)
Tests       20 passed (20)
```

托盘端前端构建：

```powershell
npm --prefix apps/tray-helper run build
```

结果：

```text
tsc && vite build
✓ built
```

说明：Vite 报告 `@tauri-apps/api/core.js` 同时被静态和动态导入，属于分包提示，不影响构建结果。

Tauri CLI 环境检查：

```powershell
npm --prefix apps/tray-helper run tauri -- info
.\scripts\check-tauri-prereqs.ps1
```

结果：

```text
WebView2 found
rustc 1.96.0
cargo 1.96.0
Rust toolchain stable-x86_64-pc-windows-msvc
MSVC cl.exe missing
vswhere.exe missing
```

Rust 检查：

```powershell
cargo check
```

结果：

- 第一次暴露脚手架问题：`Cargo.toml` 声明了 lib target，但没有 `src/lib.rs`。已删除多余 lib target。
- 之后 `cargo check` 拉取 crates.io 失败，错误指向 `index.crates.io` 通过 `127.0.0.1` 代理连接失败。
- 覆盖代理环境变量后再次执行，5 分钟未完成，判断为当前 Cargo 网络/镜像环境不可用。

根项目全量测试：

```powershell
npm test
```

结果：

```text
Test Files  50 passed (50)
Tests       249 passed (249)
```

根项目生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

未执行：

- `npm run tray:dev`
- `npm run tray:build`

原因：

- 当前机器缺 Microsoft C++ Build Tools / MSVC，`cl.exe` 和 `vswhere.exe` 均未检测到。
- 当前 Cargo 依赖下载环境不可用，Rust 依赖尚不能稳定拉取。

下一步进入 Tauri 真机运行前，需要先完成：

1. 安装 Visual Studio Build Tools，勾选 Desktop development with C++。
2. 修复 Cargo 访问 crates.io 的代理/镜像配置，或配置可用内网 Rust crate 镜像。
3. 重新执行 `cargo check`、`npm run tray:dev`、`npm run tray:build` 和托盘通知手工冒烟。

## 2026-06-18 V5.4 托盘打包元数据与上线文档

范围：

- 新增托盘助手图标源文件：`apps/tray-helper/src-tauri/app-icon.svg`。
- 使用 Tauri CLI 生成默认图标集：`apps/tray-helper/src-tauri/icons`。
- 更新 `tauri.conf.json`：
  - 产品名：`PDF 图纸审批托盘助手`
  - 应用标识：`local.pdf-approval.tray-helper`
  - 托盘图标：`icons/32x32.png`
  - Windows 打包目标：`nsis`、`msi`
  - 安装包图标：`icons/icon.ico`
  - 发布者：`PDF Approval Team`
- 新增用户指南：`docs/tray-helper-user-guide.md`。
- 新增管理员指南：`docs/tray-helper-admin-guide.md`。
- 新增发布验收清单：`docs/tray-helper-verification.md`。
- 更新 Windows 局域网部署文档，加入托盘助手文档索引、构建命令和产物路径。

图标生成：

```powershell
npm --prefix apps/tray-helper run tauri -- icon src-tauri/app-icon.svg
```

结果：

```text
icon.ico, icon.icns, icon.png, 32x32.png, 64x64.png, 128x128.png and platform icon sets created
```

Tauri 配置检查：

```powershell
npm --prefix apps/tray-helper run tauri -- info
```

结果：

```text
WebView2 found
Rust stable-x86_64-pc-windows-msvc found
Tauri JS 2.11.2 / API 2.11.1 detected
Plugins detected: autostart, notification, store, opener
MSVC Build Tools missing
```

托盘端测试：

```powershell
npm run tray:test
```

结果：

```text
Test Files  8 passed (8)
Tests       20 passed (20)
```

托盘端前端构建：

```powershell
npm --prefix apps/tray-helper run build
```

结果：

```text
tsc && vite build
✓ built
```

根项目全量测试：

```powershell
npm test
```

结果：

```text
Test Files  50 passed (50)
Tests       249 passed (249)
```

根项目生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

Tauri 安装包构建：

```powershell
npm run tray:build
```

结果：

- 命令运行 5 分钟后超时。
- 未生成 `apps/tray-helper/src-tauri/target/release/bundle`。
- 超时后确认存在残留 `npm run tray:build`、`tauri build` 和 `cargo build --release` 进程，已停止这些构建进程。

Cargo 离线检查：

```powershell
cargo check --offline
```

结果：

```text
error: no matching package named `winapi` found
required by package `auto-launch v0.5.0`
required by package `tauri-plugin-autostart v2.0.0`
```

结论：

- V5.4 的打包元数据、图标资源和上线文档已完成。
- 当前机器仍不能产出 Tauri Windows 安装包。
- 阻塞项仍是：
  - 缺 Visual Studio Build Tools / MSVC。
  - Cargo 本地缓存不完整，且当前 crates.io 网络/代理不可用。

## 2026-06-18 V5.5 非 C 盘 Tauri 构建环境准备

本节原本记录“把 Tauri 构建环境放到非 C 盘”的准备方案。该方案已被 V5.6 取代，不再作为当前实施路径。

保留结论：

- 当时没有执行真实 Rust 安装。
- 当时没有执行 Visual Studio Build Tools 安装。
- 当前机器仍未产出 Tauri Windows 安装包。
- 后续以 V5.6 的“当前机器不安装工具链，安装包由外部构建机/CI 产出”为准。

## 2026-06-18 V5.6 托盘助手外部构建模式

用户最新约束：

- 当前机器不要安装 Tauri 打包环境。
- 不再继续 Rust、Visual Studio Build Tools 或专用工具链目录的本机安装路径。

范围调整：

- 删除会创建目录、下载或安装工具链的脚本：
  - `scripts/use-tauri-build-env.ps1`
  - `scripts/bootstrap-rust-non-c.ps1`
  - `scripts/install-vs-buildtools-non-c.ps1`
  - `scripts/build-tray-non-c.ps1`
- 重写 `scripts/check-tauri-prereqs.ps1` 为只读检查脚本。
- 新增 `scripts/build-tray-frontend-only.ps1`，只运行托盘单元测试和托盘前端构建。
- 新增 `docs/tray-helper-external-build.md`，固化外部构建机/CI 产出 Windows 安装包的流程。
- 更新 `docs/tray-helper-admin-guide.md`、`docs/tray-helper-verification.md`、`docs/deploy-windows-lan.md`，移除当前机器安装工具链的上线指引。

当前机器允许执行的验证：

```powershell
npm test
npm run build
.\scripts\build-tray-frontend-only.ps1
.\scripts\check-tauri-prereqs.ps1
```

当前机器不执行：

```powershell
npm run tray:build
```

除非后续明确允许在这台机器安装并使用 Tauri 打包环境。

外部构建机负责执行：

```powershell
npm install --registry=https://registry.npmmirror.com
npm --prefix apps/tray-helper install --registry=https://registry.npmmirror.com
npm test
npm run build
npm run tray:test
npm --prefix apps/tray-helper run build
npm run tray:build
```

安装包产物路径：

```text
apps\tray-helper\src-tauri\target\release\bundle
```

本批验证结果：

```powershell
.\scripts\check-tauri-prereqs.ps1
```

结果：

- Node `v24.15.0`、npm `11.12.1` 可用。
- Rust `1.96.0`、Cargo `1.96.0`、`stable-x86_64-pc-windows-msvc` 可用。
- WebView2 Runtime 存在。
- `cl.exe` 缺失。
- `vswhere.exe` 缺失。
- 脚本只读执行，没有安装或下载工具链。

```powershell
.\scripts\build-tray-frontend-only.ps1
```

结果：

- 托盘单元测试：8 个文件、20 个测试通过。
- 托盘前端构建：`tsc && vite build` 通过。
- 未执行 Rust 编译或 Tauri 安装包构建。

```powershell
npm test
```

结果：

- 50 个测试文件通过。
- 249 个测试通过。

```powershell
npm run build
```

结果：

- `tsc && vite build` 通过。

当前结论：

- 当前机器上的 V5 Web、后端和托盘前端验证通过。
- 当前机器仍不产出 Tauri Windows 安装包。
- Tauri 安装包需按 `docs/tray-helper-external-build.md` 在外部构建机/CI 生成。

## 2026-06-19 V5.7 Electron 客户端第一批

用户方向调整：

- V5 正式主线改为 Electron 客户端 + 局域网服务端。
- Tauri 托盘助手保留为历史实验，不再作为正式客户端实施路径。

本批范围：

- 新增 Electron 方案设计与实施计划：
  - `docs/plans/2026-06-19-electron-client-server-design.md`
  - `docs/plans/2026-06-19-electron-client-server-implementation-plan.md`
- 新增前端服务端地址配置：
  - `src/client/clientConfig.ts`
  - `src/client/pages/ServerConnectionPage.tsx`
- 改造 API URL：
  - Web 模式继续使用相对 `/api`。
  - Electron 模式使用保存的 `http://服务器IP:8080`。
  - 原始 PDF、签后 PDF、签名图片、CSV 下载都走统一 URL 拼接。
- 新增 Electron 子应用：
  - `apps/desktop-client/main.cjs`
  - `apps/desktop-client/preload.cjs`
  - `apps/desktop-client/desktopConfig.cjs`
  - `apps/desktop-client/package.json`
- 根项目新增脚本：
  - `npm run desktop:test`
  - `npm run desktop:build`
  - `npm run desktop:dev`
- 安装 Electron dev dependency。

已执行验证：

```powershell
npm run desktop:test
```

结果：

- `apps/desktop-client` 2 个测试文件通过。
- 7 个测试通过。

```powershell
npm test
```

结果：

- 52 个测试文件通过。
- 260 个测试通过。

```powershell
npm run build
```

结果：

- `tsc && vite build` 通过。
- `dist/client` 生产前端已生成。

```powershell
npm run desktop:build
```

结果：

- 先执行 `npm run build` 通过。
- 再执行 `npm run desktop:test` 通过。

Electron 二进制处理：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules\electron\install.js
node_modules\.bin\electron.cmd --version
```

结果：

- Electron 二进制已下载到 `node_modules\electron\dist\electron.exe`。
- Electron 版本：`v42.4.1`。

短暂启动冒烟：

```powershell
$electron = (Resolve-Path '.\node_modules\electron\dist\electron.exe').Path
$proc = Start-Process -FilePath $electron -ArgumentList 'apps/desktop-client' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5
$exited = $proc.HasExited
if (-not $exited) { Stop-Process -Id $proc.Id -Force }
```

结果：

- Electron 主进程启动后 5 秒内未异常退出。
- 测试结束后已停止进程。
- 检查无本次测试残留 Electron 进程。

当前限制：

- 本批已完成开发启动级 Electron 客户端，不包含安装包打包。
- 安装包制作可在后续引入 `electron-builder` 或同类工具。

## 2026-06-19 V5.8 Electron 便携客户端打包

本批范围：

- 新增便携打包脚本：`scripts/desktopPackage.mjs`。
- 新增打包布局测试：`apps/desktop-client/packageLayout.test.mjs`。
- 根项目新增命令：`npm run desktop:package`。
- 更新 Electron 客户端用户和管理员文档。

输出形态：

```text
dist\desktop-client\PDF图纸审批客户端
```

启动文件：

```text
dist\desktop-client\PDF图纸审批客户端\PDF图纸审批客户端.exe
```

验证：

```powershell
npm run desktop:test
```

结果：

- `apps/desktop-client` 3 个测试文件通过。
- 8 个测试通过。

```powershell
npm run desktop:package
```

结果：

- `npm run build` 通过。
- `npm run desktop:test` 通过。
- 便携客户端目录生成成功。

便携版短启动冒烟：

```powershell
.\dist\desktop-client\PDF图纸审批客户端\PDF图纸审批客户端.exe
```

结果：

- 进程启动 5 秒内未异常退出。
- 测试结束后已停止进程。
- 检查无本次测试残留便携客户端进程。

当前限制：

- 便携版需要复制整个 `PDF图纸审批客户端` 文件夹，不能只复制 exe。
- 还没有安装向导、开始菜单快捷方式和自动升级。

## 2026-06-19 V5.9 服务端发布包

本批范围：

- 新增服务端发布包脚本：`scripts/serverPackage.mjs`。
- 新增服务端包布局测试：`src/server/serverPackage.test.ts`。
- 根项目新增命令：`npm run server:package`。
- 更新部署说明和 Electron 管理员说明。

输出形态：

```text
dist\server-package\PDF图纸审批服务端
```

包内包含：

- `src/server` 服务端源码。
- `dist/client` 网页备用入口。
- `scripts/start-server.ps1`、`scripts/install-startup-task.ps1`、`scripts/backup-database.ps1`。
- `data`、`backups`、`logs` 空目录。
- 精简 `package.json`。
- `部署说明.txt`。

包内不包含：

- `node_modules`。
- Electron 运行时。
- React/Vite/Electron 等前端或客户端开发依赖。
- 根项目 `package-lock.json`。

验证：

```powershell
npm run server:package
```

结果：

- `npm run build` 通过。
- `src/server/serverPackage.test.ts` 通过。
- 服务端发布包目录生成成功。
- 关键文件存在：`src/server/index.ts`、`dist/client/index.html`、`scripts/start-server.ps1`、`部署说明.txt`。
- `node_modules` 和 `package-lock.json` 未复制。

当前限制：

- 服务端发布包目标电脑仍需安装 Node.js。
- 首次部署需在包目录执行 `npm install --omit=dev`。

## 2026-06-19 V5.10 服务端免 Node exe 打包

范围：

- 新增 Electron 服务端壳：`apps/server-exe`。
- 新增服务端启动封装：`src/server/startServer.ts`。
- 新增服务端 exe 打包脚本：`scripts/serverExePackage.mjs`。
- 根项目新增命令：`npm run server:exe`。
- 服务端 exe 默认把数据、备份和日志放在发布目录下：
  - `data`
  - `backups`
  - `logs`
- 服务端窗口显示本机地址、局域网地址、数据目录和日志目录。
- 管理端服务日志读取 exe 包内 `logs\server.log` 和 `logs\server.err.log`。

验证：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
.\node_modules\electron\dist\electron.exe -e "console.log(process.versions.node); console.log(typeof require('node:sqlite').DatabaseSync)"
```

结果：

```text
24.16.0
function
```

说明 Electron 自带 Node 运行时支持当前后端使用的 `node:sqlite`。

```powershell
npm test -- --run src/server/serverExePackage.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       2 passed (2)
```

```powershell
npm test -- --run src/server/startServer.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

覆盖：端口被占用时，启动函数会把 `EADDRINUSE` 交给 Electron 服务端窗口显示中文错误提示，而不是形成未处理异常。

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
npm run server:exe
```

结果：

```text
Server exe package created: dist\server-exe\PDF图纸审批服务端
```

输出：

```text
dist\server-exe\PDF图纸审批服务端\PDF图纸审批服务端.exe
```

服务端 exe 冒烟：

```powershell
$env:PORT = '18080'
Start-Process -FilePath 'dist\server-exe\PDF图纸审批服务端\PDF图纸审批服务端.exe'
Invoke-RestMethod http://127.0.0.1:18080/health
```

结果：

```json
{"ok":true}
```

冒烟结束后已停止临时服务端进程，并清空发布目录内由冒烟生成的 `data`、`backups`、`logs` 临时内容。

全量回归：

```powershell
npm test
```

结果：

```text
Test Files  55 passed (55)
Tests       264 passed (264)
```

当前限制：

- 免 Node 版仍需复制整个 `PDF图纸审批服务端` 文件夹，不能只复制 exe。
- 当前先提供便携目录，不包含安装向导、开始菜单快捷方式或自动升级。

## 2026-06-20 V5.11 服务端控制台与端口设置

范围：

- 服务端 exe 窗口从简单状态页调整为部署控制台：
  - 服务状态。
  - 当前端口。
  - 本机地址。
  - 局域网地址。
  - 启动设置。
  - 数据目录、备份目录、日志目录。
- 新增 `server-config.json` 端口配置。
- 服务端窗口支持：
  - 保存端口。
  - 保存并重启。
  - 打开本机工作台。
  - 打开局域网地址。
  - 打开数据、备份、日志目录。
- `PORT` 环境变量仍保留最高优先级，用于高级部署或临时覆盖。

聚焦测试：

```powershell
npm test -- --run src/server/serverExeRuntimeConfig.test.ts src/server/serverExeConsoleView.test.ts src/server/serverExePackage.test.ts src/server/startServer.test.ts
```

结果：

```text
Test Files  4 passed (4)
Tests       9 passed (9)
```

CJS 语法检查：

```powershell
node --check apps\server-exe\main.cjs
node --check apps\server-exe\serverConsoleView.cjs
node --check apps\server-exe\serverRuntimeConfig.cjs
node --check apps\server-exe\preload.cjs
```

结果：全部通过。

全量回归：

```powershell
npm test
```

结果：

```text
Test Files  57 passed (57)
Tests       270 passed (270)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

服务端 exe 打包：

```powershell
npm run server:exe
```

结果：

```text
Server exe package created: dist\server-exe\PDF图纸审批服务端
```

配置端口冒烟：

```powershell
Set-Content dist\server-exe\PDF图纸审批服务端\server-config.json '{"port":18082}'
Start-Process dist\server-exe\PDF图纸审批服务端\PDF图纸审批服务端.exe
Invoke-RestMethod http://127.0.0.1:18082/health
```

结果：

```json
{"ok":true}
```

冒烟结束后已停止临时服务端进程，并清空发布目录内由冒烟生成的 `server-config.json`、`data`、`backups`、`logs` 临时内容。

说明：

- 本机未安装 Playwright，尝试使用 Electron 自身生成截图未稳定产出文件，未把截图作为最终验收依据。
- UI 验证以 `serverExeConsoleView.test.ts` 的静态渲染断言、CJS 语法检查和服务端 exe 启动冒烟为准。

## 2026-06-20 V5.12 Windows NSIS 安装包

范围：

- 新增 `electron-builder` 作为安装包生成工具。
- 新增 `scripts/windowsInstallers.mjs`，基于已有便携客户端和服务端 exe 目录生成 NSIS 安装包。
- 新增安装包配置测试 `src/server/windowsInstallers.test.ts`。
- 根项目新增命令：
  - `npm run installer:test`
  - `npm run installer:package`
- 安装包缓存固定在项目目录 `.cache\electron-builder`，避免把构建缓存放到 C 盘。
- 服务端和客户端仍保持分离部署：
  - 服务端安装到审批服务器电脑。
  - 客户端安装到设计师、主管、工艺等使用者电脑。

依赖安装：

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.cache\npm')
$env:ELECTRON_BUILDER_CACHE=(Join-Path (Get-Location) '.cache\electron-builder')
npm install -D electron-builder --registry=https://registry.npmmirror.com
```

聚焦测试：

```powershell
npm test -- --run src/server/windowsInstallers.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

安装包生成：

```powershell
$env:ELECTRON_BUILDER_CACHE=(Join-Path (Get-Location) '.cache\electron-builder')
npm run installer:package
```

输出：

```text
dist\installers\client\PDF图纸审批客户端-安装包-0.1.0.exe
dist\installers\server\PDF图纸审批服务端-安装包-0.1.0.exe
```

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  58 passed (58)
Tests       273 passed (273)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
$env:ELECTRON_BUILDER_CACHE=(Join-Path (Get-Location) '.cache\electron-builder')
npm run installer:package
```

结果：

```text
Desktop client package created: dist\desktop-client\PDF图纸审批客户端
Server exe package created: dist\server-exe\PDF图纸审批服务端
Client installer output: dist\installers\client
Server installer output: dist\installers\server
```

产物检查：

```text
dist\installers\client\PDF图纸审批客户端-安装包-0.1.0.exe   102246243 bytes
dist\installers\server\PDF图纸审批服务端-安装包-0.1.0.exe   102790298 bytes
```

签名检查：

```powershell
Get-AuthenticodeSignature dist\installers\client\PDF图纸审批客户端-安装包-0.1.0.exe
Get-AuthenticodeSignature dist\installers\server\PDF图纸审批服务端-安装包-0.1.0.exe
```

结果：两个安装包状态均为 `NotSigned`。

当前限制：

- 安装包为 NSIS exe，不是 MSI。
- 服务端安装包安装的是可双击启动的服务端程序，不注册 Windows Service。
- 当前安装包未配置企业代码签名；首次运行可能出现 Windows SmartScreen 提示。
- 当前未配置正式产品图标，Electron Builder 会使用默认图标。

## 2026-06-22 V5.13 全量检查、角色向导与旧打印角色移除

范围：

- 登录后新增按角色区分的流程向导，覆盖设计师、主管、工艺、管理员。
- 当前业务流程移除旧 `printer` 打印角色：默认账号不再创建打印账号，用户管理不再暴露打印角色，旧打印账号无法登录或出现在用户列表。
- 数据库 `users.role` 的历史 CHECK 暂不破坏性迁移，保留 `printer` 仅用于旧数据兼容和回归测试。
- 批量上传时的已有版本查询改为按项目和零件名去重，并增加短防抖，避免一次上传多张同零件图纸时重复请求。
- 全部图纸列表增加旧请求保护，切换筛选时旧响应不会覆盖新列表。
- 角色流程向导步骤标签使用标准控件圆角，避免重新引入胶囊形 `999px` 圆角。
- 升级 `nodemailer` 到 `^9.0.1`，处理生产依赖安全审计问题。

聚焦验证：

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       11 passed (11)
```

```powershell
npm test -- --run src/client/pages/approvalsPageLayout.test.ts src/client/pages/approvalListLogic.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       9 passed (9)
```

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts src/client/pages/approvalsPageLayout.test.ts src/client/roleGuide.test.ts src/client/widgets/RoleFlowGuide.test.ts src/server/routes/users.test.ts src/server/auth.test.ts src/server/notifications/email.test.ts
```

结果：

```text
Test Files  7 passed (7)
Tests       26 passed (26)
```

构建验证：

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

安全审计：

```powershell
$env:npm_config_cache=(Join-Path (Get-Location) '.cache\npm')
npm audit --omit=dev --audit-level=moderate --registry=https://registry.npmjs.org
```

结果：

```text
found 0 vulnerabilities
```

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  61 passed (61)
Tests       280 passed (280)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

```powershell
npm run desktop:test
```

结果：

```text
Test Files  3 passed (3)
Tests       8 passed (8)
```

## 2026-06-22 V6.1 批注体验优化验证

范围：

- 右侧批注列表点击后选中批注，并让左侧 PDF 预览滚动到对应标记。
- 批注标记增加稳定的 `data-annotation-id`，用于列表和 PDF 层定位。
- 新增设计师只读、归档/作废只读、空批注和保存失败的中文提示。
- 更新 Windows 局域网部署说明、Electron 客户端用户说明和管理员说明，明确审查版 PDF 带批注、正式签后 PDF 保持干净。

聚焦验证：

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       9 passed (9)
```

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/styles.test.ts src/server/pdf/annotatePdf.test.ts src/server/routes/approvalAnnotations.test.ts
```

结果：

```text
Test Files  5 passed (5)
Tests       40 passed (40)
```

文档检索：

```powershell
rg -n "V6.1|画笔|云线|批注|审查版 PDF|签后 PDF" docs
```

结果：可在部署说明、客户端用户说明和客户端管理员说明中检索到 V6.1 批注说明。

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  70 passed (70)
Tests       360 passed (360)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

说明：

- 构建仍有既有的 PDF 相关 chunk 超过 500 kB 提醒，本批未新增该风险。
- 本批未启动开发服务做人工浏览器烟测；批注创建、编辑、权限、审查版 PDF 导出和签后 PDF 生成边界由自动化测试覆盖。

## 2026-06-23 个人资料、通知偏好与遗漏检查验证

范围：

- 检查个人资料、常用项目和角色通知偏好的实现链路。
- 修复非管理员未配置签名时无法进入“我的资料”的遗漏。
- 修复管理员删除图纸入口不可达的问题：管理员可进入“全部图纸”做台账维护和删除，但仍不显示上传、签名入口；“全部图纸”批量签后 PDF 和打印归档操作保持设计师口径。
- 同步更新 profile/通知偏好设计文档中的管理员导航说明。

聚焦验证：

```powershell
npm test -- --run src/client/roleAccess.test.ts src/client/pages/approvalsPageLayout.test.ts src/client/appRouting.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       12 passed (12)
```

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  75 passed (75)
Tests       393 passed (393)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

说明：

- 构建仍有既有的 PDF 相关 chunk 超过 500 kB 提醒，本次未新增该风险。
- 本次未启动浏览器做人工烟测；资料页、权限路由、通知服务、提交页常用项目和管理员删除入口由自动化测试覆盖。

## 2026-06-23 管理员个人资料常用项目收口验证

范围：

- 管理员“我的资料”不显示常用项目区块。
- `/api/profile` 对管理员固定返回空 `commonProjects`，并在保存资料时忽略并清空管理员提交的 `commonProjects`。
- 设计师、主管、工艺仍可维护常用项目，设计师提交页继续使用常用项目快捷入口。
- 同步更新个人资料与通知偏好设计文档。

TDD 红灯验证：

```powershell
npm test -- --run src/server/routes/profile.test.ts src/client/pages/ProfilePage.test.ts
```

结果：新增测试先失败，失败点为前端缺少角色判断函数、后端管理员保存后返回 `["项目A"]`。

聚焦验证：

```powershell
npm test -- --run src/server/routes/profile.test.ts src/client/pages/ProfilePage.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       6 passed (6)
```

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  75 passed (75)
Tests       394 passed (394)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

说明：

- 构建仍有既有的 PDF 相关 chunk 超过 500 kB 提醒，本次未新增该风险。
- 静态检查发现 `systemRisk` 已有偏好项和收件人规则，但尚未看到真实触发调用，建议作为下一批通知增强项处理。

## 2026-06-23 运维通知、分页、PDF 懒加载与清理策略验证

范围：

- 补齐 `systemRisk` 邮件触发：手动扫描、数据库备份后按管理员偏好发送系统风险邮件，并写入系统通知日志。
- 增加“给自己发送测试邮件”，便于用户验证个人邮箱与 SMTP 配置。
- “全部图纸”改为服务端分页与关键词检索，避免图纸量增长后前端一次性加载过重。
- PDF 预览、签名定位、批注工作区改为动态加载，降低普通页面入口包体积。
- 增加清理维护：临时上传、失败/部分失败批量提交记录、未被当前记录引用的旧签审 PDF，支持预览后执行。
- 修复构建暴露的 `clampPageSize` 类型收窄问题，避免 `number | undefined` 传入 `Math.trunc`。

聚焦验证：

```powershell
npm test -- --run src/server/notifications/systemRiskNotifications.test.ts src/server/routes/profile.test.ts src/server/routes/system.test.ts
npm test -- --run src/client/api.test.ts src/client/pages/ProfilePage.test.ts
npm test -- --run src/server/repositories/approvals.test.ts src/server/routes/approvals.test.ts src/client/api.test.ts
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/pages/submitDrawingLayout.test.ts
npm test -- --run src/server/repositories/batchSubmissions.test.ts src/server/services/cleanupService.test.ts src/server/routes/system.test.ts
npm test -- --run src/client/api.test.ts src/client/pages/settingsDiagnostics.test.ts
```

结果：上述聚焦测试均通过。

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  77 passed (77)
Tests       404 passed (404)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

说明：

- 普通入口包为 `assets/index-DAjO3J9S.js`，约 `326.38 kB`；PDF 工作区已拆出 `PdfSignaturePlacementWorkspace` 和 `PdfAnnotationWorkspace` 异步 chunk。
- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB，这是 PDF 库相关异步 chunk，普通页面不再同步加载。
- 本批未启动浏览器做人工烟测；系统风险邮件、分页接口、清理接口、资料页测试邮件和 PDF 懒加载由自动化测试与构建覆盖。

## 2026-06-23 侧边栏图标化与 Logo 视觉优化验证

范围：

- 菜单栏增加路由图标，展开状态显示“图标 + 文案”。
- 侧栏收起状态改为 72px 图标窄栏，只显示 Logo、导航图标、收起/展开按钮和退出图标。
- 应用 Logo 改为复用打包图标 `src/client/public/app-icon.png`。
- 保持原有路由、权限和侧栏收起状态本地存储逻辑不变。

聚焦验证：

```powershell
npm test -- --run src/client/appLayout.test.ts src/client/styles.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       12 passed (12)
```

最终回归：

```powershell
npm test
```

结果：

```text
Test Files  77 passed (77)
Tests       404 passed (404)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build
✓ built
```

说明：

- 构建仍提示既有 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB，属于 PDF 异步 chunk；本次侧栏改造未新增该类风险。
- 本批未启动浏览器做人工烟测；侧栏结构和关键 CSS 行为由源级测试覆盖。

## 2026-06-23 批注回退到初始版验证

范围：

- 新增 `POST /api/approvals/:id/annotations/reset`，主管、工艺、管理员可清空当前图纸批注。
- 设计师禁止回退批注；已归档或作废图纸返回只读错误。
- 回退只删除批注记录，不修改原始 PDF 和签后 PDF；审查版 PDF 继续按当前批注动态生成。
- 回退操作写入操作日志 `approval.annotations_reset`，记录删除数量。
- 审批详情页在“审查版 PDF”旁增加“回退到初始版”，执行前二次确认，完成后刷新批注和操作日志。

红灯验证：

```powershell
npm test -- --run src/server/routes/approvalAnnotations.test.ts
npm test -- --run src/client/api.test.ts src/client/pages/approvalDetailLayout.test.ts
```

结果：

```text
后端新增 reset 测试最初因接口不存在返回 404。
前端新增 reset 测试最初因 resetApprovalAnnotations 和页面入口不存在失败。
```

聚焦验证：

```powershell
npm test -- --run src/server/routes/approvalAnnotations.test.ts src/client/api.test.ts src/client/pages/approvalDetailLayout.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       40 passed (40)
```

最终回归：

```powershell
npm run build
npm test
```

结果：

```text
npm run build: tsc && vite build 通过，仍保留既有 PDF 异步 chunk 超过 500 kB 提示。
npm test: Test Files 77 passed (77), Tests 408 passed (408)
```

说明：

- 构建过程中发现 `node:sqlite` 的 `changes` 类型可能为 `number | bigint`，已显式转为 `number` 后通过构建。
- 本批未启动浏览器做人工烟测；接口权限、删除数量、操作日志、前端 API 路径和详情页入口由自动化测试覆盖。

## 2026-06-23 V7 质量、审图效率与部署排障验证

范围：

- 新增 `/health` 安全版本信息和 API 兼容版本。
- 客户端新增连接自检，提示 `127.0.0.1`、地址格式和版本兼容问题。
- 服务端 exe 控制台强化局域网地址展示和“复制客户端地址”。
- 增加审批列表长期使用索引。
- PDF 预览增加适高、页码跳转和更稳定的缩放/拖动控制。
- 批注列表增加筛选和连续标注。
- 运维追溯新增自动维护计划和备份目录校验。
- 拆分审批详情右侧面板和设置页运维 Tab，降低单文件维护压力。
- 更新 Windows 局域网部署、Electron 管理员和客户端用户文档。

聚焦验证：

```powershell
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       9 passed (9)
```

全量回归：

```powershell
npm test
```

结果：

```text
Test Files  84 passed (84)
Tests       441 passed (441)
```

```powershell
npm run build
```

结果：

```text
tsc && vite build 通过。
```

说明：构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是既有 PDF 库异步 chunk，普通入口包约 `342.48 kB`，PDF 批注和签名定位工作区仍为异步加载。

桌面客户端和安装包验证：

```powershell
npm run desktop:test
npm run installer:test
$env:ELECTRON_BUILDER_CACHE=(Join-Path (Get-Location) '.cache\electron-builder')
npm run installer:package
```

结果：

```text
desktop:test: Test Files  3 passed (3), Tests  8 passed (8)
installer:test: Test Files  1 passed (1), Tests  3 passed (3)
installer:package: 客户端与服务端 NSIS 安装包生成成功
```

安装包输出：

```text
dist\installers\client\PDF图纸审批客户端-安装包-0.1.0.exe  102473962 bytes
dist\installers\server\PDF图纸审批服务端-安装包-0.1.0.exe  103351608 bytes
```

签名检查：

```powershell
Get-AuthenticodeSignature dist\installers\client\PDF图纸审批客户端-安装包-0.1.0.exe
Get-AuthenticodeSignature dist\installers\server\PDF图纸审批服务端-安装包-0.1.0.exe
```

结果：两个安装包状态均为 `NotSigned`。当前仍需按内部软件分发方式说明来源，或后续接入企业代码签名证书。

本地开发服务重启：

```powershell
npm run dev
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173
```

结果：

```text
后端: http://127.0.0.1:8080/health -> ok
前端: http://127.0.0.1:5173 -> HTTP 200
```

当前限制：

- 本次未做真实坚果云现场上传/删除烟测，文件监听路径仍建议上线前用现场目录做一次真实 PDF 提交和删除验证。
- 本次未连接真实 SMTP 发送外部邮件；邮件链路由自动化测试和页面“发送测试邮件”入口覆盖。
- 安装包未代码签名，Windows 可能显示安全提醒。

## 2026-06-23 V7 无遗留打磨验证

范围：

- PDF 批注工作区和签名定位工作区新增横向缩略页导航，保留页码输入、上一页/下一页、滚轮缩放和拖动平移。
- 管理员“运维追溯”新增维护执行结果看板，汇总最近一次自动备份、自动清理和备份校验状态。
- `/health` 在非测试运行时自动返回服务端非回环 IPv4 局域网地址。

红灯验证：

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/widgets/PdfSignaturePlacementWorkspace.test.ts src/client/pages/settingsDiagnostics.test.ts src/server/server.test.ts src/client/styles.test.ts
```

结果：

```text
初始失败点为缺少 .pdf-page-thumbnails、buildMaintenanceRunSummary、维护执行结果文案、getLanIPv4Addresses 和缩略页样式。
```

聚焦验证：

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/widgets/PdfSignaturePlacementWorkspace.test.ts src/client/pages/settingsDiagnostics.test.ts src/server/server.test.ts src/client/styles.test.ts
```

结果：

```text
Test Files  5 passed (5)
Tests       44 passed (44)
```

全量回归：

```powershell
npm test
```

结果：

```text
Test Files  84 passed (84)
Tests       444 passed (444)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build 通过。
```

说明：构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是既有 PDF 库异步 chunk；本次缩略页导航没有引入新的 PDF 渲染依赖。

本地开发服务重启：

```powershell
npm run dev
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173
```

结果：

```text
后端: http://127.0.0.1:8080/health -> ok，lanUrls 返回 172.30.255.69 和 192.168.0.62 两个局域网地址。
前端: http://127.0.0.1:5173 -> HTTP 200
```

## 2026-06-23 移动端适配验证

范围：

- 520px 以下移动端断点：应用壳层切换为单列，侧边栏变为顶部 sticky 导航，菜单横向滚动。
- 审批列表表格在手机宽度下转为卡片列表，通过单元格 `data-label` 显示字段名。
- 工具栏、筛选表单、分页、批量操作按钮在窄屏下改为更适合触控的纵向布局。
- PDF 预览、签名定位工作区、批注工具栏和浮窗在手机宽度下限制高度和宽度，避免被屏幕裁切。
- 管理员运维日志继续保持独立滚动面板，避免长日志把页面无限撑开。

聚焦验证：

```powershell
npm test -- --run src/client/styles.test.ts src/client/widgets/ApprovalTable.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       15 passed (15)
```

全量回归：

```powershell
npm test
```

结果：

```text
Test Files  84 passed (84)
Tests       447 passed (447)
```

生产构建：

```powershell
npm run build
```

结果：

```text
tsc && vite build 通过。
```

说明：构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是既有 PDF 库异步 chunk 体积提示，本次移动端适配未新增 PDF 依赖。

390px 真机宽度冒烟：

```text
审批页: innerWidth=390, docScrollWidth=390, bodyScrollWidth=390, overflowX=0。
运维页: innerWidth=390, docScrollWidth=390, bodyScrollWidth=390, overflowX=0。
侧边栏: position=sticky, width=390, height=188。
菜单栏: display=flex, overflow-x=auto。
审批列表: table display=block, row display=grid, cell grid-template-columns=82px 230px。
运维日志: operation-log-panel .table-surface overflow=auto。
```

截图：

```text
output/playwright/mobile-approvals-fresh.png
output/playwright/mobile-settings-operations-fresh.png
```

## 2026-06-23 v0.8.0 安装包与更新清单验证

范围：

- 版本号统一提升到 `0.8.0`。
- 客户端和服务端重新生成 Windows 安装包。
- 生成局域网更新清单 `dist/updates/latest.json` 和随包更新日志 `dist/updates/CHANGELOG.md`。
- 管理员端可配置 `update_manifest_url` 并检查更新清单。

验证命令：

```powershell
npm test
npm run build
npm run installer:package
Get-AuthenticodeSignature -LiteralPath 'dist\installers\client\PDF图纸审批客户端-安装包-0.8.0.exe','dist\installers\server\PDF图纸审批服务端-安装包-0.8.0.exe'
```

结果：

```text
npm test: 87 个测试文件，454 个测试通过。
npm run build: tsc 与 Vite 生产构建通过。
npm run installer:package: 客户端安装包、服务端安装包和更新清单生成成功。
客户端安装包: dist\installers\client\PDF图纸审批客户端-安装包-0.8.0.exe，约 102.48 MB。
服务端安装包: dist\installers\server\PDF图纸审批服务端-安装包-0.8.0.exe，约 103.36 MB。
更新清单: dist\updates\latest.json。
更新日志: dist\updates\CHANGELOG.md。
签名状态: 两个安装包均为 NotSigned，当前未配置代码签名证书。
```

## 2026-06-23 v0.8.5 服务端统一更新配置验证

范围：

- 版本号统一提升到 `0.8.5`。
- 更新清单地址改为服务端按当前请求 Host 自动推导 `/updates/latest.json`。
- 管理端“目录与通知”不再展示或保存 `update_manifest_url`。
- 旧数据库中的 `update_manifest_url` 不再覆盖服务端默认更新源。
- 服务端窗口新增“更新发布”信息，显示更新目录和可复制的清单地址。
- 重新生成客户端和服务端安装包，并同步到真实运行目录 `E:\PDF服务端\pdf-approval\releases`。

验证命令：

```powershell
npm test -- --run src/server/routes/system.test.ts src/client/pages/settingsDiagnostics.test.ts src/server/serverExeConsoleView.test.ts src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts
npm run build
npm test
npm run desktop:test
npm run installer:package
Get-Content -Raw 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Get-Item 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.5.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.5.exe'
Get-AuthenticodeSignature -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.5.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.5.exe'
```

结果：

```text
聚焦测试: 5 个测试文件，31 个测试通过。
npm run build: tsc 与 Vite 生产构建通过。
npm test: 88 个测试文件，462 个测试通过。
npm run desktop:test: 3 个测试文件，8 个测试通过。
npm run installer:package: 0.8.5 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.5。
运行目录客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.5.exe，102475315 bytes。
运行目录服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.5.exe，103355870 bytes。
签名状态: 两个安装包均为 NotSigned，当前未配置企业代码签名证书。
git status: 当前目录不是 Git 仓库，无法读取工作树差异。
```

说明：

- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是 PDF 预览依赖 chunk 的体积提示，未阻断构建或安装包生成。
- 在线更新仍是“检查并下载安装包”，不会静默安装。

## 2026-06-23 v0.8.4 服务端安装器二次自检测修复验证

范围：

- 版本号统一提升到 `0.8.4`。
- 继续修复服务端安装器从 `releases\installers\server` 目录运行时提示“无法关闭”的问题。
- 自定义 NSIS 检测目标从 `${APP_EXECUTABLE_FILENAME}` 改为明确的 `${PRODUCT_NAME}.exe`。

根因补充：

```text
0.8.3 已绕开默认的“安装目录前缀”检测，但仍使用 NSIS 模板变量 APP_EXECUTABLE_FILENAME。
在安装器上下文中该变量存在歧义，仍可能匹配安装包自身。
0.8.4 改为 PRODUCT_NAME.exe，对本项目等价于 PDF图纸审批服务端.exe / PDF图纸审批客户端.exe，只匹配真正运行的应用进程。
```

验证命令：

```powershell
npm test -- --run src/server/windowsInstallers.test.ts src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts
npm run installer:package
npm test
Get-Content -LiteralPath 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Get-AuthenticodeSignature -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.4.exe','E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.4.exe'
```

结果：

```text
聚焦测试: 3 个测试文件，8 个测试通过。
npm run installer:package: 0.8.4 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
npm test: 88 个测试文件，461 个测试通过。
服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.4.exe，103355435 bytes。
客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.4.exe，102475344 bytes。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.4。
签名状态: 两个安装包均为 NotSigned，当前未配置代码签名证书。
```

说明：

- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是 PDF 预览依赖 chunk 的体积提示，未阻断构建或安装包生成。
- 当前更新能力采用局域网 `latest.json` 清单检查和下载链接展示，不做静默自动替换，避免未确认的外部更新服务或证书依赖。

## 2026-06-23 v0.8.1 服务端内置更新目录验证

范围：

- 版本号统一提升到 `0.8.1`。
- 服务端直接托管 `releaseDir\updates` 和 `releaseDir\installers`，默认开发环境为 `dist`。
- 服务端 exe 启动时创建 `releases\updates`、`releases\installers\client`、`releases\installers\server`。
- 服务端窗口显示“更新”目录并支持打开。
- 重新生成客户端和服务端安装包。

验证命令：

```powershell
npm test -- --run src/server/server.test.ts src/server/serverExePackage.test.ts src/server/serverExeConsoleView.test.ts src/server/releaseVersion.test.ts src/server/updateManifestPackage.test.ts src/server/services/updateInfo.test.ts src/server/routes/system.test.ts
npm run build
npm run installer:package
npm test
```

结果：

```text
聚焦测试: 7 个测试文件，26 个测试通过。
npm run build: tsc 与 Vite 生产构建通过。
npm run installer:package: 0.8.1 客户端安装包、服务端安装包和更新清单生成成功。
npm test: 87 个测试文件，455 个测试通过。
HTTP 冒烟: /updates/latest.json 返回 200，version=0.8.1；/installers/client/PDF图纸审批客户端-安装包-0.8.1.exe 返回 200。
客户端安装包: dist\installers\client\PDF图纸审批客户端-安装包-0.8.1.exe，约 102.48 MB。
服务端安装包: dist\installers\server\PDF图纸审批服务端-安装包-0.8.1.exe，约 103.36 MB。
签名状态: 两个安装包均为 NotSigned，当前未配置代码签名证书。
```

说明：

- 在线更新仍是“检查新版并下载新版安装包”，不会静默自动替换正在运行的客户端。
- 正式部署后，将 `latest.json`、`CHANGELOG.md` 和两个安装包放入服务端窗口显示的“更新”目录，再将更新清单地址配置为 `http://服务器IP:端口/updates/latest.json`。

## 2026-06-23 v0.8.2 普通用户自动检查客户端更新验证

范围：

- 版本号统一提升到 `0.8.2`。
- 普通用户登录后自动请求 `/api/system/client-update-info` 检查客户端新版本。
- 非管理员更新接口只返回客户端安装包下载入口，不暴露服务端安装包。
- `npm run installer:package` 默认同步更新清单和安装包到真实运行目录 `E:\PDF服务端\pdf-approval\releases`。

验证命令：

```powershell
npm test -- --run src/server/routes/system.test.ts src/client/api.test.ts src/client/appLayout.test.ts src/server/runtimeReleaseSync.test.ts src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts
npm run build
npm run installer:package
npm test
Get-ChildItem -LiteralPath 'dist\installers\client','dist\installers\server','dist\updates' -File | Where-Object { $_.Name -match '0\.8\.2|latest|CHANGELOG' }
Get-ChildItem -LiteralPath 'E:\PDF服务端\pdf-approval\releases' -Recurse -File | Where-Object { $_.Name -match '0\.8\.2|latest|CHANGELOG' }
Get-Content -LiteralPath 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Get-AuthenticodeSignature -LiteralPath 'dist\installers\client\PDF图纸审批客户端-安装包-0.8.2.exe','dist\installers\server\PDF图纸审批服务端-安装包-0.8.2.exe'
```

结果：

```text
聚焦测试: 6 个测试文件，45 个测试通过。
npm run build: tsc 与 Vite 生产构建通过。
npm run installer:package: 0.8.2 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
npm test: 88 个测试文件，460 个测试通过。
客户端安装包: dist\installers\client\PDF图纸审批客户端-安装包-0.8.2.exe，102477137 bytes。
服务端安装包: dist\installers\server\PDF图纸审批服务端-安装包-0.8.2.exe，103357088 bytes。
运行目录客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.2.exe。
运行目录服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.2.exe。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.2。
签名状态: 两个安装包均为 NotSigned，当前未配置代码签名证书。
```

说明：

- 本机 `127.0.0.1:8080` 当前未监听，HTTP 冒烟未执行；真实运行目录文件已同步，服务端启动后会按 `/updates/latest.json` 和 `/installers/...` 对外提供下载。
- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是 PDF 预览依赖 chunk 的体积提示，未阻断构建或安装包生成。
- 在线更新能力仍是“自动检查 + 下载客户端安装包”，不会静默自动安装。

## 2026-06-23 v0.8.3 服务端安装器自检测误判修复验证

范围：

- 版本号统一提升到 `0.8.3`。
- 修复从 `E:\PDF服务端\pdf-approval\releases\installers\server` 运行服务端安装包时，NSIS 把安装器自身误判为旧服务端进程的问题。
- 新增自定义 `build\installer.nsh`，安装器只按精确 exe 名称检测 `PDF图纸审批服务端.exe` 或 `PDF图纸审批客户端.exe`。
- 重新生成客户端和服务端安装包，并同步到真实运行目录 `E:\PDF服务端\pdf-approval\releases`。

根因：

```text
electron-builder 默认 NSIS 检测逻辑在 PowerShell 可用时会检查所有 ExecutablePath 以 $INSTDIR 开头的进程。
用户从 E:\PDF服务端\pdf-approval\releases\installers\server 启动安装包时，安装器进程路径也以 $INSTDIR 开头。
因此安装器把自身当成待关闭的旧服务端应用，弹出“PDF图纸审批服务端 无法关闭”。
```

验证命令：

```powershell
npm test -- --run src/server/windowsInstallers.test.ts src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts
npm run installer:package
npm test
Get-ChildItem -LiteralPath 'E:\PDF服务端\pdf-approval\releases' -Recurse -File | Where-Object { $_.Name -match '0\.8\.3|latest|CHANGELOG' }
Get-Content -LiteralPath 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Get-AuthenticodeSignature -LiteralPath 'dist\installers\client\PDF图纸审批客户端-安装包-0.8.3.exe','dist\installers\server\PDF图纸审批服务端-安装包-0.8.3.exe'
```

结果：

```text
聚焦测试: 3 个测试文件，8 个测试通过。
npm run installer:package: 0.8.3 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
npm test: 88 个测试文件，461 个测试通过。
客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.3.exe，102475300 bytes。
服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.3.exe，103355399 bytes。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.3。
签名状态: 两个安装包均为 NotSigned，当前未配置代码签名证书。
```

## 2026-06-24 v0.8.6 性能与体验打磨验证

范围：

- 版本号统一提升到 `0.8.6`。
- 业务页面改为路由级懒加载，侧边栏 hover/focus 预加载目标页面。
- 全量图纸台账搜索增加输入防抖、`useDeferredValue` 和刷新反馈。
- 详情页减少不必要 PDF 状态复查，PDF 检查失败时提供重试入口。
- 长列表、风险行、批量历史、批注项和操作日志表格增加 `content-visibility` 渲染优化。
- 服务端新增慢 API 请求日志，阈值由 `PDF_APPROVAL_SLOW_REQUEST_MS` 控制，日志不记录请求体。
- 新增操作日志时间线和管理员日志排序索引。
- 重新生成客户端和服务端安装包，并同步到真实运行目录 `E:\PDF服务端\pdf-approval\releases`。

验证命令：

```powershell
npm test -- --run src/client/appLayout.test.ts src/client/pages/approvalListLogic.test.ts src/client/pages/approvalDetailLogic.test.ts src/client/styles.test.ts src/client/pages/approvalsPageLayout.test.ts src/server/server.test.ts src/server/dbIndexes.test.ts src/server/releaseVersion.test.ts
npm run build
npm test
npm run desktop:test
npm run installer:package
Get-Content -LiteralPath 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Get-ChildItem -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.6.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.6.exe'
Get-AuthenticodeSignature -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.6.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.6.exe'
```

结果：

```text
聚焦测试: 8 个测试文件，59 个测试通过。
npm run build: tsc 与 Vite 生产构建通过；业务页面已拆分为独立页面 chunk，入口 index-B4nNRO3v.js 为 238.33 kB。
npm test: 88 个测试文件，471 个测试通过。
npm run desktop:test: 3 个测试文件，8 个测试通过。
npm run installer:package: 0.8.6 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.6。
运行目录客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.6.exe，102486876 bytes。
运行目录服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.6.exe，103368048 bytes。
签名状态: 两个安装包均为 NotSigned，当前未配置企业代码签名证书。
```

说明：

- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB。这是 PDF.js 预览依赖的独立 chunk，当前已从主入口拆出，未阻断构建或安装包生成。
- 慢请求日志只记录 `method`、不含 query 的 `path`、`status` 和 `durationMs`，不会记录请求体、密码或 token。

补充检查：

```text
2026-06-24 继续收尾时发现当前分发文档仍引用 0.8.5 安装包名，已更新：
- docs/desktop-client-admin-guide.md
- docs/desktop-client-user-guide.md
- docs/deploy-windows-lan.md

文档版本检查: 当前分发文档中不再出现 0.8.5 安装包名，均指向 0.8.6。
补充聚焦测试: 6 个测试文件，30 个测试通过。
```

## 2026-06-24 v0.8.7 服务端升级保留更新目录验证

范围：

- 版本号统一提升到 `0.8.7`。
- 修复服务端重新安装或升级后 `releases` 目录被清空，导致 `/updates/latest.json` 返回 `HTTP_404` 的问题。
- 自定义 NSIS 删除逻辑：升级清理旧应用文件时保留 `data`、`backups`、`logs`、`releases` 和 `server-config.json`。
- 重新生成客户端和服务端安装包，并同步到真实运行目录 `E:\PDF服务端\pdf-approval\releases`。

根因：

```text
服务端安装包升级时会先执行旧版本卸载器。electron-builder 默认卸载逻辑会 RMDir /r $INSTDIR，安装目录里的 releases 也会被删除。
服务端仍然托管 /updates/latest.json，但 releases\updates\latest.json 已不存在，因此返回 HTTP_404。
```

验证命令：

```powershell
npm test -- --run src/server/windowsInstallers.test.ts src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts src/server/server.test.ts src/server/runtimeReleaseSync.test.ts
npm test
npm run installer:package
Get-Content -LiteralPath 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8080/updates/latest.json'
Invoke-WebRequest -UseBasicParsing 'http://192.168.0.62:8080/updates/latest.json'
Get-AuthenticodeSignature -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.7.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.7.exe'
```

结果：

```text
聚焦测试: 5 个测试文件，16 个测试通过。
npm test: 88 个测试文件，472 个测试通过。
npm run installer:package: 0.8.7 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.7。
HTTP 冒烟: http://127.0.0.1:8080/updates/latest.json 返回 200，version=0.8.7。
HTTP 冒烟: http://192.168.0.62:8080/updates/latest.json 返回 200，version=0.8.7。
运行目录客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.7.exe，102487207 bytes。
运行目录服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.7.exe，103368537 bytes。
签名状态: 两个安装包均为 NotSigned，当前未配置企业代码签名证书。
```

说明：

- 本次已直接恢复真实运行目录中的 `latest.json`，所以当前局域网更新检查不再是 404。
- 后续从 `0.8.7` 服务端安装包开始，升级安装会保留 `releases`，不会再因为重装清空更新清单。

## 2026-06-25 v0.8.8 窗口适配正式发布包验证

范围：

- 版本号统一提升到 `0.8.8`。
- 将窗口尺寸变化下的资料页表单、通知偏好和顶部流程向导防挤压修复纳入正式更新包。
- 管理员运维页去掉多余的本机更新日志区块。
- 重新生成客户端和服务端安装包，并同步到真实运行目录 `E:\PDF服务端\pdf-approval\releases`。

验证命令：

```powershell
npm test -- --run src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts src/server/updateManifestPackage.test.ts src/server/runtimeReleaseSync.test.ts src/client/styles.test.ts src/client/pages/settingsDiagnostics.test.ts
npm test
npm run installer:package
Get-Content -LiteralPath 'E:\PDF服务端\pdf-approval\releases\updates\latest.json'
Get-Item -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.8.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.8.exe'
Get-AuthenticodeSignature -LiteralPath 'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.8.exe','E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.8.exe'
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8080/updates/latest.json'
Invoke-WebRequest -UseBasicParsing 'http://192.168.0.62:8080/updates/latest.json'
```

结果：

```text
聚焦测试: 6 个测试文件，32 个测试通过。
npm test: 88 个测试文件，473 个测试通过。
npm run installer:package: 0.8.8 客户端安装包、服务端安装包、更新清单生成成功，并同步到 E:\PDF服务端\pdf-approval\releases。
运行目录更新清单: E:\PDF服务端\pdf-approval\releases\updates\latest.json，version=0.8.8，releaseDate=2026-06-25。
运行目录客户端安装包: E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.8.exe，102487194 bytes。
运行目录服务端安装包: E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.8.exe，103368705 bytes。
签名状态: 两个安装包均为 NotSigned，当前未配置企业代码签名证书。
HTTP 冒烟: 当前 8080 服务未运行，127.0.0.1:8080 和 192.168.0.62:8080 均连接被拒绝；服务端启动或安装 0.8.8 后需复测。
```

说明：

- `latest.json` 已在真实运行目录中更新到 `0.8.8`，服务端启动后会通过 `/updates/latest.json` 对局域网提供新版清单。

## 2026-06-25 v0.8.9 客户端更新检测修复验证

范围：

- 修复只升级服务端后，旧客户端把服务端版本误当成客户端版本，导致不会提示客户端更新的问题。
- 客户端更新检查优先传入 Electron 已安装外壳版本。
- 服务端兼容未传版本的旧 Electron 客户端，按未知旧版处理并继续提示最新客户端安装包。
- 管理员版本更新面板将“当前版本”明确为“服务端当前版本”。

命令：

```powershell
npm test -- --run src/client/api.test.ts src/client/clientConfig.test.ts src/client/appLayout.test.ts src/client/pages/settingsDiagnostics.test.ts src/server/routes/system.test.ts src/server/services/updateInfo.test.ts src/server/releaseVersion.test.ts
npm test
npm run installer:package
```

结果：

- 聚焦测试：7 个测试文件、65 个用例通过。
- 全量测试：88 个测试文件、477 个用例通过。
- `npm run installer:package` 成功，已构建客户端、服务端安装包和更新清单。
- 运行目录更新清单：`E:\PDF服务端\pdf-approval\releases\updates\latest.json`，version=`0.8.9`，releaseDate=`2026-06-25`。
- 运行目录客户端安装包：`E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.8.9.exe`，102487305 bytes。
- 运行目录服务端安装包：`E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.8.9.exe`，103369241 bytes。
- 签名状态：客户端、服务端安装包均为 `NotSigned`，Windows 仍可能显示安全提醒。
- HTTP 冒烟：`http://127.0.0.1:8080/updates/latest.json` 返回 200，version=`0.8.9`。
- HTTP 冒烟：`http://192.168.0.62:8080/updates/latest.json` 返回 200，version=`0.8.9`。
- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB；该 PDF 依赖已是独立 chunk，未阻断构建或安装包生成。

## 2026-06-26 客户端打印并自动归档验证

范围：

- 审批详情页新增“打印并归档”入口，仅在 Electron 客户端、设计师或管理员、已通过待打印且签后 PDF 已生成时显示。
- 打印前支持设置打印机、份数、页码范围、纸张、方向、彩色/黑白、双面、边距、缩放和打印背景。
- Electron 主进程新增打印机列表、打印参数持久化和签后 PDF 原生打印 IPC。
- Windows 打印回调成功后自动调用现有归档接口；取消或失败不归档。
- 浏览器访问保持“打开签后 PDF + 手动标记归档”的兜底方式。

命令：

```powershell
npm test -- --run src/client/printSettings.test.ts
npm run desktop:test -- --run apps/desktop-client/electronShell.test.mjs apps/desktop-client/desktopConfig.test.mjs
npm test -- --run src/client/clientConfig.test.ts src/client/printSettings.test.ts
npm test -- --run src/client/pages/approvalDetailPrint.test.ts
npm test -- --run src/client/printSettings.test.ts src/client/clientConfig.test.ts src/client/pages/approvalDetailPrint.test.ts src/client/pages/approvalDetailLogic.test.ts
npm run desktop:test
npm test
npm run build
```

结果：

- 打印参数聚焦测试：`src/client/printSettings.test.ts` 6 个用例通过。
- Electron 桥接聚焦测试：`electronShell.test.mjs`、`desktopConfig.test.mjs` 共 9 个用例通过。
- 客户端桥接聚焦测试：`src/client/clientConfig.test.ts` 和打印参数测试共 15 个用例通过。
- 审批详情打印逻辑测试：`src/client/pages/approvalDetailPrint.test.ts` 4 个用例通过。
- 前端聚焦回归：4 个测试文件、37 个用例通过。
- `npm run desktop:test`：3 个测试文件、10 个用例通过。
- `npm test`：90 个测试文件、489 个用例通过。
- `npm run build`：TypeScript 和 Vite 构建通过。
- 构建仍提示 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 超过 500 kB；该提示为既有 PDF 依赖体积提示，未阻断构建。

未覆盖项：

- 本次未连接真实打印机做纸张出纸验证。Electron 能确认打印任务被 Windows 打印系统接受，但不能可靠确认打印机后续缺纸、卡纸或实际出纸状态。

## 2026-06-26 v0.9.0 打包与运行目录同步验证

范围：

- 将打印并自动归档能力发布为 `0.9.0`。
- 重新生成客户端、服务端安装包和局域网更新清单。
- 同步发布文件到真实服务端运行目录 `E:\PDF服务端\pdf-approval\releases`。

命令：

```powershell
npm test -- --run src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts src/client/clientConfig.test.ts src/client/printSettings.test.ts src/client/pages/approvalDetailPrint.test.ts
npm run installer:package
npm test -- --run src/server/releaseVersion.test.ts src/server/updateManifestPackage.test.ts src/server/runtimeReleaseSync.test.ts
Get-AuthenticodeSignature -LiteralPath `
  'dist\installers\client\PDF图纸审批客户端-安装包-0.9.0.exe',`
  'dist\installers\server\PDF图纸审批服务端-安装包-0.9.0.exe',`
  'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.9.0.exe',`
  'E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.9.0.exe'
```

结果：

- 版本聚焦测试：5 个测试文件、23 个用例通过。
- `npm run installer:package` 成功退出，exit code = 0。
- 发布打包验证：3 个测试文件、4 个用例通过。
- `dist\updates\latest.json` 和 `E:\PDF服务端\pdf-approval\releases\updates\latest.json` 均为 version=`0.9.0`，releaseDate=`2026-06-26`。
- `dist\installers\client\PDF图纸审批客户端-安装包-0.9.0.exe`：102491558 bytes。
- `dist\installers\server\PDF图纸审批服务端-安装包-0.9.0.exe`：103372019 bytes。
- `E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.9.0.exe`：102491558 bytes。
- `E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.9.0.exe`：103372019 bytes。
- 四个安装包 Authenticode 状态均为 `NotSigned`，当前未配置企业代码签名证书，Windows 可能继续显示安全提醒。
- 更新清单下载路径指向 `../installers/client/PDF图纸审批客户端-安装包-0.9.0.exe` 和 `../installers/server/PDF图纸审批服务端-安装包-0.9.0.exe`。

## 2026-06-26 v0.9.1 electron-updater 启动更新验证

范围：

- Electron 客户端接入 `electron-updater`，启动后通过服务端 `/updates/latest.yml` 检查客户端新版，不依赖用户登录。
- 客户端发现新版后自动下载并显示进度；下载完成后提示用户打开安装包，按 Windows 安装向导手动完成升级。
- 发布流程新增 `latest.yml`、客户端安装包和 `.blockmap` 文件到 `dist\updates`，并同步到真实运行目录 `E:\PDF服务端\pdf-approval\releases\updates`。
- 服务端仍通过 `latest.json` 提供网页/管理端版本信息；Electron 自动更新使用 `latest.yml`。

命令：

```powershell
npm run desktop:test -- --run apps/desktop-client/electronShell.test.mjs apps/desktop-client/packageLayout.test.mjs
npm test -- --run src/server/runtimeReleaseSync.test.ts src/server/windowsInstallers.test.ts src/server/updateManifestPackage.test.ts src/client/clientConfig.test.ts src/client/appLayout.test.ts src/server/releaseVersion.test.ts src/server/services/updateInfo.test.ts
npm run build
npm run desktop:test
npm test
npm run installer:package
Get-AuthenticodeSignature -LiteralPath `
  'dist\installers\client\PDF图纸审批客户端-安装包-0.9.1.exe',`
  'dist\installers\server\PDF图纸审批服务端-安装包-0.9.1.exe',`
  'E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.9.1.exe',`
  'E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.9.1.exe'
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/updates/latest.json
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/updates/latest.yml
Invoke-WebRequest -UseBasicParsing http://192.168.0.62:8080/updates/latest.yml
```

结果：

- Electron 聚焦测试：2 个文件、5 个用例通过。
- 更新相关聚焦测试：7 个文件、28 个用例通过。
- `npm run build` 通过；仍有既有 `assets/pdf-CJRVEglZ.js` 约 `531.35 kB` 的 Vite chunk 体积提醒，未阻断构建。
- `npm run desktop:test`：3 个文件、11 个用例通过。
- `npm test`：90 个文件、491 个用例通过。首次全量测试发现新增更新弹窗进度条使用 `border-radius: 999px` 触发视觉规范测试失败，已改为 `var(--radius-control)` 并重新全量通过。
- `npm run installer:package` 成功退出，重新生成客户端、服务端安装包，并同步到 `E:\PDF服务端\pdf-approval\releases`。
- `dist\updates\latest.yml` 和 `E:\PDF服务端\pdf-approval\releases\updates\latest.yml` 均为 version=`0.9.1`，指向 `PDF图纸审批客户端-安装包-0.9.1.exe`，size=`103108694`。
- `dist\updates\latest.json` 和 `E:\PDF服务端\pdf-approval\releases\updates\latest.json` 均为 version=`0.9.1`，releaseDate=`2026-06-26`。
- `dist\installers\client\PDF图纸审批客户端-安装包-0.9.1.exe`：103108694 bytes。
- `dist\installers\server\PDF图纸审批服务端-安装包-0.9.1.exe`：103373427 bytes。
- `E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.9.1.exe`：103108694 bytes。
- `E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.9.1.exe`：103373427 bytes。
- `dist\updates\PDF图纸审批客户端-安装包-0.9.1.exe.blockmap` 和 `E:\PDF服务端\pdf-approval\releases\updates\PDF图纸审批客户端-安装包-0.9.1.exe.blockmap` 均存在。
- HTTP 冒烟：`http://127.0.0.1:8080/updates/latest.json` 返回 200，version=`0.9.1`。
- HTTP 冒烟：`http://127.0.0.1:8080/updates/latest.yml` 返回 200，首行为 `version: 0.9.1`。
- HTTP 冒烟：`http://192.168.0.62:8080/updates/latest.yml` 返回 200，首行为 `version: 0.9.1`。
- 四个安装包 Authenticode 状态均为 `NotSigned`，当前未配置企业代码签名证书，Windows 可能继续显示安全提醒。

上线注意：

- `0.9.0` 及更早客户端没有内置 `electron-updater`，无法自动升级到 `0.9.1`；团队电脑需要手动安装一次 `PDF图纸审批客户端-安装包-0.9.1.exe`。
- 从 `0.9.1` 之后，客户端启动时才会自动检查后续新版，自动下载完成后仍由用户打开安装包并按安装向导升级，不执行静默安装或自动重启。

## 2026-06-29 PDM V1 Foundation 验证

范围：

- 新增 PDM 标准图纸文件名解析，支持 `体系文件号 《管家婆物料号 图纸名称》 版本.pdf`，并兼容体系文件号后补和物料号缺失待补齐。
- 新增 PDM 零件、图纸版本、项目使用记录、审批来源链接和元数据修复数据模型。
- 审批通过后自动发布 PDM 图纸版本，保证同一管家婆物料号全局唯一、同一物料号同一版本不重复发布。
- 新增零件库页面、零件详情页、审批详情 PDM 信息和元数据修复入口。
- 新增 PDM 历史回填维护服务，可扫描已通过或已打印归档审批，将标准文件名且有效 PDF 的历史图纸补发布到零件库。

命令：

```powershell
npm test -- --run src/server/services/pdmBackfillService.test.ts
npm test
npm run build
npm run desktop:test
```

结果：

```text
PDM 回填聚焦测试: 1 个测试文件，2 个用例通过。
npm test: 95 个测试文件，528 个用例通过。
npm run build: TypeScript 与 Vite 生产构建通过。
npm run desktop:test: 3 个测试文件，11 个用例通过。
```

构建说明：

```text
Vite 构建仍提示 assets/pdf-CJRVEglZ.js 约 531.35 kB 超过 500 kB。
该文件是 PDF.js 预览依赖的独立 chunk，当前不阻断构建；后续如继续压缩首屏体积，可再拆分 PDF 预览加载时机或调整 manualChunks。
```

已知限制：

- PDM 历史回填已接入管理员“系统管理”维护入口，可触发 `PdmBackfillService.backfillApprovedDrawings()` 并查看回填结果。
- 标准 PDM 发布以管家婆物料号为主键；缺失物料号的历史审批不会自动发布，需要先通过元数据修复补齐。
- 缺失体系文件号允许发布，后续可通过元数据修复补齐。

## 2026-06-29 PDM 工作台布局优化验证

范围：

- 零件库首页从普通台账调整为“PDM 工作台”：顶部主搜索、筛选区、统计条、零件主表和待补录问题队列。
- 零件详情页从信息面板调整为“零件主档案”：主键、当前有效版本、体系文件号、共用状态、使用项目、版本历史和审批追溯更集中。
- 窄屏下 PDM 主表改为卡片式展示，避免不同窗口尺寸下横向挤压。

命令：

```powershell
npm test -- --run src/client/pages/pdmPageLayout.test.ts
npm test -- --run src/client/styles.test.ts
npm run build
```

结果：

```text
PDM 页面布局测试: 1 个测试文件，7 个用例通过。
样式规则测试: 1 个测试文件，15 个用例通过。
npm run build: TypeScript 与 Vite 生产构建通过。
```

浏览器冒烟：

```text
Chrome headless 打开 http://127.0.0.1:5173/#/pdm，使用 admin / admin123 登录。
桌面 1440x950: PDM 工作台、4 个统计卡、主表和待补录队列正常渲染，无横向溢出，控制台无 error。
移动 390x840: 工作台单列展示，PDM 表格卡片化，thead 隐藏，无横向溢出，控制台无 error。
零件详情 #/pdm/parts/1: 零件主档案、5 个关键字段和详情布局正常渲染，无横向溢出，控制台无 error。
```

说明：

```text
构建仍保留既有 assets/pdf-CJRVEglZ.js 约 531.35 kB 的 Vite chunk 体积提示，该提示来自 PDF.js 预览依赖，不阻断本次 PDM 页面优化。
```

## 2026-07-02 PDM 台账与待补录清单收口验证

范围：

- 零件库首页固化为三段式 PDM 台账：统计与风险概览、紧凑筛选区、零件主表。
- 后端零件列表返回筛选后的总零件数、当前有效版本数和共用件数，避免前端只按当前页推断统计。
- 待补录从零件库右侧风险队列拆出为独立清单页 `#/pdm/pending-metadata`，管理员和设计师可进入，主管和工艺不可进入。
- 零件详情页固化为“主档案 + 当前有效版本 + 版本关系页签”，覆盖版本历史、使用项目、关联审批和文件哈希。
- PDM 主表突出管家婆物料号、图纸名称、当前版本、体系文件号、项目复用、状态和最近发布。

命令：

```powershell
npm test -- --run
npm run build
git diff --check
```

结果：

```text
npm test -- --run: 95 个测试文件，535 个用例通过。
npm run build: TypeScript 与 Vite 生产构建通过。
git diff --check: 无空白或补丁格式问题。
```

说明：

```text
构建仍保留既有 assets/pdf-CJRVEglZ.js 约 531.35 kB 的 Vite chunk 体积提示，该提示来自 PDF.js 预览依赖，不阻断本次 PDM 台账收口。

## 2026-07-02 PDM V1 收口与 v0.9.2 发布验证

变更范围：

- PDM 零件详情页新增原始 PDF、签后 PDF、审查版 PDF 直接入口。
- PDM 零件详情页新增操作时间线，直接展示该零件相关审批和 PDM 操作日志。
- 新增管理员 PDM 图纸版本作废接口和页面入口；作废当前版本后会回退到最近的非作废历史版本。
- PDM 待补录清单新增列表内快速补录和“发布到 PDM”重试。
- 修正 PDM 历史回填验证文档中的过期限制说明。
- 版本升级到 `0.9.2`，重新生成客户端、服务端安装包和更新清单。

命令验证：

```powershell
npm test -- --run src/client/pages/pdmPageLayout.test.ts
npm test -- --run src/server/repositories/pdmParts.test.ts
npm test -- --run src/server/routes/pdm.test.ts
npm test -- --run src/client/api.test.ts
npm test
npm run desktop:test
npm run build
npm run installer:package
git diff --check
```

结果：

- focused PDM 前端布局测试：10 个用例通过。
- PDM repository 测试：9 个用例通过。
- PDM routes 测试：8 个用例通过。
- client API 测试：27 个用例通过。
- 全量测试：95 个测试文件、541 个用例通过。
- Electron 桌面壳测试：3 个测试文件、12 个用例通过。
- Vite/TypeScript 构建通过；仍保留既有 `assets/pdf-CJRVEglZ.js` 约 531.35 kB 的 PDF.js chunk 提示，不阻断发布。
- `git diff --check` 通过。

浏览器冒烟：

- 使用临时端口 `18080` 和临时数据库启动 `0.9.2` 开发服务，未占用真实服务端 `8080`。
- Chrome/Playwright 打开 `http://127.0.0.1:18080/#/pdm`，使用 `admin / admin123` 登录。
- PDM 工作台显示零件总数、当前有效版本、待补录、共用件数和零件主表。
- PDM 待补录页显示“快速补录”“发布到 PDM”，点击“快速补录”后出现物料号、体系文件号、图纸名称内联表单。
- PDM 零件详情页显示原始 PDF、签后 PDF、审查版 PDF、历史版本、作废版本控件。
- 点击“操作时间线”后显示审核处理和发布到 PDM 记录。
- Playwright console error 检查：0 个 error。

发布产物：

- `dist\installers\client\PDF图纸审批客户端-安装包-0.9.2.exe`：103125185 bytes。
- `dist\installers\server\PDF图纸审批服务端-安装包-0.9.2.exe`：103396067 bytes。
- `E:\PDF服务端\pdf-approval\releases\installers\client\PDF图纸审批客户端-安装包-0.9.2.exe`：103125185 bytes。
- `E:\PDF服务端\pdf-approval\releases\installers\server\PDF图纸审批服务端-安装包-0.9.2.exe`：103396067 bytes。
- `E:\PDF服务端\pdf-approval\releases\updates\latest.json` 和 `latest.yml` 均已同步，version=`0.9.2`。
- 真实服务端 `http://127.0.0.1:8080/updates/latest.json` 返回 version=`0.9.2`；`/updates/latest.yml` 首行为 `version: 0.9.2`。

注意：

- 验证时真实服务端 `/health` 仍显示 `0.9.1`，因为尚未安装新版服务端 exe；当前已同步的是更新目录。安装 `PDF图纸审批服务端-安装包-0.9.2.exe` 后，服务端运行版本才会变为 `0.9.2`。
```

## 2026-07-10 Phase 0 browser baseline

验证范围：

- Playwright 仅清理并重建 `.cache/e2e/runtime`，数据库、图纸、签名、日志、备份和发布目录均位于该隔离根目录；未使用或读取真实 `data`、`output`、`logs`、`backups`、`config` 目录。
- 固定种子提供管理员、主管、工艺和设计师角色；四种角色均有独立的浏览器落点和角色导航断言，失败时可直接定位到具体角色。
- 测试代码生成有效 PDF，并在桌面、移动项目中断言首个 PDF canvas 的非白像素数大于 100。
- Axe 在桌面、移动项目的登录页和管理员主区域均为 0 个 critical 违规。
- 视觉基线包括管理员外壳 desktop/mobile、审批 PDF 工作台 desktop/mobile，四张截图均已人工复核；截图断言禁用动画并使用固定 `maxDiffPixels: 1000`，避免全页高度放大可接受差异。相同的两份截图 spec 已连续定向复测三次且全部通过，未更新快照；登录与角色导航属于交互基线，没有单独截图。

命令：

```powershell
npm test -- --run src/client
npm test -- --run src/server/auth.test.ts src/server/domain src/server/repositories src/server/services src/server/files src/server/pdf
npm test -- --run src/server/routes/auth.test.ts src/server/routes/submissions.test.ts src/server/routes/approvals.test.ts src/server/routes/approvalAnnotations.test.ts src/server/routes/approvalComments.test.ts src/server/routes/pdm.test.ts
npm test -- --run src/server/routes/settings.test.ts src/server/routes/system.test.ts src/server/routes/users.test.ts src/server/routes/profile.test.ts src/server/routes/signatures.test.ts src/server/routes/signatureTemplates.test.ts src/server/routes/operationLogs.test.ts src/server/routes/reports.test.ts src/server/routes/tray.test.ts src/server/server.test.ts src/server/startServer.test.ts src/server/dbIndexes.test.ts
npm run e2e:typecheck
npm run build
npm run desktop:test
npm run e2e -- --project=mobile-chromium e2e/smoke/approval-workbench.spec.ts
npm run e2e -- e2e/smoke/login-navigation.spec.ts
npm run e2e -- e2e/smoke/approval-workbench.spec.ts e2e/smoke/responsive-accessibility.spec.ts
npm run e2e
```

结果：

- client：32 个测试文件、223 个用例通过；Vitest `16.04s`，命令墙钟 `25.5s`。
- server auth/domain/repositories/services/files/pdf：31 个测试文件、130 个用例通过；Vitest `15.20s`，命令墙钟 `24.7s`，低于 60 秒硬超时。
- server 核心 routes：6 个测试文件、88 个用例通过；Vitest `36.64s`，命令墙钟 `45.6s`，低于 60 秒硬超时。
- server settings/system/users 等：12 个测试文件、65 个用例通过；Vitest `13.79s`，命令墙钟 `21.8s`，低于 60 秒硬超时。
- `npm run e2e:typecheck`：通过，命令墙钟 `9.3s`。
- `npm run build`：TypeScript 与 Vite 生产构建通过，命令墙钟 `26.8s`；保留既有 `assets/pdf-CJRVEglZ.js` `531.35 kB` 超过 500 kB 的 PDF.js chunk 警告，不阻断构建。
- `npm run desktop:test`：3 个测试文件、12 个用例通过；Vitest `5.24s`，命令墙钟 `13.7s`。
- 移动 PDF 工作台定向复测：2 个用例通过，Playwright `37.8s`；工作台快照已精确遮罩动态“提交时间”值。当前 desktop 基线为 `1440x1235`、`235902` bytes、SHA-256 `D28CA02DA90DAEE605ABCB5085169279765047040C18F094B9DE7451260CCC5E`，mobile 基线为 `390x3604`、`237530` bytes、SHA-256 `3F67D6B1ADE21DE6F3E0E35F363E74FF40A244CECD1FD58797823FC89D8AB2F0`。
- 登录与角色导航定向复测：desktop 5 个、mobile 5 个，共 10 个用例通过；管理员、主管、工艺和设计师的独立浏览器断言均通过。Playwright `46.4s`，命令墙钟 `52.5s`。
- 固定截图容差定向校准：`maxDiffPixels: 1000` 下连续三次均为 desktop 5 个、mobile 5 个，共 10 个用例通过；三次 Playwright 均为 `1.0m`，命令墙钟依次为 `68.5s`、`68.6s`、`66.9s`，未更新快照。
- 完整 Playwright：desktop 10 个、mobile 10 个，共 20 个用例通过；Playwright `1.2m`，命令墙钟 `74.7s`。退出后 `14173`、`18080` 均无监听。

范围审计：

- Phase 0 未修改业务流程、数据库 schema 或桌面打包逻辑；`package.json` 和 lockfile 仅增加测试脚本及开发依赖。
- 产品代码唯一改动是将登录方式切换容器的 ARIA 语义从 `tablist` 修正为 `group`，未改变交互或认证行为。

## 2026-07-13 Phase 1 Task 22 平台收尾验证（完成）

范围与隔离：

- 新增独立 `playwright.platform.config.ts`，使用 `24173`（Vite）和 `28080`（Platform API），未修改 Phase 0 的 `playwright.config.ts`、`14173`、`18080` 或 legacy `.cache/e2e/runtime`。
- 平台 harness 设计为每次创建唯一 fresh PostgreSQL database，应用当前 `0001`–`0007` 迁移，以真实 `startPlatformWebServer()`、`workerMain()` 和 Vite 启动 Web/Worker/客户端。每次运行拥有单一 MinIO cleanup root `phase1-e2e/<run-id>`；Web 与 Worker 显式注入同一个测试 StorageAdapter wrapper，把逻辑 `write/openRead/head/delete` 和 wrapper 自有 health probe 全部映射到其 `objects/` 子前缀。Worker probe sentinel 位于同一 owned root 的 `sentinel/` 子前缀，因此对 adapter 仍是前缀外对象，但正常退出或启动失败时可由 cleanup root 统一兜底。生产默认 storage factory 不变，也没有新增环境变量 fallback。退出时关闭 HTTP、Pool、Worker、删除该 owned cleanup root 和本次 state 文件，再由现有 harness 等待 session 为 0 并 `DROP DATABASE ... WITH (FORCE)`。
- Mailpit 清理函数只接受 `127.0.0.1|localhost|::1:58025`；由于 Mailpit API 的本地测试基线使用全量清理，harness 只有在首次清理成功、确认取得本地测试实例所有权后才在退出时再次清理。它不得指向共享或远程 Mailpit。
- 测试种子使用源码内固定的 `.test` 邮箱、合成密码和 TOTP 常量；`.cache/platform-e2e/state.json` 分别记录 owned `storageCleanupRoot` 与 adapter 实际 `storagePrefix`，并只发布非秘密的管理员邮箱及必要实体 ID，不写密码、TOTP secret 或 recovery codes。进程启动第一步先删除陈旧 state，退出再次删除；不提交截图、trace、视频或临时 state。

已实际执行的 TDD 与静态门禁（节选；所有测试命令均由 60 秒执行器约束）：

```powershell
node scripts/run-with-timeout.mjs 60000 npm run e2e:platform -- --project=desktop-chromium e2e/platform/identity-security.spec.ts
node scripts/run-with-timeout.mjs 60000 npm test -- --run e2e/platform/support/totp.unit.test.ts e2e/platform/support/mailpit.unit.test.ts e2e/platform/support/fixtures.unit.test.ts e2e/platform/support/server.unit.test.ts src/client/viteConfig.test.ts
node scripts/run-with-timeout.mjs 60000 npm run e2e:typecheck
node scripts/run-with-timeout.mjs 60000 npm test -- --run src/client
npm run test:platform:unit
node scripts/run-with-timeout.mjs 60000 npm test -- --run src/server/auth.test.ts src/server/domain src/server/repositories src/server/services src/server/files src/server/pdf
node scripts/run-with-timeout.mjs 60000 npm test -- --run src/server/routes/auth.test.ts src/server/routes/submissions.test.ts src/server/routes/approvals.test.ts src/server/routes/approvalAnnotations.test.ts src/server/routes/approvalComments.test.ts src/server/routes/pdm.test.ts
node scripts/run-with-timeout.mjs 60000 npm test -- --run src/server/routes/settings.test.ts src/server/routes/system.test.ts src/server/routes/users.test.ts src/server/routes/profile.test.ts src/server/routes/signatures.test.ts src/server/routes/signatureTemplates.test.ts src/server/routes/operationLogs.test.ts src/server/routes/reports.test.ts src/server/routes/tray.test.ts src/server/server.test.ts src/server/startServer.test.ts src/server/dbIndexes.test.ts
node scripts/run-with-timeout.mjs 60000 npm test -- --run src/server/serverPackage.test.ts src/server/serverExePackage.test.ts
node scripts/run-with-timeout.mjs 60000 npm run desktop:test
node scripts/run-with-timeout.mjs 60000 npm run build
node scripts/run-with-timeout.mjs 60000 npm run e2e -- --project=desktop-chromium e2e/smoke/login-navigation.spec.ts
git diff --check
```

结果：

- 首个 identity spec 有效 RED：1 个用例在 `page.goto(http://127.0.0.1:24173/)` 得到 `ERR_CONNECTION_REFUSED`，证明当时尚无 harness；墙钟 `12.0s`。此前 Playwright 先暴露本机缺少版本匹配的 bundled Chromium 与 ffmpeg，平台配置改为“bundled Chromium 存在时优先，否则使用已安装 Chrome channel”，并关闭非必需视频；截图/trace 均位于被忽略的 `.cache/platform-e2e`。
- Vite platform target 先得到预期 RED：24 个通过、1 个失败，实际仍选 `18080` 而预期 platform `28080`；墙钟 `16.2s`。最小实现后，TOTP、Mailpit 与 Vite 共 3 个文件、29 个用例通过；fresh 复测 Vitest `4.17s`、命令墙钟 `14.6s`。
- lifecycle fixture 初次类型检查得到预期 RED：`TS2322`，worker-scoped fixture 被错误声明为 test scope；墙钟 `10.6s`。分离 Playwright test/worker fixtures 后通过；三份完整 spec 落盘后的 fresh `e2e:typecheck` 通过，命令墙钟 `10.7s`。
- Mailpit 不可用诊断先得到预期 RED：2 个通过、1 个失败，原始 `connect ECONNREFUSED secret-host` 未映射；修复后 3/3 通过，Vitest `1.67s`、命令墙钟 `10.2s`，错误消息不再泄露连接上下文。
- state 发布竞态与清理诊断先得到预期 RED：2 个文件、2 个用例均因函数不存在失败，同时证明导入 `server.ts` 会错误启动 harness；墙钟 `15.1s`。修复后 state 使用临时文件 + rename 原子发布，并在 Vite 绑定 `24173` 前完成；`server.ts` 增加 main-module guard，清理逐项保留稳定子错误。2/2 GREEN 后 `e2e:typecheck` 继续通过，组合命令墙钟 `24.2s`。
- 最终 support + Vite targeted fresh：5 个文件、32 个用例通过，Vitest `6.17s`；随后 `e2e:typecheck` 和 `git diff --check` 通过，组合墙钟 `25.7s`。
- 端口检查显示平台 `24173:RELEASED`、`28080:RELEASED`。

已完成的无 Docker 回归门禁：

- Task 20/21 身份客户端与界面聚焦：9 个文件、156 个用例通过，墙钟 `13.0s`。
- 全量 client：40 个文件、375 个用例通过，墙钟 `15.6s`。
- legacy auth/domain/repositories/services/files/pdf：31 个文件、130 个用例通过，墙钟 `20.3s`。
- legacy 核心 routes：6 个文件、88 个用例通过，墙钟 `41.0s`。
- legacy settings/system/users 等：12 个文件、65 个用例通过，墙钟 `23.7s`。
- server/server-exe package：2 个文件、3 个用例通过，墙钟 `12.1s`。
- Electron：3 个文件、12 个用例通过，墙钟 `12.3s`。
- `npm run build`：TypeScript 与 Vite 生产构建通过，墙钟 `29.7s`；只保留既有 `assets/pdf-CJRVEglZ.js` `531.35 kB` 超过 500 kB 的 PDF.js chunk 警告。

规格审查 Important 修复证据：

- 物理 S3 前缀与 Worker 注入先得到预期 RED：storage suite 因 wrapper 模块不存在失败；Worker 新用例仍进入真实 `loadPlatformConfig`，4 个既有用例通过、1 个新用例失败，墙钟 `13.3s`。实现测试 wrapper、Web `dependencies.createStorage` 注入和 Worker 显式 `loadConfig/storageFactory/runLifecycle` 依赖后，2 个文件、7 个用例通过，墙钟 `17.6s`。
- fresh 受影响回归包含 prefixed storage、TOTP、Mailpit、state publication、cleanup diagnostics 和 Worker lifecycle：6 个文件、14 个用例通过，墙钟 `14.6s`。
- identity security spec 在 `page.goBack()` 后、下一次 `page.goto('/')` 前，使用同一 helper 同时扫描后退态 URL、localStorage、sessionStorage 和 console；检查 challenge、invitation、enrollment、`otpauth://` URI、手工 TOTP secret、两次 TOTP code 与全部 recovery codes 均不残留。
- 运行手册已明确列出 `npm run platform:db:migrate`、`npm run platform:bootstrap-admin` 和 `npm run platform:worker`；未跟踪 `.env.local` 使用等价的显式 Node 入口覆盖，不修改或隐藏 npm 默认配置。
- 修复后的 Task 20/21 聚焦回归：9 个文件、156 个用例通过，墙钟 `13.2s`；`e2e:typecheck` 通过，墙钟 `11.2s`；`npm run build` 通过，墙钟 `27.3s`，仍只有既有 PDF.js `531.35 kB` 警告。

质量审查 Critical / Important 修复证据：

- 本地依赖边界采用 fail-closed：在 Mailpit、PostgreSQL、MinIO 的任何请求前，先删除陈旧 state，再校验全部 TEST/admin/migration/web/worker/bootstrap PostgreSQL URL 均为固定 `55432` loopback、允许的本地角色/数据库/本地密码；MinIO 必须是固定 `59000` loopback HTTP、无认证/path/query/hash、精确 `pdf-approval` bucket、`forcePathStyle=true` 和 local-only 示例凭据。run env 从白名单显式构造，不继承生产同名配置。对应 RED 后，环境与启动边界 2 个文件、14 个用例通过。
- startup、E2E Worker child 和正式 Worker 进程错误只允许白名单稳定 code，否则输出通用 code；数据库 URL、secret 和任意 `error.code` 不再透传。对应 3 个文件、10 个用例通过。
- S3 prefix 回收检查 `DeleteObjects.Errors`，且 `IsTruncated=true` 缺 `NextContinuationToken` 时 fail-closed；多页、部分失败和缺 token 3 个用例通过。
- `npm run e2e:platform` 无参数时由无 shell 的 Node runner 顺序执行 desktop identity、desktop session/project、mobile identity 三次独立 fresh harness；显式参数保持单次 Playwright 直通。stateful Playwright `retries` 固定为 0；command matrix 2/2 通过。
- 完整 harness 已接真实 Worker prefix probe：先在 owned run root 的 `objects/` adapter 子前缀写对象、在同一 root 的 `sentinel/` 子前缀写 sentinel，并在真实 PostgreSQL transaction 中写 storage metadata 与 cleanup outbox intent，之后才启动 Worker；轮询时先确认 sentinel 存在，观察到对象已删除且 metadata 为 `deleted` 后再确认一次 sentinel，最后主动删除 sentinel。sentinel 对 Worker adapter 是前缀外对象；正常退出或启动失败时由 cleanup root 兜底。该真实 PostgreSQL + MinIO 路径已随最终四个 Platform Playwright 用例完成验证。
- Mailpit 全量清理前获取 `127.0.0.1:58026` OS 独占锁，退出释放；并发所有权测试 4/4 通过。Worker child 在启动配置/模式检查前建立外层 AbortSignal，IPC/SIGTERM/SIGINT shutdown 在 schema gate 后仍被观察，取消后不创建 storage、不启动 loop；Worker 相关 2 个文件、8 个用例通过。
- 邀请限流按源码定义保留 `invitation.prepare` 与 `invitation.complete` 两个不同 PostgreSQL 共享 bucket；E2E 分别验证两类失败各自达到 `429`，不把 prepare 打满误写成 complete 必须立即 `429`。
- fresh 组合受影响回归：12 个文件、65 个用例通过，墙钟 `17.4s`；Worker 聚焦实际收集 3 个文件、19 个用例通过，墙钟 `14.8s`。身份客户端/API 聚焦另有 9 个文件、113 个用例通过，墙钟 `15.9s`；既有 Task 20/21 9 文件、156 用例证据仍见上一条。
- `e2e:typecheck` 首次仅因新 runner `.mjs` 缺类型声明失败；补同名 `.d.mts` 后 fresh 通过，墙钟 `11.3s`。`npm run build` fresh 通过，墙钟 `29.4s`，仍只有既有 PDF.js `531.35 kB` chunk 警告。
- 最终 Minor 的 ownership layout 与 sentinel 成功前复检均先得到有效 RED：2 个文件、7 个用例中 2 个失败；最小修复后受影响 4 个文件、11 个用例通过，墙钟 `15.4s`。layout 断言 sentinel 不属于 adapter `objects/` 前缀但属于 cleanup root；竞态用例模拟首次 sentinel 存在、probe 已删、返回前 sentinel 消失并确认必须失败。

基础设施恢复与最终真实验收：

- Docker Desktop 恢复后，PostgreSQL `127.0.0.1:55432`、MinIO `127.0.0.1:59000/59001`、Mailpit `127.0.0.1:51025/58025` 三项容器均为 healthy；只执行幂等 `npm run infra:up`，未 reset、未删除卷。
- 九组 Platform integration 共 `319/319` 通过；Platform unit 共 `530` 个通过，另有 1 个 Windows symlink policy 跳过。此前环境中的 `runWithTimeout/taskkill` 用例已在最终权限环境下通过。
- Phase 0 回归保持绿色：client `375/375`、legacy auth/domain/repositories/services/files/pdf `130/130`、legacy core routes `88/88`、legacy settings/system 等 `65/65`、package `3/3`、Electron `12/12`、legacy Playwright `20/20`；生产构建通过，只有既有 PDF.js `531.35 kB` chunk 警告。
- Windows 下 Playwright `webServer` 会强制结束进程树，无法等待异步清理。最终改为 `scripts/run-platform-e2e.mjs` 持有 harness 生命周期：每组 fork fresh harness，等待 READY，运行 Playwright，并在 `finally` 通过 IPC 请求 shutdown；只有同时收到 cleanup ack 和 child exit 才算成功。pass、Playwright fail/throw、harness 启动失败和超时路径均有单测，生命周期测试 `19/19`、`e2e:typecheck`、`git diff --check` 均通过。
- 真实定向运行 `npm run e2e:platform -- --project=desktop-chromium e2e/platform/project-access.spec.ts`：`1/1` 通过，墙钟 `28.5s`；退出后数据库、对象、邮件、state、端口与 Mailpit 锁均为 0。
- 真实完整运行 `npm run e2e:platform`：三次独立 READY；desktop identity `1/1`、desktop project/session `2/2`、mobile identity `1/1`，合计 `4/4` 通过，墙钟 `100.5s`。覆盖 Axe、无横向溢出、真实 Cookie/CSRF、邀请、TOTP、一次性恢复码、两类邀请限流、项目 active membership 与未授权统一 404。
- 完整运行退出后再次核对：`pdf_approval_test_*` 数据库 `0`、MinIO `phase1-e2e/*` 对象 `0`、Mailpit 测试邮件 `0`、`.cache/platform-e2e/state.json` 不存在，`14173/18080/24173/28080/58026` 监听 `0`；三项基础设施仍为 healthy。

最终验收结论：

- Phase 1 Task 22 的真实依赖、浏览器、Worker、数据库、对象存储、邮件与清理生命周期门禁全部通过。
- Phase 1 验收范围已闭环；已知 PDF.js chunk 警告保持 Phase 0 基线，不阻断本阶段完成。

## 2026-07-13 Phase 2 Task 1–2：DS0/DS1 启动切片

范围：

- 新建 `codex/phase-2-ui-design-system`，以已验收的 Phase 1 提交为基础；详细计划写入 `docs/plans/2026-07-13-phase-2-ui-design-system-app-shell.md`。
- 将基础视觉来源从 `src/client/styles.css` 的单一 `:root` 拆为 `styles/tokens.css`、`reset.css`、`globals.css` 和 `motion.css`。未迁移页面通过只指向新令牌的兼容别名继续工作；本切片不迁移审批、PDM 或 PDF 业务 DOM。
- 视觉方向采用精密工业：冷中性工作面、深色工具表面、单一青绿色主操作；取消旧 body 装饰渐变，不引入 UI 框架或运行时字体。
- 新增开发专用 `/__ui-gallery`。入口同时要求 `import.meta.env.DEV`，生产构建扫描 `UI 设计系统基线` 与 `Phase 2 · DS0 / DS1` 均为 0 个匹配，生产导航没有 Gallery 入口。
- 新增独立 `playwright.ui.config.ts` 和 `npm run e2e:ui`，固定覆盖 `1440×900`、`1280×800`、`1024×768`、`768×1024`、`390×844` 五个视口，不连接 legacy/platform API。

TDD 与浏览器校准：

- 初始 foundation 测试按预期 RED：4 个令牌/入口断言失败，Gallery 因实现文件不存在而无法收集。
- 最小实现后，foundation、Gallery 和既有样式聚焦测试共 `21/21` 通过。
- UI Gallery 首轮五视口真实浏览器得到有效 RED：次要文字 `#627278` 在工作面 `#e7ecee` 上只有 `4.20:1`，低于 WCAG AA `4.5:1`。将令牌校准为 `#5b6b70` 后对比度达到 `4.66:1`，未降低 axe 门禁。
- 五视口均验证：无横向溢出、键盘 `:focus-visible` 可见、reduced-motion 将滚动恢复为 `auto`、控制台 0 个 error、axe 0 个 serious/critical；截图已人工检查桌面和手机布局。
- UI Gallery 截图大小：desktop `134587`、compact `132139`、landscape `133534`、portrait `134805`、mobile `129969` bytes。

回归结果：

- 全量 client：42 个文件、`381/381` 通过。
- `npm run e2e:typecheck`：通过。
- `npm run build`：通过；只保留既有 PDF.js `531.35 kB` chunk 警告。
- Electron：3 个文件、`12/12` 通过。
- UI Gallery：五视口 `5/5` 通过，非更新模式复测稳定。
- Phase 0 legacy Playwright：先得到 16 个行为测试通过、4 个预期视觉差异；人工检查新的 desktop/mobile 管理台和 PDF 工作台后更新四张基线，完整非更新模式复测 `20/20` 通过。
- Phase 1 Platform Playwright：desktop identity `1/1`、desktop project/session `2/2`、mobile identity `1/1`，合计 `4/4` 通过。
- Platform 退出后：测试数据库 `0`、MinIO 测试对象 `0`、Mailpit 测试邮件 `0`、state 文件不存在，`14173/18080/24173/28080/34173/58026` 监听 `0`。

当前边界：

- Phase 2 已开始，但尚未完成；本切片只完成详细计划、DS0 和 DS1。
- 下一切片是 Task 3 Actions：Button、IconButton、ButtonLink 和 ButtonGroup，并从 platform identity 开始迁移调用点。

## 2026-07-14 Phase 2 Task 3–5：DS2 Platform Identity 垂直切片

范围：

- 新增仓库内生 Actions、Forms、Feedback 组件层；Actions 包含 `Button`、`IconButton`、`ButtonLink`、`ButtonGroup`，Forms 包含字段、输入、选择、选择组、开关、文件拖放和表单动作，Feedback 包含提示、Toast、保存状态、进度、骨架、空/错状态和连接横幅。
- Platform 登录、MFA、邀请激活、恢复码和项目访问页面已迁移到公共组件；业务请求、路由、Cookie/CSRF、安全激活和项目权限逻辑保持不变。
- 删除 identity 中零引用的 `.platform-button`、`.platform-error`、`.platform-feedback`、基础 input/select、factor 和 confirmation 实现；保留的 `platform-form` 只负责页面布局。`platformIdentity.css` 的颜色全部改为语义令牌。
- UI Gallery 扩展到 DS0–DS2 的主要状态；五份截图已人工检查，当前大小为 desktop `229528`、compact `225062`、landscape `223411`、portrait `226621`、mobile `214005` bytes。

真实浏览器校准：

- loading Button 初始丢失可访问名称，修复为 loading 时使用显式 `aria-label`。
- warning 文本初始对比度为 `3.41:1`，将 warning 令牌调整为 `#8a5c00` 后通过 axe。
- PasswordInput 的“显示密码”按钮与“密码”输入框名称冲突；按钮改用“显示/隐藏输入内容”可访问名称，具体字段信息保留在 title。
- RadioGroup 原先把说明文本并入 accessible name；改为独立 `aria-labelledby` 与 `aria-describedby`，恢复码选项可按精确名称定位。

Gallery 生命周期修复：

- Windows 下 Playwright `webServer` 退出存在端口释放竞态。`scripts/run-ui-gallery-e2e.mjs` 现直接使用 Vite `createServer()` 持有服务，Playwright CLI 以 `shell: false` 子进程运行，并在成功或失败路径的 `finally` 关闭 Vite。
- runner 生命周期单测 `4/4` 通过。`npm run e2e:ui` 连续两次均为五视口 `5/5` 通过；两次结束后的 `34173` 监听数均为 `0`，未再出现端口占用。

本切片回归：

- 全量 client：46 个测试文件、`390/390` 通过。
- `npm run e2e:typecheck`：通过；runner 的依赖注入声明已收窄为实际使用的 Vite 和 child-process 契约。
- `npm run build`：TypeScript 与 Vite 生产构建通过；只保留既有 PDF.js `531.35 kB` chunk 警告。
- Phase 1 Platform Playwright：desktop identity `1/1`、desktop project/session `2/2`、mobile identity `1/1`，合计 `4/4` 通过。
- Platform 退出后 `.cache/platform-e2e/state.json` 不存在，`24172/24173` 监听均为 `0`，`pdf_approval_e2e_%` 测试数据库为 `0`。

当前边界：

- Phase 2 尚未完成；本切片只收口 DS2 公共组件中的 Actions、Forms、Feedback 以及 Platform Identity 调用点。
- 下一切片继续迁移 legacy Login/Profile/Submit，然后实现 Overlays、DS3 AppShell 和 DS4 数据组件及业务页面迁移。

### DS2 legacy Login / Profile / Submit 调用点迁移

- legacy 登录、个人资料和提交图纸已改用共享 Actions、Forms、Feedback；页面源码不再自建 input/select/textarea，也不再使用 `.secondary-button`、`.error`、`.success` 或 `.success-message` 表达公共语义。
- 批量文件选择行保留领域专用按钮 DOM，避免公共 Button 的内容包装破坏文件名、状态和错误信息网格；页面级提交、重置、模板、快捷账号和资料动作均已迁移。
- 聚焦迁移与既有布局测试：5 个文件、`24/24` 通过；全量 client 更新为 47 个文件、`392/392` 通过。生产构建通过，只保留既有 PDF.js `531.35 kB` 警告。
- legacy Playwright 登录/角色入口在 desktop/mobile 共 `10/10` 通过，覆盖管理员、主管、工艺、设计师落点和登录页 critical axe 门禁；退出后 `14173/18080` 监听均为 `0`。
- 使用真实浏览器人工检查 desktop 登录、提交、个人资料和 `390×844` mobile 登录；控件无溢出，字段可访问名称、密码显示按钮、空状态和禁用原因均正确暴露。

### DS2 Overlay 公共层与调用点迁移

- 新增 `Dialog`、`ConfirmDialog`、`Drawer`、`Popover`、`Tooltip`；Modal/Drawer 统一管理初始焦点、Tab 环、Escape、body 滚动锁和关闭后的焦点回归，手机使用全宽底部 Dialog 或全屏 Drawer。
- 桌面更新、签名必配、打印设置、管理端系统清理和 PDM 历史回填已迁移到公共浮层；打印设置同步迁移到共享 Actions/Forms/Feedback。
- 旧 `.desktop-update-*` 容器、`.signature-required-*`、`.print-settings-backdrop/dialog/header/check/actions` 在生产调用点零引用后删除；更新下载进度和打印表单的领域布局样式保留。
- Overlay 与迁移聚焦回归：7 个文件、`44/44` 通过；全量 client 更新为 49 个文件、`396/396` 通过，`e2e:typecheck` 和生产构建通过。
- Gallery 五视口交互验证 Dialog/Drawer 初始焦点、Escape 关闭、焦点回归和 Popover Escape；更新基线后非更新模式 `5/5` 通过，`34173` 监听为 `0`。桌面与手机截图已人工检查；当前大小为 desktop `245403`、compact `240070`、landscape `238445`、portrait `241343`、mobile `228479` bytes。

### DS3 AppShell、导航与页面模式

- `App.tsx` 不再拥有 sidebar/nav/user DOM；新 `AppShell` 只接收品牌、已过滤导航、用户显示信息和内容，`AppNavigation` 不认识角色权限，权限仍由 `roleAccess` 先行过滤。
- 当前页统一使用 `aria-current="page"`；桌面展开宽度 `232px`、收起宽度 `64px`，平板/手机切换为顶部横向任务流。管理员、主管、工艺和设计师原有落点不变；主管/工艺入口文案由“待我审核”统一为“我的任务”。
- 新增 `PageHeader`、`Breadcrumbs`、`Tabs`、`SegmentedControl` 和 `FilterBar`；MyTasks 首个迁移为“我的任务”页面标题与统一错误反馈。Gallery 增加 DS3 页面壳层样例。
- AppShell 迁移后，全局 `styles.css` 中旧 `.app-layout/.sidebar/.brand/.side-nav/.user-panel/.ghost-button/.content-area/.app-shell/.skip-link` 及其响应式规则共删除 522 行；新实现只使用 CSS Modules 和语义令牌。
- 聚焦 DS3 组件测试 `16/16` 通过；全量 client 更新为 52 个文件、`400/400` 通过，`e2e:typecheck`、生产构建和 `git diff --check` 通过。
- legacy Playwright 完整非更新模式：desktop/mobile 共 22 项，`21` 通过，mobile-only 的 desktop 64px 契约用例按设计跳过 `1`；desktop 断言动画稳定后精确为 `64px`。退出后 `14173/18080` 监听均为 `0`。
- 四份 AppShell/PDF 工作台视觉基线已在真实浏览器人工复核并更新；desktop admin `125186`、mobile admin `117602`、desktop workbench `120741`、mobile workbench `148104` bytes。
- Gallery DS0–DS3 更新后非更新模式五视口 `5/5` 通过，截图已人工复核；当前大小为 desktop `281878`、compact `275865`、landscape `273396`、portrait `275733`、mobile `261986` bytes。

## 2026-07-14 Phase 2 Task 9–12：DS4 数据页与阶段验收（完成）

实现范围：

- 新增业务无关的 `StatusChip`、`Badge`、`KeyValueList`、`TableFrame`、`DataTable`、`Pagination`、`Timeline`、`FileLink`、`HashValue` 和 `BatchActionBar`。`DataTable` 不请求数据；审批和 PDM 状态均在页面或领域适配层映射为 `label/tone`。
- `DataTable` 覆盖固定表头、受控选择、全选/部分选择、行键盘进入、loading/empty/error、重试、手机卡片字段和 `mobileHidden` 领域配置；手机批量操作栏固定在可触达位置。
- MyTasks、Approvals 和共享 ApprovalTable 已迁移。审批台账继续保留延迟关键词请求、筛选、分页、批量签后 PDF、打印归档、管理员删除和行进入；单删、批删、打印归档均改用 `ConfirmDialog`。
- PDM Parts、Pending Metadata、Part Detail 已迁移。零件库保留风险队列、查询、分页和详情入口；待补录使用 Drawer 快速补录；详情页使用 DataTable、FileLink、HashValue 和 Timeline，并把版本作废改为 `ConfirmDialog`。
- Settings 使用统一 PageHeader/Tabs；用户、签名模板和 Operations 操作日志迁移到 DataTable。模板删除改用 `ConfirmDialog`；表格内字段使用带隐藏视觉标签的公共表单控件。
- 删除零引用的 `.data-table`、`.approval-table`、`.pdm-table`、`.table-action-bar`、`.pagination-bar`、`.user-table`、`.template-table`、`.operation-table` 和 `.operation-log-panel` 公共实现及其响应式分支。

TDD 与静态门禁：

- DS4 初始测试先因 `src/client/ui/data/index.tsx` 不存在得到预期 RED；最小实现后数据组件 `4/4` 通过。
- 迁移聚焦回归：审批切片 `22/22`，PDM 与数据组件 `14/14`，Settings/Forms/Overlay 聚焦 `15/15`。
- 全量 client：53 个测试文件、`405/405` 通过。
- `npm run e2e:typecheck`：通过。
- `npm run build`：通过；仍只有既有 `assets/pdf-CJRVEglZ.js` `531.35 kB` 超过 500 kB 的 PDF.js chunk 警告。
- 新 DS4 CSS/组件扫描：硬编码颜色 `0`、任意 z-index `0`、公共组件中的审批/PDM/WebDAV 业务词 `0`；旧表格选择器生产引用 `0`；`git diff --check` 通过。

真实浏览器与运行时验收：

- Gallery E2E 已升级为 DS0–DS4：先因旧阶段标识得到五视口有效 RED；新增表格选择、状态、分页和手机字段断言后，1440×900、1280×800、1024×768、768×1024、390×844 非更新模式 `5/5` 通过。
- Gallery 每个视口均验证无横向溢出、axe serious/critical `0`、控制台 error `0`、reduced motion、Dialog/Drawer/Popover 焦点契约，以及桌面全选和移动端逐行选择。五张截图已人工检查；大小依次为 desktop `345429`、compact `338019`、landscape `334355`、portrait `346498`、mobile `329493` bytes。
- Electron：3 个测试文件、`12/12` 通过。
- legacy Playwright：22 项，`21 passed / 1 skipped`；跳过项仅为 mobile 项目不适用 desktop 64px 契约。系统管理桌面/手机实际截图人工检查后更新，完整非更新模式复测稳定。
- Platform Playwright：desktop identity `1/1`、desktop project/session `2/2`、mobile identity `1/1`，合计 `4/4` 通过。
- 最终退出后 `14173/18080/24173/28080/34173/58026` 监听均为 `0`，Platform state 文件不存在。

Phase 2 结论：

- DS0–DS4、统一 AppShell、公共 Actions/Forms/Feedback/Overlays/Navigation/Data 组件及计划内业务页迁移全部完成。
- Phase 2 验收闭环；PDF Studio 专用三栏工作台继续进入 Phase 3，未在本阶段越界修改。
