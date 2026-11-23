import fs from "node:fs";
import path from "node:path";

/**
 * Keeps the room's recording so a meeting can be listened to again.
 *
 * This is the one part of the system that writes the room's audio to disk, so
 * it is deliberately narrow:
 *
 *   - a recording lives under its own id, in pieces, exactly as the browser
 *     cut them; nothing is re-encoded or merged
 *   - it is deleted after RECORDING_RETENTION_DAYS, swept on every save, so
 *     the disk cannot fill quietly with months of meetings nobody will open
 *   - KEEP_RECORDINGS=false turns the whole thing off, and the system goes
 *     back to transcribing from memory and keeping no audio at all
 *
 * A CAR investigation recorded here is people's words, verbatim. Whoever can
 * open the app can play it back, so the retention window is the real control
 * — keep it short unless there is a reason not to.
 */

const DATA_DIR = path.join(process.cwd(), "data");
const ROOT = path.join(DATA_DIR, "recordings");

export const KEEP_RECORDINGS = (process.env.KEEP_RECORDINGS || "true") !== "false";
export const RETENTION_DAYS = Number(process.env.RECORDING_RETENTION_DAYS || "90");

/** Ids come from the browser, so they are checked before touching the disk. */
function safeId(id: string): string | null {
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

function dirFor(id: string): string | null {
  const safe = safeId(id);
  return safe ? path.join(ROOT, safe) : null;
}

/** Delete recordings older than the retention window. Returns how many went. */
export function sweepOldRecordings(): number {
  if (!fs.existsSync(ROOT) || !Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  let gone = 0;
  for (const name of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    try {
      if (fs.statSync(dir).mtimeMs >= cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      gone++;
    } catch (err) {
      console.error("[recordings] sweep", name, (err as Error).message);
    }
  }
  if (gone > 0) console.log(`[recordings] ลบการบันทึกที่เก่ากว่า ${RETENTION_DAYS} วัน ${gone} รายการ`);
  return gone;
}

/** Store one piece of a recording. Returns false if nothing was written. */
export async function savePart(id: string, part: number, blob: Blob): Promise<boolean> {
  if (!KEEP_RECORDINGS) return false;
  const dir = dirFor(id);
  if (!dir || !Number.isInteger(part) || part < 0 || part > 999) return false;
  try {
    sweepOldRecordings();
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(path.join(dir, `part-${String(part).padStart(3, "0")}.webm`), buf);
    console.log(`[recordings] เก็บ ${id}/part-${part} (${(buf.length / 1048576).toFixed(2)}MB)`);
    return true;
  } catch (err) {
    console.error("[recordings] save", id, (err as Error).message);
    return false;
  }
}

export interface RecordingPart {
  part: number;
  bytes: number;
}

/** The pieces of a recording, in order. Empty when there is no recording. */
export function listParts(id: string): RecordingPart[] {
  const dir = dirFor(id);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => ({ part: Number(f.replace(/\D/g, "")), bytes: fs.statSync(path.join(dir, f)).size }))
    .filter((p) => Number.isFinite(p.part))
    .sort((a, b) => a.part - b.part);
}

/** Read one piece back, or null when it is gone. */
export function readPart(id: string, part: number): Buffer | null {
  const dir = dirFor(id);
  if (!dir || !Number.isInteger(part)) return null;
  const file = path.join(dir, `part-${String(part).padStart(3, "0")}.webm`);
  try {
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

/** Delete a whole recording now, without waiting for the retention sweep. */
export function deleteRecording(id: string): boolean {
  const dir = dirFor(id);
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[recordings] ลบการบันทึก ${id}`);
    return true;
  } catch (err) {
    console.error("[recordings] delete", id, (err as Error).message);
    return false;
  }
}
