import { describe, expect, it, vi } from "vitest";
import { createWebDavNetworkGuard } from "./webDavNetworkGuard.ts";

describe("WebDAV DNS network guard", () => {
  it("rejects any production answer set that contains a private address", async () => {
    const guard = createWebDavNetworkGuard({ environment: "production", lookup: vi.fn(async () => [
      { address: "8.8.8.8", family: 4 }, { address: "10.0.0.8", family: 4 }
    ]) });
    await expect(guard(new URL("https://dav.company.com/root/")))
      .rejects.toMatchObject({ code: "WEBDAV_RESOLVED_ADDRESS_FORBIDDEN" });
  });

  it("allows globally reachable production answers and bypasses DNS outside production", async () => {
    const lookup = vi.fn(async () => [{ address: "2606:4700:4700::1111", family: 6 }]);
    await expect(createWebDavNetworkGuard({ environment: "production", lookup })(
      new URL("https://dav.company.com/root/")
    )).resolves.toBeUndefined();
    const developmentLookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);
    await createWebDavNetworkGuard({ environment: "development", lookup: developmentLookup })(
      new URL("http://127.0.0.1:1900/root/")
    );
    expect(developmentLookup).not.toHaveBeenCalled();
  });
});
