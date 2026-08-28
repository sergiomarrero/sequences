import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { supabase } from "@/lib/supabase";
import { SequenceError } from "@/lib/sequences";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A template itself: rename, describe, make default, delete. Its steps
// are edited one at a time at /api/sequences/templates/[stepId].
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
  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    update.name = body.name.trim().slice(0, 80);
  }
  if ("description" in body) {
    update.description =
      typeof body.description === "string"
        ? body.description.trim().slice(0, 1000)
        : "";
  }
  const makeDefault = body.is_default === true;
  if (!Object.keys(update).length && !makeDefault) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const sb = supabase();
  try {
    // Exactly one default: clearing the others and setting this one is two
    // writes, and a crash between them leaves no default rather than two,
    // which the readers treat as "first template wins".
    if (makeDefault) {
      const clear = await sb
        .from("crm_templates")
        .update({ is_default: false })
        .eq("is_default", true);
      if (clear.error) throw new Error(clear.error.message);
      update.is_default = true;
    }
    const res = await sb
      .from("crm_templates")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (res.error) {
      const dup = /duplicate|unique/i.test(res.error.message);
      throw new SequenceError(
        dup ? "a template with that name already exists" : res.error.message,
        dup ? 409 : 500,
      );
    }
    return NextResponse.json(res.data);
  } catch (e) {
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "update failed" },
      { status },
    );
  }
}

export async function DELETE(
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
  const sb = supabase();
  try {
    const cur = await sb.from("crm_templates").select("id, is_default");
    if (cur.error) throw new Error(cur.error.message);
    const me = (cur.data ?? []).find((t) => t.id === id);
    if (!me) throw new SequenceError("no such template", 404);
    if (me.is_default) {
      throw new SequenceError(
        "this is the default template: make another one the default first",
        409,
      );
    }
    if ((cur.data ?? []).length <= 1) {
      throw new SequenceError("cannot delete the last template", 409);
    }
    // steps cascade; sequences drafted from it keep their copies and their
    // template_id goes null (treated as the default from then on)
    const res = await sb.from("crm_templates").delete().eq("id", id);
    if (res.error) throw new Error(res.error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status },
    );
  }
}
