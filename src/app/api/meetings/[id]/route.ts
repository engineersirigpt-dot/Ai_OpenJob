import { NextRequest, NextResponse } from "next/server";
import { getMeeting, deleteMeeting } from "@/lib/meeting-history";

export const runtime = "nodejs";

// GET /api/meetings/:id — full meeting record (with transcript)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const record = getMeeting(id);
  if (!record) {
    return NextResponse.json({ error: "ไม่พบการประชุม" }, { status: 404 });
  }
  return NextResponse.json(record);
}

// DELETE /api/meetings/:id
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json({ ok: deleteMeeting(id) });
}
