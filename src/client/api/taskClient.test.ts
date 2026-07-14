import { afterEach, describe, expect, it, vi } from "vitest";
import { listMyTasks } from "./taskClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";

const projectId = "01890f1e-9b4a-7cc2-8f00-000000000701";

afterEach(() => vi.unstubAllGlobals());

describe("taskClient", () => {
  it("loads global and project task projections through the shared request layer", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      items: [], counts: { blocking: 0, total: 0 }
    }), { status: 200, headers: { "Content-Type": "application/json",
      "X-Request-ID": "task-client-request" } }));
    vi.stubGlobal("fetch", fetch);
    await listMyTasks();
    await listMyTasks({ projectId });
    expect(fetch.mock.calls.map(([target]) => target)).toEqual([
      "/api/v2/tasks",
      `/api/v2/tasks?projectId=${projectId}`
    ]);
  });

  it("rejects legacy project identifiers before network work", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => listMyTasks({ projectId: "12" })).toThrow(PlatformRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
