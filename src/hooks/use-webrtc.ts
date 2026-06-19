"use client";

import { useRef, useState, useCallback, useEffect } from "react";

interface UseWebRTCOptions {
  onDataChannelMessage?: (event: MessageEvent) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
}

export interface RealtimeSessionConfig {
  instructions: string;
  voice: string;
}

interface RealtimeConnectResponse {
  ephemeralToken: string;
  sessionId?: string;
  model: string;
  sessionConfig: RealtimeSessionConfig;
}

/**
 * WebRTC connection to OpenAI Realtime API (GA flow).
 *
 * Flow:
 *   1. GET ephemeral token from /api/realtime
 *   2. Create SDP offer + microphone track
 *   3. POST SDP to https://api.openai.com/v1/realtime/calls
 *   4. Receive answer, set remote description → connection live
 */
export function useWebRTC({ onDataChannelMessage, onConnectionStateChange }: UseWebRTCOptions = {}) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<string>("new");
  const [dataChannelReady, setDataChannelReady] = useState(false);

  const connect = useCallback(async (body?: Record<string, unknown>) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // Remote audio (AI speaks)
    const remoteAudio = new MediaStream();
    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach((t) => remoteAudio.addTrack(t));
      setRemoteStream(remoteAudio);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setConnectionState(state);
      onConnectionStateChange?.(state);
    };

    // Data channel for events
    const dc = pc.createDataChannel("oai-events", { ordered: true });
    dcRef.current = dc;

    dc.onopen = () => setDataChannelReady(true);
    dc.onclose = () => setDataChannelReady(false);
    dc.onmessage = (e) => onDataChannelMessage?.(e);

    // Microphone (user/room audio)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStreamRef.current = stream;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    // Step 1: ephemeral token
    const tokenRes = await fetch("/api/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(err.error || `HTTP ${tokenRes.status}`);
    }
    const data = (await tokenRes.json()) as RealtimeConnectResponse;

    // Step 2: SDP offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Step 3: send SDP directly to OpenAI with ephemeral token (GA flow)
    const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.ephemeralToken}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!sdpRes.ok) {
      const errBody = await sdpRes.text().catch(() => "");
      throw new Error(`OpenAI SDP error: ${sdpRes.status} ${errBody}`);
    }

    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    return data.sessionConfig;
  }, [onDataChannelMessage, onConnectionStateChange]);

  const sendEvent = useCallback((payload: Record<string, unknown>) => {
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const disconnect = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    setRemoteStream(null);
    setConnectionState("closed");
    setDataChannelReady(false);
  }, []);

  useEffect(() => {
    return () => { disconnect(); };
  }, [disconnect]);

  return {
    connect,
    disconnect,
    sendEvent,
    remoteStream,
    connectionState,
    dataChannelReady,
  };
}
