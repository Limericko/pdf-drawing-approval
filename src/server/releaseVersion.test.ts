import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appVersion } from "../shared/appVersion.ts";

const expectedVersion = "0.9.2";

describe("release version metadata", () => {
  it("keeps package, health, desktop client, and server exe versions aligned", () => {
    const rootPackage = readJson("package.json");
    const desktopPackage = readJson(path.join("apps", "desktop-client", "package.json"));
    const serverExePackage = readJson(path.join("apps", "server-exe", "package.json"));

    expect(rootPackage.version).toBe(expectedVersion);
    expect(desktopPackage.version).toBe(expectedVersion);
    expect(serverExePackage.version).toBe(expectedVersion);
    expect(appVersion).toBe(expectedVersion);
  });
});

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as { version: string };
}
