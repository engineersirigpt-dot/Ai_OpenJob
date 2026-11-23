import { NextRequest, NextResponse } from "next/server";
import { savePart } from "@/lib/recordings";
import { transcribePiece, type PieceResult } from "@/lib/transcribe-piece";

export const runtime = "nodejs";
export const maxDuration = 300; // a long piece takes a while to transcribe

/**
 * POST /api/transcribe-file
 *
 * One recorded piece of a meeting, as multipart form data:
 *   file         the audio (webm/opus, as the browser cut it)
 *   recordingId  where to keep it on disk, with
 *   part         its index in the recording
 *   store        "1" = keep it and return at once, without transcribing
 *
 * The browser sends every piece with store=1 when a meeting ends, so the
 * room is not kept waiting on the model; the server transcribes the kept
 * pieces afterwards (see meeting-pipeline.ts). Without store=1 the piece is
 * transcribed here and now — what "สรุปใหม่" and the tests use.
 */
export interface FileTurn {
  speaker: string;
  text: string;
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "ไม่พบไฟล์เสียง" }, { status: 400 });
  }

  // Keep the audio first: the recording is worth having even when the model
  // returns nothing, and the browser only sends it once.
  const recordingId = String(form?.get("recordingId") || "").trim();
  const part = Number(form?.get("part") ?? NaN);
  let stored = false;
  if (recordingId && Number.isInteger(part)) {
    stored = await savePart(recordingId, part, file);
  }

  if (String(form?.get("store") || "") === "1") {
    if (!stored) {
      return NextResponse.json(
        { error: "เก็บไฟล์เสียงไม่ได้ — ต้องมี recordingId และ KEEP_RECORDINGS ต้องไม่ปิด" },
        { status: 400 },
      );
    }
    return NextResponse.json({ stored: true, part, bytes: file.size });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY ไม่ได้ตั้งค่า" }, { status: 500 });
  }

  const result: PieceResult | null = await transcribePiece(file, file.name || "segment.webm");
  if (!result) {
    return NextResponse.json({ error: "ถอดเสียงไฟล์ไม่สำเร็จ" }, { status: 502 });
  }

  // The record is one running block: everything said in this stretch becomes a
  // single turn. A new block is started later only by a question or an answer.
  const turns: FileTurn[] = result.text ? [{ speaker: "ผู้ประชุม", text: result.text }] : [];
  return NextResponse.json({
    turns,
    text: turns.map((t) => `${t.speaker}: ${t.text}`).join("\n"),
    diarized: false,
    // Diagnostics, so a stretch that produced no text can always say why.
    heard: result.heard.slice(0, 300),
    dropped: result.dropped.length > 0 ? result.dropped.join(" | ") : undefined,
    retriedWithoutHint: result.retriedWithoutHint,
  });
}
