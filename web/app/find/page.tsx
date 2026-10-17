"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { seekerFetch } from "./api-client";
import { useMeter } from "./meter";
import {
  errorCode, errorDetail, errorText, fmtDate, hm, KIND_OPTIONS,
  LICENCE_COLORS, LICENCE_LABELS, SERVES_LABELS
} from "./labels";

const PAGE = 12;

/** Every code that means "the meter, not the network, stopped you". Each one gets the
 *  same panel with its own sentence and its own way out, because a seeker who is told
 *  only "search failed" has no idea whether to wait, to pay or to sign in again. */
const BLOCKED_CODES = new Set([
  "NO_SEARCH_PASS", "SEARCH_PASS_EXHAUSTED", "FREE_SEARCH_NOT_READY", "SEARCH_PASS_EXISTS",
  "PENDING_VERIFICATION", "SEARCH_PASS_EXPIRED", "SEARCH_PASS_NOT_USABLE",
  "SEARCH_PASS_NOT_OFFERED", "SEARCH_EXPIRED", "PASS_ALREADY_RECORDED",
  "PASS_AWAITING_VERIFICATION"
]);

type Card = {
  id: string; company_name: string; serves: string[]; headline: string | null;
  home_base: string | null; region_names: string[]; services_offered: string | null;
  corridors_served: string | null; fleet_size_declared: number | null;
  year_established: number | null; licence_valid_to: string | null; licence_state: string;
  contact_name: string; contact_channel: string; is_verified: boolean; total: number;
};

type Applied = { kind: string | null; regionId: number | null; query: string | null };

type Board = {
  searchId: string; found: number; remaining: number | null; passKind: string | null;
  resetsAt: string | null; results: Card[]; applied: Applied; offset: number;
};

type Region = { region_id: number; region_name: string; companies: number };

export default function FindSearchPage() {
  const { state, ready: meterReady, failed: meterFailed, refresh, claimFree } = useMeter();
  const [regions, setRegions] = useState<Region[]>([]);
  const [kind, setKind] = useState("");
  const [regionId, setRegionId] = useState("");
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; waitMinutes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Counts of live listings per region cost no credit — this is what the filter
    // dropdown is built from, and it must not spend a search just to draw a form.
    seekerFetch("/directory/regions")
      .then(async res => (res.ok ? res.json() : []))
      .then(rows => { if (!cancelled && Array.isArray(rows)) setRegions(rows); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  async function postSearch(overrides?: Partial<Applied>) {
    setBusy(true); setError(null); setBlocked(null); setClaimed(null);
    const applied: Applied = {
      kind: overrides?.kind ?? (kind || null),
      regionId: overrides?.regionId ?? (regionId ? Number(regionId) : null),
      query: overrides?.query ?? (query.trim() || null)
    };
    try {
      const res = await seekerFetch("/directory/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...applied, limit: PAGE, offset: 0 })
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setBoard({
          searchId: json.searchId, found: json.found ?? 0, remaining: json.remaining ?? null,
          passKind: json.passKind ?? null, resetsAt: json.resetsAt ?? null,
          results: json.results ?? [], applied, offset: 0
        });
        await refresh();
        return;
      }
      if (BLOCKED_CODES.has(errorCode(json))) {
        setBoard(null);
        setBlocked({
          message: errorText(json, "You cannot search yet."),
          waitMinutes: Number(errorDetail(json).freeWaitMinutes ?? state?.free_wait_minutes ?? 0)
        });
        return;
      }
      setBoard(null);
      setError(errorText(json, "Search failed."));
    } catch (e: any) {
      if (e?.message !== "session ended") setError("Search failed. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  /** Paging a search that was already paid for is free for five minutes — that is the
   *  whole point of the claim check, and why the pager uses the GET. */
  async function goTo(offset: number) {
    if (!board) return;
    setBusy(true); setError(null); setBlocked(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (board.applied.kind) qs.set("kind", board.applied.kind);
      if (board.applied.regionId) qs.set("regionId", String(board.applied.regionId));
      if (board.applied.query) qs.set("query", board.applied.query);
      const res = await seekerFetch(`/directory/search/${board.searchId}?${qs.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setBoard({ ...board, results: json.results ?? [], found: json.found ?? board.found, offset });
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (res.status === 410 || errorCode(json) === "SEARCH_EXPIRED") {
        setBoard(null);
        setBlocked({ message: errorText(json, "This search has timed out."), waitMinutes: state?.free_wait_minutes ?? 0 });
        return;
      }
      setError(errorText(json, "Could not load that page."));
    } catch (e: any) {
      if (e?.message !== "session ended") setError("Could not load that page.");
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true); setError(null); setBlocked(null); setClaimed(null);
    try {
      const r = await claimFree();
      if (r.ok) {
        setClaimed(`Free search ready — ${r.json.remaining ?? 1} search for 24 hours.`);
        return;
      }
      if (BLOCKED_CODES.has(r.code)) setBlocked({ message: r.message, waitMinutes: state?.free_wait_minutes ?? 0 });
      else setError(r.message);
    } finally {
      setBusy(false);
    }
  }

  const live = state?.live_pass_id != null;
  const wait = state?.free_wait_minutes ?? 0;
  const pages = board ? Math.max(1, Math.ceil((board.found ?? 0) / PAGE)) : 1;
  const page = board ? Math.floor(board.offset / PAGE) + 1 : 1;

  const inputCls = "rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>
        Find a transporter or a clearing agent
      </h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Companies publish a profile of their own accord: what they carry, where they base, which
        licences they declare. WAISHA does not verify their fleet — it verifies that they signed up.
      </p>

      {/* ---------- the meter ---------- */}
      <section className={`${card} mt-24`} style={cardStyle}>
        <div className="flex flex-wrap items-center justify-between gap-12">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Your search credits
            </p>
            {!meterReady ? (
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>Reading your meter…</p>
            ) : meterFailed ? (
              <p className="mt-8 text-sm" style={{ color: "var(--danger)" }}>{meterFailed}</p>
            ) : live ? (
              <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
                <strong>{state?.live_kind === "weekly" ? "Weekly pass" : "Free search"}</strong>{" "}
                — {state?.live_remaining ?? 0} search{state?.live_remaining === 1 ? "" : "es"} left
                {state?.live_expires_at ? `, until ${fmtDate(state.live_expires_at)}` : ""}.
              </p>
            ) : wait > 0 ? (
              <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
                Today&apos;s free search is used. The next one unlocks in <strong>{hm(wait)}</strong>.
              </p>
            ) : (
              <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
                You have one free search waiting — it costs nothing and lasts 24 hours.
              </p>
            )}
            {state && state.awaiting_count > 0 && (
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                {state.awaiting_count} recorded payment{state.awaiting_count === 1 ? "" : "s"} with the office,
                awaiting confirmation. Your free search works meanwhile.
              </p>
            )}
          </div>
          {!live && wait === 0 && (
            <button type="button" onClick={claim} disabled={busy}
              className="waisha-btn rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
              Claim free search
            </button>
          )}
          {!live && wait > 0 && (
            <Link href="/find/account" className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
              Or record a weekly pass
            </Link>
          )}
        </div>
        {state && state.verified === false && (
          <p className="mt-16 text-sm" style={{ color: "var(--warning)" }}>
            Your account is not confirmed yet. Sign out and enter the code we emailed you.
          </p>
        )}
        {claimed && (
          <p role="status" className="mt-16 px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {claimed}
          </p>
        )}
      </section>

      {/* ---------- the form ---------- */}
      <form className={`${card} mt-24`} style={cardStyle}
        onSubmit={e => { e.preventDefault(); void postSearch(); }}>
        <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          Who are you looking for?
        </p>
        <div className="mt-12 flex flex-wrap gap-12">
          <select value={kind} onChange={e => setKind(e.target.value)} className={inputCls} style={inputStyle}
            aria-label="Type of company">
            {KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={regionId} onChange={e => setRegionId(e.target.value)} className={inputCls}
            style={inputStyle} aria-label="Region">
            <option value="">Anywhere in Tanzania</option>
            {regions.map(r => (
              <option key={r.region_id} value={r.region_id}>
                {r.region_name} ({Number(r.companies)})
              </option>
            ))}
          </select>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Corridor, city, service…"
            className={`${inputCls} min-w-[200px] flex-1`} style={inputStyle} aria-label="Search words" />
          <button type="submit" disabled={busy}
            className="waisha-btn rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
            {busy ? "Searching" : "Search"}
          </button>
        </div>
        <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
          {live
            ? "One search spends one credit. Paging through the results you got costs nothing for the next few minutes."
            : "Searching spends one credit. Read the meter above before you run it."}
        </p>
      </form>

      {error && (
        <div role="alert" className="mt-24 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      )}

      {blocked && (
        <div role="alert" className="mt-24 rounded-card border p-24"
          style={{ borderColor: "var(--warning)", background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{blocked.message}</p>
          <div className="mt-16 flex flex-wrap gap-12">
            {!live && wait === 0 && (
              <button type="button" onClick={claim} disabled={busy}
                className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
                Claim today&apos;s free search
              </button>
            )}
            <Link href="/find/account" className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
              Record a weekly pass — TSh 3,000
            </Link>
            <Link href="/find/history" className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
              See my searches
            </Link>
          </div>
        </div>
      )}

      {/* ---------- results ---------- */}
      {board && (
        <section className="mt-24">
          <div className="mb-16 flex flex-wrap items-baseline justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {board.found} compan{board.found === 1 ? "y" : "ies"}
              {board.applied.kind ? ` · ${SERVES_LABELS[board.applied.kind]}` : ""}
              {board.applied.query ? ` · “${board.applied.query}”` : ""}
            </h2>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {board.remaining !== null ? `${board.remaining} left on this pass` : "Free search"}
              {" · page "}{page}/{pages}
            </p>
          </div>

          {board.results.length === 0 ? (
            <div className={card} style={cardStyle}>
              <p className="text-sm" style={{ color: "var(--ink)" }}>Nothing matches this search.</p>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Try a wider region, or search by corridor instead of city. A new search costs one credit,
                so read the meter above before running it again.
              </p>
            </div>
          ) : (
            <div className="grid gap-12 md:grid-cols-2">
              {board.results.map(c => (
                <Link key={c.id} href={`/find/companies/${c.id}?searchId=${board.searchId}`}
                  className="rounded-card border bg-surface p-20 transition-transform hover:-translate-y-[2px]"
                  style={cardStyle}>
                  <div className="flex items-start justify-between gap-12">
                    <h3 className="text-sm font-bold leading-snug" style={{ color: "var(--ink)" }}>
                      {c.company_name}
                    </h3>
                    {c.is_verified && (
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em]"
                        style={{ color: "var(--gold-green)" }}>Verified</span>
                    )}
                  </div>
                  <div className="mt-8 flex flex-wrap gap-8">
                    {c.serves.map(s => (
                      <span key={s} className="rounded-input px-8 py-4 text-[10px] font-bold uppercase tracking-[0.1em]"
                        style={{ background: "color-mix(in srgb, var(--gold) 16%, transparent)", color: "var(--ink)" }}>
                        {SERVES_LABELS[s] ?? s}
                      </span>
                    ))}
                  </div>
                  {c.headline && (
                    <p className="mt-8 text-xs leading-snug" style={{ color: "var(--ink-soft)" }}>{c.headline}</p>
                  )}
                  <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {c.region_names?.length ? c.region_names.join(", ") : c.home_base ?? "Regions not declared"}
                  </p>
                  <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.12em]"
                    style={{ color: LICENCE_COLORS[c.licence_state] ?? "var(--ink-soft)" }}>
                    {LICENCE_LABELS[c.licence_state] ?? c.licence_state}
                    {c.licence_valid_to ? ` · ${fmtDate(c.licence_valid_to)}` : ""}
                  </p>
                </Link>
              ))}
            </div>
          )}

          {board.found > PAGE && (
            <div className="mt-16 flex items-center justify-between">
              <button type="button" disabled={busy || board.offset === 0}
                onClick={() => goTo(Math.max(0, board.offset - PAGE))}
                className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                Previous
              </button>
              <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                {Math.min(board.offset + 1, board.found)}–{Math.min(board.offset + PAGE, board.found)} of {board.found}
              </span>
              <button type="button" disabled={busy || board.offset + PAGE >= board.found}
                onClick={() => goTo(board.offset + PAGE)}
                className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </section>
      )}

      {!board && !blocked && meterReady && (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>
          Your results will appear here. Opening a company shows the contact WAISHA published for it.
        </p>
      )}
    </div>
  );
}
