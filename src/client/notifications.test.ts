import { describe, expect, it } from "vitest";
import { newTaskNotificationIds } from "./notifications.ts";

describe("newTaskNotificationIds", () => {
  it("only returns task ids that were not notified before", () => {
    expect(newTaskNotificationIds([1, 2, 3], [1, 3])).toEqual([2]);
  });

  it("does not notify again when entering the task page with the same tasks", () => {
    expect(newTaskNotificationIds([4, 5], [4, 5])).toEqual([]);
  });
});
