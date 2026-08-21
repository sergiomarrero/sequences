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
  events: SequenceEvent[];
}

export interface SequenceEvent {
  id: string;
  sequence_id: string;
  at: string;
  actor: string;
  action: string;
  detail: string | null;
  step_position: number | null;
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

export type EventActor = "user" | "sync" | "system";

// Append to a sequence's activity log. Recording what happened must never
// be the reason an operation fails, so every error here is swallowed: a
// missing log line is a worse day than a failed send, not the reverse.
export async function logEvent(
  sequenceId: string,
  e: {
    actor?: EventActor;
    action: string;
    detail?: string | null;
    stepPosition?: number | null;
  },
): Promise<void> {
  try {
    await supabase().from("crm_sequence_events").insert({
      sequence_id: sequenceId,
      actor: e.actor ?? "user",
      action: e.action,
      detail: e.detail ? e.detail.slice(0, 2000) : null,
      step_position: e.stepPosition ?? null,
    });
  } catch {
    // ignored on purpose
  }
}

// Has this sequence's introduction already gone out? Used to keep a started
// sequence from being pushed back to a pre-send status, which would make the
// run open a second thread.
export async function sequenceHasStarted(id: string): Promise<boolean> {
  const sb = supabase();
  const seq = await sb
    .from("crm_sequences")
    .select("gmail_thread_id")
    .eq("id", id)
    .single();
  if (!seq.error && seq.data?.gmail_thread_id) return true;
  const sent = await sb
    .from("crm_sequence_steps")
    .select("id")
    .eq("sequence_id", id)
    .not("sent_at", "is", null)
    .limit(1);
  if (sent.error) throw new Error(sent.error.message);
  return (sent.data ?? []).length > 0;
}

export function hasUnresolvedSlots(text: string): boolean {
  return /\[[^\]]+\]/.test(text);
}

// The [bracketed] placeholders still sitting in a step's sendable text.
// Position 1 carries a subject line, so its slots count too.
export function unresolvedSlots(step: {
  position: number;
  subject: string | null;
  body: string;
}): string[] {
  const text =
    step.position === 1 ? `${step.subject ?? ""}\n${step.body}` : step.body;
  return text.match(/\[[^\]]+\]/g) ?? [];
}

export function holdReasonFor(position: number, slots: string[]): string {
  return `Step ${position} needs input: ${slots.join("; ")}`.slice(0, 500);
}

// Editing a step can clear the very slots a sequence is held on. Re-read the
// next unsent step and lift the hold as soon as nothing is missing, so the
// board never keeps telling the user to fill in text they already filled in.
export async function refreshHoldState(sequenceId: string): Promise<void> {
  const sb = supabase();
  const cur = await sb
    .from("crm_sequences")
    .select("status, hold_reason, gmail_thread_id")
    .eq("id", sequenceId)
    .single();
  if (cur.error) throw new Error(cur.error.message);

  const next = await nextUnsentStep(sequenceId);
  const slots = next ? unresolvedSlots(next) : [];
  const update: Record<string, unknown> = {};

  if (slots.length) {
    if (cur.data.status === "held") {
      const reason = holdReasonFor(next!.position, slots);
      if (reason !== cur.data.hold_reason) update.hold_reason = reason;
    }
  } else {
    if (cur.data.hold_reason) update.hold_reason = null;
    if (cur.data.status === "held") {
      const sent = await sb
        .from("crm_sequence_steps")
        .select("id")
        .eq("sequence_id", sequenceId)
        .not("sent_at", "is", null)
        .limit(1);
      if (sent.error) throw new Error(sent.error.message);
      update.status =
        cur.data.gmail_thread_id || (sent.data ?? []).length
          ? "active"
          : "approved";
    }
  }
  if (!Object.keys(update).length) return;
  const res = await sb.from("crm_sequences").update(update).eq("id", sequenceId);
  if (res.error) throw new Error(res.error.message);
  if (update.status) {
    await logEvent(sequenceId, {
      actor: "system",
      action: "hold cleared",
      detail: `slots filled; status ${cur.data.status} -> ${update.status}`,
      stepPosition: next?.position ?? null,
    });
  } else if ("hold_reason" in update && update.hold_reason) {
    await logEvent(sequenceId, {
      actor: "system",
      action: "hold updated",
      detail: String(update.hold_reason),
      stepPosition: next?.position ?? null,
    });
  }
}

async function nextUnsentStep(sequenceId: string) {
  const res = await supabase()
    .from("crm_sequence_steps")
    .select("position, subject, body")
    .eq("sequence_id", sequenceId)
    .is("sent_at", null)
    .order("position", { ascending: true })
    .limit(1);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? [])[0] ?? null;
}

// Newest events first, capped per sequence so one busy card cannot crowd
// out the others.
const EVENTS_PER_SEQUENCE = 60;

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
    byId.set(s.id, { ...s, steps: [], events: [] });
  }
  for (const st of stepRes.data ?? []) {
    byId.get(st.sequence_id)?.steps.push(st);
  }

  // The log is diagnostic, never load-bearing: if the events table is not
  // there yet (migration 0010 unrun), the board still works without it.
  const evRes = await sb
    .from("crm_sequence_events")
    .select("*")
    .order("at", { ascending: false })
    .limit(1000);
  if (!evRes.error) {
    for (const ev of evRes.data ?? []) {
      const seq = byId.get(ev.sequence_id);
      if (seq && seq.events.length < EVENTS_PER_SEQUENCE) seq.events.push(ev);
    }
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

  await logEvent(ins.data.id, {
    action: "created",
    detail: `${steps.length} emails drafted from the template for ${ins.data.email}`,
  });

  return {
    ...ins.data,
    steps: (stepIns.data ?? []).sort((a, b) => a.position - b.position),
    events: [],
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
  actor: EventActor = "user",
): Promise<Sequence> {
  const sb = supabase();
  const cur = await sb.from("crm_sequences").select("*").eq("id", id).single();
  if (cur.error) throw new Error(cur.error.message);

  const update: Record<string, unknown> = {};
  if (action === "send_now") {
    if (!["approved", "active", "held"].includes(cur.data.status)) {
      throw new Error("send_now requires an approved or active sequence");
    }
    // Queueing a send that the slot gate would refuse is a lie to the user:
    // hold the sequence and say what it needs instead of pretending it is on
    // its way. Same rule the mailman applies at send time.
    const nextStep = await nextUnsentStep(id);
    const slots = nextStep ? unresolvedSlots(nextStep) : [];
    if (nextStep && slots.length) {
      update.send_now = false;
      update.status = "held";
      update.hold_reason = holdReasonFor(nextStep.position, slots);
    } else {
      update.send_now = true;
      if (cur.data.status === "held") update.hold_reason = null;
    }
  } else {
    const rule = ACTIONS[action];
    if (!rule) throw new Error("unknown action");
    if (!rule.from.includes(cur.data.status)) {
      throw new Error(`cannot ${action} from status ${cur.data.status}`);
    }
    let to: SequenceStatus = rule.to;
    // A sequence whose introduction already went out resumes mid-thread:
    // approving or restoring it goes straight to "active" so the mailman
    // picks up at the next unsent step instead of re-sending the intro.
    if (to === "pending" || to === "approved") {
      const sent = await sb
        .from("crm_sequence_steps")
        .select("id")
        .eq("sequence_id", id)
        .not("sent_at", "is", null)
        .limit(1);
      if (sent.error) throw new Error(sent.error.message);
      if (cur.data.gmail_thread_id || (sent.data ?? []).length) to = "active";
    }
    update.status = to;
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

  const detail =
    action === "send_now"
      ? update.send_now
        ? "next email queued to send"
        : `send refused: ${update.hold_reason}`
      : `status ${cur.data.status} -> ${update.status}`;
  await logEvent(id, { actor, action, detail });

  const steps = await sb
    .from("crm_sequence_steps")
    .select("*")
    .eq("sequence_id", id)
    .order("position", { ascending: true });
  if (steps.error) throw new Error(steps.error.message);
  return { ...res.data, steps: steps.data ?? [], events: [] };
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

  await logEvent(sequenceId, {
    action: "reordered",
    detail: `step ${a.position} moved ${dir} (swapped with step ${b.position})`,
    stepPosition: b.position,
  });
}
