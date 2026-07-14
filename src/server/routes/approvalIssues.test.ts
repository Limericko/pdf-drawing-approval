import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalIssueRepository } from "../repositories/approvalIssues.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { OperationLogRepository } from "../repositories/operationLogs.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { UserRepository } from "../repositories/users.ts";
import { createServer } from "../server.ts";

async function appContext() {
  const db = createDatabase(":memory:");
  const approvals = new ApprovalRepository(db);
  const approvalIssues = new ApprovalIssueRepository(db);
  const operationLogs = new OperationLogRepository(db);
  const users = new UserRepository(db);
  const settings = new SettingsRepository(db);
  const supervisor = users.create({ username: "issue_supervisor", password: "123456", role: "supervisor", displayName: "主管审阅" });
  const process = users.create({ username: "issue_process", password: "123456", role: "process", displayName: "工艺审阅" });
  const designer = users.create({ username: "issue_designer", password: "123456", role: "designer", displayName: "设计人员" });
  const admin = users.create({ username: "issue_admin", password: "admin123", role: "admin", displayName: "系统管理员" });
  const approval = approvals.create({
    projectName: "精密传动项目",
    partName: "减速器壳体",
    version: "A03",
    minorVersion: "A03",
    majorVersion: "A0",
    originalFilePath: "original.pdf",
    currentFilePath: "current.pdf"
  });
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "issue-secret" },
    { db, approvals, approvalIssues, operationLogs, users, settings }
  );
  const login = async (username: string, password: string) =>
    (await request(app).post("/api/auth/login").send({ username, password })).body.token as string;

  return {
    app,
    approval,
    approvals,
    approvalIssues,
    operationLogs,
    supervisor,
    process,
    designer,
    admin,
    supervisorToken: await login("issue_supervisor", "123456"),
    processToken: await login("issue_process", "123456"),
    designerToken: await login("issue_designer", "123456"),
    adminToken: await login("issue_admin", "admin123")
  };
}

function issueInput(assigneeUserId: number, severity: "low" | "medium" | "high" | "critical" = "high") {
  return {
    assigneeUserId,
    title: "轴承孔公差未标注",
    description: "请补充 H7 公差与基准关系。",
    severity,
    dueAt: "2026-07-18T09:00:00.000Z"
  };
}

function authorize(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("approval issue routes", () => {
  it("lets reviewers create and every authenticated role list formal issues", async () => {
    const context = await appContext();
    const created = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/issues`)
      .set(authorize(context.supervisorToken))
      .send(issueInput(context.designer.id))
      .expect(201);

    expect(created.body).toEqual(expect.objectContaining({
      creatorDisplayName: "主管审阅",
      assigneeDisplayName: "设计人员",
      severity: "high",
      status: "open"
    }));

    const assignees = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/issues/assignees`)
      .set(authorize(context.supervisorToken))
      .expect(200);
    expect(assignees.body).toEqual([expect.objectContaining({ id: context.designer.id, role: "designer" })]);

    const updated = await request(context.app)
      .patch(`/api/approvals/${context.approval.id}/issues/${created.body.id}`)
      .set(authorize(context.supervisorToken))
      .send({ title: "轴承孔公差与基准未标注", severity: "critical", expectedVersion: 1 })
      .expect(200);
    expect(updated.body).toEqual(expect.objectContaining({ title: "轴承孔公差与基准未标注", severity: "critical", version: 2 }));

    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/issues`)
      .set(authorize(context.designerToken))
      .send(issueInput(context.designer.id, "low"))
      .expect(403);

    const listed = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/issues`)
      .set(authorize(context.designerToken))
      .expect(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: created.body.id, eventCount: 1, version: 2 })]);
    expect(context.operationLogs.listForTarget("approval", context.approval.id).map((log) => log.action))
      .toContain("approval.issue_created");
  });

  it("enforces assignee handling and independent reviewer closure", async () => {
    const context = await appContext();
    const created = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/issues`)
      .set(authorize(context.supervisorToken))
      .send(issueInput(context.designer.id, "medium"))
      .expect(201);
    const transitionUrl = `/api/approvals/${context.approval.id}/issues/${created.body.id}/transitions`;

    await request(context.app).post(transitionUrl).set(authorize(context.processToken)).send({ action: "start" }).expect(403);
    await request(context.app).post(transitionUrl).set(authorize(context.designerToken)).send({ action: "start" }).expect(200);
    await request(context.app).post(transitionUrl).set(authorize(context.designerToken))
      .send({ action: "submit_review", note: "已统一修改为 C1.5。" }).expect(200);
    await request(context.app).post(transitionUrl).set(authorize(context.designerToken))
      .send({ action: "close", note: "自己复核" }).expect(403);

    await request(context.app).post(transitionUrl).set(authorize(context.supervisorToken))
      .send({ action: "return", note: "请同步更新技术要求。" }).expect(200);
    await request(context.app).post(transitionUrl).set(authorize(context.designerToken))
      .send({ action: "submit_review", note: "技术要求已同步。" }).expect(200);
    const closed = await request(context.app).post(transitionUrl).set(authorize(context.processToken))
      .send({ action: "close", note: "工艺复核通过。" }).expect(200);

    expect(closed.body).toEqual(expect.objectContaining({ status: "closed", closedByUserId: context.process.id }));
    const events = await request(context.app)
      .get(`/api/approvals/${context.approval.id}/issues/${created.body.id}/events`)
      .set(authorize(context.supervisorToken))
      .expect(200);
    expect(events.body.map((event: { action: string }) => event.action)).toEqual([
      "created", "started", "submitted_review", "returned", "submitted_review", "closed"
    ]);
  });

  it("requires an audited reason for administrator force-close", async () => {
    const context = await appContext();
    const issue = context.approvalIssues.create({
      approvalId: context.approval.id,
      creatorUserId: context.supervisor.id,
      assigneeUserId: context.designer.id,
      title: "材料牌号错误",
      description: "标题栏与技术要求不一致。",
      severity: "critical"
    });
    const url = `/api/approvals/${context.approval.id}/issues/${issue.id}/transitions`;

    await request(context.app).post(url).set(authorize(context.supervisorToken))
      .send({ action: "force_close", note: "评审确认" }).expect(403);
    await request(context.app).post(url).set(authorize(context.adminToken))
      .send({ action: "force_close", note: "" }).expect(400);
    const closed = await request(context.app).post(url).set(authorize(context.adminToken))
      .send({ action: "force_close", note: "线下评审已确认，管理员强制关闭。" }).expect(200);

    expect(closed.body).toEqual(expect.objectContaining({
      status: "closed",
      forcedCloseReason: "线下评审已确认，管理员强制关闭。"
    }));
  });

  it("blocks approval while high severity issues remain open", async () => {
    const context = await appContext();
    const issue = context.approvalIssues.create({
      approvalId: context.approval.id,
      creatorUserId: context.supervisor.id,
      assigneeUserId: context.designer.id,
      title: "关键尺寸缺失",
      description: "缺少尺寸导致无法加工。",
      severity: "high"
    });

    const blocked = await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set(authorize(context.supervisorToken))
      .send({ role: "supervisor", decision: "approved", comment: "同意" })
      .expect(409);
    expect(blocked.body).toEqual({ error: "OPEN_HIGH_SEVERITY_ISSUES", blockingIssueCount: 1 });
    expect(context.approvals.getById(context.approval.id)?.supervisorStatus).toBe("pending");

    context.approvalIssues.transition(issue.id, {
      action: "force_close",
      actorUserId: context.admin.id,
      note: "管理员确认已有线下签字记录。"
    });
    await request(context.app)
      .post(`/api/approvals/${context.approval.id}/review`)
      .set(authorize(context.supervisorToken))
      .send({ role: "supervisor", decision: "approved", comment: "同意" })
      .expect(200);
    expect(context.approvals.getById(context.approval.id)?.supervisorStatus).toBe("approved");
  });

  it("deduplicates retried API creates and reports stale version conflicts", async () => {
    const context = await appContext();
    const body = { ...issueInput(context.designer.id), clientRequestId: "route-retry-001" };
    const first = await request(context.app).post(`/api/approvals/${context.approval.id}/issues`)
      .set(authorize(context.supervisorToken)).send(body).expect(201);
    const retried = await request(context.app).post(`/api/approvals/${context.approval.id}/issues`)
      .set(authorize(context.supervisorToken)).send(body).expect(200);
    expect(retried.body.id).toBe(first.body.id);

    const url = `/api/approvals/${context.approval.id}/issues/${first.body.id}/transitions`;
    const started = await request(context.app).post(url).set(authorize(context.designerToken))
      .send({ action: "start", expectedVersion: 1 }).expect(200);
    expect(started.body.version).toBe(2);
    await request(context.app).post(url).set(authorize(context.designerToken))
      .send({ action: "submit_review", note: "已修改。", expectedVersion: 1 })
      .expect(409, { error: "ISSUE_VERSION_CONFLICT" });
  });
});
