import fs from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont, type RGB } from "pdf-lib";
import type { ApprovalAnnotation } from "../repositories/approvalAnnotations.ts";

const colorMap: Record<Exclude<ApprovalAnnotation["color"], "custom">, RGB> = {
  red: rgb(0.9, 0.12, 0.12),
  amber: rgb(0.95, 0.55, 0.08),
  blue: rgb(0.1, 0.35, 0.85),
  green: rgb(0.08, 0.55, 0.28)
};
const customColorPattern = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/;
const annotationTextFontCandidates = [
  process.env.PDF_APPROVAL_ANNOTATION_FONT,
  "C:\\Windows\\Fonts\\Deng.ttf",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\simsunb.ttf",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simsun.ttc"
].filter((candidate): candidate is string => Boolean(candidate));

type AnnotationTextFont = {
  font: PDFFont;
  supportsUnicode: boolean;
};

export async function generateAnnotatedPdf(input: {
  sourcePdfPath: string;
  annotations: ApprovalAnnotation[];
}): Promise<Uint8Array> {
  const sourceBytes = await fs.readFile(input.sourcePdfPath).catch(() => {
    throw new Error("SOURCE_PDF_NOT_FOUND");
  });
  const pdf = await PDFDocument.load(sourceBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const textFont = input.annotations.some((annotation) => annotation.message.trim())
    ? await loadAnnotationTextFont(pdf, font)
    : { font, supportsUnicode: false };
  const pages = pdf.getPages();

  input.annotations.forEach((annotation, index) => {
    if (annotation.pageNumber < 1 || annotation.pageNumber > pages.length) {
      throw new Error("PDF_PAGE_OUT_OF_RANGE");
    }

    drawAnnotation(pages[annotation.pageNumber - 1], annotation, index + 1, textFont, boldFont);
  });

  return pdf.save();
}

async function loadAnnotationTextFont(pdf: PDFDocument, fallbackFont: PDFFont): Promise<AnnotationTextFont> {
  pdf.registerFontkit(fontkit);

  for (const fontPath of annotationTextFontCandidates) {
    try {
      const fontBytes = await fs.readFile(fontPath);
      return {
        font: await pdf.embedFont(fontBytes, { subset: true }),
        supportsUnicode: true
      };
    } catch {
      // Try the next Windows font candidate. If none are available, the caller falls back to Helvetica.
    }
  }

  return { font: fallbackFont, supportsUnicode: false };
}

function drawAnnotation(page: PDFPage, annotation: ApprovalAnnotation, sequence: number, textFont: AnnotationTextFont, boldFont: PDFFont) {
  const color = annotationColor(annotation);

  if (annotation.kind === "rect") {
    const box = toBox(page, annotation);
    page.drawRectangle({ ...box, borderColor: color, borderWidth: 2, color, opacity: 0.08 });
    drawLabel(page, `${sequence}`, box.x, box.y + box.height + 4, color, boldFont);
    drawCommentCallout(page, annotation.message, box.x + 18, box.y + box.height + 4, color, textFont);
    return;
  }

  if (annotation.kind === "circle") {
    const box = toBox(page, annotation);
    page.drawEllipse({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      xScale: box.width / 2,
      yScale: box.height / 2,
      borderColor: color,
      borderWidth: 2,
      color,
      opacity: 0.06
    });
    drawLabel(page, `${sequence}`, box.x, box.y + box.height + 4, color, boldFont);
    drawCommentCallout(page, annotation.message, box.x + 18, box.y + box.height + 4, color, textFont);
    return;
  }

  if (annotation.kind === "arrow") {
    drawArrow(page, annotation, color);
    const start = toPoint(page, annotation.xRatio, annotation.yRatio);
    drawLabel(page, `${sequence}`, start.x + 4, start.y + 4, color, boldFont);
    drawCommentCallout(page, annotation.message, start.x + 22, start.y + 4, color, textFont);
    return;
  }

  if (annotation.kind === "text") {
    const box = toBox(page, annotation);
    page.drawRectangle({ ...box, borderColor: color, borderWidth: 1.5, color, opacity: 0.08 });
    drawLabel(page, `${sequence}`, box.x, box.y + box.height + 4, color, boldFont);
    drawReviewText(page, annotation.message, box, color, textFont);
    return;
  }

  if (annotation.kind === "ink") {
    drawInk(page, annotation, color);
    const point = toPoint(page, annotation.xRatio, annotation.yRatio);
    drawLabel(page, `${sequence}`, point.x + 4, point.y + 4, color, boldFont);
    drawCommentCallout(page, annotation.message, point.x + 22, point.y + 4, color, textFont);
    return;
  }

  if (annotation.kind === "cloud") {
    const box = toBox(page, annotation);
    drawCloud(page, box, color);
    drawLabel(page, `${sequence}`, box.x, box.y + box.height + 4, color, boldFont);
    drawCommentCallout(page, annotation.message, box.x + 18, box.y + box.height + 4, color, textFont);
    return;
  }

  const pinPoint = drawPin(page, annotation, sequence, color, boldFont);
  drawCommentCallout(page, annotation.message, pinPoint.x + 14, pinPoint.y + 4, color, textFont);
}

function annotationColor(annotation: ApprovalAnnotation) {
  if (annotation.color !== "custom") return colorMap[annotation.color];
  const strokeColor = parseStrokeColor(annotation.styleJson);
  if (!strokeColor) return colorMap.red;
  return rgb(strokeColor.r / 255, strokeColor.g / 255, strokeColor.b / 255);
}

function parseStrokeColor(styleJson: string | null) {
  if (!styleJson) return null;
  try {
    const parsed = JSON.parse(styleJson) as { strokeColor?: unknown };
    if (typeof parsed.strokeColor !== "string") return null;
    const match = parsed.strokeColor.match(customColorPattern);
    if (!match) return null;
    return {
      r: Number.parseInt(match[1], 16),
      g: Number.parseInt(match[2], 16),
      b: Number.parseInt(match[3], 16)
    };
  } catch {
    return null;
  }
}

function toBox(page: PDFPage, annotation: ApprovalAnnotation) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const width = pageWidth * (annotation.widthRatio ?? 0);
  const height = pageHeight * (annotation.heightRatio ?? 0);
  return {
    x: pageWidth * annotation.xRatio,
    y: pageHeight - pageHeight * annotation.yRatio - height,
    width,
    height
  };
}

function toPoint(page: PDFPage, xRatio: number, yRatio: number) {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  return {
    x: pageWidth * xRatio,
    y: pageHeight - pageHeight * yRatio
  };
}

function drawArrow(page: PDFPage, annotation: ApprovalAnnotation, color: RGB) {
  const start = toPoint(page, annotation.xRatio, annotation.yRatio);
  const end = toPoint(page, annotation.endXRatio ?? annotation.xRatio, annotation.endYRatio ?? annotation.yRatio);

  page.drawLine({ start, end, color, thickness: 2 });

  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = 10;
  const headAngle = Math.PI / 7;
  const left = {
    x: end.x - headLength * Math.cos(angle - headAngle),
    y: end.y - headLength * Math.sin(angle - headAngle)
  };
  const right = {
    x: end.x - headLength * Math.cos(angle + headAngle),
    y: end.y - headLength * Math.sin(angle + headAngle)
  };
  page.drawLine({ start: end, end: left, color, thickness: 2 });
  page.drawLine({ start: end, end: right, color, thickness: 2 });
}

function drawInk(page: PDFPage, annotation: ApprovalAnnotation, color: RGB) {
  const points = parseAnnotationPoints(annotation.pointsJson);
  if (points.length < 2) {
    return;
  }

  for (let index = 1; index < points.length; index += 1) {
    page.drawLine({
      start: toPoint(page, points[index - 1].xRatio, points[index - 1].yRatio),
      end: toPoint(page, points[index].xRatio, points[index].yRatio),
      color,
      thickness: 2,
      opacity: 0.92
    });
  }
}

function drawCloud(page: PDFPage, box: { x: number; y: number; width: number; height: number }, color: RGB) {
  const path = createCloudSvgPath(box.width, box.height);
  page.drawSvgPath(path, {
    x: box.x,
    y: box.y,
    borderColor: color,
    borderWidth: 2,
    borderOpacity: 0.92,
    color,
    opacity: 0.04
  });
}

function drawPin(page: PDFPage, annotation: ApprovalAnnotation, sequence: number, color: RGB, boldFont: PDFFont) {
  const point = toPoint(page, annotation.xRatio, annotation.yRatio);
  const radius = 9;
  page.drawEllipse({
    x: point.x,
    y: point.y,
    xScale: radius,
    yScale: radius,
    color,
    borderColor: rgb(1, 1, 1),
    borderWidth: 1
  });
  const label = String(sequence);
  page.drawText(label, {
    x: point.x - boldFont.widthOfTextAtSize(label, 8) / 2,
    y: point.y - 3,
    size: 8,
    font: boldFont,
    color: rgb(1, 1, 1)
  });
  return point;
}

function drawLabel(page: PDFPage, label: string, x: number, y: number, color: RGB, font: PDFFont) {
  page.drawRectangle({
    x,
    y,
    width: Math.max(14, font.widthOfTextAtSize(label, 8) + 8),
    height: 13,
    color
  });
  page.drawText(label, { x: x + 4, y: y + 3, size: 8, font, color: rgb(1, 1, 1) });
}

function drawReviewText(
  page: PDFPage,
  text: string,
  box: { x: number; y: number; width: number; height: number },
  color: RGB,
  textFont: AnnotationTextFont
) {
  const normalized = normalizeAnnotationText(text, textFont.supportsUnicode);
  if (!normalized) return;

  const fontSize = 10;
  const lineHeight = fontSize * 1.22;
  const padding = 5;
  const maxWidth = Math.max(8, box.width - padding * 2);
  const maxLines = Math.max(1, Math.floor((box.height - padding * 2) / lineHeight) + 1);
  const lines = wrapAnnotationText(normalized, textFont.font, fontSize, maxWidth).slice(0, maxLines);
  const startY = box.y + Math.max(padding, box.height - padding - fontSize);

  lines.forEach((line, index) => {
    page.drawText(line, {
      x: box.x + padding,
      y: startY - index * lineHeight,
      size: fontSize,
      font: textFont.font,
      color
    });
  });
}

function drawCommentCallout(page: PDFPage, text: string, x: number, y: number, color: RGB, textFont: AnnotationTextFont) {
  const normalized = normalizeAnnotationText(text, textFont.supportsUnicode);
  if (!normalized) return;

  const { width: pageWidth, height: pageHeight } = page.getSize();
  const fontSize = 9;
  const lineHeight = fontSize * 1.28;
  const paddingX = 5;
  const paddingY = 4;
  const maxWidth = Math.min(150, Math.max(80, pageWidth * 0.28));
  const lines = wrapAnnotationText(normalized, textFont.font, fontSize, maxWidth - paddingX * 2).slice(0, 3);
  if (lines.length === 0) return;

  const textWidth = Math.max(...lines.map((line) => textFont.font.widthOfTextAtSize(line, fontSize)));
  const boxWidth = Math.min(maxWidth, Math.max(30, textWidth + paddingX * 2));
  const boxHeight = lines.length * lineHeight + paddingY * 2;
  const safeX = clamp(x, 2, Math.max(2, pageWidth - boxWidth - 2));
  const safeY = clamp(y, 2, Math.max(2, pageHeight - boxHeight - 2));

  page.drawRectangle({
    x: safeX,
    y: safeY,
    width: boxWidth,
    height: boxHeight,
    color: rgb(1, 1, 1),
    opacity: 0.88,
    borderColor: color,
    borderWidth: 0.8
  });

  lines.forEach((line, index) => {
    page.drawText(line, {
      x: safeX + paddingX,
      y: safeY + boxHeight - paddingY - fontSize - index * lineHeight,
      size: fontSize,
      font: textFont.font,
      color
    });
  });
}

function normalizeAnnotationText(text: string, supportsUnicode: boolean) {
  if (supportsUnicode) return text.replace(/\r\n?/g, "\n").trim().slice(0, 500);
  return text
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function wrapAnnotationText(text: string, font: PDFFont, fontSize: number, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    lines.push(...wrapAnnotationParagraph(trimmed, font, fontSize, maxWidth));
  }
  return lines;
}

function wrapAnnotationParagraph(text: string, font: PDFFont, fontSize: number, maxWidth: number) {
  const lines: string[] = [];
  let current = "";

  for (const char of Array.from(text)) {
    const next = current ? `${current}${char}` : char;
    if (font.widthOfTextAtSize(next, fontSize) <= maxWidth || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = char;
  }

  if (current) lines.push(current);
  return lines;
}

function parseAnnotationPoints(pointsJson: string | null): Array<{ xRatio: number; yRatio: number }> {
  if (!pointsJson) return [];
  try {
    const parsed = JSON.parse(pointsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((point): point is { xRatio: number; yRatio: number } => {
        if (!point || typeof point !== "object") return false;
        const candidate = point as { xRatio?: unknown; yRatio?: unknown };
        return typeof candidate.xRatio === "number" && typeof candidate.yRatio === "number";
      })
      .map((point) => ({
        xRatio: clamp(point.xRatio, 0, 1),
        yRatio: clamp(point.yRatio, 0, 1)
      }));
  } catch {
    return [];
  }
}

function createCloudSvgPath(width: number, height: number) {
  const safeWidth = Math.max(4, width);
  const safeHeight = Math.max(4, height);
  const amplitude = clamp(Math.min(safeWidth, safeHeight) * 0.18, 3, 10);
  const horizontalSegments = Math.max(3, Math.ceil(safeWidth / 32));
  const verticalSegments = Math.max(2, Math.ceil(safeHeight / 26));
  const commands = [`M 0 0`];

  appendCloudSide(commands, { x: 0, y: 0 }, { x: safeWidth, y: 0 }, horizontalSegments, 0, -amplitude);
  appendCloudSide(commands, { x: safeWidth, y: 0 }, { x: safeWidth, y: safeHeight }, verticalSegments, amplitude, 0);
  appendCloudSide(commands, { x: safeWidth, y: safeHeight }, { x: 0, y: safeHeight }, horizontalSegments, 0, amplitude);
  appendCloudSide(commands, { x: 0, y: safeHeight }, { x: 0, y: 0 }, verticalSegments, -amplitude, 0);

  return `${commands.join(" ")} Z`;
}

function appendCloudSide(
  commands: string[],
  start: { x: number; y: number },
  end: { x: number; y: number },
  segments: number,
  controlOffsetX: number,
  controlOffsetY: number
) {
  for (let index = 1; index <= segments; index += 1) {
    const previousRatio = (index - 1) / segments;
    const nextRatio = index / segments;
    const middleRatio = (previousRatio + nextRatio) / 2;
    const control = {
      x: round(start.x + (end.x - start.x) * middleRatio + controlOffsetX),
      y: round(start.y + (end.y - start.y) * middleRatio + controlOffsetY)
    };
    const next = {
      x: round(start.x + (end.x - start.x) * nextRatio),
      y: round(start.y + (end.y - start.y) * nextRatio)
    };
    commands.push(`Q ${control.x} ${control.y} ${next.x} ${next.y}`);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
