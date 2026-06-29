import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "./fileHash.ts";

describe("sha256File", () => {
  it("returns the same sha256 hash for the same file content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-hash-"));
    const first = path.join(dir, "first.pdf");
    const second = path.join(dir, "second.pdf");
    await fs.writeFile(first, "%PDF-1.7\nsame content");
    await fs.writeFile(second, "%PDF-1.7\nsame content");

    await expect(sha256File(first)).resolves.toBe(await sha256File(second));
  });

  it("returns different hashes for different file content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-hash-"));
    const first = path.join(dir, "first.pdf");
    const second = path.join(dir, "second.pdf");
    await fs.writeFile(first, "%PDF-1.7\nfirst");
    await fs.writeFile(second, "%PDF-1.7\nsecond");

    await expect(sha256File(first)).resolves.not.toBe(await sha256File(second));
  });

  it("throws FILE_NOT_FOUND for missing files", async () => {
    await expect(sha256File(path.join(os.tmpdir(), "missing-file.pdf"))).rejects.toThrow("FILE_NOT_FOUND");
  });
});
