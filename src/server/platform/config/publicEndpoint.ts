import { isIP } from "node:net";
import { domainToASCII } from "node:url";

type SpecialPurposeRangeDefinition = readonly [cidr: string, globallyReachable: boolean, name: string];
type CompiledIpv4Range = { network: number; prefixLength: number; globallyReachable: boolean };
type CompiledIpv6Range = { network: bigint; prefixLength: number; globallyReachable: boolean };

const ipv6WellKnownNat64Definition = [
  "64:ff9b::/96",
  true,
  "IPv4-IPv6 Translation"
] as const satisfies SpecialPurposeRangeDefinition;

// Snapshot of the IANA IPv4 Special-Purpose Address Registry, checked 2026-07-11.
// Longest-prefix matching preserves the registry's globally reachable exceptions.
// N/A entries are treated as non-public because production endpoints must be
// unambiguously globally reachable. Multicast is an endpoint-policy addition.
const ipv4SpecialPurposeDefinitions = [
  ["0.0.0.0/8", false, "This network"],
  ["0.0.0.0/32", false, "This host on this network"],
  ["10.0.0.0/8", false, "Private-Use"],
  ["100.64.0.0/10", false, "Shared Address Space"],
  ["127.0.0.0/8", false, "Loopback"],
  ["169.254.0.0/16", false, "Link Local"],
  ["172.16.0.0/12", false, "Private-Use"],
  ["192.0.0.0/24", false, "IETF Protocol Assignments"],
  ["192.0.0.0/29", false, "IPv4 Service Continuity Prefix"],
  ["192.0.0.8/32", false, "IPv4 dummy address"],
  ["192.0.0.9/32", true, "Port Control Protocol Anycast"],
  ["192.0.0.10/32", true, "TURN Anycast"],
  ["192.0.0.170/32", false, "NAT64/DNS64 Discovery"],
  ["192.0.0.171/32", false, "NAT64/DNS64 Discovery"],
  ["192.0.2.0/24", false, "Documentation (TEST-NET-1)"],
  ["192.31.196.0/24", true, "AS112-v4"],
  ["192.52.193.0/24", true, "AMT"],
  ["192.88.99.0/24", false, "Deprecated 6to4 Relay Anycast"],
  ["192.88.99.2/32", false, "6a44-relay anycast"],
  ["192.168.0.0/16", false, "Private-Use"],
  ["192.175.48.0/24", true, "Direct Delegation AS112"],
  ["198.18.0.0/15", false, "Benchmarking"],
  ["198.51.100.0/24", false, "Documentation (TEST-NET-2)"],
  ["203.0.113.0/24", false, "Documentation (TEST-NET-3)"],
  ["224.0.0.0/4", false, "Multicast endpoint policy"],
  ["240.0.0.0/4", false, "Reserved"],
  ["255.255.255.255/32", false, "Limited Broadcast"]
] as const satisfies readonly SpecialPurposeRangeDefinition[];

// Snapshot of the IANA IPv6 Special-Purpose Address Registry, checked 2026-07-11.
// Deprecated site-local, IPv4-compatible, and multicast ranges are explicit
// endpoint-policy additions. Keep this table synchronized with the IANA registry.
const ipv6SpecialPurposeDefinitions = [
  ["::/96", false, "Deprecated IPv4-compatible endpoint policy"],
  ["::/128", false, "Unspecified"],
  ["::1/128", false, "Loopback"],
  ["::ffff:0:0/96", false, "IPv4-mapped"],
  ipv6WellKnownNat64Definition,
  ["64:ff9b:1::/48", false, "Local-use IPv4-IPv6 Translation"],
  ["100::/64", false, "Discard-Only"],
  ["100:0:0:1::/64", false, "Dummy IPv6 Prefix"],
  ["2001::/23", false, "IETF Protocol Assignments"],
  ["2001::/32", false, "TEREDO (globally reachable N/A)"],
  ["2001:1::1/128", true, "Port Control Protocol Anycast"],
  ["2001:1::2/128", true, "TURN Anycast"],
  ["2001:1::3/128", true, "DNS-SD Anycast"],
  ["2001:2::/48", false, "Benchmarking"],
  ["2001:3::/32", true, "AMT"],
  ["2001:4:112::/48", true, "AS112-v6"],
  ["2001:10::/28", false, "Deprecated ORCHID"],
  ["2001:20::/28", true, "ORCHIDv2"],
  ["2001:30::/28", true, "Drone Remote ID"],
  ["2001:db8::/32", false, "Documentation"],
  ["2002::/16", false, "6to4 (globally reachable N/A)"],
  ["2620:4f:8000::/48", true, "Direct Delegation AS112"],
  ["3fff::/20", false, "Documentation"],
  ["5f00::/16", false, "Segment Routing SIDs"],
  ["fc00::/7", false, "Unique-Local"],
  ["fe80::/10", false, "Link-Local Unicast"],
  ["fec0::/10", false, "Deprecated Site-Local endpoint policy"],
  ["ff00::/8", false, "Multicast endpoint policy"]
] as const satisfies readonly SpecialPurposeRangeDefinition[];

const specialUseDomainSuffixes = [
  "alt",
  "arpa",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "home.arpa",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
  "test"
] as const;

const ipv4SpecialPurposeRanges = ipv4SpecialPurposeDefinitions
  .map(compileIpv4Range)
  .sort(longestPrefixFirst);
const ipv6SpecialPurposeRanges = ipv6SpecialPurposeDefinitions
  .map(compileIpv6Range)
  .sort(longestPrefixFirst);
const ipv6WellKnownNat64Range = compileIpv6Range(ipv6WellKnownNat64Definition);
const ipv6GlobalUnicastDefault = compileIpv6Range(["2000::/3", true, "Global Unicast default"]);

export function isPublicEndpointHostname(rawHostname: string) {
  const normalizedHostname = normalizeHostname(rawHostname);
  if (normalizedHostname === null) return false;
  const ipVersion = isIP(normalizedHostname);
  if (ipVersion === 4) return isGloballyReachableIpv4(normalizedHostname);
  if (ipVersion === 6) return isGloballyReachableIpv6(normalizedHostname);
  return isPublicDomainName(normalizedHostname);
}

function isPublicDomainName(hostname: string) {
  const asciiHostname = domainToASCII(hostname).toLowerCase();
  if (!asciiHostname || asciiHostname.length > 253) return false;
  const labels = asciiHostname.split(".");
  if (labels.length < 2 || labels.some(isInvalidDomainLabel)) return false;
  return !specialUseDomainSuffixes.some(
    (suffix) => asciiHostname === suffix || asciiHostname.endsWith(`.${suffix}`)
  );
}

function isInvalidDomainLabel(label: string) {
  return (
    label.length < 1 ||
    label.length > 63 ||
    !/^[a-z0-9-]+$/.test(label) ||
    label.startsWith("-") ||
    label.endsWith("-")
  );
}

function isGloballyReachableIpv4(hostname: string) {
  return isGloballyReachableIpv4Address(parseIpv4(hostname));
}

function isGloballyReachableIpv4Address(address: number) {
  const classification = ipv4SpecialPurposeRanges.find((range) => matchesIpv4Range(address, range));
  return classification?.globallyReachable ?? true;
}

function isGloballyReachableIpv6(hostname: string) {
  const address = ipv6WordsToBigInt(parseIpv6Words(hostname));
  if (matchesIpv6Range(address, ipv6WellKnownNat64Range)) {
    return isGloballyReachableIpv4Address(Number(address & 0xffffffffn));
  }
  const classification = ipv6SpecialPurposeRanges.find((range) => matchesIpv6Range(address, range));
  return classification?.globallyReachable ?? matchesIpv6Range(address, ipv6GlobalUnicastDefault);
}

function compileIpv4Range([cidr, globallyReachable]: SpecialPurposeRangeDefinition): CompiledIpv4Range {
  const [hostname, prefixText] = cidr.split("/");
  return { network: parseIpv4(hostname), prefixLength: Number(prefixText), globallyReachable };
}

function compileIpv6Range([cidr, globallyReachable]: SpecialPurposeRangeDefinition): CompiledIpv6Range {
  const [hostname, prefixText] = cidr.split("/");
  return {
    network: ipv6WordsToBigInt(parseIpv6Words(hostname)),
    prefixLength: Number(prefixText),
    globallyReachable
  };
}

function parseIpv4(hostname: string) {
  return hostname.split(".").map(Number).reduce((value, octet) => value * 256 + octet, 0) >>> 0;
}

function matchesIpv4Range(address: number, range: CompiledIpv4Range) {
  const shift = 32 - range.prefixLength;
  return shift === 0 ? address === range.network : address >>> shift === range.network >>> shift;
}

function matchesIpv6Range(address: bigint, range: CompiledIpv6Range) {
  const shift = BigInt(128 - range.prefixLength);
  return address >> shift === range.network >> shift;
}

function parseIpv6Words(hostname: string) {
  const halves = hostname.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  return [...head.map(parseHexWord), ...Array.from({ length: missing }, () => 0), ...tail.map(parseHexWord)];
}

function ipv6WordsToBigInt(words: number[]) {
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n);
}

function parseHexWord(value: string) {
  return Number.parseInt(value, 16);
}

function normalizeHostname(hostname: string) {
  if (hostname.startsWith("[")) {
    if (!hostname.endsWith("]")) return null;
    const unwrappedHostname = hostname.slice(1, -1);
    return isIP(unwrappedHostname) === 6 ? unwrappedHostname : null;
  }
  if (hostname.endsWith("..")) return null;
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function longestPrefixFirst<T extends { prefixLength: number }>(left: T, right: T) {
  return right.prefixLength - left.prefixLength;
}
