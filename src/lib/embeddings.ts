/** Shared embedding helpers (used by the chat RAG index and memory search). */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

export async function embed(texts: string[]): Promise<number[][]> {
  if (!OPENAI_API_KEY || texts.length === 0) return [];
  const out: number[][] = [];
  // batch to stay well under request limits
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!res.ok) {
      console.error("[embed-err]", res.status, await res.text().catch(() => ""));
      throw new Error("embedding failed");
    }
    const data = await res.json();
    for (const item of data.data) out.push(item.embedding as number[]);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
