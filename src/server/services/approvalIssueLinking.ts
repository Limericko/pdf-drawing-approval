import type { DatabaseConnection } from "../db.ts";
import type {
  ApprovalAnnotation,
  ApprovalAnnotationInput,
  ApprovalAnnotationRepository
} from "../repositories/approvalAnnotations.ts";
import type {
  ApprovalIssue,
  ApprovalIssueRepository,
  CreateApprovalIssueInput
} from "../repositories/approvalIssues.ts";

export type LinkedApprovalIssueResult = {
  issue: ApprovalIssue;
  annotation: ApprovalAnnotation;
  created: boolean;
};

export function createLinkedApprovalIssue(
  deps: {
    db: DatabaseConnection;
    approvalAnnotations: ApprovalAnnotationRepository;
    approvalIssues: ApprovalIssueRepository;
  },
  input: {
    issue: Omit<CreateApprovalIssueInput, "annotationId">;
    annotation: ApprovalAnnotationInput;
  }
): LinkedApprovalIssueResult {
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    if (input.issue.clientRequestId) {
      const existing = deps.approvalIssues.getByClientRequestId(input.issue.clientRequestId);
      if (existing) {
        if (existing.approvalId !== input.issue.approvalId) throw new Error("ISSUE_REQUEST_ID_CONFLICT");
        if (!existing.annotationId) throw new Error("ISSUE_LINKED_ANNOTATION_NOT_FOUND");
        const annotation = deps.approvalAnnotations.getById(existing.annotationId);
        if (!annotation) throw new Error("ISSUE_LINKED_ANNOTATION_NOT_FOUND");
        deps.db.exec("COMMIT");
        return { issue: existing, annotation, created: false };
      }
    }

    const annotation = deps.approvalAnnotations.create(input.annotation);
    const issue = deps.approvalIssues.createInCurrentTransaction({
      ...input.issue,
      annotationId: annotation.id
    });
    deps.db.exec("COMMIT");
    return { issue, annotation, created: true };
  } catch (error) {
    deps.db.exec("ROLLBACK");
    throw error;
  }
}
