/**
 * พรชัย long-term memory — local SQLite (data/pornchai-memory is a table in
 * meetings.db's directory; its own DB file keeps concerns separate). After each
 * พรชัย meeting we extract facts worth remembering (about เฮีย, the company,
 * preferences, ongoing topics) and inject them into the next session's system
 * prompt — the same idea as ChatGPT's Memory, but on our own server.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { TranscriptTurn } from "@/lib/meeting-history";
import { embed, cosine } from "@/lib/embeddings";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "pornchai-memory.db");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Memory extraction quality matters (a wrongly-extracted "fact" persists) —
// use a gpt-5 mini with a gpt-4o-mini fallback.
const MEMORY_MODEL = process.env.MEMORY_MODEL || "gpt-5.4-mini";
const MEMORY_FALLBACK = "gpt-4o-mini";

export interface MemoryEntry {
  id: string;
  text: string;
  source: string;
  /** The folder this memory lives in. Empty means it has not been filed yet. */
  topic: string;
  createdAt: string;
}

/** The name shown for memories that have no topic yet. */
export const UNFILED = "ยังไม่จัดหมวด";

let _db: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      source     TEXT,
      created_at TEXT NOT NULL
    );
  `);
  // Migration: embeddings for RAG-style memory search (backfilled lazily).
  try {
    _db.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT`);
  } catch {
    /* column already exists */
  }
  // Migration: the folder a memory is filed under. Existing memories keep an
  // empty topic and show up as unfiled until they are organized.
  try {
    _db.exec(`ALTER TABLE memories ADD COLUMN topic TEXT`);
  } catch {
    /* column already exists */
  }
  return _db;
}

export function listMemories(): MemoryEntry[] {
  const rows = db()
    .prepare(`SELECT * FROM memories ORDER BY created_at ASC`)
    .all() as unknown as Array<{
    id: string;
    text: string;
    source: string | null;
    topic: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    source: r.source || "",
    topic: (r.topic || "").trim(),
    createdAt: r.created_at,
  }));
}

/** The folders, with how many memories are in each. Largest first. */
export function listTopics(): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of listMemories()) {
    const key = m.topic || UNFILED;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => (b.count - a.count) || a.topic.localeCompare(b.topic, "th"));
}

/** Forget several memories at once. Returns how many were removed. */
export function deleteMemories(ids: string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db().prepare(`DELETE FROM memories WHERE id = ?`);
  let gone = 0;
  for (const id of ids) gone += Number(stmt.run(id).changes) > 0 ? 1 : 0;
  return gone;
}

/** Move memories into a folder (an empty topic puts them back as unfiled). */
export function setTopic(ids: string[], topic: string): number {
  if (ids.length === 0) return 0;
  const clean = topic.trim() === UNFILED ? "" : topic.trim().slice(0, 60);
  const stmt = db().prepare(`UPDATE memories SET topic = ? WHERE id = ?`);
  let moved = 0;
  for (const id of ids) moved += Number(stmt.run(clean, id).changes) > 0 ? 1 : 0;
  return moved;
}

/** Rename a folder, carrying every memory in it across. */
export function renameTopic(from: string, to: string): number {
  const ids = listMemories()
    .filter((m) => (m.topic || UNFILED) === from)
    .map((m) => m.id);
  return setTopic(ids, to);
}

/** Add memories, skipping exact-duplicate texts. Returns how many were added. */
export function addMemories(texts: string[], source: string): number {
  const existing = new Set(listMemories().map((m) => m.text.trim()));
  let added = 0;
  const stmt = db().prepare(`INSERT INTO memories (id, text, source, created_at) VALUES (?, ?, ?, ?)`);
  for (const raw of texts) {
    const text = raw.trim();
    if (!text || existing.has(text)) continue;
    stmt.run(randomUUID(), text, source, new Date().toISOString());
    existing.add(text);
    added++;
  }
  return added;
}

export function deleteMemory(id: string): boolean {
  const res = db().prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

export interface MemoryHit {
  text: string;
  source: string;
  score: number;
}

/**
 * RAG-style search over memories: embed the query, cosine-rank all memories.
 * Rows without an embedding are backfilled first (best-effort, batched) so
 * old memories become searchable the first time anyone asks.
 */
export async function searchMemories(query: string, k = 4): Promise<MemoryHit[]> {
  if (!query.trim()) return [];
  const d = db();

  // Lazy backfill for rows that don't have an embedding yet.
  try {
    const missing = d
      .prepare(`SELECT id, text FROM memories WHERE embedding IS NULL LIMIT 256`)
      .all() as unknown as Array<{ id: string; text: string }>;
    if (missing.length > 0) {
      const vecs = await embed(missing.map((m) => m.text));
      const upd = d.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`);
      missing.forEach((m, i) => {
        if (vecs[i]) upd.run(JSON.stringify(vecs[i]), m.id);
      });
      console.log(`[pornchai-memory] embedded ${missing.length} memory rows`);
    }
  } catch (err) {
    console.error("[pornchai-memory] embed backfill failed:", err);
  }

  const rows = d
    .prepare(`SELECT text, source, embedding FROM memories WHERE embedding IS NOT NULL`)
    .all() as unknown as Array<{ text: string; source: string | null; embedding: string }>;
  if (rows.length === 0) return [];

  const [qVec] = await embed([query]);
  if (!qVec) return [];

  const scored = rows.map((r) => {
    let vec: number[] = [];
    try {
      vec = JSON.parse(r.embedding);
    } catch {
      /* skip */
    }
    return {
      text: r.text,
      source: r.source ? `ความจำ (${r.source})` : "ความจำ",
      score: vec.length ? cosine(qVec, vec) : -1,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  // Floor is HIGHER than the chat RAG's 0.3: short memory sentences score a
  // higher cosine baseline than 900-char chunks, so 0.3 lets unrelated
  // memories leak into unrelated questions (seen with a weather question).
  return scored.slice(0, k).filter((h) => h.score > 0.35);
}

/** Memories as a prompt block (oldest→newest, capped). "" if none. */
export function memoryPromptBlock(maxChars = 4000): string {
  const all = listMemories();
  if (all.length === 0) return "";
  // keep the newest facts if we exceed the budget
  const lines: string[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const line = `- ${all[i].text}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Extract facts worth remembering from a finished พรชัย meeting. Best-effort:
 * returns [] on any failure. Only explicitly-stated facts, never guesses.
 */
export async function extractMemories(
  turns: TranscriptTurn[],
  meetingTitle: string,
): Promise<string[]> {
  if (!OPENAI_API_KEY || turns.length === 0) return [];

  const convo = turns
    .map((t) => `${t.speaker === "assistant" ? "พรชัย" : t.label || "เฮีย/ที่ประชุม"}: ${t.text}`)
    .join("\n")
    .slice(0, 24000);

  const userPrompt = `ต่อไปนี้คือบทสนทนาระหว่าง "พรชัย" (ผู้ช่วย AI) กับ "เฮีย" (ผู้ใช้/เจ้าของบริษัท) ในการประชุม${meetingTitle ? ` เรื่อง "${meetingTitle}"` : ""}:

${convo}

สกัด "ข้อเท็จจริงที่ควรจดจำระยะยาว" สำหรับให้พรชัยจำไว้ใช้ในการคุยครั้งต่อๆ ไป เช่น:
- ข้อมูลเกี่ยวกับเฮีย/บริษัท (ชื่อคน บทบาท สิ่งที่กำลังทำ)
- ความชอบ/สไตล์ที่เฮียบอก (เช่น ชอบคำตอบสั้น, ให้เรียกอะไร)
- โปรเจค/เรื่องที่กำลังดำเนินอยู่ ที่น่าจะถูกพูดถึงอีก
- สิ่งที่เฮียสั่งตรงๆ ว่า "จำไว้"

กติกา:
- เอาเฉพาะสิ่งที่ถูกพูดไว้จริงในบทสนทนา ห้ามเดา ห้ามแต่งเพิ่ม
- ข้อละ 1 ประโยคสั้นๆ ภาษาไทย
- ไม่เอาเรื่องจิปาถะ/ทักทาย/สิ่งที่ใช้ครั้งเดียวจบ
- ถ้าไม่มีอะไรควรจำเลย ให้ตอบ []

ตอบเป็น JSON array ของ string เท่านั้น เช่น ["...","..."] ห้ามมีข้อความอื่น`;

  const messages = [
    { role: "system", content: "คุณสกัดข้อเท็จจริงที่ควรจดจำจากบทสนทนา ตอบเป็น JSON array ของ string เท่านั้น" },
    { role: "user", content: userPrompt },
  ];
  const models = [MEMORY_MODEL, MEMORY_FALLBACK].filter((m, i, a) => a.indexOf(m) === i);
  for (const model of models) {
    // gpt-5.x rejects custom temperature — use low reasoning effort instead.
    const body: Record<string, unknown> = { model, messages };
    if (/^gpt-5/.test(model)) body.reasoning_effort = "low";
    else body.temperature = 0.1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error("[memory-extract-err]", model, res.status, await res.text().catch(() => ""));
        continue;
      }
      const data = await res.json();
      const raw: string = data?.choices?.[0]?.message?.content?.trim() || "[]";
      const jsonText = raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
      const parsed = JSON.parse(jsonText);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.trim()).slice(0, 10) : [];
    } catch (err) {
      console.error("[memory-extract-err]", model, err);
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

/**
 * Files memories into folders with the model's help.
 *
 * Folders are only useful if the same kind of fact always lands in the same
 * one, so the model is shown the folders that already exist and told to reuse
 * them wherever one fits — left to itself it invents a new near-synonym for
 * every memory ("ความชอบของเฮีย" next to "สไตล์ที่เฮียชอบ") and the bank ends
 * up with one folder per fact.
 *
 * Only the memories passed in are touched, and a memory the model does not
 * answer for keeps the folder it already had.
 */
export async function organizeMemories(
  ids?: string[],
): Promise<{ filed: number; topics: string[] }> {
  const all = listMemories();
  const targets = ids?.length ? all.filter((m) => ids.includes(m.id)) : all.filter((m) => !m.topic);
  if (targets.length === 0 || !OPENAI_API_KEY) return { filed: 0, topics: [] };

  const existing = [...new Set(all.map((m) => m.topic).filter(Boolean))];
  const list = targets.map((m, i) => `${i + 1}. ${m.text}`).join("\n");

  const userPrompt = `ต่อไปนี้คือ "ความจำ" ของผู้ช่วย AI ชื่อพรชัย ที่ใช้ในโรงพิมพ์ศิริวัฒนา แต่ละข้อคือข้อเท็จจริงหนึ่งเรื่อง

${list}

${
  existing.length
    ? `หมวดที่มีอยู่แล้ว (ให้ใช้ซ้ำถ้าเข้ากันได้):\n${existing.map((t) => `- ${t}`).join("\n")}\n`
    : ""
}จัดแต่ละข้อลงหมวด โดย
- ใช้หมวดที่มีอยู่แล้วก่อน ถ้าไม่มีหมวดไหนเข้ากันจริงๆ จึงตั้งหมวดใหม่
- ชื่อหมวดเป็นภาษาไทย สั้น 2-5 คำ เป็นคำนาม เช่น "ข้อมูลบริษัท" "คนและหน้าที่" "ความชอบของเฮีย" "งาน CAR" "เครื่องจักรและการผลิต" "ระบบและโปรแกรม"
- หมวดทั้งหมดรวมกันไม่ควรเกิน 8 หมวด ถ้าเกินให้รวมหมวดที่ใกล้กันเข้าด้วยกัน
- ห้ามแก้ข้อความของความจำ ห้ามรวมหรือตัดข้อ

ตอบเป็น JSON array เท่านั้น ยาวเท่าจำนวนข้อที่ให้มา (${targets.length} ข้อ) เรียงตามลำดับเดิม แต่ละตัวเป็นชื่อหมวดของข้อนั้น
ตัวอย่าง: ["ข้อมูลบริษัท","ความชอบของเฮีย","งาน CAR"]`;

  const messages = [
    {
      role: "system",
      content: "คุณจัดหมวดหมู่ข้อมูล ตอบเป็น JSON array ของ string เท่านั้น ไม่มีคำอธิบาย",
    },
    { role: "user", content: userPrompt },
  ];

  for (const model of [MEMORY_MODEL, MEMORY_FALLBACK].filter((m, i, a) => a.indexOf(m) === i)) {
    const body: Record<string, unknown> = { model, messages };
    if (/^gpt-5/.test(model)) body.reasoning_effort = "low";
    else body.temperature = 0.1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error("[memory-organize-err]", model, res.status, await res.text().catch(() => ""));
        continue;
      }
      const data = await res.json();
      const raw: string = data?.choices?.[0]?.message?.content?.trim() || "[]";
      const parsed = JSON.parse(
        raw.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim(),
      );
      if (!Array.isArray(parsed)) continue;

      let filed = 0;
      const used = new Set<string>();
      for (let i = 0; i < targets.length; i++) {
        const topic = typeof parsed[i] === "string" ? parsed[i].trim().slice(0, 60) : "";
        if (!topic) continue;
        setTopic([targets[i].id], topic);
        used.add(topic);
        filed++;
      }
      console.log(`[memory-organize] จัดได้ ${filed}/${targets.length} ข้อ ใน ${used.size} หมวด`);
      return { filed, topics: [...used] };
    } catch (err) {
      console.error("[memory-organize-err]", model, err);
    } finally {
      clearTimeout(timer);
    }
  }
  return { filed: 0, topics: [] };
}
