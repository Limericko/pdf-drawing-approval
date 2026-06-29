import { describe, expect, it } from "vitest";
import {
  defaultPrintSettings,
  parsePageRanges,
  sanitizePrintSettings,
  toDesktopPrintOptions
} from "./printSettings.ts";

describe("print settings", () => {
  it("uses conservative signed PDF print defaults", () => {
    expect(defaultPrintSettings()).toEqual({
      printerName: "",
      copies: 1,
      pageRange: "",
      paperSize: "printer-default",
      orientation: "portrait",
      colorMode: "color",
      duplexMode: "simplex",
      marginMode: "default",
      scaleFactor: 100,
      printBackground: false
    });
  });

  it("parses one-based page ranges for Electron zero-based ranges", () => {
    expect(parsePageRanges("1, 3, 5-8")).toEqual([
      { from: 0, to: 0 },
      { from: 2, to: 2 },
      { from: 4, to: 7 }
    ]);
  });

  it("rejects invalid page ranges with a stable error", () => {
    expect(() => parsePageRanges("0")).toThrow("INVALID_PAGE_RANGE");
    expect(() => parsePageRanges("4-2")).toThrow("INVALID_PAGE_RANGE");
    expect(() => parsePageRanges("1,a")).toThrow("INVALID_PAGE_RANGE");
  });

  it("clamps numeric values and preserves valid option sets", () => {
    expect(
      sanitizePrintSettings({
        printerName: " HP ",
        copies: 500,
        pageRange: " 1-2 ",
        paperSize: "A3",
        orientation: "landscape",
        colorMode: "grayscale",
        duplexMode: "longEdge",
        marginMode: "printableArea",
        scaleFactor: 15,
        printBackground: true
      })
    ).toEqual({
      printerName: "HP",
      copies: 99,
      pageRange: "1-2",
      paperSize: "A3",
      orientation: "landscape",
      colorMode: "grayscale",
      duplexMode: "longEdge",
      marginMode: "printableArea",
      scaleFactor: 25,
      printBackground: true
    });
  });

  it("maps app settings to Electron print options", () => {
    expect(
      toDesktopPrintOptions({
        ...defaultPrintSettings(),
        printerName: "HP LaserJet",
        copies: 2,
        pageRange: "2-4",
        paperSize: "A4",
        orientation: "landscape",
        colorMode: "grayscale",
        duplexMode: "shortEdge",
        marginMode: "none",
        scaleFactor: 95,
        printBackground: true
      })
    ).toEqual({
      silent: true,
      deviceName: "HP LaserJet",
      copies: 2,
      pageRanges: [{ from: 1, to: 3 }],
      pageSize: "A4",
      usePrinterDefaultPageSize: false,
      landscape: true,
      color: false,
      duplexMode: "shortEdge",
      margins: { marginType: "none" },
      scaleFactor: 95,
      printBackground: true
    });
  });

  it("omits page size when printer defaults should be used", () => {
    expect(toDesktopPrintOptions(defaultPrintSettings())).toMatchObject({
      silent: true,
      usePrinterDefaultPageSize: true
    });
    expect(toDesktopPrintOptions(defaultPrintSettings())).not.toHaveProperty("pageSize");
  });
});
