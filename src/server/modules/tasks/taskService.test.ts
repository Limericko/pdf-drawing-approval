import { describe, expect, it } from "vitest";
import { compareTasks } from "./taskService.ts";
import type { TaskResponse } from "../../../shared/contracts/business.ts";

const base = {
  projectId: null,
  summary: "任务摘要",
  target: { route: "/tasks", resourceId: null }
} as const;

describe("task presentation ordering", () => {
  it("sorts by blocking priority, due time, creation time and stable ID", () => {
    const tasks: TaskResponse[] = [
      task("normal", "normal", null, "2026-07-14T04:00:00.000Z"),
      task("later", "blocking", "2026-07-15T04:00:00.000Z", "2026-07-14T03:00:00.000Z"),
      task("earlier", "blocking", "2026-07-14T08:00:00.000Z", "2026-07-14T05:00:00.000Z"),
      task("undated", "blocking", null, "2026-07-14T02:00:00.000Z")
    ];
    expect(tasks.sort(compareTasks).map(({ id }) => id)).toEqual(["earlier", "later", "undated", "normal"]);
  });
});

function task(id: string, priority: TaskResponse["priority"], dueAt: string | null,
  createdAt: string): TaskResponse {
  return { ...base, id, kind: "approval_review", priority, title: id, dueAt, createdAt };
}
