"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  NoSendDay,
  SendStats,
  Sequence,
  SequenceEvent,
  SequenceFact,
  SequenceStatus,
  SequenceStep,
  SequenceTemplateStep,
} from "@/lib/sequences";

function fmtStamp(v: string): string {
  const d = new Date(v);
  const date = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

// Everything that has happened to this sequence, newest first. Diagnostic,
// The round-level facts panel. Fill each once; every step that references
// {{key}} resolves it at send time, so 200 sequences update together.
function FactsPanel({
  facts,
  save,
}: {
  facts: SequenceFact[];
  save: (key: string, url: string, patch: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const v: Record<string, string> = {};
    for (const f of facts) v[f.key] = f.value;
    setValues(v);
  }, [facts]);

  if (!facts.length) {
    return (
      <section className="zone">
        <h2>Round facts</h2>
        <p className="edit-hint">
          Facts are not set up yet: run{" "}
          <code>db/migrations/0011_crm_sequence_facts.sql</code> in Supabase
          and reload. Then fields like &ldquo;where the round stands&rdquo; are
          filled once here instead of once per sequence.
        </p>
      </section>
    );
  }

  return (
    <section className="zone">
      <h2>Round facts</h2>
      <p className="edit-hint facts-hint">
        Filled once, used everywhere: any email containing a{" "}
        <code>{"{{token}}"}</code> gets the current value at send time. An
        empty fact holds every email that needs it, exactly like an unfilled
        [bracket].
      </p>
      <div className="facts">
        {facts.map((f) => (
          <label key={f.key} className="fact">
            <span className="fact-label">
              {f.label}
              <code className="fact-token">{`{{${f.key}}}`}</code>
            </span>
            <textarea
              rows={2}
              value={values[f.key] ?? ""}
              placeholder="Empty: every email that needs this is held"
              onChange={(e) => {
                setValues((v) => ({ ...v, [f.key]: e.target.value }));
                save(`fact:${f.key}`, "/api/sequences/facts", {
                  key: f.key,
                  value: e.target.value,
                });
              }}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

// not decorative: when a card misbehaves this is the record of what was
// actually asked of it and what the server did in response.
function ActivityLog({ seq }: { seq: Sequence }) {
  const [copied, setCopied] = useState(false);
  const events: SequenceEvent[] = seq.events ?? [];

  async function copy() {
    const text = [
      `Sequence: ${seq.name} <${seq.email}>`,
      `Status: ${seq.status} · next step ${seq.next_step} · send_now ${seq.send_now}`,
      seq.hold_reason ? `Hold: ${seq.hold_reason}` : null,
      `Thread: ${seq.gmail_thread_id ?? "none"}`,
      "",
      ...events.map(
        (e) =>
          `${fmtStamp(e.at)} [${e.actor}] ${e.action}${e.detail ? `: ${e.detail}` : ""}`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // clipboard blocked (insecure context, permissions): fall back to a
      // selectable prompt so the text is still recoverable
      window.prompt("Copy the activity log:", text);
    }
  }

  return (
    <details className="seq log">
      <summary>
        <span>Activity log</span>
        <span className="chip">{events.length} recorded</span>
      </summary>
      {events.length === 0 ? (
        <p className="edit-hint">
          Nothing recorded yet. Every approve, edit, hold, send, and stop
          from here on shows up in this list.
        </p>
      ) : (
        <>
          <ul className="events">
            {events.map((e) => (
              <li key={e.id}>
                <span className="ev-at">{fmtStamp(e.at)}</span>
                <span className={`ev-actor a-${e.actor}`}>{e.actor}</span>
                <span className="ev-what">
                  <b>{e.action}</b>
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="quiet" onClick={copy}>
              {copied ? "Copied" : "Copy log for a bug report"}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

function hasSlots(text: string): boolean {
  return /\[[^\]]+\]/.test(text);
}

function fmtDate(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// The live-state chip on each card, worded like the prototype:
// "Active · step 2 of 8 sent 08/20".
function chipText(seq: Sequence): string {
  const total = seq.steps.length;
  const sent = seq.steps.filter((s) => s.sent_at);
  const last = sent.length
    ? sent
        .map((s) => s.sent_at as string)
        .sort()
        .slice(-1)[0]
    : null;
  switch (seq.status) {
    case "pending":
      return "Pending review";
    case "saved":
      return "Saved for later";
    case "approved":
      return "Approved · intro sends next run";
    case "active":
      return sent.length
        ? `Active · step ${sent.length} of ${total} sent ${fmtDate(last)}`
        : "Active";
    case "held":
      return "Needs input · held";
    case "replied":
      return "Replied · sequence stopped";
    case "done":
      return `Done · all ${total} sent`;
    case "stopped":
      return "Stopped";
    case "archived":
      return "Archived";
  }
}

// The slots still blocking a step. Shared by the card and the running board
// so both agree on what "needs input" means.
const FACT_TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
// mirrors CHECKPOINT_MARKER in lib/sequences.ts: the entry a flagged step
// contributes to its own blocker list
const CHECKPOINT_MARKER = "[review checkpoint]";

function slotsIn(
  step: SequenceStep | undefined,
  facts: Record<string, string> = {},
): string[] {
  if (!step) return [];
  // Slim listing: no text on board, but the server already judged it and
  // shipped the verdict as step.slots. Text present (card open, or an edit
  // in flight) wins, so gating tracks keystrokes.
  if (step.body === undefined) return step.slots ?? [];
  const gate: string[] = step.review_gate ? [CHECKPOINT_MARKER] : [];
  const text =
    step.position === 1 ? `${step.subject ?? ""}\n${step.body}` : step.body;
  // [bracketed] text is a per-sequence slot; a {{token}} whose shared fact is
  // still empty blocks the same way, but is fixed once in the facts panel.
  const slots: string[] = text.match(/\[[^\]]+\]/g) ?? [];
  for (const m of text.matchAll(FACT_TOKEN)) {
    const v = facts[m[1].toLowerCase()];
    if (!v || !v.trim()) slots.push(m[0]);
  }
  return slots.concat(gate);
}

function firstUnsent(seq: Sequence): SequenceStep | undefined {
  return [...seq.steps]
    .filter((s) => !s.sent_at)
    .sort((a, b) => a.position - b.position)[0];
}

function lastSentAt(seq: Sequence): string | null {
  const sent = seq.steps
    .filter((s) => s.sent_at)
    .map((s) => s.sent_at as string)
    .sort();
  return sent.length ? sent[sent.length - 1] : null;
}

// Business days elapsed since a send: exclusive of the send day, inclusive of
// today, matching how the daily run counts a wait.
function businessDaysSince(iso: string): number {
  const from = new Date(iso);
  const d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const now = new Date();
  const end = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  let n = 0;
  for (let t = d + 86400000; t <= end; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

// One line answering "what happens next, and is it on me?". `rank` sorts the
// running board so anything waiting on Sergio floats to the top.
type NextTone = "needs" | "go" | "wait" | "idle";
function nextAction(
  seq: Sequence,
  facts: Record<string, string> = {},
): {
  label: string;
  tone: NextTone;
  rank: number;
} {
  if (seq.status === "stopped") return { label: "Stopped", tone: "idle", rank: 9 };
  const next = firstUnsent(seq);
  if (!next) return { label: "All emails sent", tone: "idle", rank: 8 };
  const slots = slotsIn(next, facts);
  if (seq.status === "held" || slots.length) {
    const onlyGate =
      slots.length > 0 && slots.every((x) => x === CHECKPOINT_MARKER);
    return {
      label: onlyGate
        ? `\u2691 Review \u00b7 step ${next.position}`
        : `Needs input \u00b7 step ${next.position}`,
      tone: "needs",
      rank: 0,
    };
  }
  if (seq.send_now) {
    return { label: `Queued \u00b7 step ${next.position}`, tone: "go", rank: 1 };
  }
  if (seq.status === "approved") {
    return { label: "Intro sends next run", tone: "go", rank: 1 };
  }
  const last = lastSentAt(seq);
  if (!last) return { label: `Step ${next.position} waiting`, tone: "wait", rank: 7 };
  const left = next.wait_days - businessDaysSince(last);
  if (left <= 0) {
    return { label: `Due now \u00b7 step ${next.position}`, tone: "go", rank: 2 };
  }
  return {
    label: `Step ${next.position} in ${left} bd`,
    tone: "wait",
    rank: 3 + Math.min(left, 99) / 100,
  };
}

// QA flags the daily sweep has raised that Sergio has not yet dealt with.
// A flag lives in the event log (action "qa_flag", stepPosition set) and
// dies naturally: a later edit of that step, the step going out, or the
// sweep itself withdrawing it (qa_ok). Events arrive newest first.
function openQaFlags(
  seq: Sequence,
): { pos: number; detail: string; at: string }[] {
  const flags: { pos: number; detail: string; at: string }[] = [];
  const cleared = new Set<number>();
  for (const ev of seq.events ?? []) {
    const pos = ev.step_position;
    if (pos == null) continue;
    if (ev.action === "edited" || ev.action === "sent" || ev.action === "qa_ok") {
      cleared.add(pos);
    } else if (ev.action === "qa_flag" && !cleared.has(pos)) {
      const step = seq.steps.find((s) => s.position === pos);
      if (step && !step.sent_at && !flags.some((f) => f.pos === pos)) {
        flags.push({ pos, detail: ev.detail ?? "QA flag", at: ev.at });
      }
    }
  }
  return flags.sort((a, b) => a.pos - b.pos);
}

// Sequences that are sending or paused mid-flight. These are the ones that
// pile up, so they get the dense board rather than a stack of cards.
const RUNNING_STATUSES: SequenceStatus[] = [
  "approved",
  "active",
  "held",
  "stopped",
];

// Finished states: the conversation is over. These live in the archive.
// "stopped" is deliberately not here: a stopped sequence is paused work you
// may well resume, so it stays on the board where you can see it.
const CLOSED_STATUSES: SequenceStatus[] = ["replied", "done", "archived"];

const STATUS_LABEL: Record<SequenceStatus, string> = {
  pending: "Pending review",
  saved: "Saved for later",
  approved: "Approved (intro sends next run)",
  active: "Active",
  held: "Held (needs input)",
  stopped: "Stopped",
  replied: "Replied",
  done: "Done",
  archived: "Archived",
};

// What you can switch a sequence to by hand. A started sequence can never go
// back to a pre-send status, or the run would open a second thread.
function statusOptions(seq: Sequence): SequenceStatus[] {
  const started = seq.steps.some((s) => s.sent_at) || !!seq.gmail_thread_id;
  const opts: SequenceStatus[] = started
    ? ["active", "held", "stopped", "replied", "done", "archived"]
    : ["pending", "saved", "approved", "stopped", "archived"];
  return opts.includes(seq.status) ? opts : [seq.status, ...opts];
}

// Statuses that let the run send again. Moving a replied sequence into one
// of these puts another automated email in front of someone who wrote back,
// so it is gated behind an explicit acknowledgement.
const SENDING_STATUSES: SequenceStatus[] = ["approved", "active", "held"];

const STATUS_ORDER: SequenceStatus[] = [
  "held",
  "active",
  "approved",
  "pending",
  "replied",
  "done",
  "stopped",
  "saved",
  "archived",
];

// Debounced field saver shared by step and template editors.
function useSaver() {
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (key: string, url: string, patch: Record<string, unknown>) => {
      const t = timers.current.get(key);
      if (t) clearTimeout(t);
      timers.current.set(
        key,
        setTimeout(async () => {
          timers.current.delete(key);
          setSaving((n) => n + 1);
          try {
            const res = await fetch(url, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            });
            if (!res.ok) {
              const j = await res.json().catch(() => null);
              throw new Error(j?.error ?? `save failed (${res.status})`);
            }
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : "save failed");
          } finally {
            setSaving((n) => n - 1);
          }
        }, 600),
      );
    },
    [],
  );
  return { save, saving: saving > 0, error };
}

function StepEditor({
  step,
  url,
  canMove,
  onMove,
  onRemove,
  onGate,
  save,
  onPromote,
  promoted,
  isNext,
  onEdit,
}: {
  step: SequenceStep;
  url: string;
  canMove: boolean;
  onMove: (dir: "up" | "down") => void;
  // absent when this step cannot be removed (sent, or the only one left)
  onRemove?: () => void;
  // toggle the review checkpoint: the sequence will stop before this step
  // and wait until the flag is cleared. Absent on sent steps.
  onGate?: () => void;
  save: (key: string, url: string, patch: Record<string, unknown>) => void;
  onPromote?: (v: { title: string; subject: string | null; body: string }) => void;
  promoted?: boolean;
  isNext?: boolean;
  // keep the card's copy of this step current as the user types, so slot
  // gating and hold notes react immediately instead of after a reload
  onEdit?: (patch: Partial<SequenceStep>) => void;
}) {
  const [title, setTitle] = useState(step.title);
  const [subject, setSubject] = useState(step.subject ?? "");
  const [body, setBody] = useState(step.body ?? "");
  const [wait, setWait] = useState(step.wait_days);
  // removing an email is destructive and the control is small, so it takes
  // two taps: the same pattern as the send button
  const [armRemove, setArmRemove] = useState(false);
  const sent = !!step.sent_at;

  useEffect(() => {
    setTitle(step.title);
    setSubject(step.subject ?? "");
    setBody(step.body ?? "");
    setWait(step.wait_days);
  }, [step.id, step.title, step.subject, step.body, step.wait_days]);

  return (
    <div className={`step ${sent ? "sent" : ""} ${!sent && step.review_gate ? "gated" : ""}`}>
      {!sent && step.review_gate && (
        <div className="gate-note">
          {"\u2691"} Checkpoint: the sequence stops here until you review this
          email and untick the flag.
        </div>
      )}
      <div className="step-head">
        <h4>
          <span className="n">{step.position}</span>
          <span className="dot">·</span>
          <input
            className="t"
            value={title}
            disabled={sent}
            aria-label={`Title of step ${step.position}`}
            onChange={(e) => {
              setTitle(e.target.value);
              onEdit?.({ title: e.target.value });
              save(`${step.id}:title`, url, { title: e.target.value });
            }}
          />
        </h4>
        {sent && (
          <span className="sentmark">✓ sent {fmtDate(step.sent_at)}</span>
        )}
        {!sent && isNext && <span className="next-pill">next up</span>}
        {!sent && onPromote && (
          <span className="starbox">
            <button
              type="button"
              className={promoted ? "on" : ""}
              title="Make this email the default template for this step"
              onClick={() =>
                onPromote({ title, subject: subject || null, body })
              }
            >
              {promoted ? "★" : "☆"}
            </button>
          </span>
        )}
        {!sent && canMove && (
          <span className="mv">
            <button onClick={() => onMove("up")} aria-label="Move earlier">↑</button>
            <button onClick={() => onMove("down")} aria-label="Move later">↓</button>
          </span>
        )}
        {!sent && onGate && (
          <span className="gate">
            <button
              type="button"
              className={step.review_gate ? "on" : ""}
              title={
                step.review_gate
                  ? "Checkpoint on: the sequence stops before this email until you untick"
                  : "Set a checkpoint: the sequence will stop here and wait for your review"
              }
              aria-label={
                step.review_gate
                  ? `Remove the review checkpoint on step ${step.position}`
                  : `Stop the sequence at step ${step.position} for review`
              }
              onClick={onGate}
            >
              {"\u2691"}
            </button>
          </span>
        )}
        {!sent && onRemove && (
          <span className="rm">
            <button
              type="button"
              className={armRemove ? "armed" : ""}
              title="Remove this email from the sequence"
              aria-label={
                armRemove
                  ? `Confirm removing step ${step.position}`
                  : `Remove step ${step.position}`
              }
              onClick={() => {
                if (armRemove) {
                  setArmRemove(false);
                  onRemove();
                } else {
                  setArmRemove(true);
                }
              }}
              onBlur={() => setArmRemove(false)}
            >
              {armRemove ? "Remove?" : "\u00d7"}
            </button>
          </span>
        )}
        {!sent && step.position === 1 && (
          <span className="wait">sends on approval</span>
        )}
        {!sent && step.position !== 1 && (
          <label className="wait">
            wait{" "}
            <input
              className="wait-days"
              type="number"
              min={1}
              max={30}
              step={1}
              value={wait}
              disabled={sent}
              inputMode="numeric"
              aria-label={`Business days of silence before step ${step.position}`}
              onChange={(e) => {
                const n = Number(e.target.value);
                setWait(n);
                if (Number.isInteger(n) && n >= 1 && n <= 30) {
                  save(`${step.id}:wait`, url, { wait_days: n });
                }
              }}
            />{" "}
            bd
          </label>
        )}
      </div>
      {step.position === 1 && (
        <p className="subj">
          <span>Subject</span>{" "}
          <input
            className="s"
            value={subject}
            disabled={sent}
            placeholder="Subject"
            aria-label="Introduction subject line"
            onChange={(e) => {
              setSubject(e.target.value);
              onEdit?.({ subject: e.target.value });
              save(`${step.id}:subject`, url, { subject: e.target.value });
            }}
          />
        </p>
      )}
      <textarea
        className="letter"
        value={body}
        disabled={sent}
        rows={Math.max(5, body.split("\n").length + 1)}
        aria-label={`Email body of step ${step.position}`}
        onChange={(e) => {
          setBody(e.target.value);
          onEdit?.({ body: e.target.value });
          save(`${step.id}:body`, url, { body: e.target.value });
        }}
      />
      {!sent && hasSlots(body + (step.position === 1 ? subject : "")) && (
        <div className="slot-note">
          [slots] need real content; this step is held, never sent, until
          they are filled.
        </div>
      )}
    </div>
  );
}

function NewSequenceForm({ onCreated }: { onCreated: (s: Sequence) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [firm, setFirm] = useState("");
  const [background, setBackground] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div className="newbar">
        <button className="primary" onClick={() => setOpen(true)}>
          New sequence
        </button>
        <span className="new-hint">
          or paste the person into Claude chat for a fully personalized draft
        </span>
      </div>
    );
  }
  return (
    <div className="card new-form">
      <div className="form-grid">
        <input placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Email *" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Firm" value={firm} onChange={(e) => setFirm(e.target.value)} />
      </div>
      <textarea
        placeholder="Background: how you met, their thesis, the ask…"
        rows={3}
        value={background}
        onChange={(e) => setBackground(e.target.value)}
      />
      {error && <div className="err">{error}</div>}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !name.trim() || !email.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const res = await fetch("/api/sequences", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, firm, background }),
              });
              const j = await res.json();
              if (!res.ok) throw new Error(j?.error ?? "create failed");
              onCreated(j);
              setOpen(false);
              setName(""); setEmail(""); setFirm(""); setBackground("");
            } catch (e) {
              setError(e instanceof Error ? e.message : "create failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Creating…" : "Create draft"}
        </button>
        <button className="quiet" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export default function SequencesView() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [templates, setTemplates] = useState<SequenceTemplateStep[]>([]);
  const [facts, setFacts] = useState<SequenceFact[]>([]);
  const [noSendDays, setNoSendDays] = useState<NoSendDay[]>([]);
  const [sendStats, setSendStats] = useState<SendStats | null>(null);
  // the intro text is for new eyes; regulars keep it folded. Remembered
  // per browser, and reading it is one tap away either way.
  const [introOpen, setIntroOpen] = useState(false);
  useEffect(() => {
    try {
      setIntroOpen(localStorage.getItem("sdesk-intro") === "open");
    } catch {}
  }, []);
  const toggleIntro = () => {
    setIntroOpen((v) => {
      try {
        localStorage.setItem("sdesk-intro", v ? "closed" : "open");
      } catch {}
      return !v;
    });
  };
  const [nsDay, setNsDay] = useState("");
  const [nsLabel, setNsLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const [tplOpen, setTplOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [queuing, setQueuing] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<Set<string>>(new Set());
  const [actErr, setActErr] = useState<{ id: string; msg: string } | null>(null);
  // resuming a sequence the investor already answered needs a deliberate ack
  const [ackFor, setAckFor] = useState<{ id: string; target: SequenceStatus } | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  // Running board: filter, search, which rows are expanded, and an escape
  // hatch back to the full-card layout for anyone who prefers it.
  const [runFilter, setRunFilter] = useState<"all" | "needs" | "go">("all");
  const [runQuery, setRunQuery] = useState("");
  const [runExpanded, setRunExpanded] = useState<Set<string>>(new Set());
  const [runCards, setRunCards] = useState(false);

  const [archQuery, setArchQuery] = useState("");
  const [archStatus, setArchStatus] = useState<"all" | SequenceStatus>("all");
  const [archExpanded, setArchExpanded] = useState<Set<string>>(new Set());
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { save, saving, error: saveError } = useSaver();

  const load = useCallback(async () => {
    try {
      // Slim: 200 sequences of metadata, not 200 sequences of email bodies.
      // Text arrives per card via hydrate() when one is opened.
      const res = await fetch("/api/sequences?slim=1");
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "load failed");
      setSequences((prev) => {
        const oldSteps = new Map<string, SequenceStep>();
        for (const s of prev) for (const st of s.steps) oldSteps.set(st.id, st);
        // keep text a hydrate or an open editor already holds; a slim row
        // must never blank a textarea mid-edit
        return (j.sequences as Sequence[]).map((s) => ({
          ...s,
          steps: s.steps.map((st) => {
            const had = oldSteps.get(st.id);
            return had && had.body !== undefined && st.body === undefined
              ? { ...st, body: had.body, subject: had.subject }
              : st;
          }),
        }));
      });
      setTemplates(j.templates);
      setFacts(j.facts ?? []);
      setNoSendDays(j.no_send_days ?? []);
      setSendStats(j.send_stats ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch one sequence's full text and events the moment its card opens.
  const hydrating = useRef<Set<string>>(new Set());
  const hydrate = useCallback(async (id: string) => {
    if (hydrating.current.has(id)) return;
    hydrating.current.add(id);
    try {
      const res = await fetch(`/api/sequences/${id}`);
      if (!res.ok) return;
      const full: Sequence = await res.json();
      setSequences((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                ...full,
                // an editor may hold newer keystrokes than the server copy;
                // never regress text that is already on screen
                steps: full.steps.map((st) => {
                  const cur = s.steps.find((x) => x.id === st.id);
                  return cur && cur.body !== undefined ? cur : st;
                }),
              }
            : s,
        ),
      );
    } finally {
      hydrating.current.delete(id);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ordered = useMemo(
    () =>
      [...sequences].sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          b.created_at.localeCompare(a.created_at),
      ),
    [sequences],
  );

  // Work you can still act on stays on the board; anything finished moves to
  // the archive below, which is its own section rather than the tail of this
  // list.
  const live = useMemo(
    () => ordered.filter((s) => !CLOSED_STATUSES.includes(s.status)),
    [ordered],
  );
  // Drafts still need reading, so they stay as cards. Running sequences are
  // the ones that pile up; they get the board.
  const drafts = useMemo(
    () => live.filter((s) => !RUNNING_STATUSES.includes(s.status)),
    [live],
  );
  const factsByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of facts) m[f.key] = f.value;
    return m;
  }, [facts]);

  const running = useMemo(
    () =>
      live
        .filter((s) => RUNNING_STATUSES.includes(s.status))
        .map((s) => ({ seq: s, next: nextAction(s, factsByKey) }))
        .sort(
          (a, b) =>
            a.next.rank - b.next.rank || a.seq.name.localeCompare(b.seq.name),
        ),
    [live, factsByKey],
  );
  const needsYou = useMemo(
    () => running.filter((r) => r.next.tone === "needs"),
    [running],
  );
  const queued = useMemo(
    () => running.filter((r) => r.next.tone === "go"),
    [running],
  );
  const runRows = useMemo(() => {
    const q = runQuery.trim().toLowerCase();
    return running.filter(({ seq, next }) => {
      if (runFilter === "needs" && next.tone !== "needs") return false;
      if (runFilter === "go" && next.tone !== "go") return false;
      if (!q) return true;
      return [seq.name, seq.email, seq.firm ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [running, runFilter, runQuery]);

  const closed = useMemo(
    () =>
      ordered
        .filter((s) => CLOSED_STATUSES.includes(s.status))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [ordered],
  );
  const archiveRows = useMemo(() => {
    const q = archQuery.trim().toLowerCase();
    return closed.filter((s) => {
      if (archStatus !== "all" && s.status !== archStatus) return false;
      if (!q) return true;
      return [s.name, s.email, s.firm ?? "", s.background ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [closed, archQuery, archStatus]);

  // Everything waiting on Sergio, in the order it deserves attention. This
  // is the first thing on the page: at 200 sequences the board is a lot of
  // rows, and the strip is the answer to "what do I actually do right now?".
  type Todo = {
    seq: Sequence;
    kind: "held" | "qa" | "draft" | "replied";
    label: string;
  };
  const todos = useMemo<Todo[]>(() => {
    const out: Todo[] = [];
    for (const s of ordered) {
      if (CLOSED_STATUSES.includes(s.status) && s.status !== "replied") continue;
      if (s.status === "held" || (RUNNING_STATUSES.includes(s.status) && slotsIn(firstUnsent(s), factsByKey).length)) {
        const next = firstUnsent(s);
        out.push({
          seq: s,
          kind: "held",
          label:
            s.hold_reason ??
            (next
              ? `step ${next.position} still needs ${slotsIn(next, factsByKey).length} blank${slotsIn(next, factsByKey).length === 1 ? "" : "s"} filled`
              : "needs input"),
        });
      }
    }
    for (const s of ordered) {
      if (CLOSED_STATUSES.includes(s.status)) continue;
      const flags = openQaFlags(s);
      if (flags.length) {
        out.push({
          seq: s,
          kind: "qa",
          label: flags
            .map((f) =>
              // the sweep sometimes writes "step N:" into the detail too;
              // don't say it twice
              /^step\s*\d+\s*:/i.test(f.detail)
                ? f.detail
                : `step ${f.pos}: ${f.detail}`,
            )
            .join(" \u00b7 "),
        });
      }
    }
    for (const s of ordered) {
      if (s.status === "pending") {
        out.push({ seq: s, kind: "draft", label: "new draft, read and approve" });
      }
    }
    for (const s of ordered) {
      if (s.status === "replied") {
        out.push({
          seq: s,
          kind: "replied",
          label: "wrote back; read the thread, then archive or resume",
        });
      }
    }
    return out;
  }, [ordered, factsByKey]);

  // Land on the thing itself: open its section, expand its card, scroll.
  function jumpTo(seq: Sequence) {
    hydrate(seq.id);
    if (CLOSED_STATUSES.includes(seq.status)) {
      setArchOpen(true);
      setArchStatus("all");
      setArchQuery("");
      setArchExpanded((prev) => new Set(prev).add(seq.id));
    } else if (RUNNING_STATUSES.includes(seq.status)) {
      setRunFilter("all");
      setRunQuery("");
      if (!runCards) {
        setRunExpanded((prev) => new Set(prev).add(seq.id));
      }
      setOpen(seq.id, true);
    } else {
      setOpen(seq.id, true);
    }
    setTimeout(() => {
      document
        .getElementById(`seq-${seq.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  async function act(id: string, action: string) {
    try {
      const res = await fetch(`/api/sequences/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? `action failed (${res.status})`);
      // the action response carries no events; keep the ones on screen, then
      // pull the freshly logged ones in the background
      setSequences((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...j, events: s.events } : s)),
      );
      setActErr(null);
      load();
      return j as Sequence;
    } catch (e) {
      setActErr({ id, msg: e instanceof Error ? e.message : "action failed" });
      return null;
    }
  }

  async function move(seq: Sequence, step: SequenceStep, dir: "up" | "down") {
    await fetch(`/api/sequences/${seq.id}/steps/${step.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ move: dir }),
    });
    load();
  }

  // One PATCH, then reload: the server recomputes the hold, so a checkpoint
  // set on the very next step shows up as held immediately, and clearing the
  // last blocker lifts it.
  async function toggleGate(seq: Sequence, step: SequenceStep) {
    const r = await fetch(`/api/sequences/${seq.id}/steps/${step.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_gate: !step.review_gate }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      setActErr({ id: seq.id, msg: j?.error ?? "could not toggle the checkpoint" });
      return;
    }
    load();
  }

  async function removeStep(seq: Sequence, step: SequenceStep) {
    const r = await fetch(`/api/sequences/${seq.id}/steps/${step.id}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      setActErr({
        id: seq.id,
        msg: j?.error ?? "could not remove that email",
      });
      return;
    }
    load();
  }

  // ☆ star: copy this step's current text over the default template for
  // the same position, so future drafts start from it.
  function promote(
    step: SequenceStep,
    v: { title: string; subject: string | null; body: string },
  ) {
    const tpl = templates.find((t) => t.position === step.position);
    if (!tpl) return;
    save(`promote:${tpl.id}`, `/api/sequences/templates/${tpl.id}`, {
      title: v.title,
      subject: v.subject,
      body: v.body,
    });
    setTemplates((prev) =>
      prev.map((t) => (t.id === tpl.id ? { ...t, ...v } : t)),
    );
    setPromoted((prev) => new Set(prev).add(step.id));
  }

  // "Send next email now" arms on the first tap and fires on the second,
  // exactly like the prototype. The server refuses to queue a send whose
  // next email still carries [slots]; say so plainly when that happens.
  async function sendNow(seq: Sequence) {
    if (armed !== seq.id) {
      setArmed(seq.id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), 8000);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
    setQueuing(seq.id);
    const updated = await act(seq.id, "send_now");
    setQueuing(null);
    if (updated && !updated.send_now && updated.status === "held") {
      setActErr({
        id: seq.id,
        msg: `Not queued. ${updated.hold_reason ?? "The next email still needs input."} Fill that in above, then send.`,
      });
    }
  }

  // Set a status directly from the card. The one-tap buttons stay for the
  // common moves; this is the escape hatch for everything else.
  async function setStatus(
    seq: Sequence,
    status: SequenceStatus,
    acknowledgeReply = false,
  ) {
    if (status === seq.status) return;
    // they answered: make the user say so out loud before more mail goes out
    if (
      seq.status === "replied" &&
      SENDING_STATUSES.includes(status) &&
      !acknowledgeReply
    ) {
      setAckChecked(false);
      setAckFor({ id: seq.id, target: status });
      return;
    }
    try {
      const res = await fetch(`/api/sequences/${seq.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          acknowledgeReply ? { status, acknowledge_reply: true } : { status },
        ),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? `could not set status (${res.status})`);
      setSequences((prev) =>
        prev.map((x) => (x.id === seq.id ? { ...x, ...j, events: x.events } : x)),
      );
      setAckFor(null);
      setActErr(
        j.status === status
          ? null
          : {
              id: seq.id,
              msg: `Set to ${STATUS_LABEL[j.status as SequenceStatus]}: this sequence already has a live thread, so it cannot go back to a pre-send status.`,
            },
      );
      load();
    } catch (e) {
      setActErr({
        id: seq.id,
        msg: e instanceof Error ? e.message : "could not set status",
      });
    }
  }

  // mirror an in-progress step edit into the card's state so slot gating,
  // hold notes, and the send button update as the user types
  function applyStepEdit(
    seqId: string,
    stepId: string,
    patch: Partial<SequenceStep>,
  ) {
    setSequences((prev) =>
      prev.map((s) =>
        s.id === seqId
          ? {
              ...s,
              steps: s.steps.map((st) =>
                st.id === stepId ? { ...st, ...patch } : st,
              ),
            }
          : s,
      ),
    );
  }

  function setOpen(id: string, isOpen: boolean) {
    if (isOpen) hydrate(id);
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // One sequence card. Used by the live list and by an expanded archive row,
  // so both places behave identically.
  function renderCard(seq: Sequence) {
    const open = openCards.has(seq.id);
              const followups = Math.max(0, seq.steps.length - 1);
              const started = seq.steps.some((s) => s.sent_at);
              const nextStep = [...seq.steps]
                .filter((s) => !s.sent_at)
                .sort((a, b) => a.position - b.position)[0];
              const nextPos = nextStep?.position;
              // the next email cannot go out while it still carries [slots]
              // or a {{token}} whose shared fact is empty
              const blockedSlots = slotsIn(nextStep, factsByKey);
              return (
                <article
                  className={`card status-${seq.status}`}
                  id={`seq-${seq.id}`}
                  key={seq.id}
                >
                  <div className="card-head">
                    <h3>
                      {seq.name}
                      {seq.is_test && <span className="test-tag">SELF-TEST</span>}
                    </h3>
                    <span className={`chip status st-${seq.status}`}>
                      {chipText(seq)}
                      {seq.send_now ? " · send queued" : ""}
                    </span>
                  </div>
                  {seq.firm && <p className="firmline">{seq.firm}</p>}
                  <p className="metaline">
                    {seq.email}
                    {seq.gmail_thread_id ? " · thread pinned" : ""}
                  </p>

                  {seq.status === "replied" && (
                    <div className="repliednote">
                      <span className="rn-flag">Replied</span>
                      <div>
                        <b>{seq.name} wrote back.</b> This sequence stopped
                        itself and will not send anything else.
                        {seq.gmail_thread_id && (
                          <>
                            {" "}
                            <a
                              href={`https://mail.google.com/mail/u/0/#all/${seq.gmail_thread_id}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Read the reply in Gmail
                            </a>
                            .
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {ackFor?.id === seq.id && (
                    <div className="ackgate">
                      <p>
                        <b>Hold on: {seq.name} already replied.</b> Setting
                        this back to{" "}
                        {STATUS_LABEL[ackFor.target].toLowerCase()} lets the
                        run put more automated follow-ups in a thread they
                        have already answered.
                      </p>
                      <label className="ack-check">
                        <input
                          type="checkbox"
                          checked={ackChecked}
                          onChange={(e) => setAckChecked(e.target.checked)}
                        />
                        <span>
                          I have read their reply and still want this
                          sequence to keep sending.
                        </span>
                      </label>
                      <div className="actions">
                        <button
                          className="danger"
                          disabled={!ackChecked}
                          onClick={() => setStatus(seq, ackFor.target, true)}
                        >
                          Resume anyway
                        </button>
                        <button
                          className="quiet"
                          onClick={() => {
                            setAckFor(null);
                            setAckChecked(false);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {seq.hold_reason &&
                    seq.status === "held" &&
                    blockedSlots.length > 0 && (
                      <div className="holdnote">{seq.hold_reason}</div>
                    )}
                  {seq.status === "held" && blockedSlots.length === 0 && (
                    <div className="readynote">
                      Filled in. Step {nextPos} is ready; send it now or let
                      the next morning run take it.
                    </div>
                  )}

                  {seq.background && (
                    <div className="bg-block">
                      <span className="lbl">Background used</span>
                      {seq.background}
                    </div>
                  )}

                  <details
                    className="seq"
                    open={open}
                    onToggle={(e) =>
                      setOpen(seq.id, (e.target as HTMLDetailsElement).open)
                    }
                  >
                    <summary>
                      <span>Read the sequence</span>
                      <span className="chip">intro + {followups} follow-ups</span>
                    </summary>

                    {seq.steps.some((st) => st.body === undefined) && (
                      <p className="edit-hint">Loading the emails\u2026</p>
                    )}
                    {seq.steps
                      .filter((st) => st.body !== undefined)
                      .map((st) => (
                      <StepEditor
                        key={st.id}
                        step={st}
                        url={`/api/sequences/${seq.id}/steps/${st.id}`}
                        canMove={!st.sent_at}
                        onMove={(dir) => move(seq, st, dir)}
                        onRemove={
                          !st.sent_at && seq.steps.length > 1
                            ? () => removeStep(seq, st)
                            : undefined
                        }
                        onGate={
                          !st.sent_at ? () => toggleGate(seq, st) : undefined
                        }
                        save={save}
                        onPromote={(v) => promote(st, v)}
                        promoted={promoted.has(st.id)}
                        isNext={
                          st.position === nextPos &&
                          ["approved", "active", "held"].includes(seq.status)
                        }
                        onEdit={(patch) => applyStepEdit(seq.id, st.id, patch)}
                      />
                    ))}

                    <p className="edit-hint">
                      Tap any email to edit it in place; edits save. A step
                      still carrying [slots] is skipped, never sent. The ☆
                      star marks an email as the new template default for
                      that step; ↑↓ reorder unsent steps, × removes one, and ⚑ checkpoints one so the sequence stops there for your review.
                    </p>

                  </details>

                  <ActivityLog seq={seq} />

                  <div className="actions">
                    <label className="status-pick">
                      <span>Status</span>
                      <select
                        value={seq.status}
                        onChange={(e) => setStatus(seq, e.target.value as SequenceStatus)}
                      >
                        {statusOptions(seq).map((st) => (
                          <option key={st} value={st}>
                            {STATUS_LABEL[st]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {["approved", "active", "held"].includes(seq.status) && (
                      <button
                        type="button"
                        className={`primary send-next ${seq.send_now && !blockedSlots.length ? "queued" : ""}`}
                        disabled={
                          blockedSlots.length > 0 ||
                          queuing === seq.id ||
                          (seq.send_now && !blockedSlots.length)
                        }
                        onClick={() => sendNow(seq)}
                      >
                        {blockedSlots.length
                          ? blockedSlots.every((x) => x === CHECKPOINT_MARKER)
                            ? `Step ${nextPos} is checkpointed: review, then untick \u2691`
                            : `Fill in step ${nextPos} to send`
                          : queuing === seq.id
                            ? "Queuing\u2026"
                            : seq.send_now
                              ? `\u2713 Queued \u00b7 step ${nextPos} sends next`
                              : armed === seq.id
                                ? "Tap again to confirm send"
                                : "Send next email now"}
                      </button>
                    )}
                    {seq.status === "pending" && (
                      <>
                        <button className="primary" onClick={() => act(seq.id, "approve")}>
                          Approve &amp; enroll
                        </button>
                        <button onClick={() => act(seq.id, "save")}>
                          Save for later
                        </button>
                        <button className="quiet" onClick={() => act(seq.id, "archive")}>
                          Archive
                        </button>
                      </>
                    )}
                    {seq.status === "held" && (
                      <button className="primary" onClick={() => act(seq.id, "approve")}>
                        Resume sending
                      </button>
                    )}
                    {["approved", "active", "held"].includes(seq.status) && (
                      <button className="danger" onClick={() => act(seq.id, "stop")}>
                        Stop sequence
                      </button>
                    )}
                    {["saved", "stopped", "archived"].includes(seq.status) &&
                      (started ? (
                        <button className="primary" onClick={() => act(seq.id, "restore")}>
                          Resume sequence
                        </button>
                      ) : (
                        <button onClick={() => act(seq.id, "restore")}>
                          Back to pending
                        </button>
                      ))}
                    {["replied", "done", "saved", "stopped"].includes(seq.status) && (
                      <button className="quiet" onClick={() => act(seq.id, "archive")}>
                        Archive
                      </button>
                    )}
                  </div>
                  {["approved", "active", "held"].includes(seq.status) &&
                    blockedSlots.length > 0 && (
                      <p className="send-note">
                        Step {nextPos} still needs {blockedSlots.length}{" "}
                        {blockedSlots.length === 1 ? "answer" : "answers"}:{" "}
                        {blockedSlots.join(" · ")}. Nothing sends until you
                        replace that text.
                      </p>
                    )}
                  {seq.send_now && !blockedSlots.length && (
                    <p className="send-note">
                      Queued. Claude sends it on the next weekday morning
                      run, or right away if you ask in chat.
                    </p>
                  )}
                  {actErr && actErr.id === seq.id && (
                    <div className="err">{actErr.msg}</div>
                  )}
                </article>
    );
  }

  return (
    <div className="sdesk">
      <header className="app-header">
        <div className="brandwrap">
          <span className="logomark" aria-hidden="true">
            R<span className="prime" />
          </span>
          <div className="brand">
            Rebel One CRM<span className="dot">.</span>
          </div>
        </div>
        <nav className="tabs">
          <a href="/"><button className="tab">Inbox</button></a>
          <a href="/contacts"><button className="tab">All Contacts</button></a>
          <a href="/sequences"><button className="tab active">Sequences</button></a>
        </nav>
        <div className="savestate">
          {saving ? "Saving…" : saveError ? `Save failed: ${saveError}` : "Saved"}
        </div>
      </header>

      <div className="wrap">
        <h1>
          Sequence Desk
          <button
            type="button"
            className="intro-toggle"
            onClick={toggleIntro}
            aria-expanded={introOpen}
          >
            {introOpen ? "Hide the guide \u25b4" : "How this works \u25be"}
          </button>
        </h1>
        {introOpen && (
        <p className="tagline">
          Investor sequences: review drafts, approve or archive, and track
          who is where. Cards sort themselves by status; the chip on each
          card is its live state.
        </p>
        )}

        {todos.length > 0 && (
          <section className="zone needs-you" aria-label="What needs you">
            <div className="ny-head">
              <h2>Needs you</h2>
              <span className="ny-count">
                {todos.length} item{todos.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul className="ny-list">
              {todos.map((t) => (
                <li key={`${t.kind}-${t.seq.id}`}>
                  <button
                    type="button"
                    className={`ny-item k-${t.kind}`}
                    onClick={() => jumpTo(t.seq)}
                  >
                    <span className={`ny-kind k-${t.kind}`}>
                      {t.kind === "held"
                        ? "Fill in"
                        : t.kind === "qa"
                          ? "QA flag"
                          : t.kind === "draft"
                            ? "Approve"
                            : "Replied"}
                    </span>
                    <span className="ny-who">{t.seq.name}</span>
                    <span className="ny-what">{t.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!loading && !loadError && todos.length === 0 && (
          <section className="zone needs-you all-clear">
            <div className="ny-head">
              <h2>Needs you</h2>
              <span className="ny-count">nothing \u2014 all clear</span>
            </div>
          </section>
        )}

        {introOpen && (
        <div className="howto">
          <p>
            <strong>Add someone:</strong> paste their name, email, and
            background into the Claude chat for a fully personalized draft,
            or use New sequence below. The drafted sequence (introduction
            plus 7 follow-ups) appears here; the introduction sends when
            you approve.
          </p>
          <p>
            <strong>Where is everyone?</strong> Each card&apos;s chip says it:
            &ldquo;Active · step N of 8 sent [date]&rdquo;. Open a card and every
            sent email carries a green ✓ with its send date.
          </p>
          <p>
            <strong>Edits</strong> to email text, subjects, and wait days
            save as you type. The ↑↓ arrows reorder unsent steps, × removes one, ⚑ sets a review checkpoint; the ☆
            star makes an email the new template default for that step.
            Decisions take effect at the next weekday morning run, or
            immediately with Send next email now.
          </p>
        </div>
        )}

        <NewSequenceForm
          onCreated={(s) => {
            setSequences((prev) => [s, ...prev]);
            setOpen(s.id, true);
          }}
        />

        <FactsPanel facts={facts} save={save} />

        <section className="zone">
          <h2>Drafts</h2>

          {loading && <div className="loading-bar">Loading…</div>}
          {loadError && <div className="err">{loadError}</div>}

          {drafts.length > 0 && (
            <div className="listbar">
              <span>
                {drafts.length} awaiting review
              </span>
              <button
                className="quiet"
                onClick={() => {
                  if (!openCards.size) drafts.forEach((s) => hydrate(s.id));
                  setOpenCards(
                    openCards.size
                      ? new Set()
                      : new Set(drafts.map((s) => s.id)),
                  );
                }}
              >
                {openCards.size ? "Collapse all" : "Expand all"}
              </button>
            </div>
          )}
          {!loading && drafts.length === 0 && (
            <p className="edit-hint">
              No drafts waiting. New ones appear here to read and approve.
            </p>
          )}

          <div className="list">
            {drafts.map((seq) => renderCard(seq))}
          </div>
        </section>

        <section className="zone">
          <h2>Running</h2>

          <div className="tallies">
            <button
              type="button"
              className={`tally ${runFilter === "needs" ? "on" : ""} ${
                needsYou.length ? "hot" : ""
              }`}
              onClick={() =>
                setRunFilter((f) => (f === "needs" ? "all" : "needs"))
              }
            >
              <span className="n">{needsYou.length}</span>
              <span className="k">need you</span>
            </button>
            <button
              type="button"
              className={`tally ${runFilter === "go" ? "on" : ""}`}
              onClick={() => setRunFilter((f) => (f === "go" ? "all" : "go"))}
            >
              <span className="n">{queued.length}</span>
              <span className="k">sending next run</span>
            </button>
            <button
              type="button"
              className={`tally ${runFilter === "all" ? "on" : ""}`}
              onClick={() => setRunFilter("all")}
            >
              <span className="n">{running.length}</span>
              <span className="k">running</span>
            </button>
          </div>

          {running.length > 0 && (
            <div className="arch-filters">
              <input
                className="arch-search"
                type="search"
                placeholder={"Search name, email, or firm\u2026"}
                aria-label="Search running sequences"
                value={runQuery}
                onChange={(e) => setRunQuery(e.target.value)}
              />
              <button className="quiet" onClick={() => setRunCards((v) => !v)}>
                {runCards ? "Table view" : "Card view"}
              </button>
              <span className="arch-count">
                {runRows.length} of {running.length} shown
              </span>
            </div>
          )}

          {!loading && running.length === 0 && (
            <p className="edit-hint">
              Nothing running. Approve a draft above and its introduction
              goes out on the next weekday morning run.
            </p>
          )}

          {running.length > 0 && runRows.length === 0 && (
            <p className="edit-hint">Nothing running matches that filter.</p>
          )}

          {runCards ? (
            <div className="list">{runRows.map((r) => renderCard(r.seq))}</div>
          ) : (
            runRows.length > 0 && (
              <div className="arch-wrap">
                <table className="arch-table run-table">
                  <colgroup>
                    <col className="c-name" />
                    <col className="c-contact" />
                    <col className="c-next" />
                    <col className="c-sent" />
                    <col className="c-last" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Firm</th>
                      <th>Next</th>
                      <th className="num">Sent</th>
                      <th>Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runRows.map(({ seq, next }) => {
                      const isOpen = runExpanded.has(seq.id);
                      const sent = seq.steps.filter((s) => s.sent_at).length;
                      const last = lastSentAt(seq);
                      return (
                        <Fragment key={seq.id}>
                          <tr
                            className={`${isOpen ? "open" : ""} tone-${next.tone}`}
                            onClick={() => {
                              if (!runExpanded.has(seq.id)) hydrate(seq.id);
                              setRunExpanded((prev) => {
                                const nx = new Set(prev);
                                if (nx.has(seq.id)) nx.delete(seq.id);
                                else nx.add(seq.id);
                                return nx;
                              });
                            }}
                          >
                            <td data-label="Name">
                              <span className="caret">
                                {isOpen ? "\u25be" : "\u25b8"}
                              </span>
                              {seq.name}
                              {seq.is_test && (
                                <span className="test-tag">TEST</span>
                              )}
                            </td>
                            {/* the firm identifies them at a glance; the
                                full address only ever truncated here, and
                                it is one tap away in the card */}
                            <td data-label="Firm" title={seq.email}>
                              {seq.firm ?? (
                                <span className="arch-email">{seq.email}</span>
                              )}
                            </td>
                            <td data-label="Next">
                              <span className={`nextchip t-${next.tone}`}>
                                {next.label}
                              </span>
                            </td>
                            <td className="num" data-label="Sent">
                              <span className="prog">
                                <span
                                  className="prog-fill"
                                  style={{
                                    width: `${
                                      (sent / Math.max(1, seq.steps.length)) * 100
                                    }%`,
                                  }}
                                />
                              </span>
                              {sent}/{seq.steps.length}
                            </td>
                            <td data-label="Last">
                              {last ? fmtDate(last) : "\u2014"}
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="arch-detail">
                              <td colSpan={5}>{renderCard(seq)}</td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>

        <section className="zone archive-zone">
          <h2 className="zone-toggle" onClick={() => setArchOpen((v) => !v)}>
            <span className="caret">{archOpen ? "\u25be" : "\u25b8"}</span>
            Archive
            <span className="zone-count">
              {closed.length} finished sequence{closed.length === 1 ? "" : "s"}
            </span>
          </h2>

          {archOpen && (
            <>
              <p className="edit-hint">
                Replied, completed, stopped, and archived sequences. Nothing
                here sends. Tap a row to read it, restore it, or archive it
                for good.
              </p>

              <div className="arch-filters">
                <input
                  className="arch-search"
                  type="search"
                  placeholder={"Filter by name, email, firm, background\u2026"}
                  value={archQuery}
                  onChange={(e) => setArchQuery(e.target.value)}
                  aria-label="Filter archived sequences"
                />
                <select
                  className="arch-status"
                  value={archStatus}
                  onChange={(e) =>
                    setArchStatus(e.target.value as "all" | SequenceStatus)
                  }
                  aria-label="Filter by status"
                >
                  <option value="all">All statuses</option>
                  {CLOSED_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {st[0].toUpperCase() + st.slice(1)} (
                      {closed.filter((s) => s.status === st).length})
                    </option>
                  ))}
                </select>
                {(archQuery || archStatus !== "all") && (
                  <button
                    className="quiet"
                    onClick={() => {
                      setArchQuery("");
                      setArchStatus("all");
                    }}
                  >
                    Clear
                  </button>
                )}
                <span className="arch-count">
                  {archiveRows.length} of {closed.length} shown
                </span>
              </div>

              {closed.length === 0 ? (
                <p className="edit-hint">
                  Nothing archived yet. Sequences land here once they are
                  replied to, completed, stopped, or archived.
                </p>
              ) : archiveRows.length === 0 ? (
                <p className="edit-hint">
                  No archived sequence matches that filter.
                </p>
              ) : (
                <div className="arch-wrap">
                  <table className="arch-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Contact</th>
                        <th>Status</th>
                        <th className="num">Sent</th>
                        <th>Last activity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archiveRows.map((seq) => {
                        const isOpen = archExpanded.has(seq.id);
                        const sent = seq.steps.filter((s) => s.sent_at).length;
                        return (
                          <Fragment key={seq.id}>
                            <tr
                              className={isOpen ? "open" : ""}
                              onClick={() => {
                                if (!archExpanded.has(seq.id)) hydrate(seq.id);
                                setArchExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(seq.id)) next.delete(seq.id);
                                  else next.add(seq.id);
                                  return next;
                                });
                              }}
                            >
                              <td data-label="Name">
                                <span className="caret">
                                  {isOpen ? "\u25be" : "\u25b8"}
                                </span>
                                {seq.name}
                                {seq.is_test && (
                                  <span className="test-tag">TEST</span>
                                )}
                              </td>
                              <td data-label="Contact">
                                <span className="arch-email">{seq.email}</span>
                                {seq.firm ? ` \u00b7 ${seq.firm}` : ""}
                              </td>
                              <td data-label="Status">
                                <span className={`chip status st-${seq.status}`}>
                                  {seq.status}
                                </span>
                              </td>
                              <td className="num" data-label="Sent">
                                {sent}/{seq.steps.length}
                              </td>
                              <td data-label="Last activity">
                                {fmtDate(seq.updated_at)}
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="arch-detail">
                                <td colSpan={5}>{renderCard(seq)}</td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>

        <section className="zone">
          <h2>Default template</h2>
          <div className="list">
            <article className="card">
              <div className="card-head">
                <h3>The 8-email default</h3>
                <span className="chip status st-template">Template</span>
              </div>
              <p className="metaline">
                Every new sequence is drafted from this. Email 1 is the
                introduction: it starts the thread and sends on approval;
                emails 2-8 follow up on that thread. Edit anything here and
                it becomes the default for future drafts.
              </p>
              <div className="bg-block">
                <span className="lbl">Why this arc</span>
                Built from current reply-rate research: every follow-up adds
                something new; why-you personalization comes early, where it
                lifts replies most; every email has one ask and invites a
                one-word answer; spacing widens through the sequence (2, 3,
                3, 4, 4, 5, 6 business days) since early follow-ups drive
                most replies and late fast ones read as spam.
              </div>

              <details
                className="seq"
                open={tplOpen}
                onToggle={(e) =>
                  setTplOpen((e.target as HTMLDetailsElement).open)
                }
              >
                <summary>
                  <span>Edit the template</span>
                  <span className="chip">intro + 7 follow-ups · editable</span>
                </summary>
                {templates.map((t) => (
                  <StepEditor
                    key={t.id}
                    step={{
                      id: t.id,
                      sequence_id: "",
                      position: t.position,
                      title: t.title,
                      subject: t.subject,
                      body: t.body,
                      wait_days: t.wait_days,
                      sent_at: null,
                      gmail_message_id: null,
                      // templates are drafts-of-drafts; a checkpoint on one
                      // would mean nothing
                      review_gate: false,
                    }}
                    url={`/api/sequences/templates/${t.id}`}
                    canMove={false}
                    onMove={() => {}}
                    save={save}
                  />
                ))}
              </details>
            </article>
          </div>
        </section>

        <section className="zone activity-zone">
          <h2>Send activity</h2>

          {sendStats ? (
            <>
              <div className="cap-meter">
                <div className="cap-line">
                  <span className="cap-count">
                    {sendStats.sent_today.toLocaleString()}
                  </span>
                  <span className="cap-of">
                    of {sendStats.daily_cap.toLocaleString()} sent today
                  </span>
                  {sendStats.no_send_today && (
                    <span className="no-send-badge">
                      No-send day: {sendStats.no_send_today}. Scheduled
                      sends pause; Send now still works.
                    </span>
                  )}
                </div>
                <div className="cap-bar">
                  <div
                    className="cap-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        (sendStats.sent_today / sendStats.daily_cap) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              <div className="activity-cols">
                <div>
                  <h3 className="mini-h">Sent per day</h3>
                  {sendStats.by_day.length === 0 ? (
                    <p className="edit-hint">No sends in the last 14 days.</p>
                  ) : (
                    <table className="mini-table">
                      <tbody>
                        {sendStats.by_day.map((d) => (
                          <tr key={d.day}>
                            <td>{d.day}</td>
                            <td className="num">{d.sent}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  <h3 className="mini-h">No-send days</h3>
                  <p className="edit-hint">
                    The scheduled run never sends on weekends or on these
                    dates, and they do not count toward wait times. Send
                    now and direct asks are exempt.
                  </p>
                  <table className="mini-table">
                    <tbody>
                      {noSendDays.map((d) => (
                        <tr key={d.day}>
                          <td>{d.day}</td>
                          <td>{d.label}</td>
                          <td className="num">
                            <button
                              className="quiet"
                              aria-label={`Remove no-send day ${d.day}`}
                              onClick={async () => {
                                await fetch("/api/sequences/no-send-days", {
                                  method: "DELETE",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({ day: d.day }),
                                });
                                load();
                              }}
                            >
                              {"\u00d7"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="ns-add">
                    <input
                      type="date"
                      aria-label="New no-send date"
                      value={nsDay}
                      onChange={(e) => setNsDay(e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="Label (e.g. Office closed)"
                      aria-label="Label for the no-send date"
                      value={nsLabel}
                      onChange={(e) => setNsLabel(e.target.value)}
                    />
                    <button
                      className="quiet"
                      disabled={!nsDay}
                      onClick={async () => {
                        await fetch("/api/sequences/no-send-days", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ day: nsDay, label: nsLabel }),
                        });
                        setNsDay("");
                        setNsLabel("");
                        load();
                      }}
                    >
                      Add day
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="edit-hint">
              Counter not available yet: run db/migrations/0014_crm_no_send_days.sql
              in Supabase and reload.
            </p>
          )}
        </section>

        <footer>
          A sequence stops on its own the moment the investor replies (any
          inbound message moves the thread to Investors/Replied for your
          review). Claude reads this page&apos;s data on every weekday run: it
          enrolls approved cards, sends what is due, honors stops, and
          refreshes the chips and ✓ marks.
        </footer>
      </div>
    </div>
  );
}
