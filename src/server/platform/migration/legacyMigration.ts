import path from "node:path";
import type { QueryExecutor } from "../database/queryExecutor.ts";
import type { StorageAdapter } from "../storage/storageAdapter.ts";
import { importLegacyCoreRecords } from "./legacyCoreImporter.ts";
import { importLegacyFileObject } from "./legacyFileImporter.ts";
import { preflightLegacyFiles, type RootMapping } from "./legacyFilePreflight.ts";
import { inspectLegacyDatabase } from "./legacyInventory.ts";
import { LegacyMigrationStore, type LegacyMigrationMode } from "./legacyMigrationStore.ts";
import { verifyLegacyMigration } from "./legacyMigrationVerifier.ts";

export async function runLegacyMigration(input: {
  readonly databasePath: string;
  readonly sourceId: string;
  readonly roots: readonly RootMapping[];
  readonly emailOverrides?: Readonly<Record<string, string>>;
  readonly mode: Extract<LegacyMigrationMode, "import" | "delta">;
  readonly executor: QueryExecutor;
  readonly storage: StorageAdapter;
  readonly now?: () => Date;
}) {
  const inventory = await inspectLegacyDatabase({ databasePath: input.databasePath, sourceId: input.sourceId,
    now: input.now });
  assertInventoryEligible(inventory, input.emailOverrides);
  const files = await preflightLegacyFiles({ databasePath: input.databasePath, roots: input.roots, now: input.now });
  if (!files.eligibleForImport) throw new Error("LEGACY_FILE_PREFLIGHT_BLOCKED");
  const store = new LegacyMigrationStore(input.executor);
  const baseline = input.mode === "delta" ? await store.findLatestSuccessfulImport(input.sourceId) : undefined;
  if (input.mode === "delta" && !baseline) throw new Error("LEGACY_DELTA_BASELINE_REQUIRED");
  const startedAt = ownDate((input.now ?? (() => new Date()))());
  const run = await store.startRun({ sourceId: input.sourceId, mode: input.mode,
    sourceFingerprintSha256: inventory.source.fingerprintSha256, baselineRunId: baseline?.id, startedAt });
  try {
    let importedFiles = 0;
    let reusedFiles = 0;
    for (const file of files.files) {
      const root = input.roots[file.rootIndex];
      if (!root) throw new Error("LEGACY_FILE_ROOT_MAPPING_MISSING");
      const absolutePath = path.resolve(root.snapshotRoot, ...file.relativePath.split("/"));
      const imported = await importLegacyFileObject({ runId: run.id, sourceId: input.sourceId,
        sourcePathSha256: file.sourcePathSha256, sourceContentSha256: file.sha256, absolutePath,
        sizeBytes: file.sizeBytes, mediaType: file.mediaType, storage: input.storage, store, now: input.now });
      imported.reused ? reusedFiles += 1 : importedFiles += 1;
    }
    const core = await importLegacyCoreRecords({ databasePath: input.databasePath, sourceId: input.sourceId,
      runId: run.id, emailOverrides: input.emailOverrides, executor: input.executor, store, now: input.now });
    const verification = await verifyLegacyMigration({ executor: input.executor, sourceId: input.sourceId,
      expected: { users: core.users, projects: core.projects, signatureAssets: core.signatureAssets,
        files: files.verifiedFiles, documents: core.documents, drawingRevisions: core.drawingRevisions,
        approvalCases: core.approvalCases, reviewDecisions: core.reviewDecisions,
        signaturePlacements: core.signaturePlacements, renderArtifacts: core.renderArtifacts,
        annotations: core.annotations, issues: core.issues, issueEvents: core.issueEvents,
        parts: core.parts, partRevisionLinks: core.partRevisionLinks, partUsages: core.partUsages } });

    if (!verification.eligibleForCutover) throw new Error("LEGACY_MIGRATION_VERIFY_FAILED");
    const report = { schemaVersion: 1, runId: run.id, mode: input.mode, sourceId: input.sourceId,
      sourceFingerprintSha256: inventory.source.fingerprintSha256, baselineRunId: baseline?.id ?? null,
      counts: { ...core, importedFiles, reusedFiles }, verification };
    await store.completeRun(run.id, { status: "succeeded", completedAt: nextCompletion(startedAt, input.now), report });
    return Object.freeze(report);
  } catch (error) {
    await store.completeRun(run.id, { status: "failed", completedAt: nextCompletion(startedAt, input.now),
      report: { schemaVersion: 1, code: safeErrorCode(error) } }).catch(() => undefined);
    throw error;
  }
}

function assertInventoryEligible(
  inventory: Awaited<ReturnType<typeof inspectLegacyDatabase>>,
  emailOverrides: Readonly<Record<string, string>> | undefined
) {
  const blocking = inventory.issues.filter((issue) => issue.severity === "blocking");
  for (const issue of blocking) {
    if (issue.code !== "ACTIVE_USER_EMAIL_MISSING") throw new Error(`LEGACY_INVENTORY_BLOCKED:${issue.code}`);
    if (!issue.sampleIds || Object.keys(emailOverrides ?? {}).length < issue.count ||
        issue.sampleIds.some((id) => !emailOverrides?.[String(id)])) {
      throw new Error("LEGACY_INVENTORY_BLOCKED:ACTIVE_USER_EMAIL_MISSING");
    }
  }
}

function ownDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("LEGACY_MIGRATION_CLOCK_INVALID");
  return new Date(value);
}

function nextCompletion(startedAt: Date, clock: (() => Date) | undefined) {
  const value = ownDate((clock ?? (() => new Date()))());
  return value.getTime() >= startedAt.getTime() ? value : new Date(startedAt);
}

function safeErrorCode(error: unknown) {
  const value = error instanceof Error ? error.message : "LEGACY_MIGRATION_FAILED";
  return /^[A-Z0-9_:.-]{1,160}$/.test(value) ? value : "LEGACY_MIGRATION_FAILED";
}
