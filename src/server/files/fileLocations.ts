import path from "node:path";

export const folders = {
  submitted: "01-待提交",
  reviewing: "02-审批中",
  rejected: "03-已驳回",
  approvedForPrint: "04-已通过待打印",
  printedArchive: "05-已打印归档"
} as const;

const managedFolders: Set<string> = new Set(Object.values(folders));

export function projectNameFromSubmittedFile(watchRoot: string, filePath: string): string | null {
  const relative = path.relative(path.join(watchRoot, folders.submitted), filePath);
  if (relative.startsWith("..")) return null;
  const segments = relative.split(path.sep).filter(Boolean);
  return segments.length >= 2 ? segments[0] : null;
}

export function projectNameFromWatchedFile(watchRoot: string, filePath: string): string | null {
  const submittedProject = projectNameFromSubmittedFile(watchRoot, filePath);
  if (submittedProject) return submittedProject;

  const relative = path.relative(watchRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length === 0) return null;
  if (managedFolders.has(segments[0])) return null;
  if (segments.length === 1) return "默认项目";
  return segments[0];
}

export function isManagedStatusFile(watchRoot: string, filePath: string) {
  const relative = path.relative(watchRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  const firstSegment = relative.split(path.sep).filter(Boolean)[0];
  return firstSegment ? managedFolders.has(firstSegment) && firstSegment !== folders.submitted : false;
}

export function targetPath(watchRoot: string, folder: string, projectName: string, fileName: string) {
  return path.join(watchRoot, folder, projectName, fileName);
}
