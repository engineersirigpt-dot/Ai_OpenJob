import { NextRequest, NextResponse } from "next/server";
import { ingestChatFiles, searchRag, ragStats } from "@/lib/pornchai-rag";
import { searchMemories } from "@/lib/pornchai-memory";

export const runtime = "nodejs";
export const maxDuration = 300; // ingesting many chats can take a while

// GET /api/pornchai-rag            → index stats
// GET /api/pornchai-rag?q=คำค้น    → top matches from past chats AND memories
export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q");
    if (q) {
      const [chats, memories] = await Promise.all([
        searchRag(q, 4),
        searchMemories(q, 4).catch((err) => {
          console.error("[memory-search-err]", err);
          return [];
        }),
      ]);
      const combined = [...chats, ...memories].sort((a, b) => b.score - a.score).slice(0, 6);
      return NextResponse.json(combined);
    }
    return NextResponse.json(ragStats());
  } catch (error) {
    console.error("[rag-err]", error);
    return NextResponse.json({ error: "ค้นหาไม่สำเร็จ" }, { status: 500 });
  }
}

// POST /api/pornchai-rag — ingest all new files in data/pornchai-chats/.
// Optional body { name, text }: save that chat as a new file first (used by
// the memory tab to add a pasted chat / a fetched share link permanently).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (text) {
      const fs = await import("fs");
      const path = await import("path");
      const safe = (name || "chat").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60) || "chat";
      const dir = path.join(process.cwd(), "data", "pornchai-chats");
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, `${safe}.txt`);
      // same name but different content → keep both, don't overwrite history
      if (fs.existsSync(file) && fs.readFileSync(file, "utf-8") !== text) {
        file = path.join(dir, `${safe}-${Date.now()}.txt`);
      }
      fs.writeFileSync(file, text, "utf-8");
    }
    const result = await ingestChatFiles();
    return NextResponse.json({ ...result, stats: ragStats() });
  } catch (error) {
    console.error("[rag-ingest-err]", error);
    return NextResponse.json({ error: (error as Error).message || "ingest ล้มเหลว" }, { status: 500 });
  }
}
