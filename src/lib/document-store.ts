/**
 * Simple in-memory document store for the current meeting.
 * For production, switch to a real DB (Postgres) or KV store.
 */

import { randomUUID } from "crypto";

export interface MeetingDocument {
  id: string;
  name: string;
  content: string;
  uploadedAt: Date;
}

const docs = new Map<string, MeetingDocument>();

export function addDocument(name: string, content: string): MeetingDocument {
  const id = randomUUID();
  const doc: MeetingDocument = { id, name, content, uploadedAt: new Date() };
  docs.set(id, doc);
  return doc;
}

export function listDocuments(): MeetingDocument[] {
  return Array.from(docs.values()).sort(
    (a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime(),
  );
}

export function getDocument(id: string): MeetingDocument | null {
  return docs.get(id) ?? null;
}

export function removeDocument(id: string): boolean {
  return docs.delete(id);
}

export function clearDocuments(): void {
  docs.clear();
}
