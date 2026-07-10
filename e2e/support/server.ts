import fs from "node:fs/promises";
import path from "node:path";
import { startPdfApprovalServer } from "../../src/server/startServer.ts";
import { e2ePort, e2eRoot } from "./fixtures.ts";
import { seedE2eData } from "./seed.ts";

await fs.rm(e2eRoot, { recursive: true, force: true });
await fs.mkdir(e2eRoot, { recursive: true });
const seeded = await seedE2eData(e2eRoot);

process.env.NODE_ENV = "test";
process.env.PORT = String(e2ePort);
process.env.PDF_APPROVAL_DATA_DIR = seeded.dataDir;
process.env.PDF_APPROVAL_DB = seeded.databasePath;
process.env.PDF_APPROVAL_JWT_SECRET = "e2e-only-secret";
process.env.PDF_APPROVAL_RELEASE_DIR = path.join(e2eRoot, "releases");

const server = startPdfApprovalServer({
  host: "127.0.0.1",
  logRoot: path.join(e2eRoot, "logs"),
  backupRoot: path.join(e2eRoot, "backups"),
  tempUploadCleanup: false
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
