import { describe, expect, it } from "vitest";
import { parseDrawingFileName } from "./parseDrawingFileName.ts";

describe("parseDrawingFileName", () => {
  it.each([
    ["轴承座-a0A0.pdf", "轴承座", "a0A0", "a0", "A0"],
    ["轴承座-a1A0.pdf", "轴承座", "a1A0", "a1", "A0"],
    ["上盖板-a0A1.pdf", "上盖板", "a0A1", "a0", "A1"]
  ])("parses valid drawing name %s", (fileName, partName, version, minorVersion, majorVersion) => {
    expect(parseDrawingFileName(fileName)).toEqual({
      partName,
      version,
      minorVersion,
      majorVersion,
      documentCode: null,
      materialCode: null,
      drawingName: partName,
      metadataStatus: "missing_material_code"
    });
  });

  it("parses the standard PDM filename with document code, material code, drawing name and version", () => {
    expect(parseDrawingFileName("MP300A000072 《0102A00700883 400A按键》 a0A0.pdf")).toEqual({
      partName: "400A按键",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      documentCode: "MP300A000072",
      materialCode: "0102A00700883",
      drawingName: "400A按键",
      metadataStatus: "complete"
    });
  });

  it("allows the document code to be added later when the material code and drawing name are present", () => {
    expect(parseDrawingFileName("《0102A00700883 400A按键》 a0A0.pdf")).toEqual({
      partName: "400A按键",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      documentCode: null,
      materialCode: "0102A00700883",
      drawingName: "400A按键",
      metadataStatus: "missing_document_code"
    });
  });

  it("allows both document code and material code to be added later when a drawing name and version are present", () => {
    expect(parseDrawingFileName("400A按键 a0A0.pdf")).toEqual({
      partName: "400A按键",
      version: "a0A0",
      minorVersion: "a0",
      majorVersion: "A0",
      documentCode: null,
      materialCode: null,
      drawingName: "400A按键",
      metadataStatus: "missing_material_code"
    });
  });

  it.each(["轴承座.pdf", "轴承座-v1.pdf", "轴承座-aA.pdf", "轴承座-a1A0.docx"])("rejects invalid drawing name %s", (fileName) => {
    expect(parseDrawingFileName(fileName)).toBeNull();
  });
});
