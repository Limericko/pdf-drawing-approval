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

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<CreateProjectResult>;
  addMember(input: AddProjectMemberInput): Promise<ProjectMember>;
  findByIdForMember(projectId: string, requesterUserId: string): Promise<Project | undefined>;
}
