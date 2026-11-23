/**
 * The browser's side of a Realtime transcription session.
 *
 * The live transcript used to be made by cutting the room's audio at pauses
 * and POSTing each slice: ten seconds of speech, then a round trip, then the
 * sentence on screen. gpt-live-transcribe hears a continuous stream and
 * writes while the room is still talking — the words appear as they are
 * said — and it decided, in a side by side on the room's own audio, to echo
 * no prompt and invent no language. This class streams the room to it.
 *
 * What goes over the socket: PCM16 at 24 kHz, appended as it is captured;
 * a `commit` whenever the caller wants the segment so far closed into one
 * finished piece of transcript. The model streams partial text between
 * commits (`onPartial`) and the finished text at each commit (`onSegment`).
 * The token comes from /api/live-transcribe-token and carries the whole
 * session configuration, so nothing is sent here but audio and commits.
 */

const OUT_RATE = 24000;

export interface LiveTranscribeHandlers {
  /** Text so far for the open segment — grows as the room talks. */
  onPartial: (text: string) => void;
  /** A finished segment, after a commit. */
  onSegment: (text: string) => void;
  /** The socket is gone, by error or by close. Not called after close(). */
  onClosed: (reason: string) => void;
}

export class LiveTranscribeClient {
  private ws: WebSocket | null = null;
  private partial = "";
  private closedByUs = false;
  private pendingCommits = 0;
  /** Samples left over from the previous frame's decimation. */
  private carry: Float32Array<ArrayBufferLike> = new Float32Array(0);

  constructor(private readonly handlers: LiveTranscribeHandlers) {}

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Mint a token and open the socket. Rejects when either fails. */
  async open(): Promise<{ model: string }> {
    const res = await fetch("/api/live-transcribe-token", { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || `token HTTP ${res.status}`);
    }
    const { token, url, model } = (await res.json()) as { token: string; url: string; model: string };

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, ["realtime", `openai-insecure-api-key.${token}`]);
      let settled = false;
      ws.onopen = () => {
        settled = true;
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("websocket error"));
        }
      };
      ws.onclose = (e) => {
        if (!settled) {
          settled = true;
          reject(new Error(`closed ${e.code} ${e.reason}`));
          return;
        }
        this.ws = null;
        if (!this.closedByUs) this.handlers.onClosed(`${e.code} ${e.reason || ""}`.trim());
      };
      ws.onmessage = (e) => this.handleMessage(e.data as string);
      this.ws = ws;
    });
    return { model };
  }

  private handleMessage(raw: string) {
    let m: { type?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.type) {
      case "conversation.item.input_audio_transcription.delta":
        this.partial += m.delta || "";
        this.handlers.onPartial(this.partial);
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const text = (m.transcript || this.partial).trim();
        this.partial = "";
        this.pendingCommits = Math.max(0, this.pendingCommits - 1);
        this.handlers.onPartial("");
        if (text) this.handlers.onSegment(text);
        break;
      }
      case "error":
        console.error("[live-stt]", m.error?.message || raw.slice(0, 200));
        break;
      default:
        break;
    }
  }

  /**
   * Stream one captured frame. `inRate` is the capture rate (the mic's
   * AudioContext); the frame is decimated to 24 kHz with a short low-pass so
   * the model is not fed aliasing, then sent as PCM16.
   */
  send(frame: Float32Array, inRate: number): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const pcm = this.toPcm16(frame, inRate);
    if (pcm.length === 0) return;
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64(pcm) }));
  }

  /** Close the segment so far; the finished text arrives through onSegment. */
  commit(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.pendingCommits += 1;
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  /** How many commits are still waiting for their finished text. */
  get busy(): boolean {
    return this.pendingCommits > 0;
  }

  close(): void {
    this.closedByUs = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already gone
    }
  }

  private toPcm16(frame: Float32Array, inRate: number): Int16Array {
    const ratio = inRate / OUT_RATE;
    if (ratio <= 1) return float2int(frame);
    // Prepend the carry so the running average never drops samples at the
    // frame edge; take `ratio` input samples per output sample (integer for
    // 48 kHz; fractional rates are handled by rounding the window).
    const input = concat(this.carry, frame);
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const from = Math.round(i * ratio);
      const to = Math.min(input.length, Math.round((i + 1) * ratio));
      let acc = 0;
      for (let k = from; k < to; k++) acc += input[k];
      const v = to > from ? acc / (to - from) : 0;
      out[i] = v < 0 ? Math.max(-1, v) * 0x8000 : Math.min(1, v) * 0x7fff;
    }
    this.carry = input.subarray(Math.round(outLen * ratio));
    return out;
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function float2int(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    out[i] = v < 0 ? Math.max(-1, v) * 0x8000 : Math.min(1, v) * 0x7fff;
  }
  return out;
}

function base64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}
