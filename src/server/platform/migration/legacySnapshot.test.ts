import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLegacySnapshot } from "./legacySnapshot.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("online legacy SQLite snapshot", () => {
  it("captures committed WAL data into one integrity-checked snapshot", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source.sqlite");
    const targetPath = path.join(root, "snapshot", "legacy.sqlite");
    const source = new DatabaseSync(sourcePath);
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL);");
    source.prepare("INSERT INTO records(value) VALUES(?)").run("committed-in-wal");

    const result = await createLegacySnapshot({ sourcePath, targetPath });
    source.close();

    expect(result).toMatchObject({ targetPath, sizeBytes: expect.any(Number) });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const snapshot = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM records").get()).toEqual({ value: "committed-in-wal" });
    } finally {
      snapshot.close();
    }
  });

  it("refuses to overwrite the source or an existing snapshot", async () => {
    const root = await tempRoot();
    const sourcePath = path.join(root, "source.sqlite");
    const source = new DatabaseSync(sourcePath); source.exec("CREATE TABLE records(id INTEGER)"); source.close();
    await expect(createLegacySnapshot({ sourcePath, targetPath: sourcePath }))
      .rejects.toMatchObject({ code: "LEGACY_SNAPSHOT_INPUT_INVALID", field: "targetPath" });
    const targetPath = path.join(root, "target.sqlite");
    await createLegacySnapshot({ sourcePath, targetPath });
    const first = await readFile(targetPath);
    await expect(createLegacySnapshot({ sourcePath, targetPath }))
      .rejects.toMatchObject({ code: "LEGACY_SNAPSHOT_INPUT_INVALID", field: "targetPath" });
    expect(await readFile(targetPath)).toEqual(first);
  });
});

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "pdf-approval-legacy-snapshot-"));
  cleanup.push(root);
  return root;
}
