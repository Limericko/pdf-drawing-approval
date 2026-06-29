# PDF 图纸审批系统 V6 图纸批注方案

日期：2026-06-22

## 版本定位

V6 目标是补齐“图纸批注与返修闭环”。当前系统已经有网页提交、PDF 预览、签名框定位、主管和工艺并行审核、自动生成签后 PDF、评论/问题、操作日志、报表、客户端和服务端安装包。缺口在于：审核意见只能用文字表达，不能直接绑定到图纸上的具体位置。

本版本把主管和工艺的审查意见从“文字说明”升级为“PDF 上的可视批注”。设计师能按批注逐条处理，管理员能追溯批注数量和未处理项。

## 已确认决策

- 批注不进入正式打印用的签后 PDF。
- 系统可生成单独的“带批注审查版 PDF”，用于内部沟通和留痕。
- 批注位置按页码和归一化比例保存，随 PDF 缩放和滚动保持对齐。
- 第一版批注先支持实用形态：定位点、矩形框、箭头、圆圈、文本说明。
- 驳回时必须有审核意见或至少一条未处理批注，避免空驳回。
- 设计师可把批注标记为“已处理”，主管、工艺和管理员可继续查看处理状态。

## 非目标

- 不做 CAD 原文件在线批注。
- 不做多人同时编辑冲突处理，采用保存后刷新列表的轻量协作模型。
- 不把批注合并进正式签名 PDF。
- 不引入外部云服务、坚果云 API 或复杂审批流引擎。
- 不做复杂画笔自由绘制，避免前期实现和审查 PDF 输出复杂度过高。

## 角色流程

### 主管 / 工艺

1. 打开待审核图纸。
2. 在 PDF 上添加矩形、箭头、圆圈、定位点或文本批注。
3. 每条批注填写短说明。
4. 通过或驳回审核。
5. 驳回时，系统接受“文字审核意见”或“未处理批注”作为驳回依据。

### 设计师

1. 打开被驳回或待处理图纸。
2. 在 PDF 上看到所有批注。
3. 按批注修改图纸。
4. 对已处理批注逐条标记“已处理”。
5. 需要沟通时继续使用现有协同评论。

### 管理员

1. 在图纸详情页查看所有批注。
2. 导出追溯报表，包含批注数量、未处理数量和最近批注摘要。
3. 打开带批注审查版 PDF 作为审查留痕。

## 数据设计

新增 `approval_annotations` 表，独立于 `approval_comments`。

原因：

- `approval_comments` 是纯文字协同记录。
- 批注需要页码、几何坐标、形状、颜色、处理状态和 PDF 输出能力。
- 独立表便于后续扩展，不破坏现有评论接口。

核心字段：

- `approval_id`
- `author_user_id`
- `kind`: `pin` / `rect` / `arrow` / `circle` / `text`
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
- `resolved_by_user_id`
- `resolved_at`
- `created_at`
- `updated_at`

坐标规则：

- `x_ratio`、`y_ratio` 是批注左上角或起点相对页面宽高的比例。
- `width_ratio`、`height_ratio` 用于矩形、圆圈、文本框。
- `end_x_ratio`、`end_y_ratio` 用于箭头终点。
- 所有比例限制在 `0..1` 范围内。
- `page_number` 从 1 开始。

## 后端接口

挂载在现有 `/api/approvals` 下：

- `GET /api/approvals/:id/annotations`
- `POST /api/approvals/:id/annotations`
- `PUT /api/approvals/:id/annotations/:annotationId`
- `POST /api/approvals/:id/annotations/:annotationId/resolve`
- `DELETE /api/approvals/:id/annotations/:annotationId`
- `GET /api/approvals/:id/annotated-file?token=...`

权限：

- 所有登录用户可查看批注。
- `supervisor`、`process`、`admin` 可创建批注。
- 批注作者和 `admin` 可编辑或删除未处理批注。
- `designer`、批注作者和 `admin` 可标记已处理。
- 已归档、已作废图纸默认只读，不允许新增或编辑批注。

## 前端设计

图纸详情页增加“批注模式”。

左侧 PDF 仍是主工作区，批注覆盖层直接贴在 PDF 页面上。右侧保持审核、签审和主要动作；协同、时间线、历史版本继续使用浮窗。批注列表可作为新的浮窗入口，也可在批注模式中显示简短列表。

交互：

- 默认展示已有批注。
- 点击“批注”进入批注工具栏。
- 工具栏提供定位点、矩形、箭头、圆圈、文本。
- 点击或拖拽 PDF 页面创建批注。
- 创建后弹出轻量输入框填写说明。
- 点击批注可查看详情、编辑说明、标记已处理。

## 审查版 PDF

新增 `src/server/pdf/annotatePdf.ts`，使用 `pdf-lib` 在原 PDF 上绘制批注。

输出规则：

- 原始审批 PDF 不被覆盖。
- 正式签后 PDF 不被覆盖、不叠加批注。
- 审查版 PDF 由接口按需生成并返回。
- 绘制内容包括形状、编号和说明摘要。

## 追溯与报表

操作日志新增：

- `approval.annotation_created`
- `approval.annotation_updated`
- `approval.annotation_resolved`
- `approval.annotation_deleted`
- `approval.annotated_pdf_opened`

CSV 报表新增：

- 批注总数。
- 未处理批注数。
- 最近批注摘要。

## 边界处理

- PDF 文件丢失或无效时，不显示批注编辑层，只显示异常面板。
- 批注页码超过当前 PDF 页数时，后端拒绝生成审查版 PDF，并返回 `PDF_PAGE_OUT_OF_RANGE`。
- 批注几何参数非法时，接口返回 `INVALID_ANNOTATION_GEOMETRY`。
- 批注保存失败不影响审核主记录。

## 验收标准

- 主管或工艺能在 PDF 上添加批注，滚动和缩放后位置不漂移。
- 设计师能查看批注并标记已处理。
- 驳回时没有文字意见且没有未处理批注会被拒绝。
- 正式签后 PDF 不包含批注。
- 审查版 PDF 能显示批注。
- 删除图纸时同步删除批注记录。
- CSV 报表包含批注统计。
- `npm test` 和 `npm run build` 通过。
