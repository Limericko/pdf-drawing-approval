import { describe, expect, it } from "vitest";
import { mergeNotifiedIds, newNotificationIds } from "./notificationState.ts";

describe("notificationState", () => {
  it("deduplicates notified approval ids", () => {
    expect(newNotificationIds([1, 2, 3], [1, 3])).toEqual([2]);
    expect(mergeNotifiedIds([1, 2], [2, 3])).toEqual([1, 2, 3]);
  });
});
