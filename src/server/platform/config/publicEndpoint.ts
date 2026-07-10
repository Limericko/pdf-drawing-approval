import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export function isPublicEndpointHostname(rawHostname: string) {
  const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPublicIpv4(hostname);
  if (ipVersion === 6) return isPublicIpv6(hostname);

  const asciiHostname = domainToASCII(hostname.replace(/\.$/, "")).toLowerCase();
  if (!asciiHostname) return false;
  return asciiHostname !== "localhost" && !asciiHostname.endsWith(".localhost") && asciiHostname !== "minio";
}

function isPublicIpv4(hostname: string) {
  const [first, second, third] = hostname.split(".").map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(hostname: string) {
  const words = parseIpv6Words(hostname);
  if (!words) return false;
  const isUnspecified = words.every((word) => word === 0);
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const isIpv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const isUniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const isLinkLocal = (words[0] & 0xffc0) === 0xfe80;
  const isMulticast = (words[0] & 0xff00) === 0xff00;
  const isDocumentation = words[0] === 0x2001 && words[1] === 0x0db8;
  return !(isUnspecified || isLoopback || isIpv4Mapped || isUniqueLocal || isLinkLocal || isMulticast || isDocumentation);
}

function parseIpv6Words(hostname: string) {
  const halves = hostname.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...head, ...tail].every((word) => /^[0-9a-f]{1,4}$/i.test(word))) return null;
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...head.map(parseHexWord), ...Array.from({ length: missing }, () => 0), ...tail.map(parseHexWord)];
}

function parseHexWord(value: string) {
  return Number.parseInt(value, 16);
}
