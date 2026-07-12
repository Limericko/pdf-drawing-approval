import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import type { ProjectMemberRole, ProjectStatus, UserStatus } from "../../models.ts";
import type { InvitationRepository } from "../invitationRepository.ts";
import type { ProjectRepository } from "../projectRepository.ts";
import type { CreateUserInput, UserRepository } from "../userRepository.ts";

export type IdentityRepositories = {
  readonly users: UserRepository;
  readonly invitations: InvitationRepository;
  readonly projects: ProjectRepository;
};

export type IdentityRepositoryFactory = (executor: QueryExecutor) => IdentityRepositories;

export type IdentityRepositoryContractContext = {
  readonly primary: QueryExecutor;
  readonly concurrentA: QueryExecutor;
  readonly concurrentB: QueryExecutor;
  readonly migration: QueryExecutor;
};

type ContractOptions = {
  readonly createRepositories: IdentityRepositoryFactory;
  readonly getContext: () => IdentityRepositoryContractContext;
};

let sequence = 0;

function uniqueEmail(label: string) {
  sequence += 1;
  return `${label}-${sequence}@example.test`;
}

function expectUuidV7(value: string) {
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

export function identityRepositoryContract(options: ContractOptions) {
  const repositories = () => options.createRepositories(options.getContext().primary);

  async function createUser(
    overrides: Partial<CreateUserInput> = {}
  ) {
    return repositories().users.create({
      email: uniqueEmail("user"),
      displayName: "Contract User",
      passwordHash: "$argon2id$v=19$contract",
      platformRole: "member",
      status: "active",
      ...overrides
    });
  }

  async function createProject(createdByUserId: string, status: ProjectStatus = "active") {
    return repositories().projects.create({
      name: `Contract Project ${sequence + 1}`,
      status,
      createdByUserId
    });
  }

  async function createInvitation(projectId: string, invitedByUserId: string, email = uniqueEmail("invitee")) {
    return repositories().invitations.create({
      tokenHash: randomBytes(32),
      tokenKeyVersion: "v1",
      email,
      platformRole: "member",
      projectId,
      projectRole: "viewer",
      invitedByUserId
    });
  }

  describe("identity repository contract", () => {
    it("normalizes Unicode email once for create and lookup and relies on the database uniqueness constraint", async () => {
      const first = await createUser({ email: "  USE\u0301R@Example.COM  " });

      expect(first.emailNormalized).toBe("usér@example.com");
      await expect(repositories().users.findByEmail("  USÉR@example.com ")).resolves.toMatchObject({ id: first.id });
      await expect(createUser({ email: "USÉR@EXAMPLE.COM" })).rejects.toMatchObject({ code: "23505" });
    });

    it("generates RFC-compatible UUIDv7 identifiers in the application for every identity aggregate", async () => {
      const creator = await createUser();
      const { project, creatorMembership } = await createProject(creator.id);
      const invitation = await createInvitation(project.id, creator.id);

      for (const id of [creator.id, project.id, creatorMembership.id, invitation.id]) expectUuidV7(id);
    });

    it("maps user timestamps and lets PostgreSQL reject invalid user states", async () => {
      const disabled = await createUser({ status: "disabled" });
      expect(disabled).toMatchObject({ status: "disabled", mfaStatus: "disabled" });
      expect(disabled.createdAt).toBeInstanceOf(Date);
      expect(disabled.updatedAt).toBeInstanceOf(Date);

      await expect(createUser({ status: "pending" as UserStatus })).rejects.toMatchObject({ code: "23514" });
    });

    it("creates a confirmed MFA user in one insert without changing the ordinary disabled default", async () => {
      const mfaEnabledAt = new Date(Date.now() + 1_000);
      const enabled = await createUser({ mfaEnabledAt });

      expect(enabled).toMatchObject({ mfaStatus: "enabled", mfaEnabledAt });
      expect(enabled.createdAt).toEqual(mfaEnabledAt);
      expect(enabled.updatedAt).toEqual(mfaEnabledAt);
      await expect(createUser()).resolves.toMatchObject({ mfaStatus: "disabled", mfaEnabledAt: null });
    });

    it("atomically creates a project with its creator as an active manager and requires active membership for reads", async () => {
      const creator = await createUser({ platformRole: "admin" });
      const unrelatedAdmin = await createUser({ platformRole: "admin" });
      const { project, creatorMembership } = await createProject(creator.id);

      expect(creatorMembership).toMatchObject({
        projectId: project.id,
        userId: creator.id,
        role: "manager",
        status: "active"
      });
      await expect(repositories().projects.findByIdForMember(project.id, creator.id)).resolves.toEqual(project);
      await expect(repositories().projects.findByIdForMember(project.id, unrelatedAdmin.id)).resolves.toBeUndefined();

      await options.getContext().migration.query(
        "UPDATE platform.project_members SET status = 'disabled', updated_at = clock_timestamp() WHERE id = $1",
        [creatorMembership.id]
      );
      await expect(repositories().projects.findByIdForMember(project.id, creator.id)).resolves.toBeUndefined();
    });

    it("authorizes invitation creation only for an active admin with an active manager membership on an active project", async () => {
      const authorized = await createUser({ platformRole: "admin" });
      const { project } = await createProject(authorized.id);
      await expect(repositories().projects.lockActiveProjectForInvitation(project.id, authorized.id)).resolves.toBe(true);

      const adminViewer = await createUser({ platformRole: "admin" });
      await repositories().projects.addMember({ projectId: project.id, userId: adminViewer.id, role: "viewer", status: "active" });
      await expect(repositories().projects.lockActiveProjectForInvitation(project.id, adminViewer.id)).resolves.toBe(false);

      const memberManager = await createUser({ platformRole: "member" });
      const memberProject = await createProject(memberManager.id);
      await expect(repositories().projects.lockActiveProjectForInvitation(memberProject.project.id, memberManager.id)).resolves.toBe(false);

      const disabledAdmin = await createUser({ platformRole: "admin", status: "disabled" });
      const disabledProject = await createProject(disabledAdmin.id);
      await expect(repositories().projects.lockActiveProjectForInvitation(disabledProject.project.id, disabledAdmin.id)).resolves.toBe(false);

      const inactiveAdmin = await createUser({ platformRole: "admin" });
      const inactiveProject = await createProject(inactiveAdmin.id);
      await options.getContext().migration.query(
        "UPDATE platform.project_members SET status='disabled',updated_at=clock_timestamp() WHERE id=$1",
        [inactiveProject.creatorMembership.id]
      );
      await expect(repositories().projects.lockActiveProjectForInvitation(inactiveProject.project.id, inactiveAdmin.id)).resolves.toBe(false);

      const archivedAdmin = await createUser({ platformRole: "admin" });
      const archivedProject = await createProject(archivedAdmin.id, "archived");
      await expect(repositories().projects.lockActiveProjectForInvitation(archivedProject.project.id, archivedAdmin.id)).resolves.toBe(false);
    });

    it("rolls back project creation when the creator membership cannot be inserted", async () => {
      const missingUserId = "01890f1e-9b4a-7cc2-8f00-ffffffffffff";
      const name = `Atomic rollback ${sequence + 1}`;

      await expect(
        repositories().projects.create({ name, status: "active", createdByUserId: missingUserId })
      ).rejects.toMatchObject({ code: "23503" });
      const rows = await options.getContext().migration.query(
        "SELECT id FROM platform.projects WHERE name = $1",
        [name]
      );
      expect(rows.rowCount).toBe(0);
    });

    it("lets PostgreSQL reject invalid project states", async () => {
      const creator = await createUser();
      await expect(createProject(creator.id, "deleted" as ProjectStatus)).rejects.toMatchObject({ code: "23514" });
    });

    it("enforces project-member uniqueness and foreign keys", async () => {
      const creator = await createUser();
      const member = await createUser();
      const { project } = await createProject(creator.id);
      const add = (projectId: string, userId: string, role: ProjectMemberRole = "designer") =>
        repositories().projects.addMember({ projectId, userId, role, status: "active" });

      await expect(add(project.id, member.id)).resolves.toMatchObject({ projectId: project.id, userId: member.id });
      await expect(add(project.id, member.id)).rejects.toMatchObject({ code: "23505" });
      await expect(add("01890f1e-9b4a-7cc2-8f00-eeeeeeeeeeee", member.id)).rejects.toMatchObject({ code: "23503" });
      await expect(add(project.id, "01890f1e-9b4a-7cc2-8f00-dddddddddddd")).rejects.toMatchObject({ code: "23503" });
    });

    it("creates invitations from one database clock instant with an exact 24-hour lifetime", async () => {
      const creator = await createUser();
      const { project } = await createProject(creator.id);
      const invitation = await createInvitation(project.id, creator.id);

      expect(invitation.expiresAt.getTime() - invitation.createdAt.getTime()).toBe(24 * 60 * 60 * 1_000);
      expect(invitation.tokenHash).toBeInstanceOf(Buffer);
      expect(invitation.tokenHash).toHaveLength(32);
      expect(invitation).toMatchObject({ tokenKeyVersion: "v1", acceptedAt: null, revokedAt: null });
    });

    it("returns the active invitation record needed for token verification and hides it after revocation", async () => {
      const creator = await createUser();
      const { project } = await createProject(creator.id);
      const invitation = await createInvitation(project.id, creator.id);

      await expect(repositories().invitations.findActiveById(invitation.id)).resolves.toEqual(invitation);
      await repositories().invitations.revoke(invitation.id);
      await expect(repositories().invitations.findActiveById(invitation.id)).resolves.toBeUndefined();
    });

    it("revokes every active invitation for one project and normalized email without touching another project", async () => {
      const inviter = await createUser();
      const firstProject = await createProject(inviter.id);
      const secondProject = await createProject(inviter.id);
      const email = uniqueEmail("reinvite");
      const first = await createInvitation(firstProject.project.id, inviter.id, email);
      const second = await createInvitation(firstProject.project.id, inviter.id, email.toUpperCase());
      const other = await createInvitation(secondProject.project.id, inviter.id, email);

      await expect(repositories().invitations.revokeActiveByProjectEmail(firstProject.project.id, ` ${email.toUpperCase()} `))
        .resolves.toBe(2);
      await expect(repositories().invitations.findActiveById(first.id)).resolves.toBeUndefined();
      await expect(repositories().invitations.findActiveById(second.id)).resolves.toBeUndefined();
      await expect(repositories().invitations.findActiveById(other.id)).resolves.toEqual(other);
    });

    it("revokes an active invitation once and fails closed when consumption is attempted", async () => {
      const inviter = await createUser();
      const acceptor = await createUser();
      const { project } = await createProject(inviter.id);
      const invitation = await createInvitation(project.id, inviter.id);

      const revoked = await repositories().invitations.revoke(invitation.id);
      expect(revoked?.revokedAt).toBeInstanceOf(Date);
      await expect(repositories().invitations.revoke(invitation.id)).resolves.toBeUndefined();
      await expect(repositories().invitations.consume(invitation.id, acceptor.id)).resolves.toBeUndefined();
    });

    it("consumes an invitation atomically once and returns undefined on repeated consumption", async () => {
      const inviter = await createUser();
      const acceptor = await createUser();
      const { project } = await createProject(inviter.id);
      const invitation = await createInvitation(project.id, inviter.id);

      const accepted = await repositories().invitations.consume(invitation.id, acceptor.id);
      expect(accepted).toMatchObject({ id: invitation.id, acceptedByUserId: acceptor.id });
      expect(accepted?.acceptedAt).toBeInstanceOf(Date);
      await expect(repositories().invitations.consume(invitation.id, acceptor.id)).resolves.toBeUndefined();
      await expect(repositories().invitations.revoke(invitation.id)).resolves.toBeUndefined();
    });

    it("does not consume an expired invitation", async () => {
      const inviter = await createUser();
      const acceptor = await createUser();
      const { project } = await createProject(inviter.id);
      const invitation = await createInvitation(project.id, inviter.id);
      await options.getContext().migration.query(
        `UPDATE platform.invitations
         SET created_at = clock_timestamp() - interval '48 hours',
             expires_at = clock_timestamp() - interval '24 hours'
         WHERE id = $1`,
        [invitation.id]
      );

      await expect(repositories().invitations.consume(invitation.id, acceptor.id)).resolves.toBeUndefined();
      await expect(repositories().invitations.revoke(invitation.id)).resolves.toBeUndefined();
    });

    it("allows exactly one winner when independent connections consume the same invitation concurrently", async () => {
      const inviter = await createUser();
      const acceptorA = await createUser();
      const acceptorB = await createUser();
      const { project } = await createProject(inviter.id);
      const invitation = await createInvitation(project.id, inviter.id);
      const context = options.getContext();
      const repoA = options.createRepositories(context.concurrentA).invitations;
      const repoB = options.createRepositories(context.concurrentB).invitations;

      const results = await Promise.all([
        repoA.consume(invitation.id, acceptorA.id),
        repoB.consume(invitation.id, acceptorB.id)
      ]);

      expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      expect([acceptorA.id, acceptorB.id]).toContain(results.find(Boolean)?.acceptedByUserId);
    });
  });
}
