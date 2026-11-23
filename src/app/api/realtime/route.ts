import { NextRequest, NextResponse } from "next/server";
import { buildMeetingInstructions, type AssistantMode } from "@/lib/prompts";
import { listDocuments, getDocument } from "@/lib/document-store";
import { memoryPromptBlock } from "@/lib/pornchai-memory";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FALLBACK_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const FALLBACK_VOICE = process.env.VOICE || "ash";
// Optional separate voice for the พรชัย persona (defaults to the main voice).
const PORNCHAI_VOICE = process.env.VOICE_PORNCHAI || "";
// Transcription model — switchable via .env without a code change. Options:
// gpt-4o-mini-transcribe (default), gpt-4o-transcribe, whisper-1.
const TRANSCRIBE_MODEL = process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const FETCH_TIMEOUT_MS = 30_000;
// Spoken answers run slightly fast — meetings have no time for a slow reader.
// 1.0 = normal; the API accepts 0.25–1.5.
const SPEECH_SPEED = Number(process.env.SPEECH_SPEED || "1.25");

/**
 * POST /api/realtime
 *
 * Returns an ephemeral client_secret for the browser to use when
 * establishing a WebRTC connection to OpenAI Realtime API.
 *
 * Optional body:
 *   - meetingTitle: string
 *   - participants: string[]
 *   - documentIds: string[]  — only inject these documents (the ones the
 *     client currently has loaded). Prevents stale documents left in the
 *     in-memory store from leaking into the session.
 */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY ไม่ได้ตั้งค่า" },
        { status: 500 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const meetingTitle = (body.meetingTitle as string) || undefined;
    const participants = (body.participants as string[]) || undefined;
    const documentIds = Array.isArray(body.documentIds) ? (body.documentIds as string[]) : null;
    const mode: AssistantMode =
      body.mode === "pornchai" ? "pornchai" : body.mode === "car" ? "car" : "default";
    // พรชัย is the assistant in every mode — same voice everywhere.
    const voice = PORNCHAI_VOICE || FALLBACK_VOICE;

    // Inject only the documents the client currently has loaded (by id).
    // Fall back to the whole store only if the client sent no id list.
    const source = documentIds
      ? documentIds.map((id) => getDocument(id)).filter((d): d is NonNullable<typeof d> => Boolean(d))
      : listDocuments();
    // OK-job mode: feed the compact digest (many docs, keep the payload small).
    // พรชัย mode: feed the REAL document text — meetings here have few uploaded
    // files, and summaries must come from actual content. Relying on a digest
    // here once caused the AI to fabricate an entire document summary.
    // Uploaded-document modes (พรชัย / สอบสวน CAR) get the REAL text: those
            // meetings have few files and answers must come from actual content.
    // OK-job meetings can carry ~19 WI files, so they get the compact digest
    // (the thinking brain still receives full text per question).
    const documents = source.map((d) => ({
      name: d.name,
      content:
        mode === "pornchai" || mode === "car"
          ? d.content.slice(0, 24000)
          : d.summary?.trim()
            ? d.summary
            : d.content.slice(0, 4000),
    }));

    // พรชัย carries his long-term memory into every session (ChatGPT-Memory
    // style, stored locally in data/pornchai-memory.db).
    // พรชัย carries his memory into every mode.
    let memory = "";
    try {
      memory = memoryPromptBlock();
    } catch (err) {
      console.error("[pornchai-memory]", err);
    }

    const instructions = buildMeetingInstructions({ meetingTitle, participants, documents, mode, memory });
    // Ultimate fallback if even the digests are too large: names only.
    const liteInstructions = buildMeetingInstructions({
      meetingTitle,
      participants,
      documents,
      lite: true,
      mode,
      memory,
    });

    async function createSession(instr: string) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        return await fetch("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session: {
              type: "realtime",
              model: FALLBACK_MODEL,
              instructions: instr,
              audio: {
                input: {
                  // No auto turn detection — buffer the whole segment and
                  // transcribe it at once on commit (more context = more accurate).
                  // The AI also never speaks on its own this way.
                  turn_detection: null,
                  transcription: { model: TRANSCRIBE_MODEL, language: "th" },
                },
                output: { voice, speed: SPEECH_SPEED },
              },
            },
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      console.log(`[realtime] docs=${documents.length} instructions=${instructions.length} chars`);
      let usedInstructions = instructions;
      let sessionRes = await createSession(instructions);

      // If the full (digest) payload still fails, retry with names only so the
      // meeting can always start; CAR/comment inject full content on demand.
      if (!sessionRes.ok) {
        const errBody = await sessionRes.text().catch(() => "(unreadable)");
        console.error(`[realtime-err] status=${sessionRes.status} body=${errBody} — retrying lite`);
        usedInstructions = liteInstructions;
        sessionRes = await createSession(liteInstructions);
      }

      if (!sessionRes.ok) {
        const errBody = await sessionRes.text().catch(() => "(unreadable)");
        console.error(`[realtime-err] lite retry failed status=${sessionRes.status} body=${errBody}`);
        return NextResponse.json(
          { error: "ไม่สามารถสร้าง session กับ OpenAI ได้" },
          { status: 502 },
        );
      }

      const data = await sessionRes.json();
      const ephemeralToken = data?.value;
      const sessionId = data?.session?.id;

      if (!ephemeralToken) {
        console.error("[realtime-err] no token in response", data);
        return NextResponse.json(
          { error: "ไม่สามารถสร้าง session กับ OpenAI ได้" },
          { status: 502 },
        );
      }

      return NextResponse.json({
        ephemeralToken,
        sessionId,
        model: FALLBACK_MODEL,
        sessionConfig: { instructions: usedInstructions, voice, transcribeModel: TRANSCRIBE_MODEL },
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return NextResponse.json({ error: "OpenAI request timeout" }, { status: 504 });
      }
      throw err;
    }
  } catch (error) {
    console.error("[realtime-err]", error);
    return NextResponse.json(
      { error: (error as Error).message || "Internal error" },
      { status: 500 },
    );
  }
}
