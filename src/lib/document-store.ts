/**
 * Document store for the current meeting, persisted to disk so documents
 * survive an app restart (e.g. `pm2 restart`).
 *
 * Note: this is still a single shared store (not per-user). Fine for
 * single-user-at-a-time use; revisit if concurrent meetings are needed.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export interface MeetingDocument {
  id: string;
  name: string;
  content: string;
  /** Compact AI-extracted digest (Job/AE/specs/CAR) used for the realtime
   *  session; full `content` is only injected on demand for CAR/comment. */
  summary?: string;
  uploadedAt: Date;
}

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "documents.json");

const docs = new Map<string, MeetingDocument>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const arr = JSON.parse(raw) as MeetingDocument[];
    for (const d of arr) {
      docs.set(d.id, { ...d, uploadedAt: new Date(d.uploadedAt) });
    }
  } catch {
    // no store file yet — start empty
  }
}

function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(Array.from(docs.values())), "utf-8");
  } catch (err) {
    console.error("[doc-store-persist]", err);
  }
}

export function addDocument(name: string, content: string, summary?: string): MeetingDocument {
  load();
  const id = randomUUID();
  const doc: MeetingDocument = { id, name, content, summary, uploadedAt: new Date() };
  docs.set(id, doc);
  persist();
  return doc;
}

/** Attach/replace a document's digest after creation (best-effort). */
export function setDocumentSummary(id: string, summary: string): void {
  load();
  const doc = docs.get(id);
  if (doc) {
    doc.summary = summary;
    persist();
  }
}

export function listDocuments(): MeetingDocument[] {
  load();
  return Array.from(docs.values()).sort(
    (a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime(),
  );
}

export function getDocument(id: string): MeetingDocument | null {
  load();
  return docs.get(id) ?? null;
}

export function removeDocument(id: string): boolean {
  load();
  const ok = docs.delete(id);
  if (ok) persist();
  return ok;
}

export function clearDocuments(): void {
  load();
  docs.clear();
  persist();
}
