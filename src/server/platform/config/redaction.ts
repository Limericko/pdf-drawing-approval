const sensitiveFieldPattern = /(PASSWORD|SECRET|TOKEN|KEYRING|ACCESS_KEY|DATABASE_URL)/i;

export function redactConfigError(error: unknown, env: NodeJS.ProcessEnv = {}) {
  return redactConfigText(error instanceof Error ? error.message : String(error), env);
}

export function redactConfigText(value: string, env: NodeJS.ProcessEnv = {}) {
  let redacted = String(value).replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
  const secrets = collectSecrets(env).sort((left, right) => right.length - left.length);
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
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
  if (value.length >= 4) secrets.add(value);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
