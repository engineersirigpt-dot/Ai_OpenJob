"use client";

import { useCallback, useRef } from "react";
import { SPEECH_START_RMS, SPEECH_KEEP_RMS, MIC_GAIN, dbfs } from "@/lib/mic-gain";
import { LiveTranscribeClient } from "@/lib/live-transcribe-client";

/**
 * Two lanes feed the live transcript.
 *
 * "ws" streams the room to gpt-live-transcribe over a Realtime socket and
 * the words appear while they are being said; the gate below only decides
 * when to close a segment (a pause, or ten seconds). "rest" is the older
 * path — cut a slice at the pause, POST it, wait — and is what the hook
 * falls back to when the socket cannot be opened or drops: the room never
 * loses its transcript to a network problem, it just gets it a little
 * later. Questions to พรชัย always use "rest": they are short, and the
 * answer needs the whole question at once.
 */
type Lane = "ws" | "rest";
/**
 * Keep streaming this long after the last frame above the gate, so the tail
 * of a sentence is not cut. Short on purpose: the first streamed meeting
 * came back as "ครับ ค่ะ ครับ ครับ โอเค ครับ ค่ะ ค่ะ ค่ะ" — a Thai speech model
 * handed near-silence answers with the commonest Thai words it knows, and
 * 1.5 s of room tone after every sentence was a lot of near-silence. 0.7 s
 * covers a trailing syllable and little else.
 */
const STREAM_HANGOVER_MS = 700;
/** How long to wait before trying the socket again after it dropped. */
const RECONNECT_MS = 3000;

/**
 * Captures the microphone as raw PCM and transcribes it via /api/transcribe
 * (our on-premises Typhoon ASR service).
 *
 * We read PCM directly instead of using MediaRecorder because:
 *   1. the ASR service wants WAV (it can't read the browser's webm/opus), and
 *   2. having the samples lets us cut segments on a natural PAUSE rather than
 *      on a fixed timer — the model then gets whole sentences, which is what
 *      makes Thai transcription accurate.
 *
 * Meeting mode: accumulate while someone speaks, flush ~0.7s after they stop.
 * Question mode: record one utterance until the caller asks for it.
 */

const TARGET_SR = 16000; // the ASR model is trained at 16 kHz
const FRAME = 4096;
// Hysteresis thresholds: far-field meeting speech (people sitting away from a
// conference mic) is much quieter than laptop-mic speech, so the old 0.02
// single threshold silently DROPPED quiet utterances. Speech "starts" above
// START and keeps counting while above KEEP — quiet syllable tails no longer
// flip the detector into silence mid-sentence.
/**
 * How loud a frame must be to count as speech.
 *
 * The right value depends entirely on the microphone and how far people sit
 * from it, which no amount of reading the code can settle — a conference mic
 * in the middle of the table and a laptop lid at one end of it are two
 * different worlds. Both are tunable without touching the code, and the gate
 * reports what it actually measured (see below) so the number can be chosen
 * from the room rather than guessed.
 */
// The thresholds live in mic-gain.ts, next to the gain they are scaled by.
// Measured against two real meetings: speech frames sat between 0.015 and
// 0.03 and the room's quiet floor at 0.0009, so a gate at 0.01 let only 8%
// of frames through while 0.004 passes 18-21% — the quiet half of the
// talking. Those are pre-gain numbers; the gate now listens after the gain
// stage, which is why the scaling is not optional.
/** How often the gate reports what it is hearing, in milliseconds. */
const LEVEL_REPORT_MS = 30_000;
const SILENCE_CUT_MS = 700; // pause this long after speech → end of sentence
const MAX_SEGMENT_MS = 10000; // a slice reaches the screen every 10s at the latest
const MIN_SPEECH_MS = 400; // ignore blips (a cough, a chair moving)
const PREROLL_MS = 300; // keep a little audio before speech starts

type Mode = "idle" | "meeting" | "question";

/** One transcribed utterance from /api/transcribe. */
export interface TranscribedSegment {
  /** Raw transcript — what goes on screen, never modified. */
  text: string;
  /** Dictionary-normalized + Thai-only — what the AI/job-matcher should use. */
  contextText: string;
  /** accept | uncertain | reject (≠ accept only in confidence enforce mode). */
  decision: "accept" | "uncertain" | "reject";
}

// Windowed-sinc low-pass kernel for decimation. The old naive averaging had a
// terrible frequency response → aliasing artifacts that confuse the ASR model.
const KERNEL_TAPS = 31; // odd
let _kernel: Float32Array | null = null;
let _kernelRatio = 0;

function lowpassKernel(ratio: number): Float32Array {
  if (_kernel && _kernelRatio === ratio) return _kernel;
  const half = (KERNEL_TAPS - 1) / 2;
  const cutoff = 0.45 / ratio; // normalized to the INPUT rate, just below target Nyquist
  const k = new Float32Array(KERNEL_TAPS);
  let sum = 0;
  for (let i = 0; i < KERNEL_TAPS; i++) {
    const n = i - half;
    const sinc = n === 0 ? 2 * Math.PI * cutoff : Math.sin(2 * Math.PI * cutoff * n) / n;
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (KERNEL_TAPS - 1));
    k[i] = sinc * hamming;
    sum += k[i];
  }
  for (let i = 0; i < KERNEL_TAPS; i++) k[i] /= sum; // unity gain at DC
  _kernel = k;
  _kernelRatio = ratio;
  return k;
}

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const kernel = lowpassKernel(ratio);
  const half = (KERNEL_TAPS - 1) / 2;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const center = Math.round(i * ratio);
    let acc = 0;
    for (let t = 0; t < KERNEL_TAPS; t++) {
      const idx = center + t - half;
      if (idx >= 0 && idx < input.length) acc += input[idx] * kernel[t];
    }
    out[i] = acc;
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

export function useTranscriber() {
  const ctxRef = useRef<AudioContext | null>(null);
  /**
   * The room's own noise, learned as the quietest frames heard recently.
   *
   * The configured thresholds assume a quiet room. On 29 Oct the laptop mic
   * sat at -28 dBFS of fan and hum, 8 dB above the start threshold, and
   * every one of 352 frames in every window "passed" — the gate was sending
   * the fan to be transcribed, and the model answered with nothing. So the
   * gate also keeps a floor and refuses anything that is not clearly above
   * it. The floor drops at once and rises slowly: a pause pulls it down,
   * a long stretch of talking does not pull it up to the voices.
   */
  const floorRef = useRef(0);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);

  const chunksRef = useRef<Float32Array[]>([]);
  const chunkSamplesRef = useRef(0);
  const speechMsRef = useRef(0);
  const silenceMsRef = useRef(0);
  // Running figures for the gate's level report.
  const levelPeakRef = useRef(0);
  const levelSumRef = useRef(0);
  const levelFramesRef = useRef(0);
  const levelAboveRef = useRef(0);
  const levelReportedRef = useRef(0);
  const speakingNowRef = useRef(false); // hysteresis state for the two thresholds
  const modeRef = useRef<Mode>("idle");
  const pausedRef = useRef(false);
  const sampleRateRef = useRef(48000);

  const onTextRef = useRef<((seg: TranscribedSegment) => void) | null>(null);
  const onBusyRef = useRef<((b: boolean) => void) | null>(null);
  const inflightRef = useRef(0);

  // The streaming lane (see Lane above).
  const laneRef = useRef<Lane>("rest");
  const liveRef = useRef<LiveTranscribeClient | null>(null);
  const onPartialRef = useRef<((text: string) => void) | null>(null);
  const lastSpeechAtRef = useRef(0);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live question preview: re-transcribe the growing utterance while speaking.
  const onQuestionPartialRef = useRef<((text: string) => void) | null>(null);
  const partialBusyRef = useRef(false);
  const lastPartialSamplesRef = useRef(0);

  const resetBuffer = useCallback(() => {
    chunksRef.current = [];
    chunkSamplesRef.current = 0;
    speechMsRef.current = 0;
    silenceMsRef.current = 0;
    speakingNowRef.current = false;
  }, []);

  /** Merge the buffer WITHOUT consuming it (for live previews). */
  const snapshotBuffer = useCallback((): Float32Array => {
    const merged = new Float32Array(chunkSamplesRef.current);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }, []);

  const takeBuffer = useCallback((): Float32Array => {
    const total = chunkSamplesRef.current;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    resetBuffer();
    return merged;
  }, [resetBuffer]);

  const send = useCallback(async (samples: Float32Array): Promise<TranscribedSegment | null> => {
    const pcm = downsample(samples, sampleRateRef.current, TARGET_SR);
    if (pcm.length < (TARGET_SR * MIN_SPEECH_MS) / 1000) return null;
    const wav = encodeWav(pcm, TARGET_SR);
    const fd = new FormData();
    fd.append("file", wav, "segment.wav");
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      if (!res.ok) return null;
      const data = await res.json();
      const text = (data?.text as string) || "";
      if (!text) return null;
      const decision =
        data?.decision === "uncertain" || data?.decision === "reject" ? data.decision : "accept";
      return { text, contextText: (data?.contextText as string) || text, decision };
    } catch {
      return null;
    }
  }, []);

  /** Flush the buffered sentence and push its text to the transcript. */
  const flushMeeting = useCallback(() => {
    if (speechMsRef.current < MIN_SPEECH_MS) {
      resetBuffer();
      return;
    }
    const samples = takeBuffer();
    inflightRef.current += 1;
    onBusyRef.current?.(true);
    send(samples)
      .then((seg) => {
        if (seg) onTextRef.current?.(seg);
      })
      .finally(() => {
        inflightRef.current -= 1;
        if (inflightRef.current <= 0) onBusyRef.current?.(false);
      });
  }, [resetBuffer, send, takeBuffer]);

  const handleAudio = useCallback(
    (input: Float32Array) => {
      if (pausedRef.current || modeRef.current === "idle") return;

      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const frameMs = (input.length / sampleRateRef.current) * 1000;

      chunksRef.current.push(new Float32Array(input));
      chunkSamplesRef.current += input.length;

      // What the gate is hearing, reported every half-minute. If the room is
      // talking and `above` stays at 0, the threshold is above the room and
      // speech is being dropped before it is ever sent anywhere.
      levelPeakRef.current = Math.max(levelPeakRef.current, rms);
      levelSumRef.current += rms;
      levelFramesRef.current += 1;
      if (rms > Math.max(SPEECH_START_RMS, floorRef.current * 3)) levelAboveRef.current += 1;
      const now = Date.now();
      if (now - levelReportedRef.current >= LEVEL_REPORT_MS) {
        levelReportedRef.current = now;
        const frames = levelFramesRef.current || 1;
        console.log(
          `[stt-gate] ระดับเสียง 30 วิ: สูงสุด ${levelPeakRef.current.toFixed(4)} ` +
            `(${dbfs(levelPeakRef.current)} dBFS) ` +
            `เฉลี่ย ${(levelSumRef.current / frames).toFixed(4)} ` +
            `(${dbfs(levelSumRef.current / frames)} dBFS) ` +
            `ผ่านเกณฑ์ ${levelAboveRef.current}/${frames} เฟรม ` +
            `(เกณฑ์ ${Math.max(SPEECH_START_RMS, floorRef.current * 3).toFixed(4)} ` +
            `พื้นห้อง ${floorRef.current.toFixed(4)} (${dbfs(floorRef.current)} dBFS) ขยาย x${MIC_GAIN}) ` +
            `ช่องทาง ${laneRef.current === "ws" ? "สตรีม" : "ส่งเป็นชิ้น"}`,
        );
        levelPeakRef.current = 0;
        levelSumRef.current = 0;
        levelFramesRef.current = 0;
        levelAboveRef.current = 0;
      }

      // Learn the floor: snap down, creep up (about 1 dB per second at 85 ms frames).
      const floor = floorRef.current;
      floorRef.current = floor === 0 || rms < floor ? rms : Math.min(rms, floor * 1.01);

      // Hysteresis: enter "speaking" above START, stay in it above KEEP —
      // and in a noisy room, above the floor by 3x (9.5 dB) to start and
      // 2x (6 dB) to keep, whichever is higher.
      const threshold = speakingNowRef.current
        ? Math.max(SPEECH_KEEP_RMS, floorRef.current * 2)
        : Math.max(SPEECH_START_RMS, floorRef.current * 3);
      if (rms > threshold) {
        speakingNowRef.current = true;
        speechMsRef.current += frameMs;
        silenceMsRef.current = 0;
      } else {
        silenceMsRef.current += frameMs;
        if (silenceMsRef.current >= SILENCE_CUT_MS) speakingNowRef.current = false;
      }

      // A question is recorded until the caller stops it — never auto-cut.
      if (modeRef.current === "question") {
        // Live preview: after ~1s of new audio, re-transcribe the whole
        // utterance so the caller can render the sentence as it grows.
        const newSamples = chunkSamplesRef.current - lastPartialSamplesRef.current;
        if (
          onQuestionPartialRef.current &&
          !partialBusyRef.current &&
          speechMsRef.current >= MIN_SPEECH_MS &&
          newSamples >= sampleRateRef.current
        ) {
          partialBusyRef.current = true;
          lastPartialSamplesRef.current = chunkSamplesRef.current;
          send(snapshotBuffer())
            .then((seg) => {
              if (seg && modeRef.current === "question") onQuestionPartialRef.current?.(seg.text);
            })
            .finally(() => {
              partialBusyRef.current = false;
            });
        }
        return;
      }

      // Streaming lane: the audio goes out as it comes in; nothing is
      // buffered here. The gate's counters still decide when a segment is
      // closed, the same way they decide when a slice is cut below.
      const live = liveRef.current;
      if (laneRef.current === "ws" && live?.ready) {
        chunksRef.current = [];
        chunkSamplesRef.current = 0;
        const now2 = Date.now();
        if (speakingNowRef.current) lastSpeechAtRef.current = now2;
        if (speakingNowRef.current || now2 - lastSpeechAtRef.current < STREAM_HANGOVER_MS) {
          live.send(input, sampleRateRef.current);
        }
        const sentenceDone = speechMsRef.current >= MIN_SPEECH_MS && silenceMsRef.current >= SILENCE_CUT_MS;
        const longEnough = speechMsRef.current >= MAX_SEGMENT_MS;
        if (sentenceDone || longEnough) {
          live.commit();
          onBusyRef.current?.(true);
          speechMsRef.current = 0;
          silenceMsRef.current = 0;
        }
        return;
      }

      const bufferedMs = (chunkSamplesRef.current / sampleRateRef.current) * 1000;

      if (speechMsRef.current >= MIN_SPEECH_MS && silenceMsRef.current >= SILENCE_CUT_MS) {
        flushMeeting(); // they finished a sentence
        return;
      }
      if (bufferedMs >= MAX_SEGMENT_MS) {
        if (speechMsRef.current >= MIN_SPEECH_MS) flushMeeting();
        else resetBuffer();
        return;
      }
      // Nobody has spoken yet → keep only a short pre-roll so the first word
      // isn't clipped, instead of accumulating silence forever.
      if (speechMsRef.current === 0) {
        const keep = Math.floor((sampleRateRef.current * PREROLL_MS) / 1000);
        while (chunkSamplesRef.current > keep && chunksRef.current.length > 1) {
          const dropped = chunksRef.current.shift();
          chunkSamplesRef.current -= dropped ? dropped.length : 0;
        }
      }
    },
    [flushMeeting, resetBuffer, send, snapshotBuffer],
  );

  /**
   * A finished streamed segment, cleaned the way the server cleans a slice
   * (/api/clean-transcript: prompt echo cut, loops and foreign text dropped,
   * print terms spelled by the dictionary). The dictionary lives on the
   * server, so the browser asks rather than imports. If that call fails the
   * raw text still reaches the screen — a sentence with "สปอตยูวี" spelled
   * by ear beats a sentence lost.
   */
  const deliverStreamed = useCallback(async (raw: string) => {
    const fallback = raw.replace(/\s+/g, " ").trim();
    if (!fallback) return;
    try {
      const res = await fetch("/api/clean-transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: fallback }),
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: string; contextText?: string; dropped?: string };
        if (!data.text) {
          if (data.dropped) console.log(`[live-stt] ทิ้งช่วง: ${data.dropped}`);
          return;
        }
        onTextRef.current?.({ text: data.text, contextText: data.contextText || data.text, decision: "accept" });
        return;
      }
    } catch {
      // local server unreachable for a moment: fall through
    }
    onTextRef.current?.({ text: fallback, contextText: fallback, decision: "accept" });
  }, []);

  /** Open the streaming lane; on any failure the hook keeps the slice lane. */
  const openLiveLane = useCallback(() => {
    if (liveRef.current || modeRef.current === "idle") return;
    const client = new LiveTranscribeClient({
      onPartial: (t) => onPartialRef.current?.(t),
      onSegment: (t) => {
        void deliverStreamed(t).finally(() => {
          if (!client.busy) onBusyRef.current?.(false);
        });
      },
      onClosed: (reason) => {
        console.warn(`[live-stt] สตรีมหลุด (${reason}) — กลับไปส่งเป็นชิ้นจนกว่าจะต่อใหม่ได้`);
        if (liveRef.current === client) liveRef.current = null;
        laneRef.current = "rest";
        onPartialRef.current?.("");
        if (modeRef.current !== "idle") {
          reconnectRef.current = setTimeout(() => openLiveLane(), RECONNECT_MS);
        }
      },
    });
    client
      .open()
      .then(({ model }) => {
        if (modeRef.current === "idle") {
          client.close();
          return;
        }
        liveRef.current = client;
        laneRef.current = "ws";
        resetBuffer();
        console.log(`[live-stt] ถอดสดแบบสตรีมด้วย ${model}`);
      })
      .catch((err) => {
        console.warn(`[live-stt] เปิดสตรีมไม่ได้ (${(err as Error).message}) — ใช้การส่งเป็นชิ้นแทน`);
        laneRef.current = "rest";
      });
  }, [deliverStreamed, resetBuffer]);

  const start = useCallback(
    (
      stream: MediaStream,
      onText: (seg: TranscribedSegment) => void,
      onBusy?: (b: boolean) => void,
      onPartial?: (text: string) => void,
    ) => {
      if (ctxRef.current) return;
      onPartialRef.current = onPartial ?? null;
      const AC: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;
      sampleRateRef.current = ctx.sampleRate;
      onTextRef.current = onText;
      onBusyRef.current = onBusy ?? null;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(FRAME, 1, 1);
      // Route through a silent gain node: ScriptProcessor only runs when it is
      // connected to the destination, but we must not play the mic back.
      const sink = ctx.createGain();
      sink.gain.value = 0;

      processor.onaudioprocess = (e) => handleAudio(e.inputBuffer.getChannelData(0));
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ctx.destination);

      sourceRef.current = source;
      processorRef.current = processor;
      sinkRef.current = sink;
      resetBuffer();
      modeRef.current = "meeting";
      ctx.resume?.().catch(() => {});
      openLiveLane();
    },
    [handleAudio, resetBuffer, openLiveLane],
  );

  const stop = useCallback(() => {
    modeRef.current = "idle";
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    reconnectRef.current = null;
    liveRef.current?.close();
    liveRef.current = null;
    laneRef.current = "rest";
    onPartialRef.current?.("");
    resetBuffer();
    if (processorRef.current) processorRef.current.onaudioprocess = null;
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    sinkRef.current?.disconnect();
    ctxRef.current?.close().catch(() => {});
    processorRef.current = null;
    sourceRef.current = null;
    sinkRef.current = null;
    ctxRef.current = null;
    onBusyRef.current?.(false);
  }, [resetBuffer]);

  /** Stop transcribing (e.g. while the AI is speaking through the speakers). */
  const setPaused = useCallback(
    (paused: boolean) => {
      pausedRef.current = paused;
      if (paused) {
        // finish the sentence in flight before the room goes quiet for พรชัย
        if (liveRef.current?.ready && speechMsRef.current >= MIN_SPEECH_MS) liveRef.current.commit();
        resetBuffer();
      }
    },
    [resetBuffer],
  );

  const startQuestion = useCallback(
    (onPartial?: (text: string) => void) => {
      resetBuffer();
      onQuestionPartialRef.current = onPartial ?? null;
      partialBusyRef.current = false;
      lastPartialSamplesRef.current = 0;
      modeRef.current = "question";
    },
    [resetBuffer],
  );

  const finishQuestion = useCallback(async (): Promise<string> => {
    const samples = takeBuffer();
    modeRef.current = "idle";
    onQuestionPartialRef.current = null;
    onBusyRef.current?.(true);
    try {
      const seg = await send(samples);
      // A question goes straight into the AI → use the normalized context text;
      // a rejected (low-confidence) question is treated as not heard.
      if (!seg || seg.decision === "reject") return "";
      return seg.contextText || seg.text;
    } finally {
      onBusyRef.current?.(false);
    }
  }, [send, takeBuffer]);

  const cancelQuestion = useCallback(() => {
    resetBuffer();
    modeRef.current = "idle";
    onQuestionPartialRef.current = null;
  }, [resetBuffer]);

  const resumeMeeting = useCallback(() => {
    resetBuffer();
    if (ctxRef.current) modeRef.current = "meeting";
  }, [resetBuffer]);

  return { start, stop, setPaused, startQuestion, finishQuestion, cancelQuestion, resumeMeeting };
}
