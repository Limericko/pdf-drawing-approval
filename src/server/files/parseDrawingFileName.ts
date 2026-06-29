import path from "node:path";

export type ParsedDrawingFileName = {
  partName: string;
  version: string;
  minorVersion: string;
  majorVersion: string;
};

export function parseDrawingFileName(filePath: string): ParsedDrawingFileName | null {
  const fileName = path.basename(filePath);
  const match = /^(.+)-(a\d+A\d+)\.pdf$/.exec(fileName);
  if (!match) return null;

  const version = match[2];
  const versionMatch = /^(a\d+)(A\d+)$/.exec(version);
  if (!versionMatch) return null;

  return {
    partName: match[1],
    version,
    minorVersion: versionMatch[1],
    majorVersion: versionMatch[2]
  };
}
