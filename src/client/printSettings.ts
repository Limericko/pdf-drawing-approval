export type PrintPaperSize = "printer-default" | "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "Legal" | "Letter" | "Tabloid";
export type PrintOrientation = "portrait" | "landscape";
export type PrintColorMode = "color" | "grayscale";
export type PrintDuplexMode = "simplex" | "shortEdge" | "longEdge";
export type PrintMarginMode = "default" | "none" | "printableArea";

export type PrintSettings = {
  printerName: string;
  copies: number;
  pageRange: string;
  paperSize: PrintPaperSize;
  orientation: PrintOrientation;
  colorMode: PrintColorMode;
  duplexMode: PrintDuplexMode;
  marginMode: PrintMarginMode;
  scaleFactor: number;
  printBackground: boolean;
};

export type DesktopPrinter = {
  name: string;
  displayName: string;
  description: string;
  isDefault: boolean;
};

export type DesktopPrintOptions = {
  silent: true;
  printBackground: boolean;
  deviceName?: string;
  color: boolean;
  margins: { marginType: PrintMarginMode };
  landscape: boolean;
  scaleFactor: number;
  copies: number;
  pageRanges?: Array<{ from: number; to: number }>;
  duplexMode: PrintDuplexMode;
  pageSize?: Exclude<PrintPaperSize, "printer-default">;
  usePrinterDefaultPageSize: boolean;
};

export type DesktopPrintResult = {
  success: boolean;
  failureReason?: string;
};

const paperSizes = ["printer-default", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "Legal", "Letter", "Tabloid"] as const;
const orientations = ["portrait", "landscape"] as const;
const colorModes = ["color", "grayscale"] as const;
const duplexModes = ["simplex", "shortEdge", "longEdge"] as const;
const marginModes = ["default", "none", "printableArea"] as const;

export function defaultPrintSettings(): PrintSettings {
  return {
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
  };
}

export function sanitizePrintSettings(input: Partial<PrintSettings> | null | undefined): PrintSettings {
  const defaults = defaultPrintSettings();
  if (!input) return defaults;

  return {
    printerName: typeof input.printerName === "string" ? input.printerName.trim() : defaults.printerName,
    copies: clampInteger(input.copies, 1, 99, defaults.copies),
    pageRange: typeof input.pageRange === "string" ? input.pageRange.trim() : defaults.pageRange,
    paperSize: oneOf(input.paperSize, paperSizes, defaults.paperSize),
    orientation: oneOf(input.orientation, orientations, defaults.orientation),
    colorMode: oneOf(input.colorMode, colorModes, defaults.colorMode),
    duplexMode: oneOf(input.duplexMode, duplexModes, defaults.duplexMode),
    marginMode: oneOf(input.marginMode, marginModes, defaults.marginMode),
    scaleFactor: clampInteger(input.scaleFactor, 25, 200, defaults.scaleFactor),
    printBackground: Boolean(input.printBackground)
  };
}

export function parsePageRanges(value: string): Array<{ from: number; to: number }> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  return trimmed.split(",").map((part) => {
    const token = part.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) throw new Error("INVALID_PAGE_RANGE");

    const fromPage = Number(match[1]);
    const toPage = match[2] ? Number(match[2]) : fromPage;
    if (!Number.isInteger(fromPage) || !Number.isInteger(toPage) || fromPage < 1 || toPage < fromPage) {
      throw new Error("INVALID_PAGE_RANGE");
    }

    return {
      from: fromPage - 1,
      to: toPage - 1
    };
  });
}

export function toDesktopPrintOptions(settings: PrintSettings): DesktopPrintOptions {
  const sanitized = sanitizePrintSettings(settings);
  const options: DesktopPrintOptions = {
    silent: true,
    printBackground: sanitized.printBackground,
    color: sanitized.colorMode === "color",
    margins: { marginType: sanitized.marginMode },
    landscape: sanitized.orientation === "landscape",
    scaleFactor: sanitized.scaleFactor,
    copies: sanitized.copies,
    pageRanges: parsePageRanges(sanitized.pageRange),
    duplexMode: sanitized.duplexMode,
    usePrinterDefaultPageSize: sanitized.paperSize === "printer-default"
  };

  if (sanitized.printerName) options.deviceName = sanitized.printerName;
  if (sanitized.paperSize !== "printer-default") options.pageSize = sanitized.paperSize;
  if (!options.pageRanges?.length) delete options.pageRanges;

  return options;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
