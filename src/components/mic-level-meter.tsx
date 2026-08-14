"use client";

import { useEffect, useRef, useState } from "react";

const BARS = 5;
const SPEECH_LEVEL = 0.12; // above this = real speech (not silence/noise floor)

/**
 * Live microphone level meter. Reads the local mic stream and shows how loud
 * the room is — so the user can tell if the mic is actually picking up sound.
 * Self-contained so its frequent updates don't re-render the whole page.
 */
export function MicLevelMeter({
  stream,
  enabled = true,
  onSpeech,
}: {
  stream: MediaStream | null;
  enabled?: boolean;
  /** Fired (often) while real speech is detected — used to gate auto-transcribe. */
  onSpeech?: () => void;
}) {
  const [level, setLevel] = useState(0); // 0..1
  const rafRef = useRef<number | null>(null);
  const onSpeechRef = useRef(onSpeech);
  useEffect(() => {
    onSpeechRef.current = onSpeech;
  });

  useEffect(() => {
    if (!stream || !enabled || stream.getAudioTracks().length === 0) {
      setLevel(0);
      return;
    }
    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    ctx.resume?.().catch(() => {});

    const buf = new Uint8Array(analyser.fftSize);
    let last = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      // Noise gate + perceptual (sqrt) scaling so normal speech fills the meter
      const gated = rms < 0.012 ? 0 : rms;
      const next = Math.min(1, Math.sqrt(gated) * 2.4);
      if (next > SPEECH_LEVEL) onSpeechRef.current?.();
      // smooth + throttle state updates (~every 60ms)
      const now = performance.now();
      if (now - last > 60) {
        last = now;
        setLevel((prev) => prev * 0.4 + next * 0.6);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      ctx.close().catch(() => {});
      setLevel(0);
    };
  }, [stream, enabled]);

  const lit = Math.round(level * BARS);

  return (
    <span className="flex items-center gap-[3px]" title="ระดับเสียงไมโครโฟน">
      {Array.from({ length: BARS }).map((_, i) => {
        const on = enabled && i < lit;
        const color =
          i >= 4 ? "bg-rose-400" : i >= 3 ? "bg-amber-400" : "bg-emerald-400";
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm transition-all ${on ? color : "bg-slate-300 dark:bg-slate-600/50"}`}
            style={{ height: `${6 + i * 3}px` }}
          />
        );
      })}
    </span>
  );
}
