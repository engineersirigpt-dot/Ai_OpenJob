/**
 * พรชัย RAG over real chat history.
 *
 * Drop exported/pasted chats (between เฮีย and the original ChatGPT "พรชัย")
 * as .txt/.md files into  data/pornchai-chats/  then call the ingest API:
 *   - each NEW file is chunked + embedded (text-embedding-3-small) into SQLite
 *   - memory facts are also extracted from it (seeds long-term memory)
 * At question time, the top matching chunks are retrieved by cosine similarity
 * and handed to พรชัย as reference context. Everything stays on our server.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { addMemories, extractMemories } from "@/lib/pornchai-memory";
import { embed, cosine } from "@/lib/embeddings";

const DATA_DIR = path.join(process.cwd(), "data");
const CHAT_DIR = path.join(DATA_DIR, "pornchai-chats");
const DB_PATH = path.join(DATA_DIR, "pornchai-memory.db");

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;

let _db: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS rag_files (
      name        TEXT PRIMARY KEY,
      hash        TEXT NOT NULL,
      chunk_count INTEGER,
      ingested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id        TEXT PRIMARY KEY,
      source    TEXT NOT NULL,
      seq       INTEGER,
      text      TEXT NOT NULL,
      embedding TEXT NOT NULL
    );
  `);
  return _db;
}

function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);
    // prefer to break on a newline near the end of the window
    if (end < clean.length) {
      const nl = clean.lastIndexOf("\n", end);
      if (nl > start + CHUNK_CHARS / 2) end = nl;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter((c) => c.length > 40);
}

export interface IngestResult {
  scanned: number;
  ingested: string[];
  skipped: string[];
  chunks: number;
  memoriesAdded: number;
}

/** Ingest every new/changed chat file in data/pornchai-chats/. */
export async function ingestChatFiles(): Promise<IngestResult> {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  const files = fs
    .readdirSync(CHAT_DIR)
    .filter((f) => /\.(txt|md|json)$/i.test(f));

  const result: IngestResult = { scanned: files.length, ingested: [], skipped: [], chunks: 0, memoriesAdded: 0 };
  const d = db();

  for (const name of files) {
    const full = path.join(CHAT_DIR, name);
    const raw = fs.readFileSync(full, "utf-8");
    const hash = crypto.createHash("sha1").update(raw).digest("hex");

    const existing = d.prepare(`SELECT hash FROM rag_files WHERE name = ?`).get(name) as
      | { hash: string }
      | undefined;
    if (existing?.hash === hash) {
      result.skipped.push(name);
      continue;
    }

    // changed file → drop old chunks first
    d.prepare(`DELETE FROM rag_chunks WHERE source = ?`).run(name);

    const chunks = chunkText(raw);
    const vectors = await embed(chunks);
    const ins = d.prepare(
      `INSERT INTO rag_chunks (id, source, seq, text, embedding) VALUES (?, ?, ?, ?, ?)`,
    );
    chunks.forEach((text, i) => {
      ins.run(crypto.randomUUID(), name, i, text, JSON.stringify(vectors[i] ?? []));
    });

    d.prepare(
      `INSERT INTO rag_files (name, hash, chunk_count, ingested_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET hash=excluded.hash, chunk_count=excluded.chunk_count, ingested_at=excluded.ingested_at`,
    ).run(name, hash, chunks.length, new Date().toISOString());

    // Also seed long-term memory from this chat (best-effort)
    try {
      const turns = [{ speaker: "user" as const, text: raw.slice(0, 24000), sequence: 0, timestamp: "" }];
      const facts = await extractMemories(turns, name.replace(/\.(txt|md|json)$/i, ""));
      if (facts.length) result.memoriesAdded += addMemories(facts, `แชทเก่า: ${name}`);
    } catch (err) {
      console.error("[rag-memory]", err);
    }

    result.ingested.push(name);
    result.chunks += chunks.length;
  }
  return result;
}

export interface RagHit {
  text: string;
  source: string;
  score: number;
}

/** Top-k chunks for a query by cosine similarity. [] when index empty/no key. */
export async function searchRag(query: string, k = 4): Promise<RagHit[]> {
  if (!query.trim()) return [];
  const rows = db().prepare(`SELECT source, text, embedding FROM rag_chunks`).all() as unknown as Array<{
    source: string;
    text: string;
    embedding: string;
  }>;
  if (rows.length === 0) return [];

  const [qVec] = await embed([query]);
  if (!qVec) return [];

  const scored = rows.map((r) => {
    let vec: number[] = [];
    try {
      vec = JSON.parse(r.embedding);
    } catch {
      /* skip */
    }
    return { text: r.text, source: r.source, score: vec.length ? cosine(qVec, vec) : -1 };
  });
  scored.sort((a, b) => b.score - a.score);
  // 0.3 floor: below this, hits are usually topically unrelated — injecting
  // them tempts the model to force a connection (hallucination risk).
  return scored.slice(0, k).filter((h) => h.score > 0.3);
}

/** Stats for the UI/debug. */
export function ragStats(): { files: number; chunks: number } {
  const f = db().prepare(`SELECT COUNT(*) AS c FROM rag_files`).get() as { c: number };
  const c = db().prepare(`SELECT COUNT(*) AS c FROM rag_chunks`).get() as { c: number };
  return { files: Number(f.c), chunks: Number(c.c) };
}
