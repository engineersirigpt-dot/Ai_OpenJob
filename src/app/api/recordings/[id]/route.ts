import { NextRequest, NextResponse } from "next/server";
import { listParts, readPart, deleteRecording, KEEP_RECORDINGS, RETENTION_DAYS } from "@/lib/recordings";

export const runtime = "nodejs";

/**
 * GET  /api/recordings/<id>            → which pieces exist, and how big
 * GET  /api/recordings/<id>?part=0     → that piece, as playable audio
 * DELETE /api/recordings/<id>          → delete the whole recording now
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const partParam = req.nextUrl.searchParams.get("part");

  if (partParam === null) {
    return NextResponse.json({
      parts: listParts(id),
      keeping: KEEP_RECORDINGS,
      retentionDays: RETENTION_DAYS,
    });
  }

  const buf = readPart(id, Number(partParam));
  if (!buf) {
    return NextResponse.json({ error: "ไม่พบไฟล์เสียงส่วนนี้" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "audio/webm",
      "Content-Length": String(buf.length),
      // The audio never changes once written, and it must not be shared.
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="meeting-part-${partParam}.webm"`,
    },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ ok: deleteRecording(id) });
}
