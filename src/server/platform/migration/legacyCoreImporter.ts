import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import { legacyRowSha256 } from "./legacyIdentity.ts";
import type { LegacyMigrationStore } from "./legacyMigrationStore.ts";

type LegacyUser = {
  id: number; username: string; password_hash: string; role: string; email: string | null;
  display_name: string; active: number; created_at: string;
};

const projectRoleByLegacyRole: Record<string, string | undefined> = {
  admin: "manager", designer: "designer", supervisor: "supervisor", process: "process", printer: undefined
};

export async function importLegacyCoreRecords(input: {
  readonly databasePath: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly emailOverrides?: Readonly<Record<string, string>>;
  readonly executor: QueryExecutor;
  readonly store: LegacyMigrationStore;
  readonly now?: () => Date;
}) {
  const observedAt = ownDate((input.now ?? (() => new Date()))());
  const database = new DatabaseSync(input.databasePath, { readOnly: true, enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false, allowExtension: false });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const users = database.prepare(
      "SELECT id,username,password_hash,role,email,display_name,active,created_at FROM users ORDER BY id"
    ).all() as LegacyUser[];
    const userIds = await importUsers(users, input, observedAt);
    const projectNames = (database.prepare(
      "SELECT DISTINCT trim(project_name) AS name FROM approvals WHERE trim(project_name)<>'' ORDER BY name"
    ).all() as { name: string }[]).map((row) => row.name);
    const projectIds = await importProjects(projectNames, input, users, userIds, observedAt);
    const signatureAssets = await importSignatureAssets(database, input, userIds, observedAt);
    const approvalResult = await importApprovals(database, input, users, userIds, projectIds, observedAt);
    return Object.freeze({ users: users.length, projects: projectNames.length,
      memberships: projectNames.length * users.filter((user) => projectRoleByLegacyRole[user.role]).length,
      signatureAssets, ...approvalResult });
  } finally {
    database.close();
  }
}

async function importUsers(
  users: LegacyUser[],
  input: Parameters<typeof importLegacyCoreRecords>[0],
  observedAt: Date
) {
  const targetIds = new Map<number, string>();
  const emails = new Set<string>();
  const prepared = users.map((user) => {
    const email = normalizeEmail(user.email || input.emailOverrides?.[String(user.id)]);
    if (!email) throw fieldError("LEGACY_USER_EMAIL_REQUIRED", user.id);
    if (emails.has(email)) throw fieldError("LEGACY_USER_EMAIL_DUPLICATE", user.id);
    emails.add(email);
    return { user, email };
  });
  for (const { user, email } of prepared) {
    const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "user", legacyId: user.id, targetTable: "platform.users",
      sourceRowSha256: legacyRowSha256(user), observedAt });
    const createdAt = legacyDate(user.created_at, "LEGACY_USER_DATE_INVALID", user.id);
    await input.executor.query(
      `INSERT INTO platform.users(
         id,email_normalized,display_name,password_hash,platform_role,status,mfa_status,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,'disabled','disabled',$6,$6)
       ON CONFLICT (id) DO UPDATE SET
         email_normalized=EXCLUDED.email_normalized,
         display_name=EXCLUDED.display_name,
         password_hash=EXCLUDED.password_hash,
         platform_role=EXCLUDED.platform_role,
         updated_at=GREATEST(platform.users.updated_at,EXCLUDED.updated_at)
       WHERE platform.users.status='disabled' AND platform.users.mfa_status='disabled'`,
      [targetId, email, requiredText(user.display_name, "LEGACY_USER_DISPLAY_NAME_INVALID", user.id),
        disabledPasswordHash(user.password_hash), user.role === "admin" ? "admin" : "member", createdAt]
    );
    const verified = await input.executor.query<{ email_normalized: string }>(
      "SELECT email_normalized FROM platform.users WHERE id=$1", [targetId]
    );
    if (verified.rows[0]?.email_normalized !== email) throw fieldError("LEGACY_USER_TARGET_CONFLICT", user.id);
    targetIds.set(user.id, targetId);
  }
  return targetIds;
}

async function importProjects(
  projectNames: string[],
  input: Parameters<typeof importLegacyCoreRecords>[0],
  users: LegacyUser[],
  userIds: Map<number, string>,
  observedAt: Date
) {
  const projectIds = new Map<string, string>();
  for (const name of projectNames) {
    const projectId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "project", legacyId: name, targetTable: "platform.projects",
      sourceRowSha256: legacyRowSha256({ name }), observedAt });
    await input.executor.query(
      `INSERT INTO platform.projects(id,name,status,created_at,updated_at)
       VALUES ($1,$2,'active',$3,$3) ON CONFLICT (id) DO NOTHING`,
      [projectId, requiredText(name, "LEGACY_PROJECT_NAME_INVALID", name), observedAt]
    );
    const verified = await input.executor.query<{ name: string }>(
      "SELECT name FROM platform.projects WHERE id=$1", [projectId]
    );
    if (verified.rows[0]?.name !== name) throw new Error("LEGACY_PROJECT_TARGET_CONFLICT");
    projectIds.set(name, projectId);

    for (const user of users) {
      const role = projectRoleByLegacyRole[user.role];
      if (!role) continue;
      const userId = userIds.get(user.id)!;
      const membershipLegacyId = `${name}:${user.id}`;
      const membershipId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "project_member", legacyId: membershipLegacyId, targetTable: "platform.project_members",
        sourceRowSha256: legacyRowSha256({ project: name, userId: user.id, role, active: user.active }), observedAt });
      await input.executor.query(
        `INSERT INTO platform.project_members(id,project_id,user_id,role,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING`,
        [membershipId, projectId, userId, role, user.active === 1 ? "active" : "disabled", observedAt]
      );
    }
  }
  return projectIds;
}

async function importSignatureAssets(
  database: DatabaseSync,
  input: Parameters<typeof importLegacyCoreRecords>[0],
  userIds: Map<number, string>,
  observedAt: Date
) {
  if (!tableExists(database, "signature_assets")) return 0;
  const rows = database.prepare(
    "SELECT id,user_id,kind,file_path,active,created_at FROM signature_assets ORDER BY id"
  ).all() as Array<{ id: number; user_id: number; kind: string; file_path: string; active: number; created_at: string }>;
  for (const row of rows) {
    const userId = userIds.get(row.user_id);
    if (!userId) throw fieldError("LEGACY_SIGNATURE_USER_MISSING", row.id);
    const pathHash = createHash("sha256").update(row.file_path).digest("hex");
    const file = await input.store.findLatestFileMapping(input.sourceId, pathHash);
    if (!file || file.status !== "ready" || file.mediaType !== "image/png") {
      throw fieldError("LEGACY_SIGNATURE_FILE_NOT_IMPORTED", row.id);
    }
    const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "signature_asset", legacyId: row.id, targetTable: "platform.signature_assets",
      sourceRowSha256: legacyRowSha256(row), observedAt });
    await input.executor.query(
      `INSERT INTO platform.signature_assets(
         id,user_id,object_id,kind,active,client_request_id,created_at
       ) VALUES ($1,$2,$3,'handwritten_png',$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET object_id=EXCLUDED.object_id,active=EXCLUDED.active`,
      [targetId, userId, file.storageObjectId, row.active === 1,
        `migration:${input.sourceId}:signature:${row.id}`,
        legacyDate(row.created_at, "LEGACY_SIGNATURE_DATE_INVALID", row.id)]
    );
  }
  return rows.length;
}

async function importApprovals(
  database: DatabaseSync,
  input: Parameters<typeof importLegacyCoreRecords>[0],
  users: LegacyUser[],
  userIds: Map<number, string>,
  projectIds: Map<string, string>,
  observedAt: Date
) {
  if (!tableExists(database, "approvals")) return { documents: 0, drawingRevisions: 0, approvalCases: 0,
    reviewDecisions: 0, signaturePlacements: 0, renderArtifacts: 0, annotations: 0, issues: 0, issueEvents: 0,
    parts: 0, partRevisionLinks: 0, partUsages: 0 };
  const approvals = database.prepare("SELECT * FROM approvals ORDER BY id").all() as Array<Record<string, unknown>>;
  if (approvals.length === 0) return { documents: 0, drawingRevisions: 0, approvalCases: 0,
    reviewDecisions: 0, signaturePlacements: 0, renderArtifacts: 0, annotations: 0, issues: 0, issueEvents: 0,
    parts: 0, partRevisionLinks: 0, partUsages: 0 };
  const supervisor = firstActiveRole(users, userIds, "supervisor");
  const process = firstActiveRole(users, userIds, "process");
  const fallbackSubmitter = firstActiveRole(users, userIds, "designer") ?? firstActiveRole(users, userIds, "admin");
  if (!supervisor || !process || !fallbackSubmitter) throw new Error("LEGACY_APPROVAL_ROLE_USER_MISSING");

  const documentIds = new Map<string, string>();
  for (const row of approvals) {
    const legacyId = integer(row.id, "LEGACY_APPROVAL_ID_INVALID");
    const projectName = requiredText(row.project_name, "LEGACY_PROJECT_NAME_INVALID", legacyId);
    const projectId = projectIds.get(projectName);
    if (!projectId) throw fieldError("LEGACY_APPROVAL_PROJECT_MISSING", legacyId);
    const documentCode = boundedText(row.document_code ?? row.part_name, 160,
      "LEGACY_DOCUMENT_CODE_INVALID", legacyId);
    const documentKey = `${projectName}:${documentCode}`;
    if (documentIds.has(documentKey)) continue;
    const submitterId = resolveSubmitter(row, users, userIds, fallbackSubmitter);
    const documentId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "document", legacyId: documentKey, targetTable: "platform.documents",
      sourceRowSha256: legacyRowSha256({ projectName, documentCode }), observedAt });
    const name = boundedText(row.drawing_name ?? row.part_name, 240, "LEGACY_DOCUMENT_NAME_INVALID", legacyId);
    const createdAt = legacyDate(String(row.submitted_at), "LEGACY_APPROVAL_DATE_INVALID", legacyId);
    await input.executor.query(
      `INSERT INTO platform.documents(id,project_id,document_code,name,created_by_user_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING`,
      [documentId, projectId, documentCode, name, submitterId, createdAt]
    );
    documentIds.set(documentKey, documentId);
  }

  let reviewDecisions = 0; let signaturePlacements = 0; let renderArtifacts = 0;
  const approvalIds = new Map<number, string>();
  const revisionIds = new Map<number, string>();
  for (const row of approvals) {
    const legacyId = integer(row.id, "LEGACY_APPROVAL_ID_INVALID");
    const projectName = String(row.project_name); const projectId = projectIds.get(projectName)!;
    const documentCode = boundedText(row.document_code ?? row.part_name, 160,
      "LEGACY_DOCUMENT_CODE_INVALID", legacyId);
    const documentId = documentIds.get(`${projectName}:${documentCode}`)!;
    const submitterId = resolveSubmitter(row, users, userIds, fallbackSubmitter);
    const originalObjectId = await mappedFileObject(input.store, input.sourceId,
      row.original_file_path, "application/pdf", legacyId);
    const createdAt = legacyDate(String(row.submitted_at), "LEGACY_APPROVAL_DATE_INVALID", legacyId);
    const revisionStatus = drawingRevisionStatus(row);
    const revisionId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "drawing_revision", legacyId, targetTable: "platform.drawing_revisions",
      sourceRowSha256: legacyRowSha256(row), observedAt });
    const publishedAt = revisionStatus === "published" ? terminalDate(row, createdAt) : null;
    await input.executor.query(
      `INSERT INTO platform.drawing_revisions(
         id,project_id,document_id,revision_code,original_object_id,source,status,metadata_status,
         material_code,client_request_id,created_by_user_id,submitted_at,published_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,'migration',$6,$7,$8,$9,$10,$11,$12,$11,$13)
       ON CONFLICT (id) DO NOTHING`,
      [revisionId, projectId, documentId,
        boundedText(row.version, 80, "LEGACY_REVISION_CODE_INVALID", legacyId), originalObjectId,
        revisionStatus, metadataStatus(row.pdm_metadata_status), optionalBoundedText(row.material_code, 160),
        `migration:${input.sourceId}:revision:${legacyId}`, submitterId, createdAt, publishedAt, observedAt]
    );
    revisionIds.set(legacyId, revisionId);
    const caseStatus = approvalCaseStatus(row.status);
    const completedAt = caseStatus === "pending" ? null : terminalDate(row, createdAt);
    const approvalId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "approval_case", legacyId, targetTable: "platform.approval_cases",
      sourceRowSha256: legacyRowSha256(row), observedAt });
    await input.executor.query(
      `INSERT INTO platform.approval_cases(
         id,project_id,revision_id,status,requires_signature,client_request_id,created_by_user_id,
         completed_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [approvalId, projectId, revisionId, caseStatus, row.signature_status !== "not_required",
        `migration:${input.sourceId}:approval:${legacyId}`, submitterId, completedAt, createdAt, observedAt]
    );
    approvalIds.set(legacyId, approvalId);
    for (const review of [
      { role: "supervisor", userId: supervisor, status: row.supervisor_status,
        comment: row.supervisor_comment, decidedAt: row.supervisor_reviewed_at },
      { role: "process", userId: process, status: row.process_status,
        comment: row.process_comment, decidedAt: row.process_reviewed_at }
    ]) {
      const status = reviewStatus(review.status, legacyId);
      const comment = status === "rejected"
        ? boundedText(review.comment, 4000, "LEGACY_REJECTION_COMMENT_MISSING", legacyId)
        : optionalBoundedText(review.comment, 4000);
      const decisionId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "review_decision", legacyId: `${legacyId}:${review.role}`,
        targetTable: "platform.review_decisions",
        sourceRowSha256: legacyRowSha256({ legacyId, ...review }), observedAt });
      await input.executor.query(
        `INSERT INTO platform.review_decisions(
           id,project_id,approval_case_id,reviewer_role,assigned_user_id,status,comment,client_request_id,
           decided_at,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [decisionId, projectId, approvalId, review.role, review.userId, status, comment,
          `migration:${input.sourceId}:review:${legacyId}:${review.role}`,
          status === "pending" ? null : legacyDate(String(review.decidedAt ?? row.submitted_at),
            "LEGACY_REVIEW_DATE_INVALID", `${legacyId}:${review.role}`), createdAt, observedAt]
      );
      reviewDecisions += 1;
    }
    renderArtifacts += await importRenderArtifacts(row, legacyId, approvalId, projectId, createdAt, input, observedAt);
  }

  if (tableExists(database, "signature_placements")) {
    const rows = database.prepare("SELECT * FROM signature_placements ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const legacyId = integer(row.id, "LEGACY_SIGNATURE_PLACEMENT_ID_INVALID");
      const approvalLegacyId = integer(row.approval_id, "LEGACY_SIGNATURE_PLACEMENT_APPROVAL_INVALID");
      const approvalId = approvalIds.get(approvalLegacyId);
      const approval = approvals.find((candidate) => Number(candidate.id) === approvalLegacyId);
      if (!approvalId || !approval) throw fieldError("LEGACY_SIGNATURE_PLACEMENT_APPROVAL_MISSING", legacyId);
      const projectId = projectIds.get(String(approval.project_name))!;
      const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "signature_placement", legacyId, targetTable: "platform.signature_placements",
        sourceRowSha256: legacyRowSha256(row), observedAt });
      await input.executor.query(
        `INSERT INTO platform.signature_placements(
           id,project_id,approval_case_id,signer_role,page_number,x_ratio,y_ratio,width_ratio,height_ratio,
           created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [targetId, projectId, approvalId, row.role, integer(row.page_number, "LEGACY_PAGE_NUMBER_INVALID"),
          number(row.x_ratio), number(row.y_ratio), number(row.width_ratio), number(row.height_ratio),
          legacyDate(String(row.created_at), "LEGACY_SIGNATURE_PLACEMENT_DATE_INVALID", legacyId), observedAt]
      );
      signaturePlacements += 1;
    }
  }
  const collaboration = await importCollaborationRecords(
    database, input, users, userIds, projectIds, approvals, approvalIds, observedAt
  );
  const pdm = await importPdmRecords(
    database, input, projectIds, approvals, approvalIds, revisionIds, observedAt
  );
  return { documents: documentIds.size, drawingRevisions: approvals.length, approvalCases: approvals.length,
    reviewDecisions, signaturePlacements, renderArtifacts, ...collaboration, ...pdm };
}

async function importCollaborationRecords(
  database: DatabaseSync,
  input: Parameters<typeof importLegacyCoreRecords>[0],
  users: LegacyUser[],
  userIds: Map<number, string>,
  projectIds: Map<string, string>,
  approvals: Array<Record<string, unknown>>,
  approvalIds: Map<number, string>,
  observedAt: Date
) {
  const annotationIds = new Map<number, string>();
  let annotations = 0;
  if (tableExists(database, "approval_annotations")) {
    const rows = database.prepare("SELECT * FROM approval_annotations ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const legacyId = integer(row.id, "LEGACY_ANNOTATION_ID_INVALID");
      const context = approvalContext(row.approval_id, approvals, approvalIds, projectIds);
      const authorId = mappedUser(row.author_user_id, userIds, "LEGACY_ANNOTATION_AUTHOR_MISSING", legacyId);
      const geometry = annotationGeometry(row);
      const style = annotationStyle(row);
      const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "annotation", legacyId, targetTable: "platform.annotations",
        sourceRowSha256: legacyRowSha256(row), observedAt });
      await input.executor.query(
        `INSERT INTO platform.annotations(
           id,project_id,approval_case_id,author_user_id,kind,page_number,geometry,style,message,resolved,
           created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [targetId, context.projectId, context.approvalId, authorId, row.kind,
          integer(row.page_number, "LEGACY_ANNOTATION_PAGE_INVALID"), JSON.stringify(geometry),
          JSON.stringify(style), boundedText(row.message, 4000, "LEGACY_ANNOTATION_MESSAGE_INVALID", legacyId),
          row.resolved === 1, legacyDate(String(row.created_at), "LEGACY_ANNOTATION_DATE_INVALID", legacyId),
          legacyDate(String(row.updated_at), "LEGACY_ANNOTATION_DATE_INVALID", legacyId)]
      );
      annotationIds.set(legacyId, targetId); annotations += 1;
    }
  }
  if (tableExists(database, "approval_comments")) {
    const rows = database.prepare("SELECT * FROM approval_comments ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const legacyId = integer(row.id, "LEGACY_COMMENT_ID_INVALID");
      const context = approvalContext(row.approval_id, approvals, approvalIds, projectIds);
      const authorId = mappedUser(row.author_user_id, userIds, "LEGACY_COMMENT_AUTHOR_MISSING", legacyId);
      const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "approval_comment", legacyId, targetTable: "platform.annotations",
        sourceRowSha256: legacyRowSha256(row), observedAt });
      await input.executor.query(
        `INSERT INTO platform.annotations(
           id,project_id,approval_case_id,author_user_id,kind,page_number,geometry,style,message,resolved,
           created_at,updated_at
         ) VALUES ($1,$2,$3,$4,'text',1,$5::jsonb,$6::jsonb,$7,$8,$9,$9)
         ON CONFLICT (id) DO NOTHING`,
        [targetId, context.projectId, context.approvalId, authorId,
          JSON.stringify({ xRatio: 0.5, yRatio: 0.5, legacyComment: true }),
          JSON.stringify({ legacyKind: String(row.kind) }),
          boundedText(row.message, 4000, "LEGACY_COMMENT_MESSAGE_INVALID", legacyId), row.resolved === 1,
          legacyDate(String(row.created_at), "LEGACY_COMMENT_DATE_INVALID", legacyId)]
      );
      annotations += 1;
    }
  }

  const issueIds = new Map<number, string>(); let issues = 0;
  if (tableExists(database, "approval_issues")) {
    const rows = database.prepare("SELECT * FROM approval_issues ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const legacyId = integer(row.id, "LEGACY_ISSUE_ID_INVALID");
      const context = approvalContext(row.approval_id, approvals, approvalIds, projectIds);
      const creatorId = mappedUser(row.creator_user_id, userIds, "LEGACY_ISSUE_CREATOR_MISSING", legacyId);
      const assigneeId = mappedUser(row.assignee_user_id, userIds, "LEGACY_ISSUE_ASSIGNEE_MISSING", legacyId);
      const closedById = row.closed_by_user_id == null ? null :
        mappedUser(row.closed_by_user_id, userIds, "LEGACY_ISSUE_CLOSER_MISSING", legacyId);
      const status = String(row.status);
      if (!["open", "in_progress", "review", "closed"].includes(status)) {
        throw fieldError("LEGACY_ISSUE_STATE_INVALID", legacyId);
      }
      if (status === "closed" && (!closedById || !row.closed_at)) throw fieldError("LEGACY_ISSUE_CLOSE_INVALID", legacyId);
      const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "issue", legacyId, targetTable: "platform.issues",
        sourceRowSha256: legacyRowSha256(row), observedAt });
      const clientRequestId = `migration:${input.sourceId}:issue:${legacyId}`;
      await input.executor.query(
        `INSERT INTO platform.issues(
           id,project_id,approval_case_id,annotation_id,creator_user_id,assignee_user_id,title,description,
           severity,status,due_at,resolution_summary,review_note,forced_close_reason,client_request_id,
           client_request_hash,version,submitted_for_review_at,closed_by_user_id,closed_at,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,decode($16,'hex'),$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO NOTHING`,
        [targetId, context.projectId, context.approvalId,
          row.annotation_id == null ? null : annotationIds.get(integer(row.annotation_id, "LEGACY_ISSUE_ANNOTATION_INVALID")),
          creatorId, assigneeId, boundedText(row.title, 240, "LEGACY_ISSUE_TITLE_INVALID", legacyId),
          boundedText(row.description, 8000, "LEGACY_ISSUE_DESCRIPTION_INVALID", legacyId), row.severity, status,
          optionalDate(row.due_at, "LEGACY_ISSUE_DATE_INVALID", legacyId), optionalBoundedText(row.resolution_summary, 8000),
          optionalBoundedText(row.review_note, 8000), optionalBoundedText(row.forced_close_reason, 4000),
          clientRequestId, createHash("sha256").update(clientRequestId).digest("hex"),
          integer(row.version, "LEGACY_ISSUE_VERSION_INVALID"),
          optionalDate(row.submitted_for_review_at, "LEGACY_ISSUE_DATE_INVALID", legacyId), closedById,
          optionalDate(row.closed_at, "LEGACY_ISSUE_DATE_INVALID", legacyId),
          legacyDate(String(row.created_at), "LEGACY_ISSUE_DATE_INVALID", legacyId),
          legacyDate(String(row.updated_at), "LEGACY_ISSUE_DATE_INVALID", legacyId)]
      );
      issueIds.set(legacyId, targetId); issues += 1;
    }
  }

  let issueEvents = 0;
  if (tableExists(database, "approval_issue_events")) {
    const rows = database.prepare("SELECT * FROM approval_issue_events ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const legacyId = integer(row.id, "LEGACY_ISSUE_EVENT_ID_INVALID");
      const issueId = issueIds.get(integer(row.issue_id, "LEGACY_ISSUE_EVENT_ISSUE_INVALID"));
      if (!issueId) throw fieldError("LEGACY_ISSUE_EVENT_ISSUE_MISSING", legacyId);
      const actorId = mappedUser(row.actor_user_id, userIds, "LEGACY_ISSUE_EVENT_ACTOR_MISSING", legacyId);
      const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "issue_event", legacyId, targetTable: "platform.issue_events",
        sourceRowSha256: legacyRowSha256(row), observedAt });
      const requestId = `migration:${input.sourceId}:issue-event:${legacyId}`;
      await input.executor.query(
        `INSERT INTO platform.issue_events(
           id,issue_id,actor_user_id,event_type,from_status,to_status,note,client_request_id,
           client_request_hash,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'),$10) ON CONFLICT (id) DO NOTHING`,
        [targetId, issueId, actorId, issueEventType(row.action), row.from_status ?? null, row.to_status,
          optionalBoundedText(row.note, 8000), requestId, createHash("sha256").update(requestId).digest("hex"),
          legacyDate(String(row.created_at), "LEGACY_ISSUE_EVENT_DATE_INVALID", legacyId)]
      );
      issueEvents += 1;
    }
  }
  return { annotations, issues, issueEvents };
}

async function importPdmRecords(
  database: DatabaseSync,
  input: Parameters<typeof importLegacyCoreRecords>[0],
  projectIds: Map<string, string>,
  approvals: Array<Record<string, unknown>>,
  approvalIds: Map<number, string>,
  revisionIds: Map<number, string>,
  observedAt: Date
) {
  if (!tableExists(database, "pdm_parts") || !tableExists(database, "pdm_drawing_revisions")) {
    return { parts: 0, partRevisionLinks: 0, partUsages: 0 };
  }
  const parts = database.prepare("SELECT * FROM pdm_parts ORDER BY id").all() as Array<Record<string, unknown>>;
  const revisions = database.prepare("SELECT * FROM pdm_drawing_revisions ORDER BY id").all() as Array<Record<string, unknown>>;
  const targetPartIds = new Map<number, string>();
  const ownerProjectIds = new Map<number, string>();
  for (const part of parts) {
    const legacyId = integer(part.id, "LEGACY_PART_ID_INVALID");
    const firstRevision = revisions.find((revision) => Number(revision.part_id) === legacyId);
    if (!firstRevision) throw fieldError("LEGACY_PART_REVISION_MISSING", legacyId);
    const approval = approvals.find((candidate) => Number(candidate.id) === Number(firstRevision.approval_id));
    const projectId = approval ? projectIds.get(String(approval.project_name)) : undefined;
    if (!projectId) throw fieldError("LEGACY_PART_PROJECT_MISSING", legacyId);
    const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "part", legacyId, targetTable: "platform.parts", sourceRowSha256: legacyRowSha256(part), observedAt });
    await input.executor.query(
      `INSERT INTO platform.parts(id,project_id,part_number,name,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [targetId, projectId, boundedText(part.material_code, 160, "LEGACY_PART_NUMBER_INVALID", legacyId),
        boundedText(part.name, 240, "LEGACY_PART_NAME_INVALID", legacyId),
        legacyDate(String(part.created_at), "LEGACY_PART_DATE_INVALID", legacyId),
        legacyDate(String(part.updated_at), "LEGACY_PART_DATE_INVALID", legacyId)]
    );
    targetPartIds.set(legacyId, targetId); ownerProjectIds.set(legacyId, projectId);
  }

  const targetRevisionByPdmId = new Map<number, string>();
  for (const revision of revisions) {
    const legacyId = integer(revision.id, "LEGACY_PDM_REVISION_ID_INVALID");
    const partId = targetPartIds.get(integer(revision.part_id, "LEGACY_PDM_REVISION_PART_INVALID"));
    const projectId = ownerProjectIds.get(Number(revision.part_id));
    const drawingRevisionId = revisionIds.get(integer(revision.approval_id, "LEGACY_PDM_REVISION_APPROVAL_INVALID"));
    if (!partId || !projectId || !drawingRevisionId) throw fieldError("LEGACY_PDM_REVISION_TARGET_MISSING", legacyId);
    const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "part_revision_link", legacyId, targetTable: "platform.part_revision_links",
      sourceRowSha256: legacyRowSha256(revision), observedAt });
    const releaseStatus = revision.release_status === "voided" ? "void" : "published";
    await input.executor.query(
      `INSERT INTO platform.part_revision_links(
         id,project_id,part_id,revision_id,material_code,release_status,void_reason,released_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [targetId, projectId, partId, drawingRevisionId,
        optionalBoundedText(revision.material_code, 160), releaseStatus,
        releaseStatus === "void" ? "旧系统迁移记录：该版本已作废" : null,
        releaseStatus === "published" ? legacyDate(String(revision.released_at),
          "LEGACY_PDM_REVISION_DATE_INVALID", legacyId) : null,
        legacyDate(String(revision.created_at), "LEGACY_PDM_REVISION_DATE_INVALID", legacyId),
        legacyDate(String(revision.updated_at), "LEGACY_PDM_REVISION_DATE_INVALID", legacyId)]
    );
    targetRevisionByPdmId.set(legacyId, drawingRevisionId);
  }
  for (const part of parts) {
    if (part.current_revision_id === null || part.current_revision_id === undefined) continue;
    const partId = targetPartIds.get(Number(part.id))!;
    const currentRevisionId = targetRevisionByPdmId.get(Number(part.current_revision_id));
    if (!currentRevisionId) throw fieldError("LEGACY_PART_CURRENT_REVISION_MISSING", String(part.id));
    await input.executor.query(
      "UPDATE platform.parts SET current_revision_id=$2,updated_at=GREATEST(updated_at,$3) WHERE id=$1",
      [partId, currentRevisionId, observedAt]
    );
  }

  let partUsages = 0;
  if (tableExists(database, "pdm_part_usages")) {
    const usages = database.prepare("SELECT * FROM pdm_part_usages ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const usage of usages) {
      const legacyId = integer(usage.id, "LEGACY_PART_USAGE_ID_INVALID");
      const legacyPartId = integer(usage.part_id, "LEGACY_PART_USAGE_PART_INVALID");
      const partId = targetPartIds.get(legacyPartId); const projectId = ownerProjectIds.get(legacyPartId);
      const usedInProjectId = projectIds.get(String(usage.project_name));
      const firstApprovalId = approvalIds.get(integer(usage.first_approval_id, "LEGACY_PART_USAGE_APPROVAL_INVALID"));
      const lastApprovalId = approvalIds.get(integer(usage.last_approval_id, "LEGACY_PART_USAGE_APPROVAL_INVALID"));
      if (!partId || !projectId || !usedInProjectId || !firstApprovalId || !lastApprovalId) {
        throw fieldError("LEGACY_PART_USAGE_TARGET_MISSING", legacyId);
      }
      const targetId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
        entityType: "part_usage", legacyId, targetTable: "platform.part_usages",
        sourceRowSha256: legacyRowSha256(usage), observedAt });
      await input.executor.query(
        `INSERT INTO platform.part_usages(
           id,project_id,part_id,used_in_project_id,first_approval_case_id,last_approval_case_id,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [targetId, projectId, partId, usedInProjectId, firstApprovalId, lastApprovalId,
          legacyDate(String(usage.created_at), "LEGACY_PART_USAGE_DATE_INVALID", legacyId),
          legacyDate(String(usage.updated_at), "LEGACY_PART_USAGE_DATE_INVALID", legacyId)]
      );
      partUsages += 1;
    }
  }
  return { parts: parts.length, partRevisionLinks: revisions.length, partUsages };
}

async function importRenderArtifacts(
  row: Record<string, unknown>, legacyId: number, approvalId: string, projectId: string, createdAt: Date,
  input: Parameters<typeof importLegacyCoreRecords>[0], observedAt: Date
) {
  let count = 0;
  const candidates = [
    { kind: "annotated_review", path: row.current_file_path !== row.original_file_path ? row.current_file_path : null },
    { kind: "signed_pdf", path: row.signed_file_path }
  ] as const;
  for (const candidate of candidates) {
    if (typeof candidate.path !== "string" || !candidate.path.trim()) continue;
    const objectId = await mappedFileObject(input.store, input.sourceId, candidate.path, "application/pdf", legacyId);
    const artifactId = await input.store.recordIdMapping({ runId: input.runId, sourceId: input.sourceId,
      entityType: "render_artifact", legacyId: `${legacyId}:${candidate.kind}`,
      targetTable: "platform.render_artifacts",
      sourceRowSha256: legacyRowSha256({ path: candidate.path, kind: candidate.kind }), observedAt });
    await input.executor.query(
      `INSERT INTO platform.render_artifacts(
         id,project_id,approval_case_id,kind,generation,status,object_id,idempotency_key,ready_at,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,1,'ready',$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [artifactId, projectId, approvalId, candidate.kind, objectId,
        `migration:${input.sourceId}:artifact:${legacyId}:${candidate.kind}`,
        terminalDate(row, createdAt), createdAt, observedAt]
    );
    count += 1;
  }
  return count;
}

async function mappedFileObject(
  store: LegacyMigrationStore, sourceId: string, sourcePath: unknown, mediaType: string, legacyId: number
) {
  if (typeof sourcePath !== "string" || !sourcePath.trim()) throw fieldError("LEGACY_FILE_REFERENCE_MISSING", legacyId);
  const pathHash = createHash("sha256").update(sourcePath).digest("hex");
  const file = await store.findLatestFileMapping(sourceId, pathHash);
  if (!file || file.status !== "ready" || file.mediaType !== mediaType) {
    throw fieldError("LEGACY_FILE_NOT_IMPORTED", legacyId);
  }
  return file.storageObjectId;
}

function firstActiveRole(users: LegacyUser[], ids: Map<number, string>, role: string) {
  const user = users.find((candidate) => candidate.role === role && candidate.active === 1);
  return user ? ids.get(user.id) : undefined;
}

function resolveSubmitter(
  row: Record<string, unknown>, users: LegacyUser[], ids: Map<number, string>, fallback: string
) {
  const numericId = Number(row.submitted_by_user_id);
  if (Number.isSafeInteger(numericId) && ids.has(numericId)) return ids.get(numericId)!;
  if (typeof row.submitted_by === "string") {
    const matched = users.find((user) => user.username === row.submitted_by);
    if (matched && ids.has(matched.id)) return ids.get(matched.id)!;
  }
  return fallback;
}

function drawingRevisionStatus(row: Record<string, unknown>) {
  if (row.status === "pending") return "submitted";
  if (row.status === "rejected") return "rejected";
  if (row.status === "voided") return "void";
  if (row.status === "approved_for_print" || row.status === "printed_archived") {
    return row.pdm_publish_status === "published" ? "published" : "approved";
  }
  throw fieldError("LEGACY_APPROVAL_STATE_NOT_IMPORTABLE", String(row.id));
}

function approvalCaseStatus(value: unknown) {
  if (value === "pending") return "pending";
  if (value === "rejected") return "rejected";
  if (value === "approved_for_print" || value === "printed_archived") return "approved";
  if (value === "voided") return "void";
  throw new Error("LEGACY_APPROVAL_STATE_NOT_IMPORTABLE");
}

function reviewStatus(value: unknown, legacyId: number) {
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  throw fieldError("LEGACY_REVIEW_STATE_INVALID", legacyId);
}

function metadataStatus(value: unknown) {
  if (["complete", "missing_material_code", "missing_document_code", "missing_required"].includes(String(value))) {
    return String(value);
  }
  return "missing_required";
}

function terminalDate(row: Record<string, unknown>, fallback: Date) {
  const candidate = row.archived_at ?? row.printed_at ?? row.signed_at ?? row.supervisor_reviewed_at ??
    row.process_reviewed_at ?? row.submitted_at;
  return candidate ? legacyDate(String(candidate), "LEGACY_TERMINAL_DATE_INVALID", String(row.id)) : fallback;
}

function approvalContext(
  rawApprovalId: unknown,
  approvals: Array<Record<string, unknown>>,
  approvalIds: Map<number, string>,
  projectIds: Map<string, string>
) {
  const legacyApprovalId = integer(rawApprovalId, "LEGACY_APPROVAL_REFERENCE_INVALID");
  const approval = approvals.find((candidate) => Number(candidate.id) === legacyApprovalId);
  const approvalId = approvalIds.get(legacyApprovalId);
  const projectId = approval ? projectIds.get(String(approval.project_name)) : undefined;
  if (!approval || !approvalId || !projectId) throw fieldError("LEGACY_APPROVAL_REFERENCE_MISSING", legacyApprovalId);
  return { approval, approvalId, projectId };
}

function mappedUser(rawUserId: unknown, userIds: Map<number, string>, code: string, legacyId: number) {
  const userId = userIds.get(integer(rawUserId, code));
  if (!userId) throw fieldError(code, legacyId);
  return userId;
}

function annotationGeometry(row: Record<string, unknown>) {
  const geometry: Record<string, unknown> = { xRatio: number(row.x_ratio), yRatio: number(row.y_ratio) };
  for (const [source, target] of [
    ["width_ratio", "widthRatio"], ["height_ratio", "heightRatio"],
    ["end_x_ratio", "endXRatio"], ["end_y_ratio", "endYRatio"]
  ] as const) {
    if (row[source] !== null && row[source] !== undefined) geometry[target] = number(row[source]);
  }
  if (typeof row.points_json === "string" && row.points_json) geometry.points = parseJson(row.points_json);
  return geometry;
}

function annotationStyle(row: Record<string, unknown>) {
  const style = typeof row.style_json === "string" && row.style_json ? parseJson(row.style_json) : {};
  if (!style || typeof style !== "object" || Array.isArray(style)) throw new Error("LEGACY_ANNOTATION_STYLE_INVALID");
  return { ...(style as Record<string, unknown>), color: String(row.color ?? "red") };
}

function parseJson(value: string) {
  try { return JSON.parse(value); } catch { throw new Error("LEGACY_JSON_INVALID"); }
}

function issueEventType(value: unknown) {
  const mapping: Record<string, string> = {
    created: "created", started: "started", submitted_review: "submitted", returned: "returned",
    closed: "closed", force_closed: "force_closed"
  };
  const result = mapping[String(value)];
  if (!result) throw new Error("LEGACY_ISSUE_EVENT_TYPE_INVALID");
  return result;
}

function optionalDate(value: unknown, code: string, id: string | number) {
  if (value === null || value === undefined || value === "") return null;
  return legacyDate(String(value), code, id);
}

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (value !== value.trim() || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function disabledPasswordHash(legacyHash: string) {
  return `legacy-disabled:${createHash("sha256").update(legacyHash).digest("hex")}`;
}

function legacyDate(value: string, code: string, id: string | number) {
  const date = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(date.getTime())) throw fieldError(code, id);
  return date;
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("LEGACY_IMPORT_CLOCK_INVALID");
  return new Date(value);
}

function requiredText(value: unknown, code: string, id: string | number) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw fieldError(code, id);
  return value;
}

function boundedText(value: unknown, maximum: number, code: string, id: string | number) {
  const text = requiredText(value, code, id);
  if (text.length > maximum) throw fieldError(code, id);
  return text;
}

function optionalBoundedText(value: unknown, maximum: number) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > maximum) {
    throw new Error("LEGACY_OPTIONAL_TEXT_INVALID");
  }
  return value;
}

function integer(value: unknown, code: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function number(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("LEGACY_NUMBER_INVALID");
  return parsed;
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function fieldError(code: string, id: string | number) {
  const error = new Error(code);
  Object.defineProperty(error, "legacyId", { value: String(id), enumerable: true });
  return error;
}
