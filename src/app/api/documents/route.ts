import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { extractTextFromFile } from "@/lib/document-parser";
import { addDocument, listDocuments, removeDocument } from "@/lib/document-store";

export const maxDuration = 60;

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

// GET — list all documents
export async function GET() {
  const docs = listDocuments();
  return NextResponse.json(
    docs.map((d) => ({
      id: d.id,
      name: d.name,
      preview: d.content.slice(0, 200),
      uploadedAt: d.uploadedAt,
    })),
  );
}

// POST — upload a document
export async function POST(req: NextRequest) {
  try {
    await ensureUploadDir();

    const form = await req.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "ไม่พบไฟล์" }, { status: 400 });
    }

    const ext = path.extname(file.name).toLowerCase();
    const supportedExts = [".pdf", ".docx", ".txt", ".md"];
    if (!supportedExts.includes(ext)) {
      return NextResponse.json(
        { error: "รองรับเฉพาะ .pdf, .docx, .txt, .md" },
        { status: 400 },
      );
    }

    const fileId = randomUUID();
    const savePath = path.join(UPLOAD_DIR, `${fileId}${ext}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(savePath, buffer);

    let content = "";
    try {
      content = await extractTextFromFile(savePath);
    } catch (err) {
      console.error("[doc-parse-err]", err);
      return NextResponse.json(
        { error: "ไม่สามารถอ่านเนื้อหาเอกสารได้" },
        { status: 400 },
      );
    }

    if (!content.trim()) {
      return NextResponse.json(
        { error: "เอกสารไม่มีเนื้อหาที่อ่านได้" },
        { status: 400 },
      );
    }

    const doc = addDocument(file.name, content);
    return NextResponse.json({
      id: doc.id,
      name: doc.name,
      preview: content.slice(0, 200),
      uploadedAt: doc.uploadedAt,
    });
  } catch (error) {
    console.error("[doc-upload-err]", error);
    return NextResponse.json(
      { error: (error as Error).message || "Internal error" },
      { status: 500 },
    );
  }
}

// DELETE — remove a document
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }
  const removed = removeDocument(id);
  return NextResponse.json({ ok: removed });
}
