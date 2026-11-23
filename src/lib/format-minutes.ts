"use client";

export interface MinutesMeta {
  meetingTitle: string;
  jobIds: string[];
  startedAt: string | null;
  endedAt: string | null;
  summary: string;
  /**
   * The conversation, in the three versions the room knows them by. All three
   * go into the document: when a number in the summary is questioned, the
   * paper has to show what each transcription pass actually heard.
   */
  transcript?: { speaker: string; text: string; label?: string }[];
  /** บทสนทนาในไฟล์เสียง — the recording, transcribed after the meeting. */
  rawFile?: string;
  /** บทสนทนาในห้องประชุม (ถอดสด) — what was read on screen while talking. */
  rawLive?: string;
  /** Mode label, e.g. "สอบสวน CAR" */
  modeLabel?: string;
}

function speakerLabel(s: string, label?: string): string {
  return s === "assistant" ? "พรชัย" : label || "ผู้ประชุม";
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("th-TH", { dateStyle: "long" }) : "—";
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) : "—";
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const sec = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m} นาที ${sec % 60} วินาที` : `${sec} วินาที`;
}

function metaRows(m: MinutesMeta): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["เรื่อง", m.meetingTitle || "(ไม่ระบุหัวข้อ)"],
    ["วันที่", fmtDate(m.startedAt)],
    ["เวลา", `${fmtTime(m.startedAt)} – ${fmtTime(m.endedAt)} น.`],
    ["ระยะเวลา", fmtDuration(m.startedAt, m.endedAt)],
  ];
  if (m.modeLabel) rows.push(["รูปแบบการประชุม", m.modeLabel]);
  if (m.jobIds.length) rows.push(["งานที่เกี่ยวข้อง", m.jobIds.join(", ")]);
  rows.push(["จำนวนบทสนทนา", `${m.transcript?.length ?? 0} รายการ`]);
  return rows;
}

/** Plain-text minutes document (for copy / download). */
export function formatMeetingMinutes(m: MinutesMeta): string {
  const pad = (s: string) => s + " ".repeat(Math.max(0, 16 - s.length));
  const lines: string[] = [
    "สรุปการประชุม",
    "=".repeat(64),
    ...metaRows(m).map(([k, v]) => pad(k) + ": " + v),
    "=".repeat(64),
    "",
    m.summary.trim() || "(ไม่มีสรุป)",
  ];

  const section = (title: string, note: string, content: string[]) => {
    if (content.length === 0) return;
    lines.push("", "-".repeat(64), title, `(${note})`, "-".repeat(64), "", ...content);
  };

  if (m.rawFile?.trim()) {
    section("บทสนทนาในไฟล์เสียง", "ถอดจากไฟล์เสียงที่อัดไว้ หลังจบประชุม ยังไม่ตรวจทาน", [
      m.rawFile.trim(),
    ]);
  }
  if (m.rawLive?.trim()) {
    section("บทสนทนาในห้องประชุม (ถอดสด)", "ถอดสดระหว่างประชุม ยังไม่ตรวจทาน", [
      m.rawLive.trim(),
    ]);
  }
  if (m.transcript && m.transcript.length) {
    section(
      "บทสนทนาสรุปโดย AI",
      "AI เทียบสองชุดข้างบนแล้วแก้คำผิด — ชุดที่ใช้เขียนบทสรุป",
      m.transcript.map((t) => `${speakerLabel(t.speaker, t.label)}: ${t.text}`),
    );
  }

  return lines.join("\n");
}

/** The .txt export's file name — the same stem the PDF gets. */
export function minutesFilename(m: MinutesMeta): string {
  return `${minutesFileStem(m)}.txt`;
}

/** The section titles the minutes writer uses (see summarize.ts formatRules). */
const SECTION_TITLES = new Set([
  "รายงาน",
  "งานที่แนบแต่ยังไม่ได้พูดถึง",
  "CAR ในตารางที่ยังไม่ได้สอบสวน",
  "สิ่งที่ต้องทำต่อ",
  "ประเด็นที่คุย",
  "มติ / ข้อตกลง",
]);

/**
 * Is this line of the minutes a heading? A numbered line, a line ending in a
 * colon, one of the writer's section titles, or a job / CAR header such as
 * "J82600431 — กล่องชาเขียว (…)" — the per-job shape of an OK-job report.
 */
export function isMinutesHeading(t: string): boolean {
  if (/^\d+[.)]\s/.test(t) || /[:：]$/.test(t)) return true;
  if (SECTION_TITLES.has(t)) return true;
  return /^(J\d{6,}|CAR[-\s]?[\w/-]+|เลขที่ CAR[^—]{0,20})\s+—\s+/.test(t);
}

/**
 * A name the file system will take.
 *
 * The browser's print dialog proposes the page title as the PDF's file
 * name, and the meeting title is typed by the room — "ช่วงบ่าย วันที่
 * 13/11/2569" — so the proposed name carried slashes and Windows refused to
 * save it. Everything a file name cannot hold is replaced, the date goes in
 * as 2569-11-13, and the result is what both the PDF and the .txt are named.
 */
export function minutesFileStem(m: MinutesMeta): string {
  const day = m.startedAt
    ? new Date(m.startedAt).toLocaleDateString("th-TH-u-ca-buddhist", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-")
    : "";
  const title = (m.meetingTitle || m.jobIds[0] || "การประชุม")
    .replace(/[\\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  // a title the room typed with its own date in it does not get a second one
  const hasDate = /\d{1,2}-\d{1,2}-\d{4}/.test(title);
  return `รายงานการประชุม ${title}${day && !hasDate ? ` ${day}` : ""}`.trim();
}

/** Open the minutes in a print window laid out as an A4 document. */
export function printMinutes(m: MinutesMeta): void {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] || c);

  const body = m.summary
    .split("\n")
    .map((line) => {
      const t = line.replace(/\*\*/g, "").trim();
      if (!t) return "";
      if (isMinutesHeading(t)) return `<h3>${esc(t)}</h3>`;
      if (/^[-•*]\s/.test(t)) return `<li>${esc(t.replace(/^[-•*]\s/, ""))}</li>`;
      return `<p>${esc(t)}</p>`;
    })
    .filter(Boolean)
    // wrap consecutive <li> runs in a <ul>
    .reduce<string[]>((acc, cur) => {
      const prev = acc[acc.length - 1];
      if (cur.startsWith("<li>") && prev && prev.startsWith("<ul>") && prev.endsWith("</ul>")) {
        acc[acc.length - 1] = prev.slice(0, -5) + cur + "</ul>";
      } else if (cur.startsWith("<li>")) {
        acc.push("<ul>" + cur + "</ul>");
      } else {
        acc.push(cur);
      }
      return acc;
    }, [])
    .join("\n");

  const docSection = (title: string, note: string, inner: string) =>
    inner
      ? `<h3 class="appendix">${esc(title)}</h3><p class="note">${esc(note)}</p>` + inner
      : "";

  // The PDF carries one transcript, the live one. The room asked for it
  // this way: the printed minutes are read by people who were not there,
  // and three versions of the same conversation — recording, live,
  // cross-checked — are a tool for checking a number, not a document.
  // All three stay in the .txt export and on screen for that.
  const appendix = [
    docSection(
      "บทสนทนาในห้องประชุม",
      "ถอดสดระหว่างประชุม ยังไม่ตรวจทาน",
      m.rawLive?.trim() ? `<p class="turn">${esc(m.rawLive.trim())}</p>` : "",
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>${esc(minutesFileStem(m))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap">
<style>
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Sarabun", "TH Sarabun New", "Noto Sans Thai", sans-serif;
    color: #15181d; background: #fff; margin: 0 auto; max-width: 180mm;
    font-size: 15px; line-height: 1.65; padding: 14mm 6mm;
  }
  h1 { font-size: 20px; margin: 0 0 14px; border-bottom: 2px solid #15181d; padding-bottom: 6px; }
  table.meta { width: 100%; max-width: 150mm; margin: 0 auto 10px; border-collapse: collapse; }
  table.meta td { padding: 4px 0; font-size: 14px; border-bottom: 1px dotted #c8cdd4; vertical-align: top; }
  table.meta td.k { width: 36mm; color: #6b7280; }
  table.meta td.v { font-weight: 600; }
  h3 { font-size: 16px; margin: 18px 0 6px; border-bottom: 1px solid #d3d8de; padding-bottom: 3px;
       page-break-after: avoid; }
  h3.appendix { margin-top: 24px; border-bottom: none; border-top: 1px solid #15181d; padding-top: 14px; }
  p { margin: 6px 0; }
  ul { margin: 6px 0 6px 20px; padding: 0; }
  li { margin: 3px 0; }
  p.turn { margin: 5px 0; font-size: 14px; }
  p.note { margin: 0 0 8px; font-size: 12.5px; color: #6b7280; }
  @media print { body { padding: 0; } }
</style></head><body>
  <h1>สรุปการประชุม</h1>
  <table class="meta">
    ${metaRows(m)
      .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`)
      .join("\n    ")}
  </table>
  ${body || "<p>(ไม่มีสรุป)</p>"}
  ${appendix}
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
