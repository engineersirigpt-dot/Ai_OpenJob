"use client";

import { keepThaiOnly, isForeignHallucination } from "@/lib/thai-text";

import { useState, useCallback, useRef } from "react";

export interface TranscriptTurn {
  speaker: "user" | "assistant";
  text: string;
  sequence: number;
  timestamp: string;
  itemId?: string;
  /** Who spoke, when the recording could tell them apart ("ผู้ประชุม A"). */
  label?: string;
  /** "room" = overheard speech (rough, hidden on screen); "ask" = asked of พรชัย. */
  kind?: "room" | "ask";
}

// The Thai/English transcription model sometimes hallucinates Chinese/Japanese/
// Korean text on unclear or silent audio — strip those characters out.
function cleanTranscript(text: string): string {
  const cleaned = keepThaiOnly(text).replace(/\s+/g, " ").trim();
  // a whole segment in another language never reaches the screen
  if (!cleaned || isForeignHallucination(cleaned)) return "";
  return cleaned;
}

export function useTranscript() {
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [isAiResponding, setIsAiResponding] = useState(false);
  const [liveUserText, setLiveUserText] = useState("");
  const [liveAiText, setLiveAiText] = useState("");
  const aiBufferRef = useRef<Map<string, string>>(new Map());
  const userBufferRef = useRef<Map<string, string>>(new Map());
  const sequenceRef = useRef(0);
  // When true, the next user transcription is appended to the last user bubble
  // (used by "แสดงข้อความที่พูด" to keep one continuous transcript).
  const mergeUserRef = useRef(false);

  const setMergeUserMode = useCallback((v: boolean) => {
    mergeUserRef.current = v;
  }, []);

  const handleRealtimeEvent = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    switch (type) {
      case "response.created":
        setIsAiResponding(true);
        setLiveAiText("");
        break;

      case "response.output_item.added": {
        const item = data.item as { id?: string };
        if (item?.id) aiBufferRef.current.set(item.id, "");
        break;
      }

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const delta = data.delta as string;
        const itemId = data.item_id as string;
        if (itemId && delta) {
          const prev = aiBufferRef.current.get(itemId) || "";
          const next = prev + delta;
          aiBufferRef.current.set(itemId, next);
          setLiveAiText(next);
        }
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript = data.transcript as string;
        const itemId = data.item_id as string;
        const text = transcript || aiBufferRef.current.get(itemId || "") || "";
        if (text.trim()) {
          const seq = sequenceRef.current++;
          setTurns((prev) => [
            ...prev,
            {
              speaker: "assistant",
              text: text.trim(),
              sequence: seq,
              timestamp: new Date().toISOString(),
              itemId: itemId || undefined,
            },
          ]);
        }
        if (itemId) aiBufferRef.current.delete(itemId);
        setLiveAiText("");
        break;
      }

      case "response.done": {
        // A cancelled response never sends transcript.done — flush whatever
        // partial text arrived so the cut-off answer stays in the record.
        const leftovers = Array.from(aiBufferRef.current.entries()).filter(([, t]) => t.trim());
        if (leftovers.length > 0) {
          setTurns((prev) => [
            ...prev,
            ...leftovers.map(([itemId, text]) => ({
              speaker: "assistant" as const,
              text: text.trim() + " …",
              sequence: sequenceRef.current++,
              timestamp: new Date().toISOString(),
              itemId: itemId || undefined,
            })),
          ]);
        }
        aiBufferRef.current.clear();
        setIsAiResponding(false);
        setLiveAiText("");
        break;
      }

      case "conversation.item.input_audio_transcription.delta": {
        const delta = data.delta as string;
        const itemId = data.item_id as string;
        if (itemId && delta) {
          const prev = userBufferRef.current.get(itemId) || "";
          const next = prev + delta;
          userBufferRef.current.set(itemId, next);
          setLiveUserText(cleanTranscript(next));
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = data.transcript as string;
        const itemId = data.item_id as string;
        const text = cleanTranscript(transcript || userBufferRef.current.get(itemId || "") || "");
        if (text) {
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            // Append to the previous user bubble when in merge mode
            if (mergeUserRef.current && last && last.speaker === "user") {
              const updated = prev.slice();
              updated[updated.length - 1] = {
                ...last,
                text: `${last.text} ${text}`.trim(),
              };
              return updated;
            }
            return [
              ...prev,
              {
                speaker: "user",
                text,
                sequence: sequenceRef.current++,
                timestamp: new Date().toISOString(),
                itemId: itemId || undefined,
              },
            ];
          });
        }
        if (itemId) userBufferRef.current.delete(itemId);
        setLiveUserText("");
        break;
      }
    }
  }, []);

  // Append a user turn coming from the external ASR service. Each finished
  // sentence becomes its own bubble.
  const addUserTurn = useCallback((raw: string) => {
    const text = cleanTranscript(raw);
    if (!text) return;
    setTurns((prev) => [
      ...prev,
      {
        speaker: "user",
        text,
        kind: "ask",
        sequence: sequenceRef.current++,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  /**
   * Add the transcript of one recorded stretch (the record of what was said).
   * These come back every ~30 seconds, already cleaned by the server.
   */
  const addRoomTurns = useCallback((items: { text: string; label?: string }[]) => {
    const rows = items
      .map((it) => ({ text: cleanTranscript(it.text), label: it.label }))
      .filter((it) => it.text);
    if (rows.length === 0) return;
    // Room speech keeps flowing into one block; only a question or an answer
    // starts a new one. The limit is just a guard against a runaway bubble.
    const MERGE_LIMIT = 6000;
    setTurns((prev) => {
      const next = prev.slice();
      for (const r of rows) {
        const last = next[next.length - 1];
        // A labelled row (a confirm marker) is its own block and ends the
        // one before it, so each job's talk sits in its own bubble under
        // its own card instead of running on through the marker.
        const continues =
          last &&
          last.kind === "room" &&
          !last.label &&
          !r.label &&
          last.text.length + r.text.length < MERGE_LIMIT;
        if (continues) {
          next[next.length - 1] = { ...last, text: `${last.text} ${r.text}`.trim() };
        } else {
          next.push({
            speaker: "user" as const,
            text: r.text,
            kind: "room" as const,
            ...(r.label ? { label: r.label } : {}),
            sequence: sequenceRef.current++,
            timestamp: new Date().toISOString(),
          });
        }
      }
      return next;
    });
  }, []);

  /**
   * Swap the rough live transcript for the accurate one.
   *
   * While the meeting runs, the room reads text from the quick live slices.
   * When it ends, the recording is transcribed in one pass — far better text —
   * and that becomes the record: every room block collapses into one, in the
   * place the first one held, so the questions and answers around it keep
   * their order.
   */
  const replaceRoomTranscript = useCallback((text: string) => {
    const clean = cleanTranscript(text);
    if (!clean) return;
    setTurns((prev) => {
      const at = prev.findIndex((t) => t.kind === "room");
      const kept = prev.filter((t) => t.kind !== "room");
      const block = {
        speaker: "user" as const,
        text: clean,
        kind: "room" as const,
        sequence: sequenceRef.current++,
        timestamp: new Date().toISOString(),
      };
      if (at < 0) return [block, ...kept];
      const before = prev.slice(0, at).filter((t) => t.kind !== "room");
      const after = prev.slice(at).filter((t) => t.kind !== "room");
      return [...before, block, ...after];
    });
  }, []);

  // Append meeting text to the last user bubble so consecutive sentences form
  // one continuous block; start a new bubble only after the AI has spoken.
  const appendUserTurn = useCallback((raw: string) => {
    const text = cleanTranscript(raw);
    if (!text) return;
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.speaker === "user" && last.kind !== "ask") {
        const updated = prev.slice();
        updated[updated.length - 1] = { ...last, text: `${last.text} ${text}`.trim() };
        return updated;
      }
      return [
        ...prev,
        {
          speaker: "user",
          text,
          kind: "room",
          sequence: sequenceRef.current++,
          timestamp: new Date().toISOString(),
        },
      ];
    });
  }, []);

  const reset = useCallback(() => {
    setTurns([]);
    setIsAiResponding(false);
    setLiveUserText("");
    setLiveAiText("");
    aiBufferRef.current.clear();
    userBufferRef.current.clear();
    sequenceRef.current = 0;
    mergeUserRef.current = false;
  }, []);

  return {
    turns,
    isAiResponding,
    liveUserText,
    /** The streaming transcriber writes its partial text here as the room talks. */
    setLiveUserText,
    liveAiText,
    handleRealtimeEvent,
    addUserTurn,
    appendUserTurn,
    addRoomTurns,
    replaceRoomTranscript,
    reset,
    setMergeUserMode,
  };
}
