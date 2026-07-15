import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession } from "./identityClient.ts";
import { PlatformRequestError } from "./platformRequest.ts";
import { uploadPlatformObject } from "./storageClient.ts";

const ids = {
  user: "01890f1e-9b4a-7cc2-8f00-000000000d01",
  project: "01890f1e-9b4a-7cc2-8f00-000000000d02",
  object: "01890f1e-9b4a-7cc2-8f00-000000000d03"
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("storageClient", () => {
  it("uploads a raw object with the shared CSRF session and validates metadata", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(sessionBody(), 200))
      .mockResolvedValueOnce(jsonResponse({ id: ids.object, mediaType: "application/pdf", sizeBytes: 8,
        sha256: "ab".repeat(32) }, 201));
    vi.stubGlobal("fetch", fetch);
    await getSession();
    const file = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    await expect(uploadPlatformObject(file)).resolves.toMatchObject({ id: ids.object });
    expect(fetch).toHaveBeenLastCalledWith("/api/v2/storage/objects", expect.objectContaining({
      method: "POST", body: file, credentials: "same-origin",
      headers: expect.objectContaining({ "content-type": "application/pdf", "x-csrf-token": "csrf-token" })
    }));
  });

  it("rejects empty and unsupported blobs before network work", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => uploadPlatformObject(new Blob([], { type: "application/pdf" }))).toThrow(PlatformRequestError);
    expect(() => uploadPlatformObject(new Blob(["x"], { type: "text/plain" }))).toThrow(PlatformRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "storage-client-test" } });
}

function sessionBody() {
  const now = "2026-07-14T07:00:00.000Z";
  return {
    user: { id: ids.user, emailNormalized: "designer@example.test", displayName: "设计师",
      platformRole: "member", status: "active", mfaStatus: "enabled", mfaEnabledAt: now,
      createdAt: now, updatedAt: now },
    globalCapabilities: [], projects: [{ id: ids.project, name: "E2E 项目", status: "active",
      role: "designer", capabilities: ["project.read", "drawings.submit"] }], csrfToken: "csrf-token"
  };
}
