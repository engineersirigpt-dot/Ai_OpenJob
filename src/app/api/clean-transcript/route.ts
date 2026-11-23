import { NextRequest, NextResponse } from "next/server";
import { STT_PROMPT } from "@/lib/stt-prompt";
import { normalizeDomainTerms } from "@/lib/domain-dictionary";
import {
  stripPromptEcho,
  isHallucinatedLoop,
  isForeignHallucination,
  keepThaiOnly,
  collapseRepeats,
  dropFillers,
} from "@/lib/thai-text";

export const runtime = "nodejs";

const THAI_ONLY = (process.env.STT_THAI_ONLY || "true") !== "false";
const DICTIONARY_ENABLED = (process.env.STT_DICTIONARY_ENABLED || "true") !== "false";

/**
 * POST /api/clean-transcript   { text }  →  { text, contextText, dropped? }
 *
 * The streamed live transcript arrives in the browser as finished segments
 * from the Realtime socket, not through /api/transcribe, so it would miss
 * the cleanup every slice gets there: the prompt read back is cut, a loop
 * or a foreign-language hallucination is dropped, and the dictionary spells
 * the print terms for the AI. The dictionary reads its extra rules from a
 * file on the server, so this runs here and the browser asks for it — one
 * small local round trip per segment, and one copy of the rules.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const raw = typeof body.text === "string" ? body.text.normalize("NFC").trim() : "";
  if (!raw) return NextResponse.json({ text: "", contextText: "", dropped: "ว่าง" });

  const echoFree = stripPromptEcho(raw, STT_PROMPT).replace(/\s+/g, " ").trim();
  if (!echoFree) return NextResponse.json({ text: "", contextText: "", dropped: "โมเดลตอบเป็นคำใบ้ ไม่ใช่คำพูด" });
  const text = dropFillers(echoFree);
  if (!text) return NextResponse.json({ text: "", contextText: "", dropped: "มีแต่คำรับ (ครับ/ค่ะ/อืม)" });
  if (isHallucinatedLoop(text)) return NextResponse.json({ text: "", contextText: "", dropped: "คำซ้ำวนลูป" });
  if (THAI_ONLY && isForeignHallucination(text)) {
    return NextResponse.json({ text: "", contextText: "", dropped: "ภาษาอื่น" });
  }
  const normalized = DICTIONARY_ENABLED ? normalizeDomainTerms(text).text : text;
  const contextText = collapseRepeats(THAI_ONLY ? keepThaiOnly(normalized) : normalized).trim() || text;
  return NextResponse.json({ text, contextText });
}
