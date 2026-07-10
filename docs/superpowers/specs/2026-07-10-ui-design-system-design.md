# 工程图纸协同平台 UI 设计系统重构设计

- 日期：2026-07-10
- 状态：设计补充稿，待书面审阅
- 适用范围：React Web、Electron 内嵌 Web、PDF Studio
- 关联总规格：`2026-07-10-engineering-drawing-collaboration-refactor-design.md`
- 视觉方向：精密工业

## 1. 结论

本项目需要建立一套仓库内生的轻量 UI 设计系统，用于替换当前单体全局 CSS、重复按钮样式、重复状态表达和各页面自建的表格、标签页、反馈与弹层。

设计系统继续使用现有 React、TypeScript、Vite 和 Lucide，不引入 Tailwind、shadcn、CSS-in-JS、运行时主题库或另一套组件框架。样式使用 CSS Variables、CSS Modules 和少量全局基础样式。这样既能保持现有技术栈和打包方式，也能让样式边界从“全站共享选择器”迁移为“令牌 + 组件 + 领域样式”。

设计系统不是独立产品，也不建设通用组件平台。它只服务当前工程图纸协同平台，优先覆盖已经重复出现或会贯穿重构的模式。业务特有组件保留在领域模块，不强行抽象成万能组件。

## 2. 当前问题

### 2.1 样式集中且边界模糊

`src/client/styles.css` 已超过 6000 行，包含：

- 全局基础样式。
- 应用侧栏与登录页。
- 表单、按钮、标签页和表格。
- 审批详情和 PDF 工具。
- PDM 页面。
- 管理后台和运维面板。
- 多组响应式覆盖。

页面和组件依靠全局 class 组合获得外观。一个选择器的调整可能影响不相关页面，旧选择器也难以判断能否删除。

### 2.2 相同语义存在多套实现

当前可见重复包括：

- 按钮：原生按钮、`.secondary-button`、`.ghost-button`、`.icon-text-button`、`.danger-lite`。
- 反馈：`.error`、`.success`、`.notice`、`.success-message`、`.error-box`。
- 标签页：`.admin-tabs`、`.detail-support-tabs`、`.pdm-tab-list`、`.segmented-control`。
- 表格：`.table-surface`、`.data-table`、`.approval-table`、`.pdm-table` 及多个领域表格。
- 弹层：打印设置、桌面更新、签名提示和浮动支持面板各自定义结构。
- 空状态和加载状态在页面内重复组织。

这些实现外观相近，但状态、可访问性、尺寸和响应式规则不完全一致。

### 2.3 测试偏向源码字符串

现有样式和布局测试能够保护特定选择器与源码结构，但不能证明：

- 页面在真实浏览器中无重叠和溢出。
- 键盘焦点、弹层焦点管理和可访问名称正确。
- 动态文字、错误状态、加载状态和长列表不会破坏布局。
- PDF 画布和缩略图真正渲染。

设计系统迁移必须保留必要的契约测试，并增加组件级真实浏览器和视觉回归证据。

## 3. 设计原则

### 3.1 产品优先

- 设计系统服务高频工程工作流，不追求营销页面效果。
- 信息密度可以较高，但层级、对齐和状态必须清楚。
- PDF、图纸、问题和任务是第一视口核心，不用装饰性内容抢占空间。
- 组件只在重复或共享行为真实存在时抽取。

### 3.2 单一视觉真相

- 颜色、间距、字号、圆角、阴影、焦点和层级只能来自令牌。
- 状态的文案与色调由集中映射产生，不允许各页面重新定义。
- 同一交互语义只能有一个基础组件实现。
- 领域页面可以组合组件，但不能复制其内部样式。

### 3.3 无业务的 UI 层

`ui` 目录中的组件：

- 不请求数据。
- 不读取业务角色。
- 不认识审批、PDM、WebDAV 等业务状态。
- 只通过 props、children 和事件工作。

业务映射和数据加载留在 `features` 或 `patterns`。

### 3.4 克制抽象

- 不建立万能 `Card`、万能表单生成器或万能页面配置 DSL。
- 不使用复杂多态 `as` API。
- 不为少于两处的领域结构创建公共组件。
- 不把普通页面区块包装成层层卡片。
- 组件 API 优先清晰、有限、可测试。

## 4. 目标目录结构

```text
src/client/
  styles/
    tokens.css
    reset.css
    globals.css
    motion.css
  ui/
    actions/
    forms/
    feedback/
    navigation/
    overlays/
    data/
    layout/
  patterns/
    AppShell/
    PageHeader/
    FilterBar/
    TaskList/
    SettingsSection/
  features/
    identity/
    tasks/
    documents/
    approvals/
    issues/
    pdm/
    sync/
    administration/
  pdf-studio/
    components/
    tools/
    viewport/
    annotations/
    issues/
  dev/
    UiGallery.tsx
```

规则：

- `styles` 只放全局基础和令牌。
- `ui` 放无业务基础组件，每个组件与自己的 CSS Module 同目录。
- `patterns` 放跨领域的组合模式。
- `features` 放领域页面、数据状态和业务展示映射。
- `pdf-studio` 是独立工作面，不把画布工具塞入通用 `ui`。
- `dev/UiGallery.tsx` 只在开发和测试构建启用，不进入生产导航。

## 5. 设计令牌

### 5.1 令牌分层

令牌分为三层：

1. 原始令牌：中性色、品牌色、间距和尺寸。
2. 语义令牌：表面、文字、边框、操作、危险、提醒、成功。
3. 组件令牌：控件高度、侧栏宽度、PDF 面板宽度等稳定尺寸。

组件只使用语义或组件令牌，不直接使用原始色值。

### 5.2 颜色

初始语义色值如下，实施时以浏览器对比度验证结果为准，但不得改变角色含义：

| 令牌 | 初始值 | 用途 |
|---|---:|---|
| `--color-chrome` | `#222c30` | 导航、PDF 工具区 |
| `--color-chrome-hover` | `#303c40` | 深色工具悬停 |
| `--color-workspace` | `#e7ecee` | 应用工作面 |
| `--color-surface` | `#ffffff` | 表格、表单、PDF 纸张 |
| `--color-surface-subtle` | `#f3f6f6` | 次级分区 |
| `--color-surface-raised` | `#f8faf9` | 弹层和固定工具区 |
| `--color-text` | `#172326` | 主文字 |
| `--color-text-muted` | `#627278` | 次要文字 |
| `--color-text-on-dark` | `#f4f8f8` | 深色区域文字 |
| `--color-border` | `#c5d0d3` | 默认边框 |
| `--color-border-strong` | `#aebdc1` | 控件与强调边框 |
| `--color-primary` | `#0d6f67` | 主操作、选择态 |
| `--color-primary-hover` | `#095b55` | 主操作悬停 |
| `--color-primary-active` | `#074a46` | 主操作按下 |
| `--color-primary-soft` | `#dcefeb` | 选择背景 |
| `--color-danger` | `#bd382e` | 正式问题、危险、阻断 |
| `--color-danger-soft` | `#fff0ee` | 危险背景 |
| `--color-warning` | `#b17a16` | 说明、提醒、同步异常 |
| `--color-warning-soft` | `#fff8e8` | 提醒背景 |
| `--color-success` | `#1f7a4d` | 完成和健康状态 |
| `--color-success-soft` | `#eaf6ef` | 成功背景 |
| `--color-info` | `#376f95` | 中性信息与链接 |
| `--color-info-soft` | `#edf4f8` | 信息背景 |

约束：

- 原色只出现在 `tokens.css`。
- 用户自定义批注颜色和 PDF 内容不受此限制。
- 红色不用于普通按钮或装饰。
- 不使用紫蓝渐变、装饰性光斑和单色页面。
- 所有文字与背景组合达到 WCAG 2.2 AA 对比度。

### 5.3 字体

产品不下载运行时 Web 字体，避免大体积中文字体影响首屏。使用系统字体栈：

```text
"Segoe UI Variable", "Microsoft YaHei UI", "PingFang SC",
"Noto Sans CJK SC", system-ui, sans-serif
```

CI 浏览器环境安装固定版本的 Noto Sans CJK SC，保证截图稳定。

字号和行高：

| 层级 | 字号/行高 | 字重 | 用途 |
|---|---:|---:|---|
| Caption | 12/18 | 400/500 | 时间、辅助信息 |
| Body small | 13/20 | 400/500 | 紧凑表格、工具说明 |
| Body | 14/22 | 400/500 | 默认正文和表单 |
| Label | 14/20 | 600 | 字段和控件标签 |
| Title small | 16/24 | 600 | 面板和区块标题 |
| Title | 20/28 | 600/700 | 页面次级标题 |
| Page title | 24/32 | 700 | 页面标题 |
| Login display | 36/44 | 700 | 仅登录入口品牌标题 |

统一规则：

- 字距为 `0`，不使用负字距。
- 不使用随视口宽度变化的字体大小。
- 数据列启用 `font-variant-numeric: tabular-nums`。
- 哈希、版本、路径和日志标识使用等宽字体栈。
- 标题使用 `text-wrap: balance`，正文使用 `text-wrap: pretty`。

### 5.4 间距与尺寸

间距令牌：

| 令牌 | 值 |
|---|---:|
| `--space-0` | `0` |
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `24px` |
| `--space-6` | `32px` |
| `--space-7` | `40px` |
| `--space-8` | `48px` |

稳定尺寸：

| 令牌 | 值 | 用途 |
|---|---:|---|
| `--control-height-sm` | `28px` | 紧凑表格工具 |
| `--control-height-md` | `36px` | 默认控件 |
| `--control-height-touch` | `44px` | 手机和触屏 |
| `--icon-button-sm` | `28px` | 紧凑工具栏 |
| `--icon-button-md` | `36px` | 默认图标按钮 |
| `--nav-width-expanded` | `232px` | 展开侧栏 |
| `--nav-width-collapsed` | `64px` | 收起侧栏 |
| `--pdf-thumbnails-width` | `112px` | PDF 左栏 |
| `--pdf-inspector-width` | `320px` | PDF 右栏 |
| `--content-max` | `1600px` | 普通业务页面上限 |

控件和动态内容不能改变工具栏、表格行、页码或 PDF 面板的稳定尺寸。

### 5.5 圆角、阴影和层级

圆角：

- `--radius-sm: 4px`
- `--radius-md: 6px`
- `--radius-lg: 8px`

除头像、批注定位点和圆形颜色样本外，不使用胶囊或 999px 圆角。

阴影只用于需要真实层级的弹层、抽屉和浮动工具：

- `--shadow-floating`
- `--shadow-dialog`
- `--shadow-document`

普通页面区块和表格不依赖阴影划分层级。

z-index 固定为：

- `--z-base: 0`
- `--z-sticky: 10`
- `--z-popover: 20`
- `--z-drawer: 30`
- `--z-dialog: 40`
- `--z-toast: 50`
- `--z-skip-link: 60`

领域 CSS 不允许出现任意 `9999` 等层级。

### 5.6 动效

- 快速状态：120ms。
- 默认交互：180ms。
- 抽屉和对话框：240ms。
- 只动画 `transform` 和 `opacity`，颜色可使用短过渡。
- 不动画布局宽高来掩盖内容变化。
- `prefers-reduced-motion: reduce` 下禁用非必要动画和顺滑滚动。

## 6. 组件层级与清单

### 6.1 Actions

| 组件 | 变体 | 必须状态 |
|---|---|---|
| `Button` | primary、secondary、ghost、danger | default、hover、active、focus、disabled、loading |
| `IconButton` | neutral、primary、danger | 同上，必须提供 accessible label 和 tooltip |
| `ButtonLink` | primary、secondary、ghost | 同 Button，不模拟禁用链接 |
| `ButtonGroup` | 仅布局组合 | 不改变子按钮语义 |

约束：

- 一个操作只能有一个主按钮。
- 熟悉工具动作优先使用 `IconButton`。
- `loading` 保持原宽度并阻止重复提交。
- danger 只用于不可逆或高风险动作。
- 不允许页面通过额外 class 重写按钮内部 padding、颜色或状态。

### 6.2 Forms

| 组件 | 职责 |
|---|---|
| `Field` | label、description、error、required 和控件关联 |
| `TextInput` | 文本、用户名、邮箱和搜索 |
| `PasswordInput` | 显示/隐藏、强度与自动完成语义 |
| `TextArea` | 多行内容和剩余字数 |
| `Select` | 中小选项集合 |
| `Checkbox` | 独立二元选择 |
| `CheckboxGroup` | 多选集合和错误关联 |
| `RadioGroup` | 少量互斥选项 |
| `Switch` | 立即生效的二元设置 |
| `NumberInput` | 数值、边界和步进 |
| `FileDropzone` | 上传、拖放、大小/类型提示和失败项 |
| `FormActions` | 保存、取消和危险动作的稳定布局 |

所有控件支持：

- default、hover、focus、disabled、readonly、invalid、loading。
- 明确 label，不依赖 placeholder 作为标签。
- 错误信息使用 `aria-describedby` 和 `aria-invalid`。
- 长中文标签可以换行，不挤压控件。

### 6.3 Feedback

| 组件 | 使用场景 |
|---|---|
| `InlineAlert` | 页面或表单内持续错误、警告和信息 |
| `Toast` | 非阻塞的短期操作反馈 |
| `SaveIndicator` | 保存中、已保存、失败、离线草稿 |
| `Progress` | 上传、下载、迁移和后台任务进度 |
| `Skeleton` | 匹配最终布局的加载占位 |
| `EmptyState` | 无数据且存在明确下一步 |
| `ErrorState` | 页面或区块加载失败及重试 |
| `ConnectionBanner` | 网络中断、服务维护和重连 |

禁止：

- 使用 `window.alert()` 表达产品反馈。
- 成功、错误和提醒共用一个无语义 class。
- 用无限旋转 spinner 代替可预期的骨架布局。

### 6.4 Navigation

| 组件 | 使用场景 |
|---|---|
| `AppNavigation` | 统一主导航和角色权限过滤 |
| `Breadcrumbs` | 对象层级和返回路径 |
| `Tabs` | 同一对象的内容视图切换 |
| `SegmentedControl` | 少量互斥模式切换 |
| `Pagination` | 服务端分页列表 |
| `StepIndicator` | 提交、迁移等有限步骤流程 |
| `Menu` | 次要命令集合 |

`Tabs` 和 `SegmentedControl` 不混用。Tabs 切换内容区域；SegmentedControl 切换同一控件或视图模式。

### 6.5 Overlays

| 组件 | 使用场景 |
|---|---|
| `Dialog` | 必须打断当前操作的确认或复杂设置 |
| `ConfirmDialog` | 不可逆动作和原因输入 |
| `Drawer` | 保留上下文的详情、筛选和审阅面板 |
| `Popover` | 与触发点相关的短表单或属性编辑 |
| `Tooltip` | 图标按钮名称和简短说明 |
| `CommandMenu` | 高频跨模块导航，后续按真实需求启用 |

所有 Overlay 必须：

- 管理初始焦点和焦点回归。
- 支持 Escape 关闭，危险确认提交时除外。
- 对屏幕阅读器提供标题和描述。
- 防止背景滚动和无意义焦点穿透。
- 在手机宽度下切换为适合的全宽 Dialog 或 Drawer。

### 6.6 Data display

| 组件 | 使用场景 |
|---|---|
| `StatusChip` | 稳定的业务状态表达 |
| `Badge` | 数量和非状态标识 |
| `KeyValueList` | 详情属性和诊断信息 |
| `TableFrame` | 表格标题、工具区、滚动和空/错状态 |
| `DataTable` | 排序、选择、列定义和服务端分页 |
| `Timeline` | 审计、问题和审批事件 |
| `FileLink` | 受控文件打开、下载和状态 |
| `HashValue` | 哈希截断、复制和完整值 tooltip |

`StatusChip` 不接收任意颜色。领域层先把状态映射为 label 和 tone：neutral、info、warning、danger、success。

`DataTable` 只处理表格行为，不理解审批或 PDM。领域列单元格保留在 feature 内。手机端由领域页面选择关键字段列表，而不是强行横向压缩所有列。

### 6.7 Layout and patterns

| 组件/模式 | 使用场景 |
|---|---|
| `AppShell` | 主导航、内容区、全局反馈和用户菜单 |
| `PageHeader` | 标题、描述、主要动作和面包屑 |
| `SectionHeader` | 页面内区块标题、布局和动作 |
| `Toolbar` | 稳定高度的命令集合 |
| `FilterBar` | 搜索、筛选、清除和结果状态 |
| `StickyActionBar` | 审核、提交和批量处理的固定动作 |
| `SplitPane` | PDF、详情和检查器的稳定分栏 |
| `ResizablePane` | 仅 PDF Studio 等真实需要调整空间的工作面 |
| `TaskList` | 跨审批、问题和同步异常的统一待办 |
| `SettingsSection` | 管理配置区块，不嵌套卡片 |

不提供通用 `Card` 原语。重复列表项可以使用领域 item 组件；普通页面区块通过间距、分隔线和背景带形成层级。

### 6.8 PDF Studio 专用组件

PDF Studio 独立维护：

- `PdfToolbar`
- `ToolButton` / `ToolGroup`
- `ViewportControls`
- `PageThumbnailRail`
- `PdfCanvasViewport`
- `AnnotationLayer`
- `AnnotationMarker`
- `AnnotationCallout`
- `AnnotationDraftPopover`
- `ColorSwatchPicker`
- `IssueList`
- `IssueListItem`
- `IssueInspector`
- `ReviewStatusPanel`
- `ReviewActionBar`

PDF 工具按钮沿用通用焦点、tooltip 和尺寸令牌，但工具选择、连续标注、颜色和画布状态留在 `pdf-studio`。

### 6.9 文案与图标

- 产品界面以中文为主，不再使用 `ROLE GUIDE`、`ADMIN CONSOLE` 等装饰性英文眉题。
- 页面标题使用对象或任务名称，说明文字只保留影响当前决策的内容。
- 按钮使用明确动词，例如“提交审核”“保存修改”“发布版本”，不使用“确定”“处理”等模糊命令。
- 不在产品界面长期展示功能介绍、视觉说明或键盘快捷键教程。
- 图标统一使用现有 Lucide，默认 `strokeWidth=2`，同一工具在全站使用同一图标。
- 用户熟悉的工具动作可以只显示图标，但必须提供 tooltip 和 accessible label。
- 状态文案由领域 presentation 映射统一输出，避免“已通过”“审批完成”“审核成功”并存。
- 成功反馈不用感叹号，错误反馈直接说明失败对象、原因和恢复动作。
- 不使用 emoji 充当产品图标或状态标识。

### 6.10 公共组件 API 约束

- 公共组件使用受限枚举 props，例如 `variant`、`size`、`tone`，不接受任意颜色名称。
- `Button` 只提供 primary、secondary、ghost、danger 和 sm、md；业务页面不能增加临时视觉变体。
- `IconButton` 的 `label` 为必填，tooltip 默认复用该名称。
- Form 控件透传必要的原生 input 属性，并由 `Field` 统一关联 label、description 和 error。
- Overlay 使用受控 `open/onOpenChange`，关闭后把焦点归还触发元素。
- `DataTable` 要求稳定 row id、显式列定义和服务端排序/分页状态，不在内部请求数据。
- 公共组件可以把 `className` 应用到根节点用于布局，但调用方不能依赖内部 DOM 或覆盖内部视觉选择器。
- `style` 只用于用户位置、测量结果、PDF 坐标和批注颜色等运行时几何数据。

## 7. 组件状态矩阵

所有公共组件必须在 UI Gallery 中展示并由浏览器测试覆盖以下状态：

| 类别 | 必测状态 |
|---|---|
| Actions | default、hover、active、keyboard focus、disabled、loading、icon-only |
| Forms | empty、filled、placeholder、focus、invalid、disabled、readonly、long label |
| Feedback | info、success、warning、danger、loading、retry、offline |
| Navigation | default、active、hover、focus、overflow、long label、permission-hidden |
| Overlay | open、close、Escape、focus trap、focus return、mobile layout |
| DataTable | loading、empty、error、one row、many rows、selected、sticky header、mobile fallback |
| StatusChip | 所有 tone、长文案、图标、紧凑表格 |
| PDF tools | selected、continuous、disabled、custom color、undo/redo availability |

同一状态不能只靠颜色区别。问题、提醒和成功状态同时使用文字、图标或结构差异。

## 8. 响应式系统

沿用并整理当前有效断点，避免同时存在多套规则：

| 范围 | 布局策略 |
|---|---|
| `>= 1281px` | 展开侧栏、完整页面工具、PDF 112px/自适应/320px 三栏 |
| `981-1280px` | 可收起 64px 侧栏、紧凑工具栏、PDF 88px/自适应/280px |
| `681-980px` | 主导航转为紧凑模式，检查器使用 Drawer，表格允许受控横向滚动 |
| `<= 680px` | 手机任务流、关键字段列表、底部动作栏；PDF 查看、定位和讨论 |
| `<= 520px` | 单列表单、44px 触控控件、无并排命令文字溢出 |

规则：

- PDF 精确绘制和签名位置编辑在小于 981px 时不作为主要入口。
- 手机仍支持查看 PDF、定位问题、讨论、修改问题状态和确认任务。
- 表格转移动布局时保留字段标签和真实语义，不使用纯 CSS 伪元素承载唯一信息。
- 所有稳定控件使用 min/max、grid tracks 或 aspect-ratio 防止动态内容引发布局跳动。

## 9. 可访问性

目标为 WCAG 2.2 AA：

- 所有交互可使用键盘完成。
- 焦点环在浅色和深色表面均可见。
- 跳到主要内容链接始终保留。
- 图标按钮必须提供可访问名称。
- 表格具有 caption 或可访问标题、正确表头和排序状态。
- 表单 label、description 和 error 正确关联。
- Dialog、Drawer、Menu、Tabs 和 Tooltip 使用正确 ARIA 语义。
- 动态保存、上传和任务状态通过合适的 `aria-live` 通知。
- 触控目标在手机为至少 44x44px。
- 颜色对比、缩放 200%、高对比模式和 reduced motion 纳入浏览器测试。

## 10. 旧样式迁移映射

| 当前实现 | 目标 | 处理规则 |
|---|---|---|
| 原生 `button` 全局样式 | `Button` / `IconButton` | 重置层不再赋予业务外观 |
| `.secondary-button` | `Button variant="secondary"` | 逐调用点替换 |
| `.ghost-button` | `Button/IconButton variant="ghost"` | 退出等图标动作使用 IconButton |
| `.icon-text-button` | `Button` 带 icon | 删除组合 class |
| `.danger-lite` | danger/ghost danger 变体 | 按风险级别选择，不叠 class |
| `.status-chip*` | `StatusChip` | 状态映射集中到 feature presentation 文件 |
| `.error/.success/.notice` | `InlineAlert` / `Toast` | 根据持续时间和位置选择 |
| `.success-message/.error-box` | `InlineAlert` | 统一结构和 ARIA |
| `.empty/.empty-state` | `EmptyState` / `ErrorState` | 区分空数据与加载失败 |
| `.admin-tabs` | `Tabs` | 管理页面内容视图 |
| `.detail-support-tabs` | `Tabs` | 审阅内容视图 |
| `.pdm-tab-list` | `Tabs` | PDM 版本关系视图 |
| `.segmented-control` | `SegmentedControl` | 模式选择，不冒充 Tabs |
| `.table-surface/.data-table` | `TableFrame` + `DataTable` | 领域 cell 留在 feature |
| `.approval-table/.pdm-table` | 领域列定义 | 删除重复表格基础样式 |
| 打印/更新/签名弹层 | `Dialog` / `ConfirmDialog` | 统一焦点和移动端行为 |
| 浮动支持面板 | `Drawer` 或 PDF Inspector | 不保留任意固定坐标弹窗 |
| `.page-heading/.panel-heading` | `PageHeader/SectionHeader` | 统一标题层级和动作对齐 |

迁移完成后删除旧选择器，禁止长期保留新旧两套外观。

## 11. 分阶段迁移

### DS0：基线与 UI Gallery

- 固化登录、列表、审批详情、PDF、PDM 和管理页截图。
- 建立开发/测试专用 `UiGallery`。
- 建立 Playwright 桌面和手机基线。
- 记录当前选择器和组件使用点。

### DS1：令牌与基础样式

- 创建 `tokens.css`、`reset.css`、`globals.css` 和 `motion.css`。
- 先让旧选择器消费新令牌，不立即重写全部 JSX。
- 删除重复硬编码颜色、圆角、阴影和 z-index。
- 维持现有行为并跑全量视觉回归。

### DS2：Actions、Forms、Feedback

- 落地 Button、IconButton、Field、输入控件、InlineAlert、Toast、Skeleton 和 EmptyState。
- 优先迁移登录、个人资料和提交图纸。
- 删除相应旧按钮和反馈选择器。

### DS3：应用外壳与导航

- 落地 AppShell、AppNavigation、PageHeader、Tabs、FilterBar 和任务入口。
- 迁移角色导航、更新提示和用户菜单。
- 验证桌面、平板和手机布局。

### DS4：数据页面

- 落地 TableFrame、DataTable、Pagination、StatusChip 和批量动作栏。
- 迁移图纸中心、PDM、用户管理、日志和运维列表。
- 删除多套表格、标签页和状态 class。

### DS5：PDF Studio

- 迁移三栏工作台、工具栏、缩略图、画布、问题列表和检查器。
- 引入 SplitPane、ResizablePane 和 StickyActionBar。
- 执行非空像素、缩放、长文档和交互视觉验证。

### DS6：管理后台与清理

- 迁移设置、同步中心、诊断、备份和危险操作。
- 删除旧 `styles.css` 和不再使用的 class。
- 扫描未使用选择器、硬编码颜色、任意 z-index 和重复组件。
- 将设计系统门禁纳入 CI。

每个阶段都必须完成“迁移调用点 -> 验证 -> 删除旧实现”，不能只添加新组件而保留旧分支。

## 12. 测试与视觉回归

### 12.1 依赖边界

运行时不新增 UI 框架。测试阶段增加：

- `@playwright/test`：真实浏览器交互与截图。
- `@axe-core/playwright`：自动可访问性检查。

这两个依赖只进入 devDependencies。

### 12.2 UI Gallery

`UiGallery` 展示：

- 每个公共组件的全部状态。
- 长中文、长英文、数字和路径内容。
- 浅色/深色表面。
- 桌面和手机容器宽度。
- 加载、空、错误、禁用和权限隐藏状态。

Gallery 不进入生产路由或安装包导航，只在开发服务器和 Playwright 测试构建开启。

### 12.3 固定视口

视觉回归至少覆盖：

- 1440x900：标准桌面。
- 1280x800：紧凑桌面。
- 1024x768：小窗口/平板横向。
- 768x1024：平板纵向。
- 390x844：手机。

CI 使用固定浏览器版本、时区 `Asia/Shanghai`、语言 `zh-CN` 和固定系统字体。

### 12.4 页面矩阵

至少截图并交互验证：

- 登录、邀请激活和 MFA。
- 角色首页和主导航展开/收起。
- 图纸列表的加载、空、错误、数据和批量选择。
- 提交表单的默认、校验错误、上传和完成。
- PDF Studio 的工具、缩略图、问题编辑、保存失败和只读状态。
- PDM 列表、零件详情和元数据补录。
- WebDAV 同步健康、冲突和失败重试。
- 管理员用户、权限、诊断和危险确认。

### 12.5 测试门禁

- 组件语义和状态使用 Vitest 验证。
- 可访问性自动检查无 serious/critical 违规。
- 稳定组件截图 `maxDiffPixelRatio <= 0.01`。
- PDF 页面因画布抗锯齿差异允许 `<= 0.02`，同时必须通过非空像素检查。
- 浏览器控制台无未处理错误和 React 警告。
- 页面无文字溢出、不可解释遮挡和动态内容布局跳动。
- `prefers-reduced-motion` 和键盘操作通过。

## 13. 设计系统治理

### 13.1 新代码规则

迁移开始后，新代码必须：

- 使用令牌而不是硬编码颜色、间距和 z-index。
- 使用公共 Button、Field、Feedback、Tabs 和 Overlay。
- 将业务状态映射集中在领域 presentation 文件。
- 将样式放在组件 CSS Module 或领域 CSS Module 中。
- 为图标按钮提供 label 和 tooltip。
- 为新增公共组件补 UI Gallery 状态和浏览器测试。

禁止：

- 在 feature 中重写公共组件内部选择器。
- 添加新的全局业务 class。
- 引入第二套组件库。
- 使用内联 style 表达固定视觉规则；用户位置、动态尺寸和批注颜色除外。
- 用快照字符串测试代替真实页面验证。

### 13.2 组件进入公共层的门槛

组件满足以下条件才进入 `ui`：

- 至少两个领域真实使用，或属于明确基础控件。
- API 不包含业务名词。
- 所有必要状态可列举并测试。
- 响应式和可访问性行为稳定。
- 内部实现可以替换而不影响调用者。

否则留在 `patterns`、`features` 或 `pdf-studio`。

### 13.3 删除门禁

旧选择器只有在以下条件全部满足后删除：

- 所有调用点已迁移。
- 目标组件状态测试通过。
- 对应页面视觉回归通过。
- `rg` 不再发现旧 class。
- Git diff 不包含无关样式变化。

## 14. 验收标准

UI 设计系统重构完成必须满足：

- `src/client/styles.css` 被删除，基础全局样式拆入明确文件。
- 颜色、间距、字号、圆角、阴影、动效和 z-index 有唯一令牌来源。
- 按钮、表单、反馈、标签页、弹层、表格和状态不再存在多套基础实现。
- 普通页面不出现卡片嵌套、营销式大标题、紫蓝渐变或装饰性光斑。
- PDF Studio 使用稳定三栏布局和专用组件边界。
- 公共组件全部进入 UI Gallery 并覆盖状态矩阵。
- 关键页面通过 5 个固定视口的 Playwright 验证。
- 无 serious/critical 可访问性违规。
- 无文字溢出、不可解释遮挡、焦点丢失和动态布局跳动。
- 手机端可完成查看、讨论、状态处理和关键管理操作。
- 旧 class、重复 CSS、硬编码颜色和任意 z-index 扫描清零。
- 新增运行时 UI 框架依赖为零。

## 15. 与实施计划的关系

详细实施计划必须把 DS0 至 DS6 分解为可独立验证的任务，并为每个任务列出：

- 目标组件或页面。
- 旧选择器和调用点。
- 新文件路径。
- 迁移顺序。
- Vitest 和 Playwright 命令。
- 桌面/手机截图门禁。
- 旧代码删除条件。

UI 设计系统是总重构阶段 2 的前置基础，也是阶段 3 PDF Studio 和后续领域页面的共同约束。实施时不得绕过本设计在页面内临时发明另一套组件。
