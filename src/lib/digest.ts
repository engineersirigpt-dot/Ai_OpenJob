/**
 * Build a compact "digest" of a WI document at pull/upload time.
 *
 * The AI reads the (messy, PDF-extracted) WI text once and distills only the
 * important fields — Job ID, Title, Customer, AE, quantity, key specs and a
 * short CAR summary — into a small block of Thai text. We store this digest
 * alongside the full content and feed ONLY the digests into the realtime
 * session instructions, so the session payload stays small even when many
 * documents are loaded. The full content is still injected on demand when the
 * user asks for a CAR / comment summary.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DIGEST_MODEL = process.env.DIGEST_MODEL || process.env.SCORING_MODEL || "gpt-4o-mini";

/** Cap the input so a single huge WI doesn't blow up cost/latency. */
const INPUT_CAP = 24000;

/**
 * General-purpose digest for arbitrary uploaded documents (พรชัย mode).
 * CRITICAL: this must NOT use the WI (print-job) template — forcing a generic
 * document into a job-shaped summary leaves blank fields that the realtime
 * model then "fills in" with fabricated Job IDs/customers. Summarize only what
 * is actually in the text.
 */
export async function digestGeneralDocument(fileName: string, rawText: string): Promise<string> {
  if (!OPENAI_API_KEY || !rawText.trim()) return "";
  const text = rawText.slice(0, INPUT_CAP);
  const userPrompt = `ต่อไปนี้คือข้อความที่แปลงจากไฟล์เอกสาร "${fileName}" (อาจมีช่องว่าง/วรรณยุกต์เพี้ยนจากการแปลงไฟล์):

${text}

สรุปสาระสำคัญของเอกสารนี้เป็นภาษาไทย 5-10 ข้อ (ขึ้นต้นแต่ละข้อด้วย "- ") ตามเนื้อหาที่ปรากฏจริงเท่านั้น:
- คงชื่อคน ชื่อบริษัท ตัวเลข วันที่ ตามที่เขียนไว้จริง ห้ามแต่งเพิ่มหรือเดาเด็ดขาด
- ถ้าเอกสารสั้น/ข้อมูลน้อย สรุปเท่าที่มี ไม่ต้องเติมให้ครบ
ตอบเฉพาะสรุป ไม่ต้องเกริ่นนำ ไม่ใช้ markdown อื่น`;

  return callDigest(userPrompt, "คุณเป็นผู้ช่วยสรุปเอกสาร ตอบกระชับ ตรงประเด็น เป็นภาษาไทย ใช้ข้อมูลจากเอกสารเท่านั้น ห้ามแต่งเพิ่ม");
}

/**
 * Returns a compact digest, or "" on any failure (caller falls back to a
 * truncated slice of the raw content). Never throws.
 */
export async function digestWiDocument(jobName: string, rawText: string): Promise<string> {
  if (!OPENAI_API_KEY || !rawText.trim()) return "";

  const text = rawText.slice(0, INPUT_CAP);
  const userPrompt = `ต่อไปนี้คือข้อความที่แปลงจากไฟล์ WI (Work Instruction) ของงานพิมพ์ ชื่อไฟล์: ${jobName}
ข้อความอาจมีช่องว่างหรือวรรณยุกต์เพี้ยนบ้างเพราะแปลงจาก PDF ให้พยายามตีความให้ถูก:

${text}

สกัด "เฉพาะข้อมูลสำคัญ" ออกมาเป็นสรุปสั้นกระชับภาษาไทย ตามรูปแบบนี้เป๊ะ (บรรทัดไหนไม่มีข้อมูลให้ใส่ "-"):
Job ID:
ชื่องาน (Title):
ลูกค้า (Customer):
AE:
จำนวน (Quantity):
วันที่ OK / วันส่ง:
สเปคสำคัญ: (ขนาด, กระดาษ, การพิมพ์/เคลือบ เช่น Spot UV, OPP, Matt waterbase ฯลฯ แบบสั้น)
CAR / ปัญหาที่เคยเกิด: (สรุปหัวข้อปัญหาสำคัญ 3-6 ข้อแบบสั้นๆ คั่นด้วย "; " ถ้าไม่มีตาราง CAR ให้ใส่ "ไม่มี")

ตอบเฉพาะสรุป ไม่ต้องเกริ่นนำ ไม่ใช้ markdown ไม่ใส่ ** หรือหัวข้อใหญ่`;

  return callDigest(
    userPrompt,
    "คุณเป็นผู้ช่วยสกัดข้อมูลสำคัญจากเอกสาร WI งานพิมพ์ ตอบกระชับ ตรงประเด็น เป็นภาษาไทย ใช้ข้อมูลจากเอกสารเท่านั้น ห้ามแต่งเพิ่ม",
  );
}

/** Shared chat-completions call for both digest flavors. Never throws. */
async function callDigest(userPrompt: string, systemPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DIGEST_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[digest-err]", res.status, await res.text().catch(() => ""));
      return "";
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("[digest-err]", err);
    return "";
  } finally {
    clearTimeout(timer);
  }
}
