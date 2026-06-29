import { describe, expect, it } from "vitest";
import { parseDrawingFileName } from "./parseDrawingFileName.ts";

describe("parseDrawingFileName", () => {
  it.each([
    ["轴承座-a0A0.pdf", "轴承座", "a0A0", "a0", "A0"],
    ["轴承座-a1A0.pdf", "轴承座", "a1A0", "a1", "A0"],
    ["上盖板-a0A1.pdf", "上盖板", "a0A1", "a0", "A1"]
  ])("parses valid drawing name %s", (fileName, partName, version, minorVersion, majorVersion) => {
    expect(parseDrawingFileName(fileName)).toEqual({ partName, version, minorVersion, majorVersion });
  });

  it.each(["轴承座.pdf", "轴承座-v1.pdf", "轴承座-aA.pdf", "轴承座-a1A0.docx"])("rejects invalid drawing name %s", (fileName) => {
    expect(parseDrawingFileName(fileName)).toBeNull();
  });
});
