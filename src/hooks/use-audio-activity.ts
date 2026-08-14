"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Detect whether an audio MediaStream is actually producing sound right now.
 * Used to sync the AI avatar video to the real audio playback (so the video
 * starts and stops exactly with what the user hears, not with the model's
 * generation-done event).
 */
export function useAudioActivity(
  stream: MediaStream | null,
  opts?: { threshold?: number; hangoverMs?: number },
): boolean {
  const threshold = opts?.threshold ?? 0.012;
  const hangoverMs = opts?.hangoverMs ?? 400;
  const [active, setActive] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setActive(false);
      return;
    }

    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // not connected to destination — the <audio> element plays the sound
    ctx.resume?.().catch(() => {});

    const buf = new Uint8Array(analyser.fftSize);
    let lastActive = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > threshold) {
        lastActive = now;
        setActive(true);
      } else if (now - lastActive > hangoverMs) {
        setActive(false);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      analyser.disconnect();
      ctx.close().catch(() => {});
      setActive(false);
    };
  }, [stream, threshold, hangoverMs]);

  return active;
}
