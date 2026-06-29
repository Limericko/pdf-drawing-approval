import { describe, expect, it, vi } from "vitest";
import { buildTaskNotification, showTaskNotification } from "./notifications.ts";
import type { TraySummary } from "./types.ts";

function summary(ids: number[]): TraySummary {
  return {
    serverTime: "2026-06-18T00:00:00.000Z",
    user: { id: 2, username: "supervisor", displayName: "主管", role: "supervisor" },
    tasks: {
      pendingCount: ids.length,
      latestIds: ids,
      latest: ids.map((id) => ({
        id,
        projectName: "300A",
        partName: `支架${id}`,
        version: "a0A0",
        submittedAt: "2026-06-18T00:00:00.000Z",
        href: `#/approvals/${id}`
      }))
    },
    admin: null
  };
}

describe("buildTaskNotification", () => {
  it("creates a detail notification for one new approval task", () => {
    expect(buildTaskNotification(summary([12]), [12], "http://127.0.0.1:8080")).toEqual({
      id: 12,
      title: "有 1 张图纸待审核",
      body: "300A / 支架12-a0A0",
      targetUrl: "http://127.0.0.1:8080/#/approvals/12"
    });
  });

  it("creates a task-list notification for multiple new approval tasks", () => {
    expect(buildTaskNotification(summary([12, 13, 14]), [12, 13, 14], "http://127.0.0.1:8080")).toEqual({
      id: 12,
      title: "有 3 张图纸待审核",
      body: "300A / 支架12-a0A0；300A / 支架13-a0A0；300A / 支架14-a0A0",
      targetUrl: "http://127.0.0.1:8080/#/"
    });
  });
});

describe("showTaskNotification", () => {
  it("sends notifications with an open action payload", async () => {
    const bridge = {
      isPermissionGranted: vi.fn().mockResolvedValue(true),
      requestPermission: vi.fn(),
      sendNotification: vi.fn()
    };

    await expect(
      showTaskNotification(bridge, {
        id: 12,
        title: "有 1 张图纸待审核",
        body: "300A / 支架12-a0A0",
        targetUrl: "http://127.0.0.1:8080/#/approvals/12"
      })
    ).resolves.toBe(true);

    expect(bridge.sendNotification).toHaveBeenCalledWith({
      id: 12,
      title: "有 1 张图纸待审核",
      body: "300A / 支架12-a0A0",
      actionTypeId: "open-approval",
      extra: { targetUrl: "http://127.0.0.1:8080/#/approvals/12" },
      autoCancel: true
    });
  });
});
