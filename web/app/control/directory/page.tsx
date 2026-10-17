"use client";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

type PassRow = {
  pass_id: string; tenant_id: string; seeker_name: string | null; email: string;
  kind: string; amount: string; currency: string;
  payment_method: string | null; payment_reference: string; recorded_at: string;
};
type ListingRow = {
  listing_id: string; tenant_id: string; company_name: string; serves: string[];
  status: string; is_verified: boolean; region_names: string[];
  contact_name: string | null; contact_channel: string | null;
  published_at: string | null; updated_at: string; searches: string | number;
};

const METHODS: Record<string, string> = {
  mpesa: "M-Pesa", airtel_money: "Airtel Money", tigo_pesa: "Mixx by Yas (Tigo Pesa)",
  halotel_cash: "Halotel Cash", bank_transfer: "Bank / Lipa Namba", cash: "Cash", other: "Other"
};

// Display only — the amount arrives as text from a numeric column and is never
// recomputed here, because the price the seeker paid lives in the pass row.
function show(amount: string, currency: string) {
  const n = Number(amount);
  return `${currency} ${Number.isFinite(n) ? n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount}`;
}
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export default function ControlDirectoryPage() {
  const [passes, setPasses] = useState<PassRow[]>([]);
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadPasses = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/directory/passes`, { credentials: "include" });
    if (res.status === 401 || res.status === 403) { window.location.href = "/control/login"; return; }
    if (res.ok) setPasses(await res.json());
  }, []);

  const loadListings = useCallback(async (search: string) => {
    const res = await fetch(`${API}/api/v1/control/directory/listings${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      { credentials: "include" });
    if (res.status === 401 || res.status === 403) { window.location.href = "/control/login"; return; }
    if (res.ok) setListings(await res.json());
  }, []);

  useEffect(() => { loadPasses(); loadListings(""); }, [loadPasses, loadListings]);

  async function post(path: string, body: any, done: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch(`${API}/api/v1${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "The platform refused that."); return false; }
      setNotice(done);
      return true;
    } finally {
      setBusy(false); setArmed(null);
    }
  }

  async function decide(p: PassRow, approve: boolean) {
    const note = (notes[p.pass_id] ?? "").trim();
    if (!approve && note.length < 4) {
      setError("A refusal needs the reason in the record — the seeker cannot see it, but the next person at this desk has to.");
      return;
    }
    const done = approve
      ? `Confirmed: ${p.seeker_name ?? p.email}'s week is live from now (${show(p.amount, p.currency)}, ref ${p.payment_reference}).`
      : `Refused: reference ${p.payment_reference} is marked rejected with your note.`;
    if (await post(`/control/directory/passes/${p.pass_id}/verify`, { approve, note: note || undefined }, done)) {
      setNotes(s => ({ ...s, [p.pass_id]: "" }));
      loadPasses();
    }
  }

  async function moderate(l: ListingRow, action: "verify" | "unverify" | "suspend" | "reinstate") {
    const note = (notes[l.listing_id] ?? "").trim();
    if (action === "suspend" && note.length < 4) {
      setError("A suspension needs a reason the company can act on.");
      return;
    }
    const words: Record<string, string> = {
      verify: `Verified ${l.company_name}.`, unverify: `Verification withdrawn from ${l.company_name}.`,
      suspend: `Suspended ${l.company_name} — it no longer appears in searches.`,
      reinstate: `${l.company_name} is live again.`
    };
    if (await post(`/control/directory/listings/${l.listing_id}/moderate`, { action, note: note || undefined }, words[action])) {
      setNotes(s => ({ ...s, [l.listing_id]: "" }));
      loadListings(q);
    }
  }

  // Armed on the first tap, executed on the second — these write to other people's
  // accounts and money records, and a stray click must cost nothing.
  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); setError(null); return; }
    run();
  };

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const smallBtn = "rounded-input border px-12 py-6 text-[11px] font-semibold";
  const note = (id: string) => (
    <input value={notes[id] ?? ""} onChange={e => setNotes(s => ({ ...s, [id]: e.target.value }))}
      placeholder="Note for the record (optional)" className={inputCls} style={inputStyle} />
  );

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Super Admin · Directory and search passes
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1080px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Marketplace desk</h1>
        <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
          Nothing here moves money. WAISHA never touches a payment — these are references people
          typed after paying the office out of band, and confirming one starts their week from this
          moment, not from the hour they paid.
        </p>

        {notice && (
          <div className="mb-16 rounded-input px-12 py-8 text-sm" role="status"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        <section className="mb-32 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-8 border-b px-16 py-12" style={{ borderColor: "var(--line)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Payment references awaiting confirmation
            </h2>
            <span className="text-[11px] font-semibold" style={{ color: "var(--ink-soft)" }}>
              {passes.length} waiting{passes.length === 200 ? " (showing first 200)" : ""}
            </span>
          </div>
          {passes.length === 0 ? (
            <p className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
              Nobody is waiting on the office right now.
            </p>
          ) : (
            <ul>
              {passes.map((p, i) => (
                <li key={p.pass_id} className="px-16 py-14" style={{ background: i % 2 ? "var(--milk-deep)" : "transparent", borderTop: i ? `1px solid var(--line)` : undefined }}>
                  <div className="flex flex-wrap items-start justify-between gap-12">
                    <div className="min-w-[240px] flex-1">
                      <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                        {p.seeker_name ?? "—"} <span className="font-normal" style={{ color: "var(--ink-soft)" }}>· {p.email}</span>
                      </p>
                      <p className="mt-4 text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {show(p.amount, p.currency)} · {METHODS[p.payment_method ?? ""] ?? p.payment_method ?? "channel not stated"} ·
                        recorded {when(p.recorded_at)}
                      </p>
                      <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--adm-accent)" }}>
                        Ref {p.payment_reference} · {p.kind}
                      </p>
                    </div>
                    <div className="flex min-w-[220px] flex-col gap-8">
                      {note(p.pass_id)}
                      <div className="flex flex-wrap gap-8">
                        <button type="button" disabled={busy} onClick={twoTap(`pass-${p.pass_id}-ok`, () => decide(p, true))}
                          className={`${smallBtn} ${armed === `pass-${p.pass_id}-ok` ? "is-on" : ""}`}
                          style={{ borderColor: "var(--success)", color: "var(--ink)" }}>
                          {armed === `pass-${p.pass_id}-ok` ? "Tap again to confirm" : "Confirm payment"}
                        </button>
                        <button type="button" disabled={busy} onClick={twoTap(`pass-${p.pass_id}-no`, () => decide(p, false))}
                          className={smallBtn} style={{ borderColor: "var(--danger)", color: "var(--ink)" }}>
                          {armed === `pass-${p.pass_id}-no` ? "Tap again to refuse" : "Refuse"}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <div className="border-b px-16 py-12" style={{ borderColor: "var(--line)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Directory register
            </h2>
          </div>
          <div className="p-16">
            <input value={q} onChange={e => { setQ(e.target.value); loadListings(e.target.value); }}
              placeholder="Search by company name" className={inputCls} style={inputStyle} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-12">Company</th>
                  <th className="p-12">Serves</th>
                  <th className="p-12">Regions</th>
                  <th className="p-12">Status</th>
                  <th className="p-12 text-right">Opens</th>
                  <th className="p-12">Contact</th>
                  <th className="p-12 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l, i) => (
                  <tr key={l.listing_id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-12 align-top">
                      <p className="font-semibold" style={{ color: "var(--ink)" }}>{l.company_name}</p>
                      <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        updated {when(l.updated_at)}{l.published_at ? ` · live since ${new Date(l.published_at).toLocaleDateString("en-GB")}` : ""}
                      </p>
                    </td>
                    <td className="p-12 align-top" style={{ color: "var(--ink-soft)" }}>{l.serves.join(" + ") || "—"}</td>
                    <td className="p-12 align-top" style={{ color: "var(--ink-soft)" }}>{l.region_names.join(", ") || "—"}</td>
                    <td className="p-12 align-top">
                      <span className="px-8 py-4 text-[10px] font-bold uppercase" style={{ borderLeft: `4px solid ${l.status === "live" ? "var(--success)" : l.status === "suspended" ? "var(--danger)" : "var(--ink-soft)"}`, color: "var(--ink)" }}>
                        {l.status}
                      </span>
                      {l.is_verified && (
                        <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--adm-accent)" }}>verified</p>
                      )}
                    </td>
                    <td className="p-12 text-right align-top tabular-nums" style={{ color: "var(--ink)" }}>{Number(l.searches ?? 0)}</td>
                    <td className="p-12 align-top text-xs" style={{ color: "var(--ink-soft)" }}>
                      {l.contact_name ?? "—"}{l.contact_channel ? <><br />{l.contact_channel}</> : null}
                    </td>
                    <td className="p-12 align-top">
                      <div className="flex flex-col items-end gap-8">
                        <div className="flex flex-wrap justify-end gap-8">
                          <button type="button" disabled={busy}
                            onClick={twoTap(`lst-${l.listing_id}-v`, () => moderate(l, l.is_verified ? "unverify" : "verify"))}
                            className={smallBtn} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                            {armed === `lst-${l.listing_id}-v` ? "Tap again" : l.is_verified ? "Unverify" : "Verify"}
                          </button>
                          {l.status === "suspended" ? (
                            <button type="button" disabled={busy}
                              onClick={twoTap(`lst-${l.listing_id}-r`, () => moderate(l, "reinstate"))}
                              className={smallBtn} style={{ borderColor: "var(--success)", color: "var(--ink)" }}>
                              {armed === `lst-${l.listing_id}-r` ? "Tap again" : "Reinstate"}
                            </button>
                          ) : (
                            <button type="button" disabled={busy}
                              onClick={twoTap(`lst-${l.listing_id}-s`, () => moderate(l, "suspend"))}
                              className={smallBtn} style={{ borderColor: "var(--danger)", color: "var(--ink)" }}>
                              {armed === `lst-${l.listing_id}-s` ? "Tap again" : "Suspend"}
                            </button>
                          )}
                        </div>
                        <div className="w-full min-w-[200px]">{note(l.listing_id)}</div>
                      </div>
                    </td>
                  </tr>
                ))}
                {listings.length === 0 && (
                  <tr><td className="p-16 text-sm" style={{ color: "var(--ink-soft)" }} colSpan={7}>
                    No listing matches that name. Companies publish their own entry from
                    their portal; this register is every one that exists.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
