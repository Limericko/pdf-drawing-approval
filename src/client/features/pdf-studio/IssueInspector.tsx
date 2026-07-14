import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Link2, Plus, X } from "lucide-react";
import type {
  ApprovalAnnotation,
  ApprovalIssue,
  ApprovalIssueEvent,
  ApprovalIssueInput,
  ApprovalIssueTransitionAction,
  User
} from "../../api.ts";
import { listApprovalIssueEvents } from "../../api.ts";
import { Button, IconButton } from "../../ui/actions/index.tsx";
import { Select, TextArea, TextInput } from "../../ui/forms/index.tsx";
import { InlineAlert } from "../../ui/feedback/index.tsx";
import {
  availableIssueActions,
  filterApprovalIssues,
  issueFilterPageNumbers,
  issueActionLabel,
  issueActionNeedsNote,
  issueSeverityLabels,
  issueStatusLabels,
  type ApprovalIssueFilters
} from "./issuePresentation.ts";
import styles from "./IssueInspector.module.css";

type IssueDraft = Omit<ApprovalIssueInput, "assigneeUserId"> & { assigneeUserId: string };

export function IssueInspector({
  approvalId,
  user,
  issues,
  assignees,
  selectedAnnotation,
  annotationPageById,
  documentPageCount,
  busyAction,
  onCreate,
  onUpdate,
  onTransition,
  onLocateAnnotation
}: {
  approvalId: number;
  user: User;
  issues: ApprovalIssue[];
  assignees: User[];
  selectedAnnotation: ApprovalAnnotation | null;
  annotationPageById: Readonly<Record<number, number>>;
  documentPageCount: number;
  busyAction: string;
  onCreate: (input: ApprovalIssueInput) => Promise<void>;
  onUpdate: (issue: ApprovalIssue, input: Partial<Omit<ApprovalIssueInput, "annotationId" | "clientRequestId">>) => Promise<void>;
  onTransition: (issue: ApprovalIssue, action: ApprovalIssueTransitionAction, note?: string) => Promise<void>;
  onLocateAnnotation: (annotationId: number) => void;
}) {
  const canCreate = user.role === "supervisor" || user.role === "process" || user.role === "admin";
  const [creating, setCreating] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [transitionAction, setTransitionAction] = useState<ApprovalIssueTransitionAction | null>(null);
  const [transitionNote, setTransitionNote] = useState("");
  const [editDraft, setEditDraft] = useState<IssueDraft | null>(null);
  const [events, setEvents] = useState<ApprovalIssueEvent[]>([]);
  const [filters, setFilters] = useState<ApprovalIssueFilters>({
    status: "all",
    severity: "all",
    assigneeUserId: "all",
    pageNumber: "all"
  });
  const [draft, setDraft] = useState<IssueDraft>(() => emptyDraft(selectedAnnotation?.id ?? null));
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null;
  const openCount = issues.filter((issue) => issue.status !== "closed").length;
  const blockingCount = issues.filter((issue) => issue.status !== "closed" && (issue.severity === "high" || issue.severity === "critical")).length;
  const actions = selectedIssue ? availableIssueActions(selectedIssue, user) : [];
  const canEditSelected = Boolean(selectedIssue && selectedIssue.status !== "closed" && (
    user.role === "admin" || user.role === "supervisor" || user.role === "process" || user.id === selectedIssue.creatorUserId
  ));
  const assigneeOptions = useMemo(() => [
    { value: "", label: assignees.length ? "选择负责人" : "暂无可分配设计人员", disabled: true },
    ...assignees.map((assignee) => ({ value: String(assignee.id), label: assignee.displayName }))
  ], [assignees]);
  const filterAssigneeOptions = useMemo(() => [
    { value: "all", label: "全部负责人" },
    ...assignees.map((assignee) => ({ value: String(assignee.id), label: assignee.displayName }))
  ], [assignees]);
  const pageOptions = useMemo(() => [
    { value: "all", label: "全部页面" },
    ...issueFilterPageNumbers(documentPageCount, annotationPageById)
      .map((pageNumber) => ({ value: String(pageNumber), label: `第 ${pageNumber} 页` }))
  ], [annotationPageById, documentPageCount]);
  const filteredIssues = useMemo(
    () => filterApprovalIssues(issues, filters, annotationPageById),
    [issues, filters, annotationPageById]
  );

  useEffect(() => {
    if (selectedAnnotation && creating) {
      setDraft((current) => ({ ...current, annotationId: selectedAnnotation.id }));
    }
  }, [selectedAnnotation?.id, creating]);

  useEffect(() => {
    if (!selectedIssue) {
      setEvents([]);
      return;
    }
    let active = true;
    void listApprovalIssueEvents(approvalId, selectedIssue.id)
      .then((nextEvents) => { if (active) setEvents(nextEvents); })
      .catch(() => { if (active) setEvents([]); });
    return () => { active = false; };
  }, [approvalId, selectedIssue?.id, selectedIssue?.version]);

  async function createIssue() {
    const assigneeUserId = Number(draft.assigneeUserId);
    if (!assigneeUserId || !draft.title.trim() || !draft.description.trim()) return;
    try {
      await onCreate({ ...draft, assigneeUserId, dueAt: draft.dueAt || null });
      setDraft(emptyDraft(selectedAnnotation?.id ?? null));
      setCreating(false);
    } catch {
      // The page-level feedback region reports the API error and keeps this draft intact.
    }
  }

  async function submitTransition() {
    if (!selectedIssue || !transitionAction) return;
    try {
      await onTransition(selectedIssue, transitionAction, transitionNote);
      setTransitionAction(null);
      setTransitionNote("");
    } catch {
      // Keep the note so a user can retry after resolving a conflict or network error.
    }
  }

  async function saveIssueFields() {
    if (!selectedIssue || !editDraft || !Number(editDraft.assigneeUserId)) return;
    try {
      await onUpdate(selectedIssue, {
        assigneeUserId: Number(editDraft.assigneeUserId),
        title: editDraft.title,
        description: editDraft.description,
        severity: editDraft.severity,
        dueAt: editDraft.dueAt || null
      });
      setEditDraft(null);
    } catch {
      // Page-level feedback reports the failure; the editor remains open for comparison.
    }
  }

  return (
    <section className={styles.root} aria-label="正式问题检查器" data-approval-id={approvalId}>
      <header className={styles.header}>
        <div><h2>正式问题</h2><p>{blockingCount > 0 ? `${blockingCount} 个问题阻止审批通过` : "没有高严重级阻断"}</p></div>
        <span className={styles.count} aria-label={`${openCount} 个未关闭问题`}>{openCount}</span>
      </header>
      <div className={styles.scroll}>
        {blockingCount > 0 ? <div className={styles.section}>
          <InlineAlert tone="danger" title="审批阻断">
            关闭全部高或严重级问题后才能通过图纸。
          </InlineAlert>
        </div> : null}

        {canCreate ? <section className={styles.section}>
          <div className={styles.itemTop}>
            <h3 className={styles.sectionTitle}>问题清单</h3>
            {creating ? <IconButton label="取消创建问题" variant="ghost" size="sm" onClick={() => setCreating(false)}><X size={16} /></IconButton>
              : <Button variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus size={15} />新建问题</Button>}
          </div>
          {creating ? <div className={styles.form}>
            {draft.annotationId ? <InlineAlert tone="info"><Link2 size={14} aria-hidden="true" /> 已关联批注 #{draft.annotationId}</InlineAlert> : null}
            <TextInput id="issue-title" label="问题标题" value={draft.title} required
              onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：轴承孔公差未标注" />
            <TextArea id="issue-description" label="问题说明" value={draft.description} required rows={3}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="说明影响和需要修改的内容" />
            <div className={styles.formRow}>
              <Select id="issue-severity" label="严重级" value={draft.severity}
                options={Object.entries(issueSeverityLabels).map(([value, label]) => ({ value, label }))}
                onChange={(event) => setDraft({ ...draft, severity: event.target.value as ApprovalIssueInput["severity"] })} />
              <Select id="issue-assignee" label="负责人" value={draft.assigneeUserId} required options={assigneeOptions}
                onChange={(event) => setDraft({ ...draft, assigneeUserId: event.target.value })} />
            </div>
            <TextInput id="issue-due-at" label="到期时间" type="datetime-local" value={toDateTimeLocal(draft.dueAt)}
              onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
            <div className={styles.formActions}><Button loading={busyAction === "issue-create"} onClick={() => void createIssue()}>创建正式问题</Button></div>
          </div> : null}
          <IssueFilters filters={filters} assigneeOptions={filterAssigneeOptions} pageOptions={pageOptions}
            onChange={(next) => { setFilters(next); setSelectedIssueId(null); }} />
          <div className={styles.list}>
            {filteredIssues.map((issue) => <IssueListItem key={issue.id} issue={issue} selected={issue.id === selectedIssueId}
              onSelect={() => { setSelectedIssueId(issue.id); setTransitionAction(null); setEditDraft(null); }} />)}
            {filteredIssues.length === 0 ? <p className={styles.empty}>{issues.length === 0 ? "尚未创建正式问题" : "没有符合筛选条件的问题"}</p> : null}
          </div>
        </section> : <section className={styles.section}>
          <h3 className={styles.sectionTitle}>问题清单</h3>
          <IssueFilters filters={filters} assigneeOptions={filterAssigneeOptions} pageOptions={pageOptions}
            onChange={(next) => { setFilters(next); setSelectedIssueId(null); }} />
          <div className={styles.list}>
            {filteredIssues.map((issue) => <IssueListItem key={issue.id} issue={issue} selected={issue.id === selectedIssueId}
              onSelect={() => { setSelectedIssueId(issue.id); setTransitionAction(null); setEditDraft(null); }} />)}
            {filteredIssues.length === 0 ? <p className={styles.empty}>{issues.length === 0 ? "尚未创建正式问题" : "没有符合筛选条件的问题"}</p> : null}
          </div>
        </section>}

        {selectedIssue ? <section className={`${styles.section} ${styles.detail}`} aria-label="所选问题详情">
          <div className={styles.itemTop}>
            <span className={styles.badge} data-severity={selectedIssue.severity}><AlertTriangle size={13} />{issueSeverityLabels[selectedIssue.severity]}</span>
            <span className={styles.badge} data-status={selectedIssue.status}>{issueStatusLabels[selectedIssue.status]}</span>
          </div>
          <h3>{selectedIssue.title}</h3>
          {canEditSelected && !editDraft ? <Button variant="ghost" size="sm" onClick={() => setEditDraft({
            annotationId: selectedIssue.annotationId,
            assigneeUserId: String(selectedIssue.assigneeUserId),
            title: selectedIssue.title,
            description: selectedIssue.description,
            severity: selectedIssue.severity,
            dueAt: selectedIssue.dueAt
          })}>编辑问题字段</Button> : null}
          {editDraft ? <div className={styles.form}>
            <TextInput id="issue-edit-title" label="问题标题" value={editDraft.title} required
              onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} />
            <TextArea id="issue-edit-description" label="问题说明" value={editDraft.description} required rows={3}
              onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} />
            <div className={styles.formRow}>
              <Select id="issue-edit-severity" label="严重级" value={editDraft.severity}
                options={Object.entries(issueSeverityLabels).map(([value, label]) => ({ value, label }))}
                onChange={(event) => setEditDraft({ ...editDraft, severity: event.target.value as ApprovalIssueInput["severity"] })} />
              <Select id="issue-edit-assignee" label="负责人" value={editDraft.assigneeUserId} options={assigneeOptions}
                onChange={(event) => setEditDraft({ ...editDraft, assigneeUserId: event.target.value })} />
            </div>
            <TextInput id="issue-edit-due-at" label="到期时间" type="datetime-local" value={toDateTimeLocal(editDraft.dueAt)}
              onChange={(event) => setEditDraft({ ...editDraft, dueAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
            <div className={styles.formActions}>
              <Button variant="ghost" size="sm" onClick={() => setEditDraft(null)}>取消</Button>
              <Button size="sm" loading={busyAction === `issue-${selectedIssue.id}-update`}
                disabled={!editDraft.title.trim() || !editDraft.description.trim() || !editDraft.assigneeUserId}
                onClick={() => void saveIssueFields()}>保存字段</Button>
            </div>
          </div> : null}
          <p>{selectedIssue.description}</p>
          <dl>
            <dt>负责人</dt><dd>{selectedIssue.assigneeDisplayName ?? `用户 #${selectedIssue.assigneeUserId}`}</dd>
            <dt>创建人</dt><dd>{selectedIssue.creatorDisplayName ?? `用户 #${selectedIssue.creatorUserId}`}</dd>
            <dt>到期时间</dt><dd>{selectedIssue.dueAt ? new Date(selectedIssue.dueAt).toLocaleString() : "未设置"}</dd>
            {selectedIssue.resolutionSummary ? <><dt>处理说明</dt><dd>{selectedIssue.resolutionSummary}</dd></> : null}
            {selectedIssue.reviewNote ? <><dt>复核记录</dt><dd>{selectedIssue.reviewNote}</dd></> : null}
            {selectedIssue.forcedCloseReason ? <><dt>强制关闭原因</dt><dd>{selectedIssue.forcedCloseReason}</dd></> : null}
          </dl>
          {selectedIssue.annotationId ? <Button variant="ghost" size="sm" onClick={() => onLocateAnnotation(selectedIssue.annotationId!)}>
            <Link2 size={15} />定位关联批注
          </Button> : null}
          <ul className={styles.events} aria-label="问题处理与复核记录">
            {events.map((event) => <li key={event.id}><div>
              <strong>{issueEventLabel(event.action)}</strong>
              <span>{event.actorDisplayName ?? `用户 #${event.actorUserId}`}{event.note ? ` · ${event.note}` : ""}</span>
              <time>{new Date(event.createdAt).toLocaleString()}</time>
            </div></li>)}
          </ul>
          {actions.length > 0 ? <div className={styles.actionBox}>
            <div className={styles.actionButtons}>{actions.map((action) => <Button key={action} size="sm"
              variant={action === "force_close" ? "danger" : action === "close" ? "primary" : "secondary"}
              onClick={() => {
                if (issueActionNeedsNote(action)) {
                  setTransitionAction(action);
                  setTransitionNote("");
                } else {
                  void onTransition(selectedIssue, action).catch(() => undefined);
                }
              }}>{issueActionLabel(action)}</Button>)}</div>
            {transitionAction ? <>
              {issueActionNeedsNote(transitionAction) ? <TextArea id="issue-transition-note" label={`${issueActionLabel(transitionAction)}说明`}
                required rows={3} value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} /> : null}
              <div className={styles.formActions}>
                <Button variant="ghost" size="sm" onClick={() => setTransitionAction(null)}>取消</Button>
                <Button size="sm" variant={transitionAction === "force_close" ? "danger" : "primary"}
                  disabled={issueActionNeedsNote(transitionAction) && !transitionNote.trim()}
                  loading={busyAction === `issue-${selectedIssue.id}-${transitionAction}`}
                  onClick={() => void submitTransition()}>{issueActionLabel(transitionAction)}</Button>
              </div>
            </> : null}
          </div> : null}
        </section> : null}
      </div>
    </section>
  );
}

function IssueFilters({
  filters,
  assigneeOptions,
  pageOptions,
  onChange
}: {
  filters: ApprovalIssueFilters;
  assigneeOptions: Array<{ value: string; label: string }>;
  pageOptions: Array<{ value: string; label: string }>;
  onChange: (filters: ApprovalIssueFilters) => void;
}) {
  return <div className={styles.filters} aria-label="正式问题筛选">
    <Select id="issue-filter-status" label="状态" value={filters.status}
      options={[{ value: "all", label: "全部状态" }, ...Object.entries(issueStatusLabels).map(([value, label]) => ({ value, label }))]}
      onChange={(event) => onChange({ ...filters, status: event.target.value as ApprovalIssueFilters["status"] })} />
    <Select id="issue-filter-severity" label="严重级" value={filters.severity}
      options={[{ value: "all", label: "全部严重级" }, ...Object.entries(issueSeverityLabels).map(([value, label]) => ({ value, label }))]}
      onChange={(event) => onChange({ ...filters, severity: event.target.value as ApprovalIssueFilters["severity"] })} />
    <Select id="issue-filter-assignee" label="负责人" value={String(filters.assigneeUserId)} options={assigneeOptions}
      onChange={(event) => onChange({ ...filters, assigneeUserId: event.target.value === "all" ? "all" : Number(event.target.value) })} />
    <Select id="issue-filter-page" label="页面" value={String(filters.pageNumber)} options={pageOptions}
      onChange={(event) => onChange({ ...filters, pageNumber: event.target.value === "all" ? "all" : Number(event.target.value) })} />
  </div>;
}

function IssueListItem({ issue, selected, onSelect }: { issue: ApprovalIssue; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={styles.item} aria-current={selected ? "true" : undefined} onClick={onSelect}>
    <span className={styles.itemTop}><strong>{issue.title}</strong><span className={styles.badge} data-severity={issue.severity}>{issueSeverityLabels[issue.severity]}</span></span>
    <span className={styles.itemMeta}><span>{issueStatusLabels[issue.status]}</span><span>{issue.assigneeDisplayName ?? "未分配"}</span></span>
  </button>;
}

function emptyDraft(annotationId: number | null): IssueDraft {
  return { annotationId, assigneeUserId: "", title: "", description: "", severity: "medium", dueAt: null };
}

function issueEventLabel(action: ApprovalIssueEvent["action"]) {
  return ({
    created: "创建问题",
    started: "开始处理",
    submitted_review: "提交复核",
    returned: "退回修改",
    closed: "复核关闭",
    force_closed: "管理员强制关闭"
  } as const)[action];
}

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
