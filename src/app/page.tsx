"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Mic,
  MicOff,
  MessageSquare,
  HelpCircle,
  Loader2,
  Sparkles,
  Send,
  X,
  Radio,
  History,
  Lightbulb,
  FileText,
  Bug,
  Check,
  Target,
  Zap,
  FolderPlus,
  ArrowRight,
  ArrowLeft,
  Brain,
  VolumeX,
  Trash2,
} from "lucide-react";
import { PornchaiMemoryPanel } from "@/components/pornchai-memory-panel";
import { useWebRTC, type RealtimeSessionConfig } from "@/hooks/use-webrtc";
import { useTranscript } from "@/hooks/use-transcript";
import { useTranscriber, type TranscribedSegment } from "@/hooks/use-transcriber";
import { useRecorder } from "@/hooks/use-recorder";
import { TranscriptFeed } from "@/components/transcript-feed";
import { ListeningWave } from "@/components/listening-wave";
import { DocumentUpload } from "@/components/document-upload";
import { JobPicker, type JobCatalogItem } from "@/components/job-picker";
import { MeetingHistory } from "@/components/meeting-history";
import { AiAvatar } from "@/components/ai-avatar";
import { MeetingSummaryModal } from "@/components/meeting-summary-modal";
import { DebugPanel, type DebugLogEntry } from "@/components/debug-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  buildCommentPrompt,
  buildVoiceQuestionInstruction,
  buildMultiCarPrompt,
  buildMultiCommentPrompt,
  buildFreeTalkPrompt,
} from "@/lib/prompts";
import { matchJobMention } from "@/lib/job-match";
import type { TranscriptTurn, ConfirmMark } from "@/lib/meeting-history";
import { orderForSession, sessionForHour } from "@/lib/ok-session";

type MeetingState = "idle" | "connecting" | "listening" | "error";

interface DocumentInfo {
  id: string;
  name: string;
  preview: string;
  uploadedAt: string;
  /** The WI digest (customer, quantity, delivery, CAR/PAR) when the server made one. */
  summary?: string;
}

// localStorage key for a meeting that failed to save (recovered on next load)
const PENDING_MEETING_KEY = "ai_openjob_pending_meeting";

// Auto-pull mode: how many on-demand documents to keep loaded before evicting
// the least-recently-mentioned one.
const AUTO_CACHE_MAX = 6;

/** The three meeting modes. พรชัย is the assistant in all of them. */
type ModeId = "okjob" | "pornchai" | "car";
const MODE_LABEL: Record<ModeId, string> = {
  okjob: "ประชุมงาน OK",
  pornchai: "พรชัยผู้ช่วยประชุม",
  car: "สอบสวน CAR",
};
const MODE_CHIP: Record<ModeId, string> = MODE_LABEL;
/** Modes whose documents are uploaded by hand (vs pulled from REPORT2). */
const usesUploads = (m: ModeId | null) => m === "pornchai" || m === "car";

// Default meeting title based on the time of day (morning vs afternoon session).
function autoMeetingTitle(mode: ModeId | null = "okjob"): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
  const period = now.getHours() < 12 ? "ช่วงเช้า" : "ช่วงบ่าย";
  const prefix =
    mode === "pornchai" ? "ประชุมศิริวัฒนา" : mode === "car" ? "สอบสวน CAR" : "ประชุม OK งาน";
  return `${prefix} ${dateStr} ${period}`;
}

/** OK-job documents are the WI PDFs pulled from REPORT2 (J########.pdf). */
const isJobDoc = (name: string) => /^J\d{8}\.pdf$/i.test(name);

export default function MeetingPage() {
  const [state, setState] = useState<MeetingState>("idle");
  const [error, setError] = useState("");
  // On-screen debug panel (for diagnosing on machines without dev tools)
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLog, setDebugLog] = useState<DebugLogEntry[]>([]);
  const debugOpenRef = useRef(false);
  // Inline multi-select job picker for CAR / comment when multiple docs loaded
  const [picker, setPicker] = useState<"car" | "comment" | null>(null);
  const [pickerSel, setPickerSel] = useState<string[]>([]);
  const [meetingTitle, setMeetingTitle] = useState("");
  // Assistant mode — chosen on the landing page before anything else.
  // null = not chosen yet (prep/meeting tabs hidden until it is).
  const [assistantMode, setAssistantMode] = useState<ModeId | null>(null);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [jobNameById, setJobNameById] = useState<Record<string, string>>({});
  // Job the meeting is currently talking about — auto-detected from speech.
  const [focusJobId, setFocusJobId] = useState<string | null>(null);
  // Auto-pull mode: the day's job catalog (NOT pulled yet); documents are
  // fetched on demand when a Job ID is spoken, then evicted when stale.
  const [autoPull, setAutoPull] = useState(false);
  const [catalog, setCatalog] = useState<JobCatalogItem[]>([]);
  /**
   * Confirm presses seen during this meeting (OK-job mode).
   *
   * The person at the keyboard opens each job's WI as the room asks and
   * presses confirm in REPORT2 when that job is settled, so the press is
   * the line between one job's talk and the next's. The page polls
   * REPORT2 while the meeting runs, and each new press becomes a mark: a
   * marker line in the live transcript at that moment, and an entry saved
   * with the meeting for the minutes writer. Nothing changes for the
   * person pressing — one source of truth, REPORT2, nothing to press here.
   */
  const [marks, setMarks] = useState<ConfirmMark[]>([]);
  const marksRef = useRef<ConfirmMark[]>([]);
  /** jobId → confirmed, as of the last poll; the baseline is taken at meeting start. */
  const confirmSnapshotRef = useRef<Map<string, boolean> | null>(null);
  /** The job the room is probably on now: the next unconfirmed one in list order. */
  /** What the first read of REPORT2 found: proof the column is being read. */
  const pullingRef = useRef<Set<string>>(new Set());
  const lastSeenRef = useRef<Record<string, number>>({});
  // Per-job auto-pull status for an honest badge: "pulling" | "error".
  const [pullState, setPullState] = useState<Record<string, "pulling" | "error">>({});
  const [showQuestionBox, setShowQuestionBox] = useState(false);
  const [questionPhase, setQuestionPhase] = useState<"idle" | "recording" | "confirming">("idle");
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [liveQuestionText, setLiveQuestionText] = useState("");
  const [aiThinking, setAiThinking] = useState(false);
  // The user cancelled the answer in progress (voice + text both stop).
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [typedQuestion, setTypedQuestion] = useState("");
  const [questionTimedOut, setQuestionTimedOut] = useState(false);
  const [activeTab, setActiveTab] = useState<"home" | "live" | "prep" | "history" | "memory">("home");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  // Post-meeting summary modal
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  /** Shown while the server is still finishing the saved record. */
  const [processingNote, setProcessingNote] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [summarySaved, setSummarySaved] = useState(false);
  const pendingPayloadRef = useRef<Record<string, unknown> | null>(null);
  const [endedMeta, setEndedMeta] = useState<{ meetingTitle: string; jobIds: string[]; startedAt: string | null; endedAt: string | null }>({
    meetingTitle: "",
    jobIds: [],
    startedAt: null,
    endedAt: null,
  });
  const sessionConfigRef = useRef<RealtimeSessionConfig | null>(null);
  const startedAtRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const {
    turns,
    isAiResponding,
    liveUserText,
    setLiveUserText,
    liveAiText,
    handleRealtimeEvent,
    addUserTurn,
    addRoomTurns,
    replaceRoomTranscript,
    reset: resetTranscript,
  } = useTranscript();
  const {
    start: startTranscriber,
    stop: stopTranscriber,
    setPaused: setTranscriberPaused,
    startQuestion,
    finishQuestion,
    cancelQuestion,
    resumeMeeting,
  } = useTranscriber();
  const [transcribing, setTranscribing] = useState(false);

  const onDataChannelMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        // Surface Realtime API errors instead of failing silently
        if (data.type === "error") {
          const code = data.error?.code || "";
          // benign: auto-transcription commits a silent/empty buffer — ignore
          if (code !== "input_audio_buffer_commit_empty") {
            console.error("[realtime error]", data);
            setError(`AI ขัดข้อง: ${data.error?.message || code || "ไม่ทราบสาเหตุ"}`);
          }
        } else if (data.type === "response.done" && data.response?.status === "failed") {
          console.error("[realtime response failed]", data.response?.status_details);
          const msg =
            data.response?.status_details?.error?.message ||
            data.response?.status_details?.reason ||
            "response failed";
          setError(`AI ตอบไม่สำเร็จ: ${msg}`);
        }

        // On-screen debug log (skip high-frequency streaming events)
        if (debugOpenRef.current) {
          const ty = data.type as string;
          if (ty && !ty.endsWith(".delta") && !ty.startsWith("output_audio_buffer")) {
            let info = "";
            if (ty === "error") info = data.error?.message || data.error?.code || "";
            else if (ty === "response.done") info = data.response?.status || "";
            else if (ty === "rate_limits.updated")
              info = (data.rate_limits || [])
                .map((r: { name: string; remaining: number }) => `${r.name}=${r.remaining}`)
                .join(" ");
            const time = new Date().toLocaleTimeString("th-TH", { hour12: false });
            setDebugLog((prev) => [...prev.slice(-39), { time, type: ty, info }]);
          }
        }

        handleRealtimeEvent(data);
      } catch { /* ignore */ }
    },
    [handleRealtimeEvent],
  );

  const { connect, disconnect, sendEvent, setMicEnabled, switchMic, micEnabled, remoteStream, localStream, micLabel, connectionState, dataChannelReady } = useWebRTC({
    onDataChannelMessage,
  });

  useEffect(() => {
    debugOpenRef.current = debugOpen;
  });

  // Auto-reconnect on a dropped WebRTC connection. A network blip used to kill
  // the whole meeting (end + restart, transcript flow broken); now we wait a
  // moment (WebRTC "disconnected" often self-heals), then rebuild the session
  // in place — the transcript and documents are untouched.
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectingRef = useRef(false);
  const connectionStateRef = useRef(connectionState);
  const meetingTitleRef = useRef(meetingTitle);
  const documentsRef = useRef(documents);
  const assistantModeRef = useRef(assistantMode);
  useEffect(() => {
    connectionStateRef.current = connectionState;
    meetingTitleRef.current = meetingTitle;
    documentsRef.current = documents;
    assistantModeRef.current = assistantMode;
  });
  useEffect(() => {
    if (state !== "listening") return;
    if (connectionState !== "failed" && connectionState !== "disconnected") return;
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    (async () => {
      // give a transient "disconnected" a chance to recover on its own
      await new Promise((r) => setTimeout(r, 3000));
      if (connectionStateRef.current === "connected") {
        reconnectingRef.current = false;
        setReconnecting(false);
        return;
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          disconnect();
          // Reconnect as the SAME mode with the SAME documents. This used to
          // fall back to "default" and to the job-document filter, so a
          // dropped connection in สอบสวน CAR came back as a plain OK-job
          // meeting with the uploaded CAR table stripped out — พรชัย kept
          // listening but had lost both his instructions and his document.
          const mode = assistantModeRef.current;
          sessionConfigRef.current = await connect({
            meetingTitle: meetingTitleRef.current || undefined,
            documentIds: documentsRef.current
              .filter((d) => (mode === "okjob" ? isJobDoc(d.name) : !isJobDoc(d.name)))
              .map((d) => d.id),
            mode: mode === "pornchai" ? "pornchai" : mode === "car" ? "car" : "default",
          });
          setError("");
          reconnectingRef.current = false;
          setReconnecting(false);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      reconnectingRef.current = false;
      setReconnecting(false);
      setError(
        "เชื่อมต่อ AI ใหม่ไม่สำเร็จหลายครั้ง — กด 'จบประชุม' แล้วเริ่มใหม่ (บทสนทนาที่ผ่านมายังอยู่ครบ)",
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState, state]);

  // Each finished sentence: the SCREEN gets the raw transcript (audit trail,
  // never modified); the AI context gets contextText (dictionary-normalized,
  // Thai-only). Low-confidence segments (enforce mode) still show on screen
  // with a marker, but the AI only learns "something was said unclearly" and
  // the job matcher ignores them.
  const lastAcceptedCtxRef = useRef("");
  const [ctxSeq, setCtxSeq] = useState(0);
  // Mirrors "a meeting is running" for the async callbacks below, which hold
  // a stale copy of state by the time their slice comes back.
  const inMeetingRef = useRef(false);
  const handleMeetingText = useCallback(
    (seg: TranscribedSegment) => {
      // A slice is transcribed over the network, so one can come back after
      // the meeting it belongs to has ended. Anything arriving outside a
      // meeting is dropped: it would otherwise be written into the next
      // meeting's record.
      if (!inMeetingRef.current) {
        console.warn("[live] ทิ้งข้อความที่มาถึงหลังจบประชุม");
        return;
      }

      // These slices are both พรชัย's ear AND what the room reads while the
      // meeting runs. They are rough — the accurate transcript is made from
      // the recording when the meeting ends, and replaces this one.
      const ok = seg.decision === "accept";
      if (ok && seg.text.trim()) addRoomTurns([{ text: seg.text.trim() }]);
      const ctx = ok && seg.contextText
        ? `(บทสนทนาในที่ประชุม) ${seg.contextText}`
        : "(บทสนทนาในที่ประชุม) [มีเสียงพูดช่วงหนึ่งแต่ระบบถอดได้ไม่ชัด]";
      sendEvent({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: ctx }] },
      });
      if (ok && seg.contextText) {
        lastAcceptedCtxRef.current = seg.contextText;
        setCtxSeq((s) => s + 1); // wakes the job matcher
      }
    },
    [sendEvent, addRoomTurns],
  );

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    inMeetingRef.current = state === "listening";
  }, [state]);

  /**
   * The recording is NOT transcribed during the meeting.
   *
   * What the room reads as people talk comes from the live slices above. The
   * recording is kept in memory in long pieces and transcribed once, when the
   * meeting ends: one pass over whole minutes of audio reads far better than
   * a transcript stitched together from short uploads, and nothing is written
   * to disk on the way.
   *
   * It is held in pieces rather than one blob only because each piece has to
   * stay inside the transcription API's file limit — a long meeting is sent as
   * a handful of files, in order.
   */
  const heldAudioRef = useRef<Blob[]>([]);
  /**
   * Where this meeting's audio is filed, so it can be played back later.
   *
   * It is chosen when the meeting starts rather than taken from the saved
   * meeting's id, because the audio is uploaded while the meeting is closing —
   * before there is a meeting record to belong to.
   */
  const recordingIdRef = useRef("");
  /**
   * What each pass produced. The ref is what the save reads (it is written
   * while the meeting is closing); the state is what the summary box shows.
   */
  const rawPassesRef = useRef<{ file: string; live: string }>({ file: "", live: "" });
  const [rawPasses, setRawPasses] = useState<{ file: string; live: string }>({
    file: "",
    live: "",
  });
  /**
   * Why the recording produced no text, when it produces none.
   *
   * This pass failing used to be invisible: its section simply vanished from
   * the summary and nobody could tell whether the recording was never made,
   * the upload failed, or the model heard nothing. The reason is shown now.
   */
  const [fileNote, setFileNoteState] = useState("");
  // The save runs while the meeting is closing, before the state lands.
  const fileNoteRef = useRef("");
  const setFileNote = useCallback((note: string) => {
    fileNoteRef.current = note;
    setFileNoteState(note);
  }, []);
  const setRawPassBoth = useCallback((file: string, live: string) => {
    rawPassesRef.current = { file, live };
    setRawPasses({ file, live });
  }, []);
  const holdChunk = useCallback((blob: Blob, index: number) => {
    heldAudioRef.current.push(blob);
    console.log(
      `[recording] piece ${index + 1} held (${(blob.size / 1048576).toFixed(2)}MB, ` +
        `${heldAudioRef.current.length} in all)`,
    );
  }, []);

  /**
   * Hand the recording to the server and come back at once.
   *
   * The pieces used to be transcribed from here, one after another, and
   * then cross-checked — the room watched a spinner for two to three
   * minutes after every meeting. Now each piece is only stored (store=1),
   * which takes as long as the upload, and the server transcribes them
   * after the meeting is saved (meeting-pipeline.ts). The summary opens
   * with the live transcript and is upgraded in place when that finishes.
   */
  const storeRecording = useCallback(async (): Promise<{ stored: number; total: number }> => {
    const pieces = heldAudioRef.current;
    heldAudioRef.current = [];
    setFileNote("");
    if (pieces.length === 0) {
      const why = "ไม่มีไฟล์เสียงให้ถอด — ตัวบันทึกเสียงไม่ได้ส่งเสียงช่วงใดมาเลย";
      console.error("[recording] " + why);
      setFileNote(why);
      return { stored: 0, total: 0 };
    }
    if (!recordingIdRef.current) {
      setFileNote("ไม่มีรหัสการบันทึก — เก็บไฟล์เสียงไม่ได้");
      return { stored: 0, total: pieces.length };
    }
    setFinalizing(`กำลังส่งไฟล์เสียง ${pieces.length} ส่วนไปเก็บ…`);
    const results = await Promise.all(
      pieces.map(async (blob, i) => {
        try {
          const fd = new FormData();
          fd.append("file", blob, `meeting-part-${i + 1}.webm`);
          fd.append("recordingId", recordingIdRef.current);
          fd.append("part", String(i));
          fd.append("store", "1");
          const res = await fetch("/api/transcribe-file", { method: "POST", body: fd });
          if (!res.ok) {
            console.error("[recording] store part", i + 1, "failed", res.status);
            return false;
          }
          return true;
        } catch (err) {
          console.error("[recording] store part", i + 1, err);
          return false;
        }
      }),
    );
    const stored = results.filter(Boolean).length;
    console.log(`[recording] เก็บไฟล์เสียง ${stored}/${pieces.length} ส่วน`);
    if (stored < pieces.length) {
      setFileNote(`เก็บไฟล์เสียงได้ ${stored} จาก ${pieces.length} ส่วน — ส่วนที่หายจะไม่ถูกถอด`);
    }
    return { stored, total: pieces.length };
  }, []);

  /**
   * Record the room while the meeting runs (separate from the live slices).
   *
   * A reconnect hands over a brand-new MediaStream, which re-runs this effect.
   * It used to empty the held audio here, so one dropped connection silently
   * threw away everything recorded up to that point and the meeting came back
   * with only the minutes after it. The held audio is cleared when a MEETING
   * starts instead, and a swapped microphone keeps what is already recorded.
   */
  const micSwappedRef = useRef(false);
  useEffect(() => {
    if (state === "listening" && localStream) {
      const sameMeeting = micSwappedRef.current;
      micSwappedRef.current = true;
      if (sameMeeting) {
        console.log(
          `[recording] ต่อไมค์ใหม่กลางประชุม — เก็บเสียงเดิมไว้ ${heldAudioRef.current.length} ส่วน`,
        );
      }
      recorder.start(localStream, {
        sameMeeting,
        onChunk: holdChunk,
        chunkMs: RECORD_PIECE_MINUTES * 60_000,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, localStream]);

  /**
   * The recording runs from the start of the meeting to the end, and only
   * "หยุดฟัง" stops it.
   *
   * It used to stop whenever พรชัย answered or a question was spoken, to keep
   * his voice out of the record. That cost more than it saved: on a meeting
   * with several questions the recording came out as a handful of short
   * pieces, and short pieces transcribe badly — one meeting's recording
   * yielded 59 characters against the live pass's 351. A continuous recording
   * is what makes the file pass worth having.
   *
   * พรชัย's own answers and the spoken questions are kept as their own turns
   * already, so they are listed for removal when the two transcripts are
   * cross-checked, and the room's block stays the room's words.
   */
  useEffect(() => {
    if (state !== "listening") return;
    const holdRecording = !micEnabled;
    if (holdRecording) {
      recorder.pause();
      return;
    }
    const t = setTimeout(() => {
      recorder.resume();
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAiResponding, questionPhase, micEnabled, state]);

  // Meeting transcription runs on our on-premises Typhoon ASR service: the
  // browser captures PCM, cuts a segment when the speaker pauses, and posts it
  // to /api/transcribe.
  useEffect(() => {
    if (state === "listening" && localStream) {
      startTranscriber(localStream, handleMeetingText, setTranscribing, setLiveUserText);
      return () => {
        stopTranscriber();
        setTranscribing(false);
      };
    }
  }, [state, localStream, startTranscriber, stopTranscriber, handleMeetingText, setLiveUserText]);

  // Pause capture while the AI speaks — echoCancellation alone doesn't stop
  // the speaker audio from coming back as ผู้ประชุม lines (and the garbled
  // echo is what produced foreign-language hallucinations). Resume ~800ms
  // after the AI finishes so the audio tail doesn't leak in either.
  useEffect(() => {
    if (!micEnabled || isAiResponding) {
      setTranscriberPaused(true);
      return;
    }
    const t = setTimeout(() => setTranscriberPaused(false), 800);
    return () => clearTimeout(t);
  }, [micEnabled, isAiResponding, setTranscriberPaused]);

  // Mic audio still streams to the Realtime peer to keep the connection alive,
  // but we never commit it — clear periodically so its buffer can't grow.
  useEffect(() => {
    if (state !== "listening") return;
    const id = setInterval(() => sendEvent({ type: "input_audio_buffer.clear" }), 15000);
    return () => clearInterval(id);
  }, [state, sendEvent]);

  // Each mode has its own document set: OK-job = WI PDFs pulled from REPORT2,
  // พรชัย = manually uploaded meeting documents. The store is shared, so we
  // partition by filename pattern — neither mode sees the other's files.
  const modeDocs = usesUploads(assistantMode)
    ? documents.filter((d) => !isJobDoc(d.name))
    : documents.filter((d) => isJobDoc(d.name));
  /** Mode id as the API/prompt layer names it. */
  const apiMode: "default" | "pornchai" | "car" =
    assistantMode === "pornchai" ? "pornchai" : assistantMode === "car" ? "car" : "default";

  // Landing-page mode choice → set the default title and jump to prep.
  function chooseAssistantMode(mode: ModeId) {
    setAssistantMode(mode);
    setMeetingTitle(autoMeetingTitle(mode));
    setActiveTab("prep");
  }

  // Going back home DESELECTS the mode (unless a meeting is running), so the
  // prep/meeting tabs disappear again until a mode is chosen.
  function goHome() {
    if (!isListening && state !== "connecting") setAssistantMode(null);
    setActiveTab("home");
  }

  // Load existing documents on mount
  useEffect(() => {
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => setDocuments(d || []))
      .catch(() => {});
  }, []);

  // Recover a meeting that failed to save last time (silent retry)
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PENDING_MEETING_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    })
      .then((r) => {
        if (r.ok) {
          localStorage.removeItem(PENDING_MEETING_KEY);
          setHistoryRefreshKey((k) => k + 1);
        }
      })
      .catch(() => {});
  }, []);

  // Play AI audio
  useEffect(() => {
    if (remoteStream && audioRef.current) {
      audioRef.current.srcObject = remoteStream;
      audioRef.current.play().catch(() => {});
    }
  }, [remoteStream]);

  // Silencing lasts only for the current answer — the next one plays normally.
  useEffect(() => {
    if (!isAiResponding && voiceMuted) {
      setVoiceMuted(false);
      if (audioRef.current) audioRef.current.muted = false;
    }
  }, [isAiResponding, voiceMuted]);

  /**
   * Cancel the answer in progress: stop the voice AND stop generating text.
   * Muting first guarantees instant silence (audio already in flight keeps
   * playing for a moment even after the server stops sending more).
   */
  function handleCancelSpeech() {
    if (audioRef.current) audioRef.current.muted = true;
    setVoiceMuted(true);
    sendEvent({ type: "response.cancel" });
    sendEvent({ type: "output_audio_buffer.clear" }); // WebRTC: drop buffered audio
    // Stay muted until the response actually ends (the effect below unmutes),
    // so trailing audio already in flight never leaks through. The timer is
    // only a safety net in case response.done never arrives.
    setTimeout(() => {
      if (audioRef.current) audioRef.current.muted = false;
      setVoiceMuted(false);
    }, 4000);
  }

  // Configure session once data channel is open
  useEffect(() => {
    if (dataChannelReady && state === "listening") {
      const cfg = sessionConfigRef.current;
      // Disable auto turn detection so AI never speaks on its own
      sendEvent({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: cfg?.instructions ?? "",
          audio: {
            input: {
              // No auto turn detection — transcribe the whole committed segment
              // at once (more accurate) and keep the AI from replying on its own.
              turn_detection: null,
              transcription: { model: cfg?.transcribeModel ?? "gpt-4o-mini-transcribe", language: "th" },
            },
            output: { voice: cfg?.voice },
          },
        },
      });
    }
  }, [dataChannelReady, state, sendEvent]);

  async function handleStart() {
    if (!assistantMode) {
      setActiveTab("home");
      return;
    }
    setState("connecting");
    setError("");
    setFocusJobId(null);
    setPullState({});
    lastSeenRef.current = {};
    lastAcceptedCtxRef.current = "";
    heldAudioRef.current = [];
    micSwappedRef.current = false;
    marksRef.current = [];
    setMarks([]);
    confirmSnapshotRef.current = null;
    // An OK-job meeting is the day's OK list. If nobody prepared it on the
    // documents page, it is fetched here, so pressing "เข้าประชุม" is all
    // the room has to do: the list drives the confirm marks, and the WI of
    // each job is pulled in the background, first jobs first.
    if (assistantMode === "okjob" && catalog.length === 0) void loadTodayCatalog();
    recordingIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `rec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    resetTranscript();
    sessionConfigRef.current = null;
    startedAtRef.current = new Date().toISOString();

    try {
      sessionConfigRef.current = await connect({
        meetingTitle: meetingTitle || undefined,
        documentIds: modeDocs.map((d) => d.id),
        mode: apiMode,
      });
      setState("listening");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  }

  async function handleStop() {
    const jobIdsNow = documents
      .map((d) => d.name.match(/^(J\d{8})\.pdf$/i)?.[1]?.toUpperCase())
      .filter((x): x is string => Boolean(x));

    // Open the summary first. Finishing a meeting takes a few seconds (the last
    // stretch of audio still has to be transcribed), and without this the room
    // just watched the meeting screen collapse back to the start button.
    setEndedMeta({
      meetingTitle,
      jobIds: jobIdsNow,
      startedAt: startedAtRef.current,
      endedAt: new Date().toISOString(),
    });
    setSummaryText("");
    setSummaryError("");
    setSummarySaved(false);
    setSummaryLoading(true);
    setSummaryOpen(true);
    setState("idle");

    // Order matters: close the recording while the microphone is still alive.
    // Releasing the track first leaves MediaRecorder unable to report back,
    // which used to stall this function and leave the meeting unsaved.
    setFinalizing("กำลังปิดการบันทึกเสียง…");
    try {
      await recorder.stop();
    } catch (err) {
      console.error("[stop] recorder", err);
    }
    disconnect();

    // The room was reading the live transcript; that is what is saved now.
    // The recording goes to the server and is transcribed there after the
    // save, cross-checked against this, and the record upgraded in place.
    const liveText = turnsRef.current
      .filter((t) => t.kind === "room")
      .map((t) => t.text)
      .join(" ")
      .trim();
    setRawPassBoth("", liveText);
    const kept = await storeRecording();
    setFinalizing("");
    if (turnsRef.current.length === 0) {
      setSummaryLoading(false);
      setSummaryOpen(false);
      return;
    }

    // Persist the meeting (with summary) and show the post-meeting summary
    const jobIds = documents
      .map((d) => d.name.match(/^(J\d{8})\.pdf$/i)?.[1]?.toUpperCase())
      .filter((x): x is string => Boolean(x));
    const jobNames = jobIds.map((j) => jobNameById[j]).filter(Boolean);
    const startedAt = startedAtRef.current;
    const endedAt = new Date().toISOString();

    const bestTurns = turnsRef.current;
    setFinalTurns(bestTurns);
    const { file: rawFile, live: rawLive } = rawPassesRef.current;

    const payload = {
      mode: assistantMode ?? "okjob",
      meetingTitle,
      jobIds,
      jobNames,
      startedAt,
      endedAt,
      transcript: bestTurns,
      // Both originals, so a number questioned later can be traced back to
      // what each pass actually heard.
      rawFile,
      rawLive,
      // …and, when the recording produced nothing, why.
      rawFileNote: fileNoteRef.current,
      // where the room's audio is kept, so it can be played back
      recordingId: recordingIdRef.current,
      // ids of the docs used in this meeting → summary spells names/numbers right
      docIds: modeDocs.map((d) => d.id),
      // the server finishes the record (recording transcript + minutes) after
      // replying, so the room is not kept waiting — only possible when the
      // pieces were actually stored
      pending: kept.stored > 0,
      // confirm presses seen during the meeting: the minutes are cut by these
      marks: marksRef.current,
    };
    pendingPayloadRef.current = payload;
    // Back up immediately so the transcript is never lost, even on a crash
    try {
      localStorage.setItem(PENDING_MEETING_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }

    // Refresh the snapshot with the real end time (the modal reads the
    // snapshot and the transcript, not the live document/title state).
    setEndedMeta({ meetingTitle, jobIds, startedAt, endedAt });

    // The documents are cleared only AFTER the save has gone through. They
    // used to be cleared here, in the same breath as the save request, and
    // the small DELETE reached the server before the large POST: the save
    // then resolved its document ids to nothing, and the minutes of a
    // meeting with twenty WI attached opened with "0 งาน". A failed save
    // keeps the documents, so the retry still has them.
    await persistMeeting(payload);
    if (!pendingPayloadRef.current) clearMeetingDocs();
  }

  // Save a meeting (with summary). On failure keeps the localStorage backup so
  // it can be retried — manually or automatically on next page load.
  async function persistMeeting(payload: Record<string, unknown>): Promise<void> {
    setSummaryError("");
    setSummaryLoading(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const rec = await res.json();
        setSummaryText(rec.summary || "");
        if (rec.meetingTitle) setMeetingTitle(rec.meetingTitle); // contextual title from the server
        setSummarySaved(true);
        setHistoryRefreshKey((k) => k + 1);
        pendingPayloadRef.current = null;
        if (rec.status === "processing" && rec.id) watchProcessing(rec.id);
        try {
          localStorage.removeItem(PENDING_MEETING_KEY);
        } catch {
          /* ignore */
        }
      } else {
        setSummaryError("บันทึก/สรุปไม่สำเร็จ");
      }
    } catch {
      setSummaryError("เชื่อมต่อไม่ได้ — ยังไม่ได้บันทึก");
    } finally {
      setSummaryLoading(false);
    }
  }

  /**
   * Follow a record the server is still finishing. Every few seconds the
   * record is fetched; when its status flips to done, the recording's
   * transcript, the cross-checked text and the rewritten minutes replace
   * what is on screen. Gives up quietly after 15 minutes — the history page
   * shows the finished record either way.
   */
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function watchProcessing(id: string) {
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    setProcessingNote("กำลังถอดไฟล์เสียงและเขียนสรุปฉบับเต็มอยู่เบื้องหลัง — อ่านฉบับนี้ไปก่อนได้ สรุปจะอัปเดตเองเมื่อเสร็จ (ราว 1-3 นาที)");
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const res = await fetch(`/api/meetings/${id}`, { cache: "no-store" });
        if (res.ok) {
          const rec = (await res.json()) as {
            status?: string;
            summary?: string;
            transcript?: TranscriptTurn[];
            rawFile?: string;
            rawLive?: string;
            rawFileNote?: string;
          };
          if (rec.status === "done") {
            if (rec.summary) setSummaryText(rec.summary);
            if (rec.transcript?.length) setFinalTurns(rec.transcript);
            setRawPassBoth(rec.rawFile || "", rec.rawLive || rawPassesRef.current.live);
            setFileNote(rec.rawFileNote || "");
            setProcessingNote("");
            setHistoryRefreshKey((k) => k + 1);
            console.log(`[pipeline] สรุปฉบับเต็มมาแล้ว (${(rec.summary || "").length} ตัวอักษร)`);
            return;
          }
        }
      } catch {
        // network blip: try again on the next tick
      }
      if (Date.now() - startedAt > 15 * 60_000) {
        setProcessingNote("");
        return;
      }
      processingTimerRef.current = setTimeout(tick, 5000);
    };
    processingTimerRef.current = setTimeout(tick, 5000);
  }

  async function handleRetrySave() {
    if (!pendingPayloadRef.current) return;
    await persistMeeting(pendingPayloadRef.current);
    // the documents outlive a failed save (see handleStop); a save that
    // finally went through releases them
    if (!pendingPayloadRef.current) clearMeetingDocs();
  }

  // Clear all documents (server store + UI) so the next meeting starts clean.
  async function clearMeetingDocs() {
    try {
      await fetch("/api/documents", { method: "DELETE" });
    } catch {
      /* ignore */
    }
    setDocuments([]);
    setJobNameById({});
    setMeetingTitle(autoMeetingTitle(assistantMode)); // refresh for the next session (AM/PM)
    setFocusJobId(null);
    setAutoPull(false);
    setCatalog([]);
    setPullState({});
    lastSeenRef.current = {};
  }

  const jobIdOf = (name: string) => name.replace(/\.pdf$/i, "");

  // Clear only the ACTIVE mode's documents (the "ล้างทั้งหมด" button) so one
  // mode's cleanup can't wipe the other mode's files.
  async function clearModeDocs() {
    const victims = modeDocs;
    for (const d of victims) {
      fetch(`/api/documents?id=${d.id}`, { method: "DELETE" }).catch(() => {});
    }
    setDocuments((prev) => prev.filter((d) => !victims.some((v) => v.id === d.id)));
  }

  /** Record one confirm press: a marker line in the live transcript. */
  const addMark = useCallback(
    (job: { jobid: string; jobName: string }, at: string, remark?: string, manual = false) => {
      if (marksRef.current.some((m) => m.jobId === job.jobid)) return;
      const mark: ConfirmMark = { jobId: job.jobid, jobName: job.jobName, at, ...(remark ? { remark } : {}), ...(manual ? { manual: true } : {}) };
      marksRef.current = [...marksRef.current, mark];
      setMarks(marksRef.current);
      const hhmm = new Date(at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
      // The marker is Thai on purpose: a Latin-only line would be dropped as
      // a foreign hallucination by the transcript's own filter.
      addRoomTurns([{ text: `✓ ยืนยันงาน ${job.jobid} ${job.jobName} เวลา ${hhmm}${remark ? ` — ${remark}` : ""}`, label: "confirm" }]);
      console.log(`[confirm] ${job.jobid} ${hhmm}${manual ? " (กดในแอป)" : ""}${remark ? ` — ${remark}` : ""}`);
      if (!documents.some((d) => jobIdOf(d.name) === job.jobid)) void autoPullJob(job.jobid);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addRoomTurns, documents],
  );



  // Poll REPORT2 for confirm presses while an OK-job meeting runs.
  useEffect(() => {
    if (state !== "listening" || assistantMode !== "okjob" || catalog.length === 0) return;
    let alive = true;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    const startedAt = startedAtRef.current ? new Date(startedAtRef.current).getTime() : Date.now();
    const tick = async () => {
      try {
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dateStart: today, dateEnd: today }),
        });
        if (!res.ok || !alive) return;
        const rows = (await res.json()) as { jobid: string; jobName: string; confirmed: boolean; confirmedAt: string | null; remark?: string }[];
        if (!Array.isArray(rows) || !alive) return;
        if (!confirmSnapshotRef.current) {
          // Baseline: whatever was confirmed before the meeting is not ours.
          confirmSnapshotRef.current = new Map(rows.map((r) => [r.jobid, r.confirmed]));
          const confirmed = new Set(rows.filter((r) => r.confirmed).map((r) => r.jobid));
          const stamp = new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          console.log(
            `[confirm] อ่านช่อง confirm ของ REPORT2 แล้ว (${stamp}): วันนี้ ${rows.length} งาน ยืนยันไปแล้วก่อนเปิดห้อง ${confirmed.size} งาน` +
              (confirmed.size ? ` (${[...confirmed].join(", ")})` : "") +
              ` — รอใบใหม่ ตรวจทุก 10 วิ`,
          );
          return;
        }
        for (const r of rows) {
          const was = confirmSnapshotRef.current.get(r.jobid) || false;
          if (r.confirmed && !was) {
            confirmSnapshotRef.current.set(r.jobid, true);
            // A press from before the meeting that REPORT2 only showed now is
            // still not part of this meeting.
            const at = r.confirmedAt && !isNaN(new Date(r.confirmedAt).getTime()) ? new Date(r.confirmedAt).getTime() : Date.now();
            if (at < startedAt - 10 * 60_000) continue;
            addMark({ jobid: r.jobid, jobName: r.jobName }, new Date(at).toISOString(), r.remark);
          }
        }
      } catch {
        // REPORT2 away for a moment: the next tick tries again
      }
    };
    void tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [state, assistantMode, catalog, addMark]);

  /**
   * Today's OK list from REPORT2, minus the jobs already confirmed (the
   * morning's jobs do not belong to the afternoon meeting), registered as
   * the catalog and pulled two at a time in list order — the order the
   * room goes through them — so the first jobs' WI are ready in seconds.
   */
  async function loadTodayCatalog() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateStart: today, dateEnd: today }),
      });
      if (!res.ok) {
        console.warn("[ok-list] ดึงรายการงาน OK วันนี้ไม่ได้", res.status);
        return;
      }
      const rows = (await res.json()) as { jobid: string; jobName: string; ae: string; confirmed: boolean }[];
      const open = (Array.isArray(rows) ? rows : []).filter((r) => !r.confirmed);
      if (open.length === 0) {
        console.warn(`[ok-list] วันนี้ (${today}) ไม่มีงานที่ยังไม่ confirm`);
        return;
      }
      // likely jobs for this session first (mornings reprints, afternoons
      // new) — ordering only; a quarter of each session is the other kind
      const hour = Number(new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }));
      const jobs: JobCatalogItem[] = orderForSession(
        open.map((r) => ({ jobid: r.jobid, jobName: r.jobName, ae: r.ae })),
        sessionForHour(hour),
      );
      handleUseCatalog(jobs);
      // Documents attached by hand before the meeting are the room's choice:
      // the list is still registered (the confirm marks need it), but no
      // WI is pulled on top of what was chosen. Only an empty room pulls.
      if (documents.length > 0) {
        console.log(`[ok-list] โหลดรายการงาน OK วันนี้ ${jobs.length} งาน — มีเอกสารที่เลือกไว้แล้ว ${documents.length} ไฟล์ ไม่ดึงเพิ่ม`);
        return;
      }
      console.log(`[ok-list] โหลดรายการงาน OK วันนี้ ${jobs.length} งาน (ยังไม่ confirm) — กำลังดึง WI`);
      // two at a time, in order; autoPullJob skips what is already loaded
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const j = jobs[next++];
          await autoPullJob(j.jobid);
        }
      };
      await Promise.all([worker(), worker()]);
      console.log(`[ok-list] ดึง WI ครบ ${jobs.length} งาน`);
    } catch (err) {
      console.warn("[ok-list]", (err as Error).message);
    }
  }

  // Register a day's jobs for auto-pull (without fetching their documents).
  function handleUseCatalog(jobs: JobCatalogItem[]) {
    setCatalog(jobs);
    setAutoPull(true);
    setJobNameById((prev) => {
      const next = { ...prev };
      for (const j of jobs) if (j.jobName) next[j.jobid] = j.jobName;
      return next;
    });
  }

  // Fetch a single job's WI on demand and inject its digest into the live
  // session so the AI can use it immediately. Best-effort + de-duplicated.
  async function autoPullJob(jobId: string) {
    if (pullingRef.current.has(jobId)) return;
    if (documents.some((d) => jobIdOf(d.name) === jobId)) return;
    pullingRef.current.add(jobId);
    setPullState((s) => ({ ...s, [jobId]: "pulling" }));
    try {
      const res = await fetch("/api/documents/from-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("[auto-pull]", jobId, res.status, data?.error);
        setPullState((s) => ({ ...s, [jobId]: "error" }));
        return;
      }
      setDocuments((prev) =>
        prev.some((d) => d.id === data.id)
          ? prev
          : [...prev, { id: data.id, name: data.name, preview: data.preview, uploadedAt: data.uploadedAt, summary: data.summary || "" }],
      );
      setPullState((s) => {
        const n = { ...s };
        delete n[jobId]; // success → clear status (doc now in the list)
        return n;
      });
      // Silently give the AI this job's digest (no response triggered).
      const digest = (data.summary as string) || data.preview || "";
      if (digest && dataChannelReady) {
        sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `[ข้อมูลเอกสารงาน ${jobId} สำหรับใช้อ้างอิง]\n${digest}` }],
          },
        });
      }
    } catch (err) {
      console.error("[auto-pull]", jobId, err);
      setPullState((s) => ({ ...s, [jobId]: "error" }));
    } finally {
      pullingRef.current.delete(jobId);
    }
  }

  function openPicker(mode: "car" | "comment") {
    const all = modeDocs.map((d) => jobIdOf(d.name));
    // Don't pre-tick everything — start empty, or just the job we detected being
    // discussed. The user ticks the one(s) they actually want to hear.
    setPickerSel(focusJobId && all.includes(focusJobId) ? [focusJobId] : []);
    setPicker(mode);
    setMicEnabled(true);
    // No auto voice here — it made the AI read all jobs aloud. Use the
    // "ให้ AI ถามอีกครั้ง" button for a short spoken prompt.
  }

  // Summarize CAR / comment for the selected jobs at once (split per job).
  // Fetches the selected jobs' full content so it works even when many docs
  // are loaded (lazy injection) — keeps the result accurate per job.
  async function runMultiSummary(mode: "car" | "comment", jobIds: string[]) {
    if (state !== "listening" || isAiResponding) return;
    setPicker(null);
    setMicEnabled(true); // open listening before the AI speaks

    let text: string;
    let brainDocIds: string[] = modeDocs.map((d) => d.id);
    if (jobIds.length > 0) {
      const ids = jobIds
        .map((jid) => modeDocs.find((d) => jobIdOf(d.name) === jid)?.id)
        .filter((x): x is string => Boolean(x));
      let docsContent: { jobId: string; content: string }[] = [];
      try {
        const res = await fetch("/api/documents/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        if (res.ok) {
          const arr = (await res.json()) as { name: string; content: string }[];
          docsContent = arr.map((d) => ({ jobId: jobIdOf(d.name), content: d.content }));
        }
      } catch {
        /* ignore — fall through with whatever we have */
      }
      brainDocIds = ids;
      text = mode === "car" ? buildMultiCarPrompt(docsContent) : buildMultiCommentPrompt(docsContent);
    } else {
      // comment with no documents → discussion only (พรชัย gets the general,
      // no-print-assumptions variant)
      text = buildCommentPrompt(undefined, apiMode);
    }

    // The top model thinks it through; realtime only reads the answer out.
    if (await askPornchaiBrain("command", text, brainDocIds)) return;

    sendEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    sendEvent({
      type: "response.create",
      // "inf" so summarizing several jobs at once isn't cut off after the first
      // (audio output eats tokens fast — 4096 only covers ~one job).
      response: { output_modalities: ["audio"], max_output_tokens: "inf" },
    });
  }

  // Have the AI ask (SHORT — never reads the whole list) which job the user
  // wants; they tap to pick from the on-screen list. Only for the manual button.
  function askJobListByVoice(mode: "car" | "comment") {
    if (state !== "listening" || isAiResponding) return;
    const what = mode === "car" ? "CAR" : "ข้อเสนอแนะ";
    sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: `พูดสั้นๆ ประโยคเดียวว่า อยากฟัง ${what} ของงานไหน ให้กดเลือกจากรายการบนหน้าจอได้เลย (ภาษาไทย ห้ามอ่านรายชื่องาน ห้ามยาว)`,
      },
    });
  }

  function handleSuggestion() {
    if (state !== "listening" || isAiResponding || modeDocs.length === 0) return;
    if (modeDocs.length > 1) {
      openPicker("car");
      return;
    }
    runMultiSummary("car", [jobIdOf(modeDocs[0].name)]);
  }

  // Comment on the whole discussion right away — no job picking. The AI already
  // has the meeting transcript + document digests in context.
  function handleComment() {
    if (state !== "listening" || isAiResponding) return;
    runMultiSummary("comment", []);
  }

  // Make the realtime model SPEAK a prepared answer verbatim (พรชัย's voice).
  const speakText = useCallback(
    (text: string) => {
      setMicEnabled(true);
      sendEvent({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: `อ่านข้อความต่อไปนี้ด้วยน้ำเสียงพรชัยอย่างเป็นธรรมชาติ เนื้อหาต้องตรงตามข้อความนี้ทุกประการ ห้ามเพิ่ม ห้ามตัด ห้ามแต่งใหม่:

${text}`,
          max_output_tokens: "inf",
        },
      });
    },
    [sendEvent],
  );

  // Two-tier brain: the top text model THINKS (with docs + memory + RAG),
  // the realtime model just reads the answer aloud. Returns false when the
  // thinking call failed so callers can fall back to single-brain mode.
  async function askPornchaiBrain(
    kind: "question" | "freetalk" | "command",
    question: string,
    docIds?: string[],
  ): Promise<boolean> {
    setAiThinking(true);
    try {
      const transcript = turns
        .slice(-40)
        .map((t) => `${t.speaker === "assistant" ? "พรชัย" : "ผู้ประชุม"}: ${t.text}`)
        .join("\n");
      const res = await fetch("/api/pornchai-think", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          question,
          transcript,
          mode: apiMode,
          docIds: docIds ?? modeDocs.map((d) => d.id),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.answer) throw new Error(data.error || "think failed");
      speakText(data.answer);
      return true;
    } catch (err) {
      console.error("[pornchai-think]", err);
      return false;
    } finally {
      setAiThinking(false);
    }
  }

  // พรชัย mode: the floor is his — thought out by the top model first.
  async function handleFreeTalk() {
    if (state !== "listening" || isAiResponding || aiThinking) return;
    setMicEnabled(true);
    const ok = await askPornchaiBrain("freetalk", "");
    if (ok) return;
    // fallback: single-brain (realtime thinks for itself)
    sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: buildFreeTalkPrompt(),
        max_output_tokens: "inf",
      },
    });
  }

  // Step 1: start capturing a voice question (pauses meeting segmentation).
  function handleStartVoiceQuestion() {
    if (state !== "listening" || isAiResponding) return;
    setMicEnabled(true);
    setPendingQuestion("");
    setLiveQuestionText("");
    setQuestionTimedOut(false);
    startQuestion(setLiveQuestionText);
    setQuestionPhase("recording");
  }

  // Step 2: stop & transcribe the question, then wait for confirmation.
  async function handleTranscribeQuestion() {
    setQuestionTimedOut(false);
    setPendingQuestion("");
    setQuestionPhase("confirming");
    const text = await finishQuestion();
    if (text) setPendingQuestion(text);
    else setQuestionTimedOut(true);
  }

  // พรชัย mode: retrieve matching snippets from เฮีย's PAST CHATS (RAG index)
  // so answers can reference what they actually discussed before.
  async function ragContextFor(q: string): Promise<string> {
    try {
      const res = await fetch(`/api/pornchai-rag?q=${encodeURIComponent(q)}`);
      if (!res.ok) return "";
      const hits = (await res.json()) as { text: string; source: string }[];
      if (!Array.isArray(hits) || hits.length === 0) return "";
      return hits
        .map((h) => `[อ้างอิง: ${h.source.startsWith("ความจำ") ? h.source : `แชทเก่า ${h.source}`}]\n${h.text}`)
        .join("\n---\n")
        .slice(0, 6000);
    } catch {
      return "";
    }
  }

  // พรชัย mode: attach the FULL text of the loaded documents to the question
  // itself. The realtime voice model reads a fresh user message reliably but
  // routinely fabricates when asked to dig through a large table buried in the
  // system prompt (seen with the CAR investigation xlsx).
  async function docContextFor(): Promise<string> {
    if (modeDocs.length === 0) return "";
    try {
      const res = await fetch("/api/documents/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: modeDocs.map((d) => d.id) }),
      });
      if (!res.ok) return "";
      const arr = (await res.json()) as { name: string; content: string }[];
      let total = 0;
      const blocks: string[] = [];
      for (const d of arr) {
        const chunk = d.content.slice(0, 15000);
        if (total + chunk.length > 45000) break;
        total += chunk.length;
        blocks.push(`--- เอกสาร: ${d.name} ---
${chunk}`);
      }
      return blocks.join("\n\n");
    } catch {
      return "";
    }
  }

  function composeQuestion(q: string, rag: string, docs: string): string {
    if (!rag && !docs) return q;
    const parts: string[] = [];
    if (docs) {
      parts.push(`เนื้อหาเอกสารที่แนบในการประชุม (แหล่งข้อมูลหลักสำหรับคำถามเกี่ยวกับเอกสาร):
${docs}`);
    }
    if (rag) {
      parts.push(
        `ข้อมูลอ้างอิงจากบทสนทนาเก่าระหว่างเฮียกับพรชัย (ระบบค้นมาให้อัตโนมัติ อาจเกี่ยวหรือไม่เกี่ยวกับคำถามก็ได้):
${rag}`,
      );
    }
    parts.push(
      `กติกาการตอบ:
- ถ้าคำถามเกี่ยวกับเอกสารที่แนบ ให้ตอบจาก "เนื้อหาเอกสาร" ข้างต้นเท่านั้น อ่านค่าตรงตามที่เขียนทีละคอลัมน์ ห้ามเดาหรือแต่งชื่อ ตัวเลข หรือแผนกเด็ดขาด ถ้าหาคำตอบในเอกสารไม่พบ ให้ตอบตรงๆ ว่าในเอกสารไม่ได้ระบุ
- ข้อมูลจากบทสนทนาเก่า (ถ้ามี) ใช้เฉพาะส่วนที่เกี่ยวข้องกับคำถามจริงๆ ถ้าไม่เกี่ยวให้เพิกเฉยทั้งหมด ห้ามลากเรื่องเก่ามาโยง
- ห้ามแต่งข้อมูลนอกเหนือจากที่มี`,
    );
    parts.push(`(คำถามจากเฮีย) ${q}`);
    return parts.join("\n\n");
  }

  // Step 3a: confirmed — hand the question text to the AI and let it answer.
  async function handleConfirmQuestion() {
    if (!pendingQuestion) return;
    const q = pendingQuestion;
    addUserTurn(q);
    setQuestionPhase("idle");
    setShowQuestionBox(false);
    setPendingQuestion("");
    resumeMeeting();
    await answerQuestion(q);
  }

  // Route a confirmed question: พรชัย thinks with the top model first; the
  // realtime model only reads the answer. OK mode (and brain failures) use
  // the original single-brain path.
  async function answerQuestion(q: string) {
    // keep the realtime conversation coherent for follow-ups
    sendEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `(คำถามจากเฮีย) ${q}` }] },
    });
    if (await askPornchaiBrain("question", q)) return;
    const [rag, docs] = await Promise.all([ragContextFor(q), docContextFor()]);
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: composeQuestion(q, rag, docs) }],
      },
    });
    sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: buildVoiceQuestionInstruction(),
        max_output_tokens: 4096,
      },
    });
  }

  // Typed question — for noisy rooms where speaking isn't practical.
  async function handleSendTypedQuestion() {
    const q = typedQuestion.trim();
    if (!q || state !== "listening" || isAiResponding || aiThinking) return;
    addUserTurn(q);
    setTypedQuestion("");
    setShowQuestionBox(false);
    await answerQuestion(q);
  }

  // Step 3b: redo — discard and record again.
  function handleRedoQuestion() {
    setPendingQuestion("");
    setLiveQuestionText("");
    setQuestionTimedOut(false);
    startQuestion(setLiveQuestionText);
    setQuestionPhase("recording");
  }

  // Switch the question box to typing mode (stops voice capture).
  function handleUseKeyboard() {
    cancelQuestion();
    setPendingQuestion("");
    setLiveQuestionText("");
    setQuestionTimedOut(false);
    setQuestionPhase("idle");
  }

  function handleCancelVoiceQuestion() {
    cancelQuestion();
    setPendingQuestion("");
    setTypedQuestion("");
    setLiveQuestionText("");
    setQuestionTimedOut(false);
    setQuestionPhase("idle");
    setShowQuestionBox(false);
    resumeMeeting();
  }

  // Auto-detect the job being discussed. Runs on the latest ACCEPTED context
  // text only (normalized, confidence-passed) — low-confidence segments never
  // trigger job selection or auto-pull. Silent — only updates a badge/selection.
  useEffect(() => {
    if (state !== "listening") return;
    const heard = lastAcceptedCtxRef.current;
    if (!heard) return;
    const ids = (autoPull ? catalog.map((c) => c.jobid) : documents.map((d) => jobIdOf(d.name))).filter(
      (id) => /^J\d{8}$/i.test(id),
    );
    const matched = matchJobMention(heard, ids);
    if (!matched) return;
    lastSeenRef.current[matched] = ctxSeq;
    setFocusJobId((prev) => (prev === matched ? prev : matched));
    if (autoPull) autoPullJob(matched);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxSeq, documents, catalog, autoPull, state]);

  // Auto-pull cache eviction: keep only the most-recently-mentioned documents.
  useEffect(() => {
    if (!autoPull || documents.length <= AUTO_CACHE_MAX) return;
    const victim = [...documents]
      .filter((d) => jobIdOf(d.name) !== focusJobId)
      .sort(
        (a, b) =>
          (lastSeenRef.current[jobIdOf(a.name)] || 0) - (lastSeenRef.current[jobIdOf(b.name)] || 0),
      )[0];
    if (!victim) return;
    fetch(`/api/documents?id=${victim.id}`, { method: "DELETE" }).catch(() => {});
    setDocuments((prev) => prev.filter((d) => d.id !== victim.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents, autoPull, focusJobId]);

  const isListening = state === "listening";
  /** On stage: พรชัย is the hero, the setup cards step aside. */
  const inMeeting = isListening || state === "connecting";
  const [drawer, setDrawer] = useState<null | "docs" | "memory" | "info">(null);
  // Meeting recorder: long stretches of audio, transcribed properly at the end
  const recorder = useRecorder();
  const [finalizing, setFinalizing] = useState("");
  const [finalTurns, setFinalTurns] = useState<typeof turns>([]);
  // The 30-second cycle: one stretch of audio is recorded, then transcribed as
  // a file. Far more accurate than the live slices, and nearly as immediate.
  // The recording is cut into pieces only to stay inside the transcription
  // API's file limit. Ten minutes of 32 kbps opus is about 2.4 MB.
  // Two minutes, not ten. The file model is a coin toss on a long piece of
  // hard audio — it reads a minute or two and then echoes, loops or stops —
  // and a 10-minute piece turned 8 minutes of a real meeting into one such
  // toss. Shorter pieces give it less to lose on each throw, and the server
  // throws twice per piece and keeps the better one.
  const RECORD_PIECE_MINUTES = 2;
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const turnsRef = useRef(turns);
  const focusJobName = focusJobId ? jobNameById[focusJobId] : "";
  // Display name for the assistant in UI labels (mode-aware).
  const aiName = "พรชัย"; // one assistant across every mode

  return (
    <main className="min-h-screen lg:h-screen flex flex-col lg:overflow-hidden p-3 sm:p-6 max-w-[1600px] mx-auto">
      <audio ref={audioRef} autoPlay />

      {/* Header — fixed top of the app shell (the page itself never scrolls) */}
      <header className="shrink-0 sticky top-0 z-40 -mx-3 px-3 sm:-mx-6 sm:px-6 pt-3 sm:pt-4 pb-3 mb-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-3">
            <img
              src="/pornchai-closed.png"
              alt="พรชัย"
              className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-purple-500/50 shadow-md shadow-purple-500/30"
            />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">AI ผู้ช่วยประชุม</h1>
            </div>
          </div>

          {/* Tabs sit beside the product name — one header row */}
          <nav className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={goHome}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              activeTab === "home"
                ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-1 ring-purple-500/40"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <Sparkles className="h-4 w-4" />
            หน้าแรก
          </button>
          {(
            <>
              <button
                type="button"
                onClick={() => (assistantMode ? setActiveTab("prep") : goHome())}
                title={assistantMode ? undefined : "เลือกโหมดที่หน้าแรกก่อน"}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "prep"
                    ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-1 ring-purple-500/40"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                }`}
              >
                <FolderPlus className="h-4 w-4" />
                เตรียมเอกสาร
              </button>
              <button
                type="button"
                onClick={() => (assistantMode ? setActiveTab("live") : goHome())}
                title={assistantMode ? undefined : "เลือกโหมดที่หน้าแรกก่อน"}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === "live"
                    ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-1 ring-purple-500/40"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                }`}
              >
                <Radio className="h-4 w-4" />
                ห้องประชุม
                {assistantMode === "car" ? " (สอบสวน CAR)" : assistantMode === "pornchai" ? " (พรชัย)" : ""}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setActiveTab("history")}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              activeTab === "history"
                ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-1 ring-purple-500/40"
                : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <History className="h-4 w-4" />
            ประวัติการประชุม
          </button>
          </nav>

          <div className="flex items-center gap-3 ml-auto">
            {/* ความจำพรชัย — standalone hero control, set apart from the utility row */}
            <div className="flex flex-col items-center gap-0.5 pr-4 mr-1 border-r-2 border-purple-300/50 dark:border-purple-500/30">
              <button
                type="button"
                onClick={() => setActiveTab("memory")}
                className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-all bg-gradient-to-r from-purple-600 via-fuchsia-500 to-pink-500 shadow-lg shadow-purple-500/50 hover:shadow-purple-500/70 hover:scale-[1.04] ${
                  activeTab === "memory" ? "ring-2 ring-purple-300 dark:ring-purple-400" : ""
                }`}
              >
                <Brain className="h-5 w-5" />
                ความจำพรชัย
              </button>
              <span className="text-[10px] text-purple-600/80 dark:text-purple-300/80 font-medium">
                คลังสมองถาวร — ดู เพิ่ม ลบ ความจำและแชทเก่า
              </span>
            </div>

            <ThemeToggle />
          </div>
        </div>

      </header>

      {/* Content area — scrolls internally; the shell around it stays fixed */}
      <div className="flex-1 lg:min-h-0 lg:overflow-hidden">
      {activeTab === "home" || (activeTab !== "history" && activeTab !== "memory" && !assistantMode) ? (
        /* Landing: choose the assistant mode first */
        <div className="h-full overflow-y-auto pr-1">
          <div className="max-w-2xl mx-auto space-y-5 pt-6">
            <div className="text-center space-y-3">
              <img
                src="/pornchai-closed.png"
                alt="พรชัย"
                className="mx-auto h-28 w-28 rounded-2xl object-cover ring-2 ring-purple-500/40 shadow-lg shadow-purple-500/25"
              />
              <div>
                <h2 className="text-2xl font-bold">พรชัย</h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">เลือกโหมดประชุมที่ต้องการ</p>
              </div>
            </div>

            {isListening && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300 text-center">
                กำลังประชุมอยู่ — เปลี่ยนโหมดได้หลังจบประชุม
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              {(["okjob", "pornchai", "car"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => chooseAssistantMode(m)}
                  disabled={isListening || state === "connecting"}
                  className={`rounded-2xl border-2 p-6 transition-all hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                    assistantMode === m
                      ? "border-purple-500 bg-purple-500/10"
                      : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-purple-400"
                  }`}
                >
                  <div className="py-3 text-lg font-bold text-center">{MODE_LABEL[m]}</div>
                </button>
              ))}
            </div>

          </div>
        </div>
      ) : activeTab === "history" ? (
        <div className="h-full overflow-y-auto pr-1">
          <MeetingHistory refreshKey={historyRefreshKey} />
        </div>
      ) : activeTab === "memory" ? (
        <div className="h-full overflow-y-auto pr-1 pt-4">
          <PornchaiMemoryPanel />
        </div>
      ) : activeTab === "prep" ? (
        /* Prep documents tab — stage documents, then confirm into the meeting */
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-y-auto pr-1">
            <div className="max-w-2xl mx-auto space-y-4">
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={goHome}
                  title="กลับไปเลือกโหมด"
                  className="flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transition-shadow shrink-0"
                >
                  <ArrowLeft className="h-4 w-4" />
                  กลับ
                </button>
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <FolderPlus className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                    {assistantMode === "car"
                      ? "เอกสารสอบสวน CAR"
                      : assistantMode === "pornchai"
                        ? "เอกสารการประชุม (พรชัย)"
                        : "เลือกเอกสารงาน OK"}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {assistantMode === "car"
                      ? "อัปโหลดตารางสอบสวน CAR และเอกสารประกอบ แล้วกดยืนยันเพื่อเข้าห้องสอบสวน"
                      : assistantMode === "pornchai"
                        ? "อัปโหลดเอกสารที่ใช้ประชุม แล้วกดยืนยันเพื่อเข้าห้องประชุมกับพรชัย"
                        : "ดึงงานจากระบบ REPORT2 แล้วกดยืนยันเพื่อเข้าห้องประชุม"}
                  </p>
                </div>
              </div>

              {usesUploads(assistantMode) ? (
                /* พรชัย / สอบสวน CAR: manually uploaded documents only */
                <DocumentUpload
                  documents={modeDocs}
                  onChange={(next) =>
                    setDocuments((prev) => [...prev.filter((d) => isJobDoc(d.name)), ...next])
                  }
                  onClearAll={clearModeDocs}
                />
              ) : (
                /* OK-job mode: REPORT2 pull only */
                <>
                  {autoPull && catalog.length > 0 && (
                    <div className="flex items-center gap-2 rounded-xl border border-purple-500/40 bg-purple-500/10 px-4 py-2.5 text-xs">
                      <Zap className="h-4 w-4 text-purple-700 dark:text-purple-300 shrink-0" />
                      <span className="text-purple-800 dark:text-purple-100">
                        โหมดดึงอัตโนมัติ: เตรียมไว้ {catalog.length} งาน — จะดึงเอกสารให้เมื่อมีคนพูดถึงเลขจ็อบ
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setAutoPull(false);
                          setCatalog([]);
                        }}
                        className="ml-auto text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                        title="ยกเลิกโหมดอัตโนมัติ"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}

                  <JobPicker
                    documents={modeDocs}
                    onChange={(next) =>
                      setDocuments((prev) => [...prev.filter((d) => !isJobDoc(d.name)), ...next])
                    }
                    onJobLoaded={(jobId, jobName) => {
                      setJobNameById((prev) => ({ ...prev, [jobId]: jobName }));
                    }}
                    onUseCatalog={handleUseCatalog}
                  />
                </>
              )}
              <div className="h-2" />
            </div>
          </div>

          {/* Confirm bar → enter the meeting room */}
          <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 pt-3 mt-2">
            <div className="max-w-2xl mx-auto flex items-center gap-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {assistantMode !== "pornchai" && autoPull
                  ? `เตรียมไว้ ${catalog.length} งาน (ดึงอัตโนมัติ)`
                  : `แนบแล้ว ${modeDocs.length} ไฟล์`}
              </span>
              <button
                type="button"
                onClick={() => setActiveTab("live")}
                className="ml-auto flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transition-shadow"
              >
                <Check className="h-4 w-4" />
                {modeDocs.length === 0 && !(assistantMode !== "pornchai" && autoPull)
                  ? assistantMode === "okjob"
                    ? "เข้าห้องประชุม — ระบบดึงงาน OK วันนี้ให้เอง"
                    : "เข้าห้องประชุม (ไม่มีเอกสาร)"
                  : "ยืนยัน — เข้าห้องประชุม"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : (
      /* Main grid */
      <div className="grid gap-4 lg:gap-6 lg:grid-cols-[320px_1fr] lg:h-full lg:min-h-0">
        {/* Left: พรชัย on stage (during a meeting) or the setup column */}
        <aside
          className={`space-y-4 lg:min-h-0 lg:pr-1 ${
            // The column scrolls in a meeting too: centring it clipped the
            // จบประชุม button off the bottom once the confirm banner arrived.
            inMeeting ? "lg:flex lg:flex-col lg:space-y-4 lg:overflow-y-auto" : "lg:overflow-y-auto"
          }`}
        >
          {!inMeeting && (
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-2">
              หัวข้อการประชุม (ไม่บังคับ)
            </label>
            <input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              placeholder=""
              className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 text-sm focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
            />

            <div className="mt-3 flex items-center gap-2 text-xs">
              <span className="text-slate-500 dark:text-slate-400">โหมด:</span>
              <span className="rounded-md border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 font-medium text-purple-700 dark:text-purple-300">
                {MODE_CHIP[assistantMode ?? "okjob"]}
              </span>
              {(
                <button
                  type="button"
                  onClick={goHome}
                  className="ml-auto text-slate-500 dark:text-slate-400 hover:underline"
                >
                  เปลี่ยนโหมด
                </button>
              )}
            </div>
          </div>
          )}

          {/* พรชัย — the stage light of the meeting screen */}
          <AiAvatar
            speaking={isAiResponding}
            stream={remoteStream}
            name="พรชัย"
            imgClosed="/pornchai-closed.png"
            imgOpen="/pornchai-open.png"
            size={inMeeting ? "stage" : "md"}
          />

          {inMeeting && (
            <ListeningWave
              stream={localStream}
              enabled={micEnabled}
              aiName={aiName}
              busy={transcribing}
              micLabel={micLabel}
              onSwitchMic={switchMic}
            />
          )}

          {inMeeting && assistantMode === "okjob" && catalog.length > 0 && (
            <p className="shrink-0 text-center text-[12px] text-slate-500 dark:text-slate-400" title="อ่านจากช่อง Confirm ของ REPORT2 ทุก 10 วินาที">
              {marks.length === 0 ? (
                <>ยังไม่มีใครกด confirm ใน REPORT2</>
              ) : (
                <>
                  <span className="text-emerald-700 dark:text-emerald-300">✓ confirm แล้ว {marks.length} งาน</span>
                  {" · ล่าสุด "}
                  {marks[marks.length - 1].jobId} {new Date(marks[marks.length - 1].at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}
                </>
              )}
            </p>
          )}

          {/* Everything that is not the conversation lives behind these chips */}
          {inMeeting && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="rounded-full border border-purple-500/40 bg-purple-500/10 px-3 py-1 text-xs font-medium text-purple-700 dark:text-purple-300">
                {MODE_CHIP[assistantMode ?? "okjob"]}
              </span>
              <button
                type="button"
                onClick={() => setDrawer("docs")}
                className="flex items-center gap-1.5 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-3 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-purple-500/50"
              >
                <FileText className="h-3.5 w-3.5" />
                เอกสาร {modeDocs.length}
              </button>
              <button
                type="button"
                onClick={() => setDrawer("memory")}
                className="flex items-center gap-1.5 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-3 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-purple-500/50"
              >
                <Brain className="h-3.5 w-3.5" />
                ความจำ
              </button>
              <button
                type="button"
                onClick={() => setDrawer("info")}
                className="flex items-center gap-1.5 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-3 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-purple-500/50"
              >
                <Target className="h-3.5 w-3.5" />
                รายละเอียด
              </button>
            </div>
          )}

          {/* พรชัย mode has จบประชุม in the action grid — this column button
              only remains for OK-job mode. */}
          {isListening && !usesUploads(assistantMode) && (
            <button
              type="button"
              onClick={handleStop}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-rose-500/15 border border-rose-500/40 px-4 py-3 text-sm font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/20"
            >
              <MicOff className="h-4 w-4" />
              จบประชุม
            </button>
          )}

          {reconnecting && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              การเชื่อมต่อ AI สะดุด — กำลังต่อใหม่อัตโนมัติ... (การประชุมยังบันทึกต่อ)
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}

        </aside>

        {/* Right: setup (before meeting) OR transcript + actions (during meeting) */}
        <section className="flex flex-col gap-4 lg:min-h-0 lg:overflow-hidden">
          {/* Before the meeting: show what's attached + shortcut to the prep tab */}
          {!isListening && state !== "connecting" && (
            <div className="lg:overflow-y-auto lg:min-h-0 space-y-4 lg:pr-1">
              {modeDocs.length > 0 || (assistantMode !== "pornchai" && autoPull) ? (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    เอกสารที่จะใช้ประชุม
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      ({assistantMode !== "pornchai" && autoPull ? `${catalog.length} งาน · อัตโนมัติ` : `${modeDocs.length} ไฟล์`})
                    </span>
                    {modeDocs.length > 0 && (
                      <button
                        type="button"
                        onClick={async () => {
                          // the mode's own documents only, one by one, so the
                          // other modes' files stay where they are
                          for (const d of modeDocs) {
                            await fetch(`/api/documents?id=${d.id}`, { method: "DELETE" }).catch(() => {});
                          }
                          const gone = new Set(modeDocs.map((d) => d.id));
                          setDocuments((prev) => prev.filter((d) => !gone.has(d.id)));
                        }}
                        className="ml-auto text-[11px] text-rose-600 dark:text-rose-400 hover:underline"
                      >
                        ล้างทั้งหมด
                      </button>
                    )}
                  </h3>
                  {autoPull ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      โหมดดึงอัตโนมัติ — ระบบจะดึงเอกสารให้เมื่อมีคนพูดถึงเลขจ็อบระหว่างประชุม
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-72 overflow-y-auto">
                      {modeDocs.map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs"
                        >
                          <FileText className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                          <span className="flex-1 truncate" title={d.name}>{d.name}</span>
                          <button
                            type="button"
                            title="เอาเอกสารนี้ออก"
                            onClick={() => {
                              fetch(`/api/documents?id=${d.id}`, { method: "DELETE" }).catch(() => {});
                              setDocuments((prev) => prev.filter((x) => x.id !== d.id));
                            }}
                            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveTab("prep")}
                    className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    แก้ไข / เพิ่มเอกสาร
                  </button>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-6 text-center space-y-3">
                  <p className="text-sm text-slate-500 dark:text-slate-400">ยังไม่ได้แนบเอกสารประกอบการประชุม</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab("prep")}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/30"
                  >
                    <FolderPlus className="h-4 w-4" />
                    ไปเตรียม / แนบเอกสาร
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Big green start button — centered in the open right-column area */}
          {!isListening && (
            <div className="flex items-center justify-center py-16 sm:py-24">
              {state === "connecting" ? (
                <button
                  type="button"
                  disabled
                  className="flex items-center justify-center gap-3 rounded-2xl bg-slate-200 dark:bg-slate-800 px-10 py-5 text-lg font-bold text-slate-500 dark:text-slate-400 shadow-2xl"
                >
                  <Loader2 className="h-6 w-6 animate-spin" />
                  กำลังเชื่อมต่อ...
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStart}
                  className="flex items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-emerald-500 to-green-600 px-10 py-5 text-lg font-bold text-white shadow-2xl shadow-emerald-500/40 hover:shadow-emerald-500/60 hover:scale-[1.03] transition-all"
                >
                  <Mic className="h-6 w-6" />
                  เริ่มประชุม — {aiName}เริ่มฟัง
                </button>
              )}
            </div>
          )}

          {/* Auto-detected job being discussed */}
          {isListening && focusJobId && (
            <div className="shrink-0 flex items-center gap-2 rounded-xl border border-purple-500/40 bg-purple-500/10 px-4 py-2 text-xs">
              <Target className="h-3.5 w-3.5 text-purple-700 dark:text-purple-300 shrink-0" />
              <span className="text-slate-500 dark:text-slate-400">กำลังพูดถึง:</span>
              <span className="font-mono font-semibold text-purple-700 dark:text-purple-300">{focusJobId}</span>
              {focusJobName && <span className="text-slate-500 dark:text-slate-400 truncate">— {focusJobName}</span>}
              {(() => {
                const loaded = documents.some((d) => jobIdOf(d.name) === focusJobId);
                if (loaded)
                  return (
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-300">
                      <Check className="h-3 w-3" />
                      โหลดเอกสารแล้ว
                    </span>
                  );
                if (pullState[focusJobId] === "pulling")
                  return (
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-purple-700 dark:text-purple-300">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      กำลังดึงเอกสาร...
                    </span>
                  );
                if (pullState[focusJobId] === "error")
                  return (
                    <button
                      type="button"
                      onClick={() => autoPullJob(focusJobId)}
                      className="ml-auto flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300 hover:underline"
                    >
                      ดึงไม่สำเร็จ — กดลองใหม่
                    </button>
                  );
                return (
                  <button
                    type="button"
                    onClick={() => autoPullJob(focusJobId)}
                    className="ml-auto text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:underline"
                  >
                    กดเพื่อดึงเอกสาร
                  </button>
                );
              })()}
            </div>
          )}

          {(isListening || state === "connecting") && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <TranscriptFeed
                turns={turns}
                jobDigests={Object.fromEntries(documents.filter((d) => d.summary).map((d) => [jobIdOf(d.name), d.summary as string]))}
                isAiResponding={isAiResponding}
                liveUserText={liveUserText}
                liveAiText={liveAiText}
                thinking={aiThinking}
                aiName={aiName}
                bare={inMeeting}
                waitingForChunk={inMeeting}
              />
            </div>
          )}

          {/* Action buttons (fixed at bottom of the column) */}
          {isListening && (
            <div className="space-y-2 shrink-0 pt-1">
              {showQuestionBox ? (
                <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                      <HelpCircle className="h-3.5 w-3.5" />
                      ถามคำถาม{aiName}
                    </label>
                    <div className="flex items-center gap-2">
                    {questionPhase !== "idle" && (
                      <button
                        type="button"
                        onClick={handleUseKeyboard}
                        className="flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                      >
                        ใช้แป้นพิมพ์
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleCancelVoiceQuestion}
                      className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
                    </div>
                  </div>

                  {questionPhase === "idle" && (
                    <div className="space-y-2">
                      {/* Type a question — for noisy rooms */}
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={typedQuestion}
                          onChange={(e) => setTypedQuestion(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSendTypedQuestion();
                            }
                          }}
                          placeholder="พิมพ์คำถามที่นี่…"
                          className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-purple-500/50"
                        />
                        <button
                          type="button"
                          onClick={handleSendTypedQuestion}
                          disabled={!typedQuestion.trim() || isAiResponding}
                          className="flex items-center justify-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-sm font-semibold text-white shrink-0"
                        >
                          <Send className="h-3.5 w-3.5" />
                          ส่ง
                        </button>
                      </div>

                      <div className="flex items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500">
                        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                        หรือ
                        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                      </div>

                      <button
                        type="button"
                        onClick={handleStartVoiceQuestion}
                        disabled={isAiResponding}
                        className="w-full flex items-center justify-center gap-2 rounded-lg border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-50 px-3 py-2.5 text-sm font-semibold text-purple-700 dark:text-purple-200"
                      >
                        <Mic className="h-4 w-4" />
                        กลับไปพูดถามด้วยเสียง
                      </button>
                    </div>
                  )}

                  {questionPhase === "recording" && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                        </span>
                        กำลังฟัง... พูดคำถามได้เลย จบแล้วกด &ldquo;พูดเสร็จแล้ว&rdquo;
                      </div>
                      {liveQuestionText && (
                        <div className="rounded-lg bg-white dark:bg-slate-900 border border-purple-500/30 px-3 py-2 text-sm">
                          <span className="text-xs text-slate-500 dark:text-slate-400">ได้ยินว่า:</span>
                          <p className="text-slate-900 dark:text-slate-100 mt-0.5">{liveQuestionText}</p>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handleTranscribeQuestion}
                        className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 px-3 py-2 text-sm font-semibold text-white"
                      >
                        <Mic className="h-3.5 w-3.5" />
                        พูดเสร็จแล้ว
                      </button>
                    </div>
                  )}

                  {questionPhase === "confirming" && (
                    <div className="space-y-2">
                      {!pendingQuestion ? (
                        questionTimedOut ? (
                          <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                            ไม่ได้ยินคำถามชัดเจน — กด &ldquo;พูดใหม่&rdquo; แล้วลองอีกครั้ง
                          </div>
                        ) : (
                          <div className="rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 dark:text-slate-400 space-y-1">
                            <div className="flex items-center gap-2">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              กำลังถอดเสียงคำถาม...
                            </div>
                            {liveQuestionText && (
                              <p className="text-sm text-slate-700 dark:text-slate-200">{liveQuestionText}</p>
                            )}
                          </div>
                        )
                      ) : (
                        <div className="rounded-lg bg-white dark:bg-slate-900 border border-purple-500/30 px-3 py-2 text-sm">
                          <span className="text-xs text-slate-500 dark:text-slate-400">คุณถามว่า:</span>
                          <p className="text-slate-900 dark:text-slate-100 mt-0.5">{pendingQuestion}</p>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={handleRedoQuestion}
                          className="flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200"
                        >
                          <Mic className="h-3.5 w-3.5" />
                          พูดใหม่
                        </button>
                        <button
                          type="button"
                          onClick={handleConfirmQuestion}
                          disabled={!pendingQuestion || isAiResponding}
                          className="flex items-center justify-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-sm font-semibold text-white"
                        >
                          <Send className="h-3.5 w-3.5" />
                          ส่ง
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : picker ? (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                      <Lightbulb className="h-3.5 w-3.5" />
                      {picker === "car" ? "อยากฟัง CAR ของงานไหน? แตะเลือกได้เลย" : "อยากฟังข้อเสนอแนะของงานไหน? แตะเลือก"}
                    </label>
                    <button type="button" onClick={() => setPicker(null)} className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[11px]">
                    <button
                      type="button"
                      onClick={() =>
                        setPickerSel(
                          pickerSel.length === modeDocs.length
                            ? []
                            : modeDocs.map((d) => d.name.replace(/\.pdf$/i, "")),
                        )
                      }
                      className="text-amber-700 dark:text-amber-300 hover:underline"
                    >
                      {pickerSel.length === modeDocs.length ? "ล้างทั้งหมด" : "เลือกทั้งหมด"}
                    </button>
                    <button
                      type="button"
                      onClick={() => askJobListByVoice(picker)}
                      disabled={isAiResponding}
                      className="flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-50"
                    >
                      <Mic className="h-3 w-3" />
                      ให้ AI ถามอีกครั้ง
                    </button>
                  </div>

                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {modeDocs.map((d) => {
                      const jid = d.name.replace(/\.pdf$/i, "");
                      const checked = pickerSel.includes(jid);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() =>
                            setPickerSel((prev) =>
                              prev.includes(jid) ? prev.filter((x) => x !== jid) : [...prev, jid],
                            )
                          }
                          className={`w-full flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
                            checked
                              ? "border-amber-500/50 bg-amber-500/15 text-amber-100"
                              : "border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300"
                          }`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "bg-amber-400 border-amber-400" : "border-slate-500"}`}>
                            {checked && <Check className="h-3 w-3 text-slate-900 dark:text-slate-100" />}
                          </span>
                          <span className="font-mono text-amber-700 dark:text-amber-300">{jid}</span>
                          <span className="text-xs text-slate-500 dark:text-slate-400 truncate">{jobNameById[jid] || ""}</span>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => runMultiSummary(picker, pickerSel)}
                    disabled={pickerSel.length === 0}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
                  >
                    <Send className="h-3.5 w-3.5" />
                    สรุป {pickerSel.length} งาน
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {/* While พรชัย is talking this slot is the stop button — in every mode */}
                  {isAiResponding || usesUploads(assistantMode) ? (
                    <button
                      type="button"
                      onClick={isAiResponding ? handleCancelSpeech : handleFreeTalk}
                      disabled={aiThinking || (isAiResponding && voiceMuted)}
                      title={
                        isAiResponding
                          ? "ยกเลิกคำตอบนี้ทันที (หยุดทั้งเสียงและข้อความ)"
                          : "พรชัยพูดตามบริบทล่าสุดในที่ประชุม (ความเห็น/ข้อเสนอแนะ/ข้อสังเกต)"
                      }
                      className={`flex flex-1 basis-40 items-center justify-center gap-2 rounded-full border px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
                        isAiResponding
                          ? "bg-gradient-to-br from-rose-500/20 to-red-500/20 border-rose-500/40 hover:from-rose-500/30 hover:to-red-500/30 text-rose-700 dark:text-rose-300"
                          : "bg-gradient-to-br from-amber-500/20 to-orange-500/20 border-amber-500/40 hover:from-amber-500/30 hover:to-orange-500/30 text-amber-800 dark:text-amber-200"
                      }`}
                    >
                      {isAiResponding ? (
                        <VolumeX className="h-4 w-4 shrink-0" />
                      ) : (
                        <MessageSquare className="h-4 w-4 shrink-0" />
                      )}
                      {isAiResponding
                        ? voiceMuted
                          ? "ยกเลิกแล้ว"
                          : "ยกเลิกการพูด"
                        : "ให้พรชัยพูด"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSuggestion}
                      disabled={isAiResponding || modeDocs.length === 0}
                      title={modeDocs.length === 0 ? "โหลดเอกสารงานก่อน (CAR มาจากเอกสาร)" : undefined}
                      className="flex flex-1 basis-40 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/40 hover:from-amber-500/30 hover:to-orange-500/30 px-4 py-3 text-sm font-semibold text-amber-800 dark:text-amber-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Lightbulb className="h-4 w-4 shrink-0" />
                      ขอ CAR ลูกค้า
                    </button>
                  )}
                  {usesUploads(assistantMode) ? (
                    /* พรชัย / CAR: "ข้อเสนอแนะ" is merged into ให้พรชัยพูด — this
                       slot ends the meeting so there is no need to scroll down. */
                    <button
                      type="button"
                      onClick={handleStop}
                      className="flex flex-1 basis-40 items-center justify-center gap-2 rounded-full bg-rose-500/15 border border-rose-500/40 hover:bg-rose-500/20 px-4 py-3 text-sm font-semibold text-rose-700 dark:text-rose-300"
                    >
                      <MicOff className="h-4 w-4 shrink-0" />
                      จบประชุม
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleComment}
                      disabled={isAiResponding}
                      className="flex flex-1 basis-40 items-center justify-center gap-2 rounded-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/40 hover:from-purple-500/30 hover:to-pink-500/30 px-4 py-3 text-sm font-semibold text-purple-700 dark:text-purple-300 disabled:opacity-50"
                    >
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      ข้อเสนอแนะ{aiName}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMicEnabled(true);
                      setTypedQuestion("");
                      setShowQuestionBox(true);
                      handleStartVoiceQuestion();
                    }}
                    disabled={isAiResponding || aiThinking}
                    className="flex flex-1 basis-40 items-center justify-center gap-2 rounded-full bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                  >
                    <HelpCircle className="h-4 w-4 shrink-0" />
                    ถามคำถาม{aiName}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMicEnabled(!micEnabled)}
                    className={`flex flex-1 basis-40 items-center justify-center gap-2 rounded-full border px-4 py-3 text-sm font-semibold transition-colors ${
                      micEnabled
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                    }`}
                  >
                    {micEnabled ? <MicOff className="h-4 w-4 shrink-0" /> : <Mic className="h-4 w-4 shrink-0" />}
                    {micEnabled ? "หยุดฟัง" : `ให้${aiName}ฟัง`}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Drawers — เอกสาร / ความจำ / รายละเอียด slide up over the stage */}
        {drawer && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4"
            onClick={() => setDrawer(null)}
          >
            <div
              className="sheet-up w-full sm:max-w-3xl max-h-[80vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold flex items-center gap-2">
                  {drawer === "docs" && <><FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" /> เอกสารที่พรชัยใช้อ้างอิง</>}
                  {drawer === "memory" && <><Brain className="h-4 w-4 text-purple-600 dark:text-purple-400" /> ความจำพรชัย</>}
                  {drawer === "info" && <><Target className="h-4 w-4 text-purple-600 dark:text-purple-400" /> รายละเอียดการประชุม</>}
                </h3>
                <button
                  type="button"
                  onClick={() => setDrawer(null)}
                  className="text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  aria-label="ปิด"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {drawer === "docs" && (
                <div className="space-y-2">
                  {modeDocs.length === 0 ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">ยังไม่มีเอกสารแนบในประชุมนี้</p>
                  ) : (
                    modeDocs.map((d) => (
                      <div
                        key={d.id}
                        className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm"
                      >
                        <FileText className="h-4 w-4 text-slate-500 dark:text-slate-400 shrink-0" />
                        <span className="flex-1 truncate" title={d.name}>{d.name}</span>
                      </div>
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDrawer(null);
                      setActiveTab("prep");
                    }}
                    className="mt-1 flex items-center gap-1.5 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    ไปหน้าเตรียมเอกสาร
                  </button>
                </div>
              )}

              {drawer === "memory" && <PornchaiMemoryPanel />}

              {drawer === "info" && (
                <div className="space-y-3 text-sm">
                  <div>
                    <span className="text-xs text-slate-500 dark:text-slate-400">หัวข้อ</span>
                    <p className="font-medium">{meetingTitle || "(ไม่มีหัวข้อ)"}</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500 dark:text-slate-400">โหมด</span>
                    <span className="rounded-full border border-purple-500/40 bg-purple-500/10 px-3 py-0.5 font-medium text-purple-700 dark:text-purple-300">
                      {MODE_CHIP[assistantMode ?? "okjob"]}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                    <span>{turns.length} เทิร์น</span>
                    <span>{micEnabled ? "ไมค์เปิด" : "ไมค์ปิด"}</span>
                  </div>
                  {focusJobId && (
                    <div className="text-xs">
                      <span className="text-slate-500 dark:text-slate-400">กำลังพูดถึงงาน </span>
                      <span className="font-mono font-semibold text-purple-700 dark:text-purple-300">{focusJobId}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDebugOpen(true);
                      setDrawer(null);
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    <Bug className="h-3.5 w-3.5" />
                    เปิดแผงดีบัก
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      )}
      </div>

      <MeetingSummaryModal
        open={summaryOpen}
        loading={summaryLoading}
        loadingText={finalizing}
        processing={processingNote}
        error={summaryError}
        meetingTitle={endedMeta.meetingTitle}
        jobIds={endedMeta.jobIds}
        startedAt={endedMeta.startedAt}
        endedAt={endedMeta.endedAt}
        turns={finalTurns.length > 0 ? finalTurns : turns}
        rawFile={rawPasses.file}
        rawLive={rawPasses.live}
        fileNote={fileNote}
        recordingId={recordingIdRef.current}
        summary={summaryText}
        onClose={() => {
          setSummaryOpen(false);
          if (summarySaved) resetTranscript(); // keep transcript on screen if unsaved
        }}
        onViewHistory={() => {
          setSummaryOpen(false);
          if (summarySaved) resetTranscript();
          setActiveTab("history");
        }}
        onRetry={handleRetrySave}
      />

      <DebugPanel
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        meetingState={state}
        connectionState={connectionState}
        dataChannelReady={dataChannelReady}
        isAiResponding={isAiResponding}
        micEnabled={micEnabled}
        turns={turns.length}
        error={error}
        log={debugLog}
      />
    </main>
  );
}
