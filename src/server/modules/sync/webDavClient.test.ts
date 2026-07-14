import { describe, expect, it, vi } from "vitest";
import { createWebDavClient, WebDavClientError } from "./webDavClient.ts";

const credential = { username: "designer@example.test", password: "app-password" };

describe("WebDAV protocol client", () => {
  it("parses a bounded PROPFIND multistatus and normalizes decoded paths", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("PROPFIND");
      expect(new Headers(init?.headers).get("Depth")).toBe("1");
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Basic /);
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
        <d:response><d:href>/root/Incoming/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/root/Incoming/GX%20A01.pdf</d:href><d:propstat><d:prop>
          <d:getetag>&quot;etag-1&quot;</d:getetag><d:getcontentlength>128</d:getcontentlength>
          <d:getlastmodified>Tue, 14 Jul 2026 10:00:00 GMT</d:getlastmodified><d:resourcetype/>
        </d:prop></d:propstat></d:response></d:multistatus>`, {
        status: 207, headers: { "Content-Type": "application/xml" }
      });
    });
    const client = createWebDavClient({ endpointUrl: "https://dav.example.test/root/", credential, fetch });
    await expect(client.list("/Incoming")).resolves.toEqual([{
      path: "/Incoming/GX A01.pdf", etag: "\"etag-1\"", sizeBytes: 128,
      modifiedAt: new Date("2026-07-14T10:00:00.000Z"), collection: false
    }]);
  });

  it("uses Range for resumable downloads and rejects servers that ignore a nonzero range", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=64-");
      return new Response(new Uint8Array([1, 2]), { status: 206, headers: {
        "Content-Range": "bytes 64-65/66", "Content-Length": "2", ETag: "\"etag-2\""
      } });
    });
    const client = createWebDavClient({ endpointUrl: "https://dav.example.test/root/", credential, fetch });
    const result = await client.download("/Incoming/A01.pdf", { rangeStart: 64 });
    expect(result.status).toBe(206);
    expect(result.totalSizeBytes).toBe(66);

    const ignored = createWebDavClient({ endpointUrl: "https://dav.example.test/root/", credential,
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200 })) });
    await expect(ignored.download("/Incoming/A01.pdf", { rangeStart: 64 }))
      .rejects.toMatchObject({ code: "WEBDAV_RANGE_NOT_HONORED", kind: "transient" });
  });

  it("uploads with a temporary path and sends a non-overwriting MOVE destination", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { ETag: "\"temp\"" } }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { ETag: "\"final\"" } }));
    const client = createWebDavClient({ endpointUrl: "https://dav.example.test/root/", credential, fetch });
    await client.put("/Published/A01.pdf.partial-sync", new Uint8Array([1, 2, 3]));
    await client.move("/Published/A01.pdf.partial-sync", "/Published/A01.pdf");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "PUT", redirect: "manual" });
    const moveHeaders = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "MOVE", redirect: "manual" });
    expect(moveHeaders.get("Destination")).toBe("https://dav.example.test/root/Published/A01.pdf");
    expect(moveHeaders.get("Overwrite")).toBe("F");
  });

  it("never forwards credentials across origins or outside the configured base path", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: {
      Location: "https://evil.example/steal"
    } }));
    const client = createWebDavClient({ endpointUrl: "https://dav.example.test/root/", credential, fetch });
    await expect(client.head("/Incoming/A01.pdf")).rejects.toBeInstanceOf(WebDavClientError);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.head("/../outside.pdf")).rejects.toMatchObject({ code: "WEBDAV_PATH_INVALID" });
  });

  it("classifies offline, authentication and conflict responses without leaking secrets", async () => {
    for (const [response, expected] of [
      [new Response(null, { status: 401 }), { kind: "permanent", code: "WEBDAV_AUTH_FAILED" }],
      [new Response(null, { status: 412 }), { kind: "permanent", code: "WEBDAV_REMOTE_CONFLICT" }],
      [new Response(null, { status: 503 }), { kind: "transient", code: "WEBDAV_REMOTE_UNAVAILABLE" }]
    ] as const) {
      const client = createWebDavClient({ endpointUrl: "https://dav.example.test/root/", credential,
        fetch: vi.fn(async () => response) });
      const error = await client.head("/Incoming/A01.pdf").catch((caught) => caught);
      expect(error).toMatchObject(expected);
      expect(JSON.stringify(error)).not.toContain(credential.password);
    }
  });
});
