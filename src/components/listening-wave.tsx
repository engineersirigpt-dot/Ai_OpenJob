"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";

/**
 * What the room sees while พรชัย listens.
 *
 * The transcript on screen is written by the live slices, which arrive every
 * few seconds; this shows that the microphone itself is working in between —
 * bars driven straight off the mic's frequency data, and a note while a slice
 * is being transcribed. The accurate transcript is made from the recording
 * when the meeting ends and replaces what is on screen.
 */

const BARS = 28;

export function ListeningWave({
  stream,
  enabled = true,
  aiName = "พรชัย",
  busy = false,
  micLabel = "",
  onSwitchMic,
}: {
  stream: MediaStream | null;
  enabled?: boolean;
  aiName?: string;
  /** A slice of speech is being transcribed right now. */
  busy?: boolean;
  /**
   * Called with a device id when the room picks another microphone from
   * the list. Without it the list is not shown.
   */
  onSwitchMic?: (deviceId: string) => Promise<void> | void;
  /** Which microphone is in use, so a silent fallback to another is visible. */
  micLabel?: string;
}) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const rafRef = useRef<number | null>(null);
  /**
   * The microphones the browser can see. Labels only exist once a mic has
   * been granted, which is why the list is read when the stream arrives
   * and again whenever a device is plugged or unplugged.
   */
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>([]);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!onSwitchMic || !stream) return;
    let alive = true;
    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!alive) return;
        setDevices(
          all
            .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")
            .map((d) => ({ id: d.deviceId, label: d.label || "ไมโครโฟน" })),
        );
      } catch {
        // no device access: the list simply stays empty
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [stream, onSwitchMic]);

  useEffect(() => {
    if (!stream || !enabled) {
      barsRef.current.forEach((b) => {
        if (b) b.style.transform = "scaleY(0.05)";
      });
      return;
    }

    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.75;
    // The analyser's default window is -100 to -30 dB, so anything louder
    // than -30 dB in a bin pins that bin at 255. The stream arriving here is
    // the amplified one (+12 dB), and a laptop mic with its own boost sits
    // above -30 dB in every bin all the time: the bars went full and stayed
    // there. The whole range up to 0 dB is used instead.
    analyser.minDecibels = -90;
    analyser.maxDecibels = 0;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    // Air-conditioning and fans sit in the lowest bins and never stop, so the
    // first bins are skipped. The noise floor is not a constant: it is
    // whatever the room measures when nobody is talking, learned as the
    // lowest level seen recently, so the bars read the same on a quiet
    // conference mic and on a hot laptop mic. It falls at once and rises
    // slowly, so a pause pulls it down and a long speech does not pull it up.
    const FIRST_BIN = 2;
    const SILENT = 0.05;
    const MARGIN = 0.04; // how far above the floor counts as speech
    let floor = 1;

    const draw = () => {
      analyser.getByteFrequencyData(data);
      const usable = Math.floor(data.length * 0.62) - FIRST_BIN;
      const step = Math.max(1, Math.floor(usable / BARS));

      // is anyone actually speaking?
      let total = 0;
      for (let i = FIRST_BIN; i < FIRST_BIN + usable; i++) total += data[i] || 0;
      const average = total / usable / 255;
      floor = average < floor ? average : Math.min(average, floor + 0.0008);
      const speaking = average > floor + MARGIN;

      for (let i = 0; i < BARS; i++) {
        const bar = barsRef.current[i];
        if (!bar) continue;
        if (!speaking) {
          bar.style.transform = `scaleY(${SILENT})`;
          continue;
        }
        let sum = 0;
        for (let k = 0; k < step; k++) sum += data[FIRST_BIN + i * step + k] || 0;
        const level = sum / step / 255;
        const above = Math.max(0, level - floor - MARGIN); // ignore the room's hum
        const scale = Math.max(SILENT, Math.min(1, above * 2.8));
        bar.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      source.disconnect();
      ctx.close().catch(() => {});
    };
  }, [stream, enabled]);

  return (
    <div className="shrink-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2.5">
      <div className="flex h-10 items-end justify-center gap-[2px]">
        {Array.from({ length: BARS }).map((_, i) => (
          <span
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
            className={`h-full w-[4px] origin-bottom rounded-full transition-none ${
              enabled
                ? "bg-gradient-to-t from-purple-600 to-pink-400"
                : "bg-slate-300 dark:bg-slate-700"
            }`}
            style={{ transform: "scaleY(0.05)" }}
          />
        ))}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 text-center">
        <span
          className={`flex items-center gap-1.5 text-[12px] font-medium ${
            enabled ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"
          }`}
        >
          {enabled ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
          {enabled ? `${aiName}กำลังฟังและบันทึกการประชุม` : "หยุดฟังอยู่"}
        </span>
        {enabled && micLabel && (
          <span
            className="w-full truncate text-center text-[10px] text-slate-400 dark:text-slate-500"
            title={micLabel}
          >
            ไมค์: {micLabel}
          </span>
        )}
        {onSwitchMic && devices.length > 1 && (
          <label className="mt-1 flex w-full items-center justify-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
            <span>เปลี่ยนไมค์:</span>
            <select
              className="max-w-[260px] truncate rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              disabled={switching}
              value={devices.find((d) => d.label === micLabel)?.id || ""}
              onChange={async (e) => {
                const id = e.target.value;
                if (!id) return;
                setSwitching(true);
                try {
                  await onSwitchMic(id);
                } finally {
                  setSwitching(false);
                }
              }}
            >
              <option value="">— เลือก —</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            {switching && <Loader2 className="h-3 w-3 animate-spin" />}
          </label>
        )}
        {enabled && busy && (
          <span className="flex items-center gap-1.5 text-[10.5px] text-slate-500 dark:text-slate-400">
            <Loader2 className="h-3 w-3 animate-spin text-purple-600 dark:text-purple-400" />
            กำลังถอดเสียง…
          </span>
        )}
      </div>
    </div>
  );
}
