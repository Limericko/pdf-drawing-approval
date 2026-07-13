# Phase 2 UI Design System and App Shell Implementation Plan

- 日期：2026-07-13
- 状态：执行中
- 分支：`codex/phase-2-ui-design-system`
- 前置门禁：Phase 0、Phase 1 已完成并通过真实浏览器验收
- 视觉方向：精密工业、文档优先、高密度、安静、可扫描

## 目标

在不更换 React、TypeScript、Vite、Express 和 Lucide 的前提下，把现有 6180 行全局样式和页面自建控件迁移为仓库内生设计系统，并建立统一 AppShell、角色入口和数据页面基础。Phase 2 交付 DS0 至 DS4；PDF Studio 专用三栏工作台留在 Phase 3。

## 本阶段边界

本阶段包含：

- DS0：UI Gallery、五视口基线、axe、溢出和控制台门禁。
- DS1：令牌、reset、globals、motion 和旧令牌兼容映射。
- DS2：Actions、Forms、Feedback 公共组件与首批页面迁移。
- DS3：AppShell、AppNavigation、PageHeader、Tabs、FilterBar 和角色入口。
- DS4：TableFrame、DataTable、Pagination、StatusChip 和批量动作栏。
- 每次迁移完成后删除对应旧调用点和旧选择器。

本阶段不包含：

- PDF Studio 画布、三栏工作台和问题状态机重构。
- 审批、PDM、WebDAV 领域数据迁移。
- SQLite 正式数据迁移、香港云资源创建或生产切换。
- Tailwind、shadcn、CSS-in-JS 或其他运行时 UI 框架。

## 不可破坏约束

- legacy 与 platform 两种运行模式继续可用。
- 新公共组件不得请求数据或认识审批、PDM、WebDAV 业务状态。
- 新代码只使用语义令牌或组件令牌，不新增硬编码颜色和任意 z-index。
- Gallery 只在开发/测试 Vite 中启用，不进入生产导航。
- 所有图标按钮必须有可访问名称；所有状态不能只靠颜色表达。
- 每个垂直切片执行“RED 测试 → 最小实现 → 浏览器验证 → 删除旧实现”。

## Task 1：建立 DS0/DS1 边界和令牌基础

目标文件：

- `src/client/styles/tokens.css`
- `src/client/styles/reset.css`
- `src/client/styles/globals.css`
- `src/client/styles/motion.css`
- `src/client/main.tsx`
- `src/client/styles.css`
- `src/client/styles/designSystemFoundation.test.ts`

步骤：

1. 先写测试，要求设计令牌完整、主入口按固定顺序加载、旧 `styles.css` 不再拥有 `:root`。
2. 写入颜色、字体、间距、控件尺寸、圆角、阴影、层级、焦点和动效令牌。
3. 为未迁移页面保留旧变量别名，但别名只能指向新令牌。
4. 把 reset、body、全局排版和 reduced-motion 从旧文件迁出。
5. 保持业务选择器不动，运行全量 client 与构建门禁。

退出条件：新令牌成为唯一基础视觉来源；旧页面仍可运行；没有新增运行时依赖。

## Task 2：建立开发专用 UI Gallery 和五视口门禁

目标文件：

- `src/client/dev/UiGallery.tsx`
- `src/client/dev/UiGallery.module.css`
- `src/client/dev/UiGallery.test.tsx`
- `e2e/ui-gallery/ui-gallery.spec.ts`
- `playwright.ui.config.ts`
- `package.json`

步骤：

1. 先写 Gallery 入口、生产隔离和内容语义测试。
2. Gallery 首批展示颜色、排版、间距、稳定尺寸、圆角、阴影和深浅表面焦点。
3. 使用独立 Vite 端口，不连接 legacy/platform API。
4. 建立 1440×900、1280×800、1024×768、768×1024、390×844 五个项目。
5. 每个视口验证无横向溢出、无 serious/critical axe 违规、控制台无 error，并生成稳定截图。
6. 人工检查桌面与手机截图后才接受基线。

退出条件：DS0 基线可重复运行，Gallery 不出现在生产导航和生产运行路径。

## Task 3：Actions 基础组件

目标目录：`src/client/ui/actions/`

组件：`Button`、`IconButton`、`ButtonLink`、`ButtonGroup`。

迁移顺序：platform identity → 登录页 → 个人资料 → 提交图纸。

必测状态：primary/secondary/ghost/danger、sm/md、loading、disabled、键盘焦点、长文案、icon-only。`IconButton.label` 必填，loading 保持宽度。

退出条件：首批页面不再使用 `.secondary-button`、`.ghost-button`、`.icon-text-button` 和 `.danger-lite`；对应旧选择器零引用后删除。

## Task 4：Forms 基础组件

目标目录：`src/client/ui/forms/`

组件：`Field`、`TextInput`、`PasswordInput`、`TextArea`、`Select`、`Checkbox`、`RadioGroup`、`Switch`、`NumberInput`、`FormActions`。

迁移顺序：platform 登录/MFA/邀请 → legacy 登录 → Profile → Submit Drawing。

退出条件：label、description、error 关联正确；错误使用 `aria-describedby`/`aria-invalid`；390px 下触控目标至少 44px。

## Task 5：Feedback 基础组件

目标目录：`src/client/ui/feedback/`

组件：`InlineAlert`、`Toast`、`SaveIndicator`、`Progress`、`Skeleton`、`EmptyState`、`ErrorState`、`ConnectionBanner`。

迁移顺序：platform identity → Runtime loading/fatal → 登录/Profile/提交反馈。

退出条件：不再用 `.error/.success/.notice` 表达多种语义；加载、空、错误、重试和离线状态进入 Gallery 与浏览器测试。

## Task 6：Overlay 基础组件

目标目录：`src/client/ui/overlays/`

组件：`Dialog`、`ConfirmDialog`、`Drawer`、`Popover`、`Tooltip`。

迁移顺序：桌面更新 → 签名提示 → 打印设置 → 管理危险确认。

退出条件：初始焦点、Escape、焦点回归、背景滚动和手机全宽布局通过真实浏览器测试。

## Task 7：统一 AppShell 和导航

目标目录：

- `src/client/patterns/AppShell/`
- `src/client/ui/navigation/`
- `src/client/patterns/PageHeader/`
- `src/client/patterns/FilterBar/`

步骤：

1. 从 `App.tsx` 提取无业务 AppShell 和权限过滤后的 AppNavigation。
2. 统一 PageHeader、Breadcrumbs、Tabs、SegmentedControl、用户菜单和更新入口。
3. platform 与 legacy 使用同一壳层视觉和交互契约，数据加载仍各自隔离。
4. 为设计师、主管、工艺、管理员建立角色首页入口和“我的任务/问题中心”稳定导航位置。
5. 验证展开、64px 收起、平板紧凑导航和手机任务流。

退出条件：`App.tsx` 不再拥有侧栏 DOM 和基础视觉；当前页使用 `aria-current="page"`；长标签和权限隐藏通过测试。

## Task 8：迁移身份与个人工作流

目标目录：`src/client/features/identity/`、`src/client/features/profile/`。

步骤：使用 Actions、Forms、Feedback、AppShell 迁移登录、邀请、MFA、恢复码、项目访问和个人资料；删除 `platformIdentity.css` 中已迁移的基础规则。

退出条件：Phase 1 Platform E2E 4/4 保持通过；登录、邀请、MFA 五视口无 serious/critical 违规。

## Task 9：数据展示基础组件

目标目录：`src/client/ui/data/`。

组件：`StatusChip`、`Badge`、`KeyValueList`、`TableFrame`、`DataTable`、`Pagination`、`Timeline`、`FileLink`、`HashValue`。

要求：DataTable 不请求数据、不认识业务；领域 presentation 文件把业务状态映射为 label/tone；手机由领域页面选择关键字段列表。

退出条件：loading/empty/error/selection/sticky header/分页/移动布局进入 Gallery 与浏览器门禁。

## Task 10：迁移图纸、任务和 PDM 数据页

迁移顺序：MyTasks → Approvals → PDM Parts → PDM Pending Metadata → PDM Part Detail。

步骤：统一 PageHeader、FilterBar、TableFrame、DataTable、StatusChip 和批量动作；保留现有业务请求和路由；逐页删除旧表格、标签页和状态 class。

退出条件：核心角色流程保持通过；页面在五视口下无不可解释横向溢出；旧表格基础选择器零引用。

## Task 11：迁移管理入口并完成 DS4 清理

范围：Settings 导航外壳、用户、权限、日志和诊断列表的基础组件迁移。复杂 WebDAV 同步中心留给 Phase 5，PDF Studio 管理面板留给 Phase 3。

退出条件：管理页使用统一标题、Tabs、Feedback、DataTable 和危险确认；不新增卡片嵌套；旧公共选择器按删除门禁清理。

## Task 12：Phase 2 最终验收

必须执行：

```powershell
npm test -- --run src/client
npm run e2e:typecheck
npm run build
npm run desktop:test
npm run e2e:ui
npm run e2e
npm run e2e:platform
git diff --check
```

最终检查：

- UI Gallery 覆盖所有已落地公共组件状态。
- 五个固定视口通过截图、axe、键盘、reduced motion 和溢出门禁。
- Phase 0 legacy Playwright 20 项和 Phase 1 Platform E2E 4 项保持通过。
- 新代码硬编码颜色、任意 z-index 和新增全局业务 class 扫描为零。
- DS0 至 DS4 调用点完成迁移；旧实现只有零引用后才能删除。
- `docs/verification.md` 写入真实命令、数量、警告和未完成边界。

## 当前执行切片

本轮先完成 Task 1 和 Task 2。Task 3 只有在 DS0/DS1 的浏览器基线稳定后开始。
