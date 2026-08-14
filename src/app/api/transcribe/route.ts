import { NextRequest, NextResponse } from "next/server";
import { normalizeDomainTerms, externalWhitelist } from "@/lib/domain-dictionary";

export const runtime = "nodejs";
export const maxDuration = 30;

// Local on-premises Thai ASR (typhoon-asr-service). Meeting audio stays inside
// the company network. Set STT_PROVIDER=openai to bypass it.
const TYPHOON_URL = process.env.TYPHOON_ASR_URL || "http://127.0.0.1:8020/transcribe";
const PROVIDER = (process.env.STT_PROVIDER || "typhoon").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
// "th" = lock to Thai (safe, transliterates English). "auto" = let the model
// detect — better for Thai/English code-switching, small risk of drifting.
const TRANSCRIBE_LANG = (process.env.TRANSCRIBE_LANG || "th").toLowerCase();

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

/** Whisper-style hallucination loops ("ครอบครอบครอบ…") — drop them. */
function isHallucinatedLoop(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (t.length < 16) return false;
  for (let n = 2; n <= 6; n++) {
    const counts = new Map<string, number>();
    for (let i = 0; i + n <= t.length; i++) {
      const gram = t.slice(i, i + n);
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    let max = 0;
    for (const c of counts.values()) if (c > max) max = c;
    if (max >= 4 && (max * n) / t.length >= 0.5) return true;
  }
  return t.length >= 20 && new Set(t).size <= 4;
}

/**
 * On garbage audio the model sometimes emits whole sentences in another
 * language even with language:"th". A real utterance here is Thai with a few
 * English terms, so a segment with almost no Thai characters is noise.
 */
function isForeignHallucination(text: string): boolean {
  const letters = text.replace(/[\s\d.,!?()\-:;"'%/]+/g, "");
  if (letters.length < 12) return false;
  let thai = 0;
  for (const ch of letters) {
    if (ch >= "฀" && ch <= "๿") thai++;
  }
  return thai / letters.length < 0.15;
}

/**
 * Thai-only context text: every Latin word is dropped unless it's a code
 * containing digits (J82601713, L640, 3x80g) or a known print-industry term.
 * Applied to contextText only — the on-screen transcript stays raw.
 */
const WHITELIST = new Set([
  "ai", "car", "spot", "uv", "opp", "pp", "pe", "pet", "pvc", "matt", "matte",
  "gloss", "waterbase", "laminate", "lamination", "die", "cut", "diecut",
  "die-cut", "emboss", "deboss", "foil", "artwork", "wi", "ae", "ok", "okay",
  "reprint", "proof", "pantone", "offset", "inner", "box", "display", "pack",
  "fsc", "ld", "gsm", "job", "id", "komori", "heidelberg", "cmyk",
  // per-deployment additions from data/stt-dictionary.json
  ...externalWhitelist(),
]);

function keepThaiOnly(text: string): string {
  return text
    // CJK (Chinese/Japanese/Korean) — pure hallucination here, never whitelisted
    .replace(/[⺀-鿿가-힯豈-﫿･-ﾟ]+/g, " ")
    .replace(/[A-Za-zÀ-ÖØ-öø-ÿĀ-ɏḀ-ỿ][A-Za-z0-9À-ÖØ-öø-ÿĀ-ɏḀ-ỿ.'\-]*/g, (word) => {
      if (/\d/.test(word)) return word; // job/product codes stay
      const bare = word.toLowerCase().replace(/[.'\-]+$/g, "");
      return WHITELIST.has(bare) ? word : " ";
    })
    .replace(/\s['"`]+(\s|$)/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
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

async function viaOpenAI(file: File): Promise<SttResult> {
  if (!OPENAI_API_KEY) return { text: "", logprobs: null };
  const form = new FormData();
  form.append("file", file, file.name || "segment.wav");
  form.append("model", OPENAI_MODEL);
  if (TRANSCRIBE_LANG && TRANSCRIBE_LANG !== "auto") form.append("language", TRANSCRIBE_LANG);
  form.append("temperature", "0");
  form.append("response_format", "json");
  // logprobs are only supported on the gpt-4o-(mini-)transcribe family.
  const wantLogprobs = OPENAI_MODEL.startsWith("gpt-4o");
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

  const rawText = result.text.normalize("NFC").trim();
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
  const contextText = THAI_ONLY ? keepThaiOnly(norm.text) : norm.text;

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
    text: rawText,
    contextText,
    decision,
    quality,
    normalizations: norm.appliedRules,
  });
}
