"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

interface AiAvatarProps {
  /** True while the AI is generating a response (may end before audio does). */
  speaking: boolean;
  /** The AI's audio stream — the real source of truth for motion. */
  stream?: MediaStream | null;
}

// Drop these into /public. IMG_OPEN is optional (mouth-open frame for lip-sync).
const IMG_CLOSED = "/ai-face-closed.png";
const IMG_OPEN = "/ai-face-open.png";

const ACTIVE_LEVEL = 0.05; // amplitude above this = audio is actually playing
const SILENCE_FRAMES = 45; // ~0.7s of quiet before we consider it stopped

/**
 * Realistic AI avatar driven by the AI's REAL audio amplitude. The analyser
 * runs off the audio stream itself (not the response state), so the mouth keeps
 * moving until the audio truly finishes — even after the response is "done".
 */
export function AiAvatar({ speaking, stream }: AiAvatarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLImageElement>(null);
  const rafRef = useRef<number | null>(null);
  const [hasImg, setHasImg] = useState(true);
  const [audioActive, setAudioActive] = useState(false);

  useEffect(() => {
    const reset = () => {
      if (wrapRef.current) wrapRef.current.style.transform = "";
      if (openRef.current) openRef.current.style.opacity = "0";
    };
    if (!stream || stream.getAudioTracks().length === 0) {
      reset();
      setAudioActive(false);
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser); // read-only tap; audio still plays via <audio>
    ctx.resume?.().catch(() => {});

    const buf = new Uint8Array(analyser.fftSize);
    let smooth = 0;
    let below = 0;
    let active = false;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const amp = Math.min(1, rms * 10);
      smooth += (amp - smooth) * 0.4;

      if (wrapRef.current) {
        wrapRef.current.style.transform = `scale(${(1 + smooth * 0.09).toFixed(3)}) translateY(${(-smooth * 3).toFixed(2)}px)`;
      }
      if (openRef.current) openRef.current.style.opacity = smooth.toFixed(2);

      // Track whether audio is actually playing (for the rings/label/border).
      if (smooth > ACTIVE_LEVEL) {
        below = 0;
        if (!active) {
          active = true;
          setAudioActive(true);
        }
      } else {
        below += 1;
        if (below > SILENCE_FRAMES && active) {
          active = false;
          setAudioActive(false);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      ctx.close().catch(() => {});
      reset();
      setAudioActive(false);
    };
  }, [stream]);

  // "Talking" = response in progress OR audio still coming out of the speaker.
  const talking = speaking || audioActive;

  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border-2 py-6 transition-all duration-300 ${
        talking
          ? "border-purple-500 bg-purple-50 dark:bg-slate-900 shadow-lg shadow-purple-500/30"
          : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
      }`}
    >
      <div className="relative flex h-40 w-40 max-w-full items-center justify-center">
        {/* pulsing rings while there is audio */}
        {talking && (
          <>
            <span className="absolute inline-flex h-full w-full rounded-2xl bg-purple-400/30 animate-ping" />
            <span
              className="absolute inline-flex h-36 w-36 rounded-2xl bg-pink-400/30 animate-ping"
              style={{ animationDelay: "0.4s" }}
            />
          </>
        )}

        {/* audio-reactive wrapper (scale + bob driven by voice) */}
        <div
          ref={wrapRef}
          className="relative aspect-square h-40 w-40 overflow-hidden rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500"
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
              />
            </>
          )}
        </div>
      </div>

      <span
        className={`text-xs font-medium ${
          talking ? "text-purple-600 dark:text-purple-300" : "text-slate-500 dark:text-slate-400"
        }`}
      >
        {talking ? "AI กำลังพูด…" : "AI พร้อมช่วยประชุม"}
      </span>
    </div>
  );
}
