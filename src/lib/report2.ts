/**
 * Integration with the internal REPORT2 system (192.168.5.40).
 *
 * - Job list: POST controllers/controller.php (post_type=get_list_job_ok_date)
 * - Meeting document per job = the "WI" PDF, stored at
 *     /linsip/wi/20{YY}/{JobID}.pdf  (year folder; falls back to /linsip/wi/{JobID}.pdf)
 *   where {YY} is characters 3-4 of the Job ID (e.g. J52600095 -> "26" -> 2026).
 *   This mirrors view_wi() in report_ok_date.js.
 */

const BASE = (process.env.REPORT2_BASE_URL || "http://192.168.5.40").replace(/\/+$/, "");
const FETCH_TIMEOUT_MS = 20_000;

/** Job IDs look like "J22600086" — one letter + 8 digits. */
export const JOB_ID_RE = /^[A-Za-z]\d{8}$/;

export interface JobOkItem {
  jobid: string;
  job_name: string;
  emp_id: string;
  emp_name: string; // AE
  okdate: string;
  detail: string;
  delivery_date: string;
  team_name: string;
  is_confirm: number;
  count_emp_meeting: number;
  booking_count: number;
}

/** YYYY-MM-DD -> DD/MM/YYYY (the format the legacy controller expects). */
function toThaiSlash(d: string): string {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJobOkList(params: {
  jobId?: string;
  dateStart?: string; // YYYY-MM-DD
  dateEnd?: string; // YYYY-MM-DD
}): Promise<JobOkItem[]> {
  const body = new URLSearchParams({
    post_type: "get_list_job_ok_date",
    jobid: (params.jobId || "").trim(),
    date_start: toThaiSlash(params.dateStart || ""),
    date_end: toThaiSlash(params.dateEnd || ""),
  });

  const res = await withTimeout((signal) =>
    fetch(`${BASE}/REPORT2/controllers/controller.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    }),
  );

  if (!res.ok) {
    throw new Error(`REPORT2 list error ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as JobOkItem[]) : [];
}

/** Candidate URLs for a job's WI PDF, year-folder first (same order as view_wi). */
export function wiPdfUrls(jobId: string): string[] {
  const j = jobId.trim();
  const yy = j.substring(2, 4);
  return [`${BASE}/linsip/wi/20${yy}/${j}.pdf`, `${BASE}/linsip/wi/${j}.pdf`];
}

/** Lightweight check: does a job have a WI PDF? Uses HEAD (falls back to a
 *  1-byte GET) so we can flag "no document" jobs without downloading them. */
export async function wiExists(jobId: string): Promise<boolean> {
  for (const url of wiPdfUrls(jobId)) {
    try {
      let res = await withTimeout((signal) => fetch(url, { method: "HEAD", signal }));
      // Some servers don't allow HEAD — retry with a tiny ranged GET.
      if (res.status === 405 || res.status === 501) {
        res = await withTimeout((signal) =>
          fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal }),
        );
      }
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.includes("pdf")) return true;
    } catch {
      // try next candidate URL
    }
  }
  return false;
}

/** Returns the WI PDF bytes for a job, or null if no file exists (404 on all paths). */
export async function fetchWiPdf(
  jobId: string,
): Promise<{ buffer: Buffer; url: string } | null> {
  for (const url of wiPdfUrls(jobId)) {
    try {
      const res = await withTimeout((signal) => fetch(url, { signal }));
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.includes("pdf")) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 0) return { buffer, url };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
