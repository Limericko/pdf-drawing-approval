import { apiCompatVersion, appName, appVersion } from "../../shared/appVersion.ts";

export type PublicHealthInput = {
  port: number;
  lanAddresses: string[];
  startedAt: string;
};

export function buildPublicHealth(input: PublicHealthInput) {
  return {
    ok: true,
    runtimeMode: "legacy" as const,
    appName,
    version: appVersion,
    apiCompatVersion,
    port: input.port,
    lanUrls: input.lanAddresses.map((address) => `http://${address}:${input.port}`),
    startedAt: input.startedAt
  };
}
