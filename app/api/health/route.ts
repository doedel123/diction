import { readApiKey } from "@/lib/stt-messages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json(
    { ok: true, configured: Boolean(readApiKey()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
