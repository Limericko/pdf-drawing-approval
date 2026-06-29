# PDM V1 设计方案：零件档案与图纸版本库

日期：2026-06-29  
基线分支：`feature/pdm-foundation`  
当前产品基线：PDF 图纸审批系统 `0.9.1`  
目标版本方向：`1.0 轻量图纸 PDM`

## 1. 目标

PDM V1 的目标不是替换现有审批系统，而是在现有“图纸审批、签名、打印归档”流程之上，建立第一层受控工程数据：

- 零件档案。
- 图纸版本库。
- 当前有效版本。
- 历史版本链。
- 审批记录与图纸版本的可追溯关联。

第一版只解决“图纸和版本是否受控”的问题，不引入复杂 BOM、工程变更单、ERP 集成或完整 PLM 流程。

## 2. 已确认业务规则

### 2.1 文件命名与后补规则

当前团队图纸文件名采用：

```text
体系文件号 《管家婆物料号 图纸名称》 版本.pdf
```

示例：

```text
MP300A000072 《0102A00700883 400A按键》 a0A0.pdf
```

解析结果：

```text
documentCode = MP300A000072
materialCode = 0102A00700883
drawingName = 400A按键
version = a0A0
```

命名允许文件名前后存在空格。版本仍使用当前系统已支持的 `a0A0`、`a1A0` 这类格式。

PDM V1 允许 `体系文件号` 和 `管家婆物料号` 后补：

- 文件名完整时，系统自动解析 PDM 元数据。
- 文件名缺少体系文件号或物料号时，审批流程仍可继续。
- `管家婆物料号` 缺失时，不自动发布到 PDM 零件库，记录为“待补物料号”。
- `体系文件号` 缺失时，可以先发布图纸版本，后续再补齐体系文件号。
- 后补操作必须记录操作日志，保留谁、何时、补了什么。

### 2.2 零件唯一性

PDM V1 固化以下规则：

- `管家婆物料号 materialCode` 一旦填写，就是零件档案的全局唯一标识。
- 同一个 `materialCode` 永远只代表一个零件。
- 同一个 `materialCode` 在系统内只有一个当前有效图纸版本。
- 多个项目可以共用同一个 `materialCode`。
- 项目不是零件唯一性的一部分，只是零件使用场景。
- 未填写 `materialCode` 的审批记录只能处于 PDM 待补录状态，不能创建正式零件档案。

### 2.3 体系文件号定位

`体系文件号 documentCode` 用于标识图纸或体系文件。V1 存储并展示该编号，但不把它作为零件主键，也不作为发布图纸版本的硬性前置条件。

为避免后续版本沿用同一体系文件号时出现冲突，V1 不强制 `documentCode` 单字段全局唯一，推荐约束是：

```text
materialCode + version 唯一
documentCode + version 尽量唯一并用于排查重复文件
```

## 3. 范围

### 3.1 V1 必做

- 新增标准文件名解析器，支持解析 `体系文件号 《管家婆物料号 图纸名称》 版本.pdf`。
- 保留旧 `零件名-版本.pdf` 解析能力，用于历史文件和非 PDM 过渡场景。
- 在审批记录中保存 PDM 元数据：体系文件号、物料号、图纸名称；缺失字段允许后补。
- 审批通过且签名版 PDF 生成成功后，如果物料号已填写，自动发布图纸版本。
- 物料号缺失时，审批记录进入 PDM 待补录清单，补齐后可重新发布。
- 自动创建或更新零件档案。
- 自动维护当前有效版本，新版本发布后旧版本进入历史。
- 记录项目与物料号的使用关系，支持共用件跨项目查询。
- 新增“零件库”页面入口，所有登录用户可查询。
- 新增零件详情页，展示当前有效版本、历史版本、关联审批和文件入口。
- 管理员可查看 PDM 元数据异常和未能自动发布的记录。
- 设计师可补录自己提交图纸的体系文件号、物料号和图纸名称；管理员可补录全部记录。

### 3.2 V1 不做

- BOM 多级结构。
- 工程变更单。
- CAD 源文件受控签入签出。
- 管家婆或 ERP 自动同步。
- 自动解析 CAD 或 Excel BOM。
- 复杂流程引擎。
- 多组织、多站点、多仓库部署。

## 4. 数据模型

### 4.1 Part 零件档案

建议表名：`pdm_parts`

字段：

- `id`
- `material_code`：管家婆物料号，全局唯一；正式零件档案中不能为空。
- `name`：零件/图纸名称，默认来自文件名中的图纸名称。
- `is_common`：是否共用件，默认由多项目使用关系自动提示，管理员可维护。
- `current_revision_id`：当前有效图纸版本。
- `created_from_approval_id`：首次创建该零件的审批记录。
- `created_at`
- `updated_at`

唯一约束：

```text
material_code
```

### 4.2 DrawingRevision 图纸版本

建议表名：`pdm_drawing_revisions`

字段：

- `id`
- `part_id`
- `material_code`
- `document_code`：允许为空，后续可补齐。
- `drawing_name`
- `version`
- `minor_version`
- `major_version`
- `approval_id`
- `release_status`：`released`、`superseded`、`voided`
- `original_file_path`
- `original_file_hash`
- `signed_file_path`
- `signed_file_hash`
- `annotated_file_path`
- `released_at`
- `created_at`
- `updated_at`

约束：

```text
UNIQUE(material_code, version)
UNIQUE(approval_id)
```

说明：

- `released` 表示当前或曾经发布成功。
- 当同物料号的新版本发布后，旧版本改为 `superseded`。
- `voided` 暂时只允许管理员操作，V1 不引入作废审批流程。

### 4.3 PartUsage 项目使用关系

建议表名：`pdm_part_usages`

字段：

- `id`
- `part_id`
- `material_code`
- `project_name`
- `first_approval_id`
- `last_approval_id`
- `created_at`
- `updated_at`

唯一约束：

```text
UNIQUE(material_code, project_name)
```

用途：

- 支持共用件查询。
- 支持按项目筛选零件。
- 后续 BOM 阶段可作为项目/产品引用零件的基础。

### 4.4 Approval 审批记录扩展

现有 `approvals` 表建议新增字段：

- `document_code`
- `material_code`
- `drawing_name`
- `pdm_revision_id`
- `pdm_metadata_status`：`complete`、`missing_material_code`、`missing_document_code`、`missing_required`
- `pdm_publish_status`：`not_applicable`、`metadata_pending`、`pending`、`published`、`failed`
- `pdm_publish_error`

保留现有字段：

- `project_name`
- `part_name`
- `version`
- `minor_version`
- `major_version`

兼容策略：

- 对标准 PDM 文件，`part_name` 可继续写入 `drawing_name`，避免现有列表和搜索失效。
- 对旧命名文件，`material_code` 可为空，审批流程照常运行；补齐物料号前不会自动进入 PDM 版本库。
- 对缺少体系文件号但已有物料号和版本的记录，允许发布到 PDM，后续补齐 `document_code`。

## 5. 发布规则

### 5.1 触发条件

图纸版本发布由系统自动触发，不要求设计师额外点击。

触发条件：

```text
审批状态 = approved_for_print
并且
签名要求已满足
并且
material_code 已填写
```

签名要求判断：

- `signature_status = generated`：可以发布。
- `signature_status = not_required`：兼容旧流程，可以发布。
- `signature_status = failed / pending / placement_required`：不发布，记录失败原因。
- `material_code` 缺失：不发布，记录为 `metadata_pending`。
- `document_code` 缺失：不阻断发布，版本详情显示“体系文件号待补”。

### 5.2 发布事务

发布必须在一个数据库事务内完成：

1. 根据 `material_code` 查找或创建 `pdm_parts`。
2. 写入或校验 `pdm_part_usages`。
3. 检查同 `material_code + version` 是否已存在。
4. 如果不存在，创建 `pdm_drawing_revisions`。
5. 将同一 `material_code` 的旧当前版本改为 `superseded`。
6. 将新版本设为零件当前有效版本。
7. 更新审批记录 `pdm_publish_status = published`。
8. 写入 `operation_logs`。

### 5.3 重复版本处理

如果同一 `materialCode + version` 已发布：

- 不覆盖旧版本。
- 不修改当前有效版本。
- 当前审批记录标记 `pdm_publish_status = failed`。
- 错误信息显示“该物料号版本已存在，请确认是否重复提交或需要发布新版本”。

### 5.4 后补发布

当审批记录已经通过，但因缺少物料号未进入 PDM 时：

1. 设计师或管理员补齐 `material_code`。
2. 系统重新计算 `pdm_metadata_status`。
3. 如果签名和审批状态满足发布条件，允许点击“发布到 PDM”或由系统自动重试发布。
4. 发布成功后，审批记录关联到零件档案和图纸版本。
5. 如果补齐后发现同物料号同版本已存在，仍按重复版本处理，不覆盖历史。

体系文件号后补不需要重新发布图纸版本，只更新审批记录和对应图纸版本的 `document_code`，并写入操作日志。

### 5.5 旧版本规则

当新版本成功发布：

- 新版本成为当前有效版本。
- 旧版本保留在历史列表。
- 旧版本文件仍可查看和下载。
- 列表中必须明确标识“历史版本”，避免误用。

## 6. 文件名解析设计

### 6.1 完整 PDM 文件名

解析格式：

```text
^(.+?)\s*《(.+?)\s+(.+?)》\s*([a-zA-Z]\d+[a-zA-Z]\d+)\.pdf$
```

解析说明：

- 第一段是 `documentCode`。
- `《》` 内第一段是 `materialCode`。
- `《》` 内剩余内容是 `drawingName`，允许包含中文、英文、数字和空格。
- 末尾是 `version`。

### 6.2 缺字段文件名

允许以下过渡情况：

```text
《0102A00700883 400A按键》 a0A0.pdf
400A按键 a0A0.pdf
400A按键-a0A0.pdf
```

处理方式：

- 能解析出物料号时，自动写入 `material_code`。
- 不能解析出物料号时，审批流程继续，但 `pdm_publish_status = metadata_pending`。
- 图纸名称和版本能解析时，应在提交预检中展示给设计师确认。
- 版本也无法解析时，仍按当前 `filename_invalid` 处理。

### 6.3 兼容旧文件名

旧格式：

```text
零件名-版本.pdf
```

处理方式：

- 继续允许审批。
- 不自动创建 PDM 零件档案。
- 在审批详情显示“未识别物料号，待补录后进入 PDM 版本库”。
- 设计师可补录自己的提交记录，管理员可补录全部记录。

### 6.4 文件名错误

如果文件扩展名为 PDF，但无法解析出图纸名称和版本：

- 沿用当前 `filename_invalid` 状态。
- 前端提示标准命名示例。
- 不进入审批队列。

## 7. 页面设计

### 7.1 导航入口

新增导航项：

```text
零件库
```

可见角色：

- 设计师。
- 主管。
- 工艺。
- 管理员。

### 7.2 零件列表

列表字段：

- 管家婆物料号。
- 图纸名称。
- 当前有效版本。
- 体系文件号。
- 使用项目数。
- 最近发布时间。
- 状态。

筛选：

- 关键词：物料号、体系文件号、图纸名称。
- 项目。
- 是否共用件。
- 是否存在当前有效版本。

交互：

- 点击物料号进入零件详情。
- 当前有效版本可直接打开签后 PDF。
- 历史版本入口进入版本列表。

### 7.3 零件详情

详情区块：

- 基础信息：物料号、名称、共用件标识、使用项目。
- 当前有效版本：版本、体系文件号、发布时间、审批记录、签后 PDF。
- 历史版本：版本链、发布人、审批结论、文件入口。
- 追溯记录：关联操作日志和审批时间线。

### 7.4 审批详情增强

现有审批详情增加 PDM 信息块：

- 体系文件号。
- 管家婆物料号。
- 图纸名称。
- 元数据状态。
- PDM 发布状态。
- 发布失败原因。
- 关联零件档案入口。
- 补录入口：设计师仅能补录自己提交的记录，管理员可补录全部记录。

### 7.5 PDM 待补录清单

新增管理视图：

- 缺少物料号。
- 缺少体系文件号。
- 缺少图纸名称。
- 物料号版本重复。
- 自动发布失败。

设计师只看到自己提交且待补录的记录；管理员看到全部记录。

## 8. 权限设计

### 8.1 读取权限

所有登录用户均可读取：

- 零件列表。
- 零件详情。
- 图纸版本历史。
- 当前有效版本文件。

理由：设计、审核、工艺都需要查历史版本和当前有效版本。

### 8.2 写入权限

系统自动写入：

- 审批通过后的版本发布。
- 项目使用关系。
- 当前有效版本切换。

管理员可写入：

- 修复历史审批的 PDM 元数据。
- 标记或取消共用件。
- 作废错误发布的图纸版本。

设计师可写入：

- 补录自己提交记录的体系文件号、物料号和图纸名称。
- 触发自己提交记录的 PDM 发布重试。

设计师、主管、工艺在 V1 不直接编辑正式零件档案，避免主数据被随意改动。设计师补录的是审批记录元数据，系统发布成功后才生成或更新零件档案。

## 9. 历史数据迁移

### 9.1 自动回填范围

迁移脚本扫描现有审批记录：

- 状态为 `approved_for_print` 或 `printed_archived`。
- 文件名可解析出标准 PDM 元数据。
- 有有效 PDF 路径和文件哈希。

满足条件的记录自动回填：

- `pdm_parts`
- `pdm_drawing_revisions`
- `pdm_part_usages`
- 审批记录 PDM 字段

### 9.2 不自动回填范围

以下记录不自动进入 PDM：

- 文件名仍是旧格式且未补录物料号。
- 文件缺失。
- PDF 无效。
- 同物料号同版本已存在。
- 物料号或版本无法解析。

这些记录进入管理员“PDM 异常清单”，后续人工处理。

### 9.3 后补历史数据

历史审批记录允许后补：

- 管理员可批量导入物料号和体系文件号映射表。
- 管理员可在单条审批详情中手动补录。
- 设计师只可补录自己提交的历史记录。
- 补录后如果状态已满足发布条件，可立即发布到 PDM。

## 10. API 设计

### 10.1 零件接口

```text
GET /api/pdm/parts
GET /api/pdm/parts/:id
GET /api/pdm/parts/:id/revisions
GET /api/pdm/pending-metadata
```

筛选参数：

```text
keyword
projectName
isCommon
hasCurrentRevision
page
pageSize
```

### 10.2 版本接口

```text
GET /api/pdm/revisions/:id
POST /api/pdm/revisions/:id/void
```

`void` 仅管理员可用，必须填写原因。

### 10.3 维护接口

```text
GET /api/pdm/publish-issues
POST /api/pdm/approvals/:approvalId/repair-metadata
POST /api/pdm/approvals/:approvalId/publish
```

维护接口权限：

- `publish-issues`：管理员查看全部，设计师查看自己的待补录记录。
- `repair-metadata`：管理员可修复全部，设计师只能修复自己的提交记录。
- `publish`：管理员可发布全部，设计师只能重试发布自己的提交记录。

## 11. 验收标准

PDM V1 完成后必须满足：

- 标准文件名能被正确解析为体系文件号、物料号、图纸名称和版本。
- 缺少体系文件号或物料号时，审批流程不被阻断。
- 缺少物料号的记录不会误入正式 PDM 零件库。
- 补齐物料号后，可重新发布到 PDM。
- 缺少体系文件号但已有物料号时，可以发布图纸版本，后续再补齐体系文件号。
- 设计师按标准文件名提交后，审批流程不变。
- 审批通过并签名成功后，系统自动创建零件档案和图纸版本。
- 同一物料号只有一个当前有效版本。
- 新版本发布后，旧版本进入历史版本。
- 同一物料号在多个项目出现时，不重复创建零件档案，只增加项目使用关系。
- 所有角色都能在“零件库”查询当前有效版本和历史版本。
- 重复提交同物料号同版本时，不覆盖已发布版本。
- 历史旧格式文件仍可审批，但不会自动进入 PDM。
- 管理员能看到 PDM 发布异常。
- 设计师能看到并补录自己提交记录的 PDM 元数据。

## 12. 风险与控制

### 12.1 命名规则风险

风险：用户上传文件名少空格、缺书名号、缺体系文件号或缺物料号。

控制：

- 上传预检时显示解析结果。
- 缺物料号时允许提交，但明确标识“待补录，暂不进入 PDM”。
- 文件名无法解析出版本时显示标准示例。
- 批量上传时逐项显示解析状态。

### 12.2 历史数据风险

风险：旧审批记录命名不统一，自动回填可能错误合并零件。

控制：

- 只自动回填标准命名且状态已发布的记录。
- 对重复物料号版本不自动覆盖。
- 管理端保留异常清单。

### 12.3 发布覆盖风险

风险：新版本发布时误覆盖当前有效版本或文件。

控制：

- 版本发布必须事务化。
- `material_code + version` 唯一。
- 文件路径和哈希只记录，不覆盖历史文件。
- 每次当前版本切换写入操作日志。

## 13. 后续演进

PDM V1 稳定后，下一阶段再考虑：

- 工程变更单。
- BOM / 产品结构。
- CAD 源文件管理。
- 图纸作废审批。
- 管家婆物料同步。

这些能力不进入 V1，避免影响当前已上线审批流程。
