"use client";

import { useState } from "react";
import { Briefcase, Search, Loader2, Download, Check, AlertTriangle, Trash2, Zap } from "lucide-react";

interface DocumentInfo {
  id: string;
  name: string;
  preview: string;
  uploadedAt: string;
}

interface JobRow {
  jobid: string;
  jobName: string;
  ae: string;
  team: string;
  okDate: string;
  deliveryDate: string;
  /** true = REPORT2 already has a Confirm for this job (discussed earlier). */
  confirmed?: boolean;
  attendees?: number;
}

export interface JobCatalogItem {
  jobid: string;
  jobName: string;
  ae: string;
}

interface JobPickerProps {
  documents: DocumentInfo[];
  onChange: (docs: DocumentInfo[]) => void;
  /** Called when a job's document is loaded — used to auto-fill the meeting title. */
  onJobLoaded?: (jobId: string, jobName: string) => void;
  /** Auto-pull mode: register the day's jobs WITHOUT pulling; documents are
   *  fetched on demand during the meeting when their Job ID is spoken. */
  onUseCatalog?: (jobs: JobCatalogItem[]) => void;
  disabled?: boolean;
}

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function JobPicker({ documents, onChange, onJobLoaded, onUseCatalog, disabled }: JobPickerProps) {
  const [jobId, setJobId] = useState("");
  const [date, setDate] = useState(isoDaysFromToday(0));
  const [aeFilter, setAeFilter] = useState("");
  // Afternoon sessions only care about jobs that haven't been discussed yet.
  const [hideConfirmed, setHideConfirmed] = useState(true);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pullingAll, setPullingAll] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  // per-job status: "loading" | "ok" | warning message
  const [rowState, setRowState] = useState<Record<string, string>>({});
  // jobid -> loaded document id (for the remove button)
  const [pulledId, setPulledId] = useState<Record<string, string>>({});
  // jobid -> has a WI PDF (checked after search, so we can flag empty jobs)
  const [wiStatus, setWiStatus] = useState<Record<string, boolean>>({});

  const loadedNames = new Set(documents.map((d) => d.name));

  async function search() {
    setLoading(true);
    setError("");
    setSearched(true);
    setWiStatus({});
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: jobId.trim(), dateStart: date, dateEnd: date }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "ค้นหาไม่สำเร็จ");
        setJobs([]);
        return;
      }
      const rows = (await res.json()) as JobRow[];
      setJobs(rows);
      checkWi(rows); // background — flag jobs with no WI document
    } catch {
      setError("เชื่อมต่อระบบ REPORT2 ไม่ได้");
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }

  // Check which jobs actually have a WI PDF (so we can mark the empty ones).
  async function checkWi(rows: JobRow[]) {
    const ids = rows.map((r) => r.jobid);
    if (!ids.length) return;
    try {
      const res = await fetch("/api/jobs/check-wi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: ids }),
      });
      if (res.ok) {
        const d = await res.json();
        setWiStatus(d.status || {});
      }
    } catch {
      /* ignore — badges just won't show */
    }
  }

  async function pull(job: JobRow) {
    setRowState((s) => ({ ...s, [job.jobid]: "loading" }));
    try {
      const res = await fetch("/api/documents/from-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.jobid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowState((s) => ({ ...s, [job.jobid]: data.error || "ดึงเอกสารไม่สำเร็จ" }));
        return;
      }
      setRowState((s) => ({ ...s, [job.jobid]: "ok" }));
      setPulledId((m) => ({ ...m, [job.jobid]: data.id }));
      if (!loadedNames.has(data.name)) onChange([...documents, data]);
      onJobLoaded?.(job.jobid, job.jobName);
    } catch {
      setRowState((s) => ({ ...s, [job.jobid]: "เชื่อมต่อไม่ได้ — กรุณาอัปโหลดเอง" }));
    }
  }

  // Pull every job in the current results that isn't loaded yet (accumulate,
  // then update the parent once to avoid stale-state overwrites in the loop).
  async function pullAllShown(rows: JobRow[]) {
    setPullingAll(true);
    const acc = [...documents];
    for (const job of rows) {
      if (acc.some((d) => d.name === `${job.jobid}.pdf`)) continue;
      setRowState((s) => ({ ...s, [job.jobid]: "loading" }));
      try {
        const res = await fetch("/api/documents/from-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.jobid }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          acc.push(data);
          setRowState((s) => ({ ...s, [job.jobid]: "ok" }));
          setPulledId((m) => ({ ...m, [job.jobid]: data.id }));
          onJobLoaded?.(job.jobid, job.jobName);
        } else {
          setRowState((s) => ({ ...s, [job.jobid]: data.error || "ไม่มีไฟล์ WI" }));
        }
      } catch {
        setRowState((s) => ({ ...s, [job.jobid]: "เชื่อมต่อไม่ได้" }));
      }
    }
    onChange(acc);
    setPullingAll(false);
  }

  async function removePulled(job: JobRow) {
    const docId = pulledId[job.jobid] || documents.find((d) => d.name === `${job.jobid}.pdf`)?.id;
    if (docId) {
      try {
        await fetch(`/api/documents?id=${docId}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
      onChange(documents.filter((d) => d.id !== docId));
    }
    setRowState((s) => {
      const n = { ...s };
      delete n[job.jobid];
      return n;
    });
    setPulledId((m) => {
      const n = { ...m };
      delete n[job.jobid];
      return n;
    });
  }

  function renderRow(job: JobRow) {
    const st = rowState[job.jobid];
    const done = st === "ok" || loadedNames.has(`${job.jobid}.pdf`);
    const isLoading = st === "loading";
    const warn = st && st !== "ok" && st !== "loading" ? st : "";
    return (
      <div
        key={job.jobid}
        className="rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-2.5 py-2 text-xs"
      >
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-purple-700 dark:text-purple-300">{job.jobid}</span>
              {job.confirmed && (
                <span className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 text-[10px] text-emerald-700 dark:text-emerald-300">
                  ประชุมแล้ว
                </span>
              )}
              {wiStatus[job.jobid] === false && (
                <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-700 dark:text-amber-300">
                  ไม่มีเอกสาร
                </span>
              )}
              <span className="text-slate-500 dark:text-slate-400 truncate" title={job.jobName}>
                {job.jobName}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              OK {job.okDate} · ส่ง {job.deliveryDate}
            </div>
          </div>

          {done ? (
            <div className="shrink-0 flex items-center gap-1">
              <span className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" />
                เพิ่มแล้ว
              </span>
              <button
                type="button"
                onClick={() => removePulled(job)}
                title="ลบเอกสารนี้"
                className="flex items-center justify-center rounded-md border border-rose-500/40 bg-rose-500/10 px-1.5 py-1 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => pull(job)}
              disabled={isLoading}
              className="shrink-0 flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 px-2 py-1 text-[11px] font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-500/20 disabled:opacity-60"
            >
              {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              {isLoading ? "กำลังดึง" : "ดึงเอกสาร"}
            </button>
          )}
        </div>
        {warn && (
          <div className="mt-1 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{warn}</span>
          </div>
        )}
      </div>
    );
  }

  // Filter by AE name + "not yet discussed", then group same-AE jobs together
  const aeq = aeFilter.trim().toLowerCase();
  const byAe = aeq ? jobs.filter((j) => (j.ae || "").toLowerCase().includes(aeq)) : jobs;
  const confirmedCount = byAe.filter((j) => j.confirmed).length;
  const filtered = hideConfirmed ? byAe.filter((j) => !j.confirmed) : byAe;
  const aeGroups = new Map<string, JobRow[]>();
  for (const j of filtered) {
    const key = j.ae?.trim() || "(ไม่ระบุ AE)";
    if (!aeGroups.has(key)) aeGroups.set(key, []);
    aeGroups.get(key)!.push(j);
  }
  const sortedGroups = [...aeGroups.entries()].sort((a, b) => a[0].localeCompare(b[0], "th"));

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Briefcase className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        ดึงเอกสารจากงานOK
      </div>

      {!disabled && (
        <div className="space-y-3">
          {/* Search controls */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0">วันที่ OK งาน</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 text-xs focus:outline-none focus:border-purple-500/50"
              />
            </div>
            <input
              type="text"
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  search();
                }
              }}
              placeholder="Job ID (เว้นว่าง = ดึงทุกงานในวันที่)"
              className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 text-sm focus:outline-none focus:border-purple-500/50"
            />
            <button
              type="button"
              onClick={search}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-purple-500/15 border border-purple-500/40 hover:bg-purple-500/25 px-3 py-2 text-xs font-semibold text-purple-700 dark:text-purple-300 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              {loading ? "กำลังดึง..." : "ดึง Job ID ของวันที่"}
            </button>
          </div>

          {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}

          {/* Results */}
          {searched && !loading && jobs.length === 0 && !error && (
            <p className="text-xs text-slate-500 dark:text-slate-400 text-center py-2">ไม่พบงานในช่วงที่ค้นหา</p>
          )}

          {jobs.length > 0 && (
            <>
              <input
                type="text"
                value={aeFilter}
                onChange={(e) => setAeFilter(e.target.value)}
                placeholder="กรองตามชื่อ AE (เช่น มานิกา)"
                className="w-full px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 text-xs focus:outline-none focus:border-purple-500/50"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  พบ {filtered.length} งาน · {sortedGroups.length} AE
                  {(() => {
                    const noWi = filtered.filter((j) => wiStatus[j.jobid] === false).length;
                    return noWi > 0 ? <span className="text-amber-700 dark:text-amber-300"> · ไม่มีเอกสาร {noWi}</span> : null;
                  })()}
                </p>
                {confirmedCount > 0 && (
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={hideConfirmed}
                      onChange={(e) => setHideConfirmed(e.target.checked)}
                      className="accent-emerald-500"
                    />
                    ซ่อนงานที่ประชุมแล้ว ({confirmedCount})
                  </label>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {onUseCatalog && (
                  <button
                    type="button"
                    onClick={() => onUseCatalog(filtered.map((j) => ({ jobid: j.jobid, jobName: j.jobName, ae: j.ae })))}
                    title="ยังไม่ดึงเอกสาร — จะดึงให้อัตโนมัติเมื่อมีคนพูดถึงเลขจ็อบในที่ประชุม"
                    className="flex items-center justify-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 px-2 py-1.5 text-[11px] font-medium text-purple-700 dark:text-purple-300"
                  >
                    <Zap className="h-3 w-3" />
                    ดึงอัตโนมัติเมื่อพูดถึง ({filtered.length})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => pullAllShown(filtered)}
                  disabled={pullingAll}
                  className="flex items-center justify-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 disabled:opacity-50"
                >
                  {pullingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  {pullingAll ? "กำลังดึง..." : `ดึงทั้งหมดเลย (${filtered.length})`}
                </button>
              </div>
              <div className="space-y-3">
                {sortedGroups.map(([ae, rows]) => (
                  <div key={ae} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 py-1">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-purple-700 dark:text-purple-300">
                        AE: {ae}
                        <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400">({rows.length})</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => pullAllShown(rows)}
                        disabled={pullingAll}
                        title={`ดึงเอกสารทั้งหมดของ ${ae}`}
                        className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 disabled:opacity-50"
                      >
                        {pullingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                        ดึงทั้งหมด
                      </button>
                    </div>
                    {rows.map((job) => renderRow(job))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
