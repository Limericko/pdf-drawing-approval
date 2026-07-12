import type { PlatformPool } from "../../database/pool.ts";
import type { PlatformMailTransport } from "../../mail/platformMailTransport.ts";
import { deriveInvitationToken, verifyInvitationToken } from "../../security/tokenHash.ts";
import type { VersionedKeyring } from "../../config/types.ts";
import { PostgresInvitationRepository } from "../../../modules/identity/repositories/postgres/PostgresInvitationRepository.ts";
import { JobHandlerError, type JobHandler } from "../jobRegistry.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createSendInvitationEmailHandler(options: {
  readonly pool: PlatformPool;
  readonly transport: PlatformMailTransport;
  readonly keyring: VersionedKeyring;
  readonly publicBaseUrl: string;
}): JobHandler {
  return async (job) => {
    const invitationId = ownPayload(job.payload);
    const invitation = await new PostgresInvitationRepository(options.pool).findActiveById(invitationId);
    if (!invitation) throw permanent("INVITATION_NOT_ACTIVE");
    let token: string;
    try {
      token = deriveInvitationToken(invitation.id, invitation.tokenKeyVersion, options.keyring);
      verifyInvitationToken(token, { invitationId: invitation.id, keyVersion: invitation.tokenKeyVersion,
        tokenHash: invitation.tokenHash }, options.keyring);
    } catch {
      throw permanent("INVITATION_TOKEN_INVALID");
    }
    const activationUrl = `${options.publicBaseUrl.replace(/\/+$/, "")}/#/accept-invitation?token=${encodeURIComponent(token)}`;
    try {
      await options.transport.sendInvitation({ invitationId, recipient: invitation.emailNormalized, activationUrl });
    } catch {
      throw new JobHandlerError("transient", "INVITATION_EMAIL_SEND_FAILED", "Invitation email delivery failed");
    }
  };
}

function ownPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw permanent("INVITATION_EMAIL_PAYLOAD_INVALID");
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || typeof payload.invitationId !== "string" || !UUID_V7.test(payload.invitationId)) {
    throw permanent("INVITATION_EMAIL_PAYLOAD_INVALID");
  }
  return payload.invitationId;
}

function permanent(code: string) { return new JobHandlerError("permanent", code, "Invitation email cannot be delivered"); }
