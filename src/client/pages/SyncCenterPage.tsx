import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Cloud, FolderSync,
  RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  createWebDavConnection,
  createWebDavMapping,
  getWebDavSyncSummary,
  listWebDavConflicts,
  listWebDavConnections,
  listWebDavMappings,
  listWebDavSyncItems,
  resolveWebDavConflict,
  retryWebDavSyncItem,
  testWebDavConnection,
  triggerWebDavScan,
  updateWebDavConnection,
  updateWebDavMapping,
  type WebDavConflict,
  type WebDavConnection,
  type WebDavMapping
} from "../api/syncClient.ts";
import { Button, ButtonGroup } from "../ui/actions/index.tsx";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "../ui/feedback/index.tsx";
import { FormActions, Select, TextInput } from "../ui/forms/index.tsx";
import { PageHeader } from "../patterns/PageHeader/index.tsx";
import styles from "./SyncCenterPage.module.css";

type ProjectOption = { readonly id: string; readonly name: string };
type SyncCenterData = Awaited<ReturnType<typeof loadSyncCenter>>;

export function SyncCenterPage({ projects, currentProjectId }: {
  readonly projects: readonly ProjectOption[];
  readonly currentProjectId: string;
}) {
  const [generation, setGeneration] = useState(0);
  const resource = useSyncResource(generation);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function refresh(nextMessage?: string) {
    if (nextMessage) setMessage(nextMessage);
    setGeneration((value) => value + 1);
  }
  async function run(target: string, operation: () => Promise<unknown>, success: string) {
    if (!reason.trim()) { setError("同步管理操作必须填写原因，便于审计与交接。"); return; }
    setBusy(target); setError(""); setMessage("");
    try { await operation(); setReason(""); refresh(success); }
    catch { setError("操作未完成。请刷新状态，确认版本、凭据引用与远端服务均有效。"); }
    finally { setBusy(""); }
  }

  return <div className={styles.page}>
    <PageHeader eyebrow="CONTROLLED FILE EXCHANGE" title="WebDAV 同步中心"
      description="云端业务数据保持唯一真相；WebDAV 仅交换 PDF。冲突人工决策，删除不向任何一端传播。"
      actions={<Button variant="secondary" onClick={() => refresh()}><RefreshCw size={16} aria-hidden="true" />刷新状态</Button>} />
    <section className={styles.reasonBar} aria-label="同步管理操作原因">
      <TextInput id="sync-operation-reason" label="本次操作原因" value={reason} maxLength={4000}
        placeholder="例如：接入项目交换目录，验证凭据与 MOVE 能力"
        onChange={(event) => setReason(event.target.value)} />
      <p><ShieldCheck size={16} aria-hidden="true" />连接、目录、重试和冲突决策都会进入不可变审计。</p>
    </section>
    {message ? <InlineAlert tone="success">{message}</InlineAlert> : null}
    {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
    <Resource resource={resource}>{(data) => <>
      <SummaryStrip data={data} />
      <section className={styles.primaryGrid}>
        <section className={styles.workSection} aria-labelledby="sync-conflicts-title">
          <SectionHeading id="sync-conflicts-title" title="待决冲突" count={data.conflicts.items.length}
            note="任何同路径异内容都停在这里，不会静默覆盖。" />
          <ConflictTable conflicts={data.conflicts.items} busy={busy} reason={reason}
            onResolve={(conflict, resolution, renamedRemotePath) => {
              const consequence = resolution === "keep_remote" ? "保留远端内容并跳过本次云端写入"
                : resolution === "import_as_new_version" ? "把远端文件作为新的云端草稿版本导入"
                : `把云端版本发布到新路径 ${renamedRemotePath}`;
              if (!window.confirm(`确认${consequence}？该决定会写入审计。`)) return;
              void run(`conflict:${conflict.id}`, () => resolveWebDavConflict(conflict.id, { resolution,
                renamedRemotePath: resolution === "publish_cloud_as_renamed" ? renamedRemotePath : null,
                reason: reason.trim(), version: conflict.version,
                idempotencyKey: `webdav:conflict:${conflict.id}:${crypto.randomUUID()}` }), "冲突决定已保存并进入受控处理队列。");
            }} />
        </section>
        <section className={styles.workSection} aria-labelledby="sync-activity-title">
          <SectionHeading id="sync-activity-title" title="最近同步活动" count={data.items.items.length}
            note="入站、出站、失败与远端缺失统一显示。" />
          <ActivityTable items={data.items.items} busy={busy} reason={reason}
            onRetry={(itemId) => void run(`item:${itemId}`, () => retryWebDavSyncItem(itemId, reason.trim()),
              "同步项已重新入队；Worker 会从安全边界继续。")}/>
        </section>
      </section>
      <section className={styles.configuration}>
        <ConnectionSection connections={data.connections.items} reason={reason} busy={busy} run={run} />
        <MappingSection mappings={data.mappings.items} connections={data.connections.items} projects={projects}
          currentProjectId={currentProjectId} reason={reason} busy={busy} run={run} />
      </section>
    </>}</Resource>
  </div>;
}

function SummaryStrip({ data }: { data: SyncCenterData }) {
  const entries = [
    { label: "连接健康", value: `${data.summary.connections.active} 正常 / ${data.summary.connections.error} 异常`,
      warning: data.summary.connections.error > 0, icon: Cloud },
    { label: "启用目录", value: `${data.summary.mappings.active} 个`, note: `${data.summary.mappings.due} 个待扫描`,
      warning: data.summary.mappings.due > 0, icon: FolderSync },
    { label: "处理队列", value: `${data.summary.items.pending} 项`, note: `${data.summary.items.failed} 项失败`,
      warning: data.summary.items.failed > 0, icon: Activity },
    { label: "开放冲突", value: `${data.summary.openConflicts} 项`, note: data.summary.openConflicts ? "需要人工决定" : "无阻塞",
      warning: data.summary.openConflicts > 0, icon: AlertTriangle }
  ];
  return <section className={styles.metrics} aria-label="WebDAV 同步摘要">{entries.map((entry) => <div key={entry.label}
    className={styles.metric} data-warning={entry.warning}><entry.icon size={18} aria-hidden="true" /><span>{entry.label}</span>
    <strong>{entry.value}</strong><small>{entry.note ?? `最近成功 ${data.summary.lastSuccessfulSyncAt ? formatDate(data.summary.lastSuccessfulSyncAt) : "暂无"}`}</small></div>)}</section>;
}

function ConnectionSection({ connections, reason, busy, run }: {
  connections: readonly WebDavConnection[]; reason: string; busy: string;
  run: (target: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    await run("connection:create", () => createWebDavConnection({ name: String(values.get("name") ?? ""),
      endpointUrl: String(values.get("endpointUrl") ?? ""), credentialRef: String(values.get("credentialRef") ?? ""),
      reason: reason.trim(), idempotencyKey: `webdav:connection:create:${crypto.randomUUID()}` }), "连接已创建；请执行连接测试。之后再配置项目目录。");
    form.reset();
  }
  return <section className={styles.configSection} aria-labelledby="sync-connections-title">
    <SectionHeading id="sync-connections-title" title="连接" count={connections.length}
      note="凭据只保存引用；密码不会进入浏览器、数据库或日志。" />
    <form className={styles.connectionForm} onSubmit={(event) => void create(event)}>
      <TextInput id="webdav-name" name="name" label="连接名称" required maxLength={160} placeholder="香港协同 WebDAV" />
      <TextInput id="webdav-endpoint" name="endpointUrl" label="HTTPS 端点" required maxLength={2048}
        placeholder="https://dav.company.com/root/" />
      <TextInput id="webdav-credential-ref" name="credentialRef" label="凭据引用" required maxLength={240}
        placeholder="secret/webdav/company" />
      <FormActions><Button type="submit" loading={busy === "connection:create"} disabled={!reason.trim()}>创建连接</Button></FormActions>
    </form>
    {connections.length === 0 ? <EmptyState title="尚未配置 WebDAV">先创建连接，再由 Worker 测试认证、DAV 与 MOVE 能力。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>连接</th><th>状态</th><th>能力</th><th>最近检查</th><th>操作</th></tr></thead>
        <tbody>{connections.map((connection) => <tr key={connection.id}><td data-label="连接"><strong>{connection.name}</strong>
          <small>{connection.endpointUrl}<br />{connection.credentialRef} · {connection.credentialAvailable ? "凭据可用" : "待验证"}</small></td>
          <td data-label="状态"><SyncState value={connection.status} /></td><td data-label="能力" className={styles.capabilities}>
            <span data-active={connection.capabilities.class1}>DAV</span><span data-active={connection.capabilities.move}>MOVE</span>
            <span data-active={connection.capabilities.rangeDownload}>RANGE</span></td>
          <td data-label="最近检查" className={styles.mono}>{connection.lastCheckedAt ? formatDate(connection.lastCheckedAt) : "未检查"}
            {connection.lastErrorCode ? <small>{connection.lastErrorCode}</small> : null}</td>
          <td data-label="操作"><ButtonGroup><Button size="sm" variant="secondary" disabled={!reason.trim()}
            loading={busy === `connection:test:${connection.id}`} onClick={() => void run(`connection:test:${connection.id}`,
              () => testWebDavConnection(connection.id, reason.trim()), "连接测试已入队，稍后刷新查看能力与状态。")}>测试</Button>
            <Button size="sm" variant={connection.status === "disabled" ? "secondary" : "danger"} disabled={!reason.trim()}
              loading={busy === `connection:status:${connection.id}`} onClick={() => void run(`connection:status:${connection.id}`,
                () => updateWebDavConnection(connection.id, { name: connection.name, endpointUrl: connection.endpointUrl,
                  credentialRef: connection.credentialRef, status: connection.status === "disabled" ? "active" : "disabled",
                  version: connection.version, reason: reason.trim(),
                  idempotencyKey: `webdav:connection:update:${connection.id}:${crypto.randomUUID()}` }),
                connection.status === "disabled" ? "连接已启用，请重新测试。" : "连接已停用，不会继续扫描或发布。")}>{connection.status === "disabled" ? "启用" : "停用"}</Button>
          </ButtonGroup></td></tr>)}</tbody></table></div>}
  </section>;
}

function MappingSection({ mappings, connections, projects, currentProjectId, reason, busy, run }: {
  mappings: readonly WebDavMapping[]; connections: readonly WebDavConnection[]; projects: readonly ProjectOption[];
  currentProjectId: string; reason: string; busy: string;
  run: (target: string, operation: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    await run("mapping:create", () => createWebDavMapping({ connectionId: String(values.get("connectionId") ?? ""),
      projectId: String(values.get("projectId") ?? ""), incomingPath: String(values.get("incomingPath") ?? ""),
      outgoingPath: String(values.get("outgoingPath") ?? ""), publishVariant: String(values.get("publishVariant") ?? "signed") as "original" | "review" | "signed",
      scanIntervalSeconds: Number(values.get("scanIntervalSeconds") ?? 300), reason: reason.trim(),
      idempotencyKey: `webdav:mapping:create:${crypto.randomUUID()}` }), "项目目录已建立，首次扫描将由 Worker 执行。连接与目录仍可独立停用。");
    form.reset();
  }
  return <section className={styles.configSection} aria-labelledby="sync-mappings-title">
    <SectionHeading id="sync-mappings-title" title="项目目录映射" count={mappings.length}
      note="Incoming 只导入草稿；Published 只接收已发布产物，两个目录不得重叠。" />
    <form className={styles.mappingForm} onSubmit={(event) => void create(event)}>
      <Select id="mapping-connection" name="connectionId" label="连接" required defaultValue=""
        options={[{ value: "", label: "选择连接", disabled: true }, ...connections.map((item) => ({ value: item.id, label: item.name }))]} />
      <Select id="mapping-project" name="projectId" label="项目" required defaultValue={currentProjectId}
        options={[{ value: "", label: "选择项目", disabled: true }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} />
      <TextInput id="mapping-incoming" name="incomingPath" label="Incoming 目录" required defaultValue="/Incoming" />
      <TextInput id="mapping-outgoing" name="outgoingPath" label="Published 目录" required defaultValue="/Published" />
      <Select id="mapping-variant" name="publishVariant" label="发布产物" defaultValue="signed" options={[
        { value: "signed", label: "签后 PDF" }, { value: "review", label: "审查版 PDF" }, { value: "original", label: "原始 PDF" }]} />
      <Select id="mapping-interval" name="scanIntervalSeconds" label="扫描周期" defaultValue="300" options={[
        { value: "60", label: "1 分钟" }, { value: "300", label: "5 分钟" }, { value: "900", label: "15 分钟" }]} />
      <FormActions><Button type="submit" loading={busy === "mapping:create"}
        disabled={!reason.trim() || connections.length === 0 || projects.length === 0}>建立映射</Button></FormActions>
    </form>
    {mappings.length === 0 ? <EmptyState title="尚无目录映射">连接测试通过后，为项目建立 Incoming 与 Published 目录。</EmptyState> :
      <div className={styles.tableWrap}><table><thead><tr><th>项目 / 连接</th><th>目录</th><th>产物</th><th>状态</th><th>最近成功</th><th>操作</th></tr></thead>
        <tbody>{mappings.map((mapping) => <tr key={mapping.id}><td data-label="项目 / 连接"><strong>{mapping.projectName}</strong>
          <small>{connections.find((item) => item.id === mapping.connectionId)?.name ?? mapping.connectionId}</small></td>
          <td data-label="目录"><span className={styles.path}><ArrowDownToLine size={14} aria-hidden="true" />{mapping.incomingPath}</span>
            <span className={styles.path}><ArrowUpFromLine size={14} aria-hidden="true" />{mapping.outgoingPath}</span></td>
          <td data-label="产物">{variantLabel(mapping.publishVariant)}<small>每 {Math.round(mapping.scanIntervalSeconds / 60)} 分钟</small></td>
          <td data-label="状态"><SyncState value={mapping.status} /></td><td data-label="最近成功" className={styles.mono}>
            {mapping.lastSuccessAt ? formatDate(mapping.lastSuccessAt) : "暂无"}</td><td data-label="操作"><ButtonGroup>
              <Button size="sm" variant="secondary" disabled={!reason.trim() || mapping.status === "disabled"}
                loading={busy === `mapping:scan:${mapping.id}`} onClick={() => void run(`mapping:scan:${mapping.id}`,
                  () => triggerWebDavScan(mapping.id, reason.trim()), "手动扫描已入队；重复请求会自动去重。")}>立即扫描</Button>
              <Button size="sm" variant={mapping.status === "disabled" ? "secondary" : "danger"} disabled={!reason.trim()}
                loading={busy === `mapping:status:${mapping.id}`} onClick={() => void run(`mapping:status:${mapping.id}`,
                  () => updateWebDavMapping(mapping.id, { incomingPath: mapping.incomingPath, outgoingPath: mapping.outgoingPath,
                    publishVariant: mapping.publishVariant, scanIntervalSeconds: mapping.scanIntervalSeconds,
                    status: mapping.status === "disabled" ? "active" : "disabled", version: mapping.version,
                    reason: reason.trim(), idempotencyKey: `webdav:mapping:update:${mapping.id}:${crypto.randomUUID()}` }),
                  mapping.status === "disabled" ? "目录映射已启用。" : "目录映射已停用；云端内容保持不变。")}>{mapping.status === "disabled" ? "启用" : "停用"}</Button>
            </ButtonGroup></td></tr>)}</tbody></table></div>}
  </section>;
}

function ConflictTable({ conflicts, busy, reason, onResolve }: { conflicts: readonly WebDavConflict[];
  busy: string; reason: string; onResolve: (conflict: WebDavConflict,
    resolution: "import_as_new_version" | "publish_cloud_as_renamed" | "keep_remote", renamed: string) => void }) {
  const [choices, setChoices] = useState<Record<string, { resolution: "import_as_new_version" | "publish_cloud_as_renamed" | "keep_remote"; renamed: string }>>({});
  if (conflicts.length === 0) return <EmptyState title="没有开放冲突">当前没有需要人工决策的同路径异内容。</EmptyState>;
  return <div className={styles.conflictList}>{conflicts.map((conflict) => {
    const choice = choices[conflict.id] ?? { resolution: conflict.direction === "inbound" ? "import_as_new_version" : "publish_cloud_as_renamed", renamed: `${conflict.remotePath.replace(/\.pdf$/i, "")}-cloud.pdf` };
    return <article key={conflict.id} className={styles.conflict}>
      <header><div><SyncState value="conflict" /><strong>{conflict.remotePath}</strong></div><span>{directionLabel(conflict.direction)} · v{conflict.version}</span></header>
      <div className={styles.compare}><dl><dt>远端</dt><dd>{formatBytes(conflict.remote.sizeBytes)} · {shortHash(conflict.remote.sha256)}</dd>
        <dd>{conflict.remote.modifiedAt ? formatDate(conflict.remote.modifiedAt) : "时间未知"}</dd></dl>
        <dl><dt>云端</dt><dd>{formatBytes(conflict.cloud.sizeBytes)} · {shortHash(conflict.cloud.sha256)}</dd><dd>{conflict.cloud.revisionId ?? "未关联版本"}</dd></dl></div>
      <div className={styles.conflictAction}><Select id={`conflict-resolution-${conflict.id}`} label="处理方式" value={choice.resolution}
        options={conflict.direction === "inbound" ? [{ value: "import_as_new_version", label: "导入为新版本" }, { value: "keep_remote", label: "仅确认保留远端" }]
          : [{ value: "publish_cloud_as_renamed", label: "云端改名发布" }, { value: "keep_remote", label: "仅确认保留远端" }]}
        onChange={(event) => setChoices((current) => ({ ...current, [conflict.id]: { ...choice,
          resolution: event.target.value as typeof choice.resolution } }))} />
        {choice.resolution === "publish_cloud_as_renamed" ? <TextInput id={`conflict-path-${conflict.id}`} label="新远端路径"
          value={choice.renamed} onChange={(event) => setChoices((current) => ({ ...current,
            [conflict.id]: { ...choice, renamed: event.target.value } }))} /> : null}
        <Button variant="danger" loading={busy === `conflict:${conflict.id}`} disabled={!reason.trim() ||
          (choice.resolution === "publish_cloud_as_renamed" && !choice.renamed.trim())}
          onClick={() => onResolve(conflict, choice.resolution, choice.renamed.trim())}>确认决定</Button></div>
    </article>;
  })}</div>;
}

function ActivityTable({ items, busy, reason, onRetry }: { items: SyncCenterData["items"]["items"];
  busy: string; reason: string; onRetry: (id: string) => void }) {
  if (items.length === 0) return <EmptyState title="暂无同步活动">扫描或 PDM 发布后，处理记录会出现在这里。</EmptyState>;
  return <div className={styles.tableWrap}><table><thead><tr><th>方向 / 路径</th><th>状态</th><th>远端信息</th><th>更新时间</th><th>恢复</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.id}><td data-label="方向 / 路径"><strong>{directionLabel(item.direction)}</strong>
      <small>{item.remotePath}</small></td><td data-label="状态"><SyncState value={item.status} />{item.lastErrorCode ? <small>{item.lastErrorCode}</small> : null}</td>
      <td data-label="远端信息" className={styles.mono}>{formatBytes(item.remoteSizeBytes)}<small>{shortHash(item.remoteSha256)}</small></td>
      <td data-label="更新时间" className={styles.mono}>{formatDate(item.updatedAt)}</td><td data-label="恢复">
        {item.status === "failed" || item.status === "remote_missing" ? <Button size="sm" variant="secondary"
          loading={busy === `item:${item.id}`} disabled={!reason.trim()} onClick={() => onRetry(item.id)}>重新入队</Button> : "—"}</td></tr>)}</tbody></table></div>;
}

function SectionHeading({ id, title, count, note }: { id: string; title: string; count: number; note: string }) {
  return <header className={styles.sectionHeading}><div><h2 id={id}>{title}</h2><span>{count}</span></div><p>{note}</p></header>;
}
function SyncState({ value }: { value: string }) { return <span className={styles.state} data-value={value}>{statusLabel(value)}</span>; }
function Resource<T>({ resource, children }: { resource: ResourceState<T>; children: (data: T) => ReactNode }) {
  if (resource.status === "loading") return <Skeleton lines={8} label="正在读取同步中心" />;
  if (resource.status === "error") return <ErrorState title="同步中心加载失败" onRetry={resource.retry}>请确认云端服务与数据库可用。</ErrorState>;
  return <>{children(resource.data)}</>;
}
type ResourceState<T> = { status: "loading" } | { status: "error"; retry: () => void } | { status: "ready"; data: T };
function useSyncResource(generation: number): ResourceState<SyncCenterData> {
  const [retry, setRetry] = useState(0); const [state, setState] = useState<ResourceState<SyncCenterData>>({ status: "loading" });
  useEffect(() => { const controller = new AbortController(); setState({ status: "loading" });
    loadSyncCenter(controller.signal).then((data) => setState({ status: "ready", data }), () => {
      if (!controller.signal.aborted) setState({ status: "error", retry: () => setRetry((value) => value + 1) });
    }); return () => controller.abort(); }, [generation, retry]);
  return state;
}
async function loadSyncCenter(signal?: AbortSignal) {
  const [summary, connections, mappings, items, conflicts] = await Promise.all([
    getWebDavSyncSummary(signal), listWebDavConnections(signal), listWebDavMappings(undefined, signal),
    listWebDavSyncItems({ page: 1, pageSize: 30 }, signal), listWebDavConflicts({ page: 1, pageSize: 30, status: "open" }, signal)
  ]);
  return { summary, connections, mappings, items, conflicts };
}
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function formatBytes(value: number | null) { if (value === null) return "大小未知"; if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 ** 2).toFixed(1)} MB`; }
function shortHash(value: string | null) { return value ? `SHA ${value.slice(0, 10)}…` : "哈希未知"; }
function directionLabel(value: string) { return value === "inbound" ? "入站" : "出站"; }
function variantLabel(value: string) { return ({ original: "原始 PDF", review: "审查版 PDF", signed: "签后 PDF" } as Record<string, string>)[value] ?? value; }
function statusLabel(value: string) { return ({ active: "正常", disabled: "停用", error: "异常", discovered: "已发现",
  downloading: "下载中", validating: "校验中", imported: "已导入", pending_upload: "待上传", uploading: "上传中",
  verifying: "回读校验", succeeded: "成功", conflict: "冲突", remote_missing: "远端缺失", failed: "失败",
  skipped: "已跳过" } as Record<string, string>)[value] ?? value; }
