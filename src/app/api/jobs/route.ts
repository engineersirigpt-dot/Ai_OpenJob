import { NextRequest, NextResponse } from "next/server";
import { fetchJobOkList } from "@/lib/report2";

export const maxDuration = 30;

/**
 * POST /api/jobs
 * Proxy the REPORT2 "รายการรอ OK งาน" list so the browser doesn't hit the
 * legacy server directly (avoids CORS / mixed-content).
 *
 * Body: { jobId?: string, dateStart?: "YYYY-MM-DD", dateEnd?: "YYYY-MM-DD" }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jobs = await fetchJobOkList({
      jobId: body.jobId,
      dateStart: body.dateStart,
      dateEnd: body.dateEnd,
    });
    return NextResponse.json(
      jobs.map((j) => ({
        jobid: j.jobid,
        jobName: j.job_name,
        ae: j.emp_name,
        team: j.team_name,
        okDate: j.okdate,
        deliveryDate: j.delivery_date,
        // Already discussed in an earlier session (the "Confirm" column in
        // REPORT2) — used to hide morning jobs from the afternoon meeting.
        confirmed: Number(j.is_confirm) === 1,
        attendees: Number(j.count_emp_meeting) || 0,
      })),
    );
  } catch (error) {
    console.error("[jobs-err]", error);
    return NextResponse.json(
      { error: "ไม่สามารถดึงรายการงานจากระบบ REPORT2 ได้" },
      { status: 502 },
    );
  }
}
