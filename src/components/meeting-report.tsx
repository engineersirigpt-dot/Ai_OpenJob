"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { isMinutesHeading } from "@/lib/format-minutes";

/**
 * The meeting summary: one box holding the summary text and, folded away
 * beneath it, the conversation it came from — in the three versions the room
 * knows them by:
 *
 *   บทสนทนาในไฟล์เสียง        the recording, transcribed after the meeting
 *   บทสนทนาในห้องประชุม (ถอดสด) what was read on screen as people talked
 *   บทสนทนาสรุปโดย AI          the two above cross-checked into the record
 *
 * The first two are wrong in different places, which is the point of keeping
 * them: when someone questions a CAR number or an amount, what each pass
 * actually heard has to be there to look at.
 */

export interface ReportTurn {
  speaker: string;
  text: string;
  sequence?: number;
  label?: string;
}

interface MeetingReportProps {
  /** Carried for the PDF/txt exports; the box itself shows no header meta. */
  meetingTitle?: string;
  jobIds?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
  modeLabel?: string;
  summary: string;
  turns?: ReportTurn[];
  withTranscript?: boolean;
  /** The recording transcribed in one pass, before cross-checking. */
  rawFile?: string;
  /** What the live pass heard during the meeting, before cross-checking. */
  rawLive?: string;
  /** Why the recording produced no text, when it produced none. */
  fileNote?: string;
  /** Where the room's audio is kept, when it was kept. */
  recordingId?: string;
}

interface RecordingPart {
  part: number;
  bytes: number;
}

/**
 * The room's audio, to listen to again.
 *
 * It is kept in the pieces it was recorded in rather than stitched into one
 * file, so each piece plays on its own; nothing is loaded until the section
 * is opened, because a long meeting is tens of megabytes. A recording that
 * has passed its retention window is simply gone, and the section says so
 * rather than showing a player that will not play.
 */
function RecordingPlayer({ recordingId }: { recordingId: string }) {
  const [parts, setParts] = useState<RecordingPart[] | null>(null);
  const [retention, setRetention] = useState(0);
  // Deleting the audio cannot be undone, so the button asks first.
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/recordings/${recordingId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setParts([]);
    } catch {
      setError("ลบไฟล์เสียงไม่สำเร็จ");
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }

  useEffect(() => {
    let alive = true;
    fetch(`/api/recordings/${recordingId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setParts(Array.isArray(d.parts) ? d.parts : []);
        setRetention(Number(d.retentionDays) || 0);
      })
      .catch(() => alive && setParts([]));
    return () => {
      alive = false;
    };
  }, [recordingId]);

  if (parts === null) {
    return <p className="text-[13px] text-slate-500 dark:text-slate-400">กำลังโหลด…</p>;
  }
  if (parts.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 p-3 text-[13px] text-slate-600 dark:text-slate-300">
        ไม่มีไฟล์เสียงของการประชุมนี้แล้ว
        {retention > 0 ? ` — ระบบลบไฟล์เสียงอัตโนมัติเมื่อเก็บไว้เกิน ${retention} วัน` : ""}
      </p>
    );
  }

  const totalMb = parts.reduce((t, p) => t + p.bytes, 0) / 1048576;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-slate-500 dark:text-slate-400">
          {parts.length} ส่วน · รวม {totalMb.toFixed(1)} MB
          {retention > 0 ? ` · ลบอัตโนมัติเมื่อเก็บเกิน ${retention} วัน` : ""}
        </p>
        {confirming ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[12px] text-rose-700 dark:text-rose-300">
              ลบถาวร ฟังย้อนหลังไม่ได้อีก
            </span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-lg bg-rose-500 hover:bg-rose-400 disabled:opacity-50 px-3 py-1 text-[12px] font-semibold text-white"
            >
              {deleting ? "กำลังลบ…" : "ยืนยันลบ"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1 text-[12px] font-medium text-slate-600 dark:text-slate-300"
            >
              ยกเลิก
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1 text-[12px] font-medium text-rose-700 dark:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            ลบไฟล์เสียง
          </button>
        )}
      </div>
      {error && <p className="text-[12px] text-rose-600 dark:text-rose-400">{error}</p>}
      {parts.map((p, i) => (
        <div key={p.part} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11.5px] text-slate-500 dark:text-slate-400">
            ส่วนที่ {i + 1}
          </span>
          <audio
            controls
            preload="metadata"
            src={`/api/recordings/${recordingId}?part=${p.part}`}
            className="h-9 w-full min-w-0"
          />
        </div>
      ))}
    </div>
  );
}

/** A title line the model sometimes writes — our own heading already says it. */
const REDUNDANT_TITLE = /^(รายงาน)?\s*สรุป(ผล)?(การ)?ประชุม[^\n]{0,60}$/;

/** Paragraphs stay apart; older summaries may still carry headings/bullets. */
function renderBody(summary: string) {
  const lines = summary
    .split("\n")
    .map((l) => l.replace(/\*\*/g, "").replace(/\s+$/, ""))
    .filter((l, i, arr) => {
      // drop a leading report title (and the blank line after it)
      const firstReal = arr.findIndex((x) => x.trim());
      return !(i === firstReal && REDUNDANT_TITLE.test(l.trim()));
    });

  const out: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flush = (key: string) => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${key}`} className="my-3 space-y-2">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2.5 text-[14px] leading-[1.8] text-slate-700 dark:text-slate-200">
            <span className="mt-[2px] select-none text-purple-600 dark:text-purple-400">•</span>
            <span className="min-w-0">{b}</span>
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) {
      flush(String(i));
      return;
    }
    if (/^[-•*]\s/.test(t)) {
      bullets.push(t.replace(/^[-•*]\s/, ""));
      return;
    }
    flush(String(i));
    if (/^\d+[.)]\s/.test(t) || /[:：]$/.test(t) || isMinutesHeading(t)) {
      out.push(
        <p key={i} className="mt-5 mb-1.5 text-[14.5px] font-semibold text-slate-900 dark:text-slate-100">
          {t}
        </p>,
      );
    } else {
      out.push(
        <p key={i} className="mb-3.5 text-[14px] leading-[1.8] text-slate-700 dark:text-slate-200">
          {t}
        </p>,
      );
    }
  });
  flush("end");
  return out;
}

/** One foldable section of the conversation. */
function Fold({
  title,
  note,
  count,
  children,
}: {
  title: string;
  note?: string;
  count?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-7">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 text-left text-[17px] font-semibold text-slate-900 dark:text-slate-100 hover:text-purple-700 dark:hover:text-purple-300"
      >
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        {title}
        {count && (
          <span className="text-[14px] font-normal text-slate-500 dark:text-slate-400">
            ({count})
          </span>
        )}
      </button>
      {open && (
        <div className="mt-3">
          {note && (
            <p className="mb-3 text-[12.5px] leading-relaxed text-slate-500 dark:text-slate-400">
              {note}
            </p>
          )}
          {children}
        </div>
      )}
    </section>
  );
}

export function MeetingReport({
  summary,
  turns = [],
  withTranscript = true,
  rawFile = "",
  rawLive = "",
  fileNote = "",
  recordingId = "",
}: MeetingReportProps) {

  return (
    <div className="w-full rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6">
      <section>
        {summary.trim() ? (
          renderBody(summary)
        ) : (
          <p className="text-[15px] text-slate-500 dark:text-slate-400">(ไม่มีสรุป)</p>
        )}
      </section>

      {withTranscript && recordingId.trim() && (
        <Fold
          title="ไฟล์เสียงต้นฉบับ"
          note="เสียงจริงในห้องประชุม กดเล่นเพื่อฟังย้อนหลัง"
        >
          <RecordingPlayer recordingId={recordingId.trim()} />
        </Fold>
      )}

      {withTranscript && (rawFile.trim() || fileNote.trim()) && (
        <Fold
          title="บทสนทนาในไฟล์เสียง"
          count={
            rawFile.trim()
              ? `${rawFile.trim().length.toLocaleString("th-TH")} ตัวอักษร`
              : "ไม่มีข้อความ"
          }
          note="ถอดจากไฟล์เสียงที่อัดไว้ หลังจบประชุม ประโยคลื่น แต่ตัวเลขและชื่ออาจเพี้ยน"
        >
          {rawFile.trim() ? (
            <p className="whitespace-pre-wrap text-[13.5px] leading-[1.75] text-slate-600 dark:text-slate-300">
              {rawFile.trim()}
            </p>
          ) : (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[13px] leading-[1.7] text-amber-800 dark:text-amber-200">
              {fileNote.trim()}
            </p>
          )}
        </Fold>
      )}

      {withTranscript && rawLive.trim() && (
        <Fold
          title="บทสนทนาในห้องประชุม (ถอดสด)"
          count={`${rawLive.trim().length.toLocaleString("th-TH")} ตัวอักษร`}
          note="ถอดสดระหว่างประชุม ตัวเลขและชื่อแม่น แต่ประโยคขาด"
        >
          <p className="whitespace-pre-wrap text-[13.5px] leading-[1.75] text-slate-600 dark:text-slate-300">
            {rawLive.trim()}
          </p>
        </Fold>
      )}

      {withTranscript && turns.length > 0 && (
        <Fold
          title="บทสนทนาสรุปโดย AI"
          count={`${turns.length} รายการ`}
          note="AI เทียบสองชุดข้างบนแล้วแก้คำผิด ชุดนี้คือตัวที่ใช้เขียนบทสรุป"
        >
          <div className="space-y-2.5">
            {turns.map((t, i) => (
              <p
                key={t.sequence ?? i}
                className="text-[13.5px] leading-[1.75] text-slate-700 dark:text-slate-200"
              >
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {t.speaker === "assistant" ? "พรชัย" : t.label || "ผู้ประชุม"}:
                </span>{" "}
                {t.text}
              </p>
            ))}
          </div>
        </Fold>
      )}

    </div>
  );
}
