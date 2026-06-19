"use client";

import { useState, useCallback, useRef } from "react";

export interface TranscriptTurn {
  speaker: "user" | "assistant";
  text: string;
  sequence: number;
  timestamp: string;
  itemId?: string;
}

export function useTranscript() {
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [isAiResponding, setIsAiResponding] = useState(false);
  const [liveUserText, setLiveUserText] = useState("");
  const [liveAiText, setLiveAiText] = useState("");
  const aiBufferRef = useRef<Map<string, string>>(new Map());
  const userBufferRef = useRef<Map<string, string>>(new Map());
  const sequenceRef = useRef(0);

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
          setLiveUserText(next);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = data.transcript as string;
        const itemId = data.item_id as string;
        const text = transcript || userBufferRef.current.get(itemId || "") || "";
        if (text.trim()) {
          const seq = sequenceRef.current++;
          setTurns((prev) => [
            ...prev,
            {
              speaker: "user",
              text: text.trim(),
              sequence: seq,
              timestamp: new Date().toISOString(),
              itemId: itemId || undefined,
            },
          ]);
        }
        if (itemId) userBufferRef.current.delete(itemId);
        setLiveUserText("");
        break;
      }
    }
  }, []);

  const reset = useCallback(() => {
    setTurns([]);
    setIsAiResponding(false);
    setLiveUserText("");
    setLiveAiText("");
    aiBufferRef.current.clear();
    userBufferRef.current.clear();
    sequenceRef.current = 0;
  }, []);

  return { turns, isAiResponding, liveUserText, liveAiText, handleRealtimeEvent, reset };
}
