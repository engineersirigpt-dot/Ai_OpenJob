"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { TranscriptTurn } from "@/hooks/use-transcript";

interface TranscriptFeedProps {
  turns: TranscriptTurn[];
  isAiResponding: boolean;
  liveUserText?: string;
  /**
   * jobId → the job's WI digest (customer, quantity, delivery, CAR/PAR), for
   * the card drawn where the room confirmed that job.
   */
  jobDigests?: Record<string, string>;
  liveAiText?: string;
  /** Two-tier brain is composing an answer (shown as a chat bubble). */
  thinking?: boolean;
  /** Display name for the assistant ("AI" or "พรชัย"). */
  aiName?: string;
  /** Stage mode: no card chrome (meeting screen on a TV). */
  bare?: boolean;
  /** In a meeting: the first slice of speech has not come back yet. */
  waitingForChunk?: boolean;
}

export function TranscriptFeed({
  turns,
  isAiResponding,
  liveUserText = "",
  jobDigests = {},
  liveAiText = "",
  thinking = false,
  aiName = "AI",
  bare = false,
  waitingForChunk = false,
}: TranscriptFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const shown = turns;

  useEffect(() => {
    // Scroll only the chat container — never the page (keeps header/controls fixed)
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, liveUserText, liveAiText, thinking]);

  return (
    <div
      ref={containerRef}
      className={`flex flex-col gap-3 h-[55vh] lg:h-full min-h-0 overflow-y-auto ${
        bare
          ? "px-1 py-2"
          : "p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800"
      }`}
      role="log"
      aria-live="polite"
    >
      {shown.length === 0 && !isAiResponding && !liveAiText && !thinking && (
        <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          {waitingForChunk
            ? `${aiName}กำลังฟังอยู่ — ข้อความจะขึ้นเรื่อย ๆ ระหว่างประชุม`
            : `กดเริ่มประชุมเพื่อให้${aiName}เริ่มฟัง`}
        </p>
      )}

      {shown.map((turn, i) => {
        // A confirm card: the room pressed confirm on this job in REPORT2 at
        // this moment, so everything above it since the previous card is
        // this job's talk. The card names the job and shows its WI digest
        // beside the words — the meeting as the room asked to read it:
        // speech, then the job and its documents, then on to the next.
        const mark = turn.kind === "room" && turn.label === "confirm"
          ? /^✓ ยืนยันงาน (\S+) (.*?) เวลา (\d{1,2}:\d{2})(?: — (.*))?$/.exec(turn.text)
          : null;
        if (mark) {
          const [, jobId, jobName, at, remark] = mark;
          const digest = (jobDigests[jobId] || "")
            .split("\n")
            .filter((l) => /^(ลูกค้า|จำนวน|วันที่ OK|สเปคสำคัญ|CAR \/ ปัญหา)/.test(l.trim()))
            .map((l) => l.replace(/\s*\([^)]*\)\s*:/, ":").trim())
            .slice(0, 5);
          return (
            <div
              key={i}
              className="w-full self-stretch rounded-2xl border border-emerald-300 bg-emerald-50/70 px-4 py-3 dark:border-emerald-800/60 dark:bg-emerald-950/25"
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:text-emerald-300">✓ ยืนยันงาน {at}</span>
                <span className="font-mono text-sm font-semibold text-emerald-900 dark:text-emerald-100">{jobId}</span>
                <span className="min-w-0 truncate text-sm text-slate-800 dark:text-slate-100">{jobName}</span>
              </div>
              {remark && <p className="mt-1 text-[13px] text-slate-700 dark:text-slate-200">หมายเหตุที่กด confirm: {remark}</p>}
              {digest.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-[12px] leading-snug text-slate-600 dark:text-slate-300">
                  {digest.map((l, k) => (
                    <li key={k} className="truncate" title={l}>{l}</li>
                  ))}
                </ul>
              )}
              <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">↑ บทสนทนาด้านบน (ตั้งแต่ใบก่อนหน้า) เป็นของงานนี้</p>
            </div>
          );
        }
        return (
        <div
          key={i}
          className={`rounded-2xl ${
            bare ? "p-3.5 text-[14px] sm:text-[15px] leading-[1.75] max-w-[92%]" : "p-3 text-sm max-w-[85%]"
          } ${
            turn.speaker === "assistant"
              ? "bg-purple-500/10 border border-purple-500/30 self-start"
              : "bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 self-end"
          }`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider opacity-70">
            {turn.speaker === "assistant" ? aiName : turn.kind === "ask" ? "คำถาม" : turn.label || "ที่ประชุม"}
          </span>
          <p className="mt-1 text-slate-900 dark:text-slate-100">{turn.text}</p>
        </div>
        );
      })}

      {liveAiText && (
        <div className="max-w-[85%] self-start rounded-xl border border-purple-500/40 bg-purple-500/10 p-3 text-sm">
          <span className="text-[10px] font-medium uppercase tracking-wider text-purple-700 dark:text-purple-300">
            {aiName} · กำลังพูด
          </span>
          <p className="mt-1 text-slate-900 dark:text-slate-100">{liveAiText}</p>
        </div>
      )}

      {liveUserText && (
        <div className="max-w-[85%] self-end rounded-xl border border-pink-500/40 bg-slate-50 p-3 text-sm dark:bg-slate-800/40">
          <span className="text-[10px] font-medium uppercase tracking-wider text-pink-600 dark:text-pink-300">
            ที่ประชุม · กำลังพูด
          </span>
          <p className="mt-1 italic text-slate-700 dark:text-slate-200">{liveUserText}</p>
        </div>
      )}

      {thinking && (
        <div className="max-w-[85%] self-start rounded-xl border border-purple-500/40 bg-purple-500/10 p-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-purple-700 dark:text-purple-300">
            {aiName}
          </span>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-600 dark:text-purple-400" />
            กำลังคิดคำตอบ...
          </p>
        </div>
      )}

      {isAiResponding && !liveAiText && !thinking && (
        <div className="self-start rounded-xl border border-purple-500/30 bg-purple-500/10 p-3 animate-pulse">
          <span className="text-[10px] text-slate-500 dark:text-slate-400">{aiName} กำลังคิด...</span>
        </div>
      )}

    </div>
  );
}
