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
}

export function buildMeetingInstructions({
  meetingTitle,
  documents,
  participants,
}: BuildMeetingInstructionsInput): string {
  const docsBlock = documents.length
    ? documents
        .map((d, i) => `[เอกสาร ${i + 1}: ${d.name}]\n${d.content.slice(0, 8000)}`)
        .join("\n\n---\n\n")
    : "(ไม่มีเอกสารประกอบการประชุม)";

  const participantsBlock = participants?.length
    ? `ผู้เข้าร่วมประชุม: ${participants.join(", ")}`
    : "";

  return `คุณคือผู้ช่วย AI ที่เข้าร่วมการประชุม ${meetingTitle ? `เรื่อง "${meetingTitle}"` : ""}

บทบาทของคุณ:
1. ฟังการประชุมในแบบเรียลไทม์ — อย่าพูดแทรกหรือเริ่มพูดเอง ห้ามตอบกลับโดยอัตโนมัติ
2. อ่านเอกสารประกอบการประชุมด้านล่าง และใช้เป็นข้อมูลอ้างอิงเมื่อถูกถาม
3. พูดเฉพาะเมื่อได้รับคำสั่งจากระบบ (เช่น "เสนอความคิดเห็น" หรือ "ตอบคำถาม") เท่านั้น
4. ตอบเป็นภาษาไทย กระชับ ตรงประเด็น สุภาพและเป็นมืออาชีพ
5. เมื่อเสนอความคิดเห็น — อ้างอิงสิ่งที่เพิ่งได้ยินในการประชุม + เนื้อหาในเอกสาร พร้อมเหตุผลรองรับ
6. เมื่อตอบคำถาม — ถ้าข้อมูลอยู่ในเอกสารให้อ้างอิงเอกสารโดยตรง ถ้าไม่มีให้ใช้ความรู้ทั่วไปและบอกชัดเจนว่า "ไม่พบในเอกสาร"
7. หากไม่แน่ใจหรือข้อมูลไม่พอ — บอกตรงๆ ไม่เดา

${participantsBlock}

=== เอกสารประกอบการประชุม ===
${docsBlock}
=== จบเอกสารประกอบการประชุม ===

สำคัญ: รอคำสั่งจากระบบเท่านั้น อย่าพูดเองจนกว่าจะมีคำสั่ง "เสนอความคิดเห็น" หรือ "ตอบคำถาม" ส่งเข้ามา`;
}

/**
 * Prompt the AI to provide a comment on the current discussion.
 */
export function buildCommentPrompt(focusHint?: string): string {
  return `จากที่ฟังการประชุมมาทั้งหมดและจากเอกสารที่อ่าน ${focusHint ? `โดยเน้นที่ "${focusHint}" ` : ""}ขอความคิดเห็นและข้อเสนอแนะที่เป็นประโยชน์ — สรุปประเด็นสำคัญ ระบุข้อกังวล (ถ้ามี) และเสนอแนะแนวทาง ใช้เวลาพูดประมาณ 30-60 วินาที`;
}

/**
 * Prompt the AI to answer a user question.
 */
export function buildQuestionPrompt(question: string): string {
  return `คำถามจากผู้ใช้: "${question}"\n\nกรุณาตอบคำถามนี้ ใช้ข้อมูลจากเอกสารประกอบการประชุมเป็นหลัก หากข้อมูลไม่อยู่ในเอกสารให้ใช้ความรู้ทั่วไปและระบุชัดเจน`;
}
