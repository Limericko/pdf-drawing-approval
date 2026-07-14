import { domainToASCII } from "node:url";
import { isPublicEndpointHostname } from "../../platform/config/publicEndpoint.ts";
import type { PlatformEnvironment } from "../../platform/config/types.ts";

const developmentLoopbacks = new Set(["localhost", "127.0.0.1", "::1"]);

export function createWebDavEndpointPolicy(options: {
  readonly environment: PlatformEnvironment;
  readonly allowedHosts: readonly string[];
}) {
  if (!options || !Array.isArray(options.allowedHosts)) throw new Error("WEBDAV_ENDPOINT_POLICY_INVALID");
  const allowed = new Set(options.allowedHosts.map(normalizeHost));
  if (allowed.has("")) throw new Error("WEBDAV_ENDPOINT_POLICY_INVALID");
  return (url: URL) => {
    if (!(url instanceof URL) || url.username || url.password || url.search || url.hash) return false;
    const host = normalizeHost(url.hostname);
    if (!host) return false;
    if (options.environment === "production") {
      return url.protocol === "https:" && allowed.has(host) && isPublicEndpointHostname(host);
    }
    if (developmentLoopbacks.has(host)) return url.protocol === "http:" || url.protocol === "https:";
    return url.protocol === "https:" && allowed.has(host);
  };
}

function normalizeHost(value: string) {
  const unwrapped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return domainToASCII(unwrapped.replace(/\.$/, "")).toLowerCase();
}
