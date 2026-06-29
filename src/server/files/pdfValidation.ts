import fs from "node:fs/promises";

const pdfHeader = Buffer.from("%PDF-");

export async function hasPdfHeader(filePath: string) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(pdfHeader.length);
    const { bytesRead } = await handle.read(buffer, 0, pdfHeader.length, 0);
    return bytesRead === pdfHeader.length && buffer.equals(pdfHeader);
  } finally {
    await handle.close();
  }
}
