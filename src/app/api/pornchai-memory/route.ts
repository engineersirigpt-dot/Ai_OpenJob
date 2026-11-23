import { NextRequest, NextResponse } from "next/server";
import {
  listMemories,
  listTopics,
  addMemories,
  deleteMemory,
  deleteMemories,
  setTopic,
  renameTopic,
  organizeMemories,
} from "@/lib/pornchai-memory";

export const runtime = "nodejs";
export const maxDuration = 120; // filing the whole bank is one model call

// GET /api/pornchai-memory — everything พรชัย remembers, and the folders
export async function GET() {
  try {
    return NextResponse.json({ memories: listMemories(), topics: listTopics() });
  } catch (error) {
    console.error("[pornchai-memory-err]", error);
    return NextResponse.json({ error: "อ่านความทรงจำไม่ได้" }, { status: 500 });
  }
}

/**
 * POST /api/pornchai-memory
 *
 *   { text, topic? }                 add one memory
 *   { action: "organize", ids? }     let the model file memories into folders
 *   { action: "move", ids, topic }   move memories into a folder
 *   { action: "rename", from, to }   rename a folder
 *   { action: "delete", ids }        forget several at once
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((i: unknown) => typeof i === "string" && i)
    : [];

  try {
    if (action === "organize") {
      const result = await organizeMemories(ids.length ? ids : undefined);
      return NextResponse.json({ ok: true, ...result, topics: listTopics() });
    }

    if (action === "move") {
      if (ids.length === 0) return NextResponse.json({ error: "ไม่ได้เลือกความจำ" }, { status: 400 });
      return NextResponse.json({ ok: true, moved: setTopic(ids, String(body.topic || "")) });
    }

    if (action === "rename") {
      const from = String(body.from || "").trim();
      const to = String(body.to || "").trim();
      if (!from || !to) return NextResponse.json({ error: "ต้องระบุชื่อหมวด" }, { status: 400 });
      return NextResponse.json({ ok: true, moved: renameTopic(from, to) });
    }

    if (action === "delete") {
      if (ids.length === 0) return NextResponse.json({ error: "ไม่ได้เลือกความจำ" }, { status: 400 });
      return NextResponse.json({ ok: true, deleted: deleteMemories(ids) });
    }

    const text = String(body.text || "").trim();
    if (!text) return NextResponse.json({ error: "ไม่มีข้อความ" }, { status: 400 });
    const added = addMemories([text], "เพิ่มเอง");
    const topic = String(body.topic || "").trim();
    if (added > 0 && topic) {
      // The new memory is the newest one with this text.
      const fresh = listMemories().filter((m) => m.text === text).pop();
      if (fresh) setTopic([fresh.id], topic);
    }
    return NextResponse.json({ ok: true, added });
  } catch (error) {
    console.error("[pornchai-memory-err]", error);
    return NextResponse.json({ error: (error as Error).message || "ทำรายการไม่สำเร็จ" }, { status: 500 });
  }
}

// DELETE /api/pornchai-memory?id=... — forget one memory
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "ต้องระบุ id" }, { status: 400 });
  return NextResponse.json({ ok: deleteMemory(id) });
}
