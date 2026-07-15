import type { QueryExecutor } from "../database/queryExecutor.ts";

export type LegacyMigrationExpectedCounts = {
  readonly users: number;
  readonly projects: number;
  readonly signatureAssets: number;
  readonly files: number;
  readonly documents: number;
  readonly drawingRevisions: number;
  readonly approvalCases: number;
  readonly reviewDecisions: number;
  readonly signaturePlacements: number;
  readonly renderArtifacts: number;
  readonly annotations: number;
  readonly issues: number;
  readonly issueEvents: number;
  readonly parts: number;
  readonly partRevisionLinks: number;
  readonly partUsages: number;
};

export async function verifyLegacyMigration(input: {
  readonly executor: QueryExecutor;
  readonly sourceId: string;
  readonly expected: LegacyMigrationExpectedCounts;
}) {
  const result = await input.executor.query<{
    user_mappings: string; mapped_users: string; project_mappings: string; mapped_projects: string;
    signature_mappings: string; mapped_signatures: string; file_mappings: string; mapped_files: string;
    document_mappings: string; mapped_documents: string; revision_mappings: string; mapped_revisions: string;
    approval_mappings: string; mapped_approvals: string; review_mappings: string; mapped_reviews: string;
    placement_mappings: string; mapped_placements: string; artifact_mappings: string; mapped_artifacts: string;
    annotation_mappings: string; mapped_annotations: string; issue_mappings: string; mapped_issues: string;
    issue_event_mappings: string; mapped_issue_events: string;
    part_mappings: string; mapped_parts: string; part_link_mappings: string; mapped_part_links: string;
    part_usage_mappings: string; mapped_part_usages: string;
    unvalidated_constraints: string;
  }>(`SELECT
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='user') AS user_mappings,
    (SELECT count(*) FROM platform.users target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='user') AS mapped_users,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='project') AS project_mappings,
    (SELECT count(*) FROM platform.projects target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='project') AS mapped_projects,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='signature_asset') AS signature_mappings,
    (SELECT count(*) FROM platform.signature_assets target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='signature_asset') AS mapped_signatures,
    (SELECT count(DISTINCT source_path_sha256) FROM platform.legacy_file_mappings WHERE source_id=$1) AS file_mappings,
    (SELECT count(*) FROM (
       SELECT DISTINCT ON (source_path_sha256) * FROM platform.legacy_file_mappings
       WHERE source_id=$1 ORDER BY source_path_sha256,verified_at DESC,source_content_sha256 DESC
     ) mapping JOIN platform.storage_objects object ON object.id=mapping.storage_object_id
      WHERE object.status='ready' AND object.size_bytes=mapping.size_bytes
      AND encode(object.sha256,'hex')=mapping.source_content_sha256) AS mapped_files,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='document') AS document_mappings,
    (SELECT count(*) FROM platform.documents target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='document') AS mapped_documents,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='drawing_revision') AS revision_mappings,
    (SELECT count(*) FROM platform.drawing_revisions target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='drawing_revision') AS mapped_revisions,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='approval_case') AS approval_mappings,
    (SELECT count(*) FROM platform.approval_cases target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='approval_case') AS mapped_approvals,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='review_decision') AS review_mappings,
    (SELECT count(*) FROM platform.review_decisions target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='review_decision') AS mapped_reviews,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='signature_placement') AS placement_mappings,
    (SELECT count(*) FROM platform.signature_placements target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='signature_placement') AS mapped_placements,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='render_artifact') AS artifact_mappings,
    (SELECT count(*) FROM platform.render_artifacts target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='render_artifact') AS mapped_artifacts,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1
      AND entity_type IN ('annotation','approval_comment')) AS annotation_mappings,
    (SELECT count(*) FROM platform.annotations target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1
      AND mapping.entity_type IN ('annotation','approval_comment')) AS mapped_annotations,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='issue') AS issue_mappings,
    (SELECT count(*) FROM platform.issues target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='issue') AS mapped_issues,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='issue_event') AS issue_event_mappings,
    (SELECT count(*) FROM platform.issue_events target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='issue_event') AS mapped_issue_events,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='part') AS part_mappings,
    (SELECT count(*) FROM platform.parts target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='part') AS mapped_parts,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='part_revision_link') AS part_link_mappings,
    (SELECT count(*) FROM platform.part_revision_links target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='part_revision_link') AS mapped_part_links,
    (SELECT count(*) FROM platform.legacy_id_mappings WHERE source_id=$1 AND entity_type='part_usage') AS part_usage_mappings,
    (SELECT count(*) FROM platform.part_usages target JOIN platform.legacy_id_mappings mapping
      ON mapping.target_id=target.id WHERE mapping.source_id=$1 AND mapping.entity_type='part_usage') AS mapped_part_usages,
    (SELECT count(*) FROM pg_constraint constraint_record JOIN pg_namespace namespace
      ON namespace.oid=constraint_record.connamespace WHERE namespace.nspname='platform'
      AND NOT constraint_record.convalidated) AS unvalidated_constraints`, [input.sourceId]);
  const row = result.rows[0];
  if (!row) throw new Error("LEGACY_MIGRATION_VERIFY_QUERY_EMPTY");
  const actual = {
    users: count(row.user_mappings), mappedUsers: count(row.mapped_users),
    projects: count(row.project_mappings), mappedProjects: count(row.mapped_projects),
    signatureAssets: count(row.signature_mappings), mappedSignatureAssets: count(row.mapped_signatures),
    files: count(row.file_mappings), mappedFiles: count(row.mapped_files),
    documents: count(row.document_mappings), mappedDocuments: count(row.mapped_documents),
    drawingRevisions: count(row.revision_mappings), mappedDrawingRevisions: count(row.mapped_revisions),
    approvalCases: count(row.approval_mappings), mappedApprovalCases: count(row.mapped_approvals),
    reviewDecisions: count(row.review_mappings), mappedReviewDecisions: count(row.mapped_reviews),
    signaturePlacements: count(row.placement_mappings), mappedSignaturePlacements: count(row.mapped_placements),
    renderArtifacts: count(row.artifact_mappings), mappedRenderArtifacts: count(row.mapped_artifacts),
    annotations: count(row.annotation_mappings), mappedAnnotations: count(row.mapped_annotations),
    issues: count(row.issue_mappings), mappedIssues: count(row.mapped_issues),
    issueEvents: count(row.issue_event_mappings), mappedIssueEvents: count(row.mapped_issue_events),
    parts: count(row.part_mappings), mappedParts: count(row.mapped_parts),
    partRevisionLinks: count(row.part_link_mappings), mappedPartRevisionLinks: count(row.mapped_part_links),
    partUsages: count(row.part_usage_mappings), mappedPartUsages: count(row.mapped_part_usages),
    unvalidatedConstraints: count(row.unvalidated_constraints)
  };
  const issues: string[] = [];
  compare("USERS", input.expected.users, actual.users, actual.mappedUsers, issues);
  compare("PROJECTS", input.expected.projects, actual.projects, actual.mappedProjects, issues);
  compare("SIGNATURE_ASSETS", input.expected.signatureAssets, actual.signatureAssets,
    actual.mappedSignatureAssets, issues);
  compare("FILES", input.expected.files, actual.files, actual.mappedFiles, issues);
  compare("DOCUMENTS", input.expected.documents, actual.documents, actual.mappedDocuments, issues);
  compare("DRAWING_REVISIONS", input.expected.drawingRevisions, actual.drawingRevisions,
    actual.mappedDrawingRevisions, issues);
  compare("APPROVAL_CASES", input.expected.approvalCases, actual.approvalCases,
    actual.mappedApprovalCases, issues);
  compare("REVIEW_DECISIONS", input.expected.reviewDecisions, actual.reviewDecisions,
    actual.mappedReviewDecisions, issues);
  compare("SIGNATURE_PLACEMENTS", input.expected.signaturePlacements, actual.signaturePlacements,
    actual.mappedSignaturePlacements, issues);
  compare("RENDER_ARTIFACTS", input.expected.renderArtifacts, actual.renderArtifacts,
    actual.mappedRenderArtifacts, issues);
  compare("ANNOTATIONS", input.expected.annotations, actual.annotations, actual.mappedAnnotations, issues);
  compare("ISSUES", input.expected.issues, actual.issues, actual.mappedIssues, issues);
  compare("ISSUE_EVENTS", input.expected.issueEvents, actual.issueEvents, actual.mappedIssueEvents, issues);
  compare("PARTS", input.expected.parts, actual.parts, actual.mappedParts, issues);
  compare("PART_REVISION_LINKS", input.expected.partRevisionLinks, actual.partRevisionLinks,
    actual.mappedPartRevisionLinks, issues);
  compare("PART_USAGES", input.expected.partUsages, actual.partUsages, actual.mappedPartUsages, issues);
  if (actual.unvalidatedConstraints !== 0) issues.push("POSTGRES_CONSTRAINT_NOT_VALIDATED");
  return Object.freeze({ expected: input.expected, actual: Object.freeze(actual),
    issues: Object.freeze(issues), eligibleForCutover: issues.length === 0 });
}

function compare(name: string, expected: number, mapped: number, targets: number, issues: string[]) {
  if (mapped !== expected) issues.push(`${name}_MAPPING_COUNT_MISMATCH`);
  if (targets !== mapped) issues.push(`${name}_TARGET_COUNT_MISMATCH`);
}

function count(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("LEGACY_MIGRATION_VERIFY_COUNT_INVALID");
  return parsed;
}
