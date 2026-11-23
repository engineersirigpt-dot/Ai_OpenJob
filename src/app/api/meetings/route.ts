import { NextRequest, NextResponse } from "next/server";
import { saveMeeting, listMeetings, type TranscriptTurn } from "@/lib/meeting-history";
import { summarizeMeeting, generateMeetingTitle, type SummaryDoc } from "@/lib/summarize";
import type { ConfirmMark } from "@/lib/meeting-history";
import { processMeetingInBackground } from "@/lib/meeting-pipeline";
import { extractMemories, addMemories } from "@/lib/pornchai-memory";
import { getDocument } from "@/lib/document-store";

export const runtime = "nodejs";
export const maxDuration = 120;

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
    let meetingTitle = String(body.meetingTitle || "");
    const startedAt = body.startedAt ? String(body.startedAt) : null;
    // The two passes the record was cross-checked from, kept for auditing.
    const rawFile = body.rawFile ? String(body.rawFile) : "";
    const rawLive = body.rawLive ? String(body.rawLive) : "";
    const rawFileNote = body.rawFileNote ? String(body.rawFileNote).slice(0, 500) : "";
    const recordingId = body.recordingId ? String(body.recordingId).slice(0, 64) : "";
    const endedAt = body.endedAt ? String(body.endedAt) : null;
    const mode =
      body.mode === "pornchai"
        ? ("pornchai" as const)
        : body.mode === "car"
          ? ("car" as const)
          : ("okjob" as const);

    if (turns.length === 0) {
      return NextResponse.json(
        { error: "ไม่มีบทสนทนาให้บันทึก", code: "EMPTY" },
        { status: 400 },
      );
    }

    // พรชัย mode: replace the generic auto title ("ประชุมศิริวัฒนา <วันที่>")
    // with a contextual one from the actual conversation + date/time. A title
    // the user typed themselves is left untouched.
    const autoTitled =
      !meetingTitle ||
      meetingTitle.startsWith("ประชุมศิริวัฒนา") ||
      meetingTitle.startsWith("สอบสวน CAR");
    if (mode !== "okjob" && autoTitled) {
      try {
        const topic = await generateMeetingTitle(turns);
        if (topic) {
          const d = startedAt ? new Date(startedAt) : new Date();
          const dateStr = d.toLocaleDateString("th-TH", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "Asia/Bangkok",
          });
          const timeStr = d.toLocaleTimeString("th-TH", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Bangkok",
          });
          meetingTitle = `${topic} — ${dateStr} ${timeStr} น.`;
        }
      } catch (err) {
        console.error("[title-err]", err);
      }
    }

    // Documents still loaded in the meeting. For an OK-job meeting they are
    // the agenda — one WI per job — and the minutes are written against
    // them (best-effort; ids may be stale on a delayed retry save, in which
    // case they simply resolve to nothing).
    const docIds = (Array.isArray(body.docIds) ? body.docIds : []) as string[];
    const docs: SummaryDoc[] = docIds
      .map((id) => getDocument(id))
      .filter((d): d is NonNullable<ReturnType<typeof getDocument>> => Boolean(d))
      .map((d) => ({ name: d.name, content: d.content, summary: d.summary }));

    /**
     * pending = the browser has stored the recording and wants its record
     * now, not after the model: the summary is left for the pipeline, which
     * transcribes the kept pieces, cross-checks, and writes the minutes
     * after this response has gone out. The documents are snapshotted here
     * because the browser clears the store the moment the save returns.
     */
    const pending = body.pending === true;
    // Confirm presses the room saw (OK-job meetings): the line between one
    // job's talk and the next's. Validated field by field — this comes from
    // the browser.
    const marks: ConfirmMark[] = (Array.isArray(body.marks) ? body.marks : [])
      .filter((m: unknown) => m && typeof m === "object")
      .map((m: Record<string, unknown>) => ({
        jobId: String(m.jobId || "").slice(0, 20),
        jobName: String(m.jobName || "").slice(0, 200),
        at: String(m.at || "").slice(0, 40),
        ...(m.remark ? { remark: String(m.remark).slice(0, 500) } : {}),
        ...(m.manual ? { manual: true } : {}),
      }))
      .filter((m: ConfirmMark) => m.jobId && m.at)
      .slice(0, 200);
    const summary = pending
      ? ""
      : await summarizeMeeting(turns, meetingTitle, jobNames, docs, mode, { marks, rawLive });

    // Knowledge meetings (พรชัย / CAR) feed long-term memory. OK-job meetings
    // happen daily and would flood it with operational trivia.
    if (mode !== "okjob") {
      try {
        const facts = await extractMemories(turns, meetingTitle);
        if (facts.length > 0) {
          const added = addMemories(facts, meetingTitle || "การประชุม");
          console.log(`[pornchai-memory] remembered ${added} new fact(s)`);
        }
      } catch (err) {
        console.error("[pornchai-memory]", err);
      }
    }

    const record = saveMeeting({
      mode,
      jobIds,
      jobNames,
      meetingTitle,
      startedAt,
      endedAt,
      transcript: turns,
      summary,
      rawFile,
      rawLive,
      rawFileNote,
      recordingId,
      docIds,
      status: pending ? "processing" : "done",
      marks,
    });
    if (pending) processMeetingInBackground(record.id, docs);

    return NextResponse.json(record);
  } catch (error) {
    console.error("[meetings-save-err]", error);
    return NextResponse.json(
      { error: (error as Error).message || "บันทึกไม่สำเร็จ" },
      { status: 500 },
    );
  }
}
