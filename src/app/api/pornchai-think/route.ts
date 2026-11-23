import { NextRequest, NextResponse } from "next/server";
import { getDocument } from "@/lib/document-store";
import { memoryPromptBlock, searchMemories } from "@/lib/pornchai-memory";
import { searchRag } from "@/lib/pornchai-rag";

/**
 * พรชัย's "thinking brain" (two-tier architecture).
 *
 * The realtime voice model is great at natural speech but shallow at
 * reasoning. So every commanded พรชัย speech (question / free-talk) is first
 * answered HERE by a top text model — with the full documents, long-term
 * memory, and RAG context — and the realtime model then just reads the
 * answer aloud in พรชัย's voice.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Try the configured model first, then fall back down the family. The first
// model that answers gets cached for the rest of the process lifetime.
const MODEL_CHAIN = [
  process.env.THINK_MODEL || "gpt-5.5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-4o",
].filter((m, i, a) => a.indexOf(m) === i);
const THINK_EFFORT = process.env.THINK_EFFORT || "low"; // reasoning effort for gpt-5.x
// Verbosity is the real latency lever: benchmarked on the same question,
// "low" cut the answer from ~1600 to ~900 tokens (31s → 20s) with the same
// analytical structure. Spoken answers shouldn't be essays anyway.
const THINK_VERBOSITY = process.env.THINK_VERBOSITY || "low";

let workingModel: string | null = null;

type ThinkMode = "default" | "pornchai" | "car";

/** What this meeting is about — the only part of the persona that varies. */
function modeBrief(mode: ThinkMode): string {
  if (mode === "default") {
    return `โหมดประชุมนี้: "ประชุมงาน OK" — ตรวจความพร้อมงานพิมพ์ก่อนผลิต เอกสารคือ WI (ใบสั่งงาน) และตาราง CAR ประวัติปัญหาของลูกค้า ที่ดึงจากระบบ REPORT2 ตามเลขที่งาน (Job ID)
โฟกัส: สเปคงาน จำนวน กำหนดส่ง ลูกค้า AE ขั้นตอนผลิต และเตือนปัญหาที่เคยเกิดกับลูกค้ารายนี้เพื่อไม่ให้เกิดซ้ำ อ้างข้อมูลงานให้ระบุ Job ID และอ่านค่าจากเอกสารตรงๆ ทีละฟิลด์`;
  }
  if (mode === "car") {
    return `โหมดประชุมนี้: "สอบสวน CAR" (Corrective Action Request) — ประชุมสอบสวนงานเสีย/งานขาดยอด ตามตารางสอบสวน CAR (คอลัมน์: ลำดับ, เลขที่ CAR, ชื่องาน, เลขที่งาน, วันที่ออก CAR, รายละเอียดปัญหา, สถานะ, มูลค่า, ผู้ออก CAR, ฝ่ายที่ออก CAR, หน่วยที่ได้รับ CAR, ผู้ตอบ CAR, ผลการตอบ, หมายเหตุ)
บทบาทของพรชัย: ผู้ช่วยกรรมการสอบสวน — ตรวจว่าคำชี้แจงครบพอปิดเคสหรือยัง โดยดู 5 ประเด็น (1) สาเหตุรากจริงไม่ใช่อาการ (2) ขอบเขตความเสียหาย จำนวน/มูลค่า (3) การแก้ไขเฉพาะหน้า (4) การป้องกันไม่ให้เกิดซ้ำ ใครทำ เมื่อไหร่ (5) หลักฐาน/ตัวชี้วัดยืนยันว่าแก้ได้จริง
ถ้าขาดประเด็นไหนให้ตั้งคำถามเจาะต่อแบบกรรมการสอบ (ตรวจที่จุดไหน ใช้เครื่องมืออะไร ค่าเท่าไรถือว่าผ่าน ถ้าไม่ผ่านทำอย่างไร) ห้ามตัดสินแทนกรรมการว่ายอมรับ/ไม่ยอมรับ — เสนอได้แค่ว่าข้อมูลพอหรือยังและต้องขออะไรเพิ่ม พร้อมอ้างคำพูดจริงและข้อมูลในตารางเป็นหลักฐาน`;
  }
  return `โหมดประชุมนี้: "พรชัยผู้ช่วยประชุม" — ปรึกษาได้ทุกเรื่อง ไม่จำกัดว่าต้องเป็นงานพิมพ์ เอกสารมาจากการอัปโหลดเอง
โฟกัส: ช่วยคิด วิเคราะห์ เสนอทางเลือกพร้อมข้อดีข้อเสีย ชี้ความเสี่ยงที่อาจถูกมองข้าม และสรุปให้เฮียตัดสินใจได้`;
}

function personaPrompt(mode: ThinkMode): string {
  return `คุณคือ "พรชัย" — AI คู่คิดและที่ปรึกษาส่วนตัวของเฮีย (เจ้าของ/ผู้บริหารโรงพิมพ์ศิริวัฒนา) คนเดียวกับที่เฮียคุยด้วยใน ChatGPT มาตลอด

${modeBrief(mode)}

ตัวตนและสไตล์:
- เรียกผู้ฟังว่า "เฮีย" เรียกตัวเองว่า "พรชัย" ลงท้าย "ครับ" สุภาพ เป็นกันเอง มีเหตุผล
- เป็นทั้งผู้ช่วย อาจารย์ และเพื่อนร่วมทาง — ตอบได้ทุกเรื่อง: ธุรกิจ การเงิน การผลิต เทคโนโลยี AI การบริหารคน และความรู้ทั่วไป
- คิดแบบที่ปรึกษา: มองหลายมุม เสนอทางเลือกพร้อมข้อดีข้อเสีย ชี้ความเสี่ยงที่อาจถูกมองข้าม และปิดท้ายด้วยขั้นถัดไปที่ทำได้จริง
- กล้าเสนอกรอบคิดและตั้งคำถามชวนคิด แบบเดียวกับที่เคยคุยเรื่อง OTB, AI Operating System, Porchai Academy

กฎเหล็กข้อเท็จจริง:
- ห้ามแต่งข้อเท็จจริงเฉพาะ: Job ID, เลขที่งาน, ชื่อคน, ชื่อบริษัท, ราคา, จำนวน, วันที่, สเปค — ถ้าไม่อยู่ในเอกสาร/บทสนทนา/ความจำ ให้บอกตรงๆ ว่าไม่มีข้อมูล
- คำถามเกี่ยวกับเอกสารให้อ่านค่าตรงตามเอกสารทีละคอลัมน์ ห้ามเดา
- ความรู้ทั่วไปและการวิเคราะห์ตอบได้เต็มความสามารถ เพียงแยกให้ชัดว่าส่วนไหนคือข้อเท็จจริง ส่วนไหนคือความเห็นของพรชัย
- ข้อมูลอ้างอิง (ความจำ/แชทเก่า) ใช้เฉพาะส่วนที่เกี่ยวกับเรื่องที่ถามจริงๆ ไม่เกี่ยวให้เพิกเฉย ห้ามลากเรื่องเก่ามาโยง

รูปแบบคำตอบ (สำคัญมาก — คำตอบจะถูกอ่านออกเสียง):
- เขียนเป็นภาษาพูดธรรมชาติ ต่อเนื่องเป็นย่อหน้า ห้ามใช้ Markdown หัวข้อ ตัวเลขนำหน้า หรือ bullet ทุกชนิด
- ห้ามเกริ่นถ่วงเวลา ("ขอเวลาสักครู่" ฯลฯ) ขึ้นต้นด้วยเนื้อหาเลย ห้ามทวนคำถาม
- สั้นเข้าไว้: ตอบ 2-4 ประโยคเป็นหลัก ยาวสุดไม่เกิน 6 ประโยค ตอบเฉพาะสิ่งที่ถูกถาม ไม่ต้องเกริ่น ไม่ต้องสรุปซ้ำท้ายคำตอบ
- ขยายความยาวกว่านี้ได้เฉพาะเมื่อเฮียขอเอง เช่น บอกว่าให้วิเคราะห์ละเอียด หรือสั่งให้สรุปทั้งเรื่อง
- ภาษาไทยเป็นหลัก ศัพท์เทคนิคอังกฤษใช้ได้`;
}

interface ThinkBody {
  kind?: "question" | "freetalk" | "command";
  mode?: ThinkMode;
  question?: string;
  docIds?: string[];
  transcript?: string;
}

async function callModel(
  messages: Array<{ role: string; content: string }>,
  verbosity: string = THINK_VERBOSITY,
): Promise<{ answer: string; model: string }> {
  const chain = workingModel ? [workingModel, ...MODEL_CHAIN.filter((m) => m !== workingModel)] : MODEL_CHAIN;
  let lastErr = "";
  for (const model of chain) {
    const body: Record<string, unknown> = { model, messages };
    if (/^gpt-5/.test(model)) {
      body.reasoning_effort = THINK_EFFORT;
      body.verbosity = verbosity;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        lastErr = `${model}: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
        console.error("[think-err]", lastErr);
        continue; // try the next model down the chain
      }
      const data = await res.json();
      const answer = data?.choices?.[0]?.message?.content?.trim() || "";
      if (!answer) {
        lastErr = `${model}: empty answer`;
        continue;
      }
      workingModel = model;
      return { answer, model };
    } catch (err) {
      lastErr = `${model}: ${(err as Error).message}`;
      console.error("[think-err]", lastErr);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr || "no model answered");
}

export async function POST(req: NextRequest) {
  if (!OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY ไม่ได้ตั้งค่า" }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as ThinkBody;
  const kind =
    body.kind === "freetalk" ? "freetalk" : body.kind === "command" ? "command" : "question";
  const mode: ThinkMode =
    body.mode === "pornchai" ? "pornchai" : body.mode === "car" ? "car" : "default";
  const question = String(body.question || "").trim();
  const transcript = String(body.transcript || "").slice(-12000);
  const docIds = Array.isArray(body.docIds) ? body.docIds : [];

  if (kind !== "freetalk" && !question) {
    return NextResponse.json({ error: "ไม่มีคำถาม" }, { status: 400 });
  }

  // Assemble everything the brain should see.
  const ragQuery = question || transcript.slice(-1500);
  const [chatHits, memHits] = await Promise.all([
    searchRag(ragQuery, 4).catch(() => []),
    searchMemories(ragQuery, 4).catch(() => []),
  ]);
  const ragBlock = [...chatHits, ...memHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((h) => `[${h.source}]\n${h.text}`)
    .join("\n---\n")
    .slice(0, 8000);

  let docBlock = "";
  let total = 0;
  for (const id of docIds) {
    const d = getDocument(id);
    if (!d) continue;
    const chunk = d.content.slice(0, 15000);
    if (total + chunk.length > 45000) break;
    total += chunk.length;
    docBlock += `--- เอกสาร: ${d.name} ---\n${chunk}\n\n`;
  }

  const memory = (() => {
    try {
      return memoryPromptBlock();
    } catch {
      return "";
    }
  })();

  const parts: string[] = [];
  if (memory) parts.push(`ความทรงจำระยะยาวของพรชัย (เรื่องที่เคยคุยกับเฮีย):\n${memory}`);
  if (docBlock) parts.push(`เอกสารที่แนบในการประชุมนี้:\n${docBlock.trim()}`);
  if (ragBlock) parts.push(`ข้อมูลอ้างอิงที่ระบบค้นมาให้ (อาจเกี่ยวหรือไม่เกี่ยว — ใช้เฉพาะที่เกี่ยว):\n${ragBlock}`);
  if (transcript) parts.push(`บทสนทนาในที่ประชุมล่าสุด:\n${transcript}`);
  parts.push(
    kind === "command"
      ? `คำสั่งจากระบบ (ทำตามนี้ แล้วตอบเป็นคำพูดที่จะอ่านออกเสียงให้ที่ประชุมฟัง):
${question}`
      : kind === "question"
      ? `คำถามจากเฮีย: ${question}`
      : `เฮียกดปุ่ม "ให้พรชัยพูด" — ดูบทสนทนาช่วงท้ายสุดว่ากำลังคุยเรื่องอะไร แล้วพูดสิ่งที่เป็นประโยชน์กับเรื่องนั้น (ความเห็น ข้อเสนอแนะ ข้อสังเกต จุดเสี่ยง หรือสรุปประเด็นค้าง — เลือกที่เหมาะที่สุด) ถ้ายังไม่มีบทสนทนาเลย ให้ทักทายสั้นๆ 2-3 ประโยคแล้วถามว่าเฮียอยากคุยเรื่องอะไร ห้ามอ้างถึงเหตุการณ์ที่ไม่ได้เกิดขึ้น`,
  );

  try {
    const t0 = Date.now();
    const { answer, model } = await callModel(
      [
        { role: "system", content: personaPrompt(mode) },
        { role: "user", content: parts.join("\n\n========\n\n") },
      ],
      // A system command (CAR summary across several jobs, discussion comment)
      // needs room to cover every item; plain spoken answers stay short.
      kind === "command" ? "medium" : THINK_VERBOSITY,
    );
    console.log(
      `[think] model=${model} mode=${mode} kind=${kind} ${Date.now() - t0}ms q="${question.slice(0, 60)}"`,
    );
    return NextResponse.json({ answer, model });
  } catch (err) {
    console.error("[think-fail]", err);
    return NextResponse.json({ error: "สมองชั้นคิดตอบไม่สำเร็จ" }, { status: 502 });
  }
}
