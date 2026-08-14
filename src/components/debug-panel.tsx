"use client";

import { X } from "lucide-react";

export interface DebugLogEntry {
  time: string;
  type: string;
  info: string;
}

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
  meetingState: string;
  connectionState: string;
  dataChannelReady: boolean;
  isAiResponding: boolean;
  micEnabled: boolean;
  turns: number;
  error: string;
  log: DebugLogEntry[];
}

function dot(ok: boolean) {
  return ok ? "🟢" : "🔴";
}

export function DebugPanel({
  open,
  onClose,
  meetingState,
  connectionState,
  dataChannelReady,
  isAiResponding,
  micEnabled,
  turns,
  error,
  log,
}: DebugPanelProps) {
  if (!open) return null;

  const connOk = connectionState === "connected" || connectionState === "completed";

  return (
    <div className="fixed bottom-3 right-3 z-[70] w-[440px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl border border-emerald-500/40 bg-black/90 backdrop-blur text-emerald-200 shadow-2xl font-mono text-[13px]">
      <div className="flex items-center justify-between border-b border-emerald-500/30 px-3 py-2">
        <span className="font-bold text-emerald-700">🐛 DEBUG</span>
        <button type="button" onClick={onClose} className="text-emerald-600 hover:text-emerald-200">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3 py-2 space-y-0.5 border-b border-emerald-500/20">
        <div>สถานะประชุม: <b>{meetingState}</b></div>
        <div>{dot(connOk)} การเชื่อมต่อ: <b>{connectionState}</b></div>
        <div>{dot(dataChannelReady)} ช่องข้อมูล: <b>{dataChannelReady ? "พร้อม" : "ไม่พร้อม"}</b></div>
        <div>AI กำลังพูด: <b>{isAiResponding ? "ใช่" : "ไม่"}</b> · ไมค์: <b>{micEnabled ? "เปิด" : "พัก"}</b> · เทิร์น: <b>{turns}</b></div>
        {error && <div className="text-rose-600">⚠ {error}</div>}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="text-emerald-500/70 mb-1">— เหตุการณ์ล่าสุด —</div>
        {log.length === 0 ? (
          <div className="text-emerald-500/50">(ยังไม่มีเหตุการณ์)</div>
        ) : (
          [...log].reverse().map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words leading-snug">
              <span className="text-emerald-500/60">{e.time}</span>{" "}
              <span className={e.type === "error" ? "text-rose-600" : "text-emerald-700"}>{e.type}</span>
              {e.info && <span className="text-amber-700"> · {e.info}</span>}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-emerald-500/30 px-3 py-1.5 text-[11px] text-emerald-500/70">
        ถ่ายรูปหน้านี้ตอนค้าง แล้วส่งให้ทีมพัฒนา
      </div>
    </div>
  );
}
