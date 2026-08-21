"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Sequence,
  SequenceStatus,
  SequenceStep,
  SequenceTemplateStep,
} from "@/lib/sequences";

const STATUS_LABEL: Record<SequenceStatus, string> = {
  pending: "Pending review",
  approved: "Approved · intro sends next run",
  active: "Active",
  held: "Needs input · held",
  replied: "Replied · sequence stopped",
  done: "All steps sent",
  stopped: "Stopped",
  saved: "Saved for later",
  archived: "Archived",
};

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

function hasSlots(text: string): boolean {
  return /\[[^\]]+\]/.test(text);
}

function fmtDate(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

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
}: {
  step: SequenceStep;
  url: string;
  canMove: boolean;
  onMove: (dir: "up" | "down") => void;
  save: (key: string, url: string, patch: Record<string, unknown>) => void;
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
    <div className={`seq-step ${sent ? "sent" : ""}`}>
      <div className="seq-step-head">
        <span className="seq-step-n">{step.position}</span>
        <input
          className="seq-step-title"
          value={title}
          disabled={sent}
          onChange={(e) => {
            setTitle(e.target.value);
            save(`${step.id}:title`, url, { title: e.target.value });
          }}
        />
        {sent ? (
          <span className="seq-sent-pill">✓ SENT {fmtDate(step.sent_at)}</span>
        ) : (
          <>
            {canMove && (
              <span className="seq-move">
                <button onClick={() => onMove("up")} aria-label="Move earlier">↑</button>
                <button onClick={() => onMove("down")} aria-label="Move later">↓</button>
              </span>
            )}
            {step.position === 1 ? (
              <span className="seq-wait">sends on approval</span>
            ) : (
              <label className="seq-wait">
                wait{" "}
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={wait}
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
          </>
        )}
      </div>
      {step.position === 1 && (
        <input
          className="seq-subject"
          placeholder="Subject"
          value={subject}
          disabled={sent}
          onChange={(e) => {
            setSubject(e.target.value);
            save(`${step.id}:subject`, url, { subject: e.target.value });
          }}
        />
      )}
      <textarea
        className="seq-body"
        value={body}
        disabled={sent}
        rows={Math.max(5, body.split("\n").length + 1)}
        onChange={(e) => {
          setBody(e.target.value);
          save(`${step.id}:body`, url, { body: e.target.value });
        }}
      />
      {!sent && hasSlots(body + (step.position === 1 ? subject : "")) && (
        <div className="seq-slot-note">
          Contains [slots]; this step is held until they are replaced with
          real content.
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
      <div className="seq-new">
        <button className="btn primary" onClick={() => setOpen(true)}>
          New sequence
        </button>
        <span className="seq-new-hint">
          or paste the person into Claude chat for a fully personalized draft
        </span>
      </div>
    );
  }
  return (
    <div className="seq-card seq-new-form">
      <div className="seq-form-grid">
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
      {error && <div className="seq-error">{error}</div>}
      <div className="seq-actions">
        <button
          className="btn primary"
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
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
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

  async function act(id: string, action: string) {
    const res = await fetch(`/api/sequences/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const j = await res.json();
    if (res.ok) {
      setSequences((prev) => prev.map((s) => (s.id === id ? { ...s, ...j } : s)));
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

  function toggle(id: string) {
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <header className="app-header">
        <div className="brand">
          Rebel One <span>Sequences</span>
        </div>
        <div className="seq-savestate">
          {saving ? "Saving…" : saveError ? `Save failed: ${saveError}` : "Saved"}
        </div>
      </header>

      <main className="seq-wrap">
        <p className="seq-intro">
          Investor sequences: an introduction that starts the thread on
          approval, then follow-ups on the same thread after each wait.
          Everything here saves as you type. Claude sends approved emails
          on the weekday morning run, or immediately with Send next now
          (also by asking in chat). A reply from the investor stops their
          sequence automatically.
        </p>

        <NewSequenceForm
          onCreated={(s) => {
            setSequences((prev) => [s, ...prev]);
            setOpenCards((prev) => new Set(prev).add(s.id));
          }}
        />

        {loading && <div className="loading-bar">Loading…</div>}
        {loadError && <div className="seq-error">{loadError}</div>}

        {ordered.map((seq) => {
          const open = openCards.has(seq.id);
          const sentCount = seq.steps.filter((s) => s.sent_at).length;
          return (
            <div className={`seq-card status-${seq.status}`} key={seq.id}>
              <div className="seq-card-head" onClick={() => toggle(seq.id)}>
                <div>
                  <div className="seq-name">
                    {seq.name}
                    {seq.is_test && <span className="seq-test-tag">TEST</span>}
                  </div>
                  <div className="seq-meta">
                    {seq.email}
                    {seq.firm ? ` · ${seq.firm}` : ""}
                    {sentCount
                      ? ` · ${sentCount} of ${seq.steps.length} sent`
                      : ` · ${seq.steps.length} emails drafted`}
                  </div>
                </div>
                <span className={`seq-chip s-${seq.status}`}>
                  {STATUS_LABEL[seq.status]}
                  {seq.send_now ? " · send queued" : ""}
                </span>
              </div>

              {seq.hold_reason && seq.status === "held" && (
                <div className="seq-hold">{seq.hold_reason}</div>
              )}

              {open && (
                <>
                  {seq.background && (
                    <div className="seq-bg">
                      <span>Background</span> {seq.background}
                    </div>
                  )}
                  {seq.steps.map((st) => (
                    <StepEditor
                      key={st.id}
                      step={st}
                      url={`/api/sequences/${seq.id}/steps/${st.id}`}
                      canMove={!st.sent_at}
                      onMove={(dir) => move(seq, st, dir)}
                      save={save}
                    />
                  ))}
                </>
              )}

              <div className="seq-actions">
                {seq.status === "pending" && (
                  <>
                    <button className="btn primary" onClick={() => act(seq.id, "approve")}>
                      Approve &amp; enroll
                    </button>
                    <button className="btn" onClick={() => act(seq.id, "save")}>
                      Save for later
                    </button>
                    <button className="btn quiet" onClick={() => act(seq.id, "archive")}>
                      Archive
                    </button>
                  </>
                )}
                {["approved", "active", "held"].includes(seq.status) && (
                  <>
                    {!seq.send_now && (
                      <button className="btn primary" onClick={() => act(seq.id, "send_now")}>
                        Send next now
                      </button>
                    )}
                    <button className="btn danger" onClick={() => act(seq.id, "stop")}>
                      Stop sequence
                    </button>
                  </>
                )}
                {["saved", "stopped", "archived"].includes(seq.status) && (
                  <button className="btn" onClick={() => act(seq.id, "restore")}>
                    Back to pending
                  </button>
                )}
                {["replied", "done", "saved", "stopped"].includes(seq.status) && (
                  <button className="btn quiet" onClick={() => act(seq.id, "archive")}>
                    Archive
                  </button>
                )}
                <button className="btn quiet" onClick={() => toggle(seq.id)}>
                  {open ? "Collapse" : "Read the sequence"}
                </button>
              </div>
            </div>
          );
        })}

        <h2 className="seq-zone-title">Default template</h2>
        <p className="seq-intro">
          Every new draft starts from this. Edits here apply to future
          sequences only. [Bracketed] slots get personalized per investor
          at draft time.
        </p>
        <div className="seq-card status-template">
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
        </div>
      </main>
    </div>
  );
}
