import { readFile, stat } from "node:fs/promises";
import type { WebDavCredential, WebDavCredentialSourceConfig } from "../../platform/config/types.ts";

const MAX_SECRET_FILE_BYTES = 256 * 1024;

export class WebDavCredentialError extends Error {
  constructor(readonly code: "WEBDAV_CREDENTIAL_REF_INVALID" | "WEBDAV_CREDENTIAL_NOT_FOUND" |
    "WEBDAV_CREDENTIAL_INVALID" | "WEBDAV_CREDENTIAL_SOURCE_UNAVAILABLE") {
    super(code);
    this.name = "WebDavCredentialError";
  }
}

export type WebDavCredentialProvider = { get(reference: string): Promise<WebDavCredential> };

export function createWebDavCredentialProvider(config: WebDavCredentialSourceConfig): WebDavCredentialProvider {
  if (!config || typeof config !== "object") throw new WebDavCredentialError("WEBDAV_CREDENTIAL_SOURCE_UNAVAILABLE");
  return Object.freeze({
    async get(reference: string) {
      if (!validRef(reference)) throw new WebDavCredentialError("WEBDAV_CREDENTIAL_REF_INVALID");
      if (config.driver === "none") throw new WebDavCredentialError("WEBDAV_CREDENTIAL_NOT_FOUND");
      if (config.driver === "inline") return cloneCredential(config.entries.get(reference));
      let source: string;
      try {
        const metadata = await stat(config.path);
        if (!metadata.isFile() || metadata.size > MAX_SECRET_FILE_BYTES) throw new Error();
        source = await readFile(config.path, "utf8");
      } catch {
        throw new WebDavCredentialError("WEBDAV_CREDENTIAL_SOURCE_UNAVAILABLE");
      }
      let entries: unknown;
      try { entries = JSON.parse(source); } catch { throw new WebDavCredentialError("WEBDAV_CREDENTIAL_INVALID"); }
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        throw new WebDavCredentialError("WEBDAV_CREDENTIAL_INVALID");
      }
      return cloneCredential((entries as Record<string, unknown>)[reference]);
    }
  });
}

function cloneCredential(value: unknown): WebDavCredential {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "password,username") {
    if (value === undefined) throw new WebDavCredentialError("WEBDAV_CREDENTIAL_NOT_FOUND");
    throw new WebDavCredentialError("WEBDAV_CREDENTIAL_INVALID");
  }
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string" ||
      !validValue(username, 254, true) || !validValue(password, 1024, false)) {
    throw new WebDavCredentialError("WEBDAV_CREDENTIAL_INVALID");
  }
  return { username, password };
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{2,239}$/.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..");
}
function validValue(value: string, maximum: number, rejectColon: boolean) {
  return value.length > 0 && value.length <= maximum && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) && (!rejectColon || !value.includes(":"));
}
