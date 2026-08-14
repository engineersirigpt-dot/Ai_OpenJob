"use client";

import { useState, useRef } from "react";
import { Upload, FileText, X, Loader2, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface DocumentInfo {
  id: string;
  name: string;
  preview: string;
  uploadedAt: string;
}

interface DocumentUploadProps {
  documents: DocumentInfo[];
  onChange: (docs: DocumentInfo[]) => void;
  /** Clear all documents (server store + UI). */
  onClearAll?: () => void;
  disabled?: boolean;
}

export function DocumentUpload({ documents, onChange, onClearAll, disabled }: DocumentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Pending delete confirmation: clear-all or a single file
  const [confirm, setConfirm] = useState<{ type: "all" } | { type: "one"; id: string; name: string } | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/documents", { method: "POST", body: formData });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || `อัปโหลด ${file.name} ล้มเหลว`);
          continue;
        }
        const doc = await res.json();
        onChange([...documents, doc]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleRemove(id: string) {
    await fetch(`/api/documents?id=${id}`, { method: "DELETE" });
    onChange(documents.filter((d) => d.id !== id));
  }

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          เอกสารประกอบการประชุม
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">{documents.length} ไฟล์</span>
          {!disabled && documents.length > 0 && onClearAll && (
            <button
              type="button"
              onClick={() => setConfirm({ type: "all" })}
              className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
              title="ลบเอกสารทั้งหมด"
            >
              <Trash2 className="h-3.5 w-3.5" />
              ล้างทั้งหมด
            </button>
          )}
        </div>
      </div>

      {/* Document list */}
      {documents.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {documents.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs"
            >
              <FileText className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
              <span className="flex-1 truncate" title={d.name}>{d.name}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => setConfirm({ type: "one", id: d.id, name: d.name })}
                  className="text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                  aria-label="ลบ"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Upload button */}
      {!disabled && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,.md"
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 px-3 py-2 text-sm font-medium text-slate-700 dark:text-slate-200 transition-colors disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {uploading ? "กำลังอัปโหลด..." : "เพิ่มเอกสาร (PDF/DOCX/TXT)"}
          </button>
        </>
      )}

      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {disabled && documents.length === 0 && (
        <p className="text-xs text-slate-500 dark:text-slate-400 text-center py-2">
          ยังไม่มีเอกสารประกอบการประชุม
        </p>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.type === "all" ? "ลบเอกสารทั้งหมด?" : "ลบเอกสารนี้?"}
        message={
          confirm?.type === "all"
            ? `ลบเอกสารทั้งหมด ${documents.length} ไฟล์ออกจากการประชุม การกระทำนี้ย้อนกลับไม่ได้`
            : confirm?.type === "one"
              ? `ลบ "${confirm.name}" ออกจากการประชุม?`
              : ""
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.type === "all") onClearAll?.();
          else if (confirm?.type === "one") handleRemove(confirm.id);
          setConfirm(null);
        }}
      />
    </div>
  );
}
