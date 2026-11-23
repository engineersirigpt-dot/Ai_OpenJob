"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Catches a crash instead of letting the page throw the user out.
 *
 * Pressing "จบประชุม" used to look like someone hit refresh: an error during
 * the save/summary step would tear the page down with nothing to show. Now the
 * error is named on screen (so it can be reported and fixed) and the meeting is
 * still in the browser's backup, which is restored on the next load.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app-error]", error);
    try {
      localStorage.setItem(
        "lastAppError",
        JSON.stringify({
          message: error.message,
          stack: error.stack?.slice(0, 2000),
          digest: error.digest,
          at: new Date().toISOString(),
        }),
      );
    } catch {
      /* ignore */
    }
  }, [error]);

  let hasBackup = false;
  try {
    hasBackup = Boolean(localStorage.getItem("ai_openjob_pending_meeting"));
  } catch {
    /* ignore */
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-5">
        <h1 className="flex items-center gap-2 text-lg font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-5 w-5" />
          ระบบสะดุดหนึ่งจังหวะ
        </h1>
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
          {hasBackup
            ? "บทสนทนาของการประชุมถูกสำรองไว้แล้ว กดโหลดหน้าใหม่ ระบบจะบันทึกและสรุปให้ต่อเอง"
            : "กดโหลดหน้าใหม่เพื่อใช้งานต่อได้เลย"}
        </p>

        <p className="mt-3 rounded-lg bg-slate-900/80 p-3 font-mono text-[11px] text-rose-200">
          {error.message || "unknown error"}
          {error.digest ? ` · ${error.digest}` : ""}
        </p>

        <button
          type="button"
          onClick={reset}
          className="mt-4 flex items-center gap-2 rounded-full bg-rose-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-400"
        >
          <RefreshCw className="h-4 w-4" />
          โหลดหน้าใหม่
        </button>
      </div>

      <p className="text-center text-xs text-slate-500 dark:text-slate-400">
        ถ้าเจออีก ส่งข้อความสีแดงด้านบนมาให้ทีมพัฒนาดูได้เลย
      </p>
    </main>
  );
}
