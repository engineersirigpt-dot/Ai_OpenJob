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
  Sparkles,
} from "lucide-react";
import { MeetingReport } from "@/components/meeting-report";
import {
  formatMeetingMinutes,
  minutesFilename,
  downloadText,
  printMinutes,
} from "@/lib/format-minutes";

interface MeetingSummary {
  id: string;
  mode?: "okjob" | "pornchai" | "car";
  jobIds: string[];
  jobNames: string[];
  meetingTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  turnCount: number;
  summary: string;
  /** "processing" while the server is still finishing the record after the save. */
  status?: "processing" | "done";
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
  /** The recording transcribed in one pass, before cross-checking. */
  rawFile?: string;
  /** What the live pass heard during the meeting, before cross-checking. */
  rawLive?: string;
  /** Why the recording produced no text, when it produced none. */
  rawFileNote?: string;
  /** Where the room's audio is kept, when it was kept. */
  recordingId?: string;
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
  // Sub-tab: history is split per assistant mode
  const [modeTab, setModeTab] = useState<"okjob" | "pornchai" | "car">("okjob");
  const [resummarizing, setResummarizing] = useState(false);

  /** Old meetings were summarized with an earlier prompt (numbered sections);
   *  this rewrites the summary from the stored transcript. */
  async function resummarize(id: string) {
    setResummarizing(true);
    try {
      const res = await fetch(`/api/meetings/${id}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.summary) {
        setDetail((d) => (d && d.id === id ? { ...d, summary: data.summary } : d));
        setMeetings((ms) => ms.map((m) => (m.id === id ? { ...m, summary: data.summary } : m)));
      }
    } finally {
      setResummarizing(false);
    }
  }

  const modeOf = (m: MeetingSummary) =>
    m.mode === "pornchai" ? "pornchai" : m.mode === "car" ? "car" : "okjob";
  const shown = meetings.filter((m) => modeOf(m) === modeTab);
  const countOf = (id: string) => meetings.filter((m) => modeOf(m) === id).length;

  /**
   * The figures at the top of a mode: how much has actually been recorded in
   * it. Totals of what is stored, not estimates — a mode with one short
   * meeting should look different from one with twenty long ones.
   */
  const totalSeconds = shown.reduce((t, m) => t + (m.durationSec || 0), 0);
  const totalTurns = shown.reduce((t, m) => t + (m.turnCount || 0), 0);
  const latest = shown
    .map((m) => m.startedAt || m.createdAt)
    .filter(Boolean)
    .sort()
    .pop();
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.round((totalSeconds % 3600) / 60);

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

  /**
   * A record the server is still finishing shows up here within seconds of
   * the meeting ending, before its minutes exist. While any is in that
   * state the list is refreshed every ten seconds, and an open detail of
   * one is refetched, so the finished record appears without a reload.
   */
  const anyProcessing = meetings.some((m) => m.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const timer = setInterval(() => {
      load();
      if (openId && detail?.status === "processing") {
        fetch(`/api/meetings/${openId}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && d.id === openId) setDetail(d);
          })
          .catch(() => {});
      }
    }, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyProcessing, openId, detail?.status, load]);

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
          <span className="text-xs text-slate-500 dark:text-slate-400">({shown.length})</span>
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

      <div className="flex flex-col sm:flex-row gap-4">
        {/* The modes, as the page's own menu */}
        <aside className="w-full sm:w-52 shrink-0 space-y-1">
          {(
              [
                ["okjob", "ประชุมงาน OK"],
                ["pornchai", "พรชัยผู้ช่วยประชุม"],
                ["car", "สอบสวน CAR"],
              ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setModeTab(id);
                setOpenId(null);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition ${
                modeTab === id
                  ? "bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/40"
                  : "border border-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60"
              }`}
            >
              <span>{label}</span>
              <span className="text-[10.5px] font-normal text-slate-400 dark:text-slate-500">
                {countOf(id)}
              </span>
            </button>
          ))}
        </aside>

        <div className="flex-1 min-w-0 space-y-3">
          {/* What this mode has recorded so far */}
          {!loading && shown.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  ["ประชุมทั้งหมด", `${shown.length}`, "ครั้ง"],
                  ["เวลารวม", hours > 0 ? `${hours}:${String(mins).padStart(2, "0")}` : `${mins}`, hours > 0 ? "ชม." : "นาที"],
                  ["บทสนทนารวม", `${totalTurns.toLocaleString("th-TH")}`, "รายการ"],
                  [
                    "ประชุมล่าสุด",
                    latest
                      ? new Date(latest).toLocaleDateString("th-TH", { day: "numeric", month: "short" })
                      : "—",
                    latest ? new Date(latest).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "",
                  ],
                ] as const
              ).map(([label, value, unit]) => (
                <div
                  key={label}
                  className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2.5"
                >
                  <p className="text-[10.5px] text-slate-500 dark:text-slate-400">{label}</p>
                  <p className="mt-0.5 flex items-baseline gap-1">
                    <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {value}
                    </span>
                    {unit && (
                      <span className="text-[10.5px] text-slate-500 dark:text-slate-400">{unit}</span>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-500 dark:text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : shown.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
              ยังไม่มีประวัติการประชุมในโหมดนี้ — เริ่มประชุมแล้วกด &ldquo;จบประชุม&rdquo; เพื่อบันทึก
            </div>
          ) : (
            <div className="space-y-2">
              {shown.map((m) => {
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
                          {m.status === "processing" && !isOpen && (
                            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              กำลังถอดไฟล์เสียงและเขียนสรุปอยู่เบื้องหลัง…
                            </p>
                          )}
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
                                      onClick={() => resummarize(detail.id)}
                                      disabled={resummarizing}
                                      title="เขียนสรุปใหม่จากบทสนทนา ด้วยรูปแบบปัจจุบัน (ข้อความเดียว)"
                                      className="flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 px-2 py-1 text-[11px] text-purple-700 dark:text-purple-300 hover:bg-purple-500/20 disabled:opacity-50"
                                    >
                                      {resummarizing ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : (
                                        <Sparkles className="h-3 w-3" />
                                      )}
                                      สรุปใหม่
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
                              {detail.status === "processing" && (
                                <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200">
                                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                                  กำลังถอดไฟล์เสียงและเขียนสรุปฉบับเต็มอยู่เบื้องหลัง — หน้านี้จะอัปเดตเองเมื่อเสร็จ
                                </div>
                              )}
                              {detail.summary ? (
                                <MeetingReport
                                  meetingTitle={detail.meetingTitle}
                                  jobIds={detail.jobIds}
                                  startedAt={detail.startedAt}
                                  endedAt={detail.endedAt}
                                  summary={detail.summary}
                                  turns={detail.transcript}
                                  rawFile={detail.rawFile}
                                  rawLive={detail.rawLive}
                                  fileNote={detail.rawFileNote}
                                  recordingId={detail.recordingId}
                                />
                              ) : (
                                <p className="text-xs text-slate-500 dark:text-slate-400">(ไม่มีสรุป)</p>
                              )}
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
      </div>
    </div>
  );
}
