import { lookup as dnsLookup } from "node:dns/promises";
import { isPublicEndpointHostname } from "../../platform/config/publicEndpoint.ts";
import type { PlatformEnvironment } from "../../platform/config/types.ts";

type Lookup = (hostname: string, options: { all: true; verbatim: true }) =>
  Promise<readonly { address: string; family: number }[]>;

export function createWebDavNetworkGuard(options: {
  readonly environment: PlatformEnvironment;
  readonly lookup?: Lookup;
}) {
  if (!options || !["development", "test", "production"].includes(options.environment)) {
    throw new Error("WEBDAV_NETWORK_GUARD_INVALID");
  }
  const resolve: Lookup = options.lookup ?? ((hostname, lookupOptions) => dnsLookup(hostname, lookupOptions));
  return async (url: URL) => {
    if (options.environment !== "production") return;
    let addresses: readonly { address: string; family: number }[];
    try { addresses = await resolve(url.hostname, { all: true, verbatim: true }); }
    catch { throw new WebDavNetworkGuardError("WEBDAV_DNS_UNAVAILABLE"); }
    if (addresses.length === 0 || addresses.length > 32 ||
        addresses.some(({ address }) => !isPublicEndpointHostname(address))) {
      throw new WebDavNetworkGuardError("WEBDAV_RESOLVED_ADDRESS_FORBIDDEN");
    }
  };
}

export class WebDavNetworkGuardError extends Error {
  readonly kind = "permanent" as const;
  constructor(readonly code: "WEBDAV_DNS_UNAVAILABLE" | "WEBDAV_RESOLVED_ADDRESS_FORBIDDEN") {
    super(code);
    this.name = "WebDavNetworkGuardError";
  }
}
