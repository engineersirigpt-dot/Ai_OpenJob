"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Records the room in fixed stretches and hands each finished stretch to the
 * caller for transcription.
 *
 * The live VAD path cuts audio every time someone pauses — three or four
 * seconds with no context, which is why that text is rough. Here the audio is
 * cut on a clock instead (30 seconds by default), so each piece carries whole
 * sentences and is transcribed as a file. A stretch is also closed when พรชัย
 * starts talking, so his own voice never lands in the recording.
 *
 * Nothing is written to disk: a stretch exists only until it has been sent.
 *
 * Two rules keep the recording alive for a whole meeting, both learned the
 * hard way:
 *
 *  1. Every stretch owns its own array of audio parts, captured in the
 *     recorder's own closure. A shared `chunksRef` loses a stretch at the cut:
 *     `MediaRecorder` delivers its audio after `stop()` returns, so by the
 *     time the data arrives the shared array has already been swapped for the
 *     next stretch's, and the finished stretch hands over nothing.
 *  2. Nothing here may throw. `new MediaRecorder()` and `start()` both fail if
 *     the previous recorder still holds the stream, and an exception thrown
 *     from the cut timer used to end the recording for the rest of the meeting
 *     with no sign on screen. Both are guarded, and a failure retries.
 */

/**
 * How much detail the recording keeps.
 *
 * This was 32 kbps, chosen to keep uploads small — but the live path sends
 * UNCOMPRESSED 16 kHz WAV, so the two passes were not hearing the same audio
 * at all, and the recording was losing exactly the detail Thai needs: the
 * aspirated/unaspirated consonant pairs (ถ/ท, ผ/พ, ข/ค) differ by a short
 * burst of high-frequency energy, which is the first thing a low bitrate
 * throws away. "ถอดเสียง" came back as "ทอดเสียง" three times in one test.
 *
 * At 64 kbps mono, opus is effectively transparent for speech. Ten minutes is
 * about 4.8 MB — still far inside the transcription API's 25 MB limit.
 */
const BITS_PER_SECOND = 64000;
const DEFAULT_CHUNK_MS = 30_000;
// Below this a blob is too short to hold speech (~1s of opus).
const MIN_BLOB_BYTES = 4000;

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

interface StartOptions {
  /** Called with every finished stretch, in order. */
  onChunk?: (blob: Blob, index: number) => void;
  /** Called the moment a stretch is cut, whether or not it had audio. */
  onCut?: () => void;
  /** Length of a stretch in milliseconds (default 30s). */
  chunkMs?: number;
  /**
   * The meeting is already running and only the microphone changed — a
   * reconnect hands over a brand-new MediaStream. What was being recorded on
   * the old one still belongs to this meeting, so it is handed over instead
   * of thrown away, and the recording keeps its run.
   */
  sameMeeting?: boolean;
}

/** One stretch being recorded, with the audio parts that belong to it. */
interface Segment {
  rec: MediaRecorder;
  parts: Blob[];
  startedAt: number;
}

export function useRecorder() {
  const segRef = useRef<Segment | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onChunkRef = useRef<StartOptions["onChunk"]>(undefined);
  const onCutRef = useRef<StartOptions["onCut"]>(undefined);
  const chunkMsRef = useRef(DEFAULT_CHUNK_MS);
  const indexRef = useRef(0);
  const pausedRef = useRef(false);
  /**
   * Which meeting this recording belongs to.
   *
   * MediaRecorder hands its audio over after `stop()` returns, so a piece can
   * arrive once the next meeting has already started. Every piece carries the
   * run it was recorded in, and one from an earlier run is dropped — audio
   * from a previous meeting must never reach this one's record.
   */
  const runRef = useRef(0);
  const [recording, setRecording] = useState(false);

  /** Close the stretch being recorded and hand its audio over. */
  const cut = useCallback((deliver: boolean): Promise<void> => {
    const seg = segRef.current;
    segRef.current = null;
    if (!seg) return Promise.resolve();
    const run = runRef.current;

    return new Promise((resolve) => {
      let settled = false;
      let guard: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        const size = seg.parts.reduce((t, p) => t + p.size, 0);
        const seconds = ((Date.now() - seg.startedAt) / 1000).toFixed(1);
        if (run !== runRef.current) {
          console.warn(
            `[recorder] ทิ้งเสียง ${(size / 1024).toFixed(0)}KB จากการประชุมก่อนหน้า ` +
              `(รอบ ${run}, ปัจจุบันรอบ ${runRef.current})`,
          );
          resolve();
          return;
        }
        if (deliver && size > MIN_BLOB_BYTES) {
          const blob = new Blob(seg.parts, { type: seg.rec.mimeType || "audio/webm" });
          console.log(`[recorder] cut after ${seconds}s → ${(size / 1024).toFixed(0)}KB`);
          onChunkRef.current?.(blob, indexRef.current++);
        } else {
          console.log(
            `[recorder] cut after ${seconds}s → ${(size / 1024).toFixed(0)}KB ` +
              `(${deliver ? "too short to send" : "discarded"})`,
          );
        }
        resolve();
      };

      seg.rec.onstop = finish;
      seg.rec.onerror = (e) => {
        console.error("[recorder] error while closing", e);
        finish();
      };
      // If the microphone track was already killed, "stop" may never report
      // back — never let that stall the end of a meeting.
      guard = setTimeout(finish, 3000);
      try {
        seg.rec.stop();
      } catch (err) {
        console.error("[recorder] stop failed", err);
        finish();
      }
    });
  }, []);

  /** Open the next stretch. Safe to call at any time; never throws. */
  const begin = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || segRef.current || pausedRef.current) return;

    const mimeType = pickMimeType();
    try {
      const rec = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: BITS_PER_SECOND } : undefined,
      );
      // The parts belong to THIS recorder, so audio delivered after the cut
      // still lands in the stretch it came from.
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      };
      rec.start();
      segRef.current = { rec, parts, startedAt: Date.now() };
    } catch (err) {
      // The watchdog below will try again on its next pass.
      console.error("[recorder] cannot open a stretch:", err);
    }
  }, []);

  /**
   * One watchdog drives everything: it cuts a stretch that has run its length
   * and opens one whenever none is running. A single lost timer can no longer
   * end the recording, because the next pass picks it up a second later.
   */
  const startLoop = useCallback(() => {
    if (loopRef.current) clearInterval(loopRef.current);
    loopRef.current = setInterval(() => {
      if (!streamRef.current || pausedRef.current) return;
      const seg = segRef.current;
      if (!seg) {
        begin();
        return;
      }
      if (Date.now() - seg.startedAt >= chunkMsRef.current) {
        // Close first, then open: two recorders on one stream make the
        // constructor throw. `stop()` runs inside `cut`, so the gap is
        // milliseconds — not a lost sentence.
        onCutRef.current?.();
        void cut(true);
        begin();
      }
    }, 500);
  }, [begin, cut]);

  const start = useCallback(
    (stream: MediaStream, opts: StartOptions = {}) => {
      streamRef.current = stream;
      onChunkRef.current = opts.onChunk;
      onCutRef.current = opts.onCut;
      chunkMsRef.current = opts.chunkMs ?? DEFAULT_CHUNK_MS;
      if (!opts.sameMeeting) indexRef.current = 0;

      // A stretch may still be open: either this meeting's, when the
      // microphone was just swapped by a reconnect, or a previous meeting's,
      // when that one ended without `stop()`. The first is handed over — it
      // is this meeting's audio — and the second is thrown away, which is
      // what stopped a new meeting inheriting the last one's recording.
      if (segRef.current) {
        const age = ((Date.now() - segRef.current.startedAt) / 1000).toFixed(0);
        pausedRef.current = true;
        if (opts.sameMeeting) {
          console.log(`[recorder] ต่อไมค์ใหม่ — เก็บช่วงที่อัดค้างไว้ (อายุ ${age}s)`);
          void cut(true);
        } else {
          console.warn(`[recorder] ทิ้งช่วงบันทึกค้างจากการประชุมก่อน (อายุ ${age}s)`);
          void cut(false);
        }
      }
      // The run stamp marks which meeting a piece of audio belongs to, so it
      // only moves on when a new meeting starts.
      if (!opts.sameMeeting) runRef.current += 1;
      pausedRef.current = false;
      begin();
      startLoop();
      setRecording(true);
    },
    [begin, startLoop, cut],
  );

  /** พรชัย is speaking: close this stretch, record nothing meanwhile. */
  const pause = useCallback(async () => {
    pausedRef.current = true;
    await cut(true);
  }, [cut]);

  /** พรชัย has finished: open the next stretch. */
  const resume = useCallback(() => {
    pausedRef.current = false;
    if (!streamRef.current) return;
    begin();
  }, [begin]);

  /** End of meeting: flush whatever is still being recorded. */
  const stop = useCallback(async (): Promise<void> => {
    if (loopRef.current) clearInterval(loopRef.current);
    loopRef.current = null;
    pausedRef.current = true;
    await cut(true);
    setRecording(false);
    streamRef.current = null;
  }, [cut]);

  return { start, pause, resume, stop, recording };
}
