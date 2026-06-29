import fs from "node:fs/promises";
import path from "node:path";

export type DirectoryEntry = {
  name: string;
  path: string;
};

export type DirectoryListing = {
  currentPath: string | null;
  parentPath: string | null;
  entries: DirectoryEntry[];
  roots: DirectoryEntry[];
};

export async function listDirectories(currentPath?: string): Promise<DirectoryListing> {
  const roots = await listRoots();
  if (!currentPath) {
    return { currentPath: null, parentPath: null, entries: roots, roots };
  }

  const resolved = path.resolve(currentPath);
  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const entries = dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  const parentPath = path.dirname(resolved);
  return {
    currentPath: resolved,
    parentPath: parentPath === resolved ? null : parentPath,
    entries,
    roots
  };
}

async function listRoots(): Promise<DirectoryEntry[]> {
  const roots: DirectoryEntry[] = [];

  for (let code = 67; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      await fs.access(drive);
      roots.push({ name: drive, path: drive });
    } catch {
      // Drive is not present or not accessible.
    }
  }

  return roots;
}
