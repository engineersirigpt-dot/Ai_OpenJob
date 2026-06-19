import fs from "fs/promises";
import path from "path";

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const buffer = await fs.readFile(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text || "";
    } finally {
      await parser.destroy();
    }
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (ext === ".txt" || ext === ".md") {
    return await fs.readFile(filePath, "utf-8");
  }

  throw new Error(`ไม่รองรับไฟล์ประเภท ${ext} — รองรับเฉพาะ .pdf, .docx, .txt, .md`);
}
