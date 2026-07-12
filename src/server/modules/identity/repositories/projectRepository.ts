import type { Project, ProjectMember, ProjectMemberRole, ProjectMemberStatus, ProjectStatus } from "../models.ts";

export type CreateProjectInput = {
  readonly name: string;
  readonly status: ProjectStatus;
  readonly createdByUserId: string;
};

export type CreateProjectResult = {
  readonly project: Project;
  readonly creatorMembership: ProjectMember;
};

export type AddProjectMemberInput = {
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectMemberRole;
  readonly status: ProjectMemberStatus;
};

export type ProjectAccessRecord = {
  readonly project: Project;
  readonly membership: ProjectMember;
};

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<CreateProjectResult>;
  addMember(input: AddProjectMemberInput): Promise<ProjectMember>;
  listForMember(requesterUserId: string): Promise<readonly ProjectAccessRecord[]>;
  findAccessByIdForMember(projectId: string, requesterUserId: string): Promise<ProjectAccessRecord | undefined>;
  findByIdForMember(projectId: string, requesterUserId: string): Promise<Project | undefined>;
  lockActiveProjectForInvitation(projectId: string, inviterUserId: string): Promise<boolean>;
}
