# PDF 图纸审批系统第一版实现总结

日期：2026-06-16

## 项目目标

为 5-10 人机械设计团队搭建一个仅在公司局域网内使用的 PDF 图纸审批系统，减少设计图纸反复打印造成的纸张浪费。

团队使用坚果云同步文件。设计师导出 PDF 后放入指定目录，系统自动生成审批任务，由固定主管和固定工艺人员并行审核。两人通过后，图纸进入待打印归档流程。

## 第一版范围

已实现一个可运行的局域网 Web 系统，包含：

- Windows 本机服务
- React 前端工作台
- Express 后端接口
- SQLite 本地数据库
- 坚果云本地目录监听
- PDF 预览和审批
- 管理端配置、用户、日志
- Windows 桌面通知和邮件通知预留

## 核心流程

1. 管理员配置审批根目录。
2. 系统创建标准目录：
   - `01-待提交`
   - `02-审批中`
   - `03-已驳回`
   - `04-已通过待打印`
   - `05-已打印归档`
3. 设计师放入 PDF：
   - 标准方式：`审批根目录\01-待提交\项目名\零件名-a0A0.pdf`
   - 简化方式：`审批根目录\零件名-a0A0.pdf`
4. 系统解析文件名并生成审批单。
5. 系统移动文件到 `02-审批中`。
6. 主管和工艺并行审核。
7. 任一人驳回后进入 `03-已驳回`。
8. 两人均通过后进入 `04-已通过待打印`。
9. 打印人员或管理员标记已打印后进入 `05-已打印归档`。

## 文件命名规则

当前支持：

```text
零件名-a数字A数字.pdf
```

示例：

```text
301新光纤-a0A0.pdf
301新光纤-a1A0.pdf
```

其中：

- `a1` 表示小版本。
- `A0` 表示大版本。

不符合命名规则的文件会记录为 `文件名异常`，不会进入正常审核。

## 用户与权限

默认用户：

```text
admin / admin123
supervisor / 123456
process / 123456
printer / 123456
```

角色：

- `admin`：系统管理、审批、打印归档
- `supervisor`：主管审核
- `process`：工艺审核
- `printer`：打印归档
- `designer`：预留设计师角色

管理端已支持：

- 用户列表
- 新增用户
- 修改姓名、邮箱、角色、启用状态
- 重置密码
- 防止停用最后一个启用管理员

## 前端页面

主要页面：

- 登录页
- 待我审核
- 全部图纸
- 图纸详情
- 系统管理

系统管理包含：

- 目录与通知
- 用户管理
- 服务日志

设计方向：

- 面向机械设计团队的内部工具。
- 工业化、安静、密集、可扫描。
- 左侧深色导航、状态芯片、版本徽标、图纸元信息条。

## 目录选择策略

Windows 后台服务直接弹出系统文件夹选择窗口不稳定，因此第一版提供三种方式：

- 手动填写路径
- 浏览服务器目录
- 系统弹窗选择

推荐使用 `浏览服务器目录`。

浏览器 File System Access API 只能拿到浏览器本机目录句柄，不能返回后端可监听的 Windows 绝对路径，因此只作为辅助说明，不作为主要配置方式。

## 文件监听与同步策略

第一版使用 `chokidar@4` 监听审批根目录。

已处理的问题：

- `chokidar@4` 不可靠支持旧式 glob，因此改为监听根目录后在代码中过滤 `.pdf`。
- 支持根目录直接放 PDF，自动归入 `默认项目`。
- 已管理状态目录不会被重复处理。
- 新增 10 秒兜底扫描，补偿坚果云同步目录可能漏掉的新增事件。
- 删除审核中文件时，审批单标记为 `file_missing`，不会继续出现在待审核队列。
- 服务离线期间删除文件，重启后也会通过兜底扫描标记为 `file_missing`。

## PDF 有效性处理

已增加 PDF 文件头校验：

- 有效 PDF 必须以 `%PDF-` 开头。
- 扩展名为 `.pdf` 但内容不是 PDF 时，接口返回 `INVALID_PDF_FILE`。
- 前端详情页显示中文诊断和服务器文件路径，避免只显示浏览器原生加载错误。

## 通知策略

第一版包含：

- 邮件通知：通过 SMTP 配置发送给主管和工艺。
- Windows 桌面通知：待办页有新增审批任务时提醒。

已修复：

- 待办页不再每次进入都重复弹通知。
- 当前按审批 ID 使用 `localStorage` 去重，同一浏览器内只对新增待办弹通知。

## 关键技术决策

### 数据库

最初尝试 `better-sqlite3`，但在 Windows + Node 24 环境下需要 Visual Studio C++ 编译工具，安装失败。

第一版改用 Node 24 内置 `node:sqlite`，避免原生依赖编译问题。

### 服务重启

管理员配置监听目录后需要重启服务才能重新建立 watcher。

第一版实现：

- `POST /api/system/restart`
- 应用以退出码 `42` 退出
- `scripts/dev-server.mjs` supervisor 自动拉起新进程

注意：便捷重启依赖通过 `npm run dev` 或同等 supervisor 启动。

### 数据迁移

审批状态新增 `file_missing` 后，旧 SQLite 表的 CHECK 约束需要迁移。

第一版已实现启动时无损重建 `approvals` 表约束。

## 主要代码位置

后端：

- `src/server/server.ts`
- `src/server/db.ts`
- `src/server/schema.sql`
- `src/server/routes/approvals.ts`
- `src/server/routes/settings.ts`
- `src/server/routes/system.ts`
- `src/server/routes/users.ts`
- `src/server/files/watchSubmissions.ts`
- `src/server/files/fileLocations.ts`
- `src/server/files/pdfValidation.ts`
- `src/server/repositories/approvals.ts`
- `src/server/repositories/users.ts`

前端：

- `src/client/App.tsx`
- `src/client/api.ts`
- `src/client/pages/SettingsPage.tsx`
- `src/client/pages/ApprovalDetailPage.tsx`
- `src/client/pages/MyTasksPage.tsx`
- `src/client/widgets/ApprovalTable.tsx`
- `src/client/widgets/StatusChip.tsx`
- `src/client/notifications.ts`
- `src/client/styles.css`

脚本：

- `scripts/dev-server.mjs`
- `scripts/start-server.ps1`
- `scripts/install-startup-task.ps1`

文档：

- `docs/verification.md`
- `docs/deploy-windows-lan.md`
- `docs/plans/2026-06-16-pdf-approval-design.md`
- `docs/plans/2026-06-16-pdf-approval-implementation-plan.md`

## 验证结果

最新验证：

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

- 当前监听目录：`G:\Personal documents\code\PDF审批\test`
- 新增标准目录下 PDF 后，系统能生成审批单并移动到 `02-审批中`
- 删除审核中文件后，状态变为 `file_missing`
- 当前服务运行在 `http://127.0.0.1:8080`

## 已知限制

- 生产部署建议通过 Windows 启动脚本或任务计划程序托管服务。
- 邮件通知依赖有效 SMTP 配置和审核人邮箱。
- 当前没有 CAD 原始文件管理，只管理导出的 PDF。
- 当前权限模型适合小团队固定流程，尚未实现按项目动态配置审核人。
- Windows 系统弹窗选择目录在后台服务模型下仍不可靠，推荐使用服务器目录浏览。
- 桌面通知去重存储在浏览器本地，换浏览器或清理本地数据后会重新通知已有待办。

## 后续建议

优先级较高：

- 增加“重新提交/替换文件”流程，处理 `file_missing` 和 `INVALID_PDF_FILE`。
- 增加管理端审批单手动修复能力，如标记作废、重新扫描、重新绑定文件。
- 增加操作审计日志表，记录谁在何时审核、归档、重置状态。
- 增加邮件配置测试按钮。

可延后：

- 按项目配置审核人。
- PDF 在线批注。
- 与坚果云 WebDAV 或企业 IM 集成。
- Windows 托盘程序或 Electron 外壳。
