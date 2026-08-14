/**
 * Detect which loaded Job ID the meeting is currently talking about, from a
 * (messy, speech-transcribed) Thai utterance.
 *
 * People rarely say the full 8-digit Job ID out loud — they say the leading
 * letter/digit and the last few digits (e.g. "เจ ห้า ... สี่ หนึ่ง สาม" for
 * J52600413). So we convert spoken Thai number words to digits, pull out the
 * contiguous digit "runs" they spoke, and match those against the last-3/last-4
 * digits (and first digit) of each loaded job. Ambiguous matches are dropped.
 */

const THAI_NUM_WORDS: [string, string][] = [
  // multi-char first so they're replaced before shorter substrings
  ["ศูนย์", "0"],
  ["เอ็ด", "1"],
  ["หนึ่ง", "1"],
  ["สอง", "2"],
  ["สาม", "3"],
  ["สี่", "4"],
  ["ห้า", "5"],
  ["หก", "6"],
  ["เจ็ด", "7"],
  ["แปด", "8"],
  ["เก้า", "9"],
];

const THAI_NUMERALS = "๐๑๒๓๔๕๖๗๘๙";

/** Turn an utterance into the list of contiguous digit groups the speaker said. */
export function digitRuns(text: string): string[] {
  let s = text;
  // NOTE: replace "เจ็ด" (7) before any handling of the letter "เจ" so we don't
  // mangle it. We don't map the leading letter at all — all job IDs share it.
  for (const [w, d] of THAI_NUM_WORDS) s = s.split(w).join(d);
  // Thai numerals → arabic
  s = s.replace(/[๐-๙]/g, (c) => String(THAI_NUMERALS.indexOf(c)));
  // Join digits spoken with small separators between them ("5 4 1 3" → "5413")
  s = s.replace(/(\d)[\s.\-]+(?=\d)/g, "$1");
  return s.match(/\d+/g) || [];
}

/**
 * Given an utterance and the loaded Job IDs (e.g. ["J52600413", ...]), return
 * the single best-matching Job ID, or null if none / ambiguous.
 */
export function matchJobMention(text: string, jobIds: string[]): string | null {
  if (!text || jobIds.length === 0) return null;
  const runs = digitRuns(text);
  if (runs.length === 0) return null;

  const jobs = jobIds.map((id) => ({ id, digits: id.replace(/\D/g, "") }));

  let best: { id: string; score: number } | null = null;

  for (const run of runs) {
    if (run.length < 3) continue; // too short → likely a quantity/date, not a job

    // Score every job for this run, then only accept an UNAMBIGUOUS top match.
    const scored: { id: string; score: number }[] = [];
    for (const job of jobs) {
      const { id, digits } = job;
      let score = 0;
      if (run === digits) score = 100; // said the whole number
      else if (run.length >= 4 && digits.endsWith(run)) score = 60 + run.length;
      // "first digit + last three" e.g. 5413 for 52600413
      else if (run.length === 4 && run[0] === digits[0] && digits.endsWith(run.slice(1)))
        score = 70;
      else if (run.length === 3 && digits.endsWith(run)) score = 40; // last 3 only
      if (score > 0) scored.push({ id, score });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.score - a.score);
    // ambiguous if two different jobs tie for the top score → skip this run
    if (scored.length > 1 && scored[1].score === scored[0].score) continue;
    if (!best || scored[0].score > best.score) best = scored[0];
  }

  return best?.id ?? null;
}
