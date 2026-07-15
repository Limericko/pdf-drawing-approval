import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebDavCredentialProvider, WebDavCredentialError } from "./webDavCredentialProvider.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("WebDavCredentialProvider", () => {
  it("returns defensive credential copies from an inline development source", async () => {
    const entries = new Map([["secret/webdav/test", { username: "designer@example.test", password: "app-password" }]]);
    const provider = createWebDavCredentialProvider({ driver: "inline", entries });
    const first = await provider.get("secret/webdav/test");
    const second = await provider.get("secret/webdav/test");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("loads a mounted secret file without exposing its content in failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pdf-approval-webdav-")); roots.push(root);
    const file = path.join(root, "credentials.json");
    await writeFile(file, JSON.stringify({ "secret/webdav/test": {
      username: "designer@example.test", password: "mounted-password"
    } }), { encoding: "utf8", mode: 0o600 });
    const provider = createWebDavCredentialProvider({ driver: "file", path: file });
    await expect(provider.get("secret/webdav/test")).resolves.toEqual({
      username: "designer@example.test", password: "mounted-password"
    });
    const failure = await provider.get("secret/webdav/missing").catch((error) => error);
    expect(failure).toBeInstanceOf(WebDavCredentialError);
    expect(JSON.stringify(failure)).not.toContain("mounted-password");
  });

  it("rejects malformed credentials and traversal references with stable errors", async () => {
    const provider = createWebDavCredentialProvider({ driver: "inline", entries: new Map([
      ["secret/webdav/broken", { username: "bad\nuser", password: "secret" }]
    ]) });
    await expect(provider.get("../secret")).rejects.toMatchObject({ code: "WEBDAV_CREDENTIAL_REF_INVALID" });
    await expect(provider.get("secret/webdav/broken")).rejects.toMatchObject({ code: "WEBDAV_CREDENTIAL_INVALID" });
  });
});
