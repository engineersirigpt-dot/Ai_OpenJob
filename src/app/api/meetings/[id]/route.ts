import { NextRequest, NextResponse } from "next/server";
import { getMeeting, deleteMeeting, updateSummary } from "@/lib/meeting-history";
import { summarizeMeeting, type SummaryDoc } from "@/lib/summarize";
import { getDocument, listDocuments } from "@/lib/document-store";
import { loadJobDocsForSummary } from "@/lib/job-docs";

export const runtime = "nodejs";
export const maxDuration = 300; // re-pulling twenty WI documents, then the summary

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

// POST /api/meetings/:id — rewrite the summary from the stored transcript
// (old meetings were summarized with an earlier prompt).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const record = getMeeting(id);
  if (!record) {
    return NextResponse.json({ error: "ไม่พบการประชุม" }, { status: 404 });
  }
  // The documents the meeting ran with. The store is emptied when a meeting
  // ends, so by the time anyone presses "สรุปใหม่" the ids usually resolve to
  // nothing; whatever is still there by id or by Job ID in the name is used,
  // and for an OK-job meeting the rest of the agenda is pulled again from
  // REPORT2 by Job ID (see job-docs.ts).
  let docs: SummaryDoc[] = record.docIds
    .map((id) => getDocument(id))
    .filter((d): d is NonNullable<ReturnType<typeof getDocument>> => Boolean(d))
    .map((d) => ({ name: d.name, content: d.content, summary: d.summary }));
  if (docs.length === 0 && record.mode === "okjob") {
    const keys = [...record.jobIds, ...record.jobNames].filter((k) => k.length >= 4);
    docs = listDocuments()
      .filter((d) => keys.some((k) => d.name.includes(k)))
      .map((d) => ({ name: d.name, content: d.content, summary: d.summary }));
  }
  if (docs.length === 0 && record.mode === "okjob" && record.jobIds.length > 0) {
    docs = await loadJobDocsForSummary(record.jobIds);
  }
  const summary = await summarizeMeeting(
    record.transcript,
    record.meetingTitle,
    record.jobNames,
    docs,
    record.mode,
    { marks: record.marks, rawLive: record.rawLive },
  );
  if (!summary) {
    return NextResponse.json({ error: "สรุปใหม่ไม่สำเร็จ" }, { status: 502 });
  }
  updateSummary(id, summary);
  return NextResponse.json({ ok: true, summary });
}
