export type ApprovalIssueRealtimeEvent = {
  type: "issue.changed";
  approvalId: number;
  issueId: number;
  version: number;
};

type Listener = (event: ApprovalIssueRealtimeEvent) => void;

export class ApprovalIssueEventHub {
  private readonly listeners = new Map<number, Set<Listener>>();

  subscribe(approvalId: number, listener: Listener) {
    const approvalListeners = this.listeners.get(approvalId) ?? new Set<Listener>();
    approvalListeners.add(listener);
    this.listeners.set(approvalId, approvalListeners);
    return () => {
      approvalListeners.delete(listener);
      if (approvalListeners.size === 0) this.listeners.delete(approvalId);
    };
  }

  publish(event: ApprovalIssueRealtimeEvent) {
    for (const listener of this.listeners.get(event.approvalId) ?? []) listener(event);
  }

  listenerCount(approvalId: number) {
    return this.listeners.get(approvalId)?.size ?? 0;
  }
}
