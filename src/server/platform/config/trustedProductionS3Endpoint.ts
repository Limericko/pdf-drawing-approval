import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { isPublicEndpointHostname } from "./publicEndpoint.ts";

type TrustedS3ProviderPattern = {
  provider: string;
  hostnamePattern: RegExp;
  forbiddenHostnamePattern: RegExp;
};

// Synchronous config loading cannot prove a domain's DNS targets are public.
// This table is therefore the explicit production trust boundary and extension
// point for audited, standard public object-storage provider hostnames.
const trustedS3ProviderPatterns: readonly TrustedS3ProviderPattern[] = [
  {
    provider: "Alibaba Cloud OSS",
    hostnamePattern: /^(?:[a-z0-9][a-z0-9-]{0,62}\.)?oss-[a-z0-9]+(?:-[a-z0-9]+)*\.aliyuncs\.com$/,
    forbiddenHostnamePattern: /(?:^|\.)oss-[^.]*internal[^.]*\.aliyuncs\.com$/
  },
  {
    provider: "Amazon S3",
    hostnamePattern: /^(?:[a-z0-9][a-z0-9-]{0,62}\.)?s3(?:[.-][a-z0-9]+(?:-[a-z0-9]+)*)?\.amazonaws\.com$/,
    forbiddenHostnamePattern: /(?:^|\.)s3[.-][^.]*(?:internal|private|vpc|vpce)[^.]*\.amazonaws\.com$/
  }
];

export function isTrustedProductionS3EndpointHostname(rawHostname: string) {
  if (!isPublicEndpointHostname(rawHostname)) return false;
  const hostname = normalizePublicHostname(rawHostname);
  if (isIP(hostname) !== 0) return true;
  const asciiHostname = domainToASCII(hostname).toLowerCase();
  return trustedS3ProviderPatterns.some(
    ({ hostnamePattern, forbiddenHostnamePattern }) =>
      hostnamePattern.test(asciiHostname) && !forbiddenHostnamePattern.test(asciiHostname)
  );
}

function normalizePublicHostname(hostname: string) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}
