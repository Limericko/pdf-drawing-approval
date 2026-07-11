import type { Invitation, PlatformRole, ProjectMemberRole } from "../models.ts";

export type CreateInvitationInput = {
  readonly tokenHash: Buffer;
  readonly tokenKeyVersion: string;
  readonly email: string;
  readonly platformRole: PlatformRole;
  readonly projectId: string;
  readonly projectRole: ProjectMemberRole;
  readonly invitedByUserId: string;
};

export interface InvitationRepository {
  create(input: CreateInvitationInput): Promise<Invitation>;
  findActiveById(id: string): Promise<Invitation | undefined>;
  revoke(id: string): Promise<Invitation | undefined>;
  consume(id: string, acceptedByUserId: string): Promise<Invitation | undefined>;
}
