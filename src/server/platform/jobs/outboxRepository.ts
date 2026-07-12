import type { OutboxEvent } from "./jobTypes.ts";

export interface OutboxRepository {
  claimUndispatched(limit: number): Promise<OutboxEvent[]>;
  markDispatched(id: string, dispatchedAt: Date): Promise<OutboxEvent>;
}
