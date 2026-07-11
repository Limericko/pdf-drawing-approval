import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

const migrationFilePattern = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export const PLATFORM_MIGRATIONS_DIRECTORY = new URL("../../../../migrations/postgres/", import.meta.url);

export type MigrationFile = {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly checksum: string;
  readonly sql: string;
};

type MigrationFileIdentity = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs" | "isFile">;

type MigrationFileHandle = {
  readFile(): Promise<Buffer>;
  stat(): Promise<MigrationFileIdentity>;
  close(): Promise<void>;
};

type MigrationFileSystem = {
  readDirectory(directory: string | URL): Promise<string[]>;
  lstat(filePath: string | URL): Promise<MigrationFileIdentity>;
  open(filePath: string | URL): Promise<MigrationFileHandle>;
};

const nodeMigrationFileSystem: MigrationFileSystem = {
  readDirectory: (directory) => readdir(directory),
  lstat: (filePath) => lstat(filePath, { bigint: true }),
  async open(filePath) {
    const handle = await open(filePath, "r");
    return {
      readFile: () => handle.readFile(),
      stat: () => handle.stat({ bigint: true }),
      close: () => handle.close()
    };
  }
};

export async function loadMigrationFiles(
  directory: string | URL = PLATFORM_MIGRATIONS_DIRECTORY,
  fileSystem: MigrationFileSystem = nodeMigrationFileSystem
): Promise<MigrationFile[]> {
  const sqlFiles = (await fileSystem.readDirectory(directory))
    .filter((fileName) => fileName.toLowerCase().endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en"));
  const versions = new Set<number>();
  const migrations: MigrationFile[] = [];

  for (const fileName of sqlFiles) {
    const match = migrationFilePattern.exec(fileName);
    if (!match) throw new Error(`MIGRATION_FILE_NAME_INVALID:${fileName}`);
    const version = Number(match[1]);
    if (version === 0 || match[1] !== String(version).padStart(4, "0")) {
      throw new Error(`MIGRATION_FILE_NAME_INVALID:${fileName}`);
    }
    if (versions.has(version)) throw new Error(`MIGRATION_DUPLICATE_VERSION:${version}`);
    versions.add(version);

    const filePath = resolveMigrationPath(directory, fileName);
    const initialIdentity = await fileSystem.lstat(filePath);
    if (!initialIdentity.isFile()) throw new Error(`MIGRATION_FILE_TYPE_INVALID:${fileName}`);
    const raw = await readStableFile(fileSystem, filePath, fileName, initialIdentity);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(`MIGRATION_SQL_ENCODING_INVALID:${fileName}`);
    }
    const sql = raw.toString("utf8");
    if (!sql.trim()) throw new Error(`MIGRATION_SQL_EMPTY:${fileName}`);
    assertNoTopLevelTransactionControl(sql, fileName);
    migrations.push({
      version,
      name: match[2]!,
      fileName,
      checksum: createHash("sha256").update(raw).digest("hex"),
      sql
    });
  }

  return migrations;
}

async function readStableFile(
  fileSystem: MigrationFileSystem,
  filePath: string | URL,
  fileName: string,
  initialIdentity: MigrationFileIdentity
) {
  const handle = await fileSystem.open(filePath);
  let raw: Buffer | undefined;
  let primaryError: unknown;
  try {
    const openedIdentity = await handle.stat();
    if (!openedIdentity.isFile() || !sameFileIdentity(initialIdentity, openedIdentity)) {
      throw new Error(`MIGRATION_FILE_CHANGED_DURING_READ:${fileName}`);
    }
    raw = await handle.readFile();
    const finalIdentity = await handle.stat();
    if (!finalIdentity.isFile() || !sameFileIdentity(openedIdentity, finalIdentity)) {
      throw new Error(`MIGRATION_FILE_CHANGED_DURING_READ:${fileName}`);
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError([primaryError, closeError], "MIGRATION_FILE_READ_CLEANUP_FAILED", { cause: primaryError });
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  return raw!;
}

function sameFileIdentity(left: MigrationFileIdentity, right: MigrationFileIdentity) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertNoTopLevelTransactionControl(sql: string, fileName: string) {
  let index = 0;
  let statementStarted = false;
  let collectHeadTokens = true;
  let headTokens: string[] = [];

  const finishStatement = () => {
    if (isTransactionControl(headTokens)) {
      throw new Error(`MIGRATION_TRANSACTION_CONTROL_FORBIDDEN:${fileName}`);
    }
    statementStarted = false;
    collectHeadTokens = true;
    headTokens = [];
  };

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index = skipLineComment(sql, index + 2);
      continue;
    }
    if (character === "/" && next === "*") {
      index = skipBlockComment(sql, index + 2);
      continue;
    }
    if (character === "'") {
      if (!statementStarted) {
        statementStarted = true;
        collectHeadTokens = false;
      }
      index = skipQuoted(sql, index, "'", hasEscapeStringPrefix(sql, index));
      continue;
    }
    if (character === '"') {
      if (!statementStarted) {
        statementStarted = true;
        collectHeadTokens = false;
      }
      index = skipQuoted(sql, index, '"', false);
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiter(sql, index);
      if (delimiter) {
        if (!statementStarted) {
          statementStarted = true;
          collectHeadTokens = false;
        }
        index = skipDollarQuoted(sql, index, delimiter);
        continue;
      }
    }
    if (character === ";") {
      finishStatement();
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const tokenEnd = scanWordEnd(sql, index + 1);
      if (!statementStarted) statementStarted = true;
      if (collectHeadTokens && headTokens.length < 2) {
        headTokens.push(sql.slice(index, tokenEnd).toUpperCase());
      }
      index = tokenEnd;
      continue;
    }

    if (!statementStarted) {
      statementStarted = true;
      collectHeadTokens = false;
    }
    index += 1;
  }

  finishStatement();
}

function isTransactionControl(tokens: readonly string[]) {
  const first = tokens[0];
  if (["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT"].includes(first ?? "")) return true;
  const second = tokens[1];
  return (
    (first === "START" && second === "TRANSACTION") ||
    (first === "RELEASE" && second === "SAVEPOINT") ||
    (first === "PREPARE" && second === "TRANSACTION")
  );
}

function skipLineComment(sql: string, index: number) {
  while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
  return index;
}

function skipBlockComment(sql: string, index: number) {
  let depth = 1;
  while (index < sql.length && depth > 0) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
      depth += 1;
      index += 2;
    } else if (sql[index] === "*" && sql[index + 1] === "/") {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

function skipQuoted(sql: string, index: number, quote: "'" | '"', allowBackslashEscape: boolean) {
  index += 1;
  while (index < sql.length) {
    if (allowBackslashEscape && sql[index] === "\\") {
      index += 2;
    } else if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
    } else if (sql[index] === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return index;
}

function hasEscapeStringPrefix(sql: string, quoteIndex: number) {
  const prefixIndex = quoteIndex - 1;
  if (prefixIndex < 0 || !/[Ee]/.test(sql[prefixIndex]!)) return false;
  const beforePrefix = sql[prefixIndex - 1];
  return beforePrefix === undefined || !/[A-Za-z0-9_$]/.test(beforePrefix);
}

function dollarQuoteDelimiter(sql: string, index: number) {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
}

function skipDollarQuoted(sql: string, index: number, delimiter: string) {
  const closingIndex = sql.indexOf(delimiter, index + delimiter.length);
  return closingIndex === -1 ? sql.length : closingIndex + delimiter.length;
}

function scanWordEnd(sql: string, index: number) {
  while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index]!)) index += 1;
  return index;
}

function resolveMigrationPath(directory: string | URL, fileName: string) {
  if (directory instanceof URL) return new URL(fileName, ensureTrailingSlash(directory));
  return path.join(directory, fileName);
}

function ensureTrailingSlash(directory: URL) {
  return directory.href.endsWith("/") ? directory : new URL(`${directory.href}/`);
}
