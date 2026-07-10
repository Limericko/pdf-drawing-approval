import { PlatformConfigError } from "./types.ts";

const sensitiveFieldPattern = /(PASSWORD|SECRET|TOKEN|KEYRING|ACCESS_KEY|DATABASE_URL)/i;
const urlCredentialsPattern = /([a-z][a-z0-9+.-]*:\/\/[^@\s/:]*:)([^@\s/]+)@/gi;
const defaultRedactionMarker = "[REDACTED]";

export function redactConfigError(error: unknown, env: NodeJS.ProcessEnv = {}) {
  if (error instanceof PlatformConfigError) return `${error.code}:${error.field}`;
  return redactConfigText(error instanceof Error ? error.message : String(error), env);
}

export function redactConfigText(value: string, env: NodeJS.ProcessEnv = {}) {
  const input = String(value);
  const secrets = collectSecrets(env);
  addUrlSecrets(secrets, input);
  const orderedSecrets = [...secrets].sort((left, right) => right.length - left.length);
  const marker = chooseRedactionMarker(orderedSecrets);
  return redactUrlCredentials(replaceSecrets(input, orderedSecrets, marker), marker);
}

function replaceSecrets(value: string, secrets: string[], marker: string) {
  if (secrets.length === 0) return value;
  const pattern = new RegExp(secrets.map(escapeRegExp).join("|"), "g");
  return value.replace(pattern, marker);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectSecrets(env: NodeJS.ProcessEnv) {
  const secrets = new Set<string>();
  for (const [field, rawValue] of Object.entries(env)) {
    if (!rawValue || !sensitiveFieldPattern.test(field)) continue;
    addSecret(secrets, rawValue);

    if (/DATABASE_URL/i.test(field)) addDatabaseUrlSecrets(secrets, rawValue);
    if (/KEYRING/i.test(field)) addJsonSecrets(secrets, rawValue);
  }
  return secrets;
}

function addUrlSecrets(secrets: Set<string>, value: string) {
  for (const match of value.matchAll(urlCredentialsPattern)) {
    addSecret(secrets, match[2]);
    addSecret(secrets, safeDecode(match[2]));
  }
}

function redactUrlCredentials(value: string, marker: string) {
  return value.replace(urlCredentialsPattern, (_match, prefix: string) => `${prefix}${marker}@`);
}

function chooseRedactionMarker(secrets: string[]) {
  if (secrets.every((secret) => !defaultRedactionMarker.includes(secret))) return defaultRedactionMarker;
  for (let codePoint = 0xe000; codePoint <= 0x10fffd; codePoint += 1) {
    if (codePoint === 0xf900) codePoint = 0xf0000;
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !secret.includes(candidate))) return candidate;
  }
  throw new Error("REDACTION_MARKER_UNAVAILABLE");
}

function addDatabaseUrlSecrets(secrets: Set<string>, rawValue: string) {
  try {
    const url = new URL(rawValue);
    addSecret(secrets, url.password);
    addSecret(secrets, safeDecode(url.password));
  } catch {
    // The full invalid value is already redacted.
  }
}

function addJsonSecrets(secrets: Set<string>, rawValue: string) {
  try {
    visitJsonSecrets(JSON.parse(rawValue), secrets);
  } catch {
    // The full invalid value is already redacted.
  }
}

function visitJsonSecrets(value: unknown, secrets: Set<string>) {
  if (typeof value === "string") {
    addSecret(secrets, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonSecrets(item, secrets);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) visitJsonSecrets(nested, secrets);
  }
}

function addSecret(secrets: Set<string>, value: string) {
  if (value.length > 0) secrets.add(value);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
