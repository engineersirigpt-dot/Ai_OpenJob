import { NextRequest, NextResponse } from "next/server";
import { saveMeeting, listMeetings, type TranscriptTurn } from "@/lib/meeting-history";
import { summarizeMeeting } from "@/lib/summarize";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/meetings — list past meetings (no transcript body)
export async function GET() {
  try {
    return NextResponse.json(listMeetings());
  } catch (error) {
    console.error("[meetings-list-err]", error);
    return NextResponse.json({ error: "ไม่สามารถอ่านประวัติได้" }, { status: 500 });
  }
}

// POST /api/meetings — save a finished meeting (generates summary)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const turns = (Array.isArray(body.transcript) ? body.transcript : []) as TranscriptTurn[];
    const jobIds = (Array.isArray(body.jobIds) ? body.jobIds : []) as string[];
    const jobNames = (Array.isArray(body.jobNames) ? body.jobNames : []) as string[];
    const meetingTitle = String(body.meetingTitle || "");
    const startedAt = body.startedAt ? String(body.startedAt) : null;
    const endedAt = body.endedAt ? String(body.endedAt) : null;

    if (turns.length === 0) {
      return NextResponse.json(
        { error: "ไม่มีบทสนทนาให้บันทึก", code: "EMPTY" },
        { status: 400 },
      );
    }

    const summary = await summarizeMeeting(turns, meetingTitle, jobNames);

    const record = saveMeeting({
      jobIds,
      jobNames,
      meetingTitle,
      startedAt,
      endedAt,
      transcript: turns,
      summary,
    });

    return NextResponse.json(record);
  } catch (error) {
    console.error("[meetings-save-err]", error);
    return NextResponse.json(
      { error: (error as Error).message || "บันทึกไม่สำเร็จ" },
      { status: 500 },
    );
  }
}
