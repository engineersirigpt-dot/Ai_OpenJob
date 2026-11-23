import { fetchJobOkList, fetchWiPdf } from "@/lib/report2";
import { extractTextFromBuffer } from "@/lib/document-parser";
import { digestWiDocument } from "@/lib/digest";
import { carParBlockForJob } from "@/lib/car-par";
import { addDocument, listDocuments } from "@/lib/document-store";
import { isReprintName, type OkSession } from "@/lib/ok-session";

/**
 * The OK meeting's documents, ready before anyone walks in.
 *
 * The OK meeting is at fixed times — 10:30 and 14:00, measured over 68
 * meeting days — and its agenda is REPORT2's OK list for the day. Nothing
 * about that needs a person: this pulls the WI, the digest and the CAR/PAR
 * block of every job still unconfirmed into the document store in one go.
 * It ran on a clock for a day (10:00 and 13:30) and the clock was taken
 * out again: a timer that fires on its own gets in the way of testing by
 * hand, and the room wanted to press the button itself. So it runs when
 * asked — POST /api/jobs/prepull — and never on its own.
 *
 * The order is the room's habit: mornings are mostly reprints (75% over
 * two months), afternoons mostly new jobs (72%), so each session pulls its
 * likely jobs first and the rest after — never nothing, because a quarter
 * of each session is the other kind.
 */

export type Session = OkSession;

function bangkokNow(): { date: string; hhmm: string; hour: number } {
  const now = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
  const hhmm = now.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false });
  return { date, hhmm, hour: Number(hhmm.slice(0, 2)) };
}

export interface PrepullResult {
  date: string;
  session: Session;
  total: number;
  pulled: string[];
  already: string[];
  noWi: string[];
  failed: string[];
}

/** Today's unconfirmed OK jobs in the order this session will take them. */
export async function todayOkJobsForSession(session: Session) {
  const { date } = bangkokNow();
  const rows = await fetchJobOkList({ dateStart: date, dateEnd: date });
  const open = rows.filter((r) => Number(r.is_confirm) !== 1);
  const likely = (r: { job_name: string }) => (session === "am" ? isReprintName(r.job_name) : !isReprintName(r.job_name));
  return { date, jobs: [...open.filter(likely), ...open.filter((r) => !likely(r))] };
}

/** Pull every unconfirmed job of today into the store, likely ones first. */
export async function prepullTodayOkJobs(session?: Session, concurrency = 2): Promise<PrepullResult> {
  const s: Session = session || (bangkokNow().hour < 12 ? "am" : "pm");
  const { date, jobs } = await todayOkJobsForSession(s);
  const result: PrepullResult = { date, session: s, total: jobs.length, pulled: [], already: [], noWi: [], failed: [] };
  const have = new Set(listDocuments().map((d) => d.name));
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const id = job.jobid.trim().toUpperCase();
      const name = `${id}.pdf`;
      if (have.has(name)) {
        result.already.push(id);
        continue;
      }
      try {
        const wi = await fetchWiPdf(id);
        if (!wi) {
          result.noWi.push(id);
          continue;
        }
        const content0 = await extractTextFromBuffer(wi.buffer, ".pdf");
        if (!content0.trim()) {
          result.noWi.push(id);
          continue;
        }
        const [digest, carPar] = await Promise.all([digestWiDocument(name, content0), carParBlockForJob(id)]);
        const content = carPar ? `${content0}\n\n${carPar}` : content0;
        const summary = carPar ? `${digest}\n${carPar}` : digest;
        addDocument(name, content, summary);
        have.add(name);
        result.pulled.push(id);
      } catch (err) {
        console.error("[ok-prepull]", id, (err as Error).message);
        result.failed.push(id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, worker));
  console.log(
    `[ok-prepull] ${date} ${s}: ${jobs.length} งานค้าง OK — ดึงใหม่ ${result.pulled.length}, มีอยู่แล้ว ${result.already.length}, ` +
      `ไม่มี WI ${result.noWi.length}, ล้มเหลว ${result.failed.length}`,
  );
  return result;
}
