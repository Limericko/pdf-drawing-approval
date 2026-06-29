import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { generateSignedPdf } from "./signPdf.ts";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");

async function createPdf(filePath: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 300]);
  await fs.writeFile(filePath, await pdf.save());
}

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-signpdf-"));
  const sourcePdfPath = path.join(dir, "source.pdf");
  const outputPdfPath = path.join(dir, "signed.pdf");
  const imagePath = path.join(dir, "signature.png");
  await createPdf(sourcePdfPath);
  await fs.writeFile(imagePath, pngBytes);
  return { dir, sourcePdfPath, outputPdfPath, imagePath };
}

describe("generateSignedPdf", () => {
  it("stamps one PNG into a PDF and writes a valid output PDF", async () => {
    const fixture = await createFixture();
    const sourceSize = (await fs.stat(fixture.sourcePdfPath)).size;

    await generateSignedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      outputPdfPath: fixture.outputPdfPath,
      stamps: [
        { imagePath: fixture.imagePath, pageNumber: 1, xRatio: 0.7, yRatio: 0.8, widthRatio: 0.12, heightRatio: 0.05 }
      ]
    });

    const output = await fs.readFile(fixture.outputPdfPath);
    expect(output.subarray(0, 5).toString()).toBe("%PDF-");
    expect(output.length).toBeGreaterThan(sourceSize);
  });

  it("stamps multiple signatures into the same PDF", async () => {
    const fixture = await createFixture();

    await generateSignedPdf({
      sourcePdfPath: fixture.sourcePdfPath,
      outputPdfPath: fixture.outputPdfPath,
      stamps: [
        { imagePath: fixture.imagePath, pageNumber: 1, xRatio: 0.62, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
        { imagePath: fixture.imagePath, pageNumber: 1, xRatio: 0.74, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 },
        { imagePath: fixture.imagePath, pageNumber: 1, xRatio: 0.86, yRatio: 0.82, widthRatio: 0.1, heightRatio: 0.05 }
      ]
    });

    await expect(fs.stat(fixture.outputPdfPath)).resolves.toBeTruthy();
  });

  it("returns a controlled error for missing signature images", async () => {
    const fixture = await createFixture();

    await expect(
      generateSignedPdf({
        sourcePdfPath: fixture.sourcePdfPath,
        outputPdfPath: fixture.outputPdfPath,
        stamps: [
          {
            imagePath: path.join(fixture.dir, "missing.png"),
            pageNumber: 1,
            xRatio: 0.7,
            yRatio: 0.8,
            widthRatio: 0.12,
            heightRatio: 0.05
          }
        ]
      })
    ).rejects.toThrow("SIGNATURE_IMAGE_NOT_FOUND");
  });

  it("returns a controlled error for out-of-range pages", async () => {
    const fixture = await createFixture();

    await expect(
      generateSignedPdf({
        sourcePdfPath: fixture.sourcePdfPath,
        outputPdfPath: fixture.outputPdfPath,
        stamps: [
          { imagePath: fixture.imagePath, pageNumber: 2, xRatio: 0.7, yRatio: 0.8, widthRatio: 0.12, heightRatio: 0.05 }
        ]
      })
    ).rejects.toThrow("PDF_PAGE_OUT_OF_RANGE");
  });
});
