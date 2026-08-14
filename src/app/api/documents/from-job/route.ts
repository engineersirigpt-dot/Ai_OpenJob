import { NextRequest, NextResponse } from "next/server";
import { extractTextFromBuffer } from "@/lib/document-parser";
import { addDocument, listDocuments } from "@/lib/document-store";
import { digestWiDocument } from "@/lib/digest";
import { fetchWiPdf, JOB_ID_RE } from "@/lib/report2";

export const maxDuration = 60;

/**
 * POST /api/documents/from-job
 * Body: { jobId: string }
 *
 * Pulls the job's WI PDF from REPORT2, extracts text, and registers it as a
 * meeting document so the AI can read it. Returns 404 (code WI_NOT_FOUND) when
 * the job has no WI PDF — the UI then asks the user to upload manually.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jobId = String(body.jobId || "").trim().toUpperCase();

    if (!JOB_ID_RE.test(jobId)) {
      return NextResponse.json(
        { error: "Job ID ไม่ถูกต้อง (รูปแบบเช่น J22600086)" },
        { status: 400 },
      );
    }

    const name = `${jobId}.pdf`;

    // Skip if this job's document is already loaded
    const existing = listDocuments().find((d) => d.name === name);
    if (existing) {
      return NextResponse.json({
        id: existing.id,
        name: existing.name,
        preview: existing.content.slice(0, 200),
        summary: existing.summary,
        uploadedAt: existing.uploadedAt,
        alreadyLoaded: true,
      });
    }

    const wi = await fetchWiPdf(jobId);
    if (!wi) {
      return NextResponse.json(
        {
          error: `ไม่พบไฟล์ WI ของงาน ${jobId} ในระบบ — กรุณาอัปโหลดเอกสารเอง`,
          code: "WI_NOT_FOUND",
        },
        { status: 404 },
      );
    }

    let content = "";
    try {
      content = await extractTextFromBuffer(wi.buffer, ".pdf");
    } catch (err) {
      console.error("[from-job-parse-err]", err);
      return NextResponse.json(
        { error: "อ่านเนื้อหา WI PDF ไม่สำเร็จ — กรุณาอัปโหลดเอง", code: "PARSE_FAIL" },
        { status: 422 },
      );
    }

    if (!content.trim()) {
      return NextResponse.json(
        {
          error: "WI PDF ไม่มีข้อความที่อ่านได้ (อาจเป็นไฟล์สแกน) — กรุณาอัปโหลดเอง",
          code: "NO_TEXT",
        },
        { status: 422 },
      );
    }

    // Distill the WI into a compact digest now (at pull time) so the realtime
    // session can load it cheaply. Best-effort — empty digest is fine.
    const summary = await digestWiDocument(name, content);
    const doc = addDocument(name, content, summary);
    return NextResponse.json({
      id: doc.id,
      name: doc.name,
      preview: content.slice(0, 200),
      summary,
      uploadedAt: doc.uploadedAt,
    });
  } catch (error) {
    console.error("[from-job-err]", error);
    return NextResponse.json(
      { error: (error as Error).message || "Internal error" },
      { status: 500 },
    );
  }
}
