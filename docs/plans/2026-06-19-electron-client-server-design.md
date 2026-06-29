# V5 Electron 客户端 / 服务端方案设计

## 目标

V5 改为 Electron 客户端 + 局域网服务端。

服务端继续运行现有 Express/SQLite/坚果云监听/自动签名能力，部署在办公室内一台常开的 Windows 电脑上。团队成员电脑安装 Electron 客户端，通过配置的局域网地址访问审批 API 和 PDF 文件。

这版不再把 Tauri 托盘助手作为主线。`apps/tray-helper` 可保留为历史试验和参考，但正式客户端新增 `apps/desktop-client`。

## 取舍

### 推荐方案：打包现有 React 前端为 Electron 客户端

客户端内置现有 React/Vite 前端，首次启动配置服务端地址，例如：

```text
http://192.168.1.20:8080
```

之后所有 `/api`、`/health`、PDF 预览、签后 PDF、签名图片和 CSV 下载都按该地址请求服务端。

优点：

- 符合“客户端 + 服务端”的使用感。
- 不需要 Rust/MSVC/Tauri 工具链。
- 不直接访问 SQLite、坚果云目录或本机文件，业务边界清晰。
- 浏览器访问 `http://服务器IP:8080` 仍可作为备用入口。

代价：

- 前端 API URL 需要从“同源相对路径”改成“可配置服务端地址”。
- Electron 首次启动需要连接配置页。
- 打包时需要安装 Electron 依赖。

### 备选方案：Electron 只打开服务端网页

客户端启动后直接加载 `http://服务器IP:8080`。

优点是改动很小；缺点是客户端基本只是浏览器壳，无法在服务不可用时提供本地配置体验，也不利于后续离线诊断、版本提示和本机能力扩展。

## 架构

```text
审批服务器 Windows PC
  npm run dev / Windows 启动任务
  Express API
  SQLite 数据库
  坚果云审批根目录监听
  PDF 签名与归档
  Web 备用入口 http://服务器IP:8080

设计师 / 主管 / 工艺 / 管理员电脑
  Electron 客户端
  本地 React 前端
  本机保存 serverUrl
  HTTP 调用 http://服务器IP:8080/api
```

## 组件

### `src/client`

继续作为唯一审批工作台前端。

新增：

- 客户端 API 地址配置模块。
- Electron 连接配置页或登录页内连接配置区。
- 所有文件 URL 统一走 API 地址拼接函数。

Web 模式默认仍使用同源相对路径，保持 `http://服务器IP:8080` 浏览器访问可用。

### `apps/desktop-client`

新增 Electron 子应用。

建议结构：

```text
apps/desktop-client/
  package.json
  main.cjs
  preload.cjs
  desktopConfig.cjs
  desktopConfig.test.cjs
```

职责：

- 创建主窗口。
- 加载打包后的 `dist/client/index.html`。
- 首次启动和菜单提供服务端地址配置能力。
- 用 `app.getPath("userData")` 保存客户端配置。
- 通过 preload 暴露最小安全桥接接口。

不做：

- 不直接读写审批数据库。
- 不监听坚果云文件夹。
- 不生成或修改 PDF。
- 不保存密码。

## 数据流

首次启动：

1. Electron 读取本机配置。
2. React 前端读取预加载的 `serverUrl`。
3. 若没有服务端地址，显示连接配置。
4. 用户输入 `http://服务器IP:8080`。
5. 客户端请求 `GET /health`。
6. 校验通过后保存地址并进入登录。

日常启动：

1. Electron 打开内置前端。
2. 前端使用保存的 `serverUrl` 请求 `/api/auth/login`、`/api/approvals` 等接口。
3. token 仍保存在前端本机 `localStorage`。
4. 退出登录只清 token，不清服务端地址。

服务端地址变更：

1. 登录页或客户端菜单打开连接配置。
2. 修改后重新健康检查。
3. 保存新地址。
4. 清理旧 token，重新登录。

## 安全边界

- Electron renderer 禁用 `nodeIntegration`。
- preload 只暴露读取/保存服务端地址、读取客户端版本等有限方法。
- API 权限仍由后端 JWT 和角色控制。
- 客户端不接触 SMTP 密码、SQLite 文件、签名生成私有逻辑。
- 服务端 CORS 允许本地 Electron/开发来源，但不开放任意外网域名。

## 错误处理

- 服务端地址为空：显示连接配置。
- 地址格式错误：提示必须是 `http://` 或 `https://`。
- `/health` 不通：提示检查服务端是否启动、防火墙、IP 是否正确。
- 登录返回 401：显示账号或密码不正确。
- 登录返回网络错误：显示无法连接审批服务器。
- 文件 URL 打开失败：保持现有 PDF 无效、文件丢失和签名失败提示。

## 打包与部署

第一阶段先实现可运行开发版：

```powershell
npm run build
npm run desktop:dev
```

第二阶段再做安装包：

```powershell
npm run desktop:package
```

上线方式：

1. 审批服务器部署现有服务，确认 `http://服务器IP:8080/health` 可访问。
2. 在团队电脑安装 Electron 客户端。
3. 首次启动填写服务器地址。
4. 用各自账号登录。
5. 完成提交、审核、签名、打印归档冒烟。

## 验收标准

- Electron 客户端能启动并加载审批工作台。
- 首次启动可配置服务端地址。
- 服务端地址错误时有明确提示。
- 配置正确后能登录。
- PDF 预览、签后 PDF、签名图片、CSV 下载都请求配置的服务端地址。
- Web 浏览器同源访问模式不受影响。
- `npm test` 和 `npm run build` 通过。
- Electron 客户端至少能通过开发启动验证。

## 风险

- Electron 体积大于 Tauri，但换来更低 Windows 工具链成本。
- 公司电脑若安全策略限制 Electron 程序访问局域网，需要在防火墙或白名单中放行。
- 客户端与服务端版本不一致时可能出现接口不兼容，正式发布时应同步升级服务端和客户端。
