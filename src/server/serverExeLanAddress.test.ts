import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { chooseLanIPv4Address, createLanUrl } = require("../../apps/server-exe/lanAddress.cjs");

describe("server exe LAN address detection", () => {
  it("prefers a physical LAN IPv4 address over tunnel and TAP adapters", () => {
    const interfaces = {
      vgate0: [
        {
          address: "172.30.255.69",
          netmask: "255.255.255.255",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.30.255.69/32"
        }
      ],
      "cfw-tap": [
        {
          address: "10.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:ff:a9:4c:6c:13",
          internal: false,
          cidr: "10.0.0.1/8"
        }
      ],
      "以太网": [
        {
          address: "192.168.0.62",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "f0:2f:74:4e:af:cf",
          internal: false,
          cidr: "192.168.0.62/24"
        }
      ]
    };

    expect(chooseLanIPv4Address(interfaces)).toBe("192.168.0.62");
    expect(createLanUrl("8080", interfaces)).toBe("http://192.168.0.62:8080");
  });

  it("does not expose loopback, link-local, or point-to-point tunnel addresses as LAN URLs", () => {
    const interfaces = {
      "Loopback Pseudo-Interface 1": [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8"
        }
      ],
      tunnel0: [
        {
          address: "172.30.255.69",
          netmask: "255.255.255.255",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.30.255.69/32"
        }
      ],
      "本地连接": [
        {
          address: "169.254.27.84",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:ff:a9:4c:6c:13",
          internal: false,
          cidr: "169.254.27.84/16"
        }
      ]
    };

    expect(chooseLanIPv4Address(interfaces)).toBe("");
    expect(createLanUrl("8080", interfaces)).toBe("");
  });
});
