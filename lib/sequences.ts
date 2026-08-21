import "server-only";
import { supabase } from "./supabase";

export const SEQUENCE_STATUSES = [
  "pending",
  "approved",
  "active",
  "held",
  "replied",
  "done",
  "stopped",
  "saved",
  "archived",
] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export interface SequenceStep {
  id: string;
  sequence_id: string;
  position: number;
  title: string;
  subject: string | null;
  body: string;
  wait_days: number;
  sent_at: string | null;
  gmail_message_id: string | null;
}

export interface Sequence {
  id: string;
  name: string;
  email: string;
  firm: string | null;
  background: string | null;
  status: SequenceStatus;
  next_step: number;
  gmail_thread_id: string | null;
  send_now: boolean;
  hold_reason: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
  steps: SequenceStep[];
}

export interface SequenceTemplateStep {
  id: string;
  position: number;
  title: string;
  subject: string | null;
  body: string;
  wait_days: number;
}

// Fields the UI may write directly on a sequence. Status changes go
// through the action endpoint so transitions stay valid.
export const SEQUENCE_EDITABLE_FIELDS = [
  "name",
  "firm",
  "background",
] as const;

export const STEP_EDITABLE_FIELDS = [
  "title",
  "subject",
  "body",
  "wait_days",
] as const;

export function hasUnresolvedSlots(text: string): boolean {
  return /\[[^\]]+\]/.test(text);
}

export async function listSequences(): Promise<{
  sequences: Sequence[];
  templates: SequenceTemplateStep[];
}> {
  const sb = supabase();
  const [seqRes, stepRes, tplRes] = await Promise.all([
    sb.from("crm_sequences").select("*").order("created_at", { ascending: false }),
    sb
      .from("crm_sequence_steps")
      .select("*")
      .order("position", { ascending: true }),
    sb
      .from("crm_sequence_templates")
      .select("*")
      .order("position", { ascending: true }),
  ]);
  if (seqRes.error) throw new Error(seqRes.error.message);
  if (stepRes.error) throw new Error(stepRes.error.message);
  if (tplRes.error) throw new Error(tplRes.error.message);

  const byId = new Map<string, Sequence>();
  for (const s of seqRes.data ?? []) {
    byId.set(s.id, { ...s, steps: [] });
  }
  for (const st of stepRes.data ?? []) {
    byId.get(st.sequence_id)?.steps.push(st);
  }
  return {
    sequences: [...byId.values()],
    templates: tplRes.data ?? [],
  };
}

// Create a new pending sequence from the current template.
export async function createSequenceFromTemplate(input: {
  name: string;
  email: string;
  firm?: string | null;
  background?: string | null;
}): Promise<Sequence> {
  const sb = supabase();
  const tplRes = await sb
    .from("crm_sequence_templates")
    .select("*")
    .order("position", { ascending: true });
  if (tplRes.error) throw new Error(tplRes.error.message);

  const ins = await sb
    .from("crm_sequences")
    .insert({
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      firm: input.firm?.trim() || null,
      background: input.background?.trim() || null,
    })
    .select("*")
    .single();
  if (ins.error) throw new Error(ins.error.message);

  const first = input.name.trim().split(/\s+/)[0] ?? "";
  const steps = (tplRes.data ?? []).map((t) => ({
    sequence_id: ins.data.id,
    position: t.position,
    title: t.title,
    subject: t.subject,
    // pre-fill the one slot we always know
    body: first ? t.body.replaceAll("[First name]", first) : t.body,
    wait_days: t.wait_days,
  }));
  const stepIns = await sb.from("crm_sequence_steps").insert(steps).select("*");
  if (stepIns.error) throw new Error(stepIns.error.message);

  return {
    ...ins.data,
    steps: (stepIns.data ?? []).sort((a, b) => a.position - b.position),
  };
}

// Valid one-tap actions per current status. The mailman (Claude's daily
// run) owns the approved->active, active->replied/done/held transitions.
const ACTIONS: Record<string, { from: SequenceStatus[]; to: SequenceStatus }> = {
  approve: { from: ["pending", "saved", "held"], to: "approved" },
  save: { from: ["pending"], to: "saved" },
  archive: { from: ["pending", "saved", "stopped", "replied", "done"], to: "archived" },
  stop: { from: ["approved", "active", "held"], to: "stopped" },
  restore: { from: ["saved", "archived", "stopped"], to: "pending" },
};

export async function applySequenceAction(
  id: string,
  action: string,
): Promise<Sequence> {
  const sb = supabase();
  const cur = await sb.from("crm_sequences").select("*").eq("id", id).single();
  if (cur.error) throw new Error(cur.error.message);

  const update: Record<string, unknown> = {};
  if (action === "send_now") {
    if (!["approved", "active", "held"].includes(cur.data.status)) {
      throw new Error("send_now requires an approved or active sequence");
    }
    update.send_now = true;
  } else {
    const rule = ACTIONS[action];
    if (!rule) throw new Error("unknown action");
    if (!rule.from.includes(cur.data.status)) {
      throw new Error(`cannot ${action} from status ${cur.data.status}`);
    }
    update.status = rule.to;
    if (action === "stop" || action === "restore") update.send_now = false;
    if (action === "restore") update.hold_reason = null;
  }

  const res = await sb
    .from("crm_sequences")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (res.error) throw new Error(res.error.message);

  const steps = await sb
    .from("crm_sequence_steps")
    .select("*")
    .eq("sequence_id", id)
    .order("position", { ascending: true });
  if (steps.error) throw new Error(steps.error.message);
  return { ...res.data, steps: steps.data ?? [] };
}

// Swap an unsent step with its unsent neighbor.
export async function moveStep(
  sequenceId: string,
  stepId: string,
  dir: "up" | "down",
): Promise<void> {
  const sb = supabase();
  const res = await sb
    .from("crm_sequence_steps")
    .select("id, position, sent_at")
    .eq("sequence_id", sequenceId)
    .order("position", { ascending: true });
  if (res.error) throw new Error(res.error.message);
  const steps = res.data ?? [];
  const i = steps.findIndex((s) => s.id === stepId);
  if (i < 0) throw new Error("step not found");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= steps.length) return;
  if (steps[i].sent_at || steps[j].sent_at) {
    throw new Error("sent steps cannot be reordered");
  }
  const a = steps[i];
  const b = steps[j];
  // three-phase swap to respect the (sequence_id, position) unique constraint
  const tmp = -1;
  const u1 = await sb.from("crm_sequence_steps").update({ position: tmp }).eq("id", a.id);
  if (u1.error) throw new Error(u1.error.message);
  const u2 = await sb.from("crm_sequence_steps").update({ position: a.position }).eq("id", b.id);
  if (u2.error) throw new Error(u2.error.message);
  const u3 = await sb.from("crm_sequence_steps").update({ position: b.position }).eq("id", a.id);
  if (u3.error) throw new Error(u3.error.message);
}
