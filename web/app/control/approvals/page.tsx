"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/** One proposal on the board — the exact bytes a second seat is asked to sign. */
interface ApprovalRow {
  id: string; action: string; target_kind: string; target_id: string; target_name: string;
  reason: string; approval_status: string;
  payload: { tenant_id?: string; reason_code?: string; note?: string;
    request_id?: string; ref?: string; ticket_ref?: string; amount?: string;
    currency?: string; pay_back?: string; company_name?: string; reason?: string };
  payload_sha256: string;
  proposed_name: string | null; proposed_role: string | null; proposed_at: string;
  decided_name: string | null; decided_role: string | null;
  decided_note: string | null; decided_at: string | null;
  applied_at: string | null;
  result: { action_id?: string; new_status?: string; sessions_revoked?: number | null;
    request_id?: string; ref?: string; amount?: string; currency?: string;
    pay_back?: string; request_status?: string } | null;
  expires_at: string;
}
interface Counts {
  pending: number; approved: number; applied: number;
  rejected: number; lapsed: number; total: number;
}
/** The answer to a signature that was spent: what the company is now, and who was told. */
interface Applied {
  action_id: string; action: string; tenant_name: string;
  prior_status: string; new_status: string; closed: boolean;
  seats_licensed: number | null; sessions_revoked?: number;
  reason_code: string; note: string; approval_id: string;
  delivery?: {
    subject?: string; recipients?: number;
    sms?: { sent: number; failed: number }; email?: { sent: number; failed: number };
    errors?: string[]; sent_at?: string;
  };
}
/** The answer to a spent refund signature. `released` is the office agreeing to pay, not a
 *  payment: the money leaves with #344's ledger, and saying so here is the whole honesty of
 *  this panel. */
interface SpentRefund {
  request_id: string; ref: string; amount: string; currency: string; pay_back: string;
  ticket_ref?: string; company_name: string; request_status: string;
  approval_id: string; raised_by?: string; released_by?: string;
}

const ACTIONS: [string, string][] = [
  ["", "Any act"], ["tenant.block", "A proposed block"], ["tenant.close", "A proposed close"],
  ["service.refund", "A proposed refund"]
];
const TABS: [string, string][] = [
  ["pending", "Waiting"], ["applied", "Done"], ["rejected", "Refused"],
  ["lapsed", "Lapsed"], ["all", "Everything"]
];
const actionLabel = (a: string) => ACTIONS.find(([v]) => v === a)?.[1] ?? a;
const reasonLabel = (k?: string) => ({
  terms_violation: "breach of the WAISHA terms", long_idle: "no paid licence for a long time",
  payment_default: "unpaid subscription", abuse: "misuse of the platform",
  complaint: "a complaint against this company", security: "a security concern", other: "another decision"
} as Record<string, string>)[k ?? ""] ?? (k ?? "—");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const seat = (name: string | null, role: string | null) =>
  name ? `${name}${role ? ` (${role})` : ""}` : (role ?? "a platform seat");
const isRefund = (r: ApprovalRow) => r.action === "service.refund";
/** What the row is about, said the way a seat can act on it. A refund paper's target_name is
 *  the uuid behind the request, and no one signs a uuid — the armed tap and the export both
 *  have to carry the ref the caller was quoted. */
const subject = (r: ApprovalRow) =>
  isRefund(r) ? r.payload?.ref ?? r.target_name : r.target_name;

/** Left as it was, or already shut? The badge has to answer without reading the sentence. */
function statusTone(s: string) {
  return s === "pending" ? "var(--warning)"
    : s === "applied" ? "var(--danger)"
    : s === "rejected" ? "var(--ink-soft)"
    : s === "lapsed" ? "var(--ink-soft)" : "var(--adm-accent)";
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [status, setStatus] = useState("pending");
  const [action, setAction] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canDecide, setCanDecide] = useState(false);
  const [csvNote, setCsvNote] = useState<string | null>(null);
  const [sign, setSign] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState<Applied | null>(null);
  const [spentRefund, setSpentRefund] = useState<SpentRefund | null>(null);

  const LIMIT = 30;

  const load = useCallback(async (s: string, a: string, search: string, off: number) => {
    setLoading(true);
    setCsvNote(null);
    try {
      const p = new URLSearchParams({ status: s, limit: String(LIMIT), offset: String(off) });
      if (a) p.set("action", a);
      if (search.trim()) p.set("q", search.trim());
      const res = await fetch(`${API}/api/v1/control/approvals?${p}`, { credentials: "include" });
      if (res.status === 401 || res.status === 403) { window.location.href = "/control/login"; return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error?.message ?? "The register could not be read.");
        setRows([]); setCounts(null);
        return;
      }
      const j = await res.json();
      setRows((j.rows ?? []) as ApprovalRow[]);
      setCounts((j.counts ?? null) as Counts | null);
      setError(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const a = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (a.ok) {
        const j = await a.json();
        setCanDecide((j.permissions ?? []).includes("control.approvals.decide"));
      }
    })();
  }, []);

  useEffect(() => { load(status, action, q, offset); }, [status, action, q, offset, load]);

  function openRow(id: string) {
    setSign(sign === id ? null : id); setNote(""); setArmed(null);
    setSpent(null); setSpentRefund(null);
  }

  /**
   * Sign, or refuse. One call either way, and the difference is which button was pressed
   * inside the same panel — a desk that has to find a different endpoint to say "no" is a
   * desk that will eventually say "yes" by accident.
   *
   * Approving is not a note on a form: the definer applies the ban in the same transaction
   * that spends the signature, so this is the press that shuts a company out and the reason
   * the second tap is armed.
   */
  async function decide(row: ApprovalRow, decision: "approve" | "reject") {
    setBusy(true); setError(null); setSpent(null); setSpentRefund(null);
    try {
      const res = await fetch(`${API}/api/v1/control/approvals/${row.id}/${decision}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ note: note.trim() })
      });
      const j = await res.json().catch(() => ({}));
      await load(status, action, q, offset);
      setArmed(null);
      if (!res.ok) {
        // A seat signing its own proposal is refused by the definer with its own status, and
        // the answer has to name what to do about it rather than read as a broken button.
        setError(j?.error?.message ?? (decision === "approve"
          ? "The signature did not land. Nothing was changed."
          : "The refusal did not land."));
        if (res.status === 403 || res.status === 409 || res.status === 410) {
          setSign(null); setNote("");
        }
        return;
      }
      if (decision === "approve") {
        if (row.action === "service.refund") setSpentRefund(j as SpentRefund);
        else setSpent(j as Applied);
        setNote("");
      } else {
        setSign(null);
      }
    } finally { setBusy(false); }
  }

  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    run();
  };

  // The board as the office keeps it: one line per proposal, quoted out for the file that
  // has to show why a company was shut. The read is already gated on the duty that lets a
  // seat see these rows at all, so a download of what is on screen adds no authority.
  function exportCsv() {
    const head = ["raised_at", "act", "company", "reason_for_the_office", "note_to_the_company",
      "payload_sha256", "raised_by", "status", "signed_by", "signed_note", "signed_at", "applied_at"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = rows.map(r => [r.proposed_at, r.action, subject(r), r.reason,
      r.payload?.note, r.payload_sha256, seat(r.proposed_name, r.proposed_role),
      r.approval_status, seat(r.decided_name, r.decided_role), r.decided_note,
      r.decided_at, r.applied_at].map(cell).join(","));
    const blob = new Blob([[head.map(cell).join(","), ...body].join("\n")],
      { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waisha-approvals-${status}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setCsvNote(`Saved ${rows.length} row${rows.length === 1 ? "" : "s"} of this screen.`);
  }

  const countFor = (tab: string): number | null =>
    counts && tab !== "all" ? counts[tab as keyof Counts] : null;

  const total = counts?.total ?? 0;
  const shown = rows.length;

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Approvals · two seats for one act
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1080px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Approvals</h1>
        <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
          A ban is proposed by one platform seat and applied by another. Nothing on this page has happened
          to a company until a second seat signs it: signing a block or a close shuts the door in the same
          call, tells the company&apos;s directors by SMS and email, and writes both names on the
          company&apos;s register. A refund paper is raised on the <Link href="/control/service"
            className="underline" style={{ color: "var(--adm-accent)" }}>Service desk</Link> and signed
          here, and the figure the second seat signs is read out of the paper, not typed into this page.
          The seat that raised a proposal cannot sign it, and a proposal nobody signs lapses after a week.
        </p>

        {counts && (
          <p className="mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
            <span className="font-bold" style={{ color: statusTone("pending") }}>
              {counts.pending} waiting
            </span>
            {" "}· {counts.applied} applied · {counts.rejected} refused · {counts.lapsed} lapsed
            {" "}· {counts.approved} signed but not spent
          </p>
        )}

        {error && (
          <div role="alert" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
            {error}
          </div>
        )}
        {spent && (
          <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
              borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">
              Signed and applied · {spent.action} · {spent.prior_status} → {spent.new_status}
              {spent.sessions_revoked ? ` · ${spent.sessions_revoked} sessions revoked` : ""}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              {spent.tenant_name} · register row {spent.action_id} ·{" "}
              {spent.delivery
                ? `told ${(spent.delivery.sms?.sent ?? 0) + (spent.delivery.email?.sent ?? 0)} of `
                  + `${spent.delivery.recipients ?? 0} directors`
                  + `${spent.delivery.errors?.length ? ` · ${spent.delivery.errors.join("; ")}` : ""}`
                : "no delivery receipt"}
            </p>
          </div>
        )}

        {spentRefund && (
          <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
              borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">
              Signed and released · {spentRefund.ref} · {spentRefund.request_status}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              {spentRefund.company_name} · {new Intl.NumberFormat("en-GB").format(Number(spentRefund.amount))} {spentRefund.currency} by {spentRefund.pay_back} ·{" "}
              the paper is agreed, not paid — the payment itself is settled from the{" "}
              <Link href="/control/service" className="underline"
                style={{ color: "var(--adm-accent)" }}>Service desk</Link>.
            </p>
          </div>
        )}

        <div className="mb-16 flex flex-wrap items-center gap-8">
          {TABS.map(([v, l]) => (
            <button key={v} type="button" onClick={() => { setOffset(0); setStatus(v); setSign(null); }}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={status === v
                ? { borderColor: "var(--adm-accent)", color: "var(--ink)",
                  background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)" }
                : { borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              {l}
              {counts && countFor(v) !== null && (
                <span className="ml-8 tabular-nums">{countFor(v)}</span>
              )}
            </button>
          ))}
          <button type="button" onClick={exportCsv} disabled={rows.length === 0}
            className="ml-auto rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            Export this screen (CSV)
          </button>
        </div>

        {csvNote && (
          <p role="status" className="-mt-8 mb-16 text-xs" style={{ color: "var(--success)" }}>{csvNote}</p>
        )}

        <div className="mb-16 flex flex-wrap gap-12">
          <input value={q} onChange={e => { setQ(e.target.value); setOffset(0); }}
            placeholder="Search the reason, the note or the company" aria-label="Search proposals"
            className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
          <select value={action} onChange={e => { setAction(e.target.value); setOffset(0); }}
            aria-label="Filter by act" className="rounded-input border px-12 py-8 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        {loading && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }} role="status">Reading the register…</p>
        )}
        {!loading && rows.length === 0 && (
          <div className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {status === "pending" ? "Nothing is waiting for a signature."
                : "No proposals match this filter."}
            </p>
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              {status === "pending"
                ? <>A ban raised on the <Link href="/control/tenants" className="underline"
                  style={{ color: "var(--adm-accent)" }}>Tenants</Link> desk and a refund raised on the{" "}
                  <Link href="/control/service" className="underline"
                    style={{ color: "var(--adm-accent)" }}>Service</Link> desk both appear here the moment
                  they are proposed, and stay until a second seat signs them or a week passes.</>
                : "Try Everything, or widen the search."}
            </p>
          </div>
        )}

        {rows.map(r => {
          const mine = sign === r.id;
          const waiting = r.approval_status === "pending";
          // A refund paper is a different act on the same register: it names a figure and a
          // call rather than a company and a notice, and the sentence beside it has to say
          // what is being signed instead of borrowing the ban's words.
          const refund = isRefund(r);
          const figure = r.payload?.amount
            ? `${new Intl.NumberFormat("en-GB").format(Number(r.payload.amount))} ${r.payload.currency ?? ""}`
            : null;
          const lapsedAt = new Date(r.expires_at).getTime() - Date.now();
          return (
            <section key={r.id} className="mb-16 rounded-card border p-16"
              style={{ borderColor: waiting ? statusTone(r.approval_status) : "var(--line)",
                background: "var(--surface)" }}>
              <div className="flex flex-wrap items-start justify-between gap-12">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-8 text-base font-bold" style={{ color: "var(--ink)" }}>
                    <span className="rounded-full px-8 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                      style={{ background: statusTone(r.approval_status), color: "var(--brand-deep)" }}>
                      {r.approval_status}
                    </span>
                    {actionLabel(r.action)}
                  </h2>
                  <p className="mt-8 break-words text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {refund && r.payload?.ref
                      ? `${r.payload.ref} · ${r.payload.company_name ?? "a caller"}`
                      : r.target_name}
                  </p>
                  <p className="mt-4 text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                    {r.target_kind} · {r.target_id}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    raised {when(r.proposed_at)}
                  </p>
                  <p className="mt-4 text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    by {seat(r.proposed_name, r.proposed_role)}
                  </p>
                  {waiting && (
                    <p className="mt-4 text-[10px] tabular-nums"
                      style={{ color: lapsedAt < 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                      {lapsedAt < 0 ? "expires on the next read"
                        : `lapses in ${Math.ceil(lapsedAt / 86_400_000)} day(s)`}
                    </p>
                  )}
                </div>
              </div>

              <p className="mt-12 text-sm" style={{ color: "var(--ink)" }}>{r.reason}</p>
              {/* Whether the company has been told is a fact the signature changed. A row
                  still waiting describes a notice that has not happened; an applied row has
                  already sent one, and this desk cannot see whether it arrived — only the
                  company's own register carries the receipt. A refund paper is never sent
                  anywhere: the paper is the record, and the money is paid from it. */}
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                {refund
                  ? <>The paper asks to pay <span className="font-semibold"
                    style={{ color: "var(--ink)" }}>{figure ?? "a figure"}</span> back by{" "}
                    <span className="font-semibold" style={{ color: "var(--ink)" }}>
                      {r.payload?.pay_back ?? "the channel on the paper"}
                    </span>{" "}
                    {r.payload?.ticket_ref ? `on the call ${r.payload.ticket_ref}` : ""}
                    {r.payload?.reason ? ` — “${r.payload.reason}”` : ""}.</>
                  : r.approval_status === "applied"
                    ? <>The note that went with the effect: {r.payload?.note || "—"} — whether it
                      reached anyone is on{" "}
                      <Link href="/control/tenants" className="underline"
                        style={{ color: "var(--adm-accent)" }}>the company's register</Link>.</>
                    : r.approval_status === "pending" || r.approval_status === "approved"
                      ? `The company would be told: ${r.payload?.note || "—"}`
                      : `Never sent. The note would have read: ${r.payload?.note || "—"}`}
              </p>
              {!refund && (
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  For {reasonLabel(r.payload?.reason_code)}
                </p>
              )}
              <p className="mt-8 break-all font-mono text-[10px]" style={{ color: "var(--ink-soft)" }}>
                sha256 {r.payload_sha256}
              </p>

              {r.decided_at && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
                  {r.approval_status === "rejected" ? "Refused" : "Signed"} by{" "}
                  {seat(r.decided_name, r.decided_role)} · {when(r.decided_at)}
                  {r.decided_note ? ` — “${r.decided_note}”` : ""}
                </p>
              )}
              {r.applied_at && (
                <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>
                  Applied {when(r.applied_at)}
                  {r.result?.new_status ? ` · company is now ${r.result.new_status}` : ""}
                  {r.result?.sessions_revoked ? ` · ${r.result.sessions_revoked} sessions revoked` : ""}
                  {r.result?.request_status
                    ? ` · paper ${r.result.ref ?? r.result.request_id} is now ${r.result.request_status}`
                      + ` — the office has agreed to pay it, not paid it`
                    : ""}
                </p>
              )}

              {waiting && !canDecide && (
                <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Your seat can read this register but not sign it. Ask a platform seat that can sign a
                  ban — the same duty signs a refund.
                </p>
              )}

              {waiting && canDecide && !mine && (
                <button type="button" onClick={() => openRow(r.id)}
                  className="mt-12 rounded-input border px-16 py-10 text-xs font-semibold"
                  style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
                  {refund ? "Sign or refuse this refund"
                    : r.action === "tenant.close" ? "Sign or refuse this close"
                      : "Sign or refuse this block"}
                </button>
              )}

              {waiting && canDecide && mine && (
                <div className="mt-12 rounded-input border p-12" style={{ borderColor: "var(--line)" }}>
                  <label className="block">
                    <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]"
                      style={{ color: "var(--ink-soft)" }}>
                      Your line on it (4–400 characters) — it is kept with both names
                    </span>
                    <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      placeholder="What you checked before signing." aria-label="Signature note"
                      className="w-full rounded-input border px-12 py-8 text-sm"
                      style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                    <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      {note.trim().length}/400
                    </span>
                  </label>
                  <div className="mt-12 flex flex-wrap gap-8">
                    <button type="button" disabled={busy || note.trim().length < 4}
                      onClick={twoTap(`sign-${r.id}`, () => decide(r, "approve"))}
                      className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                      style={armed === `sign-${r.id}`
                        ? { borderColor: "var(--danger)",
                          background: "color-mix(in srgb, var(--danger) 14%, transparent)", color: "var(--ink)" }
                        : { borderColor: "var(--danger)", color: "var(--ink)" }}>
                      {armed === `sign-${r.id}`
                        ? `Tap again to ${refund ? "release" : r.action === "tenant.close" ? "close" : "block"} ${subject(r)}`
                        : `Sign and ${refund ? "release the paper"
                          : r.action === "tenant.close" ? "close the account" : "block access"}`}
                    </button>
                    <button type="button" disabled={busy || note.trim().length < 4}
                      onClick={() => decide(r, "reject")}
                      className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                      style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      Refuse it
                    </button>
                    <button type="button" onClick={() => { setSign(null); setNote(""); setArmed(null); }}
                      className="rounded-input border px-16 py-10 text-xs font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      Leave it waiting
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}

        {!loading && total > LIMIT && (
          <div className="mt-16 flex flex-wrap items-center gap-12">
            <button type="button" disabled={offset === 0}
              onClick={() => { setOffset(Math.max(0, offset - LIMIT)); setSign(null); }}
              className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              Newer
            </button>
            <button type="button" disabled={offset + shown >= total}
              onClick={() => { setOffset(offset + LIMIT); setSign(null); }}
              className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              Older
            </button>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {offset + 1}–{offset + shown} of {total} in this filter
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
