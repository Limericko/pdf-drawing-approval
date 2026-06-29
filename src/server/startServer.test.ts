import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPdfApprovalServer, startTempUploadCleanup } from "./startServer.ts";
import { getTempUpload, saveTempUpload } from "./uploads/tempUploads.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("startPdfApprovalServer", () => {
  it("starts a temporary upload cleanup loop with an immediate cleanup pass", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-startup-cleanup-"));
    const upload = await saveTempUpload({
      rootDir,
      originalName: "临时件-a0A0.pdf",
      buffer: Buffer.from("%PDF-1.7\n")
    });
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(path.dirname(upload.filePath), old, old);

    const cleanup = startTempUploadCleanup(rootDir, { maxAgeMs: 1_000, intervalMs: 60_000 });
    const removed = await cleanup.firstRun;
    cleanup.stop();

    expect(removed).toBe(1);
    await expect(getTempUpload(rootDir, upload.uploadId)).rejects.toThrow("UPLOAD_NOT_FOUND");
  });

  it("reports listen errors through the startup error callback", async () => {
    const blocker = await listenOnRandomPort();
    process.env.NODE_ENV = "test";
    process.env.PORT = String(blocker.port);
    process.env.PDF_APPROVAL_DB = ":memory:";

    const errors: Error[] = [];
    const server = startPdfApprovalServer({
      host: "127.0.0.1",
      onError: (error) => errors.push(error)
    });

    await waitFor(() => errors.length > 0);

    expect((errors[0] as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
    server.close();
    await blocker.close();
  });
});

async function listenOnRandomPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate a test port.");

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function waitFor(predicate: () => boolean) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}
