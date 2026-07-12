import type { QueryResultRow } from "pg";
import { createIdentityId } from "../../ids.ts";
import type { ProjectMember, ProjectMemberRole, ProjectMemberStatus, ProjectStatus } from "../../models.ts";
import type { QueryExecutor } from "../../../../platform/database/queryExecutor.ts";
import type {
  AddProjectMemberInput,
  CreateProjectInput,
  CreateProjectResult,
  ProjectAccessRecord,
  ProjectRepository
} from "../projectRepository.ts";

type ProjectMemberRow = QueryResultRow & {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectMemberRole;
  status: ProjectMemberStatus;
  created_at: Date;
  updated_at: Date;
};

type CreatedProjectRow = QueryResultRow & {
  project_id: string;
  project_name: string;
  project_status: ProjectStatus;
  project_created_at: Date;
  project_updated_at: Date;
  membership_id: string;
  membership_user_id: string;
  membership_role: ProjectMemberRole;
  membership_status: ProjectMemberStatus;
  membership_created_at: Date;
  membership_updated_at: Date;
};

type ProjectAccessRow = QueryResultRow & {
  project_id: string;
  project_name: string;
  project_status: ProjectStatus;
  project_created_at: Date;
  project_updated_at: Date;
  membership_id: string;
  membership_user_id: string;
  membership_role: ProjectMemberRole;
  membership_status: ProjectMemberStatus;
  membership_created_at: Date;
  membership_updated_at: Date;
};

function mapProjectMember(row: ProjectMemberRow): ProjectMember {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProjectAccess(row: ProjectAccessRow): ProjectAccessRecord {
  return {
    project: {
      id: row.project_id,
      name: row.project_name,
      status: row.project_status,
      createdAt: row.project_created_at,
      updatedAt: row.project_updated_at
    },
    membership: {
      id: row.membership_id,
      projectId: row.project_id,
      userId: row.membership_user_id,
      role: row.membership_role,
      status: row.membership_status,
      createdAt: row.membership_created_at,
      updatedAt: row.membership_updated_at
    }
  };
}

const PROJECT_ACCESS_SELECT = `SELECT p.id AS project_id,p.name AS project_name,p.status AS project_status,
  p.created_at AS project_created_at,p.updated_at AS project_updated_at,
  pm.id AS membership_id,pm.user_id AS membership_user_id,pm.role AS membership_role,
  pm.status AS membership_status,pm.created_at AS membership_created_at,pm.updated_at AS membership_updated_at
  FROM platform.projects p
  INNER JOIN platform.project_members pm ON pm.project_id=p.id AND pm.user_id=$1 AND pm.status='active'
  INNER JOIN platform.users u ON u.id=pm.user_id AND u.status='active'`;

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async create(input: CreateProjectInput): Promise<CreateProjectResult> {
    const projectId = createIdentityId();
    const membershipId = createIdentityId();
    const result = await this.executor.query<CreatedProjectRow>(
      `WITH inserted_project AS (
         INSERT INTO platform.projects (id, name, status)
         VALUES ($1, $2, $3)
         RETURNING id, name, status, created_at, updated_at
       ), inserted_membership AS (
         INSERT INTO platform.project_members (id, project_id, user_id, role, status)
         SELECT $4, id, $5, 'manager', 'active' FROM inserted_project
         RETURNING id, project_id, user_id, role, status, created_at, updated_at
       )
       SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
         p.created_at AS project_created_at, p.updated_at AS project_updated_at,
         m.id AS membership_id, m.user_id AS membership_user_id, m.role AS membership_role,
         m.status AS membership_status, m.created_at AS membership_created_at,
         m.updated_at AS membership_updated_at
       FROM inserted_project p CROSS JOIN inserted_membership m`,
      [projectId, input.name, input.status, membershipId, input.createdByUserId]
    );
    const row = result.rows[0]!;
    return {
      project: {
        id: row.project_id,
        name: row.project_name,
        status: row.project_status,
        createdAt: row.project_created_at,
        updatedAt: row.project_updated_at
      },
      creatorMembership: {
        id: row.membership_id,
        projectId: row.project_id,
        userId: row.membership_user_id,
        role: row.membership_role,
        status: row.membership_status,
        createdAt: row.membership_created_at,
        updatedAt: row.membership_updated_at
      }
    };
  }

  async addMember(input: AddProjectMemberInput) {
    const result = await this.executor.query<ProjectMemberRow>(
      `INSERT INTO platform.project_members (id, project_id, user_id, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, user_id, role, status, created_at, updated_at`,
      [createIdentityId(), input.projectId, input.userId, input.role, input.status]
    );
    return mapProjectMember(result.rows[0]!);
  }

  async listForMember(requesterUserId: string) {
    const result = await this.executor.query<ProjectAccessRow>(
      `${PROJECT_ACCESS_SELECT} ORDER BY p.name ASC, p.id ASC`, [requesterUserId]
    );
    return result.rows.map(mapProjectAccess);
  }

  async findAccessByIdForMember(projectId: string, requesterUserId: string) {
    const result = await this.executor.query<ProjectAccessRow>(
      `${PROJECT_ACCESS_SELECT} WHERE p.id=$2`, [requesterUserId, projectId]
    );
    return result.rows[0] ? mapProjectAccess(result.rows[0]) : undefined;
  }

  async findByIdForMember(projectId: string, requesterUserId: string) {
    return (await this.findAccessByIdForMember(projectId, requesterUserId))?.project;
  }

  async lockActiveProjectForInvitation(projectId: string, inviterUserId: string) {
    const result = await this.executor.query<{ id: string }>(
      `SELECT project.id
       FROM platform.projects project
       INNER JOIN platform.users inviter
         ON inviter.id = $2 AND inviter.platform_role = 'admin' AND inviter.status = 'active'
       INNER JOIN platform.project_members membership
         ON membership.project_id = project.id AND membership.user_id = inviter.id
           AND membership.role = 'manager' AND membership.status = 'active'
       WHERE project.id = $1 AND project.status = 'active'
       FOR NO KEY UPDATE OF project, inviter, membership`,
      [projectId, inviterUserId]
    );
    return result.rowCount === 1;
  }
}
