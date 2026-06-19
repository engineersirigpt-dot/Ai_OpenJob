"use client";

import { useEffect, useRef } from "react";
import type { TranscriptTurn } from "@/hooks/use-transcript";

interface TranscriptFeedProps {
  turns: TranscriptTurn[];
  isAiResponding: boolean;
  liveUserText?: string;
  liveAiText?: string;
}

export function TranscriptFeed({
  turns,
  isAiResponding,
  liveUserText = "",
  liveAiText = "",
}: TranscriptFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, liveUserText, liveAiText]);

  return (
    <div
      className="flex flex-col gap-3 h-[55vh] min-h-[400px] overflow-y-auto p-4 rounded-2xl bg-slate-900/60 border border-slate-800"
      role="log"
      aria-live="polite"
    >
      {turns.length === 0 && !isAiResponding && !liveUserText && !liveAiText && (
        <p className="text-center text-slate-500 py-12 text-sm">
          กดเริ่มประชุมเพื่อให้ AI เริ่มฟัง
        </p>
      )}

      {turns.map((turn, i) => (
        <div
          key={i}
          className={`rounded-xl p-3 text-sm max-w-[85%] ${
            turn.speaker === "assistant"
              ? "bg-purple-500/10 border border-purple-500/30 self-start"
              : "bg-slate-800/60 border border-slate-700 self-end"
          }`}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider opacity-70">
            {turn.speaker === "assistant" ? "AI" : "ที่ประชุม"}
          </span>
          <p className="mt-1 text-slate-100">{turn.text}</p>
        </div>
      ))}

      {liveAiText && (
        <div className="rounded-xl p-3 text-sm max-w-[85%] bg-purple-500/10 border border-purple-500/40 self-start">
          <span className="text-[10px] font-medium uppercase tracking-wider text-purple-300">
            AI · กำลังพูด
          </span>
          <p className="mt-1 text-slate-100">{liveAiText}</p>
        </div>
      )}

      {liveUserText && (
        <div className="rounded-xl p-3 text-sm max-w-[85%] bg-slate-800/40 border border-pink-500/40 self-end">
          <span className="text-[10px] font-medium uppercase tracking-wider text-pink-300">
            ที่ประชุม · กำลังพูด
          </span>
          <p className="mt-1 italic text-slate-200">{liveUserText}</p>
        </div>
      )}

      {isAiResponding && !liveAiText && (
        <div className="rounded-xl bg-purple-500/10 border border-purple-500/30 p-3 self-start animate-pulse">
          <span className="text-[10px] text-slate-400">AI กำลังคิด...</span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
