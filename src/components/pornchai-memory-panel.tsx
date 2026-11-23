"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Brain,
  Plus,
  Search,
  Trash2,
  Loader2,
  RefreshCw,
  Link2,
  MessageSquarePlus,
  Folder,
  FolderOpen,
  ChevronLeft,
  Sparkles,
  CheckSquare,
  Square,
  FolderInput,
} from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface MemoryEntry {
  id: string;
  text: string;
  source: string;
  /** The folder it is filed under; empty until it has been organized. */
  topic: string;
  createdAt: string;
}

/** Shown as the folder name for memories with no topic yet. */
const UNFILED = "ยังไม่จัดหมวด";

interface RagStats {
  files: number;
  chunks: number;
}

/** One memory, with a tick box so several can be acted on at once. */
function MemoryList({
  items,
  selected,
  onToggle,
  onDelete,
  showTopic = false,
  emptyText,
}: {
  items: MemoryEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onDelete: (m: MemoryEntry) => void;
  showTopic?: boolean;
  emptyText: string;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">{emptyText}</p>
    );
  }
  return (
    <div className="space-y-1.5">
      {items.map((m) => {
        const ticked = selected.has(m.id);
        return (
          <div
            key={m.id}
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
              ticked
                ? "border-purple-500/50 bg-purple-500/5"
                : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
            }`}
          >
            <button
              type="button"
              onClick={() => onToggle(m.id)}
              className="mt-0.5 shrink-0 text-slate-400 hover:text-purple-600 dark:hover:text-purple-400"
              aria-label={ticked ? "เอาออกจากที่เลือก" : "เลือกความจำนี้"}
            >
              {ticked ? (
                <CheckSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              ) : (
                <Square className="h-4 w-4" />
              )}
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-800 dark:text-slate-100 leading-relaxed">{m.text}</p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">
                {showTopic && (
                  <span className="text-purple-600 dark:text-purple-400">
                    {m.topic || UNFILED} ·{" "}
                  </span>
                )}
                {m.source || "ไม่ระบุที่มา"}
                {m.createdAt
                  ? ` · ${new Date(m.createdAt).toLocaleDateString("th-TH", { dateStyle: "medium" })}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onDelete(m)}
              className="text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 shrink-0 mt-0.5"
              aria-label="ลบความจำ"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** พรชัย memory manager: view / search / add / delete long-term memories. */
export function PornchaiMemoryPanel() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [newText, setNewText] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<MemoryEntry | null>(null);
  // Folder view: null means the grid of folders, a string means that folder.
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [organizing, setOrganizing] = useState(false);
  const [organizeMsg, setOrganizeMsg] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);
  // Which of the page's own menu entries is showing.
  const [view, setView] = useState<"folders" | "add" | "rag">("folders");

  // Chat knowledge base (RAG) — add via share link or pasted text
  const [ragStats, setRagStats] = useState<RagStats | null>(null);
  const [chatLink, setChatLink] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [chatText, setChatText] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState("");

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/pornchai-rag");
      if (res.ok) setRagStats(await res.json());
    } catch {
      /* stats are cosmetic */
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Save a chat (name+text) permanently into the knowledge base and re-index.
  async function ingestChat(name: string, text: string) {
    const res = await fetch("/api/pornchai-rag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "บันทึกเข้าคลังไม่สำเร็จ");
    setRagStats(data.stats || null);
    const added = Array.isArray(data.ingested) ? data.ingested.length : 0;
    setIngestMsg(
      added > 0
        ? `เพิ่มเข้าคลังแล้ว ${added} ไฟล์ (${data.chunks} ท่อน, ความจำใหม่ ${data.memoriesAdded} ข้อ)`
        : "ไฟล์นี้อยู่ในคลังอยู่แล้ว (เนื้อหาไม่เปลี่ยน)",
    );
    await load();
  }

  async function handleIngestLink() {
    const url = chatLink.trim();
    if (!url) return;
    setIngesting(true);
    setIngestMsg("");
    setError("");
    try {
      const res = await fetch("/api/chat-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "อ่านลิงก์ไม่สำเร็จ");
      await ingestChat(data.name || "chat", data.text);
      setChatLink("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIngesting(false);
    }
  }

  async function handleIngestText() {
    const text = chatText.trim();
    if (!text) return;
    setIngesting(true);
    setIngestMsg("");
    setError("");
    try {
      await ingestChat(chatTitle.trim() || "แชทเพิ่มเอง", text);
      setChatTitle("");
      setChatText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIngesting(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pornchai-memory");
      if (!res.ok) throw new Error("โหลดไม่สำเร็จ");
      const data = await res.json();
      const list: MemoryEntry[] = Array.isArray(data) ? data : data.memories || [];
      // newest first for browsing
      setMemories([...list].reverse());
      setSelected(new Set());
    } catch {
      setError("โหลดความจำไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    const text = newText.trim();
    if (!text) return;
    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/pornchai-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error();
      setNewText("");
      await load();
    } catch {
      setError("เพิ่มความจำไม่สำเร็จ");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/pornchai-memory?id=${id}`, { method: "DELETE" });
      setMemories((ms) => ms.filter((m) => m.id !== id));
    } catch {
      setError("ลบไม่สำเร็จ");
    }
  }

  /** Forget everything ticked, in one request. */
  async function handleDeleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      const res = await fetch("/api/pornchai-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", ids }),
      });
      if (!res.ok) throw new Error();
      setMemories((ms) => ms.filter((m) => !selected.has(m.id)));
      setSelected(new Set());
    } catch {
      setError("ลบไม่สำเร็จ");
    }
  }

  /** Move everything ticked into a folder. */
  async function handleMoveSelected(topic: string) {
    const ids = [...selected];
    if (ids.length === 0 || !topic) return;
    try {
      const res = await fetch("/api/pornchai-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", ids, topic }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("ย้ายไม่สำเร็จ");
    }
  }

  /** Let the model file the memories that have no folder yet. */
  async function handleOrganize(all: boolean) {
    setOrganizing(true);
    setOrganizeMsg("");
    setError("");
    try {
      const ids = all ? memories.map((m) => m.id) : undefined;
      const res = await fetch("/api/pornchai-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "organize", ids }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { filed?: number; topics?: string[] };
      setOrganizeMsg(
        data.filed
          ? `จัดเข้าโฟลเดอร์แล้ว ${data.filed} ข้อ (${(data.topics || []).length} หมวด)`
          : "ไม่มีข้อไหนต้องจัดเพิ่ม",
      );
      await load();
    } catch {
      setError("จัดโฟลเดอร์ไม่สำเร็จ");
    } finally {
      setOrganizing(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const q = query.trim().toLowerCase();
  const matches = q
    ? memories.filter(
        (m) => m.text.toLowerCase().includes(q) || (m.source || "").toLowerCase().includes(q),
      )
    : memories;

  // Folders are built from the memories on screen, so a search narrows them.
  const folders = (() => {
    const counts = new Map<string, number>();
    for (const m of matches) {
      const key = m.topic || UNFILED;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic, "th"));
  })();
  const allFolders = folders.map((f) => f.topic);

  // Searching shows every match at once; otherwise show the open folder.
  const shown = q ? matches : openTopic === null ? [] : matches.filter((m) => (m.topic || UNFILED) === openTopic);
  const unfiled = memories.filter((m) => !m.topic).length;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Brain className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          ความจำพรชัย
          <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
            ({memories.length} ข้อ)
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            โหลดใหม่
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        {/* The page's own menu: browsing on top, the things that add to the
            bank below it, and the filing tools at the bottom. */}
        <aside className="w-full sm:w-52 shrink-0 space-y-1">
          {(
            [
              ["folders", "โฟลเดอร์ความจำ", `${memories.length} ข้อ`],
              ["add", "เพิ่มความจำ", ""],
              ["rag", "คลังความรู้ (แชทเก่า)", ragStats ? `${ragStats.files} ไฟล์` : ""],
            ] as Array<[typeof view, string, string]>
          ).map(([key, label, hint]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition ${
                view === key
                  ? "bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/40"
                  : "border border-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60"
              }`}
            >
              <span>{label}</span>
              {hint && (
                <span className="text-[10.5px] font-normal text-slate-400 dark:text-slate-500">
                  {hint}
                </span>
              )}
            </button>
          ))}

          <div className="!mt-3 border-t border-slate-200 dark:border-slate-800 pt-3 space-y-1.5">
            <button
              type="button"
              onClick={() => handleOrganize(false)}
              disabled={organizing || memories.length === 0}
              title="ให้พรชัยจัดความจำที่ยังไม่มีโฟลเดอร์ โดยใช้โฟลเดอร์ที่มีอยู่ก่อน"
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-purple-500 hover:bg-purple-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs font-semibold text-white"
            >
              {organizing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              จัดด้วย AI
              {unfiled > 0 && !organizing ? ` (${unfiled})` : ""}
            </button>
            <button
              type="button"
              onClick={() => handleOrganize(true)}
              disabled={organizing || memories.length === 0}
              title="จัดใหม่ทั้งคลัง รวมข้อที่มีโฟลเดอร์อยู่แล้ว"
              className="flex w-full items-center justify-center rounded-xl border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs font-semibold text-purple-700 dark:text-purple-200"
            >
              จัดใหม่ทั้งคลัง
            </button>
          </div>
        </aside>

        <div className="flex-1 min-w-0 space-y-3">
          {view === "add" ? (
            <>
          {/* Add a memory */}
          <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
            <label className="text-xs font-medium text-purple-700 dark:text-purple-300">
              เพิ่มความจำใหม่ (พรชัยจะจำไปใช้ทุกการประชุม)
            </label>
            <div className="flex items-start gap-2">
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                rows={2}
                placeholder="เช่น: เฮียชอบให้ตอบสั้นๆ ตรงประเด็น / โปรเจกต์ X มีกำหนดส่งเดือนหน้า"
                className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-purple-500/50 resize-y"
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={adding || !newText.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-purple-500 hover:bg-purple-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-sm font-semibold text-white shrink-0"
              >
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                เพิ่ม
              </button>
            </div>
          </div>
            </>
          ) : view === "rag" ? (
            <>
          {/* Chat knowledge base (permanent RAG) */}
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
                <MessageSquarePlus className="h-3.5 w-3.5" />
                เพิ่มแชทเก่าเข้าคลังความรู้ถาวร (พรชัยค้นใช้ตอบได้ตลอด)
              </label>
              {ragStats && (
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  คลังตอนนี้: {ragStats.files} ไฟล์ / {ragStats.chunks} ท่อน
                </span>
              )}
            </div>

            {/* From a ChatGPT share link */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={chatLink}
                onChange={(e) => setChatLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleIngestLink();
                  }
                }}
                placeholder="วางลิงก์แชท ChatGPT (chatgpt.com/share/...)"
                className="flex-1 px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500/50"
              />
              <button
                type="button"
                onClick={handleIngestLink}
                disabled={ingesting || !chatLink.trim()}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-200 shrink-0"
              >
                {ingesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                เก็บเข้าคลัง
              </button>
            </div>

            {/* Or paste the chat text directly */}
            <details className="group">
              <summary className="text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer hover:text-slate-700 dark:hover:text-slate-200">
                หรือวางข้อความแชทเอง (กดเปิด)
              </summary>
              <div className="mt-2 space-y-2">
                <input
                  type="text"
                  value={chatTitle}
                  onChange={(e) => setChatTitle(e.target.value)}
                  placeholder="ตั้งชื่อเรื่อง เช่น คุยเรื่องแผนการตลาด 2027"
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500/50"
                />
                <textarea
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  rows={5}
                  placeholder="วางเนื้อหาแชททั้งหมดที่นี่..."
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-emerald-500/50 resize-y"
                />
                <button
                  type="button"
                  onClick={handleIngestText}
                  disabled={ingesting || !chatText.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 text-xs font-semibold text-white"
                >
                  {ingesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  บันทึกเข้าคลัง
                </button>
              </div>
            </details>

            {ingestMsg && (
              <p className="text-xs text-emerald-700 dark:text-emerald-300">{ingestMsg}</p>
            )}
          </div>
            </>
          ) : (
            <>
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาความจำ... (เช่น CAR, ERP, เงินเดือน)"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-purple-500/50"
            />
          </div>
          {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
          {organizeMsg && (
            <p className="text-xs text-purple-700 dark:text-purple-300">{organizeMsg}</p>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              กำลังโหลดความจำ...
            </div>
          ) : memories.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">ยังไม่มีความจำ</p>
          ) : q ? (
            /* Searching looks across every folder at once. */
            <MemoryList
              items={shown}
              selected={selected}
              onToggle={toggle}
              onDelete={setConfirmDelete}
              showTopic
              emptyText={`ไม่พบความจำที่ตรงกับ "${query}"`}
            />
          ) : openTopic === null ? (
            /* The folders */
            <div className="pb-6">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {folders.map((f) => (
                  <button
                    key={f.topic}
                    type="button"
                    onClick={() => {
                      setOpenTopic(f.topic);
                      setSelected(new Set());
                    }}
                    className="group rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-center hover:border-purple-500/50 hover:shadow-sm transition"
                  >
                    <span className="relative mx-auto flex h-14 w-16 items-center justify-center">
                      <Folder
                        className="h-14 w-16 text-purple-500/80 group-hover:text-purple-500"
                        strokeWidth={1.5}
                      />
                      <span className="absolute inset-0 flex items-center justify-center pt-2 text-[13px] font-bold text-purple-700 dark:text-purple-300">
                        {f.count}
                      </span>
                    </span>
                    <p className="mt-2 text-[13px] font-semibold text-slate-800 dark:text-slate-100 break-words">
                      {f.topic}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                      {f.count} ข้อ
                    </p>
                  </button>
                ))}
              </div>
              {unfiled > 0 && (
                <p className="mt-4 text-center text-[11px] text-slate-500 dark:text-slate-400">
                  มี {unfiled} ข้อที่ยังไม่ได้จัดหมวด — กด &quot;จัดด้วย AI&quot; ด้านบนให้พรชัยจัดให้
                </p>
              )}
            </div>
          ) : (
            /* Inside a folder */
            <div className="space-y-3 pb-6">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOpenTopic(null);
                    setSelected(new Set());
                  }}
                  className="flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  ทุกโฟลเดอร์
                </button>
                <span className="flex items-center gap-1.5 text-sm font-bold text-slate-900 dark:text-slate-100">
                  <FolderOpen className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  {openTopic}
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    ({shown.length} ข้อ)
                  </span>
                </span>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setSelected(
                        selected.size === shown.length ? new Set() : new Set(shown.map((m) => m.id)),
                      )
                    }
                    className="flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    {selected.size === shown.length && shown.length > 0 ? (
                      <CheckSquare className="h-3.5 w-3.5" />
                    ) : (
                      <Square className="h-3.5 w-3.5" />
                    )}
                    เลือกทั้งหมด
                  </button>
                </div>
              </div>

              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/5 px-3 py-2">
                  <span className="text-xs font-medium text-purple-700 dark:text-purple-300">
                    เลือกไว้ {selected.size} ข้อ
                  </span>
                  <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <FolderInput className="h-3.5 w-3.5" />
                    ย้ายไป
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const v = e.target.value;
                        e.currentTarget.value = "";
                        if (v) handleMoveSelected(v);
                      }}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-900 dark:text-slate-100"
                    >
                      <option value="">เลือกโฟลเดอร์…</option>
                      {allFolders
                        .filter((t) => t !== openTopic)
                        .map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setConfirmBulk(true)}
                    className="flex items-center gap-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    ลบที่เลือก ({selected.size})
                  </button>
                </div>
              )}

              <MemoryList
                items={shown}
                selected={selected}
                onToggle={toggle}
                onDelete={setConfirmDelete}
                emptyText="โฟลเดอร์นี้ว่างแล้ว"
              />
            </div>
          )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmBulk}
        title={`ลบความจำ ${selected.size} ข้อ?`}
        message="พรชัยจะลืมทุกข้อที่เลือกไว้อย่างถาวร"
        onCancel={() => setConfirmBulk(false)}
        onConfirm={() => {
          setConfirmBulk(false);
          handleDeleteSelected();
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="ลบความจำนี้?"
        message={confirmDelete ? `"${confirmDelete.text.slice(0, 120)}" — พรชัยจะลืมเรื่องนี้ถาวร` : ""}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) handleDelete(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}
