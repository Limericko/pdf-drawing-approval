import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ScanRunRepository } from "./scanRuns.ts";

function repo() {
  return new ScanRunRepository(createDatabase(":memory:"));
}

describe("ScanRunRepository", () => {
  it("starts and completes scan runs with counts", () => {
    const repository = repo();
    const started = repository.start("manual:admin");

    expect(started.status).toBe("running");
    expect(started.triggeredBy).toBe("manual:admin");

    const completed = repository.complete(started.id, {
      processedCount: 2,
      missingCount: 1,
      invalidCount: 3
    });

    expect(completed.status).toBe("completed");
    expect(completed.processedCount).toBe(2);
    expect(completed.missingCount).toBe(1);
    expect(completed.invalidCount).toBe(3);
    expect(completed.finishedAt).toBeTruthy();
  });

  it("marks scan runs as failed", () => {
    const repository = repo();
    const started = repository.start("timer");

    const failed = repository.fail(started.id, "目录不可访问");

    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("目录不可访问");
  });

  it("lists recent scan runs newest first", () => {
    const repository = repo();
    const first = repository.start("first");
    const second = repository.start("second");

    expect(repository.listRecent().map((scan) => scan.id)).toEqual([second.id, first.id]);
  });
});
