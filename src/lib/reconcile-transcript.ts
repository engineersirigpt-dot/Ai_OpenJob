/**
 * Cross-checks the two transcripts a meeting produces against each other.
 *
 * The room is transcribed twice, by pipelines that fail in different places:
 *
 *   - the LIVE pass cuts audio wherever someone pauses, so each piece is short
 *     and heard in isolation. Short pieces keep numbers, names and print-shop
 *     jargon intact, but the sentences come out clipped and context-free.
 *   - the FILE pass hears ten minutes at a stretch. The sentences read well and
 *     the wording is coherent, but a long context lets the model smooth a Job
 *     ID or a CAR number into whatever fits the sentence.
 *
 * Where both agree, the words are almost certainly right. Where they differ,
 * the difference is the interesting part — and in this shop it lands on the
 * things that must not be wrong: CAR numbers, Job IDs, amounts, people's
 * names. So the file pass is the base, the live pass corrects it, and a model
 * decides each disagreement under rules that forbid inventing a third answer.
 *
 * Nothing here may silently rewrite the record: every window is length-checked
 * against its base, and a window that fails falls back to the base text.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.RECONCILE_MODEL || "gpt-5.5";
const FALLBACK_MODEL = "gpt-4o";

// A window small enough that the model attends to every word in it. Bigger
// windows measurably lose corrections in the middle.
const WINDOW_CHARS = 2200;
// The live text is cut differently, so its matching stretch is taken with a
// margin on both sides rather than at an exact offset.
const LIVE_MARGIN = 400;


// A window may grow only a little — past this the model is writing, not
// correcting.
const MAX_GROWTH = 0.35;
// With nothing to cut, it may not shrink much either.
const MAX_SHRINK_PLAIN = 0.35;
// With lines to cut, how much a window shrinks depends entirely on how much
// พรชัย talked in it, so a percentage of the base is the wrong measure: an
// answer of his can be most of a window. The corrector gives a real one. The
// live pass is deaf while he speaks, so for a stretch of the meeting it holds
// the room's words and nothing else — a result far shorter than that means
// the room's own speech was deleted, not just his.
const CUT_FLOOR_OF_CORRECTOR = 0.5;
// …but never demand more than this share of the base, which guards the case
// where the corrector is the one carrying the extra speech.
const CUT_FLOOR_CAP_OF_BASE = 0.6;
const CUT_FLOOR_MIN_CHARS = 60;

// If one pass came back far shorter than the other it did not hear the whole
// meeting, and must not be the base — building the record on it throws the
// rest of the meeting away. Below this share of the longer pass, the two swap
// roles.
const TRUNCATED_BELOW = 0.6;

const NEWLINE = "\n";

const SYSTEM = `คุณเป็นผู้ตรวจทานบทถอดเสียงการประชุมของโรงพิมพ์ศิริวัฒนา (งานพิมพ์ออฟเซ็ต บรรจุภัณฑ์ กล่องยา ฉลาก)

คุณรู้งานพิมพ์ดี จึงรู้ว่าคำไหนที่ระบบถอดเสียงมักได้ยินผิด เช่น
- ชื่อเครื่องจักร: Komori, Heidelberg, Bobst, Mitsubishi
- ศัพท์งานพิมพ์: plate (เพลท), artwork, reprint, die-cut, Spot UV, OPP, Pantone, offset, layout, lay size, paper size, capacity, downtime
- ระบบงาน: CAR, NCR, OPP, IFU, ERP, KPI, WI, RFQ, Estimate, OTB, Job ID
- ตัวเลขที่สำคัญมาก: เลขลำดับ CAR, เลข Job (J ตามด้วยเลข 8 หลัก), จำนวนเงิน, จำนวนสี, ขนาดกระดาษ

ความรู้นี้ใช้เพื่อ "เลือกคำที่ถูกจากสองชุดที่มีอยู่" เท่านั้น ห้ามใช้เพื่อเดาหรือเติมสิ่งที่ไม่มีใครพูด
สิ่งที่คุณไม่รู้ ให้คงไว้ตามที่ถอดมา อย่าทำให้มันอ่านดูดีขึ้นด้วยการเดา`;

const DESC_FILE =
  "ถอดจากไฟล์เสียงยาว ประโยคลื่น บริบทดี แต่คำเฉพาะ/ตัวเลขมักเพี้ยนเพราะถูกเกลี่ยตามบริบท";
const DESC_LIVE =
  "ถอดสดเป็นช่วงสั้น ประโยคขาดวิ่น แต่ได้ยินตัวเลข ชื่อคน และศัพท์เฉพาะแม่นกว่า";

const rules = (descA: string, descB: string, context: string) => `${
  context ? `หัวข้อการประชุมนี้: ${context}` + NEWLINE + NEWLINE : ""
}คุณจะได้บทถอดเสียง "การประชุมเดียวกัน ช่วงเดียวกัน" สองชุด จากระบบถอดเสียงสองตัวที่ผิดพลาดไม่เหมือนกัน

- ชุด A (ฐาน): ${descA}
- ชุด B (ตัวทาน): ${descB}

หน้าที่ของคุณ: ส่งคืน "ชุด A ที่แก้คำผิดแล้ว" โดยทำตามกฎนี้อย่างเคร่งครัด

1. ยึดโครงประโยคและถ้อยคำของชุด A เป็นหลัก ห้ามเขียนใหม่ ห้ามเรียบเรียง ห้ามสรุปย่อ ห้ามตัดทิ้ง
2. แก้เฉพาะคำที่ชุด B ให้มาต่างกัน และคุณมั่นใจว่าชุด B ถูกกว่า เช่น ตัวเลข ชื่อคน ชื่อเครื่องจักร ศัพท์โรงพิมพ์ (CAR, NCR, Spot UV, OPP, die-cut, Komori, Heidelberg, Pantone, plate, artwork, reprint, layout, Job ID)
3. ห้ามสร้างคำที่ไม่ปรากฏในชุด A หรือชุด B เลือกได้แค่จากสองชุดนี้เท่านั้น
4. ตัวเลขที่สองชุดไม่ตรงกันและตัดสินไม่ได้ ห้ามเดา ให้เขียนว่า [เลขไม่ชัด: <ค่าจาก A> หรือ <ค่าจาก B>]
5. ข้อความที่มีแต่ในชุด B และชุด A ไม่มีเลย ให้เติมเข้าไปตามลำดับที่ควรอยู่ ถ้ามั่นใจว่าเป็นคำพูดจริง
6. ถ้าชุด B ว่างหรืออ่านไม่ได้ความ ให้ส่งชุด A กลับไปเหมือนเดิมทั้งหมด
7. ตอบกลับเป็นบทสนทนาล้วน ไม่ต้องมีหัวข้อ ไม่ต้องอธิบาย ไม่ต้องใส่เครื่องหมายคำพูด

หลักการตัดสินเมื่อสองชุดขัดกัน (เรียงตามลำดับความสำคัญ)
ก. ตัวเลข ชื่อคน ชื่อเครื่องจักร รหัสงาน → เชื่อชุดที่ถอดเป็นช่วงสั้น เพราะได้ยินชัดกว่า
ข. รูปประโยคและลำดับคำ → เชื่อชุดฐาน เพราะได้ฟังต่อเนื่องจึงเรียงถูก
ค. ศัพท์งานพิมพ์ที่ชุดหนึ่งเขียนเป็นไทยอีกชุดเขียนเป็นอังกฤษ (เพลท/plate, โคโมริ/Komori) → ใช้รูปอังกฤษ
ง. จำนวนเงินที่ชุดหนึ่งเขียนเป็นตัวหนังสืออีกชุดเป็นตัวเลข (สองหมื่นห้าพัน/25,000) → ใช้ตัวเลข
จ. ชุดหนึ่งมีประโยคที่อีกชุดไม่มีเลย และตัดสินไม่ได้ว่าใครถูก → เก็บไว้ ห้ามลบ

เสียงที่ไม่ใช่เนื้อหาการประชุม
ไฟล์เสียงบันทึกทุกอย่างในห้อง บางครั้งจึงติดเสียงที่ไม่ใช่การประชุม เช่น คนร้องเพลงหรือเปิดเพลง คนคุยเรื่องส่วนตัว หรือประโยคที่โมเดลถอดเสียงแต่งขึ้นเองตอนไม่มีเสียงพูด (เช่น "ขอบคุณที่รับชม" "ฝากกดติดตาม")

11. ห้ามลบข้อความเหล่านี้ทิ้ง ให้ครอบด้วยวงเล็บเหลี่ยมแบบนี้ [ไม่ใช่เนื้อหาประชุม: ...ข้อความเดิม...] คงถ้อยคำเดิมไว้ข้างใน
12. ครอบเฉพาะที่มั่นใจจริง ถ้าไม่แน่ใจว่าเกี่ยวกับงานหรือไม่ ให้ปล่อยไว้เฉยๆ อย่าครอบ — การครอบคำพูดที่เป็นเนื้อหาประชุมเสียหายกว่าการปล่อยเสียงขยะไว้
13. บทสนทนาเรื่องงานที่ใช้คำไม่สุภาพ ยังเป็นเนื้อหาประชุม ห้ามครอบ`;

/**
 * The recording is continuous, so it also holds พรชัย's spoken answers and any
 * question spoken into the microphone. Both are already kept as their own
 * turns, so they are cut out of the room's block here — with their exact
 * wording given, rather than left to be recognized.
 */
const cutRule = (lines: string[]) =>
  lines.length === 0
    ? ""
    : `

### ข้อความที่ต้องตัดออก
ไฟล์เสียงบันทึกทั้งห้องรวมเสียงของพรชัย (AI) และคำถามที่พูดใส่ไมค์ด้วย ข้อความเหล่านี้ถูกเก็บแยกไว้แล้ว จึงต้องตัดออกจากบทสนทนาของห้องประชุม

กฎเพิ่มเติม
8. ตัดช่วงที่ตรงกับข้อความด้านล่างออกให้หมด รวมถึงช่วงที่ถอดเสียงเพี้ยนไปจากเดิมเล็กน้อยแต่เป็นประโยคเดียวกัน
9. ห้ามตัดคำพูดอื่นของคนในห้องที่ไม่อยู่ในรายการนี้ แม้จะดูคล้ายกัน
10. ตัดออกแล้วเหลือเท่าไหร่ก็ส่งเท่านั้น ไม่ต้องเขียนอะไรมาแทนที่ ถ้าตัดแล้วไม่เหลืออะไรเลยให้ตอบว่างเปล่า

${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

export interface ReconcileResult {
  text: string;
  /** How many windows the model actually changed. */
  corrected: number;
  /** How many windows fell back to the base text. */
  rejected: number;
  windows: number;
}

/** Cut text into windows at a space near the target size. */
function windowize(text: string, size: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > at + size * 0.5) end = space;
    }
    spans.push([at, end]);
    at = end;
  }
  return spans;
}

async function callModel(userPrompt: string): Promise<string> {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userPrompt },
  ];
  for (const model of [MODEL, FALLBACK_MODEL].filter((m, i, a) => a.indexOf(m) === i)) {
    const body: Record<string, unknown> = { model, messages };
    if (/^gpt-5/.test(model)) {
      // Checking words against words is not a reasoning task; low effort keeps
      // the end of a meeting from stalling. Verbosity must stay low or the
      // model starts explaining its corrections instead of making them.
      body.reasoning_effort = "low";
      body.verbosity = "low";
    } else {
      body.temperature = 0;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error("[reconcile]", model, res.status, await res.text().catch(() => ""));
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      if (text) return text;
    } catch (err) {
      console.error("[reconcile]", model, err);
    } finally {
      clearTimeout(timer);
    }
  }
  return "";
}

/**
 * Cross-checks the file transcript (`base`) against the live one (`live`).
 *
 * The file pass is normally the base, because its sentences read better. But a
 * pass that came back far shorter did not hear the whole meeting — a recording
 * chopped into short pieces transcribes badly — and basing the record on it
 * would throw the rest of the meeting away. So whichever pass heard more of
 * the meeting becomes the base, and the other one corrects it.
 *
 * Returns the better of the two unchanged if there is nothing to compare
 * against or the model is unavailable: the record is never left worse than it
 * started.
 */
export async function reconcileTranscript(
  base: string,
  live: string,
  /** Lines already kept as their own turns: พรชัย's answers, spoken questions. */
  exclude: string[] = [],
  /** The meeting's subject, which helps judge what belongs in the record. */
  context = "",
): Promise<ReconcileResult> {
  const file = base.trim();
  const liveText = live.trim();
  if (!file) return { text: liveText, corrected: 0, rejected: 0, windows: 0 };
  if (!liveText || !OPENAI_API_KEY) {
    return { text: file, corrected: 0, rejected: 0, windows: 0 };
  }

  // Whichever pass heard more of the meeting is the base.
  const fileTruncated = file.length < liveText.length * TRUNCATED_BELOW;
  const a = fileTruncated ? liveText : file;
  const b = fileTruncated ? file : liveText;
  const descA = fileTruncated ? DESC_LIVE : DESC_FILE;
  const descB = fileTruncated ? DESC_FILE : DESC_LIVE;
  const nameA = fileTruncated ? "ถอดสด" : "ถอดจากไฟล์เสียง";
  const nameB = fileTruncated ? "ถอดจากไฟล์เสียง" : "ถอดสด";
  if (fileTruncated) {
    console.warn(
      `[reconcile] ขาไฟล์สั้นผิดปกติ (${file.length} vs ${liveText.length} ตัวอักษร) — ` +
        `ใช้ขาถอดสดเป็นฐานแทน`,
    );
  }

  // Lines kept elsewhere are cut from the room's block, which changes how a
  // window's length is judged (see the floor constants above).
  const cutLines = exclude.map((l) => l.trim()).filter((l) => l.length > 8);
  const cuts = cutRule(cutLines);

  const spans = windowize(a, WINDOW_CHARS);
  // Both transcripts run through the same audio in the same order, so a window
  // of the base maps onto the live text by proportion, taken with a margin.
  const ratio = b.length / a.length;
  const out: string[] = [];
  let corrected = 0;
  let rejected = 0;

  for (const [from, to] of spans) {
    const chunkA = a.slice(from, to).trim();
    if (!chunkA) continue;
    // Where this window lands in the corrector, and the same span widened by
    // a margin — the two transcripts are cut at different places, so the
    // model is given the neighbouring words as well.
    const coreFrom = Math.max(0, Math.floor(from * ratio));
    const coreTo = Math.min(b.length, Math.ceil(to * ratio));
    const coreLength = Math.max(0, coreTo - coreFrom);
    const chunkB = b
      .slice(Math.max(0, coreFrom - LIVE_MARGIN), Math.min(b.length, coreTo + LIVE_MARGIN))
      .trim();

    if (!chunkB) {
      out.push(chunkA);
      continue;
    }

    const answer = await callModel(
      `${rules(descA, descB, context)}${cuts}

### ชุด A (ฐาน — ${nameA})
${chunkA}

### ชุด B (ตัวทาน — ${nameB} อาจคาบเกี่ยวช่วงข้างเคียงเล็กน้อย)
${chunkB}

### ส่งคืนชุด A ที่แก้คำผิดแล้ว`,
    );

    const fixed = answer.trim();
    // Growing means the model wrote something; shrinking can simply be the
    // lines that were cut out, so the two directions are judged apart.
    const change = (fixed.length - chunkA.length) / chunkA.length;
    const tooLong = change > MAX_GROWTH;

    let tooShort: boolean;
    if (cutLines.length === 0) {
      tooShort = -change > MAX_SHRINK_PLAIN;
    } else {
      // The yardstick is the corrector's own span for this window — not the
      // margined slice the model was shown, and not a share of the base.
      // Subtracting a fixed margin instead collapsed the floor to its minimum
      // on any window smaller than the margin, which is most short meetings.
      const floor = Math.min(
        chunkA.length * CUT_FLOOR_CAP_OF_BASE,
        Math.max(CUT_FLOOR_MIN_CHARS, coreLength * CUT_FLOOR_OF_CORRECTOR),
      );
      tooShort = fixed.length < floor;
    }
    if (!fixed || tooLong || tooShort) {
      console.warn(
        `[reconcile] ตีกลับหนึ่งช่วง: ${chunkA.length} → ${fixed.length} ตัวอักษร ` +
          `(${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}%)`,
      );
      out.push(chunkA);
      rejected += 1;
      continue;
    }
    if (fixed !== chunkA) corrected += 1;
    out.push(fixed);
  }

  return {
    text: out.join(" ").replace(/\s{2,}/g, " ").trim() || a,
    corrected,
    rejected,
    windows: spans.length,
  };
}
