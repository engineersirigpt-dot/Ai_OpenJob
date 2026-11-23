"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

interface AiAvatarProps {
  /** True while the AI is generating a response (may end before audio does). */
  speaking: boolean;
  /** The AI's audio stream — the real source of truth for motion. */
  stream?: MediaStream | null;
  /** Display name under the avatar (e.g. "พรชัย" in persona mode). */
  name?: string;
  /** Face images (mouth closed / open frames) — override per assistant mode. */
  imgClosed?: string;
  imgOpen?: string;
  /** "stage" = พรชัย is the hero of the meeting screen: large, no card chrome. */
  size?: "md" | "stage";
}

// Default frames in /public. The open frame is optional (used for lip-sync).
const IMG_CLOSED = "/pornchai-closed.png";
const IMG_OPEN = "/pornchai-open.png";

const ACTIVE_LEVEL = 0.05; // amplitude above this = audio is actually playing
const SILENCE_FRAMES = 45; // ~0.7s of quiet before we consider it stopped

/**
 * Realistic AI avatar driven by the AI's REAL audio amplitude. The analyser
 * runs off the audio stream itself (not the response state), so the mouth keeps
 * moving until the audio truly finishes — even after the response is "done".
 */
export function AiAvatar({
  speaking,
  stream,
  name = "AI",
  imgClosed = IMG_CLOSED,
  imgOpen = IMG_OPEN,
  size = "md",
}: AiAvatarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLImageElement>(null);
  const rafRef = useRef<number | null>(null);
  const [hasImg, setHasImg] = useState(true);
  const [audioActive, setAudioActive] = useState(false);

  // Switching mode switches images — give the new set a fresh chance to load.
  useEffect(() => {
    setHasImg(true);
  }, [imgClosed]);

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

      // Mouth crossfade ONLY — no scaling/bobbing/glow, per user preference.
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

  const stage = size === "stage";
  const box = stage ? "h-48 w-48 sm:h-56 sm:w-56" : "h-40 w-40";

  return (
    <div
      className={
        stage
          ? "relative flex flex-col items-center justify-center gap-4 py-2"
          : "relative flex flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border-2 border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 py-6"
      }
    >
      <div className={`relative flex max-w-full items-center justify-center ${box}`}>
        {/* Static frame — the ONLY animation is the mouth crossfade below. */}
        <div
          ref={wrapRef}
          className={`relative aspect-square overflow-hidden bg-gradient-to-br from-purple-500 to-pink-500 ${box} ${
            stage
              ? `rounded-full ${talking ? "stage-halo-live" : "stage-halo"}`
              : "rounded-2xl"
          }`}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <Sparkles className="h-12 w-12 text-white/90" />
          </div>

          {hasImg && (
            <>
              <img
                src={imgClosed}
                alt="AI"
                className="absolute inset-0 h-full w-full object-cover"
                onError={() => setHasImg(false)}
              />
              <img
                ref={openRef}
                src={imgOpen}
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
        className={`font-medium ${stage ? "text-sm" : "text-xs"} ${
          talking ? "text-pink-600 dark:text-pink-300" : "text-slate-500 dark:text-slate-400"
        }`}
      >
        {talking ? `${name} กำลังพูด…` : `${name} พร้อมช่วยประชุม`}
      </span>
    </div>
  );
}
