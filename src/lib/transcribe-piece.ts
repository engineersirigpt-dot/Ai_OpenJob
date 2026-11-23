import { STT_PROMPT } from "@/lib/stt-prompt";
import { normalizeDomainTerms } from "@/lib/domain-dictionary";
import {
  keepThaiOnly,
  isForeignHallucination,
  isHallucinatedLoop,
  collapseRepeats,
  stripPromptEcho,
  isPromptEcho,
  dropFillers,
} from "@/lib/thai-text";

/**
 * Transcribes ONE recorded piece of a meeting — a whole two-minute file, not
 * a live slice. This is the core the /api/transcribe-file route used to hold
 * inline; it lives here so the server can also run it on its own, after the
 * meeting is saved, on the pieces kept on disk. Hearing a whole piece at
 * once is what makes it accurate: sentence-level context, no cuts mid-word.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Plain transcription: the meeting record is one running block of what the
// room said, so speaker labels are not needed — and this model accepts a
// prompt (the diarizing one refuses it). Set TRANSCRIBE_FILE_MODEL to override.
// gpt-transcribe (July 2026) replaced gpt-4o-transcribe after a side by side
// on the room's own two-minute pieces: gpt-4o-transcribe's longest answer
// (1,493 characters) was one syllable repeated 320 times, and its next try
// on the same piece was a quarter of the length; gpt-transcribe returned 262
// real characters, identical on both tries, in a third of the time, and
// writes "..." where it cannot hear instead of inventing. Less text, all of
// it true. TRANSCRIBE_FILE_MODEL overrides.
const FILE_MODEL = process.env.TRANSCRIBE_FILE_MODEL || "gpt-transcribe";
const FALLBACK_MODEL = "gpt-4o-mini-transcribe";
// A short Thai sentence, not the vocabulary list — stt-prompt.ts has why.
const VOCAB_HINT = STT_PROMPT;
/**
 * How many times each piece is transcribed, keeping the fullest result.
 *
 * On a hard stretch this model is a coin toss: the same two minutes of a
 * real meeting came back as 14, 303, 424 and 458 characters on four tries,
 * with nothing changed between them. Temperature 0 does not help — it makes
 * the coin always land on the short side (29 characters, three times out
 * of three on the whole file). So each piece is asked for twice, in
 * parallel, and the pass that produced more speech is the one kept; a pass
 * that was an echo or a loop produces nothing and loses automatically.
 */
const SAMPLES = Math.min(
  4,
  Math.max(
    1,
    Number(process.env.TRANSCRIBE_FILE_SAMPLES) ||
      // gpt-transcribe returned the same text on every try, so a second
      // throw buys nothing; the coin-toss models still get two.
      (FILE_MODEL.startsWith("gpt-transcribe") ? 1 : 2),
  ),
);
const LANG = (process.env.TRANSCRIBE_LANG || "th").toLowerCase();
const THAI_ONLY = (process.env.STT_THAI_ONLY || "true") !== "false";
const DICTIONARY_ENABLED = (process.env.STT_DICTIONARY_ENABLED || "true") !== "false";

interface DiarizedSegment {
  text?: string;
  speaker?: string;
}

/** Cleaned text, plus the reason it was thrown away (for the log). */
interface Cleaned {
  text: string;
  dropped?: string;
}

function clean(raw: string): Cleaned {
  const asHeard = raw.normalize("NFC").trim();
  if (!asHeard) return { text: "", dropped: "โมเดลไม่ได้ยินคำพูด" };

  // The prompt read back at us is not speech — cut it out first.
  const echoFree = stripPromptEcho(asHeard, VOCAB_HINT).trim();
  if (!echoFree) return { text: "", dropped: "โมเดลตอบกลับมาเป็นคำใบ้ศัพท์ ไม่ใช่คำพูดในห้อง" };
  const text = dropFillers(echoFree);
  if (!text) return { text: "", dropped: "มีแต่คำรับ (ครับ/ค่ะ/อืม)" };
  if (isHallucinatedLoop(text)) return { text: "", dropped: "เป็นคำซ้ำวนลูป (หลอน)" };
  if (THAI_ONLY && isForeignHallucination(text)) {
    return { text: "", dropped: "เป็นภาษาอื่น" };
  }

  const normalized = DICTIONARY_ENABLED ? normalizeDomainTerms(text).text : text;
  const scrubbed = THAI_ONLY ? keepThaiOnly(normalized) : normalized;
  const out = collapseRepeats(scrubbed).trim();
  if (!out) return { text: "", dropped: "เหลือแต่ตัวอักษรที่ถูกกรองออก" };
  return { text: out };
}

async function transcribe(file: Blob, name: string, model: string, diarized: boolean, hint: string) {
  const form = new FormData();
  form.append("file", file, name);
  form.append("model", model);
  form.append("response_format", diarized ? "diarized_json" : "json");
  if (LANG && LANG !== "auto") form.append("language", LANG);
  // the diarizing model rejects a prompt; the others use it to stay in Thai
  if (!diarized && hint) form.append("prompt", hint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 280_000);
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[transcribe-piece]", model, res.status, body.slice(0, 300));
      return null;
    }
    return (await res.json()) as { text?: string; segments?: DiarizedSegment[] };
  } catch (err) {
    console.error("[transcribe-piece]", model, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What one transcription pass produced, after the filters. */
interface Harvest {
  merged: string;
  dropped: string[];
  heard: string;
}

function harvest(data: { text?: string; segments?: DiarizedSegment[] }, diarized: boolean): Harvest {
  const segmented = diarized && Array.isArray(data.segments) && data.segments.length > 0;
  const raws = segmented ? (data.segments || []).map((s) => s.text || "") : [data.text || ""];
  const pieces: string[] = [];
  const dropped: string[] = [];
  for (const raw of raws) {
    const res = clean(raw);
    if (res.text) pieces.push(res.text);
    else if (res.dropped) dropped.push(res.dropped);
  }
  return {
    merged: pieces.join(" ").replace(/\s{2,}/g, " ").trim(),
    dropped,
    heard: raws.join(" ").trim(),
  };
}

/** The fullest of SAMPLES parallel passes, or null if every one failed. */
async function bestOf(file: Blob, name: string, model: string, diarized: boolean, hint: string): Promise<Harvest | null> {
  const passes = await Promise.all(
    Array.from({ length: SAMPLES }, () => transcribe(file, name, model, diarized, hint)),
  );
  const harvests = passes
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .map((d) => harvest(d, diarized));
  if (harvests.length === 0) return null;
  return harvests.sort((a, b) => b.merged.length - a.merged.length)[0];
}

export interface PieceResult {
  /** The piece's speech, cleaned; "" when the model heard none. */
  text: string;
  /** What the model actually returned, before any filter (for the log). */
  heard: string;
  /** Why the text is empty, when it is. */
  dropped: string[];
  /** The piece had to be transcribed again with the prompt removed. */
  retriedWithoutHint: boolean;
}

/**
 * Transcribe one piece. Returns null only when every call to the model
 * failed outright (network, auth) — "heard nothing" is a result, not an error.
 */
export async function transcribePiece(file: Blob, name = "piece.webm"): Promise<PieceResult | null> {
  if (!OPENAI_API_KEY) return null;
  const t0 = Date.now();
  // Diarized first when configured; plain transcription is the fallback.
  const wantDiarized = FILE_MODEL.includes("diarize");
  let usedModel = FILE_MODEL;
  let diarized = wantDiarized;
  let got = await bestOf(file, name, FILE_MODEL, wantDiarized, VOCAB_HINT);
  if (!got) {
    usedModel = FALLBACK_MODEL;
    diarized = false;
    got = await bestOf(file, name, FALLBACK_MODEL, false, VOCAB_HINT);
  }
  if (!got) return null;

  /**
   * The prompt is a liability on audio the model finds hard: asked to
   * transcribe a stretch it cannot read, it answers with the prompt instead,
   * and the echo guard then leaves nothing. So an echoed pass is retried
   * with no prompt at all. A roughly spelled transcript beats none.
   */
  let retriedWithoutHint = false;
  if (!got.merged && VOCAB_HINT && isPromptEcho(got.heard, VOCAB_HINT)) {
    retriedWithoutHint = true;
    console.warn(`[transcribe-piece] คำใบ้สะท้อนกลับทั้งก้อน — ถอดซ้ำโดยไม่ใช้คำใบ้`);
    const plain = await bestOf(file, name, usedModel, diarized, "");
    if (plain) {
      got = plain.merged ? plain : { ...plain, dropped: [...got.dropped, ...plain.dropped] };
    }
  }

  console.log(
    `[transcribe-piece] ${name} ${(file.size / 1048576).toFixed(2)}MB model=${usedModel} ` +
      `samples=${SAMPLES} heard=${got.heard.length} chars=${got.merged.length} ${Date.now() - t0}ms` +
      (retriedWithoutHint ? " retry=ไม่ใช้คำใบ้" : "") +
      (got.dropped.length > 0 ? ` dropped=${got.dropped.join("|")}` : ""),
  );
  return { text: got.merged, heard: got.heard, dropped: got.dropped, retriedWithoutHint };
}
