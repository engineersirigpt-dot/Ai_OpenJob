import { NextRequest, NextResponse } from "next/server";
import { reconcileTranscript } from "@/lib/reconcile-transcript";

export const runtime = "nodejs";
export const maxDuration = 300; // a long meeting is several windows

/**
 * POST /api/reconcile-transcript
 *
 * Takes the meeting's two transcripts — the one made from the recording and
 * the one made live — and returns the recording's text with the live pass's
 * corrections applied. See lib/reconcile-transcript.ts for the rules.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { base?: string; live?: string; exclude?: string[]; context?: string }
    | null;
  const base = (body?.base || "").trim();
  const live = (body?.live || "").trim();
  // Lines already kept as their own turns: พรชัย's answers, spoken questions.
  const exclude = Array.isArray(body?.exclude)
    ? body.exclude.filter((l) => typeof l === "string" && l.trim()).map((l) => l.trim())
    : [];
  // The meeting's subject, so off-topic audio can be judged against it.
  const context = typeof body?.context === "string" ? body.context.slice(0, 300) : "";

  if (!base && !live) {
    return NextResponse.json({ error: "ไม่มีบทสนทนาให้ตรวจทาน" }, { status: 400 });
  }

  const t0 = Date.now();
  const result = await reconcileTranscript(base, live, exclude, context);
  console.log(
    `[reconcile] base=${base.length} live=${live.length} ตัดออก=${exclude.length} ` +
      `→ ${result.text.length} ตัวอักษร ` +
      `(${result.windows} ช่วง, แก้ ${result.corrected}, ตีกลับ ${result.rejected}) ${Date.now() - t0}ms`,
  );

  return NextResponse.json(result);
}
