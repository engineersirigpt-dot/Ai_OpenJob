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
}

export interface MeetingRecord {
  id: string;
  jobIds: string[];
  jobNames: string[];
  meetingTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  turnCount: number;
  transcript: TranscriptTurn[];
  summary: string;
  createdAt: string;
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
  return _db;
}

interface MeetingRow {
  id: string;
  job_ids: string | null;
  job_names: string | null;
  meeting_title: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  turn_count: number | null;
  transcript: string | null;
  summary: string | null;
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
    jobIds: parse<string[]>(r.job_ids, []),
    jobNames: parse<string[]>(r.job_names, []),
    meetingTitle: r.meeting_title || "",
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSec: r.duration_sec,
    turnCount: r.turn_count ?? 0,
    transcript: parse<TranscriptTurn[]>(r.transcript, []),
    summary: r.summary || "",
    createdAt: r.created_at,
  };
}

export function saveMeeting(input: {
  jobIds: string[];
  jobNames: string[];
  meetingTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  transcript: TranscriptTurn[];
  summary: string;
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
        (id, job_ids, job_names, meeting_title, started_at, ended_at, duration_sec, turn_count, transcript, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      JSON.stringify(input.jobIds),
      JSON.stringify(input.jobNames),
      input.meetingTitle,
      input.startedAt,
      input.endedAt,
      durationSec,
      input.transcript.length,
      JSON.stringify(input.transcript),
      input.summary,
      createdAt,
    );

  return getMeeting(id)!;
}

/** List meetings, newest first. Transcript omitted for a lighter payload. */
export function listMeetings(): Omit<MeetingRecord, "transcript">[] {
  const rows = db()
    .prepare(`SELECT * FROM meetings ORDER BY created_at DESC`)
    .all() as unknown as MeetingRow[];
  return rows.map((r) => {
    const { transcript, ...rest } = rowToRecord(r);
    void transcript;
    return rest;
  });
}

export function getMeeting(id: string): MeetingRecord | null {
  const row = db().prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as
    | unknown as MeetingRow
    | undefined;
  return row ? rowToRecord(row) : null;
}

export function deleteMeeting(id: string): boolean {
  const res = db().prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}
