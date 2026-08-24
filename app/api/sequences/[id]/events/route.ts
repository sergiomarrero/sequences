import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { logEvent } from "@/lib/sequences";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The daily QA sweep writes its verdicts here: qa_flag when a step's text
// carries a defect worth Sergio's eyes, qa_ok to clear a flag that no
// longer applies. Sync-only: the UI never invents QA events, it only
// renders them, and a flag dies naturally when the step is edited or sent.
const ALLOWED = new Set(["qa_flag", "qa_ok", "note"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const caller = await sequencesCaller(req);
  if (caller !== "sync") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.action !== "string" ||
    !ALLOWED.has(body.action) ||
    typeof body.detail !== "string" ||
    !body.detail.trim() ||
    body.detail.length > 2000
  ) {
    return NextResponse.json(
      { error: "action must be qa_flag/qa_ok/note with a detail under 2000 chars" },
      { status: 400 },
    );
  }
  const pos = Number(body.step_position);
  await logEvent(id, {
    actor: "sync",
    action: body.action,
    detail: body.detail.trim(),
    stepPosition: Number.isInteger(pos) && pos > 0 ? pos : undefined,
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
