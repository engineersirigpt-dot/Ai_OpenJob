"use client";

export interface MinutesMeta {
  meetingTitle: string;
  jobIds: string[];
  startedAt: string | null;
  endedAt: string | null;
  summary: string;
}

/** Build a plain-text meeting minutes document (for copy / download). */
export function formatMeetingMinutes(m: MinutesMeta): string {
  const date = m.startedAt
    ? new Date(m.startedAt).toLocaleString("th-TH", { dateStyle: "long", timeStyle: "short" })
    : "";
  return [
    "รายงานสรุปการประชุม",
    "==============================",
    m.meetingTitle ? `เรื่อง: ${m.meetingTitle}` : "",
    m.jobIds.length ? `งานที่เกี่ยวข้อง: ${m.jobIds.join(", ")}` : "",
    date ? `วันที่: ${date}` : "",
    "------------------------------",
    "",
    m.summary.trim() || "(ไม่มีสรุป)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Safe filename slug from a title. */
export function minutesFilename(m: MinutesMeta): string {
  const day = m.startedAt ? new Date(m.startedAt).toISOString().slice(0, 10) : "meeting";
  const tag = m.jobIds[0] || m.meetingTitle.replace(/\s+/g, "-").slice(0, 20) || "summary";
  return `meeting-${day}-${tag}.txt`;
}

/** Open the meeting minutes in a print window (user can "Save as PDF"). */
export function printMinutes(m: MinutesMeta): void {
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] || c);
  const date = m.startedAt
    ? new Date(m.startedAt).toLocaleString("th-TH", { dateStyle: "long", timeStyle: "short" })
    : "";

  const body = m.summary
    .split("\n")
    .map((line) => {
      const t = line.replace(/\*\*/g, "").trim();
      if (!t) return "<div style='height:6px'></div>";
      if (/^\d+[.)]\s/.test(t) || /[:：]$/.test(t)) return `<h3>${esc(t)}</h3>`;
      if (/^[-•*]\s/.test(t)) return `<div class="b">• ${esc(t.replace(/^[-•*]\s/, ""))}</div>`;
      return `<p>${esc(t)}</p>`;
    })
    .join("\n");

  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>รายงานสรุปการประชุม</title>
<style>
  body{font-family:'Sarabun','TH Sarabun New','Noto Sans Thai',sans-serif;color:#1a1a1a;max-width:720px;margin:32px auto;padding:0 24px;line-height:1.55;}
  h1{font-size:22px;margin:0 0 4px;}
  .meta{font-size:14px;color:#444;border-bottom:2px solid #333;padding-bottom:10px;margin-bottom:16px;}
  h3{font-size:16px;margin:16px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px;}
  p{margin:4px 0;font-size:15px;}
  .b{margin:3px 0 3px 12px;font-size:15px;}
</style></head><body>
  <h1>รายงานสรุปการประชุม</h1>
  <div class="meta">
    ${m.meetingTitle ? `<div><b>เรื่อง:</b> ${esc(m.meetingTitle)}</div>` : ""}
    ${m.jobIds.length ? `<div><b>งานที่เกี่ยวข้อง:</b> ${esc(m.jobIds.join(", "))}</div>` : ""}
    ${date ? `<div><b>วันที่:</b> ${esc(date)}</div>` : ""}
  </div>
  ${body}
</body></html>`;

  const w = window.open("", "_blank", "width=820,height=920");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
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
