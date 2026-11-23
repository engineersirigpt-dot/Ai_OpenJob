/**
 * Shared transcript cleanup — used by the live segment route and by the
 * end-of-meeting file transcription.
 *
 * Thai meetings here are full of English terms (capacity, layout, downtime,
 * Spot UV, CAR). Those are real speech, so Latin words are KEPT. What gets
 * stripped is script that can only be hallucination — Chinese, Japanese,
 * Korean, Arabic, Devanagari, Cyrillic — plus stray single letters and the
 * punctuation left behind. A segment that is foreign end to end is dropped
 * earlier by isForeignHallucination().
 */

export function keepThaiOnly(text: string): string {
  return (
    text
      // CJK (Chinese/Japanese/Korean) — never a real word in these meetings
      .replace(/[⺀-鿿가-힯豈-﫿ｦ-ﾟ]+/g, " ")
      // Arabic / Devanagari / Hebrew / Cyrillic — same story
      .replace(/[֐-ۿऀ-ॿЀ-ӿ]+/g, " ")
      // Latin words with accents English does not use (Vietnamese, Spanish,
      // Portuguese, transliterated Pali…) are hallucinations — drop the word
      .replace(
        /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]*[\u00c0-\u024f\u1e00-\u1eff][A-Za-z\u00c0-\u024f\u1e00-\u1eff]*/g,
        " ",
      )
      // a lone Latin letter is mic noise, not a word (A4, L640 keep their digits)
      .replace(/(^|\s)[A-Za-z](?=\s|$)/g, "$1")
      // Thai writing has no question marks — the STT emits them as noise
      .replace(/[?？]+/g, " ")
      // punctuation left orphaned after a foreign word was removed
      .replace(/(^|\s)[.,!;:]+(?=\s|$)/g, " ")
      .replace(/\s['"`]+(\s|$)/g, " ")
      .replace(/\s+([.,!;:])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/**
 * Terms that may legitimately stand alone with no Thai around them — company
 * jargon and codes. Anything else Latin-only is the model inventing speech.
 */
const STANDALONE_OK = new Set([
  "ok", "okay", "car", "ncr", "uv", "spot", "opp", "pp", "pe", "pet", "pvc",
  "matt", "matte", "gloss", "laminate", "lamination", "die", "cut", "diecut",
  "die-cut", "emboss", "deboss", "foil", "artwork", "wi", "ae", "reprint",
  "proof", "pantone", "offset", "inner", "box", "display", "pack", "fsc", "ld",
  "gsm", "job", "id", "komori", "heidelberg", "cmyk", "plate", "layout", "size",
  "lay", "paper", "capacity", "downtime", "dashboard", "ifu", "erp", "kpi",
  "spec", "order", "stock", "sheet",
]);

/**
 * Does this segment look like a language that is not spoken in these meetings?
 *
 * Thai meetings here mix Thai with English terms, and people code-switch a
 * word or a phrase — never four Latin words in a row with no Thai around them.
 * A run like that (or a segment with almost no Thai) is the model inventing
 * Vietnamese/Indonesian/Spanish out of noise, so the whole segment is dropped.
 */
export function isForeignHallucination(text: string): boolean {
  const letters = text.replace(/[\s\d.,!?()\-:;"'%/]+/g, "");
  if (letters.length === 0) return false; // digits or punctuation only

  let thai = 0;
  let other = 0; // scripts that never belong here
  for (const ch of letters) {
    if (ch >= "\u0e00" && ch <= "\u0e7f") thai++;
    else if (!/[A-Za-z]/.test(ch)) other++;
  }
  // any amount of a foreign script, once it is more than a stray mark
  if (other >= 3) return true;

  const latinWords = (text.match(/[A-Za-z][A-Za-z'-]*/g) || []).filter((w) => w.length > 1);
  // No Thai at all: only company terms and codes are believable on their own.
  // Everything else ("Okay, thank you", "Sami, nemi", "SX") is invented.
  if (thai === 0) {
    const hasDigitCode = /\d/.test(text);
    const allKnown =
      latinWords.length > 0 &&
      latinWords.every((w) => STANDALONE_OK.has(w.toLowerCase().replace(/[.'-]+$/g, "")));
    return !(hasDigitCode || allKnown);
  }
  // mostly non-Thai with a Latin sentence inside it
  if (letters.length >= 12 && thai / letters.length < 0.15 && latinWords.length >= 4) return true;

  return false;
}

/**
 * Collapse a phrase the model repeated back to back.
 *
 * On unclear audio these models sometimes stutter a whole phrase two or three
 * times ("ของรอบนี้แกมจัดประชุม ของรอบนี้แกมจัดประชุม ของรอบนี้แกมจัดประชุม").
 * The loop detector only drops a segment when the repetition dominates it, so
 * shorter stutters used to survive. This removes the duplicates and keeps the
 * sentence — no model involved, so nothing is rewritten.
 */
export function collapseRepeats(text: string): string {
  let words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return text;

  for (let size = Math.min(12, Math.floor(words.length / 2)); size >= 2; size--) {
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      const window = words.slice(i, i + size);
      if (window.length < size) {
        out.push(...words.slice(i));
        break;
      }
      out.push(...window);
      let j = i + size;
      // skip every immediate repeat of this window
      while (
        j + size <= words.length &&
        words.slice(j, j + size).join(" ") === window.join(" ")
      ) {
        j += size;
      }
      i = j;
    }
    words = out;
  }

  // the same word three or more times in a row ("ครับ ครับ ครับ")
  const single: string[] = [];
  for (const w of words) {
    const n = single.length;
    if (n >= 2 && single[n - 1] === w && single[n - 2] === w) continue;
    single.push(w);
  }
  return single.join(" ");
}

/**
 * Backchannel particles — what the room says while someone else is talking.
 *
 * The streaming model hears everything and writes it down: every "ครับ",
 * "ค่ะ" and "อืม" from the people agreeing along, as its own little segment
 * or scattered through a sentence. The first streamed meeting read
 * "ครับ อืม ค่ะ เกินสี่สิบเกิน ครับ สี่สิบเก้า ใกล้ก็เกินแล้ว ค่ะ โอเค ค่ะ". The
 * older model happened to drop these; this one does not, so they are
 * dropped here, deliberately. A particle attached to its word
 * ("ส่งพรุ่งนี้ครับ") is left alone — only a particle standing by itself
 * goes. "ใช่" and "ไม่" are answers, not particles, and stay.
 */
const FILLER = new Set([
  "ครับ", "ค่ะ", "คะ", "ครับผม", "คับ", "ค่า", "จ้ะ", "จ้า",
  "อืม", "อื้ม", "อื้อ", "เออ", "เอ่อ", "เอิ่ม", "อ่า", "อ้า", "ฮะ", "หือ", "หื้ม",
  "นะ", "นะคะ", "นะครับ", "เนอะ", "อ๋อ", "อ้อ",
]);
/** Stands alone as an acknowledgement, but carries meaning inside a sentence. */
const SOFT_FILLER = new Set(["โอเค", "โอเคครับ", "โอเคค่ะ", "ได้", "ได้ครับ", "ได้ค่ะ"]);

export function dropFillers(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const strip = (w: string) => w.replace(/[.,!?…]+$/g, "");
  // Nothing but acknowledgements: the room was agreeing, not saying anything.
  if (words.every((w) => FILLER.has(strip(w)) || SOFT_FILLER.has(strip(w)))) return "";
  return words.filter((w) => !FILLER.has(strip(w))).join(" ");
}

/** Whisper-style hallucination loops ("ครอบครอบครอบ…") — drop them. */
export function isHallucinatedLoop(text: string): boolean {
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
 * Throws away a transcript that is the vocabulary hint read back to us.
 *
 * `gpt-4o-transcribe` takes a `prompt` as a spelling hint, but when a stretch
 * holds no clear speech it sometimes "transcribes" the hint itself — a room
 * that said nothing came back as the list of printing terms. The hint is known
 * text, so any run of it is cut out; if nothing of substance is left, the whole
 * stretch is dropped.
 */
/** How many comma-separated hint terms in a row count as the list, not speech. */
const TERM_RUN_MIN = 5;

/**
 * Cuts a comma-separated run of vocabulary-hint terms out of a transcript,
 * together with the "…:" lead-in in front of it, whatever words that lead-in
 * was transcribed as.
 */
function cutTermRun(text: string, terms: string[]): string {
  if (terms.length < TERM_RUN_MIN) return text;
  const known = new Set(terms.map((t) => t.toLowerCase()));
  const norm = (s: string) => s.trim().replace(/[.!?]+$/, "").toLowerCase();

  // Walk the comma-separated pieces, remembering where each one started.
  const pieces: Array<{ text: string; at: number }> = [];
  let at = 0;
  for (const piece of text.split(",")) {
    pieces.push({ text: piece, at });
    at += piece.length + 1;
  }

  let best: { from: number; to: number } | null = null;
  let runStart = -1;
  for (let i = 0; i <= pieces.length; i++) {
    const isTerm = i < pieces.length && known.has(norm(pieces[i].text));
    if (isTerm) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart >= TERM_RUN_MIN) {
      const from = pieces[runStart].at;
      const last = pieces[i - 1];
      const span = { from, to: last.at + last.text.length };
      if (!best || span.to - span.from > best.to - best.from) best = span;
    }
    runStart = -1;
  }
  if (!best) return text;

  // Take the lead-in with it: everything back to the last ":" within reach,
  // and the few words before that colon, which are the mangled phrase.
  let from = best.from;
  const lookback = text.slice(Math.max(0, from - 60), from);
  const colon = lookback.lastIndexOf(":");
  if (colon >= 0) {
    const beforeColon = lookback.slice(0, colon);
    const phrase = beforeColon.match(/[^\s]+$/);
    // `colon` is an index inside the look-back window, so the phrase starts
    // that many characters into the window, minus its own length.
    from = Math.max(0, from - 60) + colon - (phrase ? phrase[0].length : 0);
  }
  return (text.slice(0, from) + " " + text.slice(best.to)).replace(/\s{2,}/g, " ").trim();
}

/**
 * Did the model answer with the hint instead of with the room?
 *
 * `gpt-4o-transcribe` takes the vocabulary hint as a spelling aid, but on a
 * stretch it cannot read it returns the hint itself, word for word. Two real
 * recordings were tried four ways each — full hint, a short Thai hint, loud,
 * quiet — and every single pass that carried a prompt came back as that
 * prompt, while the same audio with no prompt returned Thai. So "the echo
 * guard emptied this" and "the model heard nothing" are different facts and
 * the caller needs to tell them apart: the first one is worth retrying.
 */
export function isPromptEcho(text: string, hint: string): boolean {
  const raw = text.trim();
  if (!raw || !hint) return false;
  return stripPromptEcho(raw, hint).trim() === "";
}

/**
 * Removes any stretch of the hint's own lead-in phrase, however it was heard.
 *
 * The model does not quote the lead-in exactly. Twelve passes over one real
 * recording produced "ศัพท์ที่ใช้ในการประชุมนี้:", "คำศัพท์ที่ใช้ในการประชุม" and
 * "การประชุมนี้:" — the phrase, a longer version of it, and a piece of it.
 * Anchoring on the exact string catches the first and misses the other two,
 * and the miss is what reached the transcript: the leftover Thai made the
 * echo look like a sentence, so the ratio test at the end of stripPromptEcho
 * stood down and let the whole vocabulary list through as minutes.
 *
 * So the phrase is found by overlap instead of by match — the longest run of
 * Thai the text shares with the lead-in, while that run is long enough to be
 * the phrase rather than a coincidence.
 */
function cutHintPhrase(text: string, leadIn: string): string {
  const MIN = 6;
  if (leadIn.length < MIN) return text;
  return text
    .replace(/[฀-๿]+/g, (run) => {
      let at = -1;
      let best = 0;
      for (let i = 0; i < run.length; i++) {
        for (let len = run.length - i; len > best; len--) {
          if (leadIn.includes(run.slice(i, i + len))) {
            at = i;
            best = len;
            break;
          }
        }
      }
      return best >= MIN ? `${run.slice(0, at)} ${run.slice(at + best)}` : run;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function stripPromptEcho(text: string, hint: string): string {
  if (!hint) return text;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Two shapes of hint. "ศัพท์ที่ใช้ในการประชุมนี้: CAR, NCR, …, WI" is a
  // lead-in and a term list, and the whole run from lead-in to last term is
  // cut. A hint with no colon — "บทสนทนาในที่ประชุมของโรงพิมพ์ พูดภาษาไทย" —
  // is a plain sentence, and only that sentence is cut: there is no list to
  // reach for, and reaching 800 characters past it would take the room's
  // next sentence with it.
  const colon = hint.indexOf(":");
  const anchor = (colon > 0 ? hint.slice(0, colon) : hint).trim();
  const terms = (colon > 0 ? hint.slice(colon + 1) : "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const tail = terms[terms.length - 1] || "";

  let out = text;
  if (anchor && tail) {
    out = out.replace(new RegExp(`(?:คำ)?${esc(anchor)}[\\s\\S]{0,800}?${esc(tail)}`, "gi"), " ");
  } else if (anchor) {
    out = out.replace(new RegExp(esc(anchor), "gi"), " ");
  }

  // The lead-in is not reliable. The model transcribes the hint's own words
  // as it hears them — "ศัพท์ที่ใช้ในการประชุมนี้" came back once as
  // "คีย์ที่ใช้ในการประชุมนี้" — and an anchor that no longer matches lets the
  // whole list through. The list itself cannot be mistaken for speech, so it
  // is found by its shape instead: a long comma-separated run of nothing but
  // hint terms. Nobody says five of these in a row, separated by commas and
  // by nothing else.
  out = cutTermRun(out, terms);

  out = out.replace(/\s{2,}/g, " ").trim();

  // Nothing but punctuation and stray terms left → the stretch was an echo.
  const leftover = out.replace(/[,.·:;\-—\s]+/g, "");
  if (!leftover) return "";

  // Or the model gave back the vocabulary without the opening phrase, or with
  // a mangled one. The decision is made on a PROBE — the text with the hint's
  // own lead-in discounted — and never on the text itself, because the lead-in
  // overlaps ordinary Thai ("การประชุมนี้" is a thing people say in a meeting)
  // and cutting it out of real speech would quietly edit the minutes.
  // For a plain-sentence hint the same probe decides on its own: the model
  // echoes it in pieces too ("บทสนทนาในที่ประชุม", "บทสนทนา ตามที่ประชุมเรื่อง"),
  // and a piece with no real Thai sentence around it is not the room.
  if (terms.length === 0 && anchor.length >= 6) {
    const probe = cutHintPhrase(out, anchor.replace(/\s+/g, ""));
    // Only a text that contained the hint is judged. One that did not is the
    // room, however short — "เดี๋ยวนะ" is a real thing somebody said.
    if (probe !== out) {
      const thaiLeft = (probe.match(/[฀-๿]/g) || []).length;
      if (thaiLeft < 10 && !/[A-Za-z]{2,}|\d/.test(probe)) return "";
    }
    return out;
  }

  if (terms.length >= 4) {
    const probe = cutHintPhrase(out, anchor);
    // A Thai sentence survived the discount, so the room really did say it.
    if (!/[฀-๿]{6,}/.test(probe)) {
      const words = probe.split(/[\s,]+/).filter(Boolean);
      // Both the whole term and its pieces: "die-cut" arrives as one word
      // when the model echoes it and as two when somebody says it, and a
      // set holding only the pieces lets the echoed form through.
      const known = new Set(
        terms.flatMap((t) => [t.toLowerCase(), ...t.toLowerCase().split(/[\s-]+/)]),
      );
      const strip = (w: string) => w.toLowerCase().replace(/[.,:;!?'-]+$/g, "");
      const unknown = words.filter((w) => !known.has(strip(w)));
      // Content of the room's own: a job code, a number, an English word
      // nobody hinted. A stray Thai syllable is not — "เช่น Komori" is the
      // model introducing the hint, not somebody naming a press.
      const ownContent = unknown.some(
        (w) => /\d/.test(w) || /^[A-Za-z][A-Za-z'-]+$/.test(strip(w)),
      );
      if (!ownContent) return "";
      const hits = words.length - unknown.length;
      if (words.length > 0 && hits / words.length >= 0.6) return "";
    }
  }

  return out;
}
