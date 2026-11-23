/**
 * Meeting history store — local SQLite (node:sqlite, built into Node 22+).
 * Records which jobs the AI joined, with transcript + summary, so meetings
 * can be reviewed after they finish. No external DB / no company DB involved.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "meetings.db");

export interface TranscriptTurn {
  speaker: "user" | "assistant";
  text: string;
  sequence: number;
  timestamp: string;
  /** Who spoke, when the recording could tell them apart ("ผู้ประชุม A"). */
  label?: string;
  /** "room" = overheard speech (rough, hidden on screen); "ask" = asked of พรชัย. */
  kind?: "room" | "ask";
}

/** Which assistant ran the meeting: OK-job meeting or the พรชัย persona. */
export type MeetingMode = "okjob" | "pornchai" | "car";

export interface MeetingRecord {
  id: string;
  mode: MeetingMode;
  jobIds: string[];
  jobNames: string[];
  meetingTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  turnCount: number;
  transcript: TranscriptTurn[];
  summary: string;
  /** The recording transcribed in one pass, before cross-checking. */
  rawFile: string;
  /** What the live pass heard during the meeting, before cross-checking. */
  rawLive: string;
  /** Why the recording produced no text, when it produced none. */
  rawFileNote: string;
  /** Where the room's audio is kept, while it is kept. */
  recordingId: string;
  /**
   * The documents that were loaded when the meeting ran. "สรุปใหม่" needs
   * them: for an OK-job meeting the WI documents are the agenda, and a
   * summary written without them cannot name a single job.
   */
  docIds: string[];
  /**
   * "processing" while the server is still transcribing the recording and
   * writing the minutes after the save; "done" once the record is final.
   * The room sees its summary either way — a processing record carries the
   * live transcript and gets upgraded in place.
   */
  status: MeetingStatus;
  /** Confirm presses seen during the meeting, in order (OK-job meetings). */
  marks: ConfirmMark[];
  createdAt: string;
}

export type MeetingStatus = "processing" | "done";

/**
 * One press of "confirm" in REPORT2 during an OK-job meeting, as the room
 * saw it. The person at the keyboard opens each job's WI as the room asks
 * for it and presses confirm when that job is settled, so the confirm time
 * is the line between one job's talk and the next's: everything said
 * before this mark and after the previous one belongs to `jobId`. Measured
 * over 68 meeting days, a job is confirmed every 1-2 minutes.
 */
export interface ConfirmMark {
  jobId: string;
  jobName: string;
  /** ISO instant — REPORT2's confirm time when it had one, else when the room saw it. */
  at: string;
  /** What was typed next to the confirm, if anything. */
  remark?: string;
  /** Pressed in the app by hand, not read from REPORT2. */
  manual?: boolean;
}

let _db: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id            TEXT PRIMARY KEY,
      job_ids       TEXT,
      job_names     TEXT,
      meeting_title TEXT,
      started_at    TEXT,
      ended_at      TEXT,
      duration_sec  INTEGER,
      turn_count    INTEGER,
      transcript    TEXT,
      summary       TEXT,
      created_at    TEXT NOT NULL
    );
  `);
  // Migration: older DBs don't have the mode column — add it, defaulting
  // existing records to the OK-job mode.
  try {
    _db.exec(`ALTER TABLE meetings ADD COLUMN mode TEXT DEFAULT 'okjob'`);
  } catch {
    /* column already exists */
  }
  // The transcript of record is the two passes cross-checked against each
  // other. Both originals are kept alongside it: when a number is questioned
  // later, what each pass actually heard has to be readable.
  // `raw_file_note` carries WHY the recording produced no text, so a meeting
  // opened from the history months later can still say what went wrong
  // instead of quietly dropping the section.
  // `recording_id` points at the room's audio on disk, so a meeting can be
  // listened to again. The audio itself is swept on its own schedule — see
  // lib/recordings.ts — so this can point at nothing, and that is normal.
  for (const col of ["raw_file", "raw_live", "raw_file_note", "recording_id", "doc_ids", "status", "marks"]) {
    try {
      _db.exec(`ALTER TABLE meetings ADD COLUMN ${col} TEXT`);
    } catch {
      /* column already exists */
    }
  }
  return _db;
}

interface MeetingRow {
  id: string;
  mode: string | null;
  job_ids: string | null;
  job_names: string | null;
  meeting_title: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  turn_count: number | null;
  transcript: string | null;
  summary: string | null;
  raw_file: string | null;
  raw_live: string | null;
  raw_file_note: string | null;
  recording_id: string | null;
  doc_ids: string | null;
  status: string | null;
  marks: string | null;
  created_at: string;
}

function rowToRecord(r: MeetingRow): MeetingRecord {
  const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: r.id,
    mode: r.mode === "pornchai" ? "pornchai" : r.mode === "car" ? "car" : "okjob",
    jobIds: parse<string[]>(r.job_ids, []),
    jobNames: parse<string[]>(r.job_names, []),
    meetingTitle: r.meeting_title || "",
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSec: r.duration_sec,
    turnCount: r.turn_count ?? 0,
    transcript: parse<TranscriptTurn[]>(r.transcript, []),
    summary: r.summary || "",
    rawFile: r.raw_file || "",
    rawLive: r.raw_live || "",
    rawFileNote: r.raw_file_note || "",
    recordingId: r.recording_id || "",
    docIds: parse<string[]>(r.doc_ids, []),
    // Records from before the column exist only as finished ones.
    status: r.status === "processing" ? "processing" : "done",
    marks: parse<ConfirmMark[]>(r.marks, []),
    createdAt: r.created_at,
  };
}

export function saveMeeting(input: {
  mode: MeetingMode;
  jobIds: string[];
  jobNames: string[];
  meetingTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  transcript: TranscriptTurn[];
  summary: string;
  /** What the recording was transcribed as, before cross-checking. */
  rawFile?: string;
  /** What the live pass heard, before cross-checking. */
  rawLive?: string;
  /** Why the recording produced no text, when it produced none. */
  rawFileNote?: string;
  /** Where the room's audio is kept, while it is kept. */
  recordingId?: string;
  /** The documents loaded in the meeting, so a re-summary can use them. */
  docIds?: string[];
  /** "processing" when the server will finish the record after saving. */
  status?: MeetingStatus;
  /** Confirm presses seen during the meeting (OK-job meetings). */
  marks?: ConfirmMark[];
}): MeetingRecord {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const durationSec =
    input.startedAt && input.endedAt
      ? Math.max(
          0,
          Math.round(
            (new Date(input.endedAt).getTime() - new Date(input.startedAt).getTime()) / 1000,
          ),
        )
      : null;

  db()
    .prepare(
      `INSERT INTO meetings
        (id, mode, job_ids, job_names, meeting_title, started_at, ended_at, duration_sec, turn_count, transcript, summary, raw_file, raw_live, raw_file_note, recording_id, doc_ids, status, marks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.mode,
      JSON.stringify(input.jobIds),
      JSON.stringify(input.jobNames),
      input.meetingTitle,
      input.startedAt,
      input.endedAt,
      durationSec,
      input.transcript.length,
      JSON.stringify(input.transcript),
      input.summary,
      input.rawFile || null,
      input.rawLive || null,
      input.rawFileNote || null,
      input.recordingId || null,
      JSON.stringify(input.docIds || []),
      input.status || "done",
      JSON.stringify(input.marks || []),
      createdAt,
    );

  return getMeeting(id)!;
}

/**
 * List meetings, newest first. The transcripts are omitted: each meeting holds
 * three of them now, and the list only needs titles and dates.
 */
export function listMeetings(): Omit<
  MeetingRecord,
  "transcript" | "rawFile" | "rawLive" | "rawFileNote"
>[] {
  const rows = db()
    .prepare(`SELECT * FROM meetings ORDER BY created_at DESC`)
    .all() as unknown as MeetingRow[];
  return rows.map((r) => {
    const { transcript, rawFile, rawLive, rawFileNote, ...rest } = rowToRecord(r);
    void transcript;
    void rawFile;
    void rawLive;
    void rawFileNote;
    return rest;
  });
}

export function getMeeting(id: string): MeetingRecord | null {
  const row = db().prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
    | unknown as MeetingRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

/** Replace a stored summary (used when re-summarizing an old meeting). */
/**
 * Finish (or re-finish) a record after the save: the server's transcription
 * of the recording, the cross-checked transcript it produced, the minutes,
 * and the status flip. Only the fields given are touched.
 */
export function updateMeetingResult(
  id: string,
  patch: {
    transcript?: TranscriptTurn[];
    rawFile?: string;
    rawFileNote?: string;
    summary?: string;
    status: MeetingStatus;
  },
): boolean {
  const sets: string[] = ["status = ?"];
  const vals: unknown[] = [patch.status];
  if (patch.transcript) {
    sets.push("transcript = ?", "turn_count = ?");
    vals.push(JSON.stringify(patch.transcript), patch.transcript.length);
  }
  if (patch.rawFile !== undefined) {
    sets.push("raw_file = ?");
    vals.push(patch.rawFile || null);
  }
  if (patch.rawFileNote !== undefined) {
    sets.push("raw_file_note = ?");
    vals.push(patch.rawFileNote || null);
  }
  if (patch.summary !== undefined) {
    sets.push("summary = ?");
    vals.push(patch.summary);
  }
  vals.push(id);
  const res = db()
    .prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as (string | number | null)[]));
  return Number(res.changes) > 0;
}

export function updateSummary(id: string, summary: string): boolean {
  const res = db().prepare(`UPDATE meetings SET summary = ? WHERE id = ?`).run(summary, id);
  return Number(res.changes) > 0;
}

export function deleteMeeting(id: string): boolean {
  const res = db().prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}
