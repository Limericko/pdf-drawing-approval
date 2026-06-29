import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

export type PdfStamp = {
  imagePath: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

export async function generateSignedPdf(input: {
  sourcePdfPath: string;
  outputPdfPath: string;
  stamps: PdfStamp[];
}): Promise<void> {
  const sourceBytes = await fs.readFile(input.sourcePdfPath).catch(() => {
    throw new Error("SOURCE_PDF_NOT_FOUND");
  });
  const pdf = await PDFDocument.load(sourceBytes);
  const pages = pdf.getPages();

  for (const stamp of input.stamps) {
    if (stamp.pageNumber < 1 || stamp.pageNumber > pages.length) {
      throw new Error("PDF_PAGE_OUT_OF_RANGE");
    }

    const imageBytes = await fs.readFile(stamp.imagePath).catch(() => {
      throw new Error("SIGNATURE_IMAGE_NOT_FOUND");
    });
    const image = await pdf.embedPng(imageBytes);
    const page = pages[stamp.pageNumber - 1];
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const width = pageWidth * stamp.widthRatio;
    const height = pageHeight * stamp.heightRatio;
    const x = pageWidth * stamp.xRatio;
    const y = pageHeight - pageHeight * stamp.yRatio - height;

    page.drawImage(image, { x, y, width, height });
  }

  await fs.mkdir(path.dirname(input.outputPdfPath), { recursive: true });
  await fs.writeFile(input.outputPdfPath, await pdf.save());
}
