"use client";

import { useCallback, useRef } from "react";

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
const SPEECH_START_RMS = 0.01;
const SPEECH_KEEP_RMS = 0.006;
const SILENCE_CUT_MS = 700; // pause this long after speech → end of sentence
const MAX_SEGMENT_MS = 12000; // don't let one segment grow forever
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
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);

  const chunksRef = useRef<Float32Array[]>([]);
  const chunkSamplesRef = useRef(0);
  const speechMsRef = useRef(0);
  const silenceMsRef = useRef(0);
  const speakingNowRef = useRef(false); // hysteresis state for the two thresholds
  const modeRef = useRef<Mode>("idle");
  const pausedRef = useRef(false);
  const sampleRateRef = useRef(48000);

  const onTextRef = useRef<((seg: TranscribedSegment) => void) | null>(null);
  const onBusyRef = useRef<((b: boolean) => void) | null>(null);
  const inflightRef = useRef(0);

  const resetBuffer = useCallback(() => {
    chunksRef.current = [];
    chunkSamplesRef.current = 0;
    speechMsRef.current = 0;
    silenceMsRef.current = 0;
    speakingNowRef.current = false;
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

      // Hysteresis: enter "speaking" above START, stay in it above KEEP.
      const threshold = speakingNowRef.current ? SPEECH_KEEP_RMS : SPEECH_START_RMS;
      if (rms > threshold) {
        speakingNowRef.current = true;
        speechMsRef.current += frameMs;
        silenceMsRef.current = 0;
      } else {
        silenceMsRef.current += frameMs;
        if (silenceMsRef.current >= SILENCE_CUT_MS) speakingNowRef.current = false;
      }

      // A question is recorded until the caller stops it — never auto-cut.
      if (modeRef.current === "question") return;

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
    [flushMeeting, resetBuffer],
  );

  const start = useCallback(
    (stream: MediaStream, onText: (seg: TranscribedSegment) => void, onBusy?: (b: boolean) => void) => {
      if (ctxRef.current) return;
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
    },
    [handleAudio, resetBuffer],
  );

  const stop = useCallback(() => {
    modeRef.current = "idle";
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
      if (paused) resetBuffer();
    },
    [resetBuffer],
  );

  const startQuestion = useCallback(() => {
    resetBuffer();
    modeRef.current = "question";
  }, [resetBuffer]);

  const finishQuestion = useCallback(async (): Promise<string> => {
    const samples = takeBuffer();
    modeRef.current = "idle";
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
  }, [resetBuffer]);

  const resumeMeeting = useCallback(() => {
    resetBuffer();
    if (ctxRef.current) modeRef.current = "meeting";
  }, [resetBuffer]);

  return { start, stop, setPaused, startQuestion, finishQuestion, cancelQuestion, resumeMeeting };
}
