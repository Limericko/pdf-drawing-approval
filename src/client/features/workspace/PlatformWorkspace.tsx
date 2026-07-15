import { Activity, ArrowUpRight, Circle, ClipboardCheck, Cloud, FileText, FolderKanban, MapPin,
  MousePointer2, PackageSearch, Pencil, PenLine, Settings, Square, TriangleAlert, Type, FolderSync } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { getProjectAccess, updateOwnAccount, type PlatformSessionContext } from "../../api/identityClient.ts";
import { decideApproval, getApproval, listApprovals, submitDrawingRevision, uploadDocumentDraft } from "../../api/approvalClient.ts";
import { createIssue, forceCloseIssue, getIssue, listIssues, reviewIssue, startIssue, submitIssue } from "../../api/issueClient.ts";
import { getPdmPart, listPdmParts, retryPdmPublish, updatePdmMetadata, voidPdmRevision,
  type PlatformPartDetail } from "../../api/pdmClient.ts";
import { getMySignature, uploadMySignature } from "../../api/signatureClient.ts";
import { listPrintArchive, recordPrintArchive } from "../../api/printArchiveClient.ts";
import { listMyTasks } from "../../api/taskClient.ts";
import { getAdminDiagnostics, listAdminAudit, listAdminBackups, listAdminUsers, revokeAdminUserSessions,
  retryAdminJob, setAdminUserStatus, getAdminSmtpSettings, updateAdminSmtpSettings } from "../../api/administrationClient.ts";
import { Button, ButtonGroup, ButtonLink } from "../../ui/actions/index.tsx";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "../../ui/feedback/index.tsx";
import { FileDropzone, FormActions, PasswordInput, Select, TextArea, TextInput } from "../../ui/forms/index.tsx";
import { AppNavigation } from "../../ui/navigation/index.tsx";
import { AppShell } from "../../patterns/AppShell/index.tsx";
import { PageHeader } from "../../patterns/PageHeader/index.tsx";
import styles from "./PlatformWorkspace.module.css";
import { PlatformAccessPage } from "../identity/PlatformAccessPage.tsx";
import { PdfAnnotationWorkspace, type AnnotationTool } from "../../widgets/PdfAnnotationWorkspace.tsx";
import { PdfSignaturePlacementWorkspace } from "../../widgets/PdfSignaturePlacementWorkspace.tsx";
import { defaultSignaturePlacements } from "../../widgets/SignaturePlacementEditor.tsx";
import type { SignaturePlacement } from "../../widgets/signaturePlacementTypes.ts";
import type { ApprovalAnnotationInput } from "../pdf-studio/annotationTypes.ts";
import { platformAnnotationToWorkspace, workspaceAnnotationToPlatform } from "../pdf-studio/platformAnnotationAdapter.ts";
import { getDesktopPrintSettings, isDesktopClient, printSignedPdfWithDesktop } from "../../clientConfig.ts";
import { toDesktopPrintOptions } from "../../printSettings.ts";

type Route = { name: "tasks" | "drawings" | "issues" | "pdm" | "signature" | "projects" | "sync" | "administration" } |
  { name: "approval" | "issue" | "part"; id: string };
type Project = PlatformSessionContext["projects"][number];
const SyncCenterPage = lazy(() => import("../../pages/SyncCenterPage.tsx")
  .then((module) => ({ default: module.SyncCenterPage })));
const ANNOTATION_TOOLS: ReadonlyArray<{ value: AnnotationTool; label: string; icon: typeof MousePointer2 }> = [
  { value: "select", label: "选择", icon: MousePointer2 }, { value: "pin", label: "定位", icon: MapPin },
  { value: "rect", label: "矩形", icon: Square }, { value: "arrow", label: "箭头", icon: ArrowUpRight },
  { value: "circle", label: "圆", icon: Circle }, { value: "text", label: "文字", icon: Type },
  { value: "ink", label: "画笔", icon: Pencil }, { value: "cloud", label: "云线", icon: Cloud }
];
const ANNOTATION_COLORS = [
  { value: "red", label: "红色" }, { value: "amber", label: "琥珀色" },
  { value: "blue", label: "蓝色" }, { value: "green", label: "绿色" }
] as const;

export function PlatformWorkspace({ user, context, logoutBusy, logoutError, onLogout }: {
  readonly user: PlatformSessionContext["user"];
  readonly context: Pick<PlatformSessionContext, "globalCapabilities" | "projects">;
  readonly logoutBusy: boolean;
  readonly logoutError: string;
  readonly onLogout: () => void | Promise<void>;
}) {
  const [route, setRoute] = useState<Route>(() => workspaceRoute(location.hash));
  const [collapsed, setCollapsed] = useState(false);
  const [projectId, setProjectId] = useState(context.projects[0]?.id ?? "");
  useEffect(() => {
    const listener = () => setRoute(workspaceRoute(location.hash));
    addEventListener("hashchange", listener);
    return () => removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    if (!context.projects.some((project) => project.id === projectId)) setProjectId(context.projects[0]?.id ?? "");
  }, [context.projects, projectId]);
  const project = context.projects.find((candidate) => candidate.id === projectId);
  const admin = context.globalCapabilities.includes("platform.security.manage");
  const nav = [
    { id: "tasks", href: "#/workspace", label: "任务中心", icon: ClipboardCheck },
    { id: "drawings", href: "#/workspace/drawings", label: "图纸中心", icon: FileText },
    { id: "pdm", href: "#/workspace/pdm", label: "PDM 零件库", icon: PackageSearch },
    { id: "signature", href: "#/workspace/signature", label: "我的签名", icon: PenLine },
    { id: "projects", href: "#/workspace/projects", label: "项目与成员", icon: FolderKanban },
    ...(admin ? [{ id: "sync", href: "#/workspace/sync", label: "同步中心", icon: FolderSync }] : []),
    ...(admin ? [{ id: "administration", href: "#/workspace/administration", label: "系统管理", icon: Settings }] : [])
  ];
  const current = route.name === "approval" || route.name === "issues" || route.name === "issue" ? "drawings" : route.name === "part" ? "pdm" : route.name;
  return <AppShell collapsed={collapsed} onToggleCollapsed={() => setCollapsed((value) => !value)}
    brand={{ name: "工程图纸协同", subtitle: "PDF 审阅与标注工作台", logoSrc: "/app-icon.png" }}
    navigation={<AppNavigation collapsed={collapsed} currentId={current} items={nav} />}
    user={{ displayName: user.displayName, roleLabel: project ? roleLabel(project.role) : platformRole(user.platformRole),
      compactRoleLabel: project ? roleLabel(project.role).slice(0, 1) : "管" }} onLogout={() => void onLogout()}>
    <div className={styles.workspace}>
      <header className={styles.contextBar}>
        <div><FolderKanban size={17} aria-hidden="true" /><span>当前项目</span></div>
        <select aria-label="当前项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {context.projects.map((item) => <option key={item.id} value={item.id}>{item.name} · {roleLabel(item.role)}</option>)}
        </select>
        <span className={styles.runtime}><span aria-hidden="true" />云端工作区</span>
      </header>
      {logoutBusy ? <InlineAlert>正在安全退出…</InlineAlert> : null}
      {logoutError ? <InlineAlert tone="danger">{logoutError}</InlineAlert> : null}
      {route.name === "projects" ? <PlatformAccessPage user={user} context={context} embedded
        logoutBusy={logoutBusy} logoutError={logoutError} onLogout={onLogout} /> : null}
      {route.name === "administration" && admin ? <AdministrationPage user={user} /> : null}
      {route.name === "sync" && admin ? <Suspense fallback={<Skeleton lines={8} label="正在加载同步中心" />}>
        <SyncCenterPage projects={context.projects} currentProjectId={projectId} />
      </Suspense> : null}
      {route.name !== "projects" && route.name !== "sync" && route.name !== "administration" && !project ?
        <EmptyState title="暂无可访问项目">请先在“项目与成员”创建项目，或联系管理员分配项目权限。</EmptyState> : null}
      {route.name !== "projects" && route.name !== "sync" && route.name !== "administration" && project ? <>
        {route.name === "tasks" ? <TaskPage project={project} /> : null}
        {route.name === "drawings" ? <DrawingPage project={project} /> : null}
        {route.name === "approval" ? <ApprovalPage project={project} approvalId={route.id} user={user} /> : null}
        {route.name === "issues" ? <IssueListPage project={project} /> : null}
        {route.name === "issue" ? <IssuePage project={project} issueId={route.id} /> : null}
        {route.name === "pdm" ? <PdmPage project={project} /> : null}
        {route.name === "part" ? <PartPage project={project} partId={route.id} /> : null}
        {route.name === "signature" ? <SignaturePage /> : null}
      </> : null}
    </div>
  </AppShell>;
}

function TaskPage({ project }: { project: Project }) {
  const resource = useResource(() => listMyTasks({ projectId: project.id }), [project.id]);
  return <Page title="任务中心" eyebrow="ROLE QUEUE" description={`${project.name} · 按阻塞程度与到期时间排序`} resource={resource}>
    {(data) => data.items.length === 0 ? <EmptyState title="当前没有待办">新的审阅、问题或补录任务会出现在这里。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>优先级</th><th>任务</th><th>说明</th><th>到期</th><th /></tr></thead>
        <tbody>{data.items.map((task) => <tr key={task.id}><td><Priority value={task.priority} /></td>
          <td><strong>{task.title}</strong><small>{task.kind}</small></td><td>{task.summary}</td>
          <td className={styles.mono}>{task.dueAt ? formatDate(task.dueAt) : "—"}</td>
          <td><ButtonLink size="sm" variant="secondary" href={workspaceTarget(task.target.route)}>打开</ButtonLink></td></tr>)}</tbody></table></div>}
  </Page>;
}

function DrawingPage({ project }: { project: Project }) {
  const [refresh, setRefresh] = useState(0);
  const resource = useResource(() => listApprovals(project.id, { page: 1, pageSize: 50 }), [project.id, refresh]);
  const memberResource = useResource(() => getProjectAccess(project.id), [project.id]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof uploadDocumentDraft>> | null>(null);
  const [supervisorUserId, setSupervisorUserId] = useState(""); const [processUserId, setProcessUserId] = useState("");
  const [placements, setPlacements] = useState<SignaturePlacement[]>(defaultSignaturePlacements);
  const members = memberResource.status === "ready" ? (memberResource.data.members ?? []) : [];
  const supervisorOptions = members.filter((member) => member.role === "supervisor" && member.status === "active");
  const processOptions = members.filter((member) => member.role === "process" && member.status === "active");
  useEffect(() => {
    if (!supervisorUserId && supervisorOptions[0]) setSupervisorUserId(supervisorOptions[0].userId);
    if (!processUserId && processOptions[0]) setProcessUserId(processOptions[0].userId);
  }, [processOptions, processUserId, supervisorOptions, supervisorUserId]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(""); setError("");
    const form = event.currentTarget; const data = new FormData(form); const file = data.get("drawing");
    try {
      if (!(file instanceof File)) throw new Error();
      const draft = await uploadDocumentDraft(project.id, file, {
        documentCode: String(data.get("documentCode") ?? ""), name: String(data.get("name") ?? ""),
        revisionCode: String(data.get("revisionCode") ?? ""), source: "web_upload",
        materialCode: String(data.get("materialCode") ?? "").trim() || null,
        idempotencyKey: `draft:${project.id}:${crypto.randomUUID()}`
      });
      setDraft(draft); setPlacements(defaultSignaturePlacements());
      setMessage(`草稿已创建：${draft.document.documentCode} / ${draft.revision.revisionCode}`); form.reset(); setRefresh((v) => v + 1);
    } catch { setError("上传失败。请确认文件为 PDF，且图号与版本填写完整。"); } finally { setBusy(false); }
  }
  async function submitDraft() {
    if (!draft || !supervisorUserId || !processUserId) return;
    setBusy(true); setError("");
    try {
      await submitDrawingRevision(project.id, draft.revision.id, { version: draft.revision.version,
        supervisorUserId, processUserId, requiresSignature: true,
        placements: placements.map(({ role: signerRole, ...placement }) => ({ signerRole, ...placement })),
        idempotencyKey: `submit:${draft.revision.id}:${crypto.randomUUID()}` });
      setDraft(null); setMessage("图纸已提交，主管与工艺将并行审核。"); setRefresh((v) => v + 1);
    } catch { setError("提交审核失败。请确认主管、工艺和三个签名框均已设置。"); } finally { setBusy(false); }
  }
  return <div className={styles.stack}><PageHeader eyebrow="DRAWING REGISTER" title="图纸中心"
    description="文档优先视图：上传、审批状态与版本入口保持在同一工作区。" />
    {project.capabilities.includes("drawings.submit") ? <form className={styles.uploadStrip} onSubmit={(event) => void upload(event)}>
      <TextInput id="document-code" name="documentCode" label="图号" required placeholder="GX-240714-001" />
      <TextInput id="document-name" name="name" label="图纸名称" required placeholder="减速器壳体" />
      <TextInput id="revision-code" name="revisionCode" label="版本" required placeholder="A01" />
      <TextInput id="material-code" name="materialCode" label="材料牌号" placeholder="QT450-10" />
      <FileDropzone id="drawing-file" name="drawing" label="PDF 文件" accept="application/pdf,.pdf" required />
      <FormActions><Button type="submit" loading={busy} loadingLabel="正在上传">上传并创建草稿</Button></FormActions>
    </form> : null}
    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}{error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    {draft ? <section className={styles.submitPanel} aria-label="提交图纸审核">
      <div><h2>提交审核</h2><p>{draft.document.documentCode} · {draft.revision.revisionCode} · 选择主管、工艺并确认三个签名框。</p></div>
      {memberResource.status === "loading" ? <Skeleton lines={2} label="正在读取项目成员" /> : null}
      {memberResource.status === "error" ? <ErrorState title="项目成员加载失败" onRetry={memberResource.retry}>请重试后再提交。</ErrorState> : null}
      {memberResource.status === "ready" ? <>
        <div className={styles.submitSelectors}><Select id="submit-supervisor" label="主管审阅人" value={supervisorUserId}
          options={[{ value: "", label: "选择主管", disabled: true }, ...supervisorOptions.map((member) => ({ value: member.userId, label: member.displayName }))]}
          onChange={(event) => setSupervisorUserId(event.target.value)} />
          <Select id="submit-process" label="工艺复核人" value={processUserId}
            options={[{ value: "", label: "选择工艺", disabled: true }, ...processOptions.map((member) => ({ value: member.userId, label: member.displayName }))]}
            onChange={(event) => setProcessUserId(event.target.value)} /></div>
        <section className={styles.placementWorkspace} aria-label="PDF 签名框定位">
          <div><h3>在 PDF 上定位签名</h3><p>拖动设计、主管、工艺签名框定位；拖动右下角控制点调整大小。</p></div>
          <PdfSignaturePlacementWorkspace pdfUrl={objectUrl(draft.revision.originalObjectId)}
            placements={placements} onChange={setPlacements} />
        </section>
        <FormActions><Button variant="ghost" onClick={() => setDraft(null)}>稍后提交</Button><Button loading={busy} disabled={!supervisorUserId || !processUserId}
          onClick={() => void submitDraft()}>提交审核</Button></FormActions>
      </> : null}
    </section> : null}
    <ResourceView resource={resource}>{(data) => data.items.length === 0 ? <EmptyState title="暂无图纸">上传第一份工程图纸开始协作。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>图号 / 名称</th><th>版本</th><th>状态</th><th>主管</th><th>工艺</th><th>更新时间</th><th /></tr></thead>
        <tbody>{data.items.map((approval) => <tr key={approval.id}><td><strong>{approval.document.documentCode}</strong><small>{approval.document.name}</small></td>
          <td className={styles.mono}>{approval.revision.revisionCode}</td><td><State value={approval.status} /></td>
          {approval.decisions.map((decision) => <td key={decision.reviewerRole}><State value={decision.status} /></td>)}
          <td className={styles.mono}>{formatDate(approval.updatedAt)}</td><td><ButtonLink size="sm" variant="secondary"
            href={`#/workspace/approvals/${approval.id}`}>审阅</ButtonLink></td></tr>)}</tbody></table></div>}
    </ResourceView>
  </div>;
}

function ApprovalPage({ project, approvalId, user }: { project: Project; approvalId: string;
  user: PlatformSessionContext["user"] }) {
  const [refresh, setRefresh] = useState(0);
  const resource = useResource(() => getApproval(project.id, approvalId), [project.id, approvalId, refresh]);
  const issueResource = useResource(() => listIssues(project.id, { approvalCaseId: approvalId, page: 1, pageSize: 100 }),
    [project.id, approvalId, refresh]);
  const archiveResource = useResource(() => listPrintArchive(project.id, approvalId), [project.id, approvalId, refresh]);
  const [comment, setComment] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [color, setColor] = useState<"red" | "amber" | "blue" | "green">("red");
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<number | null>(null);
  const [draftAnnotation, setDraftAnnotation] = useState<ApprovalAnnotationInput | null>(null);
  const [issueTitle, setIssueTitle] = useState(""); const [issueDescription, setIssueDescription] = useState("");
  const [issueSeverity, setIssueSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [printing, setPrinting] = useState(false);
  const issues = issueResource.status === "ready" ? issueResource.data.items : [];
  const annotations = useMemo(() => issues.flatMap((issue) => issue.annotation
    ? [platformAnnotationToWorkspace(issue.annotation, issue)] : []), [issues]);
  const pageIssueCounts = useMemo(() => annotations.reduce<Record<number, number>>((counts, annotation) => {
    counts[annotation.pageNumber] = (counts[annotation.pageNumber] ?? 0) + 1; return counts;
  }, {}), [annotations]);
  return <Page title="图纸审阅" eyebrow="PDF REVIEW" description={project.name} resource={resource}>
    {(approval) => {
      const decision = approval.decisions.find((item) => item.assignedUserId === user.id && item.status === "pending");
      const canAnnotate = approval.status === "pending" && ["manager", "supervisor", "process"].includes(project.role);
      const blockingCount = issues.filter((issue) => issue.status !== "closed" &&
        (issue.severity === "high" || issue.severity === "critical")).length;
      const signedArtifact = approval.artifacts.find((artifact) => artifact.kind === "signed_pdf" &&
        artifact.status === "ready" && artifact.objectId);
      async function decide(value: "approved" | "rejected") {
        if (!decision) return; setBusy(true); setError("");
        try { await decideApproval(project.id, approval.id, decision.reviewerRole,
          { decision: value, comment: comment.trim() || null, version: decision.version,
            idempotencyKey: `decision:${decision.id}:${crypto.randomUUID()}` }); setRefresh((v) => v + 1); }
        catch { setError(value === "rejected" && !comment.trim() ? "驳回时必须填写说明。" : "审核状态已变化，请刷新后重试。"); }
        finally { setBusy(false); }
      }
      function beginIssue(annotation: ApprovalAnnotationInput) {
        setDraftAnnotation(annotation); setIssueTitle(`${annotationToolLabel(annotation.kind)}标注需要确认`);
        setIssueDescription(annotation.message === "请填写批注内容" ? "请核对标注位置并完成图纸修改。" : annotation.message);
        setIssueSeverity("medium"); setSelectedAnnotationId(null);
      }
      async function saveIssue() {
        if (!draftAnnotation || !issueTitle.trim() || !issueDescription.trim()) return;
        setBusy(true); setError("");
        try {
          await createIssue(project.id, approval.id, { title: issueTitle.trim(), description: issueDescription.trim(),
            severity: issueSeverity, assigneeUserId: approval.revision.createdByUserId, dueAt: null,
            annotation: workspaceAnnotationToPlatform({ ...draftAnnotation, message: issueDescription.trim() }),
            idempotencyKey: `issue:${approval.id}:${crypto.randomUUID()}` });
          setDraftAnnotation(null); setIssueTitle(""); setIssueDescription(""); setTool("select");
          setRefresh((value) => value + 1);
        } catch { setError("正式问题创建失败。请确认审批仍可审阅并重试。"); } finally { setBusy(false); }
      }
      async function printAndArchive() {
        if (!signedArtifact?.objectId || !isDesktopClient()) return;
        setPrinting(true); setError("");
        const settings = await getDesktopPrintSettings();
        try {
          const result = await printSignedPdfWithDesktop(objectUrl(signedArtifact.objectId), toDesktopPrintOptions(settings));
          if (!result.success) {
            await recordPrintArchive(project.id, approval.id, { objectId: null,
              printerName: settings.printerName || null, status: "failed",
              errorCode: archiveErrorCode(result.failureReason),
              idempotencyKey: `print:${approval.id}:${crypto.randomUUID()}` });
            throw new Error("PRINT_FAILED");
          }
          await recordPrintArchive(project.id, approval.id, { objectId: signedArtifact.objectId,
            printerName: settings.printerName || null, status: "archived", errorCode: null,
            idempotencyKey: `print:${approval.id}:${crypto.randomUUID()}` });
          setRefresh((value) => value + 1);
        } catch { setError("打印任务未成功提交，失败结果已记录到归档历史。"); }
        finally { setPrinting(false); }
      }
      return <div className={styles.reviewGrid}><section className={styles.documentPane}>
        <div className={styles.documentHeading}><div><strong>{approval.document.documentCode}</strong>
          <span>{approval.document.name} · {approval.revision.revisionCode}</span></div><State value={approval.status} /></div>
        <div className={styles.annotationToolbar} role="toolbar" aria-label="PDF 批注工具">
          {ANNOTATION_TOOLS.map(({ value, label, icon: Icon }) => <Button key={value} size="sm"
            variant={tool === value ? "secondary" : "ghost"} aria-pressed={tool === value}
            disabled={!canAnnotate && value !== "select"} onClick={() => setTool(value)}>
            <Icon size={15} aria-hidden="true" />{label}
          </Button>)}
          <span className={styles.toolbarDivider} aria-hidden="true" />
          {ANNOTATION_COLORS.map((item) => <button key={item.value} type="button" className={styles.colorChoice}
            data-color={item.value} aria-label={`批注颜色：${item.label}`} aria-pressed={color === item.value}
            disabled={!canAnnotate} onClick={() => setColor(item.value)} />)}
        </div>
        <div className={styles.pdfStudio}><PdfAnnotationWorkspace pdfUrl={objectUrl(approval.revision.originalObjectId)}
          annotations={annotations} tool={tool} color={color} readOnly={!canAnnotate}
          selectedAnnotationId={selectedAnnotationId} pageIssueCounts={pageIssueCounts}
          onDraftAnnotation={(annotation) => beginIssue(annotation)}
          onSelectAnnotation={(annotation) => setSelectedAnnotationId(annotation.id)} /></div>
      </section><aside className={styles.inspector}><h2>审阅状态</h2>
        <dl className={styles.definition}>{approval.decisions.map((item) => <div key={item.id}><dt>{roleLabel(item.reviewerRole)}</dt>
          <dd><State value={item.status} />{item.comment ? <p>{item.comment}</p> : null}</dd></div>)}</dl>
        {blockingCount > 0 ? <InlineAlert tone="danger" title="审批被问题阻断">
          还有 {blockingCount} 个高或严重级问题未关闭，不能通过图纸。
        </InlineAlert> : null}
        {draftAnnotation ? <div className={styles.actionPanel} aria-label="新建正式问题">
          <h3>新建正式问题</h3><p>第 {draftAnnotation.pageNumber} 页 · {annotationToolLabel(draftAnnotation.kind)}</p>
          <TextInput id="platform-issue-title" label="问题标题" value={issueTitle} required
            onChange={(event) => setIssueTitle(event.target.value)} />
          <TextArea id="platform-issue-description" label="问题说明" value={issueDescription} required rows={4}
            onChange={(event) => setIssueDescription(event.target.value)} />
          <Select id="platform-issue-severity" label="严重级" value={issueSeverity}
            options={[{ value: "low", label: "低" }, { value: "medium", label: "中" },
              { value: "high", label: "高" }, { value: "critical", label: "严重" }]}
            onChange={(event) => setIssueSeverity(event.target.value as typeof issueSeverity)} />
          <ButtonGroup><Button variant="ghost" onClick={() => setDraftAnnotation(null)}>取消</Button>
            <Button loading={busy} disabled={!issueTitle.trim() || !issueDescription.trim()}
              onClick={() => void saveIssue()}>创建并指派设计师</Button></ButtonGroup>
        </div> : null}
        <section className={styles.issueSummary} aria-label="当前图纸问题">
          <div><h3>当前图纸问题</h3><span>{issues.filter((issue) => issue.status !== "closed").length} 个未关闭</span></div>
          {issueResource.status === "loading" ? <Skeleton lines={3} label="正在读取问题" /> : null}
          {issueResource.status === "error" ? <ErrorState title="问题加载失败" onRetry={issueResource.retry}>请重试。</ErrorState> : null}
          {issueResource.status === "ready" && issues.length === 0 ? <p>尚未创建正式问题。</p> : null}
          {issues.map((issue) => { const marker = annotations.find((annotation) => annotation.externalId === issue.annotationId);
            return <button key={issue.id} type="button" className={styles.issueRow}
            aria-current={selectedAnnotationId === marker?.id ? "true" : undefined}
            onClick={() => setSelectedAnnotationId(marker?.id ?? null)}>
            <span><Priority value={issue.severity === "critical" ? "blocking" : issue.severity === "high" ? "high" : "normal"} />
              <strong>{issue.title}</strong></span><State value={issue.status} />
          </button>; })}
        </section>
        <section className={styles.issueSummary} aria-label="打印归档记录">
          <div><h3>打印归档</h3>{signedArtifact ? <State value="ready" /> : <State value="pending" />}</div>
          {archiveResource.status === "loading" ? <Skeleton lines={2} label="正在读取归档记录" /> : null}
          {archiveResource.status === "error" ? <ErrorState title="归档记录加载失败" onRetry={archiveResource.retry}>请重试。</ErrorState> : null}
          {archiveResource.status === "ready" && archiveResource.data.items.length === 0 ? <p>尚无打印归档记录。</p> : null}
          {archiveResource.status === "ready" ? archiveResource.data.items.slice(0, 5).map((event) =>
            <div key={event.id} className={styles.archiveRow}><State value={event.status} />
              <span>{event.printerName ?? "系统默认打印机"} · {formatDate(event.createdAt)}</span></div>) : null}
          {signedArtifact?.objectId && ["designer", "manager"].includes(project.role) ? isDesktopClient() ?
            <Button size="sm" variant="secondary" loading={printing} onClick={() => void printAndArchive()}>桌面打印并归档</Button> :
            <p>在 Windows 桌面客户端中打开后可打印并自动归档。</p> : null}
        </section>
        {decision ? <div className={styles.actionPanel}><TextArea id="review-comment" label="审核意见" value={comment}
          onChange={(event) => setComment(event.target.value)} rows={4} />{error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <ButtonGroup><Button loading={busy} disabled={blockingCount > 0} onClick={() => void decide("approved")}>通过</Button>
            <Button variant="danger" loading={busy} onClick={() => void decide("rejected")}>驳回</Button></ButtonGroup></div> : null}
        <ButtonLink variant="secondary" href={`#/workspace/issues?approval=${approval.id}`}>查看问题</ButtonLink>
      </aside></div>;
    }}
  </Page>;
}

function IssuePage({ project, issueId }: { project: Project; issueId: string }) {
  const [refresh, setRefresh] = useState(0); const resource = useResource(() => getIssue(project.id, issueId), [project.id, issueId, refresh]);
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function run(action: (issue: Awaited<ReturnType<typeof getIssue>>) => Promise<unknown>, issue: Awaited<ReturnType<typeof getIssue>>) {
    setBusy(true); setError(""); try { await action(issue); setNote(""); setRefresh((v) => v + 1); }
    catch { setError("问题状态已变化或当前角色无权执行该操作。"); } finally { setBusy(false); }
  }
  return <Page title="问题处理" eyebrow="ISSUE LOOP" description={project.name} resource={resource}>{(issue) => <div className={styles.issueLayout}>
    <section><div className={styles.issueTitle}><State value={issue.status} /><Priority value={issue.severity === "critical" ? "blocking" : issue.severity === "high" ? "high" : "normal"} /></div>
      <h2>{issue.title}</h2><p>{issue.description}</p><dl className={styles.definition}><div><dt>负责人</dt><dd className={styles.mono}>{issue.assigneeUserId}</dd></div>
        <div><dt>到期</dt><dd>{issue.dueAt ? formatDate(issue.dueAt) : "未设置"}</dd></div></dl></section>
    <aside className={styles.inspector}><TextArea id="issue-note" label={issue.status === "in_progress" ? "解决说明" : "处理意见"}
      rows={5} value={note} onChange={(event) => setNote(event.target.value)} />{error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className={styles.verticalActions}>{issue.status === "open" ? <Button loading={busy}
        onClick={() => void run((current) => startIssue(project.id, current.id, { version: current.version,
          idempotencyKey: `issue:start:${crypto.randomUUID()}` }), issue)}>开始处理</Button> : null}
        {issue.status === "in_progress" ? <Button loading={busy} disabled={!note.trim()}
          onClick={() => void run((current) => submitIssue(project.id, current.id, { version: current.version,
            resolutionSummary: note, idempotencyKey: `issue:submit:${crypto.randomUUID()}` }), issue)}>提交复核</Button> : null}
        {issue.status === "review" ? <><Button loading={busy} disabled={!note.trim()}
          onClick={() => void run((current) => reviewIssue(project.id, current.id, { version: current.version,
            decision: "closed", note, idempotencyKey: `issue:close:${crypto.randomUUID()}` }), issue)}>复核通过</Button>
          <Button variant="secondary" loading={busy} disabled={!note.trim()}
            onClick={() => void run((current) => reviewIssue(project.id, current.id, { version: current.version,
              decision: "returned", note, idempotencyKey: `issue:return:${crypto.randomUUID()}` }), issue)}>退回处理</Button></> : null}
        {project.role === "manager" && issue.status !== "closed" ? <Button variant="danger" loading={busy} disabled={!note.trim()}
          onClick={() => void run((current) => forceCloseIssue(project.id, current.id, { version: current.version,
            reason: note, idempotencyKey: `issue:force:${crypto.randomUUID()}` }), issue)}>强制关闭</Button> : null}</div>
    </aside></div>}</Page>;
}

function IssueListPage({ project }: { project: Project }) {
  const approvalId = new URLSearchParams(location.hash.split("?", 2)[1] ?? "").get("approval");
  const resource = useResource(() => listIssues(project.id, { page: 1, pageSize: 100 }), [project.id]);
  return <Page title="问题中心" eyebrow="ISSUE REGISTER" description="问题指派、处理与复核状态。" resource={resource}>
    {(data) => { const items = approvalId ? data.items.filter((issue) => issue.approvalCaseId === approvalId) : data.items;
      return items.length === 0 ? <EmptyState title="没有匹配的问题">当前图纸没有未结问题。</EmptyState> :
        <div className={styles.tableWrap}><table><thead><tr><th>严重度</th><th>问题</th><th>状态</th><th>到期</th><th /></tr></thead>
          <tbody>{items.map((issue) => <tr key={issue.id}><td><Priority value={issue.severity === "critical" ? "blocking" : issue.severity === "high" ? "high" : "normal"} /></td>
            <td><strong>{issue.title}</strong><small>{issue.description}</small></td><td><State value={issue.status} /></td>
            <td>{issue.dueAt ? formatDate(issue.dueAt) : "—"}</td><td><ButtonLink size="sm" variant="secondary"
              href={`#/workspace/issues/${issue.id}`}>处理</ButtonLink></td></tr>)}</tbody></table></div>; }}
  </Page>;
}

function PdmPage({ project }: { project: Project }) {
  const resource = useResource(() => listPdmParts(project.id, { page: 1, pageSize: 50 }), [project.id]);
  return <Page title="PDM 零件库" eyebrow="RELEASED DRAWINGS" description="当前版本、材料牌号与完整发布历史。" resource={resource}>
    {(data) => data.items.length === 0 ? <EmptyState title="暂无已发布零件">双审与签章完成后，版本会自动进入零件库。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>零件号</th><th>名称</th><th>当前版本</th><th>材料</th><th>发布状态</th><th /></tr></thead>
        <tbody>{data.items.map((part) => <tr key={part.id}><td className={styles.mono}><strong>{part.partNumber}</strong></td><td>{part.name}</td>
          <td className={styles.mono}>{part.currentRevisionCode ?? "—"}</td><td>{part.materialCode ?? "待补录"}</td>
          <td><State value={part.releaseStatus ?? "pending"} /></td><td><ButtonLink size="sm" variant="secondary"
            href={`#/workspace/pdm/${part.id}`}>追溯</ButtonLink></td></tr>)}</tbody></table></div>}
  </Page>;
}

function PartPage({ project, partId }: { project: Project; partId: string }) {
  const [refresh, setRefresh] = useState(0); const [message, setMessage] = useState("");
  const resource = useResource(() => getPdmPart(project.id, partId), [project.id, partId, refresh]);
  return <Page title="零件追溯" eyebrow="PDM TRACE" description={project.name} resource={resource}>{(data) => <div className={styles.stack}>
    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
    <section className={styles.partHeader}><div><span className={styles.mono}>{data.part.partNumber}</span><h2>{data.part.name}</h2></div>
      <div><span>当前版本</span><strong className={styles.mono}>{data.part.currentRevisionCode ?? "—"}</strong></div></section>
    <div className={styles.tableWrap}><table><thead><tr><th>版本</th><th>材料</th><th>状态</th><th>发布日期</th><th>对象</th><th>版本操作</th></tr></thead>
      <tbody>{data.revisions.map((revision) => <tr key={revision.linkId}><td className={styles.mono}>{revision.revisionCode}</td>
        <td>{revision.materialCode ?? "待补录"}</td><td><State value={revision.releaseStatus} /></td>
        <td className={styles.mono}>{revision.releasedAt ? formatDate(revision.releasedAt) : "—"}</td><td><div className={styles.objectLinks}>
          <a href={objectUrl(revision.originalObjectId)} target="_blank" rel="noreferrer">原始 PDF</a>
          {revision.signedObjectId ? <a href={objectUrl(revision.signedObjectId)} target="_blank" rel="noreferrer">签后 PDF</a> : null}
          {revision.annotatedObjectId ? <a href={objectUrl(revision.annotatedObjectId)} target="_blank" rel="noreferrer">审查版</a> : null}
        </div></td><td><PdmRevisionActions projectId={project.id} revision={revision} canVoid={project.role === "manager"}
          onChanged={(nextMessage) => { setMessage(nextMessage); setRefresh((value) => value + 1); }} /></td></tr>)}</tbody></table></div>
    <section><h2>使用项目</h2><ul className={styles.usageList}>{data.usages.map((usage) => <li key={usage.projectId}>
      <strong>{usage.projectName}</strong><span>最近更新 {formatDate(usage.updatedAt)}</span></li>)}</ul></section>
  </div>}</Page>;
}

export function PdmRevisionActions({ projectId, revision, canVoid, onChanged }: {
  readonly projectId: string;
  readonly revision: PlatformPartDetail["revisions"][number];
  readonly canVoid: boolean;
  readonly onChanged: (message: string) => void;
}) {
  const [materialCode, setMaterialCode] = useState(revision.materialCode ?? "");
  const [voidReason, setVoidReason] = useState(""); const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function run(action: "metadata" | "retry" | "void") {
    if (action === "metadata" && !materialCode.trim()) { setError("补录材料牌号后才能发布。"); return; }
    if (action === "void" && !voidReason.trim()) { setError("作废版本必须填写原因。"); return; }
    setBusy(action); setError("");
    try {
      if (action === "metadata") await updatePdmMetadata(projectId, revision.linkId, {
        materialCode: materialCode.trim(), version: revision.version,
        idempotencyKey: `pdm:metadata:${revision.linkId}:${crypto.randomUUID()}` });
      if (action === "retry") await retryPdmPublish(projectId, revision.linkId, { version: revision.version,
        idempotencyKey: `pdm:retry:${revision.linkId}:${crypto.randomUUID()}` });
      if (action === "void") await voidPdmRevision(projectId, revision.linkId, { reason: voidReason.trim(),
        version: revision.version, idempotencyKey: `pdm:void:${revision.linkId}:${crypto.randomUUID()}` });
      onChanged(action === "metadata" ? "材料牌号已补录，版本发布已重新执行。" :
        action === "retry" ? "版本发布已重试。" : "版本已作废并保留完整历史。等待刷新…");
    } catch { setError("PDM 版本状态已变化或当前角色无权执行此操作。"); }
    finally { setBusy(""); }
  }
  if (revision.releaseStatus === "void") return <small>{revision.voidReason ? `作废原因：${revision.voidReason}` : "已作废"}</small>;
  return <div className={styles.pdmActions}>
    {revision.releaseStatus === "pending_metadata" ? <div><TextInput id={`pdm-material-${revision.linkId}`}
      label="材料牌号" hideLabel value={materialCode} placeholder="材料牌号" maxLength={160}
      onChange={(event) => setMaterialCode(event.target.value)} />
      <Button size="sm" loading={busy === "metadata"} disabled={!materialCode.trim()}
        onClick={() => void run("metadata")}>补录并发布</Button></div> : null}
    {revision.releaseStatus === "failed" ? <Button size="sm" variant="secondary" loading={busy === "retry"}
      onClick={() => void run("retry")}>重试发布</Button> : null}
    {canVoid ? <div><TextInput id={`pdm-void-${revision.linkId}`} label="作废原因" hideLabel value={voidReason}
      placeholder="作废原因" maxLength={4000} onChange={(event) => setVoidReason(event.target.value)} />
      <Button size="sm" variant="danger" loading={busy === "void"} disabled={!voidReason.trim()}
        onClick={() => void run("void")}>作废版本</Button></div> : null}
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
  </div>;
}

function SignaturePage() {
  const [refresh, setRefresh] = useState(0); const resource = useResource(() => getMySignature(), [refresh]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage(""); const form = event.currentTarget;
    const file = new FormData(form).get("signature");
    try { if (!(file instanceof File)) throw new Error(); await uploadMySignature(file,
      `signature:${crypto.randomUUID()}`); setMessage("签名已更新，后续签章将使用新版本。"); setRefresh((v) => v + 1); form.reset(); }
    catch { setError("签名上传失败。请选择透明背景 PNG，文件不超过 8 MB。"); } finally { setBusy(false); }
  }
  return <div className={styles.stack}><PageHeader eyebrow="PERSONAL SIGNATURE" title="我的签名"
    description="内部可视手写签名，不属于 CA 证书数字签名。" />
    <ResourceView resource={resource}>{(signature) => signature ? <section className={styles.signaturePreview}>
      <img src={objectUrl(signature.objectId)} alt="当前手写签名" /><div><strong>当前签名已启用</strong><span>更新于 {formatDate(signature.createdAt)}</span></div>
    </section> : <EmptyState title="尚未配置签名">上传签名后，双审通过的图纸才可自动生成签后 PDF。</EmptyState>}</ResourceView>
    <form className={styles.signatureForm} onSubmit={(event) => void upload(event)}><FileDropzone id="signature-file" name="signature"
      label="PNG 签名图片" accept="image/png,.png" required description="建议透明背景并裁剪到签名主体。" />
      <Button type="submit" loading={busy} loadingLabel="正在上传">保存为当前签名</Button></form>
    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}{error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
  </div>;
}

function AdministrationPage({ user }: { user: PlatformSessionContext["user"] }) {
  const [refresh, setRefresh] = useState(0);
  const diagnostics = useResource(() => getAdminDiagnostics(), [refresh]);
  const users = useResource(() => listAdminUsers({ page: 1, pageSize: 50 }), [refresh]);
  const backups = useResource(() => listAdminBackups(), [refresh]);
  const audit = useResource(() => listAdminAudit({ page: 1, pageSize: 50 }), [refresh]);
  const smtp = useResource(() => getAdminSmtpSettings(), [refresh]);
  const [reason, setReason] = useState(""); const [busyTarget, setBusyTarget] = useState("");
  const [message, setMessage] = useState(""); const [error, setError] = useState("");
  async function mutateUser(target: Awaited<ReturnType<typeof listAdminUsers>>["items"][number],
    action: "status" | "sessions") {
    if (!reason.trim()) { setError("执行用户安全操作前必须填写原因。"); return; }
    setBusyTarget(`${target.id}:${action}`); setMessage(""); setError("");
    try {
      if (action === "status") await setAdminUserStatus(target.id, { status: target.status === "active" ? "disabled" : "active",
        expectedUpdatedAt: target.updatedAt, reason: reason.trim(), idempotencyKey: `admin:user:${target.id}:${crypto.randomUUID()}` });
      else await revokeAdminUserSessions(target.id, { reason: reason.trim(),
        idempotencyKey: `admin:sessions:${target.id}:${crypto.randomUUID()}` });
      setMessage(action === "status" ? "用户状态已更新并写入审计。" : "该用户的活动会话已撤销。");
      setReason(""); setRefresh((value) => value + 1);
    } catch { setError("管理操作失败。请确认目标仍有效且没有触发最后管理员保护。"); }
    finally { setBusyTarget(""); }
  }
  async function retryJob(jobId: string) {
    if (!reason.trim()) { setError("重试失败任务前必须填写原因。"); return; }
    setBusyTarget(`${jobId}:retry`); setMessage(""); setError("");
    try {
      await retryAdminJob(jobId, { reason: reason.trim(),
        idempotencyKey: `admin:job:${jobId}:${crypto.randomUUID()}` });
      setMessage("失败任务已重新进入队列，操作已写入审计。");
      setReason(""); setRefresh((value) => value + 1);
    } catch { setError("任务重试失败。请确认任务仍处于失败状态。"); }
    finally { setBusyTarget(""); }
  }
  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(""); setError(""); setBusyTarget("account");
    const data = new FormData(event.currentTarget); const newPassword = String(data.get("newPassword") ?? "");
    try {
      await updateOwnAccount({ username: String(data.get("username") ?? ""), email: String(data.get("email") ?? ""),
        currentPassword: String(data.get("currentPassword") ?? ""), ...(newPassword ? { newPassword } : {}) });
      location.reload();
    } catch { setError("账号设置保存失败。请确认当前密码正确，且用户名或邮箱未被占用。"); setBusyTarget(""); }
  }
  async function saveSmtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(""); setError(""); setBusyTarget("smtp"); const data = new FormData(event.currentTarget);
    const mode = String(data.get("security") ?? "ssl"); const password = String(data.get("password") ?? "");
    try {
      await updateAdminSmtpSettings({ host: String(data.get("host") ?? ""), port: Number(data.get("port")),
        from: String(data.get("from") ?? ""), username: String(data.get("smtpUsername") ?? "") || undefined,
        ...(password ? { password } : {}), secure: mode === "ssl", requireTls: mode === "starttls" });
      setMessage("邮件服务器设置已保存，Worker 将自动使用新配置。"); setRefresh((value) => value + 1);
    } catch { setError("邮件服务器设置保存失败，请检查地址、端口和邮箱格式。"); }
    finally { setBusyTarget(""); }
  }
  return <div className={styles.stack}><PageHeader eyebrow="PLATFORM OPERATIONS" title="系统管理"
    description="云端健康、用户安全、队列与备份状态集中呈现。" />
    <section className={styles.adminSection}><h2>管理员账号</h2>
      <form className={styles.signatureForm} onSubmit={(event) => void saveAccount(event)}>
        <TextInput id="admin-account-username" name="username" label="登录用户名"
          defaultValue={user.usernameNormalized ?? ""} minLength={3} maxLength={32} required />
        <TextInput id="admin-account-email" name="email" type="email" label="邮箱"
          defaultValue={user.emailNormalized} maxLength={254} required />
        <PasswordInput id="admin-account-current-password" name="currentPassword" label="当前密码"
          autoComplete="current-password" maxLength={256} required />
        <PasswordInput id="admin-account-new-password" name="newPassword" label="新密码（不修改可留空）"
          autoComplete="new-password" minLength={12} maxLength={256} />
        <Button type="submit" loading={busyTarget === "account"}>保存账号设置</Button>
      </form><p>保存后会撤销当前会话，请使用新账号信息重新登录。</p></section>
    <section className={styles.adminSection}><h2>邮件服务器</h2><ResourceView resource={smtp}>{(settings) =>
      <form key={settings.configured ? `${settings.host}:${settings.port}` : "smtp-empty"}
        className={styles.signatureForm} onSubmit={(event) => void saveSmtp(event)}>
        <TextInput id="smtp-host" name="host" label="SMTP 服务器" defaultValue={settings.configured ? settings.host : ""} required />
        <TextInput id="smtp-port" name="port" type="number" label="端口"
          defaultValue={settings.configured ? String(settings.port) : "465"} min={1} max={65535} required />
        <TextInput id="smtp-from" name="from" type="email" label="发件人邮箱"
          defaultValue={settings.configured ? settings.from : ""} required />
        <TextInput id="smtp-username" name="smtpUsername" label="SMTP 用户名"
          defaultValue={settings.configured ? settings.username : ""} />
        <PasswordInput id="smtp-password" name="password"
          label={settings.passwordConfigured ? "SMTP 密码（留空则保留现有密码）" : "SMTP 密码"} maxLength={1024} />
        <Select id="smtp-security" name="security" label="连接加密"
          defaultValue={settings.configured ? settings.secure ? "ssl" : "starttls" : "ssl"}
          options={[{ value: "ssl", label: "SSL/TLS（通常为 465）" },
            { value: "starttls", label: "STARTTLS（通常为 587）" }]} />
        <Button type="submit" loading={busyTarget === "smtp"}>保存邮件设置</Button>
      </form>}</ResourceView></section>
    <section className={styles.adminActionBar}><TextInput id="admin-action-reason" label="管理操作原因" value={reason}
      onChange={(event) => setReason(event.target.value)} placeholder="例如：员工离职，撤销账号及会话" />
      <p>停用账号、撤销会话等危险操作必须提供原因，并记录到不可变审计日志。</p></section>
    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    <ResourceView resource={diagnostics}>{(data) => <section className={styles.metrics}>
      <Metric label="数据库" value={data.postgres === "healthy" ? "正常" : "异常"} />
      <Metric label="对象存储" value={data.storage === "healthy" ? "正常" : "异常"} warning={data.storage !== "healthy"} />
      <Metric label="Worker" value={data.worker.status === "healthy" ? "在线" : data.worker.status === "stale" ? "心跳过期" : "未连接"}
        warning={data.worker.status !== "healthy"} />
      <Metric label="队列" value={`${data.queue.pending} 待执行 / ${data.queue.dead} 失败`} warning={data.queue.dead > 0} />
      <Metric label="产物失败" value={String(data.renderFailures)} warning={data.renderFailures > 0} />
      <Metric label="最近备份" value={data.latestBackup ? `${data.latestBackup.verificationStatus} · ${formatDate(data.latestBackup.startedAt)}` : "无记录"}
        warning={!data.latestBackup || data.latestBackup.verificationStatus !== "passed"} />
    </section>}</ResourceView>
    <section className={styles.adminSection}><h2>失败任务</h2><ResourceView resource={diagnostics}>{(data) => data.deadJobs.length === 0 ?
      <EmptyState title="没有失败任务">队列中没有需要人工恢复的任务。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>任务类型</th><th>失败码</th><th>尝试次数</th><th>更新时间</th><th>恢复操作</th></tr></thead>
        <tbody>{data.deadJobs.map((job) => <tr key={job.id}><td><strong>{job.jobType}</strong><small>{job.id}</small></td>
          <td><State value="failed" /> <span className={styles.mono}>{job.errorCode ?? "未记录"}</span></td>
          <td className={styles.mono}>{job.attemptCount} / {job.maxAttempts}</td><td className={styles.mono}>{formatDate(job.updatedAt)}</td>
          <td><Button size="sm" variant="secondary" loading={busyTarget === `${job.id}:retry`} disabled={!reason.trim()}
            onClick={() => void retryJob(job.id)}>重新入队</Button></td></tr>)}</tbody></table></div>}</ResourceView></section>
    <ResourceView resource={users}>{(data) => <div className={styles.tableWrap}><table><thead><tr><th>用户</th><th>平台角色</th><th>状态</th><th>MFA</th><th>活动会话</th><th>更新时间</th><th>安全操作</th></tr></thead>
      <tbody>{data.items.map((user) => <tr key={user.id}><td><strong>{user.displayName}</strong><small>{user.emailNormalized}</small></td>
        <td>{platformRole(user.platformRole)}</td><td><State value={user.status} /></td><td><State value={user.mfaStatus} /></td>
        <td className={styles.mono}>{user.activeSessionCount}</td><td className={styles.mono}>{formatDate(user.updatedAt)}</td>
        <td><ButtonGroup><Button size="sm" variant={user.status === "active" ? "danger" : "secondary"}
          loading={busyTarget === `${user.id}:status`} disabled={!reason.trim()}
          onClick={() => void mutateUser(user, "status")}>{user.status === "active" ? "停用" : "启用"}</Button>
          <Button size="sm" variant="secondary" loading={busyTarget === `${user.id}:sessions`}
            disabled={!reason.trim() || user.activeSessionCount === 0}
            onClick={() => void mutateUser(user, "sessions")}>撤销会话</Button></ButtonGroup></td></tr>)}</tbody></table></div>}</ResourceView>
    <section className={styles.adminSection}><h2>备份验证</h2><ResourceView resource={backups}>{(data) => data.items.length === 0 ?
      <EmptyState title="暂无备份验证记录">云端备份检查结果会显示在这里。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>开始时间</th><th>状态</th><th>验证</th><th>范围</th></tr></thead>
        <tbody>{data.items.map((backup) => <tr key={backup.id}><td className={styles.mono}>{formatDate(backup.startedAt)}</td>
          <td><State value={backup.status} /></td><td><State value={backup.verificationStatus} /></td><td>{backup.provider}</td></tr>)}</tbody></table></div>}</ResourceView></section>
    <section className={styles.adminSection}><h2>最近审计</h2><ResourceView resource={audit}>{(data) => data.items.length === 0 ?
      <EmptyState title="暂无审计事件">管理及业务操作将在这里形成不可变记录。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>动作</th><th>目标</th><th>结果</th><th>请求号</th></tr></thead>
        <tbody>{data.items.map((event) => <tr key={event.id}><td className={styles.mono}>{formatDate(event.occurredAt)}</td>
          <td>{event.action}</td><td>{event.targetType}<small>{event.targetId ?? "—"}</small></td><td><State value={event.result} /></td>
          <td className={styles.mono}>{event.requestId}</td></tr>)}</tbody></table></div>}</ResourceView></section>
  </div>;
}

function Page<T>({ title, eyebrow, description, resource, children }: { title: string; eyebrow: string; description: ReactNode;
  resource: Resource<T>; children: (data: T) => ReactNode }) {
  return <div className={styles.stack}><PageHeader title={title} eyebrow={eyebrow} description={description} />
    <ResourceView resource={resource}>{children}</ResourceView></div>;
}

type Resource<T> = { status: "loading" } | { status: "error"; retry: () => void } | { status: "ready"; data: T };
function useResource<T>(load: () => Promise<T>, dependencies: readonly unknown[]): Resource<T> {
  const [generation, setGeneration] = useState(0); const [state, setState] = useState<Resource<T>>({ status: "loading" });
  useEffect(() => { let active = true; setState({ status: "loading" }); load().then((data) => active && setState({ status: "ready", data }),
    () => active && setState({ status: "error", retry: () => setGeneration((v) => v + 1) })); return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, generation]);
  return state;
}
function ResourceView<T>({ resource, children }: { resource: Resource<T>; children: (data: T) => ReactNode }) {
  if (resource.status === "loading") return <Skeleton lines={5} label="正在读取数据" />;
  if (resource.status === "error") return <ErrorState title="数据加载失败" onRetry={resource.retry}>请检查网络后重试。</ErrorState>;
  return <>{children(resource.data)}</>;
}
function State({ value }: { value: string }) { return <span className={styles.state} data-value={value}>{stateLabel(value)}</span>; }
function Priority({ value }: { value: string }) { return <span className={styles.priority} data-value={value}>{priorityLabel(value)}</span>; }
function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className={styles.metric} data-warning={warning}><span>{label}</span><strong>{value}</strong>{warning ? <TriangleAlert size={16} aria-hidden="true" /> : <Activity size={16} aria-hidden="true" />}</div>;
}
function objectUrl(id: string) { return `/api/v2/storage/objects/${encodeURIComponent(id)}/content`; }
function workspaceTarget(route: string) {
  const issue = /^\/issues\/([0-9a-f-]+)$/.exec(route); if (issue) return `#/workspace/issues/${issue[1]}`;
  const approval = /^\/approvals\/([0-9a-f-]+)$/.exec(route); if (approval) return `#/workspace/approvals/${approval[1]}`;
  return route.startsWith("/pdm") ? "#/workspace/pdm" : "#/workspace";
}
export function workspaceRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?", 1)[0];
  const approval = /^\/workspace\/approvals\/([0-9a-f-]+)$/.exec(path); if (approval) return { name: "approval", id: approval[1] };
  const issue = /^\/workspace\/issues\/([0-9a-f-]+)$/.exec(path); if (issue) return { name: "issue", id: issue[1] };
  const part = /^\/workspace\/pdm\/([0-9a-f-]+)$/.exec(path); if (part) return { name: "part", id: part[1] };
  if (path === "/workspace/issues") return { name: "issues" };
  if (path === "/workspace/drawings") return { name: "drawings" }; if (path === "/workspace/pdm") return { name: "pdm" };
  if (path === "/workspace/signature") return { name: "signature" }; if (path === "/workspace/sync") return { name: "sync" };
  if (path === "/workspace/administration") return { name: "administration" };
  if (path === "/workspace/projects") return { name: "projects" };
  return { name: "tasks" };
}
function formatDate(value: string | Date) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function archiveErrorCode(value: unknown) { return typeof value === "string" && value.trim()
  ? value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) : "DESKTOP_PRINT_FAILED"; }
function roleLabel(role: string) { return ({ manager: "项目经理", designer: "设计人员", supervisor: "主管审阅", process: "工艺复核", viewer: "只读成员" } as Record<string, string>)[role] ?? role; }
function platformRole(role: string) { return role === "admin" ? "平台管理员" : "平台成员"; }
function priorityLabel(value: string) { return ({ blocking: "阻塞", high: "高", normal: "普通", low: "低" } as Record<string, string>)[value] ?? value; }
function annotationToolLabel(value: string) { return ({ pin: "定位", rect: "矩形", arrow: "箭头", circle: "圆形",
  text: "文字", ink: "画笔", cloud: "云线" } as Record<string, string>)[value] ?? value; }
function stateLabel(value: string) { return ({ pending: "待处理", approved: "已通过", rejected: "已驳回", published: "已发布",
  pending_metadata: "待补录", failed: "失败", void: "已作废", open: "待处理", in_progress: "处理中", review: "待复核",
  closed: "已关闭", active: "启用", disabled: "停用", enabled: "已启用" } as Record<string, string>)[value] ?? value; }
