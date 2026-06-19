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
} from "lucide-react";
import { useWebRTC, type RealtimeSessionConfig } from "@/hooks/use-webrtc";
import { useTranscript } from "@/hooks/use-transcript";
import { TranscriptFeed } from "@/components/transcript-feed";
import { DocumentUpload } from "@/components/document-upload";
import { buildCommentPrompt, buildQuestionPrompt } from "@/lib/prompts";

type MeetingState = "idle" | "connecting" | "listening" | "error";

interface DocumentInfo {
  id: string;
  name: string;
  preview: string;
  uploadedAt: string;
}

export default function MeetingPage() {
  const [state, setState] = useState<MeetingState>("idle");
  const [error, setError] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [questionInput, setQuestionInput] = useState("");
  const [showQuestionBox, setShowQuestionBox] = useState(false);
  const sessionConfigRef = useRef<RealtimeSessionConfig | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const { turns, isAiResponding, liveUserText, liveAiText, handleRealtimeEvent, reset: resetTranscript } = useTranscript();

  const onDataChannelMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        handleRealtimeEvent(data);
      } catch { /* ignore */ }
    },
    [handleRealtimeEvent],
  );

  const { connect, disconnect, sendEvent, remoteStream, dataChannelReady } = useWebRTC({
    onDataChannelMessage,
  });

  // Load existing documents on mount
  useEffect(() => {
    fetch("/api/documents")
      .then((r) => r.json())
      .then((d) => setDocuments(d || []))
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
              turn_detection: null,
              transcription: { model: "gpt-4o-mini-transcribe", language: "th" },
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
    resetTranscript();
    sessionConfigRef.current = null;

    try {
      sessionConfigRef.current = await connect({ meetingTitle: meetingTitle || undefined });
      setState("listening");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  }

  function handleStop() {
    disconnect();
    setState("idle");
  }

  function handleComment() {
    if (state !== "listening" || isAiResponding) return;
    // Commit any pending audio so the AI knows about the latest discussion
    sendEvent({ type: "input_audio_buffer.commit" });
    // Inject a system-like instruction asking for comment
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: buildCommentPrompt() }],
      },
    });
    sendEvent({
      type: "response.create",
      response: { output_modalities: ["audio"] },
    });
  }

  function handleAskQuestion() {
    if (!questionInput.trim() || state !== "listening" || isAiResponding) return;
    const q = questionInput.trim();
    sendEvent({ type: "input_audio_buffer.commit" });
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: buildQuestionPrompt(q) }],
      },
    });
    sendEvent({
      type: "response.create",
      response: { output_modalities: ["audio"] },
    });
    setQuestionInput("");
    setShowQuestionBox(false);
  }

  const isListening = state === "listening";

  return (
    <main className="min-h-screen p-6 max-w-6xl mx-auto">
      <audio ref={audioRef} autoPlay />

      {/* Header */}
      <header className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-500">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">AI ผู้ช่วยประชุม</h1>
            <p className="text-xs text-slate-400">ฟังประชุม อ่านเอกสาร และตอบคำถามได้</p>
          </div>
        </div>
      </header>

      {/* Main grid */}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Left: setup */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <label className="text-xs font-medium text-slate-300 block mb-2">
              หัวข้อการประชุม (ไม่บังคับ)
            </label>
            <input
              type="text"
              value={meetingTitle}
              onChange={(e) => setMeetingTitle(e.target.value)}
              disabled={isListening || state === "connecting"}
              placeholder="เช่น ประชุมวางแผนกลยุทธ์ Q1"
              className="w-full px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700 text-sm focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
            />
          </div>

          <DocumentUpload
            documents={documents}
            onChange={setDocuments}
            disabled={isListening || state === "connecting"}
          />

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
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-400"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              กำลังเชื่อมต่อ...
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStop}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-rose-500/15 border border-rose-500/40 px-4 py-3 text-sm font-semibold text-rose-300 hover:bg-rose-500/20"
            >
              <MicOff className="h-4 w-4" />
              จบประชุม
            </button>
          )}

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
              {error}
            </div>
          )}
        </aside>

        {/* Right: transcript + actions */}
        <section className="space-y-4">
          {/* Status bar */}
          {isListening && (
            <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-2 text-xs">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </span>
              <span className="text-emerald-300 font-medium">AI กำลังฟังการประชุม</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{turns.length} เทิร์น</span>
            </div>
          )}

          <TranscriptFeed
            turns={turns}
            isAiResponding={isAiResponding}
            liveUserText={liveUserText}
            liveAiText={liveAiText}
          />

          {/* Action buttons */}
          {isListening && (
            <div className="space-y-2">
              {showQuestionBox ? (
                <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-purple-300 flex items-center gap-1.5">
                      <HelpCircle className="h-3.5 w-3.5" />
                      ถามคำถาม AI
                    </label>
                    <button
                      type="button"
                      onClick={() => { setShowQuestionBox(false); setQuestionInput(""); }}
                      className="text-slate-500 hover:text-slate-300"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <textarea
                    value={questionInput}
                    onChange={(e) => setQuestionInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleAskQuestion();
                      }
                    }}
                    rows={2}
                    placeholder="พิมพ์คำถามที่อยากให้ AI ตอบ..."
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-sm resize-none focus:outline-none focus:border-purple-500/50"
                  />
                  <button
                    type="button"
                    onClick={handleAskQuestion}
                    disabled={!questionInput.trim() || isAiResponding}
                    className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-sm font-semibold text-white"
                  >
                    <Send className="h-3.5 w-3.5" />
                    ส่งคำถาม
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleComment}
                    disabled={isAiResponding}
                    className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/40 hover:from-purple-500/30 hover:to-pink-500/30 px-4 py-3 text-sm font-semibold text-purple-200 disabled:opacity-50"
                  >
                    <MessageSquare className="h-4 w-4" />
                    เสนอความคิดเห็น
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowQuestionBox(true)}
                    disabled={isAiResponding}
                    className="flex items-center justify-center gap-2 rounded-xl bg-slate-800/60 border border-slate-700 hover:bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-200 disabled:opacity-50"
                  >
                    <HelpCircle className="h-4 w-4" />
                    ถามคำถาม AI
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
