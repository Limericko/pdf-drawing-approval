import type { DatabaseConnection } from "../db.ts";

export type SignaturePlacementRole = "designer" | "supervisor" | "process";

export type SignaturePlacementInput = {
  role: SignaturePlacementRole;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

export type SignaturePlacement = SignaturePlacementInput & {
  id: number;
  approvalId: number;
  createdAt: string;
  updatedAt: string;
};

type SignaturePlacementRow = {
  id: number;
  approval_id: number;
  role: SignaturePlacementRole;
  page_number: number;
  x_ratio: number;
  y_ratio: number;
  width_ratio: number;
  height_ratio: number;
  created_at: string;
  updated_at: string;
};

const requiredRoles: SignaturePlacementRole[] = ["designer", "supervisor", "process"];

export class SignaturePlacementRepository {
  constructor(private readonly db: DatabaseConnection) {}

  upsertMany(approvalId: number, placements: SignaturePlacementInput[]): SignaturePlacement[] {
    for (const placement of placements) {
      validatePlacement(placement);
    }

    const statement = this.db.prepare(
      `INSERT INTO signature_placements (
        approval_id, role, page_number, x_ratio, y_ratio, width_ratio, height_ratio
      ) VALUES (
        @approvalId, @role, @pageNumber, @xRatio, @yRatio, @widthRatio, @heightRatio
      )
      ON CONFLICT(approval_id, role) DO UPDATE SET
        page_number = excluded.page_number,
        x_ratio = excluded.x_ratio,
        y_ratio = excluded.y_ratio,
        width_ratio = excluded.width_ratio,
        height_ratio = excluded.height_ratio,
        updated_at = CURRENT_TIMESTAMP`
    );

    for (const placement of placements) {
      statement.run({ approvalId, ...placement });
    }

    return this.listForApproval(approvalId);
  }

  listForApproval(approvalId: number): SignaturePlacement[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM signature_placements
         WHERE approval_id = ?
         ORDER BY CASE role
           WHEN 'designer' THEN 1
           WHEN 'supervisor' THEN 2
           WHEN 'process' THEN 3
           ELSE 4
         END`
      )
      .all(approvalId) as SignaturePlacementRow[];
    return rows.map(mapSignaturePlacement);
  }

  hasRequiredPlacements(approvalId: number): boolean {
    const roles = new Set(this.listForApproval(approvalId).map((placement) => placement.role));
    return requiredRoles.every((role) => roles.has(role));
  }
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

function mapSignaturePlacement(row: SignaturePlacementRow): SignaturePlacement {
  return {
    id: row.id,
    approvalId: row.approval_id,
    role: row.role,
    pageNumber: row.page_number,
    xRatio: row.x_ratio,
    yRatio: row.y_ratio,
    widthRatio: row.width_ratio,
    heightRatio: row.height_ratio,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
