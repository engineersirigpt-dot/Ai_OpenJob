"use client";

import { useState, useCallback, useRef } from "react";

export interface TranscriptTurn {
  speaker: "user" | "assistant";
  text: string;
  sequence: number;
  timestamp: string;
  itemId?: string;
}

// The Thai/English transcription model sometimes hallucinates Chinese/Japanese/
// Korean text on unclear or silent audio — strip those characters out.
function cleanTranscript(text: string): string {
  return text
    .replace(/[　-〿぀-ヿ㐀-鿿가-힯＀-￯]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

      case "response.done":
        setIsAiResponding(false);
        setLiveAiText("");
        break;

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
        sequence: sequenceRef.current++,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  // Append meeting text to the last user bubble so consecutive sentences form
  // one continuous block; start a new bubble only after the AI has spoken.
  const appendUserTurn = useCallback((raw: string) => {
    const text = cleanTranscript(raw);
    if (!text) return;
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.speaker === "user") {
        const updated = prev.slice();
        updated[updated.length - 1] = { ...last, text: `${last.text} ${text}`.trim() };
        return updated;
      }
      return [
        ...prev,
        { speaker: "user", text, sequence: sequenceRef.current++, timestamp: new Date().toISOString() },
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

  return { turns, isAiResponding, liveUserText, liveAiText, handleRealtimeEvent, addUserTurn, appendUserTurn, reset, setMergeUserMode };
}
