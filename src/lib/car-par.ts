/**
 * CAR and PAR documents for a job, from the company's REPORT system.
 *
 * A WI carries the customer's CAR history on its last page, and that was
 * all พรชัย knew about past problems — until a PAR turned up in the
 * question "แล้ว PAR คืออะไร". PAR (Preventive Action Request) is the
 * document raised when a risk is seen before it becomes a loss; CAR
 * (Corrective Action Request) is raised after. Both live in the same table
 * behind the report "รายงานปัญหาจาก Timesheet และ CAR/PAR", keyed by Job ID,
 * with the problem, ISO's reading of it, the cause, the fix and the
 * prevention — fuller than the WI's one-line history, and the only place
 * PAR exists at all. On 13 Nov 2569 the two-year table held 1,678 CAR and
 * 156 PAR; the WI of a job in that morning's meeting (J82602553) said
 * nothing about the PAR open on it.
 *
 * The endpoint filters by keyword, and a Job ID as keyword returns that
 * job's documents in under two seconds, so each job is asked for on its own
 * when its WI is loaded. A failure here never blocks a meeting: the WI is
 * still loaded, just without this block.
 */

const BASE = (process.env.REPORT2_BASE_URL || "http://192.168.5.40").replace(/\/+$/, "");
const ENABLED = (process.env.CAR_PAR_LOOKUP || "on").toLowerCase() !== "off";
/** How far back to look. A customer's old PAR is still a warning. */
const YEARS_BACK = 3;

export interface CarParDoc {
  carCode: string;
  carType: "CAR" | "PAR" | string;
  docDate: string;
  jobId: string;
  jobName: string;
  machineName: string;
  problemDesc: string;
  isoRemark: string;
  causesDesc: string;
  correctiveDesc: string;
  preventiveDesc: string;
}

function clean(s: unknown, max = 400): string {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** All CAR/PAR documents on one job, newest first. [] on any failure. */
export async function fetchCarParForJob(jobId: string): Promise<CarParDoc[]> {
  if (!ENABLED) return [];
  const id = jobId.trim().toUpperCase();
  if (!/^[A-Z]\d{8}$/.test(id)) return [];
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - YEARS_BACK);
  const body = new URLSearchParams({
    post_type: "fetch_list_car_document",
    start_date: iso(start),
    end_date: iso(end),
    keyword: id,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${BASE}/report/controllers/controller.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { carListDocument?: Record<string, unknown>[] };
    const rows = Array.isArray(data?.carListDocument) ? data.carListDocument : [];
    // The report joins one document to several rows (one per remark line);
    // one row per document code is enough here, the fullest one wins.
    const byCode = new Map<string, CarParDoc>();
    for (const r of rows) {
      if (String(r.jobId || "").toUpperCase() !== id) continue;
      const doc: CarParDoc = {
        carCode: clean(r.carCode, 40),
        carType: clean(r.carType, 10) || "CAR",
        docDate: clean(r.docDate, 10),
        jobId: id,
        jobName: clean(r.jobName, 120),
        machineName: clean(r.machineName, 60),
        problemDesc: clean(r.problemDesc),
        isoRemark: clean(r.isoRemark),
        causesDesc: clean(r.causesDesc),
        correctiveDesc: clean(r.correctiveDesc),
        preventiveDesc: clean(r.preventiveDesc),
      };
      const prev = byCode.get(doc.carCode);
      const weight = (d: CarParDoc) =>
        d.problemDesc.length + d.isoRemark.length + d.causesDesc.length + d.correctiveDesc.length + d.preventiveDesc.length;
      if (!prev || weight(doc) > weight(prev)) byCode.set(doc.carCode, doc);
    }
    return [...byCode.values()].sort((a, b) => b.docDate.localeCompare(a.docDate));
  } catch (err) {
    console.warn("[car-par]", id, (err as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The documents as a block of Thai text to append to the job's WI, in the
 * shape both the realtime session and the minutes writer already read.
 * "" when the job has none.
 */
export function formatCarParBlock(docs: CarParDoc[]): string {
  if (docs.length === 0) return "";
  const car = docs.filter((d) => d.carType !== "PAR");
  const par = docs.filter((d) => d.carType === "PAR");
  const line = (d: CarParDoc) =>
    `- ${d.carType} ${d.carCode} (${d.docDate}${d.machineName ? `, เครื่อง ${d.machineName}` : ""})\n` +
    `  ปัญหา: ${d.problemDesc || "-"}\n` +
    (d.isoRemark ? `  ISO สรุป: ${d.isoRemark}\n` : "") +
    `  สาเหตุ: ${d.causesDesc || "ยังไม่ได้ระบุ"}\n` +
    `  แก้ไข: ${d.correctiveDesc || "ยังไม่ได้ระบุ"}\n` +
    `  ป้องกัน: ${d.preventiveDesc || "ยังไม่ได้ระบุ"}`;
  const parts: string[] = [];
  parts.push(`CAR/PAR ของงานนี้จากระบบ (CAR ${car.length} ใบ, PAR ${par.length} ใบ):`);
  if (par.length) {
    parts.push(
      "PAR = ใบขอให้ดำเนินการป้องกัน ออกเมื่อเห็นความเสี่ยงก่อนเกิดความเสียหาย ต้องเตือนที่ประชุมให้ชัดว่ามี PAR ค้างอยู่กับงานนี้และแนวทางป้องกันตอบแล้วหรือยัง",
    );
    parts.push(...par.map(line));
  }
  if (car.length) parts.push(...car.map(line));
  return parts.join("\n");
}

/** Fetch and format in one go: the text to append to a job's WI, or "". */
export async function carParBlockForJob(jobId: string): Promise<string> {
  const docs = await fetchCarParForJob(jobId);
  const block = formatCarParBlock(docs);
  if (block) {
    console.log(
      `[car-par] ${jobId}: CAR ${docs.filter((d) => d.carType !== "PAR").length} / PAR ${docs.filter((d) => d.carType === "PAR").length}`,
    );
  }
  return block;
}
