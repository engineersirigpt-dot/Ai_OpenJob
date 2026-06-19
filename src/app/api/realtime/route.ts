import { NextRequest, NextResponse } from "next/server";
import { buildMeetingInstructions } from "@/lib/prompts";
import { listDocuments } from "@/lib/document-store";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FALLBACK_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const FALLBACK_VOICE = process.env.VOICE || "ash";
const FETCH_TIMEOUT_MS = 30_000;

/**
 * POST /api/realtime
 *
 * Returns an ephemeral client_secret for the browser to use when
 * establishing a WebRTC connection to OpenAI Realtime API.
 *
 * Optional body:
 *   - meetingTitle: string
 *   - participants: string[]
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

    // Load uploaded documents
    const documents = listDocuments().map((d) => ({ name: d.name, content: d.content }));

    const instructions = buildMeetingInstructions({
      meetingTitle,
      participants,
      documents,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const sessionRes = await fetch(
        "https://api.openai.com/v1/realtime/client_secrets",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session: {
              type: "realtime",
              model: FALLBACK_MODEL,
              instructions,
              audio: {
                input: {
                  turn_detection: null,
                  transcription: { model: "gpt-4o-mini-transcribe", language: "th" },
                },
                output: { voice: FALLBACK_VOICE },
              },
            },
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timer);

      if (!sessionRes.ok) {
        const errBody = await sessionRes.text().catch(() => "(unreadable)");
        console.error(`[realtime-err] status=${sessionRes.status} body=${errBody}`);
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
        sessionConfig: { instructions, voice: FALLBACK_VOICE },
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        return NextResponse.json(
          { error: "OpenAI request timeout" },
          { status: 504 },
        );
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
