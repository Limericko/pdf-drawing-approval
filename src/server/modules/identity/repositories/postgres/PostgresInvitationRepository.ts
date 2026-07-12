import type { QueryResultRow } from "pg";
import { normalizeEmail } from "../../email.ts";
import { createIdentityId } from "../../ids.ts";
import type { Invitation, PlatformRole, ProjectMemberRole } from "../../models.ts";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import type { CreateInvitationInput, InvitationRepository } from "../invitationRepository.ts";

type InvitationRow = QueryResultRow & {
  id: string;
  token_hash: Buffer;
  token_key_version: string;
  email_normalized: string;
  platform_role: PlatformRole;
  project_id: string;
  project_role: ProjectMemberRole;
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  accepted_at: Date | null;
};

const INVITATION_COLUMNS = `id, token_hash, token_key_version, email_normalized, platform_role,
  project_id, project_role, invited_by_user_id, accepted_by_user_id, created_at, expires_at,
  revoked_at, accepted_at`;

function mapInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    tokenHash: Buffer.from(row.token_hash),
    tokenKeyVersion: row.token_key_version,
    emailNormalized: row.email_normalized,
    platformRole: row.platform_role,
    projectId: row.project_id,
    projectRole: row.project_role,
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    acceptedAt: row.accepted_at
  };
}

export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async create(input: CreateInvitationInput) {
    const result = await this.executor.query<InvitationRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       INSERT INTO platform.invitations
         (id, token_hash, token_key_version, email_normalized, platform_role, project_id,
          project_role, invited_by_user_id, created_at, expires_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, times.now, times.now + interval '24 hours'
       FROM times
       RETURNING ${INVITATION_COLUMNS}`,
      [
        input.id ?? createIdentityId(),
        input.tokenHash,
        input.tokenKeyVersion,
        normalizeEmail(input.email),
        input.platformRole,
        input.projectId,
        input.projectRole,
        input.invitedByUserId
      ]
    );
    return mapInvitation(result.rows[0]!);
  }

  async findById(id: string) {
    const result = await this.executor.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM platform.invitations WHERE id = $1`, [id]
    );
    return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
  }

  async findActiveById(id: string) {
    const result = await this.executor.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS}
       FROM platform.invitations
       WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
      [id]
    );
    return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
  }

  async revoke(id: string) {
    const result = await this.executor.query<InvitationRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       UPDATE platform.invitations invitation
       SET revoked_at = times.now
       FROM times
       WHERE invitation.id = $1
         AND invitation.accepted_at IS NULL
         AND invitation.revoked_at IS NULL
         AND invitation.expires_at > times.now
       RETURNING ${INVITATION_COLUMNS}`,
      [id]
    );
    return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
  }

  async consume(id: string, acceptedByUserId: string) {
    const result = await this.executor.query<InvitationRow>(
      `WITH times AS (SELECT clock_timestamp() AS now)
       UPDATE platform.invitations invitation
       SET accepted_at = times.now, accepted_by_user_id = $2
       FROM times
       WHERE invitation.id = $1
         AND invitation.accepted_at IS NULL
         AND invitation.revoked_at IS NULL
         AND invitation.expires_at > times.now
       RETURNING ${INVITATION_COLUMNS}`,
      [id, acceptedByUserId]
    );
    return result.rows[0] ? mapInvitation(result.rows[0]) : undefined;
  }
}
