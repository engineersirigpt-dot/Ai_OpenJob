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

  if (e === ".xlsx" || e === ".xls") {
    const { read, utils } = await import("xlsx");
    const wb = read(buffer, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const csv = utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
      if (csv.trim()) parts.push(`### ชีต: ${name}\n${csv.trim()}`);
    }
    return parts.join("\n\n");
  }

  if (e === ".txt" || e === ".md" || e === ".csv") {
    return buffer.toString("utf-8");
  }

  throw new Error(`ไม่รองรับไฟล์ประเภท ${ext} — รองรับเฉพาะ .pdf, .docx, .xlsx, .txt, .md, .csv`);
}

export async function extractTextFromFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);
  return extractTextFromBuffer(buffer, ext);
}
