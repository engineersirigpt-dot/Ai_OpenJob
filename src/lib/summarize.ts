import type { TranscriptTurn, ConfirmMark } from "@/lib/meeting-history";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// A full minutes report benefits from the bigger model; override per
// deployment with SUMMARY_MODEL. Falls back to gpt-4o when the primary fails.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gpt-5.5";

export interface SummaryDoc {
  name: string;
  content: string;
  /** The short digest made when the document was loaded (WI fields, CAR list). */
  summary?: string;
}

export type SummaryMode = "okjob" | "car" | "pornchai";

export async function generateMeetingTitle(turns: TranscriptTurn[]): Promise<string> {
  if (!OPENAI_API_KEY || turns.length === 0) return "";
  const convo = turns
    .map((t) => `${t.speaker === "assistant" ? "AI" : "ผู้ประชุม"}: ${t.text}`)
    .join("\n")
    .slice(0, 8000);
  const messages = [
    {
      role: "system",
      content: "คุณตั้งชื่อการประชุมจากบทสนทนา ตอบเป็นชื่อเรื่องอย่างเดียว",
    },
    {
      role: "user",
      content: `ต่อไปนี้คือบทสนทนาการประชุม:\n\n${convo}\n\nตั้งชื่อการประชุมสั้นๆ 3-8 คำ ภาษาไทย บอกหัวเรื่องหลักที่คุยกันจริง (เช่น "สอบสวน CAR งานพิมพ์", "วางแผนระบบ ERP") ห้ามใส่วันที่ เวลา เครื่องหมายคำพูด หรือคำว่า "ประชุมเรื่อง" นำหน้า — ตอบเฉพาะชื่อเรื่อง`,
    },
  ];
  for (const model of ["gpt-5.4-mini", "gpt-4o-mini"]) {
    const body: Record<string, unknown> = { model, messages };
    if (/^gpt-5/.test(model)) body.reasoning_effort = "low";
    else body.temperature = 0.2;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error("[title-err]", model, res.status);
        continue;
      }
      const data = await res.json();
      const title = (data?.choices?.[0]?.message?.content?.trim() || "")
        .replace(/^["'“”]+|["'“”]+$/g, "")
        .slice(0, 80);
      if (title) return title;
    } catch (err) {
      console.error("[title-err]", model, err);
    } finally {
      clearTimeout(timer);
    }
  }
  return "";
}

/** Job IDs as REPORT2 writes them: J + digits. */
const JOB_ID = /J\d{6,}/g;

/**
 * Which documents the room actually talked about.
 *
 * A job is "mentioned" when its Job ID, or a distinctive word of its name,
 * shows up in the transcript. The transcript is from a far-field mic and the
 * names are garbled in it, so the match is loose on purpose: a false positive
 * costs a few thousand characters of prompt, a false negative costs the
 * minutes the job's details.
 */
function mentioned(doc: SummaryDoc, convo: string): boolean {
  const ids = new Set([...(doc.name.match(JOB_ID) || []), ...((doc.summary || "").match(JOB_ID) || [])]);
  for (const id of ids) {
    if (convo.includes(id) || convo.includes(id.slice(-4))) return true;
  }
  const words = doc.name
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[\s_\-().,/]+/)
    .filter((w) => w.length >= 3 && !/^J\d+$/.test(w) && !/^(WI|CAR|PDF|JOB)$/i.test(w));
  return words.some((w) => convo.includes(w));
}

/**
 * The documents, laid out so the model can use all of them.
 *
 * Twenty WI documents at eight thousand characters each do not fit, and
 * the old cap quietly dropped everything after the third — which is how a
 * meeting with twenty jobs attached produced minutes that mentioned none.
 * Now every document is present through its digest (the Job ID, customer,
 * quantity, dates and CAR history that the minutes actually need), and the
 * full text is added only for the ones the room talked about.
 */
function buildDocBlock(
  docs: SummaryDoc[],
  convo: string,
  mode: SummaryMode,
): { block: string; discussed: number } {
  if (docs.length === 0) return { block: "", discussed: 0 };
  // A CAR investigation is different: its document is the CAR table itself,
  // one row per case, and the minutes are written row by row. The digest of
  // a table is five bullets, which loses every row, and "mentioned" cannot
  // see a CAR number inside a file name. So the table goes in whole.
  if (mode === "car") {
    const parts: string[] = [];
    let total = 0;
    for (const d of docs) {
      const chunk = d.content.slice(0, Math.max(0, 40000 - total));
      if (!chunk) break;
      total += chunk.length;
      parts.push(`--- ${d.name} ---\n${chunk}`);
    }
    return {
      block: `\n\nตารางสอบสวน CAR และเอกสารที่แนบ (${docs.length} ฉบับ, เนื้อหาเต็ม):\n\n${parts.join("\n\n")}`,
      discussed: docs.length,
    };
  }
  const register: string[] = [];
  const full: string[] = [];
  let fullChars = 0;
  let discussed = 0;
  for (const d of docs) {
    const digest = (d.summary || "").trim() || d.content.slice(0, 600).trim();
    const hit = mentioned(d, convo);
    if (hit) discussed++;
    register.push(`[${hit ? "ถูกพูดถึง" : "ไม่พบว่าถูกพูดถึง"}] ${d.name}\n${digest}`);
    if (hit && fullChars < 36000) {
      const chunk = d.content.slice(0, 6000);
      fullChars += chunk.length;
      full.push(`--- ${d.name} (เนื้อหาเต็ม) ---\n${chunk}`);
    }
  }
  const block =
    `\n\nทะเบียนเอกสารที่แนบในการประชุม (${docs.length} ฉบับ — ถูกพูดถึง ${discussed} ฉบับ ตามที่ระบบตรวจพบ ซึ่งอาจพลาดได้ ให้ยึดบทสนทนาเป็นหลัก):\n\n` +
    register.join("\n\n") +
    (full.length ? `\n\nเนื้อหาเต็มของเอกสารที่ถูกพูดถึง:\n\n${full.join("\n\n")}` : "");
  return { block, discussed };
}

/**
 * The confirm presses, as the one thing in the prompt that is not a guess.
 *
 * The person at the keyboard presses confirm in REPORT2 when the room is
 * done with a job, so the presses in time order are the room's own
 * segmentation of the meeting: what was said between two presses belongs
 * to the job confirmed second. The live transcript carries a marker line
 * at each press ("✓ ยืนยันงาน …"), so the writer can read the talk and the
 * boundaries together instead of matching sentences to WI by numbers.
 */
function buildMarksBlock(marks: ConfirmMark[], rawLive: string, mode: SummaryMode): string {
  if (mode !== "okjob" || marks.length === 0) return "";
  const hhmm = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "?" : d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  };
  const list = marks
    .map((m, i) => `${i + 1}. ${hhmm(m.at)} ✓ ${m.jobId} — ${m.jobName}${m.remark ? ` (หมายเหตุที่พิมพ์ตอน confirm: ${m.remark})` : ""}${m.manual ? " [กดในแอป]" : ""}`)
    .join("\n");
  const live = rawLive.trim()
    ? `\n\nบทถอดสดตามเวลาจริง พร้อมเครื่องหมาย ✓ ยืนยันงาน แทรกอยู่ ณ จังหวะที่กด confirm (ใช้ชุดนี้ตัดสินว่าข้อความไหนเป็นของงานไหน ส่วนถ้อยคำให้ยึดบทสนทนาด้านบน):\n${rawLive.trim()}`
    : "";
  return (
    `\n\nลำดับการกด confirm ในห้อง (${marks.length} ครั้ง) — เส้นแบ่งงานที่แน่นอน: ข้อความที่พูดก่อนเครื่องหมายแต่ละอันและหลังอันก่อนหน้า คือของงานที่ถูกยืนยันตรงนั้น:\n${list}` +
    live
  );
}

function formatRules(mode: SummaryMode, docs: SummaryDoc[], discussed: number, convoChars: number): string {
  const common = `
กติกาของผู้จดรายงานชั้นยอด:
- ผู้อ่านไม่ได้อยู่ในห้อง: ทุกข้อต้องเป็นประโยคสมบูรณ์ที่อ่านแล้วรู้ว่า "เรื่องอะไร เกิดอะไรขึ้น ตกลงว่าอย่างไร" โดยไม่ต้องเดา เช่น "เครื่องพิมพ์ที่จะใช้กับงานนี้เสีย ผลิตไม่ได้ตามกำหนด ที่ประชุมตกลงไม่ย้ายงานไปเครื่องอื่น ให้เตรียมงานรอและติดตามการซ่อม" ไม่ใช่ "มีการกล่าวถึงเครื่องเสีย"
- ห้ามเขียนแบบ "มีการกล่าวถึง…" "มีการพูดถึง…" แล้วตามด้วยคำที่ยกมาจากบทพูด — ให้เล่าว่าสาระคืออะไร ถ้าสาระไม่พอจะเล่า ข้อนั้นไม่ต้องเขียน
- ห้ามยกตัวเลขหรือคำที่ตีความไม่ได้มาเรียงไว้ (เช่น "15, 18, 28, 35") ตัวเลขจะอยู่ในรายงานได้ต่อเมื่อบอกได้ว่าเป็นตัวเลขของอะไร ถ้าบอกไม่ได้ให้ทิ้ง หรือเอ่ยสั้นๆ ในบรรทัดท้ายเรื่องเสียงไม่ชัดเท่านั้น
- เขียนสิ่งที่รู้ให้ชัดและจบในตัว ห้ามต่อท้ายทุกข้อด้วย "แต่ไม่ชัดเจนว่า…" หรือ "ไม่มีการระบุ…" — ถ้าบทพูดเพี้ยน ให้ใช้เอกสารช่วยตีความก่อน (เช่น ได้ยิน "สามสิบเอ็ด" และ WI ของงานหนึ่งมีจำนวน 31,000 ให้เขียนว่า น่าจะหมายถึงจำนวน 31,000 ของงานนั้น) แล้วรวบรวมเฉพาะสิ่งที่ตีความไม่ได้จริงๆ ไว้ในบรรทัดสุดท้ายบรรทัดเดียว
- Job ID ที่ได้ยินมักขาดหรือเกินหนึ่งหลัก ("J8260263" มี 7 หลัก ของจริงมี 8) ให้เทียบกับ Job ID ของงานที่แนบ เลือกตัวที่ใกล้เคียงที่สุด แล้วเขียนว่า "น่าจะเป็น Jxxxxxxxx" พร้อมเหตุผล — ห้ามเขียน Job ID ที่ไม่มีในเอกสารเป็นชื่อหัวข้อ
- ทุกตัวเลข ชื่อคน ชื่องาน Job ID ลูกค้า ต้องมาจากบทสนทนาหรือเอกสารที่แนบ ห้ามแต่งเพิ่ม และสะกดตามเอกสาร
- ข้อความในรูป [ไม่ใช่เนื้อหาประชุม: ...] คือเสียงอื่นที่ติดมา ห้ามนำมาเขียน
- คงศัพท์เทคนิคภาษาอังกฤษไว้ (Spot UV, OPP, CAR, WI, Job ID)
- ภาษากระชับแบบรายงาน ไม่เล่าซ้ำคำพูด ไม่ใส่ ** หรือ markdown ขึ้นต้นข้อย่อยด้วย "- " เท่านั้น หัวข้อส่วนเขียนเป็นบรรทัดธรรมดา
- บทสนทนายาว ${convoChars} ตัวอักษร: เขียนให้ครบทุกเรื่องที่คุยกันจริง ไม่ตัดทิ้งเพราะกลัวยาว แต่ไม่เติมคำเยิ่นเย้อ`;

  if (mode === "okjob") {
    return `รายงานนี้คือ "รายงานการประชุมงาน OK" — การตรวจความพร้อมงานพิมพ์ก่อนผลิต ที่ประชุมไล่ดูทีละงานจากเอกสาร WI ที่แนบ (${docs.length} งาน) ผู้อ่านคือผู้บริหารและฝ่ายผลิต ซึ่งต้องรู้ว่างานไหนคุยแล้ว ตกลงว่าอย่างไร ติดอะไร และงานไหนยังไม่ได้ดู

เขียนตามโครงนี้เรียงกัน:
1) ย่อหน้าภาพรวม 3-5 บรรทัด เล่าเป็นเรื่อง: ประชุมอะไร งานที่แนบกี่งาน คุยถึงกี่งาน เรื่องใหญ่ที่สุดของวันคืออะไร (เช่น เครื่องเสียทำให้งานเลื่อน) ตกลงกันว่าอย่างไร และอะไรยังค้าง — คนที่อ่านแค่ย่อหน้านี้ต้องรู้ว่าวันนี้เกิดอะไรขึ้น
2) บรรทัด "รายงาน" แล้วตามด้วยงานที่ถูกพูดถึงทีละงาน ตามลำดับที่คุย แต่ละงานขึ้นบรรทัดหัวว่า Job ID — ชื่องาน (ลูกค้า, จำนวน, วันส่ง) โดยอ่านค่าจาก WI แล้วตามด้วยข้อย่อย 1-5 ข้อ: สิ่งที่ตกลง/สั่งแก้/ปัญหาที่พบ, สเปคหรือตัวเลขที่พูดถึง, และถ้า WI มีประวัติ CAR ของลูกค้ารายนี้ที่เกี่ยวกับเรื่องที่คุย ให้เตือนไว้หนึ่งข้อ
   ถ้าเอกสารของงานมีส่วน "CAR/PAR ของงานนี้จากระบบ" ให้เตือนเสมอ ไม่ว่าที่ประชุมจะพูดถึงหรือไม่ เขียนเป็นข้อแยกขึ้นต้นด้วยชนิดเอกสาร เช่น "PAR PA/B.69/11007 (9 พ.ย. 69): งานมีขี้กระดาษกระจายทั่วชิ้นงานขณะพิมพ์ GL844 — แนวทางป้องกันยังไม่ได้ระบุ ต้องตอบก่อนผลิตรอบนี้" — PAR คือใบขอให้ป้องกันที่ออกเมื่อเห็นความเสี่ยงก่อนเกิดความเสียหาย ถ้ายังไม่มีแนวทางป้องกัน ให้เขียนว่าต้องตอบ และใส่ไว้ใน "สิ่งที่ต้องทำต่อ" ด้วย ส่วน CAR จากระบบให้เตือนเฉพาะที่เกี่ยวกับเรื่องที่คุยหรือยังไม่ได้แก้
   ถ้าบทสนทนาพูดถึงเรื่องหนึ่งโดยไม่เอ่ยชื่องาน ให้จับคู่กับงานใน WI ด้วยตัวเลข/สเปค/ลูกค้าที่ตรงกัน และบอกว่าจับคู่จากอะไร ถ้าจับคู่ไม่ได้ ให้ขึ้นหัวเป็นชื่อเรื่องที่บอกสาระ เช่น "เครื่องพิมพ์เสีย — งานที่รอคิวเลื่อนทั้งหมด" หรือ "กระดาษล็อตใหม่ทันส่งสิ้นเดือนหน้า" (ห้ามใช้หัวว่า "เรื่องที่ไม่ระบุงาน") แล้วเขียนข้อย่อยตามปกติ
   ข้อย่อยของแต่ละงานเรียงตามนี้: สถานะ/ปัญหา → สิ่งที่ตกลง → ใครทำอะไรต่อ — เขียนเป็นประโยค ไม่ใช่คำสำคัญ
   ถ้ามี "ลำดับการกด confirm" ให้ใช้มันเป็นเส้นแบ่งงานก่อนวิธีอื่นทุกวิธี: งานที่ถูก confirm คืองานที่คุยจริง เรียงตามเวลา confirm และห้ามจับคู่ข้อความไปงานอื่นที่ไม่ได้อยู่ในช่วงเวลานั้น
   confirm หลายใบที่กดติดกันภายในนาทีเดียวกัน (เช่น ใบ Re-Order 3 ใบของ AE เดียวกันกด 10:44 ทั้งหมด) คือห้องคุยรวมกันแล้วกดรวบ ให้เขียนเป็นหัวข้อเดียว เช่น "J22600139, J22600140, J22600141 — งาน Re-Order ไอโออิ / ราชมงคล 3 ใบ (AE ณัฐพร)" แล้วข้อย่อยร่วมกัน ไม่ต้องแยก 3 หัวข้อที่เขียนเหมือนกัน
   งานที่คุยสั้น (ไม่กี่ประโยค) ไม่มีคำสั่งแก้ ไม่มีปัญหา และ confirm ผ่าน ให้เขียนบรรทัดเดียวใต้หัวข้อว่า "ผ่าน ไม่มีประเด็น" (ถ้ามีหมายเหตุที่พิมพ์ตอน confirm ให้ใส่ตามนั้น เช่น "ผ่าน — OK ครบ") ไม่ต้องแต่งข้อย่อยเพิ่ม ประชุม OK งานจริงใช้เวลางานละ 1-2 นาที งานส่วนใหญ่ผ่านแบบนี้
3) บรรทัด "งานที่แนบแต่ยังไม่ได้พูดถึง" แล้วตามด้วย Job ID — ชื่องาน บรรทัดละงาน (ระบบตรวจพบว่าถูกพูดถึง ${discussed} จาก ${docs.length} งาน แต่ให้ตัดสินจากบทสนทนาเอง) ถ้าครบทุกงานให้เขียนว่า คุยครบทุกงาน
4) บรรทัด "สิ่งที่ต้องทำต่อ" แล้วตามด้วยข้อย่อย ระบุงาน ผู้รับผิดชอบ และกำหนดเวลา ตามที่พูดจริง ถ้าไม่มีใครถูกมอบหมายในข้อใด ให้ใส่ "(ยังไม่ระบุผู้รับผิดชอบ)" ท้ายข้อนั้น
5) ถ้ามีช่วงที่บทถอดเสียงอ่านไม่ออกจนตีความไม่ได้ ปิดท้ายด้วยบรรทัดเดียว: "ช่วงที่ถอดเสียงไม่ชัด: …"
${common}`;
  }
  if (mode === "car") {
    return `รายงานนี้คือ "รายงานการสอบสวน CAR" ผู้อ่านคือกรรมการสอบสวนและผู้บริหาร ซึ่งต้องรู้ว่า CAR แต่ละใบ หน่วยที่ถูกออก CAR ชี้แจงว่าอย่างไร สาเหตุรากคืออะไร แก้และป้องกันอย่างไร และกรรมการสรุปว่ารับหรือไม่

เขียนตามโครงนี้เรียงกัน:
1) ย่อหน้าภาพรวม 3-5 บรรทัด เล่าเป็นเรื่อง: สอบสวน CAR กี่ใบจากทั้งหมดกี่ใบในตาราง ของงาน/ลูกค้า/หน่วยใด ใบไหนปิดได้ ใบไหนยังไม่รับหรือขอข้อมูลเพิ่ม เพราะอะไร และมูลค่าความเสียหายรวมที่สอบวันนี้ (จากตาราง) — คนที่อ่านแค่ย่อหน้านี้ต้องรู้ว่าวันนี้สอบอะไรไปและผลเป็นอย่างไร
2) บรรทัด "รายงาน" แล้วตามด้วย CAR ทีละใบ ตามลำดับที่สอบ ขึ้นบรรทัดหัวว่า เลขที่ CAR — ชื่องาน / เลขที่งาน (หน่วยที่ได้รับ CAR, มูลค่า) โดยอ่านค่าจากตารางที่แนบ แล้วข้อย่อยเรียงตามนี้ เขียนเป็นประโยคสมบูรณ์ทุกข้อ:
   - ปัญหาตามตาราง: เกิดอะไรขึ้นกับงานนี้ (รายละเอียดจากคอลัมน์รายละเอียด ย่อให้สั้น)
   - คำชี้แจงของหน่วยที่ได้รับ CAR: เขาอธิบายว่าเกิดจากอะไร ใครพูด
   - สาเหตุรากที่ที่ประชุมสรุป (ถ้ากรรมการเห็นต่างจากหน่วยที่ชี้แจง ให้เขียนทั้งสองฝั่ง)
   - การแก้ไขเฉพาะหน้าและการป้องกันซ้ำ: ทำอะไร ใครรับไปทำ ภายในเมื่อไหร่
   - ผลสรุปของกรรมการ: ยอมรับ / ไม่ยอมรับ / ขอข้อมูลเพิ่ม และเงื่อนไขที่ต้องส่งเพิ่ม ตามที่พูดจริงเท่านั้น ห้ามตัดสินแทน
   ถ้าประเด็นใดใน 5 ข้อนี้ไม่ได้ถูกพูดถึงเลยในการสอบใบนั้น ให้เขียนข้อเดียวว่า "ยังไม่ได้ชี้แจงเรื่อง…" แทนการเว้นไป เพราะกรรมการต้องรู้ว่าอะไรยังขาด
   เลขที่ CAR ที่ได้ยินจากเสียงมักเพี้ยน (ได้ยิน "ศูนย์สี่ศูนย์หนึ่งหนึ่ง" หรือเอ่ยแค่ชื่องาน) ให้จับคู่กับแถวในตารางด้วยชื่องาน เลขที่งาน หน่วย หรือมูลค่าที่ตรงกัน และบอกว่าจับคู่จากอะไร
3) บรรทัด "CAR ในตารางที่ยังไม่ได้สอบสวน" แล้วตามด้วยเลขที่ CAR — ชื่องาน (หน่วยที่ได้รับ, มูลค่า) บรรทัดละใบ หรือเขียนว่า สอบสวนครบทุกใบ
4) บรรทัด "สิ่งที่ต้องทำต่อ" ข้อย่อยพร้อมผู้รับผิดชอบและกำหนดเวลาตามที่พูดจริง
5) ถ้ามีช่วงที่ถอดเสียงไม่ชัด ปิดท้ายบรรทัดเดียว: "ช่วงที่ถอดเสียงไม่ชัด: …"
${common}`;
  }
  return `รายงานนี้คือ "รายงานการประชุม/ปรึกษา" ทั่วไป ผู้อ่านคือผู้บริหารที่ไม่ได้เข้าฟัง ต้องอ่านจบแล้วรู้ว่าคุยเรื่องอะไร ตัดสินใจอะไร และใครต้องทำอะไรต่อ

เขียนตามโครงนี้เรียงกัน:
1) ย่อหน้าภาพรวม 3-5 บรรทัด เล่าเป็นเรื่อง: ประชุมหรือปรึกษาเรื่องอะไร ใครเกี่ยวข้อง ปัญหาหรือโจทย์ตั้งต้นคืออะไร คุยกันไปถึงไหน ตัดสินใจอะไรแล้ว และอะไรยังเปิดอยู่ — คนที่อ่านแค่ย่อหน้านี้ต้องเห็นภาพรวมทั้งหมด
2) บรรทัด "ประเด็นที่คุย" แล้วตามด้วยหัวข้อทีละเรื่อง ตามลำดับที่คุย แต่ละเรื่องขึ้นบรรทัดหัวเป็นชื่อเรื่องที่บอกสาระ (เช่น "ระบบ ERP ตัวใหม่ — จะเริ่มที่ฝ่ายไหนก่อน" ไม่ใช่ "ERP") แล้วข้อย่อย 2-5 ข้อ เขียนเป็นประโยคสมบูรณ์ เรียงตามนี้: ปัญหาหรือคำถามตั้งต้น → ข้อเท็จจริงและตัวเลขที่ยกมา (ใครบอก) → ความเห็นที่ต่างกันและเหตุผลของแต่ละฝ่าย → สิ่งที่สรุปได้ในเรื่องนั้น หรือเขียนตรงๆ ว่ายังไม่สรุป เพราะติดอะไร
   ถ้าพรชัยถูกถามหรือเสนอความเห็นในเรื่องนั้น ให้เขียนสิ่งที่พรชัยเสนอหนึ่งข้อ แยกจากความเห็นของคนในห้อง
   ถ้าเอกสารที่แนบ (ไฟล์ที่อัปโหลด แชทเก่า) มีรายละเอียดของเรื่องนั้น ให้เติมจากเอกสารและบอกว่ามาจากเอกสารใด
3) บรรทัด "มติ / ข้อตกลง" ข้อย่อยเฉพาะสิ่งที่ตกลงกันแล้วจริง เขียนให้ครบว่าตกลงอะไร ภายใต้เงื่อนไขอะไร ถ้าไม่มีให้เขียนว่า ยังไม่มีข้อตกลง และเรื่องไหนที่ใกล้จะตกลงแต่ยังติดอะไร
4) บรรทัด "สิ่งที่ต้องทำต่อ" ข้อย่อยพร้อมผู้รับผิดชอบและกำหนดเวลาตามที่พูดจริง
5) ถ้ามีช่วงที่ถอดเสียงไม่ชัด ปิดท้ายบรรทัดเดียว: "ช่วงที่ถอดเสียงไม่ชัด: …"
${common}`;
}

/**
 * Summarize a finished meeting in Thai as the minutes of record. Best-effort:
 * returns "" if there's no API key, no content, or the request fails —
 * summarization must never block saving the meeting record.
 *
 * The documents loaded in the meeting are the other half of the input. For
 * an OK-job meeting they are the agenda itself — one WI per job — and the
 * minutes are written per job against them; for a CAR investigation they
 * are the CAR table. See buildDocBlock for how all of them fit.
 */
export async function summarizeMeeting(
  turns: TranscriptTurn[],
  meetingTitle: string,
  jobNames: string[],
  docs: SummaryDoc[] = [],
  mode: SummaryMode = "okjob",
  extras: {
    /** Confirm presses seen during the meeting, in order. */
    marks?: ConfirmMark[];
    /** The live transcript with the confirm markers still in it, in time order. */
    rawLive?: string;
  } = {},
): Promise<string> {
  if (!OPENAI_API_KEY || turns.length === 0) return "";

  const convo = turns
    .map((t) => `${t.speaker === "assistant" ? "พรชัย" : t.label || "ผู้ประชุม"}: ${t.text}`)
    .join("\n");

  const context = [
    meetingTitle ? `หัวข้อ: ${meetingTitle}` : "",
    jobNames.length ? `งานที่เกี่ยวข้อง: ${jobNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { block: docBlock, discussed } = buildDocBlock(docs, convo, mode);
  const convoChars = convo.length;
  const marksBlock = buildMarksBlock(extras.marks || [], extras.rawLive || "", mode);

  const userPrompt =
    `${context ? context + "\n\n" : ""}ต่อไปนี้คือบทสนทนาการประชุม (ถอดจากไมค์กลางห้อง ชื่อและตัวเลขอาจเพี้ยน):\n\n${convo}${marksBlock}${docBlock}\n\n` +
    formatRules(mode, docs, discussed, convoChars);

  const messages = [
    {
      role: "system",
      content:
        "คุณคือผู้จดรายงานการประชุมชั้นยอดของโรงพิมพ์ศิริวัฒนา รายงานของคุณอ่านแล้วเห็นภาพการประชุมทั้งหมดโดยไม่ต้องเข้าฟัง ครบทุกเรื่องที่คุย ตัวเลขและชื่อถูกต้องตามเอกสาร ไม่แต่งเพิ่ม และไม่เขียนคลุมเครือ",
    },
    { role: "user", content: userPrompt },
  ];

  // Primary model, then gpt-4o — a failed summary must never block the save.
  const models = [SUMMARY_MODEL, "gpt-4o"].filter((m, i, a) => a.indexOf(m) === i);
  for (const model of models) {
    // gpt-5.x rejects custom temperature; it takes effort/verbosity instead
    // (low effort is enough here — verbosity high gives the detailed report).
    const body: Record<string, unknown> = { model, messages };
    if (/^gpt-5/.test(model)) {
      // Medium effort: the per-job write-up has to match garbled speech to
      // the right WI, which low effort does not do reliably.
      body.reasoning_effort = "medium";
      body.verbosity = "medium";
    } else {
      body.temperature = 0.3;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
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
        console.error("[summarize-err]", model, res.status, await res.text().catch(() => ""));
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || "";
      if (text) return text;
    } catch (err) {
      console.error("[summarize-err]", model, err);
    } finally {
      clearTimeout(timer);
    }
  }
  return "";
}
