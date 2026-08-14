import fs from "fs/promises";
import path from "path";

/**
 * Extract plain text from a document buffer.
 * Shared by file uploads and remote (REPORT2 WI PDF) fetches.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  ext: string,
): Promise<string> {
  const e = ext.toLowerCase();

  if (e === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy();
    }
  }

  if (e === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (e === ".txt" || e === ".md") {
    return buffer.toString("utf-8");
  }

  throw new Error(`ไม่รองรับไฟล์ประเภท ${ext} — รองรับเฉพาะ .pdf, .docx, .txt, .md`);
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);
  return extractTextFromBuffer(buffer, ext);
}
