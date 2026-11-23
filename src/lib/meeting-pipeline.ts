import { getMeeting, updateMeetingResult, type TranscriptTurn } from "@/lib/meeting-history";
import { listParts, readPart } from "@/lib/recordings";
import { transcribePiece } from "@/lib/transcribe-piece";
import { reconcileTranscript } from "@/lib/reconcile-transcript";
import { summarizeMeeting, type SummaryDoc } from "@/lib/summarize";
import { keepThaiOnly, isForeignHallucination } from "@/lib/thai-text";
import { loadJobDocsForSummary } from "@/lib/job-docs";

/**
 * Finishes a meeting after it has been saved.
 *
 * Ending a meeting used to mean waiting: the browser transcribed the
 * recording piece by piece, cross-checked it against the live transcript,
 * and only then saved and summarized — two to three minutes of a spinner
 * for an eight-minute meeting, during which the room could do nothing. The
 * room asked for that step to be removed. It is the step that turned ten
 * characters into 2,882 on the same meeting, so instead of removing it,
 * it moved: the browser now stores the pieces, saves at once with the live
 * transcript, and shows the room its summary; this runs on the server after
 * the response has gone out and upgrades the record in place — the
 * recording's transcript, the cross-checked text, and minutes rewritten
 * from it. The page polls and swaps the upgrade in when it lands.
 *
 * Every step is best-effort and the record is never left "processing": if
 * the recording cannot be read or the model fails, the minutes are written
 * from the live transcript and the record is marked done with a note.
 */
export async function processMeeting(id: string, docsIn: SummaryDoc[]): Promise<void> {
  let docs = docsIn;
  const t0 = Date.now();
  const record = getMeeting(id);
  if (!record) return;

  const liveText = record.transcript
    .filter((t) => t.kind === "room")
    .map((t) => t.text)
    .join(" ")
    .trim();

  // 1. The recording, piece by piece, in order.
  let rawFile = "";
  let rawFileNote = "";
  const parts = record.recordingId ? listParts(record.recordingId) : [];
  if (parts.length === 0) {
    rawFileNote = "ไม่มีไฟล์เสียงที่เก็บไว้ให้ถอด — ใช้บทถอดสดเป็นบทสนทนา";
  } else {
    const texts: string[] = [];
    const problems: string[] = [];
    for (const p of parts) {
      const buf = readPart(record.recordingId, p.part);
      if (!buf) {
        problems.push(`ส่วนที่ ${p.part + 1}: อ่านไฟล์ไม่ได้`);
        continue;
      }
      const result = await transcribePiece(new Blob([new Uint8Array(buf)], { type: "audio/webm" }), `meeting-part-${p.part + 1}.webm`);
      if (!result) {
        problems.push(`ส่วนที่ ${p.part + 1}: เซิร์ฟเวอร์ถอดไม่สำเร็จ`);
        continue;
      }
      if (result.text) texts.push(result.text);
      else problems.push(`ส่วนที่ ${p.part + 1}: ${result.dropped.join(", ") || "โมเดลไม่ได้ยินคำพูด"}`);
    }
    rawFile = texts.join(" ").replace(/\s{2,}/g, " ").trim();
    if (!rawFile) {
      const mb = (parts.reduce((t, p) => t + p.bytes, 0) / 1048576).toFixed(2);
      rawFileNote =
        `ส่งไฟล์เสียง ${parts.length} ส่วน (${mb}MB) ไปถอดแล้ว แต่ไม่ได้ข้อความกลับมา` +
        (problems.length ? ` — ${problems.join(", ")}` : "");
    } else if (problems.length) {
      rawFileNote = `บางส่วนถอดไม่ได้: ${problems.join(", ")}`;
    }
  }

  // 2. Cross-check the two passes; the result becomes the record. The
  //    recording is continuous, so it also holds พรชัย's answers and any
  //    question spoken into the mic — both already their own turns, so they
  //    are listed for removal from the room's block.
  let roomText = rawFile || liveText;
  if (rawFile && liveText) {
    try {
      const exclude = record.transcript
        .filter((t) => t.speaker === "assistant" || t.kind === "ask")
        .map((t) => t.text.trim())
        .filter(Boolean);
      const context = [record.meetingTitle, ...record.jobNames].filter(Boolean).join(" — ");
      const r = await reconcileTranscript(rawFile, liveText, exclude, context);
      if (r.text) {
        roomText = r.text;
        console.log(`[pipeline] reconcile ${r.windows} ช่วง — แก้ ${r.corrected}, ตีกลับ ${r.rejected}`);
      }
    } catch (err) {
      console.error("[pipeline] reconcile", (err as Error).message);
    }
  }

  // 3. The transcript of record: the room's block replaced, everything else
  //    (questions, answers) kept in place — the same shape the page builds.
  const transcript = replaceRoomTurns(record.transcript, roomText);

  // 4. Minutes, from the final transcript and the documents snapshotted at
  //    save time (the store is cleared by then). An OK-job meeting whose
  //    snapshot came back empty — the store was cleared early, or the ids
  //    were stale — gets its WI pulled again by Job ID, the way "สรุปใหม่"
  //    does, rather than minutes that open with "0 งาน".
  if (docs.length === 0 && record.mode === "okjob" && record.jobIds.length > 0) {
    try {
      docs = await loadJobDocsForSummary(record.jobIds);
    } catch (err) {
      console.error("[pipeline] job docs", (err as Error).message);
    }
  }
  let summary = "";
  try {
    summary = await summarizeMeeting(transcript, record.meetingTitle, record.jobNames, docs, record.mode, {
      marks: record.marks,
      rawLive: record.rawLive,
    });
  } catch (err) {
    console.error("[pipeline] summary", (err as Error).message);
  }

  updateMeetingResult(id, {
    transcript,
    rawFile,
    rawFileNote,
    summary: summary || record.summary,
    status: "done",
  });
  console.log(
    `[pipeline] ${id.slice(0, 8)} เสร็จ: ไฟล์ ${rawFile.length} ตัวอักษร, บทสนทนา ${roomText.length}, ` +
      `สรุป ${summary.length} ใน ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}

/** Replace the room's turns with one block of `text`, keeping the rest in order. */
function replaceRoomTurns(turns: TranscriptTurn[], text: string): TranscriptTurn[] {
  const clean = keepThaiOnly(text).replace(/\s+/g, " ").trim();
  if (!clean || isForeignHallucination(clean)) return turns;
  const at = turns.findIndex((t) => t.kind === "room");
  const sequence = turns.reduce((m, t) => Math.max(m, t.sequence), 0) + 1;
  const block: TranscriptTurn = {
    speaker: "user",
    text: clean,
    kind: "room",
    sequence,
    timestamp: new Date().toISOString(),
  };
  const kept = turns.filter((t) => t.kind !== "room");
  if (at < 0) return [block, ...kept];
  const before = turns.slice(0, at).filter((t) => t.kind !== "room");
  const after = turns.slice(at).filter((t) => t.kind !== "room");
  return [...before, block, ...after];
}

/**
 * Run the pipeline after the response has been sent, and never let it throw
 * into the request. A failure here still marks the record done, with the
 * minutes the save already wrote, so nothing stays "processing" forever.
 */
export function processMeetingInBackground(id: string, docs: SummaryDoc[]): void {
  setTimeout(() => {
    processMeeting(id, docs).catch((err) => {
      console.error("[pipeline] failed", id, (err as Error).message);
      try {
        updateMeetingResult(id, { status: "done", rawFileNote: `ประมวลผลเบื้องหลังล้มเหลว: ${(err as Error).message}` });
      } catch {
        // nothing more to do
      }
    });
  }, 0);
}
