export type PlatformRole = "admin" | "member";
export type UserStatus = "active" | "disabled";
export type MfaStatus = "disabled" | "enabled";
export type ProjectStatus = "active" | "archived";
export type ProjectMemberRole = "manager" | "designer" | "supervisor" | "process" | "viewer";
export type ProjectMemberStatus = "active" | "disabled";

export type PlatformUser = {
  readonly id: string;
  readonly emailNormalized: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly platformRole: PlatformRole;
  readonly status: UserStatus;
  readonly mfaStatus: MfaStatus;
  readonly mfaEnabledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ProjectMember = {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectMemberRole;
  readonly status: ProjectMemberStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type Invitation = {
  readonly id: string;
  readonly tokenHash: Buffer;
  readonly tokenKeyVersion: string;
  readonly emailNormalized: string;
  readonly platformRole: PlatformRole;
  readonly projectId: string;
  readonly projectRole: ProjectMemberRole;
  readonly invitedByUserId: string;
  readonly acceptedByUserId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly acceptedAt: Date | null;
};
