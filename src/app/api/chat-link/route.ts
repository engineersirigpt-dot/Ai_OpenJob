import { NextRequest, NextResponse } from "next/server";

/**
 * Read a public ChatGPT share link and return the conversation as plain text.
 *
 * Share pages embed the conversation as a react-router "turbo-stream" payload
 * inside a streamController.enqueue("...") script — a flattened JSON array
 * where objects are {"_keyIdx": valueIdx} reference maps. We fetch the page,
 * decode that structure, and format the messages as "เฮีย:/พรชัย:" lines so
 * the result can be uploaded like any meeting document.
 */

export const maxDuration = 60;

/**
 * Why a share page came back with no conversation in it.
 *
 * A link copied out of the browser's address bar is not a share link: the
 * page it serves is the sign-in wall, and it looks exactly like an expired
 * link to a parser. ChatGPT says which it is, so say it back instead of
 * guessing — the fix is entirely in the user's hands.
 */
function loginWall(html: string): boolean {
  // Verified against both shapes of a non-public link. The page's wording
  // varies between requests, so the route's own state keys are the reliable
  // signal: `loginRequired` on the owner-only /share/e/ route, and
  // `showInaccessibleToast` on /share/<id> when the chat is not shared.
  return (
    html.includes("loginRequired") ||
    html.includes("showInaccessibleToast") ||
    html.includes("Log in to view") ||
    html.includes("Unable to load conversation")
  );
}

const NEED_PUBLIC_LINK =
  "ลิงก์นี้ยังไม่ได้เปิดแชร์แบบสาธารณะ — ChatGPT ตอบว่าต้องล็อกอินก่อนจึงจะอ่านได้ " +
  "วิธีแก้: เปิดแชทใน ChatGPT กดปุ่มแชร์ (Share) แล้วกดสร้างลิงก์ จะได้ลิงก์หน้าตา " +
  "chatgpt.com/share/xxxxxxxx ซึ่งดึงได้ ส่วนลิงก์ที่คัดลอกจากช่องที่อยู่เว็บ (มี /share/e/ หรือ /c/) ใช้ไม่ได้";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeDecoder(values: any[]) {
  const seen = new Map<number, any>();
  function decode(i: any, depth = 0): any {
    if (depth > 80) return null;
    if (typeof i === "string" || typeof i === "boolean" || i === null || i === undefined) return i;
    if (typeof i === "number") {
      if (i < 0 || i >= values.length) return null;
      if (seen.has(i)) return seen.get(i);
      const v = values[i];
      if (Array.isArray(v)) {
        const out: any[] = [];
        seen.set(i, out);
        for (const ref of v) out.push(decode(ref, depth + 1));
        return out;
      }
      if (v && typeof v === "object") {
        const out: Record<string, any> = {};
        seen.set(i, out);
        for (const [k, ref] of Object.entries(v)) {
          const key = k.startsWith("_") ? values[Number(k.slice(1))] : k;
          if (typeof key === "string") out[key] = decode(ref, depth + 1);
        }
        return out;
      }
      return v;
    }
    return i;
  }
  return decode;
}

function findKey(obj: any, key: string, depth = 0): any {
  if (depth > 12 || obj === null || typeof obj !== "object") return null;
  if (!Array.isArray(obj) && key in obj) return obj[key];
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const r = findKey(v, key, depth + 1);
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

export async function POST(req: NextRequest) {
  let url = "";
  try {
    const body = await req.json();
    url = String(body?.url || "").trim();
  } catch {
    /* fallthrough */
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "ลิงก์ไม่ถูกต้อง" }, { status: 400 });
  }
  const okHost = parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
  // Two share-link shapes exist: the classic /share/<uuid> and the newer
  // short /s/t_<token> (which redirects to the share page — fetch follows it).
  if (
    parsed.protocol !== "https:" ||
    !okHost ||
    !/^\/(share|s)\/[a-z0-9_-]+/i.test(parsed.pathname)
  ) {
    return NextResponse.json(
      { error: "รองรับเฉพาะลิงก์แชร์ ChatGPT (chatgpt.com/share/... หรือ chatgpt.com/s/...)" },
      { status: 400 },
    );
  }

  // The owner-only form carries the same id as the public one, so try the
  // public shape too — it works whenever the conversation really is shared.
  const candidates = [parsed.toString()];
  const ownerOnly = parsed.pathname.match(/^\/share\/e\/(.+)$/i);
  if (ownerOnly) candidates.push(`https://chatgpt.com/share/${ownerOnly[1]}`);

  let html = "";
  let wall = false;
  for (const candidate of candidates) {
    let body = "";
    try {
      const res = await fetch(candidate, {
        headers: { "User-Agent": UA, "Accept-Language": "th,en;q=0.8" },
        cache: "no-store",
      });
      if (!res.ok) {
        console.warn("[chat-link]", candidate, res.status);
        continue;
      }
      body = await res.text();
    } catch (err) {
      console.warn("[chat-link]", candidate, (err as Error).message);
      continue;
    }
    if (loginWall(body)) {
      wall = true;
      continue;
    }
    html = body;
    break;
  }

  if (!html) {
    return wall
      ? NextResponse.json({ error: NEED_PUBLIC_LINK }, { status: 400 })
      : NextResponse.json(
          { error: "เข้าถึงลิงก์ไม่ได้ — ลิงก์อาจถูกลบหรือหมดอายุ" },
          { status: 502 },
        );
  }

  // Pull every streamController.enqueue("...") payload and use the largest
  // one that parses to the flattened-array format.
  const payloads = [...html.matchAll(/streamController\.enqueue\("((?:[^"\\]|\\.)*)"\)/g)]
    .map((m) => m[1])
    .sort((a, b) => b.length - a.length);

  // Collect message objects ({author, content}) from either share shape:
  //  - /share/<uuid>  → "linear_conversation": [{message: {...}}, ...]
  //  - /s/t_<token>   → "postWithProfile".post.attachments[].messages[] (a
  //    shared snippet — one or a few messages, not the whole conversation)
  let msgs: any[] | null = null;
  let title = "";
  for (const payload of payloads) {
    try {
      const values = JSON.parse(`"${payload}"`);
      const arr = JSON.parse(values);
      if (!Array.isArray(arr)) continue;
      const root = makeDecoder(arr)(0);

      const conv = findKey(root, "linear_conversation");
      if (Array.isArray(conv) && conv.length) {
        msgs = conv.map((n: any) => n?.message).filter(Boolean);
        const t = findKey(root, "title");
        if (typeof t === "string") title = t;
        break;
      }

      const post = findKey(root, "postWithProfile")?.post ?? findKey(root, "post");
      if (post && Array.isArray(post.attachments)) {
        const collected: any[] = [];
        for (const att of post.attachments) {
          if (Array.isArray(att?.messages)) collected.push(...att.messages);
        }
        if (collected.length) {
          msgs = collected;
          const t = post.title || post.og_title;
          if (typeof t === "string") title = t.replace(/^ChatGPT( -\s*)?/, "").trim();
          break;
        }
      }
    } catch {
      /* try the next payload */
    }
  }

  if (!msgs || msgs.length === 0) {
    return NextResponse.json(
      { error: "ไม่พบเนื้อหาแชทในลิงก์ — ลิงก์อาจหมดอายุ ถูกลบ หรือรูปแบบหน้าเว็บเปลี่ยน" },
      { status: 422 },
    );
  }

  const lines: string[] = [];
  for (const msg of msgs) {
    if (!msg) continue;
    const role = msg.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts: string[] = (msg.content?.parts || []).filter((p: any) => typeof p === "string");
    const text = parts.join("\n").trim();
    if (!text) continue;
    lines.push(`${role === "user" ? "เฮีย" : "พรชัย"}: ${text}`);
  }

  if (lines.length === 0) {
    return NextResponse.json({ error: "แชทในลิงก์นี้ไม่มีข้อความ" }, { status: 422 });
  }

  const safeTitle = (title || "chatgpt-chat").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60);
  const text = `บทสนทนา ChatGPT: ${title || "(ไม่มีชื่อ)"}\nที่มา: ${parsed.toString()}\n\n${lines.join("\n\n")}`;

  return NextResponse.json({ name: `แชท ${safeTitle}`, title, messages: lines.length, text });
}
