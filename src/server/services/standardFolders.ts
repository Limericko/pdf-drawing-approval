import fs from "node:fs/promises";
import path from "node:path";
import { folders } from "../files/fileLocations.ts";

export const standardApprovalFolders = Object.values(folders);

export type StandardFolderState = {
  name: string;
  path: string;
  exists: boolean;
};

export async function inspectStandardFolders(watchRoot: string | null) {
  if (!watchRoot) {
    return {
      watchRoot,
      rootExists: false,
      ready: false,
      folders: [] as StandardFolderState[]
    };
  }

  const rootExists = await pathExists(watchRoot);
  const folderStates = await Promise.all(
    standardApprovalFolders.map(async (name) => {
      const folderPath = path.join(watchRoot, name);
      return {
        name,
        path: folderPath,
        exists: await pathExists(folderPath)
      };
    })
  );

  return {
    watchRoot,
    rootExists,
    ready: rootExists && folderStates.every((folder) => folder.exists),
    folders: folderStates
  };
}

export async function prepareStandardFolders(watchRoot: string) {
  const root = watchRoot.trim();
  if (!root) throw new Error("WATCH_ROOT_REQUIRED");

  await fs.mkdir(root, { recursive: true });
  const results = [];

  for (const name of standardApprovalFolders) {
    const folderPath = path.join(root, name);
    const existed = await pathExists(folderPath);
    await fs.mkdir(folderPath, { recursive: true });
    results.push({
      name,
      path: folderPath,
      status: existed ? ("existing" as const) : ("created" as const)
    });
  }

  return {
    watchRoot: root,
    folders: results
  };
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
