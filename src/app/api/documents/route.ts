import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { extractTextFromBuffer } from "@/lib/document-parser";
import { addDocument, listDocuments, removeDocument, clearDocuments } from "@/lib/document-store";
import { digestWiDocument } from "@/lib/digest";

export const maxDuration = 60;

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

// POST — upload a document (parsed in-memory, no file left on disk)
export async function POST(req: NextRequest) {
  try {
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

    const buffer = Buffer.from(await file.arrayBuffer());

    let content = "";
    try {
      content = await extractTextFromBuffer(buffer, ext);
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

    const summary = await digestWiDocument(file.name, content);
    const doc = addDocument(file.name, content, summary);
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

// DELETE — remove one document (?id=), or clear ALL when no id is given
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    clearDocuments();
    return NextResponse.json({ ok: true, cleared: "all" });
  }
  const removed = removeDocument(id);
  return NextResponse.json({ ok: removed });
}
