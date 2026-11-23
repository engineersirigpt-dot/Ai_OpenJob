/**
 * Which OK session a job most likely belongs to — shared by the browser and
 * the server, so it must stay free of server-only imports.
 *
 * Measured over 68 meeting days (1 Sep – 19 Nov 2569): the 10:30 session
 * confirmed 758 jobs, 75% of them reprints; the 14:00 session 336 jobs,
 * 72% of them new. A tendency, not a rule — a quarter of each session is
 * the other kind — so this is used to ORDER a day's jobs (likely ones
 * first), never to leave any out.
 */
export type OkSession = "am" | "pm";

export function isReprintName(name: string): boolean {
  return /\brep\.?\b|reprint|re-?order|พิมพ์เพิ่ม|ซ่อม/i.test(name || "");
}

/** The session for a Bangkok wall-clock hour. */
export function sessionForHour(hour: number): OkSession {
  return hour < 12 ? "am" : "pm";
}

/** Does this job fit the session's usual kind? */
export function fitsSession(jobName: string, session: OkSession): boolean {
  return session === "am" ? isReprintName(jobName) : !isReprintName(jobName);
}

/** Likely jobs first, the rest after; order within each group kept. */
export function orderForSession<T extends { jobName: string }>(jobs: T[], session: OkSession): T[] {
  return [...jobs.filter((j) => fitsSession(j.jobName, session)), ...jobs.filter((j) => !fitsSession(j.jobName, session))];
}
