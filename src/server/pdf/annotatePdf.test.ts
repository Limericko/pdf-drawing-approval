import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { ApprovalAnnotation } from "../repositories/approvalAnnotations.ts";
import { generateAnnotatedPdf } from "./annotatePdf.ts";

async function createPdf(filePath: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  pdf.addPage([400, 300]);
  await fs.writeFile(filePath, await pdf.save());
}

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-annotatepdf-"));
  const sourcePdfPath = path.join(dir, "source.pdf");
  await createPdf(sourcePdfPath);
  return { dir, sourcePdfPath };
}

function annotation(input: Partial<ApprovalAnnotation>): ApprovalAnnotation {
  return {
    id: input.id ?? 1,
    approvalId: input.approvalId ?? 1,
    authorUserId: input.authorUserId ?? 1,
    authorUsername: input.authorUsername ?? "supervisor",
    authorDisplayName: input.authorDisplayName ?? "主管",
    authorRole: input.authorRole ?? "supervisor",
    kind: input.kind ?? "rect",
    message: input.message ?? "尺寸需确认",
    pageNumber: input.pageNumber ?? 1,
    xRatio: input.xRatio ?? 0.1,
    yRatio: input.yRatio ?? 0.1,
    widthRatio: input.widthRatio ?? 0.2,
    heightRatio: input.heightRatio ?? 0.1,
    endXRatio: input.endXRatio ?? null,
    endYRatio: input.endYRatio ?? null,
    pointsJson: input.pointsJson ?? null,
    styleJson: input.styleJson ?? null,
    color: input.color ?? "red",
    resolved: input.resolved ?? false,
    resolvedByUserId: input.resolvedByUserId ?? null,
    resolvedAt: input.resolvedAt ?? null,
    createdAt: input.createdAt ?? "2026-06-22T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-22T00:00:00.000Z"
  };
}

describe("generateAnnotatedPdf", () => {
  it("draws review annotations into a valid PDF without changing the source file", async () => {
    const fixture = await createFixture();
    const before = await fs.readFile(fixture.sourcePdfPath);

    const output = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [
        annotation({ id: 1, kind: "rect", message: "矩形框", xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.1 }),
        annotation({ id: 2, kind: "circle", message: "圆圈", xRatio: 0.45, yRatio: 0.1, widthRatio: 0.15, heightRatio: 0.1, color: "blue" }),
        annotation({ id: 3, kind: "arrow", message: "箭头", xRatio: 0.1, yRatio: 0.55, endXRatio: 0.35, endYRatio: 0.7, widthRatio: null, heightRatio: null, color: "amber" }),
        annotation({ id: 4, kind: "text", message: "文字批注", xRatio: 0.45, yRatio: 0.55, widthRatio: 0.25, heightRatio: 0.12, color: "green" }),
        annotation({ id: 5, kind: "pin", message: "定位点", xRatio: 0.8, yRatio: 0.75, widthRatio: null, heightRatio: null }),
        annotation({
          id: 6,
          kind: "ink",
          message: "画笔",
          xRatio: 0.12,
          yRatio: 0.2,
          widthRatio: null,
          heightRatio: null,
          pointsJson: JSON.stringify([
            { xRatio: 0.12, yRatio: 0.2 },
            { xRatio: 0.22, yRatio: 0.25 },
            { xRatio: 0.3, yRatio: 0.2 }
          ]),
          color: "red"
        }),
        annotation({ id: 7, kind: "cloud", message: "云线", xRatio: 0.56, yRatio: 0.68, widthRatio: 0.24, heightRatio: 0.14, color: "blue" })
      ]
    });

    expect(Buffer.from(output).subarray(0, 5).toString()).toBe("%PDF-");
    expect(output.length).toBeGreaterThan(before.length);
    await expect(PDFDocument.load(output)).resolves.toBeTruthy();
    await expect(fs.readFile(fixture.sourcePdfPath)).resolves.toEqual(before);
  });

  it("uses ink points and cloud bounds when rendering review annotations", async () => {
    const fixture = await createFixture();
    const before = await fs.readFile(fixture.sourcePdfPath);

    const shortInk = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [
        annotation({
          kind: "ink",
          xRatio: 0.1,
          yRatio: 0.2,
          widthRatio: null,
          heightRatio: null,
          pointsJson: JSON.stringify([
            { xRatio: 0.1, yRatio: 0.2 },
            { xRatio: 0.2, yRatio: 0.22 }
          ])
        })
      ]
    });
    const longInk = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [
        annotation({
          kind: "ink",
          xRatio: 0.1,
          yRatio: 0.2,
          widthRatio: null,
          heightRatio: null,
          pointsJson: JSON.stringify([
            { xRatio: 0.1, yRatio: 0.2 },
            { xRatio: 0.5, yRatio: 0.22 },
            { xRatio: 0.7, yRatio: 0.5 }
          ])
        })
      ]
    });
    const smallCloud = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [annotation({ kind: "cloud", xRatio: 0.25, yRatio: 0.25, widthRatio: 0.1, heightRatio: 0.08 })]
    });
    const largeCloud = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [annotation({ kind: "cloud", xRatio: 0.25, yRatio: 0.25, widthRatio: 0.32, heightRatio: 0.18 })]
    });

    expect(Buffer.compare(Buffer.from(shortInk), Buffer.from(longInk))).not.toBe(0);
    expect(Buffer.compare(Buffer.from(smallCloud), Buffer.from(largeCloud))).not.toBe(0);
    await expect(PDFDocument.load(shortInk)).resolves.toBeTruthy();
    await expect(PDFDocument.load(largeCloud)).resolves.toBeTruthy();
    await expect(fs.readFile(fixture.sourcePdfPath)).resolves.toEqual(before);
  });

  it("uses custom annotation colors from style metadata in review PDFs", async () => {
    const fixture = await createFixture();
    const redOutput = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [annotation({ kind: "rect", color: "red", styleJson: null })]
    });
    const customOutput = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [annotation({ kind: "rect", color: "custom", styleJson: JSON.stringify({ strokeColor: "#7c3aed" }) })]
    });

    expect(Buffer.compare(Buffer.from(redOutput), Buffer.from(customOutput))).not.toBe(0);
    await expect(PDFDocument.load(customOutput)).resolves.toBeTruthy();
  });

  it("keeps Chinese text annotation content in review PDFs", async () => {
    const fixture = await createFixture();

    const chineseTextOutput = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [annotation({ kind: "text", message: "中文批注内容", widthRatio: 0.25, heightRatio: 0.12 })]
    });
    const emptyTextOutput = await generateAnnotatedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      annotations: [annotation({ kind: "text", message: "   ", widthRatio: 0.25, heightRatio: 0.12 })]
    });

    expect(Buffer.compare(Buffer.from(chineseTextOutput), Buffer.from(emptyTextOutput))).not.toBe(0);
    expect(chineseTextOutput.length).toBeGreaterThan(emptyTextOutput.length);
    await expect(PDFDocument.load(chineseTextOutput)).resolves.toBeTruthy();
  });

  it("keeps non-text annotation comments in review PDFs", async () => {
    const fixture = await createFixture();
    const cases: Array<{ kind: ApprovalAnnotation["kind"]; input: Partial<ApprovalAnnotation> }> = [
      { kind: "pin", input: { xRatio: 0.12, yRatio: 0.16, widthRatio: null, heightRatio: null } },
      { kind: "rect", input: { xRatio: 0.16, yRatio: 0.2, widthRatio: 0.2, heightRatio: 0.1 } },
      { kind: "circle", input: { xRatio: 0.22, yRatio: 0.24, widthRatio: 0.16, heightRatio: 0.1 } },
      {
        kind: "arrow",
        input: { xRatio: 0.12, yRatio: 0.48, endXRatio: 0.32, endYRatio: 0.62, widthRatio: null, heightRatio: null }
      },
      {
        kind: "ink",
        input: {
          xRatio: 0.14,
          yRatio: 0.3,
          widthRatio: null,
          heightRatio: null,
          pointsJson: JSON.stringify([
            { xRatio: 0.14, yRatio: 0.3 },
            { xRatio: 0.22, yRatio: 0.32 }
          ])
        }
      },
      { kind: "cloud", input: { xRatio: 0.42, yRatio: 0.42, widthRatio: 0.22, heightRatio: 0.14 } }
    ];

    for (const item of cases) {
      const withComment = await generateAnnotatedPdf({
        sourcePdfPath: fixture.sourcePdfPath,
        annotations: [annotation({ ...item.input, kind: item.kind, message: `${item.kind}批注内容` })]
      });
      const withoutComment = await generateAnnotatedPdf({
        sourcePdfPath: fixture.sourcePdfPath,
        annotations: [annotation({ ...item.input, kind: item.kind, message: "   " })]
      });

      expect(Buffer.compare(Buffer.from(withComment), Buffer.from(withoutComment)), item.kind).not.toBe(0);
      expect(withComment.length, item.kind).toBeGreaterThan(withoutComment.length);
      await expect(PDFDocument.load(withComment)).resolves.toBeTruthy();
    }
  });

  it("rejects annotations outside the source PDF page range", async () => {
    const fixture = await createFixture();

    await expect(
      generateAnnotatedPdf({
        sourcePdfPath: fixture.sourcePdfPath,
        annotations: [annotation({ pageNumber: 3 })]
      })
    ).rejects.toThrow("PDF_PAGE_OUT_OF_RANGE");
  });
});
