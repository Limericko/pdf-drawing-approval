import type { DatabaseConnection } from "../db.ts";
import type { UserRole } from "./users.ts";

export type SignatureAssetKind = "uploaded_png" | "drawn_png";

export type SignatureAsset = {
  id: number;
  userId: number;
  kind: SignatureAssetKind;
  filePath: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserSignatureStatus = {
  userId: number;
  username: string;
  displayName: string;
  role: UserRole;
  hasSignature: boolean;
  signatureId: number | null;
  signatureUpdatedAt: string | null;
};

type SignatureAssetRow = {
  id: number;
  user_id: number;
  kind: SignatureAssetKind;
  file_path: string;
  active: number;
  created_at: string;
  updated_at: string;
};

type UserSignatureStatusRow = {
  user_id: number;
  username: string;
  display_name: string;
  role: UserRole;
  signature_id: number | null;
  signature_updated_at: string | null;
};

export class SignatureAssetRepository {
  constructor(private readonly db: DatabaseConnection) {}

  createForUser(input: { userId: number; kind: SignatureAssetKind; filePath: string }): SignatureAsset {
    const result = this.db
      .prepare(
        `INSERT INTO signature_assets (user_id, kind, file_path)
         VALUES (@userId, @kind, @filePath)`
      )
      .run(input);
    return this.getById(Number(result.lastInsertRowid))!;
  }

  replaceActiveForUser(input: { userId: number; kind: SignatureAssetKind; filePath: string }): SignatureAsset {
    this.db.prepare("UPDATE signature_assets SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND active = 1").run(input.userId);
    return this.createForUser(input);
  }

  getById(id: number): SignatureAsset | null {
    const row = this.db.prepare("SELECT * FROM signature_assets WHERE id = ?").get(id) as SignatureAssetRow | undefined;
    return row ? mapSignatureAsset(row) : null;
  }

  getActiveForUser(userId: number): SignatureAsset | null {
    const row = this.db
      .prepare("SELECT * FROM signature_assets WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1")
      .get(userId) as SignatureAssetRow | undefined;
    return row ? mapSignatureAsset(row) : null;
  }

  listUserSignatureStatus(): UserSignatureStatus[] {
    const rows = this.db
      .prepare(
        `SELECT
          users.id AS user_id,
          users.username,
          users.display_name,
          users.role,
          signature_assets.id AS signature_id,
          signature_assets.updated_at AS signature_updated_at
        FROM users
        LEFT JOIN signature_assets ON signature_assets.user_id = users.id AND signature_assets.active = 1
        ORDER BY users.active DESC, users.role, users.username`
      )
      .all() as UserSignatureStatusRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      hasSignature: row.signature_id !== null,
      signatureId: row.signature_id,
      signatureUpdatedAt: row.signature_updated_at
    }));
  }
}

function mapSignatureAsset(row: SignatureAssetRow): SignatureAsset {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    filePath: row.file_path,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
