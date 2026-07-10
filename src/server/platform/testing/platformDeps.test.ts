import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../../");
const scriptPath = path.join(workspaceRoot, "scripts", "platform-deps.mjs");

describe("platform-deps", () => {
  it("refuses reset without explicit local data loss confirmation", () => {
    const result = spawnSync(process.execPath, [scriptPath, "reset"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 5_000
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("pdf-approval-phase1-postgres-data");
    expect(result.stdout).toContain("pdf-approval-phase1-minio-data");
    expect(result.stderr).toContain("--confirm-local-data-loss");
    expect(result.stderr).not.toContain("ReferenceError");
  });

  it("reports an unavailable Docker daemon without masking the error", () => {
    const result = spawnSync(process.execPath, [scriptPath, "status"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        DOCKER_HOST: "npipe:////./pipe/pdfApprovalMissingDockerEngine"
      }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker command failed");
    expect(result.stderr).not.toContain("ReferenceError");
  });
});
