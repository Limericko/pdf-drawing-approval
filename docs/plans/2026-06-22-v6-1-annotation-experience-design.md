# PDF 图纸审批系统 V6.1 批注体验优化方案

日期：2026-06-22

## 背景

V6 已经补齐图纸批注的核心闭环：批注可落库、可展示、可处理、可导出审查版 PDF，并且不污染正式签后 PDF。当前问题集中在使用手感：批注创建依赖右侧先写内容，拖拽反馈弱，创建后不能像常见编辑器一样移动、缩放或快速调整，文字和形状工具还不够接近机械审图习惯。

本版本不替换现有数据链路，不整体引入第三方批注系统。它参考 PDF.js Annotation Editor、react-pdf-highlighter 系列、pdfjs-annotation-extension 和 tldraw 的交互模式，在当前 PDF.js 预览层上继续增强。

## 目标

- 让审核人能像使用常见 PDF 批注工具一样顺手地画、改、删批注。
- 保持现有审批权限、时间线、审查版 PDF、驳回依据、处理状态和报表能力。
- 支持机械审图常用标记：文字、箭头、矩形、圆、自由画笔、修订云。
- 批注仍只作为审查留痕，不写入正式签名打印 PDF。

## 非目标

- 不做 CAD 原文件批注。
- 不把批注合并进正式签后 PDF。
- 不做多人实时协同编辑。
- 不整体替换为第三方 PDF 编辑器或白板库。
- 不支持复杂图层、旋转、组合、多选对齐等专业设计软件能力。

## 参考方向

### PDF.js Annotation Editor

可借鉴工具栏、文字/墨迹/高亮等编辑器思路，但原生实现与 PDF.js Viewer 耦合较强。当前项目使用自定义 PDF.js canvas 渲染，更适合借鉴交互，不直接嵌入完整 Viewer。

### react-pdf-highlighter 系列

可借鉴归一化坐标、批注定位、滚动跳转和批注列表同步。当前项目已经用页码和比例坐标保存批注，可继续沿用。

### pdfjs-annotation-extension

可借鉴工具丰富度：矩形、圆、箭头、云线、画笔、文字等。它的方向符合机械审图，但直接接入成本高。

### tldraw

可借鉴选择态、边框手柄、拖拽移动、缩放手感、工具栏状态和撤销体验。当前项目只需要轻量子集。

## 推荐方案

保留当前 `approval_annotations` 表和 API，扩展批注类型与几何数据。前端继续使用 `PdfAnnotationWorkspace` 和 `PdfAnnotationLayer`，但把它从“画形状按钮”升级为“轻量 PDF 批注编辑器”。

核心变化：

1. 画完再填内容
   - 审核人先在图纸上画框、箭头、云线或文字区域。
   - 松手后在批注附近弹出输入框。
   - 输入后保存；取消则不创建记录。

2. 选中后可编辑
   - 点击批注进入选中态。
   - 选中态显示边框和调整手柄。
   - 可拖动位置、缩放矩形/文字/圆/云线。
   - 可修改文字、颜色、删除。

3. 工具栏前置
   - PDF 顶部增加紧凑批注工具栏。
   - 工具包含：选择、定位点、箭头、矩形、圆、文字、画笔、云线、撤销、删除、颜色。
   - 右侧批注列表保留为追溯和处理入口，不再承担主要绘制入口。

4. 增加自由画笔
   - 用指针轨迹保存为归一化点数组。
   - 用于手画圈、划线、短文字标记。
   - 审查版 PDF 导出时按页面尺寸还原轨迹。

5. 增加修订云
   - 第一版云线可用矩形云线：用户拖出区域，系统按边框生成波浪/云状路径。
   - 后续可扩展为自由云线。

6. 撤销当前未保存操作
   - 支持撤销当前页面最近一次创建或调整。
   - 已保存到服务器的批注删除仍走权限校验。

## 数据设计

现有字段继续保留：

- `kind`
- `message`
- `page_number`
- `x_ratio`
- `y_ratio`
- `width_ratio`
- `height_ratio`
- `end_x_ratio`
- `end_y_ratio`
- `color`
- `resolved`

新增或扩展：

- `kind` 增加 `ink` 和 `cloud`。
- 新增 `points_json`，用于自由画笔和后续复杂路径。
- 可选新增 `style_json`，用于线宽、透明度、云线密度等轻量样式。

兼容原则：

- 老批注无需迁移即可继续显示。
- 新字段可为空。
- 旧类型仍使用原坐标字段。
- `ink` 必须有 `points_json`。
- `cloud` 第一版可使用矩形几何字段，不强制 `points_json`。

## 前端结构

### PdfAnnotationWorkspace

继续负责 PDF 加载、页面渲染、每页比例坐标转换和页面列表。

新增职责：

- 管理当前工具栏状态。
- 接收页面层发出的草稿事件。
- 暴露选中批注 ID。

### PdfAnnotationLayer

升级为页面级交互层。

新增状态：

- `draft`: 正在绘制的批注草稿。
- `selectedAnnotationId`: 当前选中批注。
- `editingDraft`: 刚画完待输入内容的草稿。
- `dragMode`: `create` / `move` / `resize` / `draw-ink`。

交互规则：

- `select`: 点击选中，拖动移动。
- `rect/circle/text/cloud`: 拖拽创建，松手弹输入框。
- `arrow`: 拖拽起点到终点，松手弹输入框。
- `pin`: 点击创建，弹输入框。
- `ink`: 按下开始记录点，移动追加点，松手弹输入框。

### Annotation Toolbar

作为审批详情页 PDF 区域顶部工具条。

工具状态必须视觉清楚：

- 当前工具高亮。
- 颜色可见。
- 不可用工具禁用。
- 只读状态显示为查看模式。

### Annotation Popover

用于“画完再填内容”和编辑选中批注。

位置规则：

- 默认贴近草稿或选中批注。
- 如果靠近页面边缘，自动向内偏移。
- 不遮挡工具栏。

## 后端设计

后端保持现有路由结构：

- `GET /api/approvals/:id/annotations`
- `POST /api/approvals/:id/annotations`
- `PUT /api/approvals/:id/annotations/:annotationId`
- `POST /api/approvals/:id/annotations/:annotationId/resolve`
- `DELETE /api/approvals/:id/annotations/:annotationId`
- `GET /api/approvals/:id/annotated-file`

扩展点：

- Repository 校验 `ink` 和 `cloud`。
- 路由 schema 接收 `pointsJson` 和 `styleJson`。
- 审查版 PDF 绘制支持 `ink` 和 `cloud`。
- 操作日志继续沿用 annotation created/updated/resolved/deleted。

## 审查版 PDF

正式签后 PDF 仍保持干净。

审查版 PDF 需要新增绘制能力：

- `ink`: 按归一化点数组绘制折线。
- `cloud`: 根据矩形边界绘制简化云线；若后续有路径点，则按路径绘制。
- `text`: 文字框支持自动换行。
- 所有类型绘制编号，便于与列表对应。

## 权限与流程

- 所有登录用户可查看批注。
- 主管、工艺、管理员可新增批注。
- 批注作者和管理员可编辑或删除未处理批注。
- 设计师、批注作者、管理员可标记已处理。
- 已归档或作废图纸只读。
- 驳回逻辑保持：无文字意见但存在未处理批注时允许驳回。

## 验收标准

- 审核人可以先画批注，松手后填写内容。
- 文字、矩形、圆、箭头、云线和自由画笔在 PDF 上可见且不漂移。
- 批注创建后可选中、移动、缩放、改颜色、删除。
- 右侧列表点击后能定位并选中图纸上的批注。
- 审查版 PDF 能导出新类型批注。
- 正式签名 PDF 不包含批注。
- 旧批注数据仍正常显示。
- `npm test` 和 `npm run build` 通过。

## 分批交付建议

1. 批次 A：数据结构扩展，支持 `ink/cloud/pointsJson/styleJson`。
2. 批次 B：前端工具栏、画完再填、草稿弹窗。
3. 批次 C：选中态、拖动、缩放、删除、颜色调整。
4. 批次 D：自由画笔、修订云、审查版 PDF 输出。
5. 批次 E：列表定位、文档、全量验证和安装包回归。
