"use client";

import { useState } from "react";
import {
  FileText,
  X,
  Clock,
  Briefcase,
  Loader2,
  ChevronDown,
  History as HistoryIcon,
  Sparkles,
  Copy,
  Download,
  Check,
  Printer,
} from "lucide-react";
import { MeetingMinutes } from "@/components/meeting-minutes";
import {
  formatMeetingMinutes,
  minutesFilename,
  downloadText,
  printMinutes,
} from "@/lib/format-minutes";

interface TranscriptTurn {
  speaker: "user" | "assistant";
  text: string;
  sequence: number;
  timestamp: string;
}

interface MeetingSummaryModalProps {
  open: boolean;
  loading: boolean;
  error?: string;
  meetingTitle: string;
  jobIds: string[];
  startedAt: string | null;
  endedAt: string | null;
  turns: TranscriptTurn[];
  summary: string;
  onClose: () => void;
  onViewHistory: () => void;
  onRetry?: () => void;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "-";
  const sec = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} นาที ${s} วิ` : `${s} วินาที`;
}

export function MeetingSummaryModal({
  open,
  loading,
  error,
  meetingTitle,
  jobIds,
  startedAt,
  endedAt,
  turns,
  summary,
  onClose,
  onViewHistory,
  onRetry,
}: MeetingSummaryModalProps) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const minutesMeta = { meetingTitle, jobIds, startedAt, endedAt, summary };
  const hasSummary = summary.trim().length > 0;

  function handleCopy() {
    navigator.clipboard?.writeText(formatMeetingMinutes(minutesMeta)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleDownload() {
    downloadText(minutesFilename(minutesMeta), formatMeetingMinutes(minutesMeta));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-4">
          <h3 className="flex items-center gap-2 text-base font-bold text-purple-700 dark:text-purple-300">
            <Sparkles className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            สรุปการประชุม
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label="ปิด"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Title + jobs */}
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-lg font-semibold">
                {meetingTitle || "ประชุม (ไม่มีหัวข้อ)"}
              </span>
              {jobIds.map((j) => (
                <span
                  key={j}
                  className="inline-flex items-center gap-1 rounded-md bg-purple-500/15 border border-purple-500/30 px-1.5 py-0.5 text-[11px] font-mono text-purple-700 dark:text-purple-300"
                >
                  <Briefcase className="h-2.5 w-2.5" />
                  {j}
                </span>
              ))}
            </div>
            <div className="mt-1.5 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
              <span>{fmtTime(startedAt)} → {fmtTime(endedAt)}</span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtDuration(startedAt, endedAt)}
              </span>
              <span>{turns.length} เทิร์น</span>
            </div>
          </div>

          {/* Summary */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                สรุปโดย AI
              </h4>
              {hasSummary && !loading && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                  >
                    {copied ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3 w-3" />}
                    {copied ? "คัดลอกแล้ว" : "คัดลอก"}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                  >
                    <Download className="h-3 w-3" />
                    .txt
                  </button>
                  <button
                    type="button"
                    onClick={() => printMinutes(minutesMeta)}
                    className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                  >
                    <Printer className="h-3 w-3" />
                    PDF
                  </button>
                </div>
              )}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 rounded-md bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                กำลังให้ AI สรุปการประชุม...
              </div>
            ) : error ? (
              <div className="rounded-md bg-rose-500/10 border border-rose-500/30 px-3 py-2.5 space-y-2">
                <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex items-center gap-1.5 rounded-md bg-rose-500 hover:bg-rose-400 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    ลองบันทึกใหม่
                  </button>
                )}
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  ระบบสำรองบทสนทนาไว้แล้ว จะลองบันทึกอัตโนมัติอีกครั้งเมื่อเปิดหน้าใหม่
                </p>
              </div>
            ) : hasSummary ? (
              <MeetingMinutes summary={summary} />
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">(ไม่มีสรุป)</p>
            )}
          </div>

          {/* Transcript (collapsible) */}
          {turns.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowTranscript((s) => !s)}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showTranscript ? "rotate-180" : ""}`}
                />
                บทสนทนาทั้งหมด ({turns.length})
              </button>
              {showTranscript && (
                <div className="mt-2 space-y-1.5 max-h-72 overflow-y-auto pr-1">
                  {turns.map((t) => (
                    <div
                      key={t.sequence}
                      className={`rounded-lg px-3 py-2 text-xs ${
                        t.speaker === "assistant"
                          ? "bg-purple-500/10 border border-purple-500/20"
                          : "bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700"
                      }`}
                    >
                      <span
                        className={`font-semibold ${
                          t.speaker === "assistant" ? "text-purple-700 dark:text-purple-300" : "text-slate-500 dark:text-slate-400"
                        }`}
                      >
                        {t.speaker === "assistant" ? "AI" : "ผู้ประชุม"}:{" "}
                      </span>
                      <span className="text-slate-600 dark:text-slate-300">{t.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-3">
          <button
            type="button"
            onClick={onViewHistory}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            <HistoryIcon className="h-4 w-4" />
            ดูในประวัติ
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-purple-500 hover:bg-purple-400 px-4 py-2 text-sm font-semibold text-white"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
}
