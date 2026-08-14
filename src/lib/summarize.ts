import type { TranscriptTurn } from "@/lib/meeting-history";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUMMARY_MODEL = process.env.SCORING_MODEL || "gpt-4o-mini";

/**
 * Summarize a finished meeting in Thai. Best-effort: returns "" if there's no
 * API key, no content, or the request fails — summarization must never block
 * saving the meeting record.
 */
export async function summarizeMeeting(
  turns: TranscriptTurn[],
  meetingTitle: string,
  jobNames: string[],
): Promise<string> {
  if (!OPENAI_API_KEY || turns.length === 0) return "";

  const convo = turns
    .map((t) => `${t.speaker === "assistant" ? "AI" : "ผู้ประชุม"}: ${t.text}`)
    .join("\n");

  const context = [
    meetingTitle ? `หัวข้อ: ${meetingTitle}` : "",
    jobNames.length ? `งานที่เกี่ยวข้อง: ${jobNames.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = `${context ? context + "\n\n" : ""}ต่อไปนี้คือบทสนทนาการประชุม:\n\n${convo}\n\nเขียน "รายงานสรุปการประชุม" เป็นภาษาไทย อ่านแล้วเข้าใจง่าย เป็นทางการพอประมาณ จัดเป็นหัวข้อตามนี้เป๊ะ (ใช้เลขข้อและขึ้นต้นบรรทัดย่อยด้วย "- "):\n\n1. ประเด็นที่หารือ\n- (สรุปแต่ละประเด็นเป็นข้อ ๆ)\n\n2. ข้อสรุป / มติที่ประชุม\n- (สิ่งที่ตกลง/ตัดสินใจ ถ้าไม่มีให้เขียน "ไม่มีข้อสรุปชัดเจน")\n\n3. สิ่งที่ต้องดำเนินการต่อ (Action Items)\n- (งานที่ต้องทำ / ใครรับผิดชอบ / กำหนดเมื่อไหร่ ถ้ามี)\n\nกระชับ ชัดเจน คงคำศัพท์เทคนิคภาษาอังกฤษไว้ตามเดิม หัวข้อไหนข้อมูลไม่พอให้ระบุว่า "ไม่มีข้อมูล" อย่าใส่เครื่องหมาย ** หรือ markdown อื่น`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          {
            role: "system",
            content: "คุณเป็นผู้ช่วยสรุปการประชุมที่กระชับ ตรงประเด็น เป็นภาษาไทย",
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[summarize-err]", res.status, await res.text().catch(() => ""));
      return "";
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("[summarize-err]", err);
    return "";
  } finally {
    clearTimeout(timer);
  }
}
