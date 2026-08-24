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
  // Absent in the slim listing (GET /api/sequences?slim=1): text ships only
  // when a card is opened, so 200 sequences do not mean 200 sequences of
  // email bodies on every page load. `slots` is the server's read of what
  // still blocks this step, computed with the current facts, so gating
  // works without the text.
  subject?: string | null;
  body?: string;
  slots?: string[];
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

// Text pasted out of the Gmail web UI carries Google's click-tracking
// wrapper around every link. Stored as-is it would show Sergio a wall of
// "https://www.google.com/url?q=..." in the editor and, worse, send that
// wrapper on as the visible link text. Keep the destination, drop the
// wrapper.
const TRACKING_RE =
  /https?:\/\/(?:www\.)?google\.com\/url\?[^\s<>"]*/gi;

// A body written by the sync caller can arrive hard-wrapped, because the
// drafts it is loaded from are text files wrapped for reading at ~72
// columns. Those newlines are mechanical, not authorial: in the editor's
// textarea they freeze the text so it will not reflow as you type, and the
// paragraph reads as a stack of short lines. Join them back up.
//
// A break is mechanical when the line before it was already full. That one
// test is what protects the breaks that mean something: "Best," is five
// characters, so "Sergio" never gets pulled up onto it. List items are
// spared outright, whatever the line before them looked like.
const WRAPPED_AT = 45;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*\u2022])\s/;

export function unwrapHardBreaks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const joinable =
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      prev.trimEnd().length >= WRAPPED_AT &&
      !LIST_ITEM.test(line);
    if (joinable) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trimStart()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function unwrapTrackingUrls(text: string): string {
  return text.replace(TRACKING_RE, (match) => {
    try {
      const target = new URL(match).searchParams.get("q");
      return target && /^https?:\/\//i.test(target) ? target : match;
    } catch {
      return match;
    }
  });
}

export type EventActor = "user" | "sync" | "system";

// A problem with what was asked, not with the server. Carries the status the
// API should answer with, so a refused action reads as a refusal (4xx) rather
// than a crash (500).
export class SequenceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SequenceError";
    this.status = status;
  }
}

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
export interface SequenceFact {
  key: string;
  label: string;
  value: string;
  updated_at: string;
}

// Facts are shared, round-level truths ("where the round stands") that steps
// reference as {{key}} tokens. Missing table = migration 0011 not run yet;
// every reader degrades to "no facts" so the rest of the desk keeps working.
export async function listFacts(): Promise<SequenceFact[]> {
  const sb = supabase();
  const res = await sb
    .from("crm_sequence_facts")
    .select("*")
    .order("key", { ascending: true });
  if (res.error) return [];
  return res.data ?? [];
}

export async function factsMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const f of await listFacts()) map[f.key] = f.value;
  return map;
}

export async function setFact(key: string, value: string): Promise<SequenceFact> {
  const sb = supabase();
  const res = await sb
    .from("crm_sequence_facts")
    .update({ value, updated_at: new Date().toISOString() })
    .eq("key", key)
    .select("*")
    .single();
  if (res.error) {
    throw new SequenceError(
      res.error.message.includes("crm_sequence_facts")
        ? "facts table missing: run db/migrations/0011_crm_sequence_facts.sql"
        : res.error.message.includes("0 rows") || res.error.code === "PGRST116"
          ? `unknown fact "${key}"`
          : res.error.message,
      res.error.code === "PGRST116" ? 404 : 500,
    );
  }
  return res.data;
}

// {{key}} tokens in a text, resolved against the facts. Exported for the
// facts API's preview and for tests of the slot gate.
export const FACT_TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export function resolveFacts(
  text: string,
  facts: Record<string, string>,
): string {
  return text.replace(FACT_TOKEN, (whole, key: string) => {
    const v = facts[key.toLowerCase()];
    return v && v.trim() ? v : whole;
  });
}

export function unresolvedSlots(
  step: {
    position: number;
    subject: string | null;
    body: string;
  },
  facts: Record<string, string> = {},
): string[] {
  const text =
    step.position === 1 ? `${step.subject ?? ""}\n${step.body}` : step.body;
  // [bracketed] text is a per-sequence slot; a {{token}} whose fact is empty
  // is a round-level one. Both block a send the same way.
  const slots: string[] = text.match(/\[[^\]]+\]/g) ?? [];
  for (const m of text.matchAll(FACT_TOKEN)) {
    const v = facts[m[1].toLowerCase()];
    if (!v || !v.trim()) slots.push(m[0]);
  }
  return slots;
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
  const slots = next ? unresolvedSlots(next, await factsMap()) : [];
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

export async function listSequences(opts?: { slim?: boolean }): Promise<{
  sequences: Sequence[];
  templates: SequenceTemplateStep[];
  facts: SequenceFact[];
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
  // Slim strips the text but keeps the verdict about it: the UI's chips,
  // send gating, and the Needs-you strip all work from `slots` alone, and
  // the full text arrives via GET /api/sequences/:id when a card opens.
  const facts = opts?.slim ? await factsMap() : null;
  for (const st of stepRes.data ?? []) {
    if (facts) {
      const { body: _b, subject: _sub, ...rest } = st;
      byId
        .get(st.sequence_id)
        ?.steps.push({ ...rest, slots: unresolvedSlots(st, facts) });
    } else {
      byId.get(st.sequence_id)?.steps.push(st);
    }
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
    // empty until migration 0011 runs; the board treats that as "no facts"
    facts: await listFacts(),
  };
}

// One sequence, full text and its own event log. The detail fetch behind
// the slim listing.
export async function getSequence(id: string): Promise<Sequence | null> {
  const sb = supabase();
  const seqRes = await sb.from("crm_sequences").select("*").eq("id", id).single();
  if (seqRes.error) return null;
  const stepRes = await sb
    .from("crm_sequence_steps")
    .select("*")
    .eq("sequence_id", id)
    .order("position", { ascending: true });
  if (stepRes.error) throw new Error(stepRes.error.message);
  const out: Sequence = { ...seqRes.data, steps: stepRes.data ?? [], events: [] };
  const evRes = await sb
    .from("crm_sequence_events")
    .select("*")
    .eq("sequence_id", id)
    .order("at", { ascending: false })
    .limit(EVENTS_PER_SEQUENCE);
  if (!evRes.error) out.events = evRes.data ?? [];
  return out;
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
      throw new SequenceError(
        "This sequence is not enrolled yet, so there is nothing to send. Approve it first.",
      );
    }
    // Queueing a send that the slot gate would refuse is a lie to the user:
    // hold the sequence and say what it needs instead of pretending it is on
    // its way. Same rule the mailman applies at send time.
    const nextStep = await nextUnsentStep(id);
    const slots = nextStep ? unresolvedSlots(nextStep, await factsMap()) : [];
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
    if (!rule) throw new SequenceError(`unknown action "${action}"`);
    if (!rule.from.includes(cur.data.status)) {
      throw new SequenceError(
        `cannot ${action} a sequence that is ${cur.data.status}`,
        409,
      );
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
// Remove an unsent step and close the gap behind it. A sequence whose
// contact only warrants five emails should be five emails long, not eight
// with three left dangling for the mailman to trip over.
export async function deleteStep(
  sequenceId: string,
  stepId: string,
): Promise<void> {
  const sb = supabase();
  const res = await sb
    .from("crm_sequence_steps")
    .select("id, position, title, sent_at")
    .eq("sequence_id", sequenceId)
    .order("position", { ascending: true });
  if (res.error) throw new Error(res.error.message);
  const steps = res.data ?? [];
  const victim = steps.find((s) => s.id === stepId);
  if (!victim) throw new SequenceError("step not found", 404);
  if (victim.sent_at) {
    throw new SequenceError(
      "this email already sent; it can no longer be removed",
      409,
    );
  }
  if (steps.length <= 1) {
    throw new SequenceError("a sequence needs at least one email", 409);
  }

  const del = await sb.from("crm_sequence_steps").delete().eq("id", stepId);
  if (del.error) throw new Error(del.error.message);

  // close the gap. (sequence_id, position) is unique, so walk upward in
  // order: each step moves into the slot the one before it just vacated.
  for (const s of steps) {
    if (s.position <= victim.position) continue;
    const u = await sb
      .from("crm_sequence_steps")
      .update({ position: s.position - 1 })
      .eq("id", s.id);
    if (u.error) throw new Error(u.error.message);
  }

  // next_step may now point past the end, or at a step that shifted down
  const seq = await sb
    .from("crm_sequences")
    .select("next_step")
    .eq("id", sequenceId)
    .single();
  if (!seq.error) {
    const remaining = steps.length - 1;
    const next = Math.min(
      Math.max(1, seq.data.next_step > victim.position ? seq.data.next_step - 1 : seq.data.next_step),
      remaining,
    );
    if (next !== seq.data.next_step) {
      await sb.from("crm_sequences").update({ next_step: next }).eq("id", sequenceId);
    }
  }

  await logEvent(sequenceId, {
    action: "removed",
    detail: `step ${victim.position} "${victim.title}" removed; ${steps.length - 1} emails remain`,
    stepPosition: victim.position,
  });

  // the hold may have been pinned to the step that just went away
  await refreshHoldState(sequenceId);
}

// How long a claim stands before another run may take it. Long enough that a
// slow send never gets double-claimed, short enough that a crashed run does
// not wedge the step until someone notices.
const CLAIM_STALE_MS = 30 * 60 * 1000;

// Take the exclusive right to send this step. Returns false when someone
// already holds it, or when the step has already gone out.
//
// The whole guarantee lives in this one conditional UPDATE. Postgres locks
// the row and re-evaluates the WHERE against the locked version, so of two
// concurrent callers exactly one matches a row and the other matches none.
// Never split this into a read-then-write: that reintroduces the race it
// exists to close.
export async function claimStepSend(
  sequenceId: string,
  stepId: string,
): Promise<boolean> {
  const sb = supabase();
  const cutoff = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const res = await sb
    .from("crm_sequence_steps")
    .update({ send_claimed_at: new Date().toISOString() })
    .eq("id", stepId)
    .eq("sequence_id", sequenceId)
    .is("sent_at", null)
    .or(`send_claimed_at.is.null,send_claimed_at.lt.${cutoff}`)
    .select("id");
  if (res.error) throw new Error(res.error.message);
  return (res.data?.length ?? 0) > 0;
}

// Hand the claim back after a send that did not happen, so the next run can
// retry immediately instead of waiting out the staleness window.
export async function releaseStepClaim(
  sequenceId: string,
  stepId: string,
): Promise<void> {
  const sb = supabase();
  const res = await sb
    .from("crm_sequence_steps")
    .update({ send_claimed_at: null })
    .eq("id", stepId)
    .eq("sequence_id", sequenceId)
    .is("sent_at", null);
  if (res.error) throw new Error(res.error.message);
}

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
  if (i < 0) throw new SequenceError("step not found", 404);
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= steps.length) return;
  if (steps[i].sent_at || steps[j].sent_at) {
    throw new SequenceError("sent emails cannot be reordered", 409);
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
