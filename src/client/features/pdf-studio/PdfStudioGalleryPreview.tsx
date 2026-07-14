import { AlertTriangle, Hand, MousePointer2, Pencil, Square, ZoomIn } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../../ui/actions/index.tsx";
import { StatusChip } from "../../ui/data/index.tsx";
import { ReviewActionBar } from "./ReviewActionBar.tsx";
import styles from "./PdfStudioGalleryPreview.module.css";

export function PdfStudioGalleryPreview() {
  const [comment, setComment] = useState("");
  return (
    <div className={styles.studio} aria-label="PDF Studio DS5 预览">
      <div className={styles.toolbar} aria-label="PDF Studio 工具状态样例">
        <div className={styles.toolGroup}>
          <IconButton label="选择工具" size="sm"><MousePointer2 size={15} /></IconButton>
          <IconButton label="矩形工具已选中" size="sm" variant="primary"><Square size={15} /></IconButton>
          <IconButton label="画笔工具" size="sm"><Pencil size={15} /></IconButton>
        </div>
        <div className={styles.toolGroup}>
          <IconButton label="放大图纸" size="sm"><ZoomIn size={15} /></IconButton>
          <IconButton label="拖动浏览" size="sm"><Hand size={15} /></IconButton>
        </div>
        <span className={styles.mode}>适宽 · 第 1 / 3 页 · 已保存</span>
        <span className={styles.mobilePolicy}>移动端保留查看、定位、问题处理和审核</span>
      </div>
      <div className={styles.body}>
        <nav className={styles.rail} aria-label="PDF Studio 缩略页样例">
          {[1, 2, 3].map((page) => (
            <button key={page} type="button" className={styles.thumbnail} data-active={page === 1}>
              <span className={styles.thumbnailPaper}>{page === 1 ? <em>2</em> : null}{page}</span>
              <small>第 {page} 页</small>
            </button>
          ))}
        </nav>
        <div className={styles.viewport}>
          <div className={styles.paper}>
            <svg className={styles.drawing} viewBox="0 0 700 495" role="img" aria-label="减速器壳体工程图示意">
              <g fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="35" y="32" width="630" height="430" />
                <path d="M105 315h350l70-65v-95l-70-65H105z" />
                <circle cx="235" cy="202" r="72" /><circle cx="235" cy="202" r="38" />
                <circle cx="438" cy="202" r="52" /><circle cx="438" cy="202" r="24" />
                <path d="M85 355h490M575 355v107M490 405h175M115 110v185M560 110v185" strokeDasharray="6 5" />
                <path d="M105 335v35m350-35v35M105 360h350M88 360l17-5v10zm384 0-17-5v10z" />
                <rect x="490" y="405" width="175" height="57" />
                <path d="M490 430h175M575 405v57" />
              </g>
            </svg>
            <span className={styles.annotation}><span>1</span></span>
          </div>
        </div>
        <aside className={styles.inspector} aria-label="问题检查器样例">
          <div className={styles.inspectorHeader}>
            <strong>审阅检查器</strong>
            <div><StatusChip tone="warning">主管待处理</StatusChip></div>
            <div className={styles.tabs}><span>问题 2</span><span>批注 3</span><span>属性</span><span>记录</span></div>
          </div>
          <div className={styles.issueList}>
            <div className={styles.issue} data-selected="true">
              <strong>轴承孔公差未标注</strong>
              <span><b><AlertTriangle size={13} /> 高</b><em>待处理</em></span>
            </div>
            <div className={styles.issue}>
              <strong>技术要求缺少热处理说明</strong>
              <span><b>中</b><em>处理中</em></span>
            </div>
          </div>
        </aside>
      </div>
      <ReviewActionBar saveStatus="saved" openIssueCount={2} blockingIssueCount={1} canReview
        comment={comment} busy={false} onCommentChange={setComment}
        onApprove={() => undefined} onApproveAndNext={() => undefined} onReject={() => undefined} />
    </div>
  );
}
