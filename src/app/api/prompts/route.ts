import { NextRequest, NextResponse } from "next/server";
import { buildMeetingInstructions, type AssistantMode } from "@/lib/prompts";

export const runtime = "nodejs";

/**
 * GET /api/prompts?mode=default|pornchai|car
 *
 * Returns the exact system prompt a meeting of that mode starts with, as plain
 * text — the same string the realtime session receives. Useful for reviewing
 * what พรชัย was told, or for reusing the persona somewhere else.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("mode") || "default";
  const mode: AssistantMode = raw === "pornchai" ? "pornchai" : raw === "car" ? "car" : "default";
  const text = buildMeetingInstructions({
    meetingTitle: "(หัวข้อการประชุม)",
    documents: [],
    participants: [],
    mode,
    memory: "(ความทรงจำของพรชัยจะถูกใส่ตรงนี้ตอนเปิดประชุมจริง)",
  });
  return new NextResponse(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
