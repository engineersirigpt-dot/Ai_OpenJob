"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { MIC_GAIN, LIMITER, MIC_HPF, MIC_NOTCH, MIC_AEC, MIC_NS, MIC_AGC, MIC_DEVICE_ID } from "@/lib/mic-gain";

interface UseWebRTCOptions {
  onDataChannelMessage?: (event: MessageEvent) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
}

export interface RealtimeSessionConfig {
  instructions: string;
  voice: string;
  /** Transcription model (from server env) — used when re-applying session.update. */
  transcribeModel?: string;
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
/**
 * Lift the room before anything reads it, and hold the peaks.
 *
 * The browser's auto-gain was asked for and measurably did nothing on this
 * mic, so the gain lives here, where its value is a number we set rather
 * than a favour we request. Echo cancellation and noise suppression are
 * applied at capture, upstream of this graph, so routing through it does not
 * undo them — this only changes how loud what they produced arrives.
 *
 * On any failure the raw stream is returned unchanged. A quiet meeting is
 * bad; a silent one is worse.
 */
function amplify(raw: MediaStream, out: { ctx: AudioContext | null }): MediaStream {
  if (MIC_GAIN <= 1 && MIC_HPF <= 0 && MIC_NOTCH <= 0) return raw;
  try {
    const AC: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    void ctx.resume();
    const gain = ctx.createGain();
    gain.gain.value = MIC_GAIN;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    const dest = ctx.createMediaStreamDestination();
    // Rumble first, then gain, then the limiter — so the wind is gone before
    // it can be amplified or make the limiter duck (see MIC_HPF).
    let head: AudioNode = ctx.createMediaStreamSource(raw);
    if (MIC_HPF > 0) {
      for (let i = 0; i < 2; i++) {
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = MIC_HPF;
        hp.Q.value = 0.707;
        head = head.connect(hp);
      }
    }
    if (MIC_NOTCH > 0) {
      // The hum and its first harmonic. Q 12 is about 8 Hz wide at 100 Hz —
      // wide enough to hold the tone if the mains drifts, far too narrow to
      // touch a voice.
      for (const f of [MIC_NOTCH, MIC_NOTCH * 2]) {
        const notch = ctx.createBiquadFilter();
        notch.type = "notch";
        notch.frequency.value = f;
        notch.Q.value = 12;
        head = head.connect(notch);
      }
    }
    head.connect(gain).connect(limiter).connect(dest);
    out.ctx = ctx;
    const dB = (20 * Math.log10(MIC_GAIN)).toFixed(1);
    console.log(
      `[mic] ขยายเสียงในโปรแกรม x${MIC_GAIN} (+${dB} dB) พร้อมตัวกันพีค` +
        (MIC_HPF > 0 ? ` ตัดเสียงต่ำกว่า ${MIC_HPF} Hz` : "") +
        (MIC_NOTCH > 0 ? ` กรองฮัม ${MIC_NOTCH}/${MIC_NOTCH * 2} Hz` : ""),
    );
    return dest.stream;
  } catch (err) {
    console.error("[mic] ขยายเสียงไม่ได้ ใช้เสียงดิบต่อ:", (err as Error).message);
    return raw;
  }
}

export function useWebRTC({ onDataChannelMessage, onConnectionStateChange }: UseWebRTCOptions = {}) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  /** The mic as the browser gave it, before the gain stage — kept to stop it. */
  const rawStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  /**
   * Which microphone the browser actually handed over.
   *
   * The audio settings are chosen for the room's conference mic, which does
   * its own DSP. If Windows switches the default device — someone unplugs it,
   * or a headset connects — the browser quietly gives us the laptop's own mic
   * instead, the settings are then wrong for it, and far-field speech starts
   * disappearing with nothing on screen to say why. So the name is shown.
   */
  const [micLabel, setMicLabel] = useState("");
  const [connectionState, setConnectionState] = useState<string>("new");
  const [dataChannelReady, setDataChannelReady] = useState(false);
  const [micEnabled, setMicEnabledState] = useState(true);

  /**
   * Open a microphone and run it through the gain stage.
   *
   * Which processing to ask the browser for is decided in mic-gain.ts, next
   * to the gain stage and the speech gate, with the measurements that chose
   * each value. The short version: echo cancellation on, noise suppression
   * off, auto-gain asked for but not relied on. The browser's own storage
   * can override any of them for a test in the real room.
   *
   * `deviceId` is the room's chosen mic. If it cannot be opened — unplugged,
   * or a stale id — the default device is opened instead and its name is
   * shown, so a silent fallback is never silent.
   */
  const openMic = useCallback(async (deviceId: string): Promise<MediaStream> => {
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: MIC_AEC,
      noiseSuppression: MIC_NS,
      autoGainControl: MIC_AGC,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    console.log(
      `[mic] AEC=${audioConstraints.echoCancellation} NS=${audioConstraints.noiseSuppression} ` +
        `AGC=${audioConstraints.autoGainControl}` + (deviceId ? ` อุปกรณ์ที่เลือกไว้=${deviceId.slice(0, 8)}…` : ""),
    );
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      console.warn("[mic] เปิดไมค์ตามที่ตั้งไว้ไม่ได้ ใช้ไมค์เริ่มต้นแทน:", (err as Error).message);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    // The previous raw stream, if any, is released by the caller once the
    // new one is in place.
    const track = stream.getAudioTracks()[0];
    const label = track?.label || "";
    setMicLabel(label);
    console.log(`[mic] ใช้งาน: ${label || "ไม่ทราบชื่ออุปกรณ์"}`);
    // What was granted, next to what was asked for. Chrome accepts a
    // constraint a device will not honour and says nothing, and that is
    // exactly how two recordings came back 0.3 dB apart with auto-gain
    // requested and not requested. Now the difference is visible.
    const got = track?.getSettings?.() as
      | (MediaTrackSettings & { autoGainControl?: boolean; noiseSuppression?: boolean })
      | undefined;
    if (got) {
      console.log(
        `[mic] ที่ได้จริง: AEC=${got.echoCancellation} NS=${got.noiseSuppression} ` +
          `AGC=${got.autoGainControl} rate=${got.sampleRate}`,
      );
    }
    // Everything downstream — the recorder, the live gate, the realtime
    // connection — reads this one stream, so the gain is applied once here.
    const holder: { ctx: AudioContext | null } = { ctx: null };
    const feed = amplify(stream, holder);
    const oldRaw = rawStreamRef.current;
    const oldCtx = audioCtxRef.current;
    rawStreamRef.current = stream;
    audioCtxRef.current = holder.ctx;
    localStreamRef.current = feed;
    setLocalStream(feed);
    oldRaw?.getTracks().forEach((t) => t.stop());
    oldCtx?.close().catch(() => {});
    return feed;
  }, []);

  /**
   * Change microphone in the middle of a meeting.
   *
   * The new mic is opened, the live connection's sender is pointed at its
   * track, and the new stream is published — the recorder and the live
   * gate pick it up as the same meeting (page.tsx keeps what was recorded).
   * The choice is remembered for next time.
   */
  const switchMic = useCallback(async (deviceId: string) => {
    try {
      localStorage.setItem("micDeviceId", deviceId);
    } catch {
      // a private window: the choice lasts for this session only
    }
    const feed = await openMic(deviceId);
    const track = feed.getAudioTracks()[0];
    const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === "audio");
    if (sender && track) await sender.replaceTrack(track);
    track.enabled = micEnabled;
    rawStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = micEnabled;
    });
  }, [openMic, micEnabled]);

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
      console.log("[webrtc] connection state:", state);
      setConnectionState(state);
      onConnectionStateChange?.(state);
    };
    pc.oniceconnectionstatechange = () => {
      console.log("[webrtc] ICE state:", pc.iceConnectionState);
    };

    // Data channel for events
    const dc = pc.createDataChannel("oai-events", { ordered: true });
    dcRef.current = dc;

    dc.onopen = () => setDataChannelReady(true);
    dc.onclose = () => setDataChannelReady(false);
    dc.onmessage = (e) => onDataChannelMessage?.(e);

    // Microphone (user/room audio) — see openMic for what is asked of it.
    const feed = await openMic(MIC_DEVICE_ID);
    feed.getTracks().forEach((t) => pc.addTrack(t, feed));
    setMicEnabledState(true);

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
  }, [onDataChannelMessage, onConnectionStateChange, openMic]);

  const sendEvent = useCallback((payload: Record<string, unknown>) => {
    if (dcRef.current?.readyState === "open") {
      dcRef.current.send(JSON.stringify(payload));
    }
  }, []);

  /** Pause/resume the microphone without dropping the connection. */
  const setMicEnabled = useCallback((enabled: boolean) => {
    // Both ends of the gain stage: the raw track keeps the room out of it,
    // and the amplified track is the one the peer connection and the
    // recorder actually read.
    for (const s of [rawStreamRef.current, localStreamRef.current]) {
      s?.getAudioTracks().forEach((t) => {
        t.enabled = enabled;
      });
    }
    setMicEnabledState(enabled);
  }, []);

  const disconnect = useCallback(() => {
    rawStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
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
    setMicEnabled,
    switchMic,
    micEnabled,
    remoteStream,
    localStream,
    micLabel,
    connectionState,
    dataChannelReady,
  };
}
