# PDF 图纸审批系统

面向 Windows 局域网团队的 PDF 图纸审批系统，用于设计师提交图纸、主管与工艺并行审核、自动签名、批注归档、打印归档、客户端更新和服务端运维管理。

当前固化版本：`0.9.2`

## 主要能力

- 设计师网页/客户端上传 PDF，写入标准审批目录。
- 主管和工艺并行审核，支持图纸预览、批注、评论、时间线和历史追溯。
- 审批通过后生成签名版 PDF，支持设计师、主管、工艺手写签名定位。
- 审批通过后支持调用打印，打印成功后进入归档。
- 管理员维护用户、目录、SMTP、日志、备份、清理、客户端更新清单。
- Electron 客户端、服务端 EXE 与 Windows 安装包打包流程。

## 技术栈

- Node.js 24
- TypeScript
- Express
- React + Vite
- 内置 `node:sqlite`
- Electron
- Vitest / Supertest

## 本地开发

```powershell
npm install --registry=https://registry.npmmirror.com
npm run dev
```

默认访问：

- Web/API：`http://127.0.0.1:8080`

## 常用验证

```powershell
npm test
npm run build
npm run desktop:test
```

## 打包发布

```powershell
npm run installer:package
```

打包流程会生成客户端、服务端安装包和更新清单。当前真实运行服务端的发布同步目录为：

```text
E:\PDF服务端\pdf-approval\releases
```

## 仓库边界

首次提交只保留源码、测试、文档、脚本和图标资源。以下内容不进入 Git：

- `node_modules/`
- `dist/`
- `data/`
- `backups/`
- `logs/`
- 根目录 `test/` 图纸工作区
- 本地配置、数据库、安装包、缓存、运行日志和 PID 文件

## 关键文档

- `docs/user-manual.md`：各角色使用说明书
- `docs/deploy-windows-lan.md`：Windows 局域网部署说明
- `docs/desktop-client-admin-guide.md`：客户端/更新管理说明
- `docs/verification.md`：阶段验证记录
- `docs/plans/2026-06-29-pdm-plm-roadmap.md`：PDM/PLM 后续路线图
