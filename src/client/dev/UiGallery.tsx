import { Copy, Save, Trash2 } from "lucide-react";
import type { CSSProperties } from "react";
import { Button, ButtonGroup, IconButton } from "../ui/actions/index.tsx";
import { Checkbox, FormActions, PasswordInput, RadioGroup, Select, Switch, TextArea, TextInput } from "../ui/forms/index.tsx";
import { EmptyState, ErrorState, InlineAlert, SaveIndicator, Skeleton } from "../ui/feedback/index.tsx";
import styles from "./UiGallery.module.css";

const semanticColors = [
  ["主操作", "--color-primary", "提交、保存与当前选择"],
  ["信息", "--color-info", "链接与中性系统信息"],
  ["成功", "--color-success", "完成、健康与已发布"],
  ["提醒", "--color-warning", "说明、期限与同步异常"],
  ["危险", "--color-danger", "正式问题与不可逆操作"]
] as const;

const typeSamples = [
  ["页面标题", "24 / 32 · 700", styles.pageTitleSample, "减速器壳体图纸审阅"],
  ["区块标题", "20 / 28 · 600", styles.titleSample, "待复核问题"],
  ["正文", "14 / 22 · 400", styles.bodySample, "版本 A03 已完成主管审核，等待工艺确认。"],
  ["紧凑数据", "13 / 20 · 500", styles.smallSample, "GX-240713-018 · 2026-07-13 23:42"],
  ["辅助信息", "12 / 18 · 500", styles.captionSample, "SHA-256 8f2c…4a91"]
] as const;

const spacingTokens = ["1 · 4", "2 · 8", "3 · 12", "4 · 16", "5 · 24", "6 · 32", "7 · 40", "8 · 48"];

export function UiGallery() {
  return <div className={styles.galleryShell}>
    <header className={styles.masthead}>
      <div className={styles.productMark} aria-hidden="true">P2</div>
      <div>
        <p className={styles.productName}>工程图纸协同平台</p>
        <h1>UI 设计系统基线</h1>
      </div>
      <div className={styles.phaseStamp}>
        <span>Phase 2 · DS0–DS2</span>
        <strong>精密工业</strong>
      </div>
    </header>

    <main className={styles.galleryMain}>
      <section className={styles.intro} aria-labelledby="gallery-purpose">
        <div>
          <p className={styles.sectionIndex}>00 / FOUNDATION</p>
          <h2 id="gallery-purpose">为重复工程工作建立稳定视觉语言</h2>
        </div>
        <p>页面优先展示图纸、任务和问题。令牌负责一致性，组件负责行为，业务状态仍留在领域层。</p>
      </section>

      <section className={styles.gallerySection} aria-labelledby="semantic-colors">
        <SectionHeading index="01" title="语义颜色" description="色彩表达操作和风险，不承担装饰任务。" />
        <div className={styles.colorGrid}>
          {semanticColors.map(([label, token, usage]) => <article className={styles.colorItem} key={token}>
            <div className={styles.colorSwatch} style={{ "--gallery-swatch": `var(${token})` } as CSSProperties} />
            <div>
              <strong>{label}</strong>
              <code>{token}</code>
              <span>{usage}</span>
            </div>
          </article>)}
        </div>
      </section>

      <section className={styles.gallerySection} aria-labelledby="type-scale">
        <SectionHeading index="02" title="排版层级" description="中文系统字体优先，数据使用等宽与等宽数字。" />
        <div className={styles.typeScale}>
          {typeSamples.map(([label, metrics, className, copy]) => <article className={styles.typeRow} key={label}>
            <div><strong>{label}</strong><span>{metrics}</span></div>
            <p className={className}>{copy}</p>
          </article>)}
        </div>
      </section>

      <section className={styles.gallerySection} aria-labelledby="spacing-size">
        <SectionHeading index="03" title="间距与稳定尺寸" description="固定工具高度，避免文字和状态改变工作面结构。" />
        <div className={styles.measureGrid}>
          <div className={styles.spacingScale} aria-label="间距令牌">
            {spacingTokens.map((token, index) => <div key={token}>
              <span style={{ width: `var(--space-${index + 1})` }} />
              <code>space-{token}</code>
            </div>)}
          </div>
          <dl className={styles.dimensionList}>
            <div><dt>默认控件</dt><dd>36 px</dd></div>
            <div><dt>触控控件</dt><dd>44 px</dd></div>
            <div><dt>展开导航</dt><dd>232 px</dd></div>
            <div><dt>PDF 检查器</dt><dd>320 px</dd></div>
          </dl>
        </div>
      </section>

      <section className={styles.gallerySection} aria-labelledby="surface-focus">
        <SectionHeading index="04" title="表面、层级与焦点" description="阴影只标记真实浮层，键盘焦点在明暗表面都清晰。" />
        <div className={styles.surfaceGrid}>
          <article className={styles.lightSurface}>
            <span>浅色业务表面</span>
            <strong>零件 GX-240713-018</strong>
            <button type="button">查看版本</button>
          </article>
          <article className={styles.darkSurface}>
            <span>深色工具表面</span>
            <strong>PDF 审阅工具</strong>
            <button type="button">适合宽度</button>
          </article>
          <article className={styles.floatingSurface}>
            <span>浮层阴影</span>
            <strong>保存失败</strong>
            <p>连接恢复后可重新提交当前草稿。</p>
          </article>
        </div>
      </section>

      <section className={styles.gallerySection} aria-labelledby="shared-actions">
        <SectionHeading index="05" id="shared-actions" title="操作组件" description="主操作唯一，危险操作只用于不可逆命令。" />
        <div className={styles.componentSurface}>
          <ButtonGroup aria-label="操作组件状态">
            <Button><Save size={16} aria-hidden="true" />保存修改</Button>
            <Button variant="secondary">返回列表</Button>
            <Button variant="ghost">查看记录</Button>
            <Button variant="danger"><Trash2 size={16} aria-hidden="true" />删除版本</Button>
            <Button loading loadingLabel="正在保存">保存修改</Button>
            <Button disabled>不可执行</Button>
            <IconButton label="复制物料号" variant="secondary"><Copy size={16} aria-hidden="true" /></IconButton>
          </ButtonGroup>
        </div>
      </section>

      <section className={styles.gallerySection} aria-labelledby="shared-forms">
        <SectionHeading index="06" id="shared-forms" title="表单组件" description="标签、说明和错误始终与控件建立语义关联。" />
        <form className={styles.formDemo} onSubmit={(event) => event.preventDefault()}>
          <TextInput id="gallery-drawing" label="图纸名称" defaultValue="E2E轴承座" description="使用图框中的正式名称" />
          <PasswordInput id="gallery-password" label="审批密码" defaultValue="drawing-review" />
          <Select id="gallery-role" label="项目角色" defaultValue="supervisor" options={[
            { value: "designer", label: "设计人员" }, { value: "supervisor", label: "主管审阅" }
          ]} />
          <TextInput id="gallery-invalid" label="体系文件号" error="体系文件号不能为空" />
          <TextArea id="gallery-note" label="处理说明" defaultValue="已按审阅意见修订圆角尺寸。" />
          <div className={styles.choiceDemo}>
            <Checkbox id="gallery-check" label="我已核对图纸版本" defaultChecked />
            <Switch id="gallery-notify" label="邮件通知" defaultChecked />
          </div>
          <RadioGroup legend="审核结论" name="gallery-result" defaultValue="approved" options={[
            { value: "approved", label: "通过", description: "允许进入后续流程" },
            { value: "rejected", label: "驳回", description: "退回设计人员修改" }
          ]} />
          <FormActions><Button type="submit">提交审核</Button><Button variant="secondary">保存草稿</Button></FormActions>
        </form>
      </section>

      <section className={styles.gallerySection} aria-labelledby="shared-feedback">
        <SectionHeading index="07" id="shared-feedback" title="反馈与状态" description="加载、空、错、离线和保存状态都有明确恢复路径。" />
        <div className={styles.feedbackGrid}>
          <InlineAlert tone="info" title="处理中">签章文件正在后台生成。</InlineAlert>
          <InlineAlert tone="success" title="发布完成">版本 A03 已发布到零件库。</InlineAlert>
          <InlineAlert tone="warning" title="需要确认">WebDAV 回读校验尚未完成。</InlineAlert>
          <InlineAlert tone="danger" title="保存失败">网络恢复后请重新提交当前修改。</InlineAlert>
          <div className={styles.statusDemo}><SaveIndicator status="saving" /><SaveIndicator status="saved" />
            <SaveIndicator status="offline" /></div>
          <Skeleton lines={3} label="正在读取任务" />
          <EmptyState title="暂无待处理问题">当前图纸没有阻断审批的问题。</EmptyState>
          <ErrorState title="项目读取失败" onRetry={() => undefined}>请检查连接后重新加载。</ErrorState>
        </div>
      </section>
    </main>
  </div>;
}

function SectionHeading({ index, id, title, description }: {
  readonly index: string;
  readonly id?: string;
  readonly title: string;
  readonly description: string;
}) {
  const headingId = id ?? (title === "语义颜色" ? "semantic-colors"
    : title === "排版层级" ? "type-scale"
      : title === "间距与稳定尺寸" ? "spacing-size" : "surface-focus");
  return <div className={styles.sectionHeading}>
    <span>{index}</span>
    <div><h2 id={headingId}>{title}</h2><p>{description}</p></div>
  </div>;
}
