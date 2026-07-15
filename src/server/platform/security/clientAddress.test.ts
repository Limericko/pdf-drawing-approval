import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { clientAddressPrefix } from "./clientAddress.ts";

describe("clientAddressPrefix", () => {
  it.each([
    ["203.0.113.97", "203.0.113.0/24"],
    ["::ffff:203.0.113.97", "203.0.113.0/24"],
    ["2001:0db8:abcd:0012:1234:5678:9abc:def0", "2001:db8:abcd:12::/64"]
  ])("canonicalizes %s", (address, expected) => {
    expect(clientAddressPrefix({ ip: address } as never)).toBe(expected);
  });

  it("rejects malformed addresses", () => {
    expect(() => clientAddressPrefix({ ip: "not-an-ip" } as never))
      .toThrowError(expect.objectContaining({ code: "CLIENT_ADDRESS_INVALID" }));
  });

  it("uses Express trust-proxy resolution instead of reading X-Forwarded-For directly", async () => {
    const untrusted = express();
    untrusted.get("/", (req, res) => res.json({ prefix: clientAddressPrefix(req) }));
    await request(untrusted).get("/").set("X-Forwarded-For", "203.0.113.97")
      .expect(200, { prefix: "127.0.0.0/24" });

    const trusted = express();
    trusted.set("trust proxy", 1);
    trusted.get("/", (req, res) => res.json({ prefix: clientAddressPrefix(req) }));
    await request(trusted).get("/").set("X-Forwarded-For", "203.0.113.97")
      .expect(200, { prefix: "203.0.113.0/24" });
  });
});
