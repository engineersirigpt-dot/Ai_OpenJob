import { NextRequest, NextResponse } from "next/server";
import { prepullTodayOkJobs, type Session } from "@/lib/ok-prepull";

export const runtime = "nodejs";
export const maxDuration = 300; // sixteen WI pulls with digests

/**
 * POST /api/jobs/prepull   { session?: "am" | "pm" }
 *
 * Pull today's unconfirmed OK jobs into the document store now — what the
 * scheduler does at its set times, on demand: the documents page calls it
 * when it opens on a meeting day and finds nothing attached (a server that
 * restarted after the scheduled time, or a meeting called at another
 * hour). Returns what was pulled, what was already there, and what has no
 * WI.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { session?: unknown };
  const session: Session | undefined = body.session === "am" || body.session === "pm" ? body.session : undefined;
  try {
    const result = await prepullTodayOkJobs(session);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[prepull]", (err as Error).message);
    return NextResponse.json({ error: "ดึงรายการงาน OK ไม่ได้" }, { status: 502 });
  }
}
