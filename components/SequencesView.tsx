"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Sequence,
  SequenceEvent,
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

// Finished states: nothing more will be sent without a human restoring them.
// These live in the archive section, not the working board.
const CLOSED_STATUSES: SequenceStatus[] = [
  "replied",
  "done",
  "stopped",
  "archived",
];

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
  const [body, setBody] = useState(step.body);
  const [wait, setWait] = useState(step.wait_days);
  const sent = !!step.sent_at;

  useEffect(() => {
    setTitle(step.title);
    setSubject(step.subject ?? "");
    setBody(step.body);
    setWait(step.wait_days);
  }, [step.id, step.title, step.subject, step.body, step.wait_days]);

  return (
    <div className="step">
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const [tplOpen, setTplOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<Set<string>>(new Set());
  const [actErr, setActErr] = useState<{ id: string; msg: string } | null>(null);
  const [archOpen, setArchOpen] = useState(false);
  const [archQuery, setArchQuery] = useState("");
  const [archStatus, setArchStatus] = useState<"all" | SequenceStatus>("all");
  const [archExpanded, setArchExpanded] = useState<Set<string>>(new Set());
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { save, saving, error: saveError } = useSaver();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sequences");
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? "load failed");
      setSequences(j.sequences);
      setTemplates(j.templates);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
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
    const updated = await act(seq.id, "send_now");
    if (updated && !updated.send_now && updated.status === "held") {
      setActErr({
        id: seq.id,
        msg: `Not queued. ${updated.hold_reason ?? "The next email still needs input."} Fill that in above, then send.`,
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
              const blockedSlots = nextStep
                ? (
                    (nextStep.position === 1
                      ? `${nextStep.subject ?? ""}\n${nextStep.body}`
                      : nextStep.body
                    ).match(/\[[^\]]+\]/g) ?? []
                  )
                : [];
              return (
                <article className={`card status-${seq.status}`} key={seq.id}>
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

                    {seq.steps.map((st) => (
                      <StepEditor
                        key={st.id}
                        step={st}
                        url={`/api/sequences/${seq.id}/steps/${st.id}`}
                        canMove={!st.sent_at}
                        onMove={(dir) => move(seq, st, dir)}
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
                      that step; ↑↓ reorder unsent steps.
                    </p>

                    {["approved", "active", "held"].includes(seq.status) && (
                      <div className="send-now">
                        <button
                          type="button"
                          disabled={blockedSlots.length > 0}
                          onClick={() => sendNow(seq)}
                        >
                          {blockedSlots.length
                            ? `Fill in step ${nextPos} to send`
                            : armed === seq.id
                              ? "Tap again to confirm send"
                              : "Send next email now"}
                        </button>
                        {blockedSlots.length > 0 && (
                          <p className="send-note">
                            Step {nextPos} still needs {blockedSlots.length}{" "}
                            {blockedSlots.length === 1 ? "answer" : "answers"}:{" "}
                            {blockedSlots.join(" · ")}. Nothing sends until
                            you replace that text.
                          </p>
                        )}
                        {seq.send_now && !blockedSlots.length && (
                          <p className="send-note">
                            Queued. Claude sends it on the next weekday
                            morning run, or right away if you ask in chat.
                          </p>
                        )}
                      </div>
                    )}
                  </details>

                  <ActivityLog seq={seq} />

                  <div className="actions">
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
                  {actErr && actErr.id === seq.id && (
                    <div className="err">{actErr.msg}</div>
                  )}
                </article>
    );
  }

  return (
    <div className="sdesk">
      <header className="app-header">
        <div className="brand">
          Rebel One <span>Sequences</span>
        </div>
        <div className="savestate">
          {saving ? "Saving…" : saveError ? `Save failed: ${saveError}` : "Saved"}
        </div>
      </header>

      <div className="wrap">
        <h1>Sequence Desk</h1>
        <p className="tagline">
          Investor sequences: review drafts, approve or archive, and track
          who is where. Cards sort themselves by status; the chip on each
          card is its live state.
        </p>

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
            save as you type. The ↑↓ arrows reorder unsent steps; the ☆
            star makes an email the new template default for that step.
            Decisions take effect at the next weekday morning run, or
            immediately with Send next email now.
          </p>
        </div>

        <NewSequenceForm
          onCreated={(s) => {
            setSequences((prev) => [s, ...prev]);
            setOpen(s.id, true);
          }}
        />

        <section className="zone">
          <h2>Sequences</h2>

          {loading && <div className="loading-bar">Loading…</div>}
          {loadError && <div className="err">{loadError}</div>}

          {live.length > 0 && (
            <div className="listbar">
              <span>
                {live.length} live sequence{live.length === 1 ? "" : "s"}
              </span>
              <button
                className="quiet"
                onClick={() =>
                  setOpenCards(
                    openCards.size ? new Set() : new Set(live.map((s) => s.id)),
                  )
                }
              >
                {openCards.size ? "Collapse all" : "Expand all"}
              </button>
            </div>
          )}
          {!loading && live.length === 0 && (
            <p className="edit-hint">
              Nothing live right now. New drafts appear here; finished ones
              are in the archive below.
            </p>
          )}

          <div className="list">
            {live.map((seq) => renderCard(seq))}
          </div>
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
                              onClick={() =>
                                setArchExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(seq.id)) next.delete(seq.id);
                                  else next.add(seq.id);
                                  return next;
                                })
                              }
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
