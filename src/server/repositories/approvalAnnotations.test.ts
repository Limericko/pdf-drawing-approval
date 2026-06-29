import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "./approvals.ts";
import { ApprovalAnnotationRepository } from "./approvalAnnotations.ts";
import { UserRepository } from "./users.ts";

function createContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const approvals = new ApprovalRepository(db);
  const annotations = new ApprovalAnnotationRepository(db);
  const reviewer = users.create({ username: "supervisor", password: "123456", role: "supervisor", displayName: "主管" });
  const designer = users.create({ username: "designer", password: "123456", role: "designer", displayName: "设计师" });
  const approval = approvals.create({
    projectName: "项目A",
    partName: "批注件",
    version: "a0A0",
    minorVersion: "a0",
    majorVersion: "A0",
    originalFilePath: "01-待提交/项目A/批注件-a0A0.pdf",
    currentFilePath: "02-审批中/项目A/批注件-a0A0.pdf"
  });

  return { annotations, approval, reviewer, designer };
}

describe("ApprovalAnnotationRepository", () => {
  it("creates and lists positioned drawing annotations with author metadata", () => {
    const { annotations, approval, reviewer } = createContext();

    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "rect",
      message: "标题栏材料需要补充",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.2,
      widthRatio: 0.3,
      heightRatio: 0.12,
      color: "red"
    });
    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "arrow",
      message: "孔距方向看这里",
      pageNumber: 2,
      xRatio: 0.35,
      yRatio: 0.4,
      endXRatio: 0.55,
      endYRatio: 0.46,
      color: "amber"
    });
    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "circle",
      message: "此处倒角确认",
      pageNumber: 1,
      xRatio: 0.5,
      yRatio: 0.5,
      widthRatio: 0.08,
      heightRatio: 0.08,
      color: "blue"
    });
    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "pin",
      message: "基准点说明",
      pageNumber: 1,
      xRatio: 0.7,
      yRatio: 0.22,
      color: "green"
    });
    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "text",
      message: "局部说明",
      pageNumber: 1,
      xRatio: 0.2,
      yRatio: 0.72,
      widthRatio: 0.18,
      heightRatio: 0.08,
      color: "red"
    });
    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "cloud",
      message: "这一片按修订云处理",
      pageNumber: 1,
      xRatio: 0.26,
      yRatio: 0.18,
      widthRatio: 0.2,
      heightRatio: 0.14,
      color: "amber"
    });
    annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "ink",
      message: "手画范围",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.15,
      pointsJson: JSON.stringify([
        { xRatio: 0.1, yRatio: 0.15 },
        { xRatio: 0.18, yRatio: 0.19 },
        { xRatio: 0.22, yRatio: 0.24 }
      ]),
      styleJson: JSON.stringify({ strokeWidth: 2 }),
      color: "green"
    });

    const result = annotations.listForApproval(approval.id);

    expect(result.map((item) => item.kind)).toEqual(["rect", "arrow", "circle", "pin", "text", "cloud", "ink"]);
    expect(result[0]).toEqual(
      expect.objectContaining({
        authorDisplayName: "主管",
        authorRole: "supervisor",
        message: "标题栏材料需要补充",
        resolved: false,
        widthRatio: 0.3,
        heightRatio: 0.12
      })
    );
    expect(result[1]).toEqual(expect.objectContaining({ endXRatio: 0.55, endYRatio: 0.46 }));
    expect(result[5]).toEqual(expect.objectContaining({ kind: "cloud", widthRatio: 0.2, heightRatio: 0.14 }));
    expect(result[6]).toEqual(
      expect.objectContaining({
        kind: "ink",
        pointsJson: JSON.stringify([
          { xRatio: 0.1, yRatio: 0.15 },
          { xRatio: 0.18, yRatio: 0.19 },
          { xRatio: 0.22, yRatio: 0.24 }
        ]),
        styleJson: JSON.stringify({ strokeWidth: 2 })
      })
    );
  });

  it("updates, resolves, counts open annotations, and deletes them for an approval", () => {
    const { annotations, approval, reviewer, designer } = createContext();
    const annotation = annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "rect",
      message: "原始说明",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.2,
      widthRatio: 0.3,
      heightRatio: 0.12,
      color: "red"
    });

    const updated = annotations.update(approval.id, annotation.id, {
      message: "更新后的说明",
      pageNumber: 2,
      xRatio: 0.2,
      yRatio: 0.3,
      widthRatio: 0.22,
      heightRatio: 0.1,
      color: "blue"
    });
    const resolved = annotations.resolve(approval.id, annotation.id, designer.id);

    expect(updated).toEqual(expect.objectContaining({ message: "更新后的说明", pageNumber: 2, color: "blue" }));
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedByUserId).toBe(designer.id);
    expect(resolved.resolvedAt).toBeTruthy();
    expect(annotations.countOpenForApproval(approval.id)).toBe(0);

    annotations.deleteForApproval(approval.id);

    expect(annotations.listForApproval(approval.id)).toEqual([]);
  });

  it("stores custom annotation colors in style metadata", () => {
    const { annotations, approval, reviewer } = createContext();

    const created = annotations.create({
      approvalId: approval.id,
      authorUserId: reviewer.id,
      kind: "rect",
      message: "自定义颜色",
      pageNumber: 1,
      xRatio: 0.1,
      yRatio: 0.2,
      widthRatio: 0.3,
      heightRatio: 0.12,
      color: "custom",
      styleJson: JSON.stringify({ strokeColor: "#7c3aed" })
    });

    expect(created).toEqual(expect.objectContaining({ color: "custom", styleJson: JSON.stringify({ strokeColor: "#7c3aed" }) }));
    expect(() =>
      annotations.create({
        approvalId: approval.id,
        authorUserId: reviewer.id,
        kind: "pin",
        message: "错误颜色",
        pageNumber: 1,
        xRatio: 0.2,
        yRatio: 0.2,
        color: "custom",
        styleJson: JSON.stringify({ strokeColor: "purple" })
      })
    ).toThrow("INVALID_ANNOTATION_COLOR");
  });

  it("rejects invalid annotation geometry", () => {
    const { annotations, approval, reviewer } = createContext();

    expect(() =>
      annotations.create({
        approvalId: approval.id,
        authorUserId: reviewer.id,
        kind: "rect",
        message: "缺少高度",
        pageNumber: 1,
        xRatio: 0.1,
        yRatio: 0.2,
        widthRatio: 0.3,
        color: "red"
      })
    ).toThrow("INVALID_ANNOTATION_GEOMETRY");

    expect(() =>
      annotations.create({
        approvalId: approval.id,
        authorUserId: reviewer.id,
        kind: "arrow",
        message: "缺少终点",
        pageNumber: 1,
        xRatio: 0.1,
        yRatio: 0.2,
        color: "red"
      })
    ).toThrow("INVALID_ANNOTATION_GEOMETRY");

    expect(() =>
      annotations.create({
        approvalId: approval.id,
        authorUserId: reviewer.id,
        kind: "pin",
        message: "越界",
        pageNumber: 0,
        xRatio: 1.2,
        yRatio: 0.2,
        color: "red"
      })
    ).toThrow("INVALID_ANNOTATION_GEOMETRY");

    expect(() =>
      annotations.create({
        approvalId: approval.id,
        authorUserId: reviewer.id,
        kind: "ink",
        message: "空画笔",
        pageNumber: 1,
        xRatio: 0.1,
        yRatio: 0.2,
        pointsJson: JSON.stringify([{ xRatio: 0.1, yRatio: 0.2 }]),
        color: "red"
      })
    ).toThrow("INVALID_ANNOTATION_GEOMETRY");

    expect(() =>
      annotations.create({
        approvalId: approval.id,
        authorUserId: reviewer.id,
        kind: "ink",
        message: "越界画笔",
        pageNumber: 1,
        xRatio: 0.1,
        yRatio: 0.2,
        pointsJson: JSON.stringify([
          { xRatio: 0.1, yRatio: 0.2 },
          { xRatio: 1.2, yRatio: 0.3 }
        ]),
        color: "red"
      })
    ).toThrow("INVALID_ANNOTATION_GEOMETRY");
  });
});
