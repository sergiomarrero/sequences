import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { supabase } from "@/lib/supabase";
import { listTemplates, SequenceError } from "@/lib/sequences";

// The template collection. Individual template steps are edited at
// /api/sequences/templates/[id]; a template's own name, default flag, and
// deletion live at /api/sequences/template/[id].
export async function GET(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ templates: await listTemplates() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "query failed" },
      { status: 500 },
    );
  }
}

// Create a template. Always seeded by copying: another template's steps
// (copy_from_template_id) or an existing sequence's steps
// (copy_from_sequence_id), so a new template never starts as an empty
// arc the create-sequence flow would refuse.
export async function POST(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const fromTemplate =
    typeof body.copy_from_template_id === "string" && body.copy_from_template_id
      ? body.copy_from_template_id
      : null;
  const fromSequence =
    typeof body.copy_from_sequence_id === "string" && body.copy_from_sequence_id
      ? body.copy_from_sequence_id
      : null;
  if (!fromTemplate && !fromSequence) {
    return NextResponse.json(
      { error: "copy_from_template_id or copy_from_sequence_id is required" },
      { status: 400 },
    );
  }

  const sb = supabase();
  try {
    let steps: {
      position: number;
      title: string;
      subject: string | null;
      body: string;
      wait_days: number;
    }[];
    if (fromTemplate) {
      const src = (await listTemplates()).find((t) => t.id === fromTemplate);
      if (!src) throw new SequenceError("no such template to copy from", 404);
      steps = src.steps.map((s) => ({
        position: s.position,
        title: s.title,
        subject: s.subject,
        body: s.body,
        wait_days: s.wait_days,
      }));
    } else {
      const src = await sb
        .from("crm_sequence_steps")
        .select("position, title, subject, body, wait_days")
        .eq("sequence_id", fromSequence)
        .order("position", { ascending: true });
      if (src.error) throw new Error(src.error.message);
      steps = src.data ?? [];
    }
    if (!steps.length) {
      throw new SequenceError("the copy source has no emails", 400);
    }

    const ins = await sb
      .from("crm_templates")
      .insert({
        name,
        description:
          typeof body.description === "string"
            ? body.description.trim().slice(0, 1000)
            : "",
      })
      .select("*")
      .single();
    if (ins.error) {
      const dup = /duplicate|unique/i.test(ins.error.message);
      throw new SequenceError(
        dup ? `a template named "${name}" already exists` : ins.error.message,
        dup ? 409 : 500,
      );
    }
    const stepIns = await sb
      .from("crm_sequence_templates")
      .insert(steps.map((s) => ({ ...s, template_id: ins.data.id })))
      .select("*");
    if (stepIns.error) throw new Error(stepIns.error.message);

    return NextResponse.json(
      {
        ...ins.data,
        steps: (stepIns.data ?? []).sort((a, b) => a.position - b.position),
      },
      { status: 201 },
    );
  } catch (e) {
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "create failed" },
      { status },
    );
  }
}
