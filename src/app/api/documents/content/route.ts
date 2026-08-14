import { NextRequest, NextResponse } from "next/server";
import { getDocument } from "@/lib/document-store";

export const runtime = "nodejs";

/**
 * POST /api/documents/content
 * Body: { ids: string[] }
 * Returns full document content for the given ids (for lazy per-job summaries).
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? (body.ids as string[]) : [];
  const docs = ids
    .map((id) => getDocument(id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({ id: d.id, name: d.name, content: d.content }));
  return NextResponse.json(docs);
}
