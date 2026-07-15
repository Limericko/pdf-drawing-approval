import { apiUrl, normalizeServerBaseUrl } from "./clientConfig.ts";
import type { SignaturePlacement, SignaturePlacementRole } from "./widgets/signaturePlacementTypes.ts";
export type { SignaturePlacement, SignaturePlacementRole } from "./widgets/signaturePlacementTypes.ts";

export type User = {
  id: number;
  username: string;
  role: "designer" | "supervisor" | "process" | "admin";
  displayName: string;
  email?: string | null;
  active?: boolean;
};

export type PublicServerHealth = {
  ok: true;
  appName: string;
  version: string;
  apiCompatVersion: number;
  port: number;
  lanUrls: string[];
  startedAt: string;
};

export type ReleaseNote = {
  version: string;
  date: string;
  title: string;
  items: string[];
};

export type UpdateManifest = {
  version: string;
  releaseDate?: string;
  channel?: string;
  notes?: string[];
  changelogUrl?: string;
  minimumApiCompatVersion?: number;
  downloads?: {
    clientInstaller?: string;
    serverInstaller?: string;
  };
};

export type SystemUpdateInfo = {
  currentVersion: string;
  currentApiCompatVersion: number;
  updateSourceUrl: string | null;
  latest: UpdateManifest | null;
  updateAvailable: boolean;
  checkedAt: string;
  error: string | null;
  releaseNotes: ReleaseNote[];
};

export type ClientUpdateInfo = SystemUpdateInfo;

export type Approval = {
  id: number;
  projectName: string;
  partName: string;
  version: string;
  status:
    | "pending"
    | "rejected"
    | "approved_for_print"
    | "printed_archived"
    | "filename_invalid"
    | "file_missing"
    | "invalid_pdf"
    | "voided";
  submittedAt: string;
  submittedByUserId: number | null;
  source: "web_upload" | "folder_watch";
  originalFileHash: string | null;
  signedFilePath: string | null;
  signedFileHash: string | null;
  signedAt: string | null;
  signatureStatus: "not_required" | "placement_required" | "pending" | "ready" | "generated" | "failed";
  signatureError: string | null;
  supervisorStatus: "pending" | "approved" | "rejected";
  supervisorComment: string | null;
  processStatus: "pending" | "approved" | "rejected";
  processComment: string | null;
  currentFilePath: string;
  printedAt: string | null;
  archivedAt: string | null;
  documentCode?: string | null;
  materialCode?: string | null;
  drawingName?: string | null;
  pdmRevisionId?: number | null;
  pdmMetadataStatus?: PdmMetadataStatus;
  pdmPublishStatus?: PdmPublishStatus;
  pdmPublishError?: string | null;
  history?: Approval[];
  relatedVersions?: Approval[];
};

export type SignatureTemplate = {
  id: number;
  name: string;
  projectName: string | null;
  placements: SignaturePlacement[];
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmissionUploadResult = {
  uploadId: string;
  originalName: string;
  parsed: {
    partName: string;
    version: string;
    minorVersion: string;
    majorVersion: string;
  } | null;
  existingVersions: Approval[];
};

export type BatchUploadItem = {
  fileName: string;
  uploadId?: string;
  status: "uploaded" | "failed";
  parsed?: SubmissionUploadResult["parsed"];
  existingVersions?: Approval[];
  error?: string;
};

export type BatchUploadResult = {
  items: BatchUploadItem[];
};

export type BatchSubmissionItem = {
  id: number;
  batchId: number;
  fileName: string;
  approvalId: number | null;
  status: "pending" | "completed" | "failed";
  errorMessage: string | null;
  placementState: "template" | "manual" | "missing" | null;
  createdAt: string;
};

export type BatchSubmission = {
  id: number;
  createdByUserId: number | null;
  projectName: string;
  status: "running" | "completed" | "failed" | "partial";
  totalCount: number;
  successCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  items: BatchSubmissionItem[];
};

export type BatchApprovalActionItem = {
  approvalId: number;
  status: "completed" | "failed";
  error?: string;
  approval?: Approval;
};

export type BatchApprovalActionResult = {
  total: number;
  success: number;
  failed: number;
  items: BatchApprovalActionItem[];
};

export type ApprovalPage = {
  items: Approval[];
  total: number;
  page: number;
  pageSize: number;
};

export type PdmMetadataStatus = "complete" | "missing_material_code" | "missing_document_code" | "missing_required";
export type PdmPublishStatus = "not_applicable" | "metadata_pending" | "pending" | "published" | "failed";
export type PdmRevisionStatus = "released" | "superseded" | "voided";

export type PdmPart = {
  id: number;
  materialCode: string;
  name: string;
  isCommon: boolean;
  currentRevisionId: number | null;
  createdFromApprovalId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PdmDrawingRevision = {
  id: number;
  partId: number;
  materialCode: string;
  documentCode: string | null;
  drawingName: string;
  version: string;
  minorVersion: string;
  majorVersion: string;
  approvalId: number;
  releaseStatus: PdmRevisionStatus;
  originalFilePath: string;
  originalFileHash: string | null;
  signedFilePath: string | null;
  signedFileHash: string | null;
  annotatedFilePath: string | null;
  releasedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PdmPartUsage = {
  id: number;
  partId: number;
  materialCode: string;
  projectName: string;
  firstApprovalId: number;
  lastApprovalId: number;
  createdAt: string;
  updatedAt: string;
};

export type PdmPendingMetadataApproval = {
  approvalId: number;
  projectName: string;
  partName: string;
  version: string;
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string | null;
  metadataStatus: PdmMetadataStatus;
  publishStatus: PdmPublishStatus;
  publishError: string | null;
  submittedByUserId: number | null;
  submittedAt: string;
};

export type PdmPartListItem = PdmPart & {
  currentVersion: string | null;
  currentDocumentCode: string | null;
  currentApprovalId: number | null;
  currentReleasedAt: string | null;
  usageProjectCount: number;
  usageProjects: string[];
};

export type PdmPartListStats = {
  totalParts: number;
  currentRevisionCount: number;
  commonPartCount: number;
};

export type PdmPartPage = {
  items: PdmPartListItem[];
  total: number;
  page: number;
  pageSize: number;
  stats: PdmPartListStats;
};

export type PdmPartDetail = {
  part: PdmPart;
  currentRevision: PdmDrawingRevision | null;
  revisions: PdmDrawingRevision[];
  usages: PdmPartUsage[];
  traceLogs: OperationLog[];
};

export type PdmRevisionVoidResult = {
  voided: PdmDrawingRevision;
  currentRevision: PdmDrawingRevision | null;
};

export type PdmMetadataRepairResult = {
  approvalId: number;
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string;
  metadataStatus: PdmMetadataStatus;
  publishStatus: PdmPublishStatus;
};

export type PdmReleaseResult = {
  status: "published" | "metadata_pending" | "failed" | "skipped" | "not_found";
  part?: PdmPart;
  revision?: PdmDrawingRevision;
  reason?: string;
  error?: string;
};

export type PdmBackfillItem = {
  approvalId: number;
  status: "published" | "skipped" | "failed";
  reason?: string;
  materialCode?: string;
  version?: string;
};

export type PdmBackfillResult = {
  scanned: number;
  published: number;
  skipped: number;
  failed: number;
  items: PdmBackfillItem[];
};

export type SignatureAsset = {
  id: number;
  userId: number;
  kind: "uploaded_png" | "drawn_png";
  filePath: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MySignature = {
  configured: boolean;
  asset: SignatureAsset | null;
};

export type UserSignatureStatus = {
  userId: number;
  username: string;
  displayName: string;
  role: User["role"];
  hasSignature: boolean;
  signatureId: number | null;
  signatureUpdatedAt: string | null;
};

export type OperationLog = {
  id: number;
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  targetType: string;
  targetId: number | null;
  message: string;
  metadata: unknown;
  createdAt: string;
};

export type ApprovalComment = {
  id: number;
  approvalId: number;
  authorUserId: number;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorRole: User["role"] | null;
  kind: "comment" | "issue";
  message: string;
  resolved: boolean;
  createdAt: string;
  resolvedAt: string | null;
};

export type ApprovalIssueSeverity = "low" | "medium" | "high" | "critical";
export type ApprovalIssueStatus = "open" | "in_progress" | "review" | "closed";
export type ApprovalIssueTransitionAction = "start" | "submit_review" | "return" | "close" | "force_close";

export type ApprovalIssue = {
  id: number;
  approvalId: number;
  annotationId: number | null;
  creatorUserId: number;
  creatorDisplayName: string | null;
  assigneeUserId: number;
  assigneeDisplayName: string | null;
  title: string;
  description: string;
  severity: ApprovalIssueSeverity;
  status: ApprovalIssueStatus;
  dueAt: string | null;
  version: number;
  resolutionSummary: string | null;
  reviewNote: string | null;
  forcedCloseReason: string | null;
  submittedForReviewAt: string | null;
  closedByUserId: number | null;
  closedByDisplayName: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount?: number;
};

export type ApprovalIssueEvent = {
  id: number;
  issueId: number;
  actorUserId: number;
  actorDisplayName: string | null;
  action: "created" | "started" | "submitted_review" | "returned" | "closed" | "force_closed";
  fromStatus: ApprovalIssueStatus | null;
  toStatus: ApprovalIssueStatus;
  note: string | null;
  createdAt: string;
};

export type ApprovalIssueInput = {
  annotationId?: number | null;
  assigneeUserId: number;
  title: string;
  description: string;
  severity: ApprovalIssueSeverity;
  dueAt?: string | null;
  clientRequestId?: string | null;
};

export type ApprovalIssueWithAnnotationInput = Omit<ApprovalIssueInput, "annotationId"> & {
  annotation: ApprovalAnnotationInput;
};

export type ApprovalAnnotationKind = "pin" | "rect" | "arrow" | "circle" | "text" | "ink" | "cloud";
export type ApprovalAnnotationColor = "red" | "amber" | "blue" | "green" | "custom";

export type ApprovalAnnotation = {
  id: number;
  approvalId: number;
  authorUserId: number;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorRole: User["role"] | null;
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number | null;
  heightRatio: number | null;
  endXRatio: number | null;
  endYRatio: number | null;
  pointsJson: string | null;
  styleJson: string | null;
  color: ApprovalAnnotationColor;
  resolved: boolean;
  resolvedByUserId: number | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalAnnotationInput = {
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio?: number | null;
  heightRatio?: number | null;
  endXRatio?: number | null;
  endYRatio?: number | null;
  pointsJson?: string | null;
  styleJson?: string | null;
  color?: ApprovalAnnotationColor;
};

export type ScanRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  processedCount: number;
  missingCount: number;
  invalidCount: number;
  errorMessage: string | null;
  triggeredBy: string;
};

export type BackupRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  backupPath: string | null;
  errorMessage: string | null;
  triggeredBy: string;
};

export type SystemDiagnostics = {
  overallStatus: "ok" | "warn";
  database: { ok: boolean; error: string | null };
  watchRoot: { path: string | null; configured: boolean; exists: boolean };
  standardFolders: Array<{ name: string; path: string | null; exists: boolean }>;
  writePermissions: Array<{ name: string; path: string; writable: boolean; error: string | null }>;
  latestScan: ScanRun | null;
  latestBackup: BackupRun | null;
  logs?: Array<{ name: string; path: string; readable: boolean; error: string | null }>;
  service?: { startedAt: string; uptimeSeconds: number };
};

export type SystemRisk = {
  key: string;
  level: "ok" | "warning" | "error";
  title: string;
  message: string;
  count?: number;
  href?: string;
};

export type CleanupResult = {
  executed: boolean;
  tempUploads: { count: number };
  failedBatchSubmissions: { count: number };
  oldSignedPdfs: { count: number; files: string[] };
};

export type MaintenanceSchedule = {
  enabled: boolean;
  time: string;
};

export type MaintenanceSettings = {
  autoBackup: MaintenanceSchedule;
  autoCleanup: MaintenanceSchedule;
};

export type BackupValidationResult = {
  ok: boolean;
  files: string[];
  message: string;
};

export type NotificationPreferences = {
  email: Record<string, boolean>;
};

export type NotificationEventOption = {
  key: string;
  label: string;
  description: string;
};

export type Profile = {
  user: User;
  commonProjects: string[];
  notificationPreferences: NotificationPreferences;
  availableNotificationEvents: NotificationEventOption[];
};

const tokenKey = "pdf_approval_token";

export function getToken() {
  return localStorage.getItem(tokenKey);
}

export function setToken(token: string) {
  localStorage.setItem(tokenKey, token);
}

export function clearToken() {
  localStorage.removeItem(tokenKey);
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(apiUrl(url), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP_${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function requestRawJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(apiUrl(url), {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP_${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function login(username: string, password: string) {
  const result = await requestJson<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  setToken(result.token);
  return result.user;
}

export async function checkServerHealth(baseUrl?: string) {
  const url = baseUrl
    ? new URL("/health", `${normalizeServerBaseUrl(baseUrl)}/`).toString()
    : apiUrl("/health");
  const response = await fetch(url, {
    cache: "no-store",
    headers: {}
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json() as Promise<PublicServerHealth>;
}

export async function registerDesigner(input: { username: string; password: string; displayName: string; email?: string }) {
  const result = await requestJson<{ token: string; user: User }>("/api/auth/register-designer", {
    method: "POST",
    body: JSON.stringify(input)
  });
  setToken(result.token);
  return result.user;
}

export function requestPasswordReset(input: { username: string; email: string }) {
  return requestJson<{ ok: true }>("/api/auth/password-reset/request", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function confirmPasswordReset(input: { token: string; password: string }) {
  return requestJson<{ ok: true }>("/api/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getProfile() {
  return requestJson<Profile>("/api/profile");
}

export function updateProfile(input: {
  displayName: string;
  email?: string | null;
  commonProjects: string[];
  notificationPreferences: NotificationPreferences;
}) {
  return requestJson<Profile>("/api/profile", {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function sendProfileTestEmail() {
  return requestJson<{ sent: true }>("/api/profile/test-email", { method: "POST" });
}

export function listApprovals(params: { mine?: boolean; status?: string; signatureStatus?: string } = {}) {
  const query = new URLSearchParams();
  if (params.mine) query.set("mine", "1");
  if (params.status) query.set("status", params.status);
  if (params.signatureStatus) query.set("signatureStatus", params.signatureStatus);
  return requestJson<Approval[]>(`/api/approvals?${query}`);
}

export function listApprovalsPage(
  params: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: string;
    signatureStatus?: string;
  }
) {
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  if (params.keyword?.trim()) query.set("keyword", params.keyword.trim());
  if (params.status) query.set("status", params.status);
  if (params.signatureStatus) query.set("signatureStatus", params.signatureStatus);
  return requestJson<ApprovalPage>(`/api/approvals?${query}`);
}

export function listPdmParts(
  params: {
    page: number;
    pageSize: number;
    keyword?: string;
    projectName?: string;
    isCommon?: boolean;
    hasCurrentRevision?: boolean;
  }
) {
  const query = new URLSearchParams();
  query.set("page", String(params.page));
  query.set("pageSize", String(params.pageSize));
  if (params.keyword?.trim()) query.set("keyword", params.keyword.trim());
  if (params.projectName?.trim()) query.set("projectName", params.projectName.trim());
  if (params.isCommon !== undefined) query.set("isCommon", params.isCommon ? "1" : "0");
  if (params.hasCurrentRevision !== undefined) query.set("hasCurrentRevision", params.hasCurrentRevision ? "1" : "0");
  return requestJson<PdmPartPage>(`/api/pdm/parts?${query}`);
}

export function getPdmPart(id: number) {
  return requestJson<PdmPartDetail>(`/api/pdm/parts/${id}`);
}

export function listPendingPdmMetadata() {
  return requestJson<{ items: PdmPendingMetadataApproval[] }>("/api/pdm/pending-metadata");
}

export function repairApprovalPdmMetadata(
  approvalId: number,
  input: { documentCode?: string | null; materialCode?: string | null; drawingName: string }
) {
  return requestJson<PdmMetadataRepairResult>(`/api/pdm/approvals/${approvalId}/repair-metadata`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function publishApprovalToPdm(approvalId: number) {
  return requestJson<PdmReleaseResult>(`/api/pdm/approvals/${approvalId}/publish`, { method: "POST" });
}

export function runPdmApprovedBackfill() {
  return requestJson<PdmBackfillResult>("/api/pdm/backfill-approved", { method: "POST" });
}

export function voidPdmRevision(revisionId: number, reason: string) {
  return requestJson<PdmRevisionVoidResult>(`/api/pdm/revisions/${revisionId}/void`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

export function getApproval(id: number) {
  return requestJson<Approval>(`/api/approvals/${id}`);
}

export function submitReview(id: number, role: "supervisor" | "process", decision: "approved" | "rejected", comment: string) {
  return requestJson<Approval>(`/api/approvals/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ role, decision, comment })
  });
}

export function markPrinted(id: number) {
  return requestJson<Approval>(`/api/approvals/${id}/mark-printed`, { method: "POST" });
}

export function voidApproval(id: number, reason: string) {
  return requestJson<Approval>(`/api/approvals/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
}

export function deleteApproval(id: number) {
  return requestJson<{ deleted: true; approvalId: number; deletedFiles: string[] }>(`/api/approvals/${id}`, {
    method: "DELETE"
  });
}

export function rebindApprovalFile(id: number, filePath: string) {
  return requestJson<Approval>(`/api/approvals/${id}/rebind-file`, {
    method: "POST",
    body: JSON.stringify({ filePath })
  });
}

export function retryApprovalValidation(id: number) {
  return requestJson<Approval>(`/api/approvals/${id}/retry-validation`, { method: "POST" });
}

export function listApprovalOperationLogs(id: number) {
  return requestJson<OperationLog[]>(`/api/approvals/${id}/operation-logs`);
}

export function listApprovalComments(approvalId: number) {
  return requestJson<ApprovalComment[]>(`/api/approvals/${approvalId}/comments`);
}

export function createApprovalComment(approvalId: number, input: { kind: "comment" | "issue"; message: string }) {
  return requestJson<ApprovalComment>(`/api/approvals/${approvalId}/comments`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function resolveApprovalComment(approvalId: number, commentId: number) {
  return requestJson<ApprovalComment>(`/api/approvals/${approvalId}/comments/${commentId}/resolve`, { method: "POST" });
}

export function listApprovalIssues(approvalId: number) {
  return requestJson<ApprovalIssue[]>(`/api/approvals/${approvalId}/issues`);
}

export function listApprovalIssueAssignees(approvalId: number) {
  return requestJson<User[]>(`/api/approvals/${approvalId}/issues/assignees`);
}

export function listApprovalIssueEvents(approvalId: number, issueId: number) {
  return requestJson<ApprovalIssueEvent[]>(`/api/approvals/${approvalId}/issues/${issueId}/events`);
}

export async function createApprovalIssue(approvalId: number, input: ApprovalIssueInput) {
  const payload = { ...input, clientRequestId: input.clientRequestId ?? crypto.randomUUID() };
  const send = () => requestJson<ApprovalIssue>(`/api/approvals/${approvalId}/issues`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof TypeError) || !navigator.onLine) throw error;
    return send();
  }
}

export async function createApprovalIssueWithAnnotation(approvalId: number, input: ApprovalIssueWithAnnotationInput) {
  const payload = { ...input, clientRequestId: input.clientRequestId ?? crypto.randomUUID() };
  const send = () => requestJson<{ issue: ApprovalIssue; annotation: ApprovalAnnotation }>(
    `/api/approvals/${approvalId}/issues/linked-annotation`,
    { method: "POST", body: JSON.stringify(payload) }
  );
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof TypeError) || !navigator.onLine) throw error;
    return send();
  }
}

export function updateApprovalIssue(approvalId: number, issueId: number, input: Partial<Omit<ApprovalIssueInput, "annotationId" | "clientRequestId">> & { expectedVersion: number }) {
  return requestJson<ApprovalIssue>(`/api/approvals/${approvalId}/issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function transitionApprovalIssue(
  approvalId: number,
  issueId: number,
  input: { action: ApprovalIssueTransitionAction; note?: string | null; expectedVersion: number }
) {
  return requestJson<ApprovalIssue>(`/api/approvals/${approvalId}/issues/${issueId}/transitions`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function subscribeApprovalIssueEvents(
  approvalId: number,
  onIssueChanged: () => void,
  onStatusChange?: (status: "connected" | "reconnecting") => void
) {
  const token = getToken();
  const query = new URLSearchParams(token ? { token } : {});
  const source = new EventSource(apiUrl(`/api/approvals/${approvalId}/issues/stream?${query}`));
  source.addEventListener("ready", () => onStatusChange?.("connected"));
  source.addEventListener("issue.changed", onIssueChanged);
  source.onerror = () => onStatusChange?.("reconnecting");
  return () => source.close();
}

export function listApprovalAnnotations(approvalId: number) {
  return requestJson<ApprovalAnnotation[]>(`/api/approvals/${approvalId}/annotations`);
}

export function createApprovalAnnotation(approvalId: number, input: ApprovalAnnotationInput) {
  return requestJson<ApprovalAnnotation>(`/api/approvals/${approvalId}/annotations`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateApprovalAnnotation(approvalId: number, annotationId: number, input: ApprovalAnnotationInput) {
  return requestJson<ApprovalAnnotation>(`/api/approvals/${approvalId}/annotations/${annotationId}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function resolveApprovalAnnotation(approvalId: number, annotationId: number) {
  return requestJson<ApprovalAnnotation>(`/api/approvals/${approvalId}/annotations/${annotationId}/resolve`, { method: "POST" });
}

export function deleteApprovalAnnotation(approvalId: number, annotationId: number) {
  return requestJson<{ deleted: true; annotationId: number }>(`/api/approvals/${approvalId}/annotations/${annotationId}`, {
    method: "DELETE"
  });
}

export function resetApprovalAnnotations(approvalId: number) {
  return requestJson<{ reset: true; deletedCount: number }>(`/api/approvals/${approvalId}/annotations/reset`, {
    method: "POST"
  });
}

export function uploadSubmissionPdf(file: File, projectName?: string) {
  const query = new URLSearchParams({ fileName: file.name });
  if (projectName?.trim()) query.set("projectName", projectName.trim());
  return requestRawJson<SubmissionUploadResult>(`/api/submissions/upload?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file
  });
}

export async function uploadBatchSubmission(files: File[], projectName?: string) {
  const items = await Promise.all(
    files.map(async (file): Promise<BatchUploadItem> => {
      try {
        const uploaded = await uploadSubmissionPdf(file, projectName);
        return {
          fileName: uploaded.originalName,
          uploadId: uploaded.uploadId,
          status: "uploaded",
          parsed: uploaded.parsed,
          existingVersions: uploaded.existingVersions
        };
      } catch (error) {
        return {
          fileName: file.name,
          status: "failed",
          error: error instanceof Error && error.message ? error.message : "UPLOAD_FAILED"
        };
      }
    })
  );
  return { items };
}

export function confirmSubmission(input: {
  uploadId: string;
  projectName: string;
  partName: string;
  version: string;
  placements: SignaturePlacement[];
}) {
  return requestJson<Approval>("/api/submissions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function confirmBatchSubmission(input: {
  projectName: string;
  items: Array<{
    uploadId?: string;
    fileName: string;
    partName: string;
    version: string;
    placements: SignaturePlacement[];
    placementState: "template" | "manual" | "missing";
  }>;
}) {
  return requestJson<BatchSubmission>("/api/submissions/batch", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function listBatchSubmissions() {
  return requestJson<BatchSubmission[]>("/api/submissions/batches");
}

export function getBatchSubmission(id: number) {
  return requestJson<BatchSubmission>(`/api/submissions/batches/${id}`);
}

export function listSubmissionExistingVersions(projectName: string, partName: string) {
  const query = new URLSearchParams({ projectName, partName });
  return requestJson<Approval[]>(`/api/submissions/existing-versions?${query}`);
}

export function getSignedFileUrl(approvalId: number, cacheKey?: string | null) {
  const query = new URLSearchParams({ token: getToken() ?? "" });
  if (cacheKey) query.set("v", cacheKey);
  return apiUrl(`/api/approvals/${approvalId}/signed-file?${query}`);
}

export function getApprovalFileUrl(approvalId: number) {
  return apiUrl(`/api/approvals/${approvalId}/file?token=${encodeURIComponent(getToken() ?? "")}`);
}

export function getAnnotatedFileUrl(approvalId: number, cacheKey?: string | null) {
  const query = new URLSearchParams({ token: getToken() ?? "" });
  if (cacheKey) query.set("v", cacheKey);
  return apiUrl(`/api/approvals/${approvalId}/annotated-file?${query}`);
}

export function retryGenerateSignedPdf(approvalId: number) {
  return requestJson<Approval>(`/api/approvals/${approvalId}/generate-signed-pdf`, { method: "POST" });
}

export function batchGenerateSignedPdf(approvalIds: number[]) {
  return requestJson<BatchApprovalActionResult>("/api/approvals/batch/generate-signed-pdf", {
    method: "POST",
    body: JSON.stringify({ approvalIds })
  });
}

export function batchMarkPrinted(approvalIds: number[]) {
  return requestJson<BatchApprovalActionResult>("/api/approvals/batch/mark-printed", {
    method: "POST",
    body: JSON.stringify({ approvalIds })
  });
}

export function listSignaturePlacements(approvalId: number) {
  return requestJson<SignaturePlacement[]>(`/api/approvals/${approvalId}/signature-placements`);
}

export function saveSignaturePlacements(approvalId: number, placements: SignaturePlacement[]) {
  return requestJson<{ approval: Approval; placements: SignaturePlacement[] }>(`/api/approvals/${approvalId}/signature-placements`, {
    method: "PUT",
    body: JSON.stringify({ placements })
  });
}

export function listSignatureTemplates(projectName?: string) {
  const query = projectName ? `?projectName=${encodeURIComponent(projectName)}` : "";
  return requestJson<SignatureTemplate[]>(`/api/signature-templates${query}`);
}

export function createSignatureTemplate(input: { name: string; projectName?: string | null; placements: SignaturePlacement[] }) {
  return requestJson<SignatureTemplate>("/api/signature-templates", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateSignatureTemplate(
  id: number,
  input: { name: string; projectName?: string | null; placements: SignaturePlacement[] }
) {
  return requestJson<SignatureTemplate>(`/api/signature-templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function deleteSignatureTemplate(id: number) {
  return requestJson<{ deleted: true; templateId: number }>(`/api/signature-templates/${id}`, {
    method: "DELETE"
  });
}

export function saveApprovalPlacementsAsTemplate(approvalId: number, input: { name: string; projectName?: string | null }) {
  return requestJson<SignatureTemplate>(`/api/approvals/${approvalId}/signature-templates`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getMySignature() {
  return requestJson<MySignature>("/api/signatures/me");
}

export function getMySignatureFileUrl() {
  return apiUrl(`/api/signatures/me/file?token=${encodeURIComponent(getToken() ?? "")}`);
}

export function uploadMySignature(file: File) {
  return requestRawJson<MySignature>("/api/signatures/me/upload", {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: file
  });
}

export function saveDrawnSignature(dataUrl: string) {
  return requestJson<MySignature>("/api/signatures/me/draw", {
    method: "POST",
    body: JSON.stringify({ dataUrl })
  });
}

export function listSignatureStatuses() {
  return requestJson<UserSignatureStatus[]>("/api/signatures/status");
}

export function getSettings() {
  return requestJson<Record<string, string>>("/api/settings");
}

export function saveSettings(settings: Record<string, string>) {
  return requestJson<{ ok: true }>("/api/settings", {
    method: "POST",
    body: JSON.stringify(settings)
  });
}

export type WatchRootStatus = {
  watchRoot: string | null;
  rootExists: boolean;
  ready: boolean;
  folders: Array<{ name: string; path: string; exists: boolean }>;
};

export function getWatchRootStatus() {
  return requestJson<WatchRootStatus>("/api/settings/watch-root/status");
}

export function prepareStandardFolders(watchRoot?: string) {
  return requestJson<{
    watchRoot: string;
    folders: Array<{ name: string; path: string; status: "created" | "existing" }>;
  }>("/api/settings/prepare-folders", {
    method: "POST",
    body: JSON.stringify({ watchRoot })
  });
}

export function selectWatchRootFolder() {
  return requestJson<{ pickerId: string }>("/api/settings/select-folder", {
    method: "POST"
  });
}

export function pollWatchRootFolder(pickerId: string) {
  return requestJson<
    | { status: "pending" }
    | { status: "selected"; path: string }
    | { status: "cancelled" }
    | { status: "error"; message: string }
  >(`/api/settings/select-folder/${encodeURIComponent(pickerId)}`);
}

export type DirectoryListing = {
  currentPath: string | null;
  parentPath: string | null;
  entries: Array<{ name: string; path: string }>;
  roots: Array<{ name: string; path: string }>;
};

export function listServerDirectories(path?: string) {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return requestJson<DirectoryListing>(`/api/settings/directories${query}`);
}

export function restartServer() {
  return requestJson<{ restarting: true }>("/api/system/restart", { method: "POST" });
}

export function scanNow() {
  return requestJson<ScanRun>("/api/system/scan-now", { method: "POST" });
}

export function listScanRuns() {
  return requestJson<ScanRun[]>("/api/system/scan-runs");
}

export function getSystemDiagnostics() {
  return requestJson<SystemDiagnostics>("/api/system/diagnostics");
}

export function getSystemRisks() {
  return requestJson<SystemRisk[]>("/api/system/risks");
}

export function runBackup() {
  return requestJson<BackupRun>("/api/system/backup", { method: "POST" });
}

export function listBackups() {
  return requestJson<BackupRun[]>("/api/system/backups");
}

export function getMaintenanceSettings() {
  return requestJson<MaintenanceSettings>("/api/system/maintenance");
}

export function getSystemUpdateInfo() {
  return requestJson<SystemUpdateInfo>("/api/system/update-info");
}

export function getClientUpdateInfo(currentVersion?: string | null) {
  const query = currentVersion?.trim()
    ? `?currentVersion=${encodeURIComponent(currentVersion.trim())}`
    : "";
  return requestJson<ClientUpdateInfo>(`/api/system/client-update-info${query}`);
}

export function saveMaintenanceSettings(settings: Partial<MaintenanceSettings>) {
  return requestJson<MaintenanceSettings>("/api/system/maintenance", {
    method: "PUT",
    body: JSON.stringify(settings)
  });
}

export function validateBackupDirectory(path: string) {
  return requestJson<BackupValidationResult>("/api/system/backups/validate", {
    method: "POST",
    body: JSON.stringify({ path })
  });
}

export function getSystemLogs(lines = 200) {
  return requestJson<{
    lines: number;
    logs: Array<{ name: string; exists: boolean; content: string }>;
  }>(`/api/system/logs?lines=${lines}`);
}

export function listOperationLogs() {
  return requestJson<OperationLog[]>("/api/operation-logs");
}

export function runSystemCleanup(execute: boolean) {
  return requestJson<CleanupResult>("/api/system/cleanup", {
    method: "POST",
    body: JSON.stringify({ execute })
  });
}

export function getApprovalReportCsvUrl(params: { projectName?: string; status?: string; from?: string; to?: string } = {}) {
  const query = new URLSearchParams();
  if (params.projectName) query.set("projectName", params.projectName);
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  query.set("token", getToken() ?? "");
  return apiUrl(`/api/reports/approvals.csv?${query}`);
}

export function testSmtp(to: string) {
  return requestJson<{ sent: true }>("/api/settings/test-smtp", {
    method: "POST",
    body: JSON.stringify({ to })
  });
}

export function listUsers() {
  return requestJson<User[]>("/api/users");
}

export function createUser(input: {
  username: string;
  password: string;
  role: User["role"];
  displayName: string;
  email?: string;
}) {
  return requestJson<User>("/api/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateUser(
  id: number,
  input: { role: User["role"]; displayName: string; email?: string; active: boolean }
) {
  return requestJson<User>(`/api/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function resetUserPassword(id: number, password: string) {
  return requestJson<User>(`/api/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password })
  });
}
