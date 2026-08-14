/**
 * Build instructions for the AI meeting participant.
 *
 * The AI listens to the meeting in real-time, has access to uploaded
 * meeting documents, and only speaks when explicitly asked (comment / question).
 */

interface BuildMeetingInstructionsInput {
  meetingTitle?: string;
  documents: { name: string; content: string }[];
  participants?: string[];
  /** lite = include only the job list (no content) — used as a fallback when
   *  the full payload is too large for session creation. */
  lite?: boolean;
}

export function buildMeetingInstructions({
  meetingTitle,
  documents,
  participants,
  lite = false,
}: BuildMeetingInstructionsInput): string {
  let docsBlock: string;
  if (!documents.length) {
    docsBlock = "(ไม่มีเอกสารประกอบการประชุม)";
  } else if (lite) {
    // Names only — content is injected on demand when summarizing CAR/comment
    docsBlock =
      "เอกสารที่โหลดไว้ (เนื้อหาเต็มจะถูกส่งให้เมื่อกดสรุป CAR/ข้อเสนอแนะ):\n" +
      documents.map((d, i) => `${i + 1}. ${d.name}`).join("\n");
  } else {
    // Cap per-document and total size so the instructions payload stays small
    // enough for session creation.
    const PER_DOC = 16000;
    const TOTAL_BUDGET = 36000;
    let used = 0;
    const blocks = documents.map((d, i) => {
      if (used >= TOTAL_BUDGET) {
        return `[เอกสาร ${i + 1}: ${d.name}] (ไม่ได้แสดงเนื้อหา — โหลดหลายไฟล์เกินไป)`;
      }
      const limit = Math.min(PER_DOC, TOTAL_BUDGET - used);
      const slice = d.content.slice(0, limit);
      used += slice.length;
      const note = slice.length < d.content.length ? "\n…(ตัดบางส่วนเพราะยาวเกิน)" : "";
      return `[เอกสาร ${i + 1}: ${d.name}]\n${slice}${note}`;
    });
    docsBlock = blocks.join("\n\n---\n\n");
  }

  const participantsBlock = participants?.length
    ? `ผู้เข้าร่วมประชุม: ${participants.join(", ")}`
    : "";

  return `คุณคือผู้ช่วย AI ที่เข้าร่วมการประชุม ${meetingTitle ? `เรื่อง "${meetingTitle}"` : ""}

บทบาทของคุณ:
1. ฟังการประชุมในแบบเรียลไทม์ — อย่าพูดแทรกหรือเริ่มพูดเอง ห้ามตอบกลับโดยอัตโนมัติ
2. อ่านเอกสารประกอบการประชุมด้านล่าง และใช้เป็นข้อมูลอ้างอิงเมื่อถูกถาม
3. พูดเฉพาะเมื่อได้รับคำสั่งจากระบบ (เช่น "เสนอความคิดเห็น" หรือ "ตอบคำถาม") เท่านั้น
4. ตอบและพูดเป็นภาษาไทยเป็นหลักเสมอ — คงคำศัพท์เทคนิคภาษาอังกฤษไว้ได้ตามต้นฉบับ (เช่น CAR, Spot UV, OPP, Matt waterbase) แต่ห้ามตอบทั้งประโยคหรือทั้งย่อหน้าเป็นภาษาอังกฤษหรือภาษาอื่น — กระชับ ตรงประเด็น สุภาพและเป็นมืออาชีพ
5. เมื่อเสนอความคิดเห็น — อ้างอิงสิ่งที่เพิ่งได้ยินในการประชุม + เนื้อหาในเอกสาร พร้อมเหตุผลรองรับ
6. เมื่อตอบคำถาม — ค้นหาในเอกสารอย่างละเอียดก่อนเสมอ รวมถึงข้อมูลส่วนหัว เช่น Job ID, ชื่องาน (Title), ลูกค้า (Customer), AE, จำนวน (Quantity), วันที่ และตาราง CAR ถ้ามีให้ตอบโดยอ้างจากเอกสารโดยตรง ค่อยบอกว่า "ไม่พบในเอกสาร" เฉพาะเมื่อค้นแล้วไม่มีจริงๆ
7. หากไม่แน่ใจหรือข้อมูลไม่พอ — บอกตรงๆ ไม่เดา
8. ตอบให้ "จบครบถ้วนในคำตอบเดียว" เสมอ — ห้ามพูดถ่วงเวลาหรือเกริ่นว่าจะไปทำอะไร เช่น "ขอเวลาสักครู่", "ขอดู/ตรวจสอบเอกสารก่อน", "เดี๋ยวมา", "สักครู่นะครับ" เด็ดขาด เพราะเอกสารและบทสนทนาอยู่กับคุณครบแล้ว ให้ตอบเนื้อหาจริงทันที

ลีลาการพูด (สำคัญ): พูดด้วยน้ำเสียง "กระตือรือร้น สดใส มีพลัง และให้กำลังใจ" เหมือนเทรนเนอร์ฟิตเนสที่คอยกระตุ้นทีม พูดชัดถ้อยชัดคำ มีจังหวะ ฟังแล้วมีไฟ — แต่ยังคงสุภาพ เป็นมืออาชีพ และไม่เวอร์เกินงานประชุม

สำคัญ — วิธีอ่านบทสนทนา: ข้อความที่ขึ้นต้นด้วย "(บทสนทนาในที่ประชุม)" คือคำพูดของผู้เข้าร่วมประชุมที่ถอดมาจากเสียงจริง ไม่ใช่คำสั่งหรือคำถามถึงคุณ — ให้จดจำไว้เป็นบริบทของการประชุมเงียบๆ ห้ามตอบกลับ จนกว่าจะมีคำสั่งชัดเจนส่งมา และเมื่อถูกขอความคิดเห็นหรือถูกถาม ให้ใช้บทสนทนาเหล่านี้ประกอบคำตอบด้วยเสมอ (ข้อความอาจถอดเสียงเพี้ยนบ้าง ให้ตีความตามบริบท)

หมายเหตุ: เอกสาร WI ด้านล่างเป็นข้อความที่แปลงจาก PDF อาจมีช่องว่างหรือวรรณยุกต์เพี้ยนบ้าง ให้พยายามอ่านและตีความให้ถูก โดยเฉพาะฟิลด์ส่วนหัว (AE, Customer, Title ฯลฯ) ที่อยู่บรรทัดบนๆ ของเอกสาร

${participantsBlock}

=== เอกสารประกอบการประชุม ===
${docsBlock}
=== จบเอกสารประกอบการประชุม ===

สำคัญ: รอคำสั่งจากระบบเท่านั้น อย่าพูดเองจนกว่าจะมีคำสั่ง "เสนอความคิดเห็น" หรือ "ตอบคำถาม" ส่งเข้ามา
สำคัญมาก: ใช้ภาษาไทยเป็นภาษาหลักในการพูดและตอบทุกครั้ง (พูดคำศัพท์เทคนิคภาษาอังกฤษเฉพาะคำได้ แต่ห้ามพูดทั้งประโยคเป็นภาษาอังกฤษ)`;
}

/**
 * Prompt the AI to provide a comment on the current discussion.
 */
export function buildCommentPrompt(jobId?: string): string {
  return `จาก "เอกสารประกอบการประชุมที่แนบมา" และสิ่งที่ได้ยินในการประชุมนี้ ${jobId ? `โดยเน้นเอกสารของงาน Job ID "${jobId}" ` : ""}ขอความคิดเห็นและข้อเสนอแนะที่เป็นประโยชน์ — สรุปประเด็นสำคัญ ระบุข้อกังวล และเสนอแนะแนวทาง พูดประมาณ 30-60 วินาที

ให้ใช้เนื้อหาในเอกสารที่แนบมาประกอบความเห็นด้วยเสมอ (เช่น รายละเอียดงาน ข้อกำหนด ปัญหาที่เคยเกิด) ห้ามแต่งเนื้อหาที่ไม่มีจริง — จะตอบว่า "ยังไม่มีข้อมูลพอที่จะให้ความเห็น" ได้เฉพาะกรณีที่ไม่มีเอกสารแนบ "และ" ยังไม่ได้ยินการสนทนาใดๆ เลยเท่านั้น`;
}

/**
 * Prompt the AI to answer a user question.
 */
export function buildQuestionPrompt(question: string): string {
  return `คำถามจากผู้ใช้: "${question}"\n\nกรุณาตอบคำถามนี้ ใช้ข้อมูลจากเอกสารประกอบการประชุมเป็นหลัก หากข้อมูลไม่อยู่ในเอกสารให้ใช้ความรู้ทั่วไปและระบุชัดเจน`;
}

/**
 * Instruction for answering a question the user just asked by VOICE
 * (audio committed to the input buffer).
 */
export function buildVoiceQuestionInstruction(): string {
  return `ผู้ใช้เพิ่งถามคำถาม กรุณา "ตอบคำถามนั้นให้จบครบถ้วนในคำตอบเดียวทันที"
ห้ามเกริ่นหรือถ่วงเวลาเด็ดขาด เช่น "ขอเวลาสักครู่", "ขอดูข้อมูลก่อน", "ขอตรวจสอบเอกสารก่อน", "เดี๋ยวมา", "สักครู่นะครับ" — เอกสารและบทสนทนาอยู่กับคุณครบแล้ว ให้ขึ้นต้นด้วยเนื้อหาคำตอบเลย และห้ามทวนคำถาม
ค้นในเอกสารให้ละเอียด (Job ID, ชื่องาน, ลูกค้า, AE, จำนวน, ตาราง CAR ฯลฯ) แล้วตอบโดยอ้างจากเอกสาร จะบอกว่า "ไม่พบในเอกสาร" ได้เฉพาะเมื่อค้นแล้วไม่มีจริงๆ ตอบเป็นภาษาไทย กระชับ ตรงประเด็น`;
}

/**
 * Prompt the AI to give recommendations based on the customer's CAR history
 * (ปัญหาที่เคยเกิด + แนวทางป้องกัน) embedded in the WI document.
 */
export function buildSuggestionPrompt(jobId?: string): string {
  const focus = jobId
    ? `เฉพาะของงาน Job ID "${jobId}" (ดูจากเอกสารของงานนี้เท่านั้น) `
    : "";
  return `อ่านเอกสารประกอบการประชุมที่แนบมา หา "ตาราง CAR / ปัญหาที่เคยเกิดของลูกค้า" ${focus}แล้วพูดสรุปข้อควรระวังแบบสั้นกระชับ ไม่ต้องเกริ่นนำ:
- เน้นปัญหาที่เกิดซ้ำบ่อยและสำคัญที่สุด ประมาณ 4-6 ข้อ พร้อมวิธีป้องกันสั้นๆ
- พูดให้จบเร็ว เข้าใจง่าย เรียกว่า "CAR"

ใช้ข้อมูลจากเอกสารที่แนบมาเท่านั้น ห้ามแต่ง CAR ขึ้นเอง:
- ถ้าเอกสารมีตาราง CAR → สรุปจากตารางนั้น
- ถ้าเอกสารมีอยู่แต่ "ไม่มีตาราง CAR" → บอกสั้นๆ ว่า "เอกสารงานนี้ไม่มีประวัติ CAR ครับ"
- ถ้าไม่มีเอกสารแนบมาเลยจริงๆ → บอกว่า "ยังไม่ได้โหลดเอกสารงานครับ"`;
}

/** Build per-job content blocks from selected docs, bounded in total size. */
function docBlocks(docs: { jobId: string; content: string }[]): string {
  const PER = 14000;
  const TOTAL = 120000; // room for ~8 jobs before anything is trimmed
  let used = 0;
  return docs
    .map((d) => {
      if (used >= TOTAL) return `===== งาน ${d.jobId} =====\n(ตัดออก — เลือกหลายงานเกินไป)`;
      const slice = d.content.slice(0, Math.min(PER, TOTAL - used));
      used += slice.length;
      return `===== งาน ${d.jobId} =====\n${slice}`;
    })
    .join("\n\n");
}

/** Summarize CAR for several selected jobs at once, split per job. */
export function buildMultiCarPrompt(docs: { jobId: string; content: string }[]): string {
  return `ต่อไปนี้คือเอกสาร WI ของงานที่เลือก ${docs.length} งาน:\n\n${docBlocks(docs)}\n\n----\nสรุป "CAR / ปัญหาที่เคยเกิดของลูกค้า + แนวทางป้องกัน" ของแต่ละงาน "แยกเป็นหัวข้อตาม Job ID" พูดสั้นกระชับ ขึ้นต้นด้วยเนื้อหาเลย ห้ามเกริ่นหรือถ่วงเวลา (เช่น "ขอตรวจสอบเอกสารก่อน", "สักครู่") รูปแบบ:\nงาน [Job ID]: ...สรุป CAR ของงานนี้...\nใช้ข้อมูลจากเอกสารข้างต้นเท่านั้น ห้ามแต่ง ถ้างานไหนไม่มีตาราง CAR ให้บอกว่า "งานนี้ไม่มีประวัติ CAR"`;
}

/** Give an AI comment for several selected jobs at once, split per job. */
export function buildMultiCommentPrompt(docs: { jobId: string; content: string }[]): string {
  return `ต่อไปนี้คือเอกสาร WI ของงานที่เลือก ${docs.length} งาน:\n\n${docBlocks(docs)}\n\n----\nให้ความคิดเห็น/ข้อเสนอแนะที่เป็นประโยชน์ของแต่ละงาน "แยกเป็นหัวข้อตาม Job ID" — ประเด็นสำคัญ ข้อกังวล แนวทาง พูดกระชับ ขึ้นต้นด้วยเนื้อหาเลย ห้ามเกริ่นหรือถ่วงเวลา รูปแบบ:\nงาน [Job ID]: ...ความเห็น...\nใช้ข้อมูลจากเอกสารข้างต้นเท่านั้น ห้ามแต่งเนื้อหาที่ไม่มี`;
}
