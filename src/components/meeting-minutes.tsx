"use client";

/**
 * Render an AI meeting summary as a readable minutes document:
 * numbered section headers stand out, bullet lines are indented.
 */
export function MeetingMinutes({ summary }: { summary: string }) {
  const lines = summary.split("\n").map((l) => l.replace(/\*\*/g, "").replace(/\s+$/, ""));

  return (
    <div className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 space-y-1">
      {lines.map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} className="h-2" />;

        // Section header: "1. ..." / "1) ..." or a line ending with ":"
        const isHeader = /^\d+[.)]\s/.test(t) || /[:：]$/.test(t);
        const isBullet = /^[-•*]\s/.test(t);

        if (isHeader) {
          return (
            <h5
              key={i}
              className="text-sm font-bold text-purple-700 dark:text-purple-300 pt-2 first:pt-0 border-b border-slate-200 dark:border-slate-800 pb-1"
            >
              {t}
            </h5>
          );
        }
        if (isBullet) {
          return (
            <div key={i} className="flex gap-2 text-sm text-slate-700 dark:text-slate-200 leading-relaxed pl-1">
              <span className="text-purple-600 dark:text-purple-400/70 shrink-0">•</span>
              <span>{t.replace(/^[-•*]\s/, "")}</span>
            </div>
          );
        }
        return (
          <p key={i} className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {t}
          </p>
        );
      })}
    </div>
  );
}
