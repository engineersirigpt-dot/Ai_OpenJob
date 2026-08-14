"use client";

import { useEffect, useState, useCallback } from "react";
import {
  History,
  Loader2,
  RefreshCw,
  ChevronRight,
  Clock,
  Briefcase,
  Trash2,
  FileText,
  Copy,
  Download,
  Printer,
} from "lucide-react";
import { MeetingMinutes } from "@/components/meeting-minutes";
import {
  formatMeetingMinutes,
  minutesFilename,
  downloadText,
  printMinutes,
} from "@/lib/format-minutes";

interface MeetingSummary {
  id: string;
  jobIds: string[];
  jobNames: string[];
  meetingTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  turnCount: number;
  summary: string;
  createdAt: string;
}

interface TranscriptTurn {
  speaker: "user" | "assistant";
  text: string;
  sequence: number;
  timestamp: string;
}

interface MeetingDetail extends MeetingSummary {
  transcript: TranscriptTurn[];
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return "-";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} นาที ${s} วิ` : `${s} วินาที`;
}

export function MeetingHistory({ refreshKey }: { refreshKey: number }) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/meetings")
      .then((r) => r.json())
      .then((d) => setMeetings(Array.isArray(d) ? d : []))
      .catch(() => setMeetings([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function openDetail(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/meetings/${id}`);
      setDetail(res.ok ? await res.json() : null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function remove(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("ลบประวัติการประชุมนี้?")) return;
    await fetch(`/api/meetings/${id}`, { method: "DELETE" });
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
    }
    setMeetings((m) => m.filter((x) => x.id !== id));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <History className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          ประวัติการประชุม
          <span className="text-xs text-slate-500 dark:text-slate-400">({meetings.length})</span>
        </h2>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          รีเฟรช
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-slate-500 dark:text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : meetings.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          ยังไม่มีประวัติการประชุม — เริ่มประชุมแล้วกด &ldquo;จบประชุม&rdquo; เพื่อบันทึก
        </div>
      ) : (
        <div className="space-y-2">
          {meetings.map((m) => {
            const isOpen = openId === m.id;
            return (
              <div
                key={m.id}
                className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => openDetail(m.id)}
                  className="w-full text-left p-4 hover:bg-slate-200 dark:hover:bg-slate-800/30 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <ChevronRight
                      className={`h-4 w-4 mt-0.5 shrink-0 text-slate-500 dark:text-slate-400 transition-transform ${
                        isOpen ? "rotate-90" : ""
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {m.meetingTitle || "ประชุม (ไม่มีหัวข้อ)"}
                        </span>
                        {m.jobIds.map((j) => (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1 rounded-md bg-purple-500/15 border border-purple-500/30 px-1.5 py-0.5 text-[11px] font-mono text-purple-700 dark:text-purple-300"
                          >
                            <Briefcase className="h-2.5 w-2.5" />
                            {j}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                        <span>{fmtDateTime(m.startedAt || m.createdAt)}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {fmtDuration(m.durationSec)}
                        </span>
                        <span>{m.turnCount} เทิร์น</span>
                      </div>
                      {m.summary && !isOpen && (
                        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                          {m.summary}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => remove(m.id, e)}
                      className="text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 shrink-0"
                      aria-label="ลบ"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-200 dark:border-slate-800 p-4 space-y-4">
                    {detailLoading || !detail ? (
                      <div className="flex justify-center py-6 text-slate-500 dark:text-slate-400">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    ) : (
                      <>
                        {/* Summary */}
                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <h4 className="text-xs font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                              <FileText className="h-3.5 w-3.5" />
                              สรุปการประชุม
                            </h4>
                            {detail.summary && (
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    navigator.clipboard?.writeText(formatMeetingMinutes(detail))
                                  }
                                  className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                                >
                                  <Copy className="h-3 w-3" />
                                  คัดลอก
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    downloadText(minutesFilename(detail), formatMeetingMinutes(detail))
                                  }
                                  className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                                >
                                  <Download className="h-3 w-3" />
                                  .txt
                                </button>
                                <button
                                  type="button"
                                  onClick={() => printMinutes(detail)}
                                  className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                                >
                                  <Printer className="h-3 w-3" />
                                  PDF
                                </button>
                              </div>
                            )}
                          </div>
                          {detail.summary ? (
                            <MeetingMinutes summary={detail.summary} />
                          ) : (
                            <p className="text-xs text-slate-500 dark:text-slate-400">(ไม่มีสรุป)</p>
                          )}
                        </div>

                        {/* Transcript */}
                        <div>
                          <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                            บทสนทนา ({detail.transcript.length})
                          </h4>
                          <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                            {detail.transcript.map((t) => (
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
                                    t.speaker === "assistant"
                                      ? "text-purple-700 dark:text-purple-300"
                                      : "text-slate-500 dark:text-slate-400"
                                  }`}
                                >
                                  {t.speaker === "assistant" ? "AI" : "ผู้ประชุม"}:{" "}
                                </span>
                                <span className="text-slate-600 dark:text-slate-300">{t.text}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
