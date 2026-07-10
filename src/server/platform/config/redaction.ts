const sensitiveFieldPattern = /(PASSWORD|SECRET|TOKEN|KEYRING|ACCESS_KEY|DATABASE_URL)/i;
const stableIdentifierPattern =
  /\b(?:PLATFORM_CONFIG_INVALID|INSECURE_PRODUCTION_CONFIG)\b|\bPDF_APPROVAL_[A-Z0-9_]+\b/g;

type ProtectedSegment = { kind: "text" | "stable-identifier"; value: string };

export function redactConfigError(error: unknown, env: NodeJS.ProcessEnv = {}) {
  return redactConfigText(error instanceof Error ? error.message : String(error), env);
}

export function redactConfigText(value: string, env: NodeJS.ProcessEnv = {}) {
  const secrets = collectSecrets(env).sort((left, right) => right.length - left.length);
  const protectedSegments = protectStableIdentifiers(String(value));
  return restoreStableIdentifiers(
    protectedSegments.map((segment) =>
      segment.kind === "stable-identifier" ? segment : { ...segment, value: redactTextSegment(segment.value, secrets) }
    )
  );
}

function protectStableIdentifiers(value: string): ProtectedSegment[] {
  const segments: ProtectedSegment[] = [];
  let offset = 0;
  for (const match of value.matchAll(stableIdentifierPattern)) {
    const index = match.index;
    if (index > offset) segments.push({ kind: "text", value: value.slice(offset, index) });
    segments.push({ kind: "stable-identifier", value: match[0] });
    offset = index + match[0].length;
  }
  if (offset < value.length) segments.push({ kind: "text", value: value.slice(offset) });
  return segments;
}

function restoreStableIdentifiers(segments: ProtectedSegment[]) {
  return segments.map((segment) => segment.value).join("");
}

function redactTextSegment(value: string, secrets: string[]) {
  const withoutSecrets = replaceSecrets(value, secrets);
  return withoutSecrets.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
}

function replaceSecrets(value: string, secrets: string[]) {
  if (secrets.length === 0) return value;
  const pattern = new RegExp(secrets.map(escapeRegExp).join("|"), "g");
  return value.replace(pattern, "[REDACTED]");
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
  return [...secrets];
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
