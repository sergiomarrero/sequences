import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { supabase } from "@/lib/supabase";
import {
  SequenceError,
  logEvent,
  moveStep,
  refreshHoldState,
  STEP_EDITABLE_FIELDS,
} from "@/lib/sequences";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH { move: "up" | "down" } to reorder, or
// PATCH { title?, subject?, body?, wait_days? } for inline edits.
// The sync caller (Claude's mailman) may additionally stamp
// { sent_at, gmail_message_id } when it sends a step.
// Sent steps are otherwise immutable: what went out is the record.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id, stepId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(stepId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  try {
    if (body.move === "up" || body.move === "down") {
      await moveStep(id, stepId, body.move);
      return NextResponse.json({ ok: true });
    }

    const sb = supabase();
    const cur = await sb
      .from("crm_sequence_steps")
      .select("id, sent_at, sequence_id")
      .eq("id", stepId)
      .single();
    if (cur.error) throw new Error(cur.error.message);
    if (cur.data.sequence_id !== id) {
      return NextResponse.json({ error: "step not in sequence" }, { status: 400 });
    }
    if (cur.data.sent_at) {
      return NextResponse.json(
        { error: "this email already sent; it can no longer be edited" },
        { status: 409 },
      );
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
    if (caller === "sync") {
      if ("sent_at" in body) {
        const d = new Date(body.sent_at);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: "invalid sent_at" }, { status: 400 });
        }
        update.sent_at = d.toISOString();
      }
      if ("gmail_message_id" in body) {
        update.gmail_message_id =
          typeof body.gmail_message_id === "string"
            ? body.gmail_message_id.trim() || null
            : null;
      }
    }
    if (!Object.keys(update).length) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    const res = await sb
      .from("crm_sequence_steps")
      .update(update)
      .eq("id", stepId)
      .select("*")
      .single();
    if (res.error) throw new Error(res.error.message);

    if (update.sent_at) {
      await logEvent(id, {
        actor: "sync",
        action: "sent",
        detail: `step ${res.data.position} "${res.data.title}" sent as Gmail message ${update.gmail_message_id ?? "(id not recorded)"}`,
        stepPosition: res.data.position,
      });
    } else {
      const fields = Object.keys(update);
      await logEvent(id, {
        actor: caller === "sync" ? "sync" : "user",
        action: "edited",
        detail: `step ${res.data.position}: ${fields.join(", ")} changed${
          fields.includes("wait_days") ? ` (wait now ${update.wait_days} bd)` : ""
        }`,
        stepPosition: res.data.position,
      });
    }

    // an edit may have resolved (or restated) the slots this sequence is held
    // on; keep the hold in step with the text
    await refreshHoldState(id);
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
