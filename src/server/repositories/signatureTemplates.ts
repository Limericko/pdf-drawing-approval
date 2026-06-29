import type { DatabaseConnection } from "../db.ts";
import type { SignaturePlacementInput, SignaturePlacementRole } from "./signaturePlacements.ts";

export type SignatureTemplate = {
  id: number;
  name: string;
  projectName: string | null;
  placements: SignaturePlacementInput[];
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

type SignatureTemplateRow = {
  id: number;
  name: string;
  project_name: string | null;
  placements_json: string;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

const requiredRoles: SignaturePlacementRole[] = ["designer", "supervisor", "process"];

export class SignatureTemplateRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: {
    name: string;
    projectName?: string | null;
    placements: SignaturePlacementInput[];
    createdByUserId?: number | null;
  }): SignatureTemplate {
    const placements = normalizePlacements(input.placements);
    const result = this.db
      .prepare(
        `INSERT INTO signature_templates (name, project_name, placements_json, created_by_user_id)
         VALUES (@name, @projectName, @placementsJson, @createdByUserId)`
      )
      .run({
        name: normalizeName(input.name),
        projectName: normalizeProjectName(input.projectName),
        placementsJson: JSON.stringify(placements),
        createdByUserId: input.createdByUserId ?? null
      });

    return this.getById(Number(result.lastInsertRowid))!;
  }

  list(input: { projectName?: string | null } = {}): SignatureTemplate[] {
    if (!Object.prototype.hasOwnProperty.call(input, "projectName")) {
      const rows = this.db
        .prepare("SELECT * FROM signature_templates ORDER BY updated_at DESC, id DESC")
        .all() as SignatureTemplateRow[];
      return rows.map(mapSignatureTemplate);
    }

    const projectName = normalizeProjectName(input.projectName);
    const rows = this.db
      .prepare(
        `SELECT * FROM signature_templates
         WHERE project_name IS NULL OR project_name = @projectName
         ORDER BY CASE WHEN project_name IS NULL THEN 1 ELSE 0 END, updated_at DESC, id DESC`
      )
      .all({ projectName }) as SignatureTemplateRow[];
    return rows.map(mapSignatureTemplate);
  }

  getById(id: number): SignatureTemplate | null {
    const row = this.db.prepare("SELECT * FROM signature_templates WHERE id = ?").get(id) as SignatureTemplateRow | undefined;
    return row ? mapSignatureTemplate(row) : null;
  }

  update(id: number, input: { name: string; projectName?: string | null; placements: SignaturePlacementInput[] }): SignatureTemplate {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error("SIGNATURE_TEMPLATE_NOT_FOUND");
    }

    this.db
      .prepare(
        `UPDATE signature_templates
         SET name = @name,
             project_name = @projectName,
             placements_json = @placementsJson,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`
      )
      .run({
        id,
        name: normalizeName(input.name),
        projectName: normalizeProjectName(input.projectName),
        placementsJson: JSON.stringify(normalizePlacements(input.placements))
      });

    return this.getById(id)!;
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM signature_templates WHERE id = ?").run(id);
  }
}

function normalizeName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("SIGNATURE_TEMPLATE_NAME_REQUIRED");
  }
  return trimmed;
}

function normalizeProjectName(projectName?: string | null) {
  const trimmed = projectName?.trim();
  return trimmed ? trimmed : null;
}

function normalizePlacements(placements: SignaturePlacementInput[]) {
  if (placements.length !== requiredRoles.length) {
    throw new Error("SIGNATURE_TEMPLATE_REQUIRES_ALL_ROLES");
  }

  for (const placement of placements) {
    validatePlacement(placement);
  }

  const byRole = new Map(placements.map((placement) => [placement.role, placement]));
  if (!requiredRoles.every((role) => byRole.has(role)) || byRole.size !== requiredRoles.length) {
    throw new Error("SIGNATURE_TEMPLATE_REQUIRES_ALL_ROLES");
  }

  return requiredRoles.map((role) => byRole.get(role)!);
}

function validatePlacement(placement: SignaturePlacementInput) {
  if (!requiredRoles.includes(placement.role)) {
    throw new Error("INVALID_SIGNATURE_ROLE");
  }

  const valid =
    Number.isInteger(placement.pageNumber) &&
    placement.pageNumber >= 1 &&
    placement.xRatio >= 0 &&
    placement.xRatio <= 1 &&
    placement.yRatio >= 0 &&
    placement.yRatio <= 1 &&
    placement.widthRatio > 0 &&
    placement.widthRatio <= 1 &&
    placement.heightRatio > 0 &&
    placement.heightRatio <= 1 &&
    placement.xRatio + placement.widthRatio <= 1 &&
    placement.yRatio + placement.heightRatio <= 1;

  if (!valid) {
    throw new Error("INVALID_SIGNATURE_PLACEMENT");
  }
}

function mapSignatureTemplate(row: SignatureTemplateRow): SignatureTemplate {
  return {
    id: row.id,
    name: row.name,
    projectName: row.project_name,
    placements: normalizePlacements(JSON.parse(row.placements_json) as SignaturePlacementInput[]),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
