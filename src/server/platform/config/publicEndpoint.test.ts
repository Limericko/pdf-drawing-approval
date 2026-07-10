import { describe, expect, it } from "vitest";
import { isPublicEndpointHostname } from "./publicEndpoint.ts";

describe("public endpoint hostname validation", () => {
  it.each([
    "127.0.0.2",
    "localhost.",
    "bucket.localhost",
    "0.0.0.0",
    "169.254.1.1",
    "10.1.2.3",
    "172.16.1.1",
    "192.168.1.1",
    "[::1]",
    "[::ffff:7f00:1]",
    "[fc00::1]",
    "[fe80::1]"
  ])("rejects the non-public hostname %s", (hostname) => {
    expect(isPublicEndpointHostname(hostname)).toBe(false);
  });

  it.each([
    "s3.ap-east-1.amazonaws.com",
    "bücher.example",
    "8.8.8.8",
    "[2606:4700:4700::1111]"
  ])("accepts the public hostname %s", (hostname) => {
    expect(isPublicEndpointHostname(hostname)).toBe(true);
  });
});
