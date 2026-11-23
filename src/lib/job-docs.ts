import { extractTextFromBuffer } from "@/lib/document-parser";
import { digestWiDocument } from "@/lib/digest";
import { fetchWiPdf } from "@/lib/report2";
import { carParBlockForJob } from "@/lib/car-par";
import type { SummaryDoc } from "@/lib/summarize";

/**
 * The WI documents of a finished meeting, pulled again from REPORT2.
 *
 * The document store is emptied when a meeting ends so the next one starts
 * clean, which is right for the room and wrong for "สรุปใหม่": a re-summary
 * of an OK-job meeting ran with no WI at all and wrote "ไม่มีงานแนบ 0 งาน"
 * about a meeting that had twenty. The meeting record keeps its Job IDs,
 * and a WI can always be fetched again by Job ID, so the agenda is rebuilt
 * from there — into memory only, never into the store, so nothing from an
 * old meeting leaks into the next.
 *
 * Jobs whose WI cannot be fetched or read are skipped; the summary is
 * written against whatever came back, and says which jobs it covers.
 */
export async function loadJobDocsForSummary(jobIds: string[], concurrency = 4): Promise<SummaryDoc[]> {
  const ids = Array.from(new Set(jobIds.map((j) => j.trim().toUpperCase()).filter(Boolean)));
  const out: SummaryDoc[] = [];
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const jobId = ids[next++];
      try {
        const wi = await fetchWiPdf(jobId);
        if (!wi) continue;
        const content = await extractTextFromBuffer(wi.buffer, ".pdf");
        if (!content.trim()) continue;
        const name = `${jobId}.pdf`;
        // the same CAR/PAR block the from-job loader attaches (see car-par.ts)
        const [digest, carPar] = await Promise.all([digestWiDocument(name, content), carParBlockForJob(jobId)]);
        out.push({
          name,
          content: carPar ? `${content}

${carPar}` : content,
          summary: carPar ? `${digest}
${carPar}` : digest,
        });
      } catch (err) {
        console.error("[job-docs]", jobId, (err as Error).message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  // The meeting's own order, so the minutes list jobs the way the room did.
  out.sort((a, b) => ids.indexOf(a.name.replace(/\.pdf$/, "")) - ids.indexOf(b.name.replace(/\.pdf$/, "")));
  console.log(`[job-docs] ดึง WI ใหม่สำหรับสรุป ${out.length}/${ids.length} งาน`);
  return out;
}
