"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, Ear, MicOff, Loader2 } from "lucide-react";

interface AiAvatarProps {
  /** True while the AI is generating a response (may end before audio does). */
  speaking: boolean;
  /** The AI's audio stream — the real source of truth for mouth motion. */
  stream?: MediaStream | null;
  /** True while the meeting is running (AI is sitting in the room listening). */
  listening?: boolean;
  /** False when the mic is muted — the AI can't hear anything right now. */
  micEnabled?: boolean;
  /** The room's mic stream — drives the "listening" reactions. */
  micStream?: MediaStream | null;
  /** True while a segment is being transcribed (AI is processing what it heard). */
  thinking?: boolean;
}

// Drop these into /public. Both frames must be the SAME crop/pose — only the
// mouth differs — otherwise the crossfade jitters.
const IMG_CLOSED = "/ai-face-closed.png";
const IMG_OPEN = "/ai-face-open.png";

const ACTIVE_LEVEL = 0.05; // AI amplitude above this = audio is actually playing
const SILENCE_FRAMES = 45; // ~0.7s of quiet before we consider it stopped
const ROOM_LEVEL = 0.06; // mic amplitude above this = someone in the room is talking
const ROOM_SILENCE_FRAMES = 30; // ~0.5s of quiet before "heard someone" clears

type Mode = "off" | "listening" | "muted" | "thinking" | "talking";

/**
 * The AI's face. Driven by REAL audio amplitude on both sides:
 *  - the AI's own audio moves the mouth (keeps moving until the audio truly
 *    ends, even after the response is "done")
 *  - the room's mic makes the face react while it is LISTENING, so the face is
 *    alive during the meeting instead of a dead still frame
 * Both analysers share one AudioContext (browsers cap how many a page may open).
 */
export function AiAvatar({
  speaking,
  stream,
  listening = false,
  micEnabled = true,
  micStream,
  thinking = false,
}: AiAvatarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLImageElement>(null);
  const haloRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const [hasImg, setHasImg] = useState(true);
  const [audioActive, setAudioActive] = useState(false);
  const [roomActive, setRoomActive] = useState(false);

  // Listening reactions are only wired while the meeting runs with a live mic.
  const listenSrc = listening && micEnabled ? micStream : null;

  useEffect(() => {
    const reset = () => {
      if (wrapRef.current) wrapRef.current.style.transform = "";
      if (openRef.current) openRef.current.style.opacity = "0";
      if (haloRef.current) haloRef.current.style.opacity = "0";
    };
    const hasAi = Boolean(stream && stream.getAudioTracks().length > 0);
    const hasMic = Boolean(listenSrc && listenSrc.getAudioTracks().length > 0);
    if (!hasAi && !hasMic) {
      reset();
      setAudioActive(false);
      setRoomActive(false);
      return;
    }

    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    ctx.resume?.().catch(() => {});
    const nodes: { source: MediaStreamAudioSourceNode; analyser: AnalyserNode }[] = [];

    // read-only taps; the audio still plays through the <audio> element
    const tap = (src: MediaStream) => {
      const source = ctx.createMediaStreamSource(src);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      nodes.push({ source, analyser });
      return analyser;
    };
    const aiAnalyser = hasAi ? tap(stream as MediaStream) : null;
    const micAnalyser = hasMic ? tap(listenSrc as MediaStream) : null;

    const buf = new Uint8Array(256);
    const amp = (analyser: AnalyserNode) => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 10);
    };

    let aiSmooth = 0;
    let micSmooth = 0;
    let aiBelow = 0;
    let micBelow = 0;
    let aiOn = false;
    let micOn = false;
    // Slow idle breathing so the face never looks frozen between turns.
    let phase = 0;

    const tick = () => {
      if (aiAnalyser) aiSmooth += (amp(aiAnalyser) - aiSmooth) * 0.4;
      if (micAnalyser) micSmooth += (amp(micAnalyser) - micSmooth) * 0.25;
      phase += 0.012;

      // Mouth follows the AI only — the room's voice must never open it.
      if (openRef.current) openRef.current.style.opacity = aiSmooth.toFixed(2);

      if (wrapRef.current) {
        let scale: number;
        let shift: number;
        if (aiSmooth > ACTIVE_LEVEL) {
          // talking — punchy bob on its own voice
          scale = 1 + aiSmooth * 0.09;
          shift = -aiSmooth * 3;
        } else {
          // listening / idle — breathe, and lean in a little toward the speaker
          const breathe = (Math.sin(phase) + 1) / 2; // 0..1
          scale = 1 + breathe * 0.012 + micSmooth * 0.03;
          shift = -breathe * 1.5 - micSmooth * 2;
        }
        wrapRef.current.style.transform = `scale(${scale.toFixed(3)}) translateY(${shift.toFixed(2)}px)`;
      }

      // Halo brightness tracks the room level — visible proof it hears you.
      if (haloRef.current) {
        haloRef.current.style.opacity = micAnalyser ? Math.min(0.9, micSmooth * 2.2).toFixed(2) : "0";
      }

      // AI audio actually playing (drives rings/label/border)
      if (aiSmooth > ACTIVE_LEVEL) {
        aiBelow = 0;
        if (!aiOn) {
          aiOn = true;
          setAudioActive(true);
        }
      } else {
        aiBelow += 1;
        if (aiBelow > SILENCE_FRAMES && aiOn) {
          aiOn = false;
          setAudioActive(false);
        }
      }

      // Someone in the room is talking
      if (micSmooth > ROOM_LEVEL) {
        micBelow = 0;
        if (!micOn) {
          micOn = true;
          setRoomActive(true);
        }
      } else {
        micBelow += 1;
        if (micBelow > ROOM_SILENCE_FRAMES && micOn) {
          micOn = false;
          setRoomActive(false);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      for (const n of nodes) {
        n.source.disconnect();
        n.analyser.disconnect();
      }
      ctx.close().catch(() => {});
      reset();
      setAudioActive(false);
      setRoomActive(false);
    };
  }, [stream, listenSrc]);

  // "Talking" = response in progress OR audio still coming out of the speaker.
  const talking = speaking || audioActive;
  const mode: Mode = talking
    ? "talking"
    : !listening
      ? "off"
      : !micEnabled
        ? "muted"
        : thinking
          ? "thinking"
          : "listening";

  const skin = {
    talking: {
      frame: "border-purple-500 bg-purple-50 dark:bg-slate-900 shadow-lg shadow-purple-500/30",
      label: "text-purple-600 dark:text-purple-300",
      text: "AI กำลังพูด…",
      icon: null,
    },
    listening: {
      frame: "border-emerald-500/60 bg-emerald-50/60 dark:bg-slate-900 shadow-lg shadow-emerald-500/20",
      label: "text-emerald-600 dark:text-emerald-300",
      text: roomActive ? "กำลังฟังอยู่ — ได้ยินเสียงพูด" : "นั่งฟังประชุมอยู่…",
      icon: <Ear className="h-3.5 w-3.5" />,
    },
    thinking: {
      frame: "border-sky-500/60 bg-sky-50/60 dark:bg-slate-900 shadow-lg shadow-sky-500/20",
      label: "text-sky-600 dark:text-sky-300",
      text: "กำลังถอดเสียงที่ได้ยิน…",
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    },
    muted: {
      frame: "border-amber-500/50 bg-amber-50/60 dark:bg-slate-900",
      label: "text-amber-600 dark:text-amber-300",
      text: "ปิดไมค์ — ตอนนี้ไม่ได้ยิน",
      icon: <MicOff className="h-3.5 w-3.5" />,
    },
    off: {
      frame: "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950",
      label: "text-slate-500 dark:text-slate-400",
      text: "AI พร้อมช่วยประชุม",
      icon: null,
    },
  }[mode];

  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border-2 py-6 transition-all duration-300 ${skin.frame}`}
    >
      <div className="relative flex h-40 w-40 max-w-full items-center justify-center">
        {/* pulsing rings while the AI itself is speaking */}
        {mode === "talking" && (
          <>
            <span className="absolute inline-flex h-full w-full rounded-2xl bg-purple-400/30 animate-ping" />
            <span
              className="absolute inline-flex h-36 w-36 rounded-2xl bg-pink-400/30 animate-ping"
              style={{ animationDelay: "0.4s" }}
            />
          </>
        )}

        {/* slow "I'm awake and listening" ring — calmer than the speaking ping */}
        {(mode === "listening" || mode === "thinking") && (
          <span
            className={`absolute inline-flex h-[105%] w-[105%] rounded-2xl animate-ping ${
              mode === "thinking" ? "bg-sky-400/20" : "bg-emerald-400/20"
            }`}
            style={{ animationDuration: "2.4s" }}
          />
        )}

        {/* audio-reactive wrapper (scale + bob driven by voice) */}
        <div
          ref={wrapRef}
          className={`relative aspect-square h-40 w-40 overflow-hidden rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 transition-[filter] duration-300 ${
            mode === "muted" ? "grayscale-[0.7] opacity-70" : mode === "off" ? "grayscale-[0.35]" : ""
          }`}
          style={{ willChange: "transform", transition: "transform 40ms linear" }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <Sparkles className="h-12 w-12 text-white/90" />
          </div>

          {hasImg && (
            <>
              <img
                src={IMG_CLOSED}
                alt="AI"
                className="absolute inset-0 h-full w-full object-cover"
                onError={() => setHasImg(false)}
              />
              <img
                ref={openRef}
                src={IMG_OPEN}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full object-cover opacity-0"
                style={{ transition: "opacity 50ms linear" }}
                onError={(e) => {
                  // no mouth-open frame → keep the closed face instead of a gap
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </>
          )}

          {/* room-level halo — brightens when someone in the meeting speaks */}
          <span
            ref={haloRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 ring-4 ring-inset ring-emerald-400/70"
            style={{ transition: "opacity 80ms linear" }}
          />
        </div>
      </div>

      <span className={`flex items-center gap-1.5 text-xs font-medium ${skin.label}`}>
        {skin.icon}
        {skin.text}
      </span>
    </div>
  );
}
