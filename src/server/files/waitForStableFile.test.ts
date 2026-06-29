import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { waitForStableFile } from "./waitForStableFile.ts";

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-"));
  return path.join(dir, "sample.pdf");
}

describe("waitForStableFile", () => {
  it("returns ok when file size and modified time stay unchanged", async () => {
    const file = await tempFile();
    await fs.writeFile(file, "pdf");

    await expect(waitForStableFile(file, { intervalMs: 5, requiredStableChecks: 1, timeoutMs: 100 })).resolves.toEqual({ ok: true });
  });

  it("returns missing for absent files", async () => {
    await expect(waitForStableFile("missing.pdf", { intervalMs: 5, timeoutMs: 20 })).resolves.toEqual({ ok: false, reason: "missing" });
  });

  it("returns timeout when stability is not reached in time", async () => {
    const file = await tempFile();
    await fs.writeFile(file, "pdf");

    await expect(waitForStableFile(file, { intervalMs: 10, requiredStableChecks: 100, timeoutMs: 20 })).resolves.toEqual({
      ok: false,
      reason: "timeout"
    });
  });
});
