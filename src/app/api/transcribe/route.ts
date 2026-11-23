import { NextRequest, NextResponse } from "next/server";
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

export const runtime = "nodejs";
export const maxDuration = 30;

// Local on-premises Thai ASR (typhoon-asr-service). Meeting audio stays inside
// the company network. Set STT_PROVIDER=openai to bypass it.
const TYPHOON_URL = process.env.TYPHOON_ASR_URL || "http://127.0.0.1:8020/transcribe";
const PROVIDER = (process.env.STT_PROVIDER || "typhoon").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// gpt-transcribe (July 2026) replaced gpt-4o-transcribe here after a side by
// side on real slices from the meeting room: on 25 gate-cut slices it echoed
// the prompt 0 times (gpt-4o-transcribe: 7), produced no foreign text, no
// repetition loops, returned the same text on every run, and answered in a
// third of the time. It writes "..." where it cannot hear, instead of
// inventing. TRANSCRIBE_MODEL overrides.
const OPENAI_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-transcribe";
// "th" = lock to Thai (safe, transliterates English). "auto" = let the model
// detect — better for Thai/English code-switching, small risk of drifting.
const TRANSCRIBE_LANG = (process.env.TRANSCRIBE_LANG || "th").toLowerCase();
// The prompt is a short Thai sentence, not the vocabulary list it used to
// be — see stt-prompt.ts for the measurement that retired the list. The echo
// guard below still removes it when the model reads it back.
const VOCAB_HINT = STT_PROMPT;

// ---- STT quality layer (no LLM, VAD untouched) ------------------------------
// Dictionary: deterministic domain-term normalization (on by default).
const DICTIONARY_ENABLED = (process.env.STT_DICTIONARY_ENABLED || "true") !== "false";
// Thai-only scrub of contextText. Turn OFF (STT_THAI_ONLY=false) when this app
// serves meetings that aren't Thai-primary print meetings.
const THAI_ONLY = (process.env.STT_THAI_ONLY || "true") !== "false";
// Confidence: off | observe (log only, no behavior change) | enforce.
const CONFIDENCE_MODE = (process.env.STT_CONFIDENCE_MODE || "observe").toLowerCase();
// Enforce thresholds — tune AFTER studying observe-mode logs from real meetings.
const CONF_GEO_MIN = Number(process.env.STT_CONF_GEO_MIN || "0.45");
const CONF_LOWRATIO_MAX = Number(process.env.STT_CONF_LOWRATIO_MAX || "0.4");

type Decision = "accept" | "uncertain" | "reject";

interface SttResult {
  text: string;
  logprobs: unknown[] | null;
}

interface QualitySummary {
  tokenCount: number;
  meanLogprob: number | null;
  tokenGeoMean: number | null;
  lowTokenRatio: number | null;
}

function summarizeLogprobs(items: unknown[] | null, lowProbabilityBoundary = 0.1): QualitySummary {
  const valid = (items ?? []).filter(
    (item): item is { logprob: number } =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { logprob?: unknown }).logprob === "number" &&
      Number.isFinite((item as { logprob: number }).logprob),
  );
  if (valid.length === 0) {
    return { tokenCount: 0, meanLogprob: null, tokenGeoMean: null, lowTokenRatio: null };
  }
  const meanLogprob = valid.reduce((sum, item) => sum + item.logprob, 0) / valid.length;
  const lowTokenCount = valid.filter((item) => Math.exp(item.logprob) < lowProbabilityBoundary).length;
  return {
    tokenCount: valid.length,
    meanLogprob,
    tokenGeoMean: Math.exp(meanLogprob),
    lowTokenRatio: lowTokenCount / valid.length,
  };
}

/** Only meaningful in enforce mode. No logprobs data → fall back to accept. */
function decide(q: QualitySummary): Decision {
  if (q.tokenCount === 0 || q.tokenGeoMean === null || q.lowTokenRatio === null) return "accept";
  if (q.tokenGeoMean < CONF_GEO_MIN * 0.7 || q.lowTokenRatio > CONF_LOWRATIO_MAX * 1.5) return "reject";
  if (q.tokenGeoMean < CONF_GEO_MIN || q.lowTokenRatio > CONF_LOWRATIO_MAX) return "uncertain";
  return "accept";
}

async function viaTyphoon(file: File): Promise<SttResult | null> {
  const form = new FormData();
  form.append("file", file, file.name || "segment.wav");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(TYPHOON_URL, { method: "POST", body: form, signal: controller.signal });
    if (!res.ok) {
      console.error("[transcribe] typhoon status", res.status);
      return null;
    }
    const data = await res.json();
    return { text: (data?.text as string) || "", logprobs: null };
  } catch (err) {
    console.error("[transcribe] typhoon unreachable:", (err as Error).message);
    return null; // null = try the fallback
  } finally {
    clearTimeout(timer);
  }
}

async function viaOpenAI(file: File, hint = VOCAB_HINT): Promise<SttResult> {
  if (!OPENAI_API_KEY) return { text: "", logprobs: null };
  const form = new FormData();
  form.append("file", file, file.name || "segment.wav");
  form.append("model", OPENAI_MODEL);
  if (TRANSCRIBE_LANG && TRANSCRIBE_LANG !== "auto") form.append("language", TRANSCRIBE_LANG);
  form.append("temperature", "0");
  if (hint) form.append("prompt", hint);
  form.append("response_format", "json");
  // logprobs: the gpt-4o-(mini-)transcribe family and gpt-transcribe return
  // them (checked against the API); whisper-1 does not.
  const wantLogprobs = /^gpt-(4o|transcribe)/.test(OPENAI_MODEL);
  if (wantLogprobs) form.append("include[]", "logprobs");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[transcribe] openai", res.status, await res.text().catch(() => ""));
      return { text: "", logprobs: null };
    }
    const data = await res.json();
    const logprobs = Array.isArray(data?.logprobs) ? (data.logprobs as unknown[]) : null;
    if (wantLogprobs && !logprobs) console.warn("[transcribe] logprobs requested but not returned");
    return { text: (data?.text as string) || "", logprobs };
  } catch {
    return { text: "", logprobs: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/transcribe — multipart/form-data, field "file" (16 kHz mono WAV).
 *
 * Returns { text, contextText, decision, quality, normalizations }:
 *  - text        = raw transcript (shown on screen, never modified)
 *  - contextText = dictionary-normalized + Thai-only (for AI context / job matching)
 *  - decision    = accept | uncertain | reject (only ≠ accept in enforce mode)
 * Never throws: a failed segment just yields empty text.
 */
export async function POST(req: NextRequest) {
  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return NextResponse.json({ text: "" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ text: "" });

  let result: SttResult;
  if (PROVIDER === "openai") {
    result = await viaOpenAI(file);
  } else {
    // Only fall back to OpenAI when the local service is unreachable/errored —
    // an empty-but-successful result means "nobody said anything".
    result = (await viaTyphoon(file)) ?? (await viaOpenAI(file));
  }

  // Echo guard: cut out any run of the vocabulary hint the model read back at
  // us (a near-silent slice sometimes comes back as the hint itself).
  let rawText = stripPromptEcho(result.text.normalize("NFC"), VOCAB_HINT).trim();

  // A slice that came back as nothing but the hint is asked again without it.
  // The hint is what caused the echo, so re-asking with it changes nothing;
  // the same audio with no prompt returns Thai. Only the OpenAI path carries a
  // prompt at all, so only that path can echo, and only a slice that produced
  // nothing is spent twice — a quiet slice stays one call.
  if (!rawText && VOCAB_HINT && isPromptEcho(result.text, VOCAB_HINT)) {
    console.warn("[transcribe] คำใบ้สะท้อนกลับ — ถอดซ้ำโดยไม่ใช้คำใบ้");
    const plain = await viaOpenAI(file, "");
    if (plain.text.trim()) {
      result = plain;
      rawText = plain.text.normalize("NFC").trim();
    }
  }
  if (!rawText) return NextResponse.json({ text: "" });
  rawText = dropFillers(rawText);
  if (!rawText) return NextResponse.json({ text: "" });

  // Segment-level garbage drops (both screen and context — it's pure noise).
  if (isHallucinatedLoop(rawText)) {
    console.warn(`[transcribe] dropped hallucination loop: ${rawText.slice(0, 40)}…`);
    return NextResponse.json({ text: "" });
  }
  if (THAI_ONLY && isForeignHallucination(rawText)) {
    console.warn(`[transcribe] dropped foreign hallucination: ${rawText.slice(0, 40)}…`);
    return NextResponse.json({ text: "" });
  }

  // Quality score is ALWAYS computed from the raw transcript.
  const quality = summarizeLogprobs(result.logprobs);
  const decision: Decision = CONFIDENCE_MODE === "enforce" ? decide(quality) : "accept";

  // Dictionary (before Latin cleanup), then Thai-only scrub → contextText.
  const norm = DICTIONARY_ENABLED
    ? normalizeDomainTerms(rawText)
    : { text: rawText, appliedRules: [] as Array<{ id: string; count: number }> };
  const contextText = collapseRepeats(THAI_ONLY ? keepThaiOnly(norm.text) : norm.text);

  // The on-screen transcript gets the same Thai-only scrub (codes + whitelist
  // survive) — mixed-in foreign fragments like "Pāṇi tā nu evi." are STT
  // hallucinations, not meeting content. Nothing readable left → drop it.
  const displayText = collapseRepeats(THAI_ONLY ? keepThaiOnly(rawText) : rawText);
  if (!displayText) {
    console.warn(`[transcribe] dropped all-foreign segment: ${rawText.slice(0, 40)}…`);
    return NextResponse.json({ text: "" });
  }

  if (CONFIDENCE_MODE !== "off") {
    console.log(
      "[stt-quality]",
      JSON.stringify({
        mode: CONFIDENCE_MODE,
        decision,
        tokenCount: quality.tokenCount,
        tokenGeoMean: quality.tokenGeoMean === null ? null : Number(quality.tokenGeoMean.toFixed(3)),
        lowTokenRatio: quality.lowTokenRatio === null ? null : Number(quality.lowTokenRatio.toFixed(3)),
        rules: norm.appliedRules,
        bytes: file.size,
        raw: rawText.slice(0, 120),
      }),
    );
  }

  return NextResponse.json({
    text: displayText,
    contextText,
    decision,
    quality,
    normalizations: norm.appliedRules,
  });
}
