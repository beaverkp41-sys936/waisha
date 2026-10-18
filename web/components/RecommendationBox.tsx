"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * The recommendation box (070) — one component, three shells.
 *
 * The transporter portal, the shipper portal and the seeker shell all render this and
 * they must not drift: a note sent from a truck and a note sent from a clearing office
 * have to land in the same register in the same shape, or the desk is not one inbox. So
 * the only thing a host passes in is its own auth-aware fetch and the prefix its token
 * is allowed to knock on (`/recommendations`, `/portal/recommendations`,
 * `/seeker/recommendations`) — the audience gate in api/src/security/audience.ts decides
 * which one a given token may use, and this component does not try to guess.
 *
 * The rules the form mirrors are the database's, not inventions of the UI: title 4–140,
 * body 15–4000, and withdrawal only while nobody has read the note yet. Counting the
 * characters on screen is what makes a refusal that arrives after a long paragraph
 * typed feel fair rather than arbitrary.
 */

export type Recommendation = {
  id: string; area: string; title: string; body: string; status: string;
  priority: string | null; reply: string | null; replied_at: string | null;
  decided_at: string | null; created_at: string; deleted_at?: string | null;
};

const AREAS: Array<[string, string]> = [
  ["transport", "Transport — trips, fleet, drivers, routes"],
  ["cfa", "Clearing and forwarding — cargo, jobs, duty"],
  ["office", "Office — attendance, staff, costs"],
  ["marketplace", "Finding a transporter or a CFA"],
  ["billing", "Subscription, invoices, payments"],
  ["documents", "Documents and files"],
  ["account", "My account, sign in, profile"],
  ["support", "The people who answer me"],
  ["other", "Something else"]
];

const STATUS_LABEL: Record<string, string> = {
  new: "Not read yet", reviewing: "Being reviewed", planned: "Planned",
  built: "Built", declined: "Not this time"
};
const STATUS_EDGE: Record<string, string> = {
  new: "var(--ink-soft)", reviewing: "var(--gold)", planned: "var(--warning)",
  built: "var(--success)", declined: "var(--danger)"
};

const CARD = "rounded-card border bg-surface p-20";
const CARD_STYLE = { borderColor: "var(--line)" };
const INPUT = "rounded-input border px-12 py-8 text-sm w-full";
const INPUT_STYLE = { borderColor: "var(--line)", background: "var(--milk)" };

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.14em]"
      style={{ color: "var(--ink-soft)" }}>
      {children}
    </span>
  );
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric"
  });
}

/** The API answers with a code and a sentence; the sentence is the one worth showing. */
function refusal(json: any, fallback: string): string {
  if (typeof json?.message === "string" && json.message) return json.message;
  if (typeof json?.error === "string" && json.error) return json.error;
  return fallback;
}

export function RecommendationBox({
  fetcher, prefix, who
}: {
  fetcher: (path: string, init?: RequestInit) => Promise<Response>;
  prefix: string;
  who: string;
}) {
  const [items, setItems] = useState<Recommendation[]>([]);
  const [area, setArea] = useState("other");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  // Withdrawal is armed, not confirmed: a native confirm() dialog wedges this app's
  // browser session, and a second tap on the same button is the same safety.
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetcher(prefix);
      const json = await res.json().catch(() => []);
      if (!res.ok) {
        setMsg({ kind: "bad", text: refusal(json, "Could not read your recommendations.") });
        return;
      }
      setItems(Array.isArray(json) ? json : []);
    } catch (e: any) {
      if (e?.message !== "session ended")
        setMsg({ kind: "bad", text: "Could not read your recommendations." });
    } finally {
      setReady(true);
    }
  }, [fetcher, prefix]);

  useEffect(() => { load(); }, [load]);

  const titleOk = title.trim().length >= 4 && title.trim().length <= 140;
  const bodyOk = body.trim().length >= 15 && body.trim().length <= 4000;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!titleOk || !bodyOk) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetcher(prefix, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, title: title.trim(), body: body.trim() })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ kind: "bad", text: refusal(json, "Could not send it.") }); return; }
      setTitle(""); setBody(""); setArea("other");
      setItems(cur => [json, ...cur]);
      setMsg({ kind: "ok", text: "Sent. It is on the register and the platform team reads it." });
    } catch (e: any) {
      if (e?.message !== "session ended") setMsg({ kind: "bad", text: "Could not send it." });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    if (armed !== id) { setArmed(id); return; }
    setArmed(null);
    setBusy(true); setMsg(null);
    try {
      const res = await fetcher(`${prefix}/${id}/withdraw`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ kind: "bad", text: refusal(json, "Could not withdraw it.") }); return; }
      setItems(cur => cur.filter(i => i.id !== id));
      setMsg({ kind: "ok", text: "Withdrawn. Nobody read it." });
    } catch (e: any) {
      if (e?.message !== "session ended") setMsg({ kind: "bad", text: "Could not withdraw it." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* The band sits on the photo pane in every shell, so it carries its own on-photo
          ink rather than inheriting one shell's flip and missing the other's. */}
      {msg && (
        <div role="status" className="mt-16 px-12 py-8 text-sm"
          style={{
            color: "var(--on-photo-soft)",
            ...(msg.kind === "ok"
              ? { background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }
              : { background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }),
          }}>
          {msg.text}
        </div>
      )}

      <form className={`${CARD} mt-20`} style={CARD_STYLE} onSubmit={send}>
        <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{ color: "var(--ink-soft)" }}>
          Write one
        </h2>
        <p className="mt-8 max-w-[620px] text-xs" style={{ color: "var(--ink-soft)" }}>
          {who} One note is one sentence someone can act on — &quot;the trip form makes me retype
          the plate on every leg&quot; is worth more here than &quot;make it better&quot;.
        </p>

        <label className="mt-16 block">
          <Label>Which part of it</Label>
          <select value={area} onChange={e => setArea(e.target.value)}
            className={INPUT} style={INPUT_STYLE}>
            {AREAS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>

        <label className="mt-16 block">
          <Label>In one line — up to 140 characters</Label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            maxLength={140} placeholder="e.g. Show the driver's phone on the trip card"
            className={INPUT} style={INPUT_STYLE} />
          <span className="mt-4 block text-[10px] tabular-nums"
            style={{ color: titleOk || !title ? "var(--ink-soft)" : "var(--danger)" }}>
            {title.trim().length}/140{title.trim().length > 0 && title.trim().length < 4 ? " · at least 4" : ""}
          </span>
        </label>

        <label className="mt-16 block">
          <Label>What you mean — 15 to 4,000 characters</Label>
          <textarea value={body} onChange={e => setBody(e.target.value)}
            rows={6} maxLength={4000}
            placeholder="What happens now, what you wanted instead, and how often you hit it."
            className={`${INPUT} leading-relaxed`} style={INPUT_STYLE} />
          <span className="mt-4 block text-[10px] tabular-nums"
            style={{ color: bodyOk || !body ? "var(--ink-soft)" : "var(--danger)" }}>
            {body.trim().length}/4,000{body.trim().length > 0 && body.trim().length < 15 ? " · at least 15" : ""}
          </span>
        </label>

        <button type="submit" disabled={busy || !titleOk || !bodyOk}
          className="waisha-btn mt-16 rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
          {busy ? "Sending" : "Send to the platform team"}
        </button>
      </form>

      <section className="mt-24">
        {/* `pane-note` is the shell's treatment for text that sits on the photo, not on glass. */}
        <h2 className="pane-note text-[10px] font-bold uppercase tracking-[0.14em]">
          What you have sent · {items.length}
        </h2>

        {!ready ? (
          <p className="pane-note mt-16 text-sm">Loading…</p>
        ) : !items.length ? (
          <p className="pane-note mt-16 text-sm">
            Nothing yet. Whatever you send appears here with the platform team&apos;s answer under it.
          </p>
        ) : (
          <div className="mt-16 space-y-14">
            {items.map(it => {
              const open = it.status === "new" && !it.reply && !it.decided_at;
              return (
                <article key={it.id} className="rounded-card border bg-surface p-20"
                  style={{ ...CARD_STYLE, borderLeft: `4px solid ${STATUS_EDGE[it.status] ?? "var(--line)"}` }}>
                  <div className="flex flex-wrap items-center gap-8 text-[10px] font-bold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    <span>{AREAS.find(([v]) => v === it.area)?.[1].split(" — ")[0] ?? it.area}</span>
                    <span aria-hidden>·</span>
                    <span style={{ color: STATUS_EDGE[it.status] ?? "var(--ink-soft)" }}>
                      {STATUS_LABEL[it.status] ?? it.status}
                    </span>
                    <span className="ml-auto normal-case tracking-normal" style={{ color: "var(--ink-soft)" }}>
                      {ago(it.created_at)}
                    </span>
                  </div>

                  <h3 className="mt-10 text-base font-bold" style={{ color: "var(--ink)" }}>
                    {it.title}
                  </h3>
                  <p className="mt-8 whitespace-pre-wrap text-sm leading-relaxed"
                    style={{ color: "var(--ink-soft)" }}>
                    {it.body}
                  </p>

                  {it.reply && (
                    <div className="mt-14 rounded-input border-l-4 px-14 py-10 text-sm"
                      style={{ borderLeftColor: "var(--success)",
                        background: "color-mix(in srgb, var(--success) 8%, transparent)",
                        color: "var(--ink)" }}>
                      <p className="text-[10px] font-bold uppercase tracking-[0.14em]"
                        style={{ color: "var(--ink-soft)" }}>
                        The platform team answered · {ago(it.replied_at)}
                      </p>
                      <p className="mt-6 whitespace-pre-wrap">{it.reply}</p>
                    </div>
                  )}

                  {open && (
                    <button type="button" disabled={busy}
                      onClick={() => withdraw(it.id)}
                      className="mt-14 rounded-input border px-14 py-6 text-[11px] font-bold uppercase tracking-[0.12em]"
                      style={{
                        borderColor: armed === it.id ? "var(--danger)" : "var(--line)",
                        color: armed === it.id ? "var(--danger)" : "var(--ink-soft)"
                      }}>
                      {armed === it.id ? "Tap again to withdraw" : "Withdraw"}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
