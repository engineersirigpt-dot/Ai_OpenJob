"use client";

import { useState, useRef } from "react";
import { Upload, FileText, X, Loader2 } from "lucide-react";

interface DocumentInfo {
  id: string;
  name: string;
  preview: string;
  uploadedAt: string;
}

interface DocumentUploadProps {
  documents: DocumentInfo[];
  onChange: (docs: DocumentInfo[]) => void;
  disabled?: boolean;
}

export function DocumentUpload({ documents, onChange, disabled }: DocumentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-purple-400" />
          เอกสารประกอบการประชุม
        </h3>
        <span className="text-xs text-slate-500">
          {documents.length} ไฟล์
        </span>
      </div>

      {/* Document list */}
      {documents.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {documents.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-2 rounded-lg bg-slate-800/40 border border-slate-700 px-3 py-2 text-xs"
            >
              <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <span className="flex-1 truncate" title={d.name}>{d.name}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemove(d.id)}
                  className="text-slate-500 hover:text-rose-400"
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
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-purple-500/40 bg-purple-500/5 hover:bg-purple-500/10 px-3 py-2.5 text-xs font-medium text-purple-300 transition-colors disabled:opacity-50"
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
        <p className="text-xs text-rose-400">{error}</p>
      )}

      {disabled && documents.length === 0 && (
        <p className="text-xs text-slate-500 text-center py-2">
          ยังไม่มีเอกสารประกอบการประชุม
        </p>
      )}
    </div>
  );
}
