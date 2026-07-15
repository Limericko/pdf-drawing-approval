import { describe, expect, it, vi } from "vitest";
import { ApprovalIssueEventHub } from "./approvalIssueEventHub.ts";

describe("ApprovalIssueEventHub", () => {
  it("isolates approval channels and unsubscribes closed clients", () => {
    const hub = new ApprovalIssueEventHub();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = hub.subscribe(10, first);
    hub.subscribe(20, second);
    hub.publish({ type: "issue.changed", approvalId: 10, issueId: 7, version: 2 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    unsubscribe();
    expect(hub.listenerCount(10)).toBe(0);
  });
});
