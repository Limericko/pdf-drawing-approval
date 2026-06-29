# PDF 图纸审批系统第四版实现总结

日期：2026-06-18

## 版本目标

第四版把第三版的签审闭环继续产品化，重点解决现场长期使用中的重复定位、批量处理、运维发现和版本追溯问题。

核心目标：

- 设计师可以复用常用图框的签名框位置模板。
- 设计师可以一次上传多张 PDF，并逐张确认独立签名位置。
- 设计师或管理员可以批量重新生成签后 PDF、批量标记打印归档。
- 管理员可以在一个页面看到影响上线运行的风险项。
- 提交和详情页面能提示同项目、同零件的其它版本。
- 管理员可以在运维追溯中查看批量上传提交历史。

## 保留的系统边界

- 仍然只在公司局域网内部使用。
- 仍然以 Windows 电脑作为审批服务器优先目标。
- 仍然以坚果云本地同步目录作为文件底座，不使用坚果云 API。
- 仍然是固定主管 + 固定工艺并行审核。
- 签名仍然是内部可视手写签名盖章，不是 CA/证书数字签名。
- 不引入复杂审批流引擎，避免超出 5-10 人团队的维护成本。

## 主要功能

### 签名框模板

第四版新增签名框模板，用于保存常用图框中的设计、主管、工艺三个签名框位置。

能力：

- 模板可为全局模板，也可绑定到某个项目。
- 设计师和管理员可在提交页套用模板。
- 设计师和管理员可在审批详情页把当前签名框位置保存为模板。
- 管理员可在“系统管理 -> 签名模板”维护模板。
- 套用模板只是复制当时的签名框位置，不会让后续审批单和模板持续绑定。

相关接口：

```text
GET    /api/signature-templates
POST   /api/signature-templates
PUT    /api/signature-templates/:id
DELETE /api/signature-templates/:id
POST   /api/approvals/:id/signature-templates
```

### 批量上传

提交图纸页支持一次选择多张 PDF。每张图纸在页面中都是独立项目，拥有自己的项目信息、零件名、版本、签名框位置和提交结果。

能力：

- 多文件上传先逐项校验 PDF 文件头。
- 批量套用模板只作为初始位置，设计师仍可逐张微调。
- “套用到当前图纸”只影响当前选中的 PDF。
- 单个文件失败不会阻塞其它文件。
- 提交后文件仍写入坚果云标准目录 `02-审批中\项目名\`。
- 批量记录保留逐项成功、失败和签名框来源状态。
- 系统管理页“运维追溯”显示最近批量提交历史，便于管理员查看每批成功数、失败数和逐项错误。

相关接口：

```text
POST /api/submissions/batch-upload
POST /api/submissions/batch
GET  /api/submissions/batches
GET  /api/submissions/batches/:id
```

### 批量签后 PDF 处理

“全部图纸”页支持对已通过待打印的图纸执行批量后处理。

能力：

- 设计师和管理员可以批量重新生成签后 PDF。
- 设计师和管理员可以批量标记打印归档。
- 主管和工艺不能执行批量签后处理。
- 批量结果按图纸逐项返回成功或失败原因。
- 批量归档仍要求有可用签后 PDF，避免误归档未签名版本。

相关接口：

```text
POST /api/approvals/batch/generate-signed-pdf
POST /api/approvals/batch/mark-printed
```

### 运维风险看板

系统管理页“运维追溯”新增风险看板，把常见上线风险集中显示。

风险项覆盖：

- 审批根目录未配置或不存在。
- 五个标准目录缺失。
- 标准目录不可写。
- 最近备份过期。
- 存在文件丢失审批单。
- 存在 PDF 无效审批单。
- 存在签名失败审批单。
- 关键签名用户未配置签名。

相关接口：

```text
GET /api/system/risks
```

### 轻量版本追溯

第四版不做完整版本树，先提供同项目、同零件的轻量提示。

能力：

- 上传解析后，提交页提示同零件已有版本。
- 修改项目名或零件名后，会重新查询已有版本。
- 审批详情页“其它版本”浮窗显示同项目、同零件的其它审批记录。
- CSV 追溯报表增加“同零件版本数”列。

相关接口和字段：

```text
GET /api/submissions/existing-versions
GET /api/approvals/:id -> relatedVersions
GET /api/reports/approvals.csv -> 同零件版本数
```

## 数据库变化

第四版新增：

- `signature_templates`：签名框模板，保存模板名称、适用项目、创建人和三类签名框位置。
- `batch_submissions`：批量提交主记录，保存批量状态、总数、成功数、失败数。
- `batch_submission_items`：批量提交逐项记录，保存文件名、审批单 ID、失败原因和签名框来源状态。

第四版扩展使用：

- `approvals`：用于同项目、同零件版本查询。
- `signature_placements`：继续作为模板复制和签后 PDF 生成的最终位置来源。
- `operation_logs`：记录模板、批量提交、批量签后处理和运维动作。

历史数据仍通过 `src/server/db.ts` 中的幂等迁移逻辑兼容升级。

## 关键代码位置

后端：

- `src/server/repositories/signatureTemplates.ts`
- `src/server/repositories/batchSubmissions.ts`
- `src/server/repositories/approvals.ts`
- `src/server/routes/signatureTemplates.ts`
- `src/server/routes/submissions.ts`
- `src/server/routes/approvals.ts`
- `src/server/routes/reports.ts`
- `src/server/routes/system.ts`
- `src/server/services/systemRisks.ts`

前端：

- `src/client/pages/SubmitDrawingPage.tsx`
- `src/client/pages/ApprovalDetailPage.tsx`
- `src/client/pages/ApprovalsPage.tsx`
- `src/client/pages/SettingsPage.tsx`
- `src/client/pages/approvalListLogic.ts`
- `src/client/pages/approvalDetailLogic.ts`
- `src/client/api.ts`

测试：

- `src/server/repositories/signatureTemplates.test.ts`
- `src/server/repositories/batchSubmissions.test.ts`
- `src/server/routes/signatureTemplates.test.ts`
- `src/server/routes/submissions.test.ts`
- `src/server/routes/approvals.test.ts`
- `src/server/routes/reports.test.ts`
- `src/server/routes/system.test.ts`
- `src/server/services/systemRisks.test.ts`
- `src/client/pages/submitDrawingLayout.test.ts`
- `src/client/pages/approvalListLogic.test.ts`
- `src/client/pages/approvalDetailLogic.test.ts`
- `src/client/pages/settingsDiagnostics.test.ts`

## 验证摘要

第四版分批验证记录见 `docs/verification.md`：

- V4.1：签名模板。
- V4.2：批量上传。
- V4.3：批量签后 PDF 处理。
- V4.4：运维风险看板。
- V4.5：轻量版本追溯。
- V4.6：文档与发布回归验证。

第四版收尾验证基线：

```text
npm test
npm run build
GET /health
浏览器烟测：提交图纸、全部图纸、系统管理
```

## 上线前检查

管理员上线前应至少完成：

1. 修改默认账号密码。
2. 设置坚果云审批根目录，并创建五个标准目录。
3. 重启服务，让监听目录生效。
4. 补齐管理员、设计师、主管、工艺账号。
5. 让设计师、主管、工艺分别配置自己的签名。
6. 保存至少一个常用图框签名模板。
7. 用一张真实图纸完成单张提交、审核、自动签名、打印归档。
8. 用多张真实图纸完成一次批量上传，确认每张图纸签名框位置互不影响。
9. 在“全部图纸”对已通过待打印记录试跑批量重新生成签后 PDF。
10. 在“系统管理 -> 运维追溯”确认风险看板、健康诊断、备份和 CSV 导出正常。

## 已知限制

- 未实现 CA/证书数字签名。
- 未实现项目级动态审核人配置。
- 未实现管理员代管他人签名。
- 未实现复杂版本树、版本差异对比或工程变更单关联。
- 批量上传仍要求设计师逐张确认签名位置，模板只减少重复定位，不替代人工检查。
- 签名视觉位置需要用真实机械图纸做现场确认。
- 坚果云同步延迟、离线删除和文件占用仍需要现场按真实目录做新增、删除、归档试运行。
