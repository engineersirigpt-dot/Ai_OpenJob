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
} from "lucide-react";
import { useWebRTC, type RealtimeSessionConfig } from "@/hooks/use-webrtc";
import { useTranscript } from "@/hooks/use-transcript";
import { useTranscriber, type TranscribedSegment } from "@/hooks/use-transcriber";
import { TranscriptFeed } from "@/components/transcript-feed";
import { DocumentUpload } from "@/components/document-upload";
import { JobPicker, type JobCatalogItem } from "@/components/job-picker";
import { MeetingHistory } from "@/components/meeting-history";
import { PrecautionsButton } from "@/components/precautions";
import { AiAvatar } from "@/components/ai-avatar";
import { MicLevelMeter } from "@/components/mic-level-meter";
import { MeetingSummaryModal } from "@/components/meeting-summary-modal";
import { DebugPanel, type DebugLogEntry } from "@/components/debug-panel";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  buildCommentPrompt,
  buildVoiceQuestionInstruction,
  buildMultiCarPrompt,
  buildMultiCommentPrompt,
} from "@/lib/prompts";
import { matchJobMention } from "@/lib/job-match";

type MeetingState = "idle" | "connecting" | "listening" | "error";

interface DocumentInfo {
  id: string;
  name: string;
  preview: string;
  uploadedAt: string;
}

// localStorage key for a meeting that failed to save (recovered on next load)
const PENDING_MEETING_KEY = "ai_openjob_pending_meeting";

// Auto-pull mode: how many on-demand documents to keep loaded before evicting
// the least-recently-mentioned one.
const AUTO_CACHE_MAX = 6;

// Default meeting title based on the time of day (morning vs afternoon session).
function autoMeetingTitle(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("th-TH", { day: "numeric", month: "long", year: "numeric" });
  const period = now.getHours() < 12 ? "ช่วงเช้า" : "ช่วงบ่าย";
  return `ประชุม OK งาน ${dateStr} ${period}`;
}

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
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [jobNameById, setJobNameById] = useState<Record<string, string>>({});
  // Job the meeting is currently talking about — auto-detected from speech.
  const [focusJobId, setFocusJobId] = useState<string | null>(null);
  // Auto-pull mode: the day's job catalog (NOT pulled yet); documents are
  // fetched on demand when a Job ID is spoken, then evicted when stale.
  const [autoPull, setAutoPull] = useState(false);
  const [catalog, setCatalog] = useState<JobCatalogItem[]>([]);
  const pullingRef = useRef<Set<string>>(new Set());
  const lastSeenRef = useRef<Record<string, number>>({});
  // Per-job auto-pull status for an honest badge: "pulling" | "error".
  const [pullState, setPullState] = useState<Record<string, "pulling" | "error">>({});
  const [showQuestionBox, setShowQuestionBox] = useState(false);
  const [questionPhase, setQuestionPhase] = useState<"idle" | "recording" | "confirming">("idle");
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [typedQuestion, setTypedQuestion] = useState("");
  const [questionTimedOut, setQuestionTimedOut] = useState(false);
  const [activeTab, setActiveTab] = useState<"live" | "prep" | "history">("prep");
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  // Post-meeting summary modal
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
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

  const { turns, isAiResponding, liveUserText, liveAiText, handleRealtimeEvent, addUserTurn, appendUserTurn, reset: resetTranscript } = useTranscript();
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

  const { connect, disconnect, sendEvent, setMicEnabled, micEnabled, remoteStream, localStream, connectionState, dataChannelReady } = useWebRTC({
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
  useEffect(() => {
    connectionStateRef.current = connectionState;
    meetingTitleRef.current = meetingTitle;
    documentsRef.current = documents;
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
          sessionConfigRef.current = await connect({
            meetingTitle: meetingTitleRef.current || undefined,
            documentIds: documentsRef.current.map((d) => d.id),
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
  const handleMeetingText = useCallback(
    (seg: TranscribedSegment) => {
      const ok = seg.decision === "accept";
      appendUserTurn(ok ? seg.text : `${seg.text} ⟨อาจฟังไม่ชัด⟩`);
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
    [appendUserTurn, sendEvent],
  );

  // Meeting transcription runs on our on-premises Typhoon ASR service: the
  // browser captures PCM, cuts a segment when the speaker pauses, and posts it
  // to /api/transcribe.
  useEffect(() => {
    if (state === "listening" && localStream) {
      startTranscriber(localStream, handleMeetingText, setTranscribing);
      return () => {
        stopTranscriber();
        setTranscribing(false);
      };
    }
  }, [state, localStream, startTranscriber, stopTranscriber, handleMeetingText]);

  // Keep listening even while the AI speaks — people talk over it in a real
  // meeting, and pausing used to throw that speech away entirely. The browser's
  // echoCancellation strips the AI's own speaker audio from the mic, so its
  // voice doesn't end up in the transcript. Only a muted mic pauses capture.
  useEffect(() => {
    setTranscriberPaused(!micEnabled);
  }, [micEnabled, setTranscriberPaused]);

  // Mic audio still streams to the Realtime peer to keep the connection alive,
  // but we never commit it — clear periodically so its buffer can't grow.
  useEffect(() => {
    if (state !== "listening") return;
    const id = setInterval(() => sendEvent({ type: "input_audio_buffer.clear" }), 15000);
    return () => clearInterval(id);
  }, [state, sendEvent]);

  // Default the meeting title from the time of day (morning/afternoon session).
  useEffect(() => {
    setMeetingTitle((prev) => prev || autoMeetingTitle());
  }, []);

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
    setState("connecting");
    setError("");
    setFocusJobId(null);
    setPullState({});
    lastSeenRef.current = {};
    lastAcceptedCtxRef.current = "";
    resetTranscript();
    sessionConfigRef.current = null;
    startedAtRef.current = new Date().toISOString();

    try {
      sessionConfigRef.current = await connect({
        meetingTitle: meetingTitle || undefined,
        documentIds: documents.map((d) => d.id),
      });
      setState("listening");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  }

  async function handleStop() {
    disconnect();
    setState("idle");

    if (turns.length === 0) return;

    // Persist the meeting (with summary) and show the post-meeting summary
    const jobIds = documents
      .map((d) => d.name.match(/^(J\d{8})\.pdf$/i)?.[1]?.toUpperCase())
      .filter((x): x is string => Boolean(x));
    const jobNames = jobIds.map((j) => jobNameById[j]).filter(Boolean);
    const startedAt = startedAtRef.current;
    const endedAt = new Date().toISOString();

    const payload = { meetingTitle, jobIds, jobNames, startedAt, endedAt, transcript: turns };
    pendingPayloadRef.current = payload;
    // Back up immediately so the transcript is never lost, even on a crash
    try {
      localStorage.setItem(PENDING_MEETING_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }

    // Snapshot meeting info for the summary modal, then clear documents NOW
    // so old docs can't linger into the next meeting (the modal uses the
    // snapshot + transcript, not the live document/title state).
    setEndedMeta({ meetingTitle, jobIds, startedAt, endedAt });
    setSummaryText("");
    setSummaryError("");
    setSummarySaved(false);
    setSummaryOpen(true);
    clearMeetingDocs();

    await persistMeeting(payload);
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
        setSummarySaved(true);
        setHistoryRefreshKey((k) => k + 1);
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

  function handleRetrySave() {
    if (pendingPayloadRef.current) persistMeeting(pendingPayloadRef.current);
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
    setMeetingTitle(autoMeetingTitle()); // refresh for the next session (AM/PM)
    setFocusJobId(null);
    setAutoPull(false);
    setCatalog([]);
    setPullState({});
    lastSeenRef.current = {};
  }

  const jobIdOf = (name: string) => name.replace(/\.pdf$/i, "");

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
          : [...prev, { id: data.id, name: data.name, preview: data.preview, uploadedAt: data.uploadedAt }],
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
    const all = documents.map((d) => jobIdOf(d.name));
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
    if (jobIds.length > 0) {
      const ids = jobIds
        .map((jid) => documents.find((d) => d.name === `${jid}.pdf`)?.id)
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
      text = mode === "car" ? buildMultiCarPrompt(docsContent) : buildMultiCommentPrompt(docsContent);
    } else {
      text = buildCommentPrompt(); // comment with no documents → use discussion only
    }

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
    if (state !== "listening" || isAiResponding || documents.length === 0) return;
    if (documents.length > 1) {
      openPicker("car");
      return;
    }
    runMultiSummary("car", [jobIdOf(documents[0].name)]);
  }

  // Comment on the whole discussion right away — no job picking. The AI already
  // has the meeting transcript + document digests in context.
  function handleComment() {
    if (state !== "listening" || isAiResponding) return;
    runMultiSummary("comment", []);
  }

  // Step 1: start capturing a voice question (pauses meeting segmentation).
  function handleStartVoiceQuestion() {
    if (state !== "listening" || isAiResponding) return;
    setMicEnabled(true);
    setPendingQuestion("");
    setQuestionTimedOut(false);
    startQuestion();
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

  // Step 3a: confirmed — hand the question text to the AI and let it answer.
  function handleConfirmQuestion() {
    if (!pendingQuestion) return;
    addUserTurn(pendingQuestion);
    sendEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: pendingQuestion }] },
    });
    sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: buildVoiceQuestionInstruction(),
        max_output_tokens: 4096,
      },
    });
    setQuestionPhase("idle");
    setPendingQuestion("");
    setShowQuestionBox(false);
    resumeMeeting();
  }

  // Typed question — for noisy rooms where speaking isn't practical.
  function handleSendTypedQuestion() {
    const q = typedQuestion.trim();
    if (!q || state !== "listening" || isAiResponding) return;
    addUserTurn(q);
    sendEvent({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: q }] },
    });
    sendEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: buildVoiceQuestionInstruction(),
        max_output_tokens: 4096,
      },
    });
    setTypedQuestion("");
    setShowQuestionBox(false);
  }

  // Step 3b: redo — discard and record again.
  function handleRedoQuestion() {
    setPendingQuestion("");
    setQuestionTimedOut(false);
    startQuestion();
    setQuestionPhase("recording");
  }

  function handleCancelVoiceQuestion() {
    cancelQuestion();
    setPendingQuestion("");
    setTypedQuestion("");
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
  const focusJobName = focusJobId ? jobNameById[focusJobId] : "";

  return (
    <main className="min-h-screen lg:h-screen flex flex-col lg:overflow-hidden p-3 sm:p-6 max-w-6xl mx-auto">
      <audio ref={audioRef} autoPlay />

      {/* Header — fixed top of the app shell (the page itself never scrolls) */}
      <header className="shrink-0 sticky top-0 z-40 -mx-3 px-3 sm:-mx-6 sm:px-6 pt-3 sm:pt-4 pb-3 mb-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">AI ผู้ช่วยประชุม</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">ฟังประชุม อ่านเอกสาร และตอบคำถามได้</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setDebugOpen((v) => !v)}
              title="แผงดีบัก"
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                debugOpen
                  ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              }`}
            >
              <Bug className="h-3.5 w-3.5" />
              Debug
            </button>
            <PrecautionsButton />
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-4 flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={() => setActiveTab("prep")}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === "prep"
                ? "border-purple-500 text-purple-700 dark:text-purple-300"
                : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <FolderPlus className="h-4 w-4" />
            เตรียมเอกสาร
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("live")}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === "live"
                ? "border-purple-500 text-purple-700 dark:text-purple-300"
                : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <Radio className="h-4 w-4" />
            ห้องประชุม
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("history")}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === "history"
                ? "border-purple-500 text-purple-700 dark:text-purple-300"
                : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            <History className="h-4 w-4" />
            ประวัติการประชุม
          </button>
        </div>
      </header>

      {/* Content area — scrolls internally; the shell around it stays fixed */}
      <div className="flex-1 lg:min-h-0 lg:overflow-hidden">
      {activeTab === "history" ? (
        <div className="h-full overflow-y-auto pr-1">
          <MeetingHistory refreshKey={historyRefreshKey} />
        </div>
      ) : activeTab === "prep" ? (
        /* Prep documents tab — stage documents, then confirm into the meeting */
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-y-auto pr-1">
            <div className="max-w-2xl mx-auto space-y-4">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <FolderPlus className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  เลือกเอกสารประกอบการประชุม
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  ดึงงานจาก REPORT2 หรืออัปโหลดเอกสาร แล้วกดยืนยันเพื่อเข้าห้องประชุม
                </p>
              </div>

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
                documents={documents}
                onChange={setDocuments}
                onJobLoaded={(jobId, jobName) => {
                  setJobNameById((prev) => ({ ...prev, [jobId]: jobName }));
                }}
                onUseCatalog={handleUseCatalog}
              />
              <DocumentUpload
                documents={documents}
                onChange={setDocuments}
                onClearAll={clearMeetingDocs}
              />
              <div className="h-2" />
            </div>
          </div>

          {/* Confirm bar → enter the meeting room */}
          <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 pt-3 mt-2">
            <div className="max-w-2xl mx-auto flex items-center gap-3">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {autoPull
                  ? `เตรียมไว้ ${catalog.length} งาน (ดึงอัตโนมัติ)`
                  : `แนบแล้ว ${documents.length} ไฟล์`}
              </span>
              <button
                type="button"
                onClick={() => setActiveTab("live")}
                disabled={documents.length === 0 && !autoPull}
                className="ml-auto flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-shadow"
              >
                <Check className="h-4 w-4" />
                {documents.length === 0 && !autoPull ? "ดึง/อัปโหลดเอกสารก่อน" : "ยืนยัน — เข้าห้องประชุม"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : (
      /* Main grid */
      <div className="grid gap-4 lg:gap-6 lg:grid-cols-[320px_1fr] lg:h-full lg:min-h-0">
        {/* Left: setup */}
        <aside className="space-y-4 lg:overflow-y-auto lg:min-h-0 lg:pr-1">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-2">
              หัวข้อการประชุม (ไม่บังคับ)
            </label>
            <input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              disabled={isListening || state === "connecting"}
              placeholder=""
              className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 text-sm focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
            />
          </div>

          {/* AI face — reacts both when it speaks and while it sits listening */}
          <AiAvatar
            speaking={isAiResponding}
            stream={remoteStream}
            listening={isListening}
            micEnabled={micEnabled}
            micStream={localStream}
            thinking={transcribing}
          />

          {/* Reference documents the AI is using (shown during the meeting) */}
          {(isListening || state === "connecting") && documents.length > 0 && (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                เอกสารอ้างอิง
                <span className="text-xs text-slate-500 dark:text-slate-400">({documents.length})</span>
              </h3>
              {documents.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs"
                >
                  <FileText className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  <span className="flex-1 truncate" title={d.name}>{d.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Main control button */}
          {state === "idle" || state === "error" ? (
            <button
              type="button"
              onClick={handleStart}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transition-shadow"
            >
              <Mic className="h-4 w-4" />
              เริ่มประชุม — AI เริ่มฟัง
            </button>
          ) : state === "connecting" ? (
            <button
              type="button"
              disabled
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-slate-200 dark:bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-500 dark:text-slate-400"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              กำลังเชื่อมต่อ...
            </button>
          ) : (
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
              {documents.length > 0 || autoPull ? (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    เอกสารที่จะใช้ประชุม
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      ({autoPull ? `${catalog.length} งาน · อัตโนมัติ` : `${documents.length} ไฟล์`})
                    </span>
                  </h3>
                  {autoPull ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      โหมดดึงอัตโนมัติ — ระบบจะดึงเอกสารให้เมื่อมีคนพูดถึงเลขจ็อบระหว่างประชุม
                    </p>
                  ) : (
                    <div className="space-y-1.5 max-h-72 overflow-y-auto">
                      {documents.map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs"
                        >
                          <FileText className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                          <span className="flex-1 truncate" title={d.name}>{d.name}</span>
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

          {/* Status bar (fixed within the column) */}
          {isListening && (
            <div
              className={`shrink-0 flex items-center gap-2 rounded-xl border px-4 py-2 text-xs ${
                micEnabled
                  ? "bg-emerald-500/20 border-emerald-500/40"
                  : "bg-amber-500/20 border-amber-500/40"
              }`}
            >
              {micEnabled ? (
                <>
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-emerald-700 dark:text-emerald-300 font-medium">AI กำลังฟังการประชุม</span>
                </>
              ) : (
                <>
                  <MicOff className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  <span className="text-amber-700 dark:text-amber-300 font-medium">หยุดฟัง — AI ไม่ได้ยินตอนนี้</span>
                </>
              )}
              <span className="text-slate-500 dark:text-slate-400">·</span>
              <span className="text-slate-500 dark:text-slate-400">{turns.length} เทิร์น</span>
              {transcribing && (
                <>
                  <span className="text-slate-500 dark:text-slate-400">·</span>
                  <span className="flex items-center gap-1 text-sky-700 dark:text-sky-300">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    กำลังถอดเสียง
                  </span>
                </>
              )}
              <span className="text-slate-500 dark:text-slate-400">·</span>
              <span className="ml-auto flex items-center gap-1">
                <MicLevelMeter stream={localStream} enabled={micEnabled} />
                <span className="text-[10px] text-slate-500 dark:text-slate-400">{micEnabled ? "ไมค์" : "ปิด"}</span>
              </span>
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
            <div className="flex-1 min-h-0">
              <TranscriptFeed
                turns={turns}
                isAiResponding={isAiResponding}
                liveUserText={liveUserText}
                liveAiText={liveAiText}
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
                      ถามคำถาม AI (พิมพ์หรือพูด)
                    </label>
                    <button
                      type="button"
                      onClick={handleCancelVoiceQuestion}
                      className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
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
                        พูดถามด้วยเสียง
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
                        กำลังฟังคำถาม... พูดได้เลย แล้วกด &ldquo;ถอดเสียง&rdquo;
                      </div>
                      <button
                        type="button"
                        onClick={handleTranscribeQuestion}
                        className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 px-3 py-2 text-sm font-semibold text-white"
                      >
                        <Send className="h-3.5 w-3.5" />
                        หยุดพูด / ถอดเสียง
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
                          <div className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            กำลังถอดเสียงคำถาม...
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
                          ยืนยันส่ง
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
                          pickerSel.length === documents.length
                            ? []
                            : documents.map((d) => d.name.replace(/\.pdf$/i, "")),
                        )
                      }
                      className="text-amber-700 dark:text-amber-300 hover:underline"
                    >
                      {pickerSel.length === documents.length ? "ล้างทั้งหมด" : "เลือกทั้งหมด"}
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
                    {documents.map((d) => {
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
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleSuggestion}
                    disabled={isAiResponding || documents.length === 0}
                    title={documents.length === 0 ? "โหลดเอกสารงานก่อน (CAR มาจากเอกสาร)" : undefined}
                    className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/40 hover:from-amber-500/30 hover:to-orange-500/30 px-3 py-3 text-sm font-semibold text-amber-800 dark:text-amber-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Lightbulb className="h-4 w-4 shrink-0" />
                    ขอ CAR ลูกค้า
                  </button>
                  <button
                    type="button"
                    onClick={handleComment}
                    disabled={isAiResponding}
                    className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/40 hover:from-purple-500/30 hover:to-pink-500/30 px-3 py-3 text-sm font-semibold text-purple-700 dark:text-purple-300 disabled:opacity-50"
                  >
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    ข้อเสนอแนะ AI
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMicEnabled(true);
                      setQuestionPhase("idle");
                      setPendingQuestion("");
                      setShowQuestionBox(true);
                    }}
                    disabled={isAiResponding}
                    className="flex items-center justify-center gap-2 rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 px-3 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50"
                  >
                    <HelpCircle className="h-4 w-4 shrink-0" />
                    ถามคำถาม AI
                  </button>
                  <button
                    type="button"
                    onClick={() => setMicEnabled(!micEnabled)}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold transition-colors ${
                      micEnabled
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                    }`}
                  >
                    {micEnabled ? <MicOff className="h-4 w-4 shrink-0" /> : <Mic className="h-4 w-4 shrink-0" />}
                    {micEnabled ? "หยุดฟัง" : "ให้ AI ฟัง"}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      )}
      </div>

      <MeetingSummaryModal
        open={summaryOpen}
        loading={summaryLoading}
        error={summaryError}
        meetingTitle={endedMeta.meetingTitle}
        jobIds={endedMeta.jobIds}
        startedAt={endedMeta.startedAt}
        endedAt={endedMeta.endedAt}
        turns={turns}
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
