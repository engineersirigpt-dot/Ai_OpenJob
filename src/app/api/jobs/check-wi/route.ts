import { NextRequest, NextResponse } from "next/server";
import { wiExists, JOB_ID_RE } from "@/lib/report2";

export const maxDuration = 30;

/**
 * POST /api/jobs/check-wi
 * Body: { jobIds: string[] }
 * Returns { status: { [jobId]: boolean } } — true if the job has a WI PDF.
 *
 * Lets the UI flag "no document" jobs before anyone tries to pull them.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jobIds = (Array.isArray(body.jobIds) ? body.jobIds : [])
      .map((j: unknown) => String(j || "").trim().toUpperCase())
      .filter((j: string) => JOB_ID_RE.test(j))
      .slice(0, 100);

    const pairs = await Promise.all(
      jobIds.map(async (id: string) => [id, await wiExists(id)] as const),
    );
    return NextResponse.json({ status: Object.fromEntries(pairs) });
  } catch (error) {
    console.error("[check-wi-err]", error);
    return NextResponse.json({ status: {} }, { status: 502 });
  }
}
