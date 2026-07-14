import { chmod, chown, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const MAX_INPUT_BYTES = 512 * 1024;
const SERVICE_DIRECTORIES = ["web", "worker", "migration", "bootstrap"];

export async function materializeProductionSecrets({ bundle, root, uid = 10001, gid = 10001 }) {
  const normalizedRoot = validateRoot(root);
  const normalizedOwner = validateOwner(uid, gid);
  const files = validateBundle(bundle);
  await secureDirectory(normalizedRoot, normalizedOwner);
  for (const service of SERVICE_DIRECTORIES) {
    await secureDirectory(path.join(normalizedRoot, service), normalizedOwner);
  }
  for (const [relativePath, value] of Object.entries(files)) {
    await atomicSecretWrite(path.join(normalizedRoot, relativePath), value, normalizedOwner);
  }
  return Object.freeze({ root: normalizedRoot, files: Object.keys(files).length });
}

function validateBundle(input) {
  exactObject(input, ["database", "storage", "smtp", "keyrings", "webdavCredentials"], "bundle");
  exactObject(input.database, ["webUrl", "workerUrl", "migrationUrl", "bootstrapUrl"], "database");
  exactObject(input.storage, ["accessKey", "secretKey"], "storage");
  exactObject(input.smtp, ["password"], "smtp");
  exactObject(input.keyrings, ["totp", "invitation", "recovery", "csrf"], "keyrings");

  const database = Object.fromEntries(Object.entries(input.database).map(([name, value]) =>
    [name, secretString(value, 4096, `database.${name}`)]));
  const storageAccessKey = secretString(input.storage.accessKey, 256, "storage.accessKey");
  const storageSecretKey = secretString(input.storage.secretKey, 1024, "storage.secretKey");
  const smtpPassword = secretString(input.smtp.password, 1024, "smtp.password");
  const keyrings = validateKeyrings(input.keyrings);
  const webdavCredentials = validateWebDavCredentials(input.webdavCredentials);

  return Object.freeze({
    "web/database-url.secret": database.webUrl,
    "web/oss-access-key.secret": storageAccessKey,
    "web/oss-secret-key.secret": storageSecretKey,
    "web/totp-keyring.secret": JSON.stringify(keyrings.totp),
    "web/invitation-hmac-keyring.secret": JSON.stringify(keyrings.invitation),
    "web/recovery-hmac-keyring.secret": JSON.stringify(keyrings.recovery),
    "web/csrf-hmac-keyring.secret": JSON.stringify(keyrings.csrf),
    "worker/database-url.secret": database.workerUrl,
    "worker/oss-access-key.secret": storageAccessKey,
    "worker/oss-secret-key.secret": storageSecretKey,
    "worker/smtp-password.secret": smtpPassword,
    "worker/invitation-hmac-keyring.secret": JSON.stringify(keyrings.invitation),
    "worker/webdav-credentials.json": JSON.stringify(webdavCredentials),
    "migration/database-url.secret": database.migrationUrl,
    "bootstrap/database-url.secret": database.bootstrapUrl,
    "bootstrap/totp-keyring.secret": JSON.stringify(keyrings.totp),
    "bootstrap/recovery-hmac-keyring.secret": JSON.stringify(keyrings.recovery)
  });
}

function validateKeyrings(value) {
  const fingerprints = new Set();
  return Object.fromEntries(Object.entries(value).map(([purpose, keyring]) => {
    exactObject(keyring, ["currentVersion", "keys"], `keyrings.${purpose}`);
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(keyring.currentVersion ?? "")) invalid(`keyrings.${purpose}`);
    if (!keyring.keys || typeof keyring.keys !== "object" || Array.isArray(keyring.keys)) invalid(`keyrings.${purpose}`);
    const entries = Object.entries(keyring.keys);
    if (entries.length < 1 || entries.length > 8 || !Object.hasOwn(keyring.keys, keyring.currentVersion)) {
      invalid(`keyrings.${purpose}`);
    }
    for (const [version, encoded] of entries) {
      if (!/^[A-Za-z0-9._-]{1,32}$/.test(version) || typeof encoded !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        invalid(`keyrings.${purpose}`);
      }
      const material = Buffer.from(encoded, "base64");
      if (material.byteLength < 32 || material.byteLength > 128) invalid(`keyrings.${purpose}`);
      const fingerprint = material.toString("hex");
      if (fingerprints.has(fingerprint)) invalid("keyrings.materialReused");
      fingerprints.add(fingerprint);
    }
    return [purpose, { currentVersion: keyring.currentVersion, keys: { ...keyring.keys } }];
  }));
}

function validateWebDavCredentials(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("webdavCredentials");
  const entries = Object.entries(value);
  if (entries.length > 100) invalid("webdavCredentials");
  for (const [reference, credential] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,239}$/.test(reference) ||
        reference.split("/").some((segment) => segment === "." || segment === "..")) invalid("webdavCredentials");
    exactObject(credential, ["username", "password"], `webdavCredentials.${reference}`);
    const username = secretString(credential.username, 254, `webdavCredentials.${reference}.username`);
    const password = secretString(credential.password, 1024, `webdavCredentials.${reference}.password`);
    if (username.includes(":")) invalid(`webdavCredentials.${reference}.username`);
  }
  return value;
}

function secretString(value, maximum, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}

function exactObject(value, expectedKeys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...expectedKeys].sort().join(",")) invalid(field);
}

function validateRoot(root) {
  if (typeof root !== "string" || root !== root.trim() || !path.isAbsolute(root) || root === path.parse(root).root) {
    invalid("root");
  }
  return path.normalize(root);
}

function validateOwner(uid, gid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) invalid("owner");
  return { uid, gid };
}

async function secureDirectory(target, owner) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalid("secretDirectory");
  if (process.platform !== "win32") {
    await chmod(target, 0o700);
    await chown(target, owner.uid, owner.gid);
  }
}

async function atomicSecretWrite(target, value, owner) {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const backup = `${target}.old-${randomUUID()}`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o400 });
    if (process.platform !== "win32") {
      await chmod(temporary, 0o400);
      await chown(temporary, owner.uid, owner.gid);
    }
    if (process.platform === "win32") await replaceOnWindows(temporary, target, backup);
    else await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    await rm(backup, { force: true }).catch(() => undefined);
  }
}

async function replaceOnWindows(temporary, target, backup) {
  let movedExisting = false;
  try {
    await rename(target, backup);
    movedExisting = true;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (movedExisting) await rename(backup, target).catch(() => undefined);
    throw error;
  }
}

function invalid(field) {
  const error = new Error("PRODUCTION_SECRET_BUNDLE_INVALID");
  Object.defineProperty(error, "code", { value: "PRODUCTION_SECRET_BUNDLE_INVALID", enumerable: true });
  Object.defineProperty(error, "field", { value: field, enumerable: true });
  throw error;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_INPUT_BYTES) invalid("stdin");
    chunks.push(bytes);
  }
  if (size === 0) invalid("stdin");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invalid("stdin");
  }
}

function parseArguments(argv) {
  const result = { root: undefined, uid: 10001, gid: 10001 };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) invalid("arguments");
    if (name === "--root") result.root = value;
    else if (name === "--uid") result.uid = Number(value);
    else if (name === "--gid") result.gid = Number(value);
    else invalid("arguments");
  }
  return result;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await materializeProductionSecrets({ bundle: await readStdin(), ...options });
    process.stdout.write(`PRODUCTION_SECRETS_MATERIALIZED files=${result.files}\n`);
  } catch (error) {
    const code = error && typeof error === "object" && error.code === "PRODUCTION_SECRET_BUNDLE_INVALID"
      ? error.code : "PRODUCTION_SECRET_MATERIALIZATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
