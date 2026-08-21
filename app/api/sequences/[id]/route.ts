import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { supabase } from "@/lib/supabase";
import {
  applySequenceAction,
  logEvent,
  SEQUENCE_EDITABLE_FIELDS,
  SEQUENCE_STATUSES,
} from "@/lib/sequences";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PATCH { action: "approve" | "save" | "archive" | "stop" | "restore" | "send_now" }
// or    { name?, firm?, background? } for inline edits (user or sync).
// The sync caller (Claude's mailman) may additionally write the run-state
// fields: status, next_step, gmail_thread_id, hold_reason, send_now, is_test.
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

  try {
    if (typeof body.action === "string") {
      const seq = await applySequenceAction(
        id,
        body.action,
        caller === "sync" ? "sync" : "user",
      );
      return NextResponse.json(seq);
    }

    const update: Record<string, unknown> = {};
    for (const f of SEQUENCE_EDITABLE_FIELDS) {
      if (f in body) {
        update[f] =
          typeof body[f] === "string" ? body[f].trim() || null : null;
      }
    }
    if (caller === "sync") {
      if ("status" in body) {
        if (!SEQUENCE_STATUSES.includes(body.status)) {
          return NextResponse.json({ error: "invalid status" }, { status: 400 });
        }
        update.status = body.status;
      }
      if ("next_step" in body) {
        const n = Number(body.next_step);
        if (!Number.isInteger(n) || n < 1 || n > 99) {
          return NextResponse.json({ error: "invalid next_step" }, { status: 400 });
        }
        update.next_step = n;
      }
      if ("gmail_thread_id" in body) {
        update.gmail_thread_id =
          typeof body.gmail_thread_id === "string"
            ? body.gmail_thread_id.trim() || null
            : null;
      }
      if ("hold_reason" in body) {
        update.hold_reason =
          typeof body.hold_reason === "string"
            ? body.hold_reason.trim() || null
            : null;
      }
      if ("send_now" in body) update.send_now = !!body.send_now;
      if ("is_test" in body) update.is_test = !!body.is_test;
    }

    if (!Object.keys(update).length) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    if ("name" in update && !update.name) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    const res = await supabase()
      .from("crm_sequences")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (res.error) throw new Error(res.error.message);
    await logEvent(id, {
      actor: caller === "sync" ? "sync" : "user",
      action: caller === "sync" ? "run update" : "details edited",
      detail: Object.entries(update)
        .map(([k, v]) => `${k}=${v === null ? "(cleared)" : String(v).slice(0, 120)}`)
        .join("; "),
    });
    return NextResponse.json(res.data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "update failed" },
      { status: 500 },
    );
  }
}
