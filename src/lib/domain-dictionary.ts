/**
 * Deterministic domain dictionary — fixes known transliterations/spacings of
 * print-industry terms AFTER STT, before the Latin cleanup.
 *
 * Rules of the rules:
 *  - only patterns actually observed in real transcripts (no guessing)
 *  - specific rules BEFORE general ones (array order is applied order)
 *  - no fuzzy matching, no customer names, no LLM
 *  - idempotent: running twice must give the same output
 *  - every replacement is recorded by rule id for auditability
 *
 * Thai-origin replacements carry surrounding spaces (Thai has no word breaks);
 * normalizeDomainTerms collapses the extra whitespace afterwards.
 */

export type DomainRule = {
  id: string;
  pattern: RegExp;
  replacement: string;
};

export const DOMAIN_RULES: DomainRule[] = [
  // --- machines ---
  { id: "machine-l640", pattern: /\b[Ll]\s*[-–—]?\s*640\b/gu, replacement: "L640" },
  { id: "machine-l640-th", pattern: /แอล\s*[-–—]?\s*640/gu, replacement: " L640 " },
  { id: "komori-th", pattern: /โค\s*โม\s*ริ/gu, replacement: " Komori " },
  { id: "heidelberg-th", pattern: /ไฮ\s*เดล\s*เบิ[ร์]*ก/gu, replacement: " Heidelberg " },
  // --- finishing / prepress (specific before general: Spot UV ก่อน UV) ---
  { id: "spot-uv-th", pattern: /สปอ[ตท]\s*ยู\s*วี/gu, replacement: " Spot UV " },
  { id: "uv-th", pattern: /ยูวี/gu, replacement: " UV " },
  { id: "die-cut-th", pattern: /(?:ได|ดาย)\s*คั[ทตด]/gu, replacement: " die-cut " },
  { id: "laminate-th", pattern: /ลา\s*มิ\s*เน[ตท]/gu, replacement: " laminate " },
  { id: "pantone-th", pattern: /(?:แพน|ปัน)\s*โทน/gu, replacement: " Pantone " },
  { id: "offset-th", pattern: /ออฟ\s*เซ็?[ทต]/gu, replacement: " offset " },
  { id: "emboss-th", pattern: /เอ็ม\s*บอส/gu, replacement: " emboss " },
  { id: "cmyk-th", pattern: /ซี\s*เอ็ม\s*ไว\s*เค/gu, replacement: " CMYK " },
];

// ---------------------------------------------------------------------------
// Per-deployment overrides — so this app can serve OTHER meeting domains
// without code changes. Optional file at data/stt-dictionary.json:
//   {
//     "disableRules": ["machine-l640"],
//     "extraRules": [{ "id": "x", "pattern": "…", "flags": "gu", "replacement": "…" }],
//     "extraWhitelist": ["komori", "somebrand"]
//   }
// data/ is excluded from deploys, so local customization survives updates.
// ---------------------------------------------------------------------------
import fs from "fs";
import path from "path";

interface ExternalConfig {
  disableRules?: string[];
  extraRules?: Array<{ id: string; pattern: string; flags?: string; replacement: string }>;
  extraWhitelist?: string[];
}

let _external: ExternalConfig | null = null;

function externalConfig(): ExternalConfig {
  if (_external) return _external;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "data", "stt-dictionary.json"), "utf-8");
    _external = JSON.parse(raw) as ExternalConfig;
    console.log("[dictionary] loaded data/stt-dictionary.json");
  } catch {
    _external = {}; // no file → built-ins only
  }
  return _external;
}

let _active: DomainRule[] | null = null;

function activeRules(): DomainRule[] {
  if (_active) return _active;
  const cfg = externalConfig();
  const disabled = new Set(cfg.disableRules ?? []);
  const rules = DOMAIN_RULES.filter((r) => !disabled.has(r.id));
  for (const r of cfg.extraRules ?? []) {
    try {
      rules.push({ id: r.id, pattern: new RegExp(r.pattern, r.flags ?? "gu"), replacement: r.replacement });
    } catch {
      console.warn(`[dictionary] bad extra rule "${r.id}" — skipped`);
    }
  }
  _active = rules;
  return rules;
}

/** Extra whitelist words from data/stt-dictionary.json (lowercase). */
export function externalWhitelist(): string[] {
  return (externalConfig().extraWhitelist ?? []).map((w) => w.toLowerCase());
}

export interface NormalizeResult {
  text: string;
  appliedRules: Array<{ id: string; count: number }>;
}

export function normalizeDomainTerms(input: string): NormalizeResult {
  let text = input.normalize("NFC");
  const appliedRules: Array<{ id: string; count: number }> = [];

  for (const rule of activeRules()) {
    let count = 0;
    text = text.replace(rule.pattern, (matched) => {
      // Already canonical (e.g. "L640" matching its own rule) → no-op, and
      // don't pollute the audit trail with a phantom replacement.
      if (matched === rule.replacement) return matched;
      count += 1;
      return rule.replacement;
    });
    if (count > 0) appliedRules.push({ id: rule.id, count });
  }

  return {
    text: text.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim(),
    appliedRules,
  };
}
