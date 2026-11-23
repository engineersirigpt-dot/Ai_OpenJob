import { NextResponse } from "next/server";
import { STT_PROMPT } from "@/lib/stt-prompt";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
/**
 * The streaming model behind the live transcript. gpt-live-transcribe is
 * Realtime-only — it answers 404 on /audio/transcriptions — and segments
 * speech itself (the session refuses turn_detection). LIVE_TRANSCRIBE=off
 * sends the browser back to the slice-and-POST path.
 */
const LIVE_MODEL = process.env.LIVE_TRANSCRIBE_MODEL || "gpt-live-transcribe";
const ENABLED = (process.env.LIVE_TRANSCRIBE || "on").toLowerCase() !== "off";

/**
 * POST /api/live-transcribe-token
 *
 * Mints a short-lived client secret for a Realtime *transcription* session,
 * with the whole session baked into it: the browser opens the WebSocket
 * with this token and streams PCM; it never sees the real API key and never
 * has to send a session.update. The response carries what the browser
 * needs to open the socket and nothing else.
 */
export async function POST() {
  if (!ENABLED) {
    return NextResponse.json({ error: "ปิดการถอดเสียงแบบสตรีมไว้ (LIVE_TRANSCRIBE=off)" }, { status: 404 });
  }
  if (!OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY ไม่ได้ตั้งค่า" }, { status: 500 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 3600 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: LIVE_MODEL,
                language: "th",
                ...(STT_PROMPT ? { prompt: STT_PROMPT } : {}),
              },
              // the model segments on its own; asking for VAD is refused
              turn_detection: null,
              noise_reduction: { type: "far_field" },
            },
          },
        },
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { value?: string; expires_at?: number; error?: { message?: string } };
    if (!res.ok || !data.value) {
      console.error("[live-transcribe-token]", res.status, data.error?.message || "");
      return NextResponse.json({ error: data.error?.message || `OpenAI ตอบ ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({
      token: data.value,
      expiresAt: data.expires_at ?? null,
      model: LIVE_MODEL,
      url: "wss://api.openai.com/v1/realtime?intent=transcription",
    });
  } catch (err) {
    console.error("[live-transcribe-token]", (err as Error).message);
    return NextResponse.json({ error: "ขอ token ไม่สำเร็จ" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
