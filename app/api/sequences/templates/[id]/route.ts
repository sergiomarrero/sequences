import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { supabase } from "@/lib/supabase";
import { SequenceError, STEP_EDITABLE_FIELDS } from "@/lib/sequences";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Edit the default template a step at a time. Affects future drafts only;
// existing sequences keep their own copies.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const f of STEP_EDITABLE_FIELDS) {
    if (!(f in body)) continue;
    if (f === "wait_days") {
      const n = Number(body.wait_days);
      if (!Number.isInteger(n) || n < 0 || n > 30) {
        return NextResponse.json({ error: "wait_days must be 0-30" }, { status: 400 });
      }
      update.wait_days = n;
    } else if (f === "body" || f === "title") {
      if (typeof body[f] !== "string" || !body[f].trim()) {
        return NextResponse.json({ error: `${f} cannot be empty` }, { status: 400 });
      }
      update[f] = body[f];
    } else {
      update[f] = typeof body[f] === "string" ? body[f] : null;
    }
  }
  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  try {
    const res = await supabase()
      .from("crm_sequence_templates")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (res.error) throw new Error(res.error.message);
    return NextResponse.json(res.data);
  } catch (e) {
    // a refused action is the caller's problem, not a server fault
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "update failed" },
      { status },
    );
  }
}
