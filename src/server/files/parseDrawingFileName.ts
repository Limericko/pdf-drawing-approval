import path from "node:path";

export type PdmMetadataStatus = "complete" | "missing_document_code" | "missing_material_code";

export type ParsedDrawingFileName = {
  partName: string;
  version: string;
  minorVersion: string;
  majorVersion: string;
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string;
  metadataStatus: PdmMetadataStatus;
};

export function parseDrawingFileName(filePath: string): ParsedDrawingFileName | null {
  const fileName = path.basename(filePath).trim();
  if (path.extname(fileName).toLowerCase() !== ".pdf") return null;

  const baseName = fileName.slice(0, -path.extname(fileName).length).trim();
  const parsed = parsePdmName(baseName) ?? parseLegacyName(baseName) ?? parseNameWithTrailingVersion(baseName);
  if (!parsed) return null;

  const version = parsed.version;
  const versionMatch = /^(a\d+)(A\d+)$/.exec(version);
  if (!versionMatch) return null;

  return {
    partName: parsed.drawingName,
    version,
    minorVersion: versionMatch[1],
    majorVersion: versionMatch[2],
    documentCode: parsed.documentCode,
    materialCode: parsed.materialCode,
    drawingName: parsed.drawingName,
    metadataStatus: metadataStatus(parsed.documentCode, parsed.materialCode)
  };
}

type ParsedNameParts = {
  documentCode: string | null;
  materialCode: string | null;
  drawingName: string;
  version: string;
};

function parsePdmName(baseName: string): ParsedNameParts | null {
  const match = /^(.*?)\s*《\s*(\S+)\s+(.+?)\s*》\s*(a\d+A\d+)$/.exec(baseName);
  if (!match) return null;
  return {
    documentCode: emptyToNull(match[1]),
    materialCode: match[2].trim(),
    drawingName: match[3].trim(),
    version: match[4]
  };
}

function parseLegacyName(baseName: string): ParsedNameParts | null {
  const match = /^(.+)-(a\d+A\d+)$/.exec(baseName);
  if (!match) return null;
  return {
    documentCode: null,
    materialCode: null,
    drawingName: match[1].trim(),
    version: match[2]
  };
}

function parseNameWithTrailingVersion(baseName: string): ParsedNameParts | null {
  const match = /^(.+?)\s+(a\d+A\d+)$/.exec(baseName);
  if (!match) return null;
  return {
    documentCode: null,
    materialCode: null,
    drawingName: match[1].trim(),
    version: match[2]
  };
}

function metadataStatus(documentCode: string | null, materialCode: string | null): PdmMetadataStatus {
  if (!materialCode) return "missing_material_code";
  if (!documentCode) return "missing_document_code";
  return "complete";
}

function emptyToNull(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
