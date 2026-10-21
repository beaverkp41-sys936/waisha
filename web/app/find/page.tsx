"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { seekerFetch } from "./api-client";
import { useMeter } from "./meter";
import RoutePicker, { routeBody, type RoutePick } from "./route-picker";
import {
  errorCode, errorDetail, errorText, fmtDate, hm, KIND_OPTIONS, SERVICE_OPTIONS,
  LICENCE_COLORS, LICENCE_LABELS, SERVES_LABELS
} from "./labels";

const PAGE = 12;

/** Every code that means "the meter, not the network, stopped you". A search now claims
 *  today's free credit itself, so the only way to be blocked is to have already used it
 *  — which is a countdown with a way out, not a dead end. */
const BLOCKED_CODES = new Set([
  "SEARCH_PASS_EXHAUSTED", "FREE_SEARCH_NOT_READY", "PENDING_VERIFICATION",
  "SEARCH_PASS_EXPIRED", "SEARCH_PASS_NOT_USABLE", "SEARCH_PASS_NOT_OFFERED",
  "SEARCH_EXPIRED"
]);

type Card = {
  id: string; company_name: string; serves: string[]; headline: string | null;
  home_base: string | null; region_names: string[]; services_offered: string | null;
  corridors_served: string | null; fleet_size_declared: number | null;
  year_established: number | null; licence_valid_to: string | null; licence_state: string;
  contact_name: string; contact_channel: string; is_verified: boolean; total: number;
};

/** Everything the one reader call takes, in the shape the search was paid for. The route
 *  keeps its display names here so the results header can say what it matched on; only
 *  routeBody() of it ever leaves the browser, because the API schema is strict. */
type Applied = {
  kind: string | null; regionId: number | null; query: string | null;
  route: RoutePick | null; services: string[]; verifiedOnly: boolean;
  licenceValid: boolean; minFleet: number | null;
};

type Board = {
  searchId: string; found: number; remaining: number | null; passKind: string | null;
  resetsAt: string | null; freeClaimed: boolean; results: Card[]; applied: Applied;
  offset: number;
};

type Region = { region_id: number; region_name: string; companies: number };
type GeoRegion = { id: number; name_en: string };

/** The flat query names the GET door reads back (120). A route that did not survive the
 *  trip into the query string would answer page two with a different list than the one the
 *  credit bought. */
function appliedQuery(a: Applied, offset: number): string {
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (a.kind) qs.set("kind", a.kind);
  if (a.regionId) qs.set("regionId", String(a.regionId));
  if (a.query) qs.set("query", a.query);
  if (a.route) {
    qs.set("originRegionId", String(a.route.originRegionId));
    qs.set("destRegionId", String(a.route.destRegionId));
    if (a.route.originText) qs.set("originText", a.route.originText);
    if (a.route.destText) qs.set("destText", a.route.destText);
    if (a.route.corridorId) qs.set("corridorId", String(a.route.corridorId));
  }
  if (a.services.length) qs.set("services", a.services.join(","));
  if (a.verifiedOnly) qs.set("verifiedOnly", "1");
  if (a.licenceValid) qs.set("licenceValid", "1");
  if (a.minFleet) qs.set("minFleet", String(a.minFleet));
  return qs.toString();
}

/** What the seeker asked for, in the fewest words that still tell the truth about which
 *  of the boxes above produced this list. */
function optionSummary(a: Applied): string {
  const parts: string[] = [];
  if (a.services.length) {
    parts.push(a.services
      .map(s => SERVICE_OPTIONS.find(o => o.value === s)?.label ?? s).join(" + "));
  }
  if (a.verifiedOnly) parts.push("verified only");
  if (a.licenceValid) parts.push("licence still valid");
  if (a.minFleet) parts.push(`${a.minFleet}+ trucks`);
  return parts.join(" · ");
}

/** The POST body. Nulls are what the schema's nullish fields accept; `route` is the one
 *  that must be absent rather than null, because it is optional and not nullish. */
function appliedBody(a: Applied, limit: number, offset: number) {
  return {
    kind: a.kind, regionId: a.regionId, query: a.query,
    route: a.route ? routeBody(a.route) : undefined,
    services: a.services.length ? a.services : null,
    verifiedOnly: a.verifiedOnly || null, licenceValid: a.licenceValid || null,
    minFleet: a.minFleet, limit, offset
  };
}

export default function FindSearchPage() {
  const { state, ready: meterReady, failed: meterFailed, refresh } = useMeter();
  const [regions, setRegions] = useState<Region[]>([]);
  const [geoRegions, setGeoRegions] = useState<GeoRegion[]>([]);
  const [kind, setKind] = useState("");
  const [regionId, setRegionId] = useState("");
  const [query, setQuery] = useState("");
  const [routePick, setRoutePick] = useState<RoutePick | null>(null);
  const [services, setServices] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [licenceValid, setLicenceValid] = useState(false);
  const [minFleet, setMinFleet] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; waitMinutes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The whole filter set as it stands in the form right now, with one field replaced by
   *  what the chip that was just pressed chose. A route or an option typed but not pressed
   *  is not a search — the seeker presses Search when they want the meter to move. */
  function filters(patch: Partial<Applied> = {}): Applied {
    const fleet = Number(minFleet.trim());
    return {
      kind: kind || null,
      regionId: regionId ? Number(regionId) : null,
      query: query.trim() || null,
      route: routePick,
      services, verifiedOnly, licenceValid,
      minFleet: minFleet.trim() && Number.isFinite(fleet) ? fleet : null,
      ...patch
    };
  }

  useEffect(() => {
    let cancelled = false;
    // Counts of live listings per region cost no credit — this is what the region chips
    // are built from, and it must not spend a search just to draw the form.
    seekerFetch("/directory/regions")
      .then(async res => (res.ok ? res.json() : []))
      .then(rows => { if (!cancelled && Array.isArray(rows)) setRegions(rows); })
      .catch(() => { });
    // Every active region, including the ones with nothing published yet: the route
    // cascades have to offer the whole map, and a road to an empty region is still a road
    // the seeker wants companies on.
    seekerFetch("/geo/regions")
      .then(async res => (res.ok ? res.json() : []))
      .then(rows => { if (!cancelled && Array.isArray(rows)) setGeoRegions(rows); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  async function postSearch() {
    setBusy(true); setError(null); setBlocked(null);
    const applied = filters();
    try {
      const res = await seekerFetch("/directory/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(appliedBody(applied, PAGE, 0))
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setBoard({
          searchId: json.searchId, found: json.found ?? 0, remaining: json.remaining ?? null,
          passKind: json.passKind ?? null, resetsAt: json.resetsAt ?? null,
          freeClaimed: json.freeClaimed === true, results: json.results ?? [],
          applied, offset: 0
        });
        await refresh();
        return;
      }
      if (BLOCKED_CODES.has(errorCode(json))) {
        setBoard(null);
        setBlocked({
          message: errorText(json, "You cannot search right now."),
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

  /**
   * Narrowing a board that is already open reads the same claim check the search paid
   * for, so it costs nothing for the five minutes the claim lives. Paging uses the same
   * door. When the claim has turned, the answer is the timeout panel, not a silent
   * re-search that would spend a credit the seeker did not ask for.
   */
  async function reread(next: Applied, offset: number) {
    if (!board) return;
    setBusy(true); setError(null); setBlocked(null);
    try {
      const res = await seekerFetch(`/directory/search/${board.searchId}?${appliedQuery(next, offset)}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setBoard({ ...board, applied: next, offset, found: json.found ?? 0,
                   results: json.results ?? [] });
        if (offset !== board.offset) window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (res.status === 410 || errorCode(json) === "SEARCH_EXPIRED") {
        setBlocked({
          message: errorText(json, "This search closed after five minutes."),
          waitMinutes: state?.free_wait_minutes ?? 0
        });
        return;
      }
      setError(errorText(json, "Could not narrow this result."));
    } catch (e: any) {
      if (e?.message !== "session ended") setError("Could not narrow this result.");
    } finally {
      setBusy(false);
    }
  }

  /** A chip or the region picker changes one field of the filters; everything else in the
   *  set — the route included — comes from the form as the seeker has it, because page two
   *  of a route search that lost its route answers a different question from page one. */
  function narrow(patch: Partial<Applied>) {
    if (board) void reread(filters(patch), 0);
  }

  function toggleService(term: string) {
    const next = services.includes(term) ? services.filter(s => s !== term) : [...services, term];
    setServices(next);
    narrow({ services: next });
  }

  function toggleFlag(field: "verifiedOnly" | "licenceValid", on: boolean) {
    if (field === "verifiedOnly") setVerifiedOnly(on); else setLicenceValid(on);
    narrow({ [field]: on } as Partial<Applied>);
  }

  const live = state?.live_pass_id != null;
  const weekly = state?.live_kind === "weekly";
  const wait = state?.free_wait_minutes ?? 0;
  const pages = board ? Math.max(1, Math.ceil((board.found ?? 0) / PAGE)) : 1;
  const page = board ? Math.floor(board.offset / PAGE) + 1 : 1;
  const regionName = (id: number | null) =>
    regions.find(r => r.region_id === id)?.region_name ?? null;

  const inputCls = "rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const chip = (on: boolean) =>
    `on-photo-btn rounded-input px-12 py-8 text-xs font-semibold${on ? " is-on" : ""}`;

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>
        Find a transporter or a clearing agent
      </h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Type a company, a corridor, a city or a service and press Search — or pick a route
        below and search the road instead. Your first search of the day is free.
      </p>

      {/* ---------- the one action on this page ---------- */}
      <form className={`${card} mt-24`} style={cardStyle}
        onSubmit={e => { e.preventDefault(); void postSearch(); }}>
        <div className="flex flex-wrap gap-8">
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Dar es Salaam, Nakonde corridor, bonded clearing…"
            aria-label="Search the directory"
            className={`${inputCls} min-w-[220px] flex-1 text-base`} style={inputStyle} />
          <button type="submit" disabled={busy}
            className="waisha-btn rounded-input px-32 py-8 text-sm font-semibold disabled:opacity-50">
            {busy ? "Searching" : board ? "New search" : "Search"}
          </button>
        </div>

        <div className="mt-16 flex flex-wrap items-center gap-8">
          <span className="mr-4 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "var(--ink-soft)" }}>
            Look for
          </span>
          {KIND_OPTIONS.map(o => {
            const on = kind === o.value;
            return (
              <button key={o.value || "all"} type="button" aria-pressed={on}
                onClick={() => { setKind(o.value); narrow({ kind: o.value || null }); }}
                className={chip(on)}>
                {o.label}
              </button>
            );
          })}
          <span className="ml-8 mr-4 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "var(--ink-soft)" }}>
            Around
          </span>
          <select value={regionId}
            onChange={e => { setRegionId(e.target.value);
              narrow({ regionId: e.target.value ? Number(e.target.value) : null }); }}
            aria-label="Region" className={inputCls} style={inputStyle}>
            <option value="">Anywhere in Tanzania</option>
            {regions.map(r => (
              <option key={r.region_id} value={r.region_id}>
                {r.region_name} ({Number(r.companies)})
              </option>
            ))}
          </select>
        </div>

        {/* ---------- what kind of company, and what they must actually do ---------- */}
        <div className="mt-16 flex flex-wrap items-center gap-8">
          <span className="mr-4 text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "var(--ink-soft)" }}>
            Only offer me
          </span>
          {SERVICE_OPTIONS.map(o => {
            const on = services.includes(o.value);
            return (
              <button key={o.value} type="button" aria-pressed={on}
                onClick={() => toggleService(o.value)} className={chip(on)}>
                {o.label}
              </button>
            );
          })}
          {[
            { field: "verifiedOnly" as const, label: "Verified companies", on: verifiedOnly },
            { field: "licenceValid" as const, label: "Licence still valid", on: licenceValid }
          ].map(o => (
            <button key={o.field} type="button" aria-pressed={o.on}
              onClick={() => toggleFlag(o.field, !o.on)} className={chip(o.on)}>
              {o.label}
            </button>
          ))}
          <label className="flex items-center gap-8">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: "var(--ink-soft)" }}>
              At least
            </span>
            <input type="number" min={1} max={20000} value={minFleet}
              onChange={e => setMinFleet(e.target.value)}
              placeholder="any" aria-label="Minimum declared trucks"
              className={`${inputCls} w-[110px]`} style={inputStyle} />
            <span className="text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: "var(--ink-soft)" }}>
              trucks
            </span>
          </label>
        </div>
        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
          Services are read out of the words each company wrote about itself, so a company
          missing from one of these boxes may still do it — its card will say. Declared fleet
          and licence dates are what the company published, not what WAISHA has verified.
        </p>

        {/* ---------- the route ---------- */}
        <RoutePicker regions={geoRegions} onPick={setRoutePick} />

        {/* The meter, in the one place a seeker looks at before pressing the button. It
            says what the next search costs, never how to go and claim something first. */}
        <p className="mt-16 text-sm" style={{ color: "var(--ink)" }}>
          {!meterReady ? <span style={{ color: "var(--ink-soft)" }}>Reading your credits…</span>
            : meterFailed ? <span style={{ color: "var(--danger)" }}>{meterFailed}</span>
            : live ? (weekly
              ? <span><strong>Weekly pass</strong> — {state?.live_remaining ?? 0} search
                  {state?.live_remaining === 1 ? "" : "es"} left, until
                  {state?.live_expires_at ? ` ${fmtDate(state.live_expires_at)}` : " its week ends"}.
                  Each search takes one.</span>
              : <span><strong>Free search</strong> — {state?.live_remaining ?? 0} left on
                  today&apos;s credit. Each search takes one.</span>)
            : wait > 0
              ? <span>Today&apos;s free search is used. The next one unlocks in{" "}
                  <strong>{hm(wait)}</strong>.</span>
              : <span>Your free search for today is waiting — press Search and it is spent
                  on this one.</span>}
        </p>
        {state && state.awaiting_count > 0 && (
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            {state.awaiting_count} recorded payment{state.awaiting_count === 1 ? "" : "s"} with the
            office, awaiting confirmation. Your free search works meanwhile.
          </p>
        )}
        {state && state.verified === false && (
          <p className="mt-16 text-sm" style={{ color: "var(--warning)" }}>
            Your account is not confirmed yet. Sign out and enter the code we emailed you.
          </p>
        )}
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
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {blocked.waitMinutes > 0
              ? <>The next free search unlocks in <strong>{hm(blocked.waitMinutes)}</strong>.
                  A weekly pass is 30 searches for TSh 3,000 and starts the day the office
                  confirms the money.</>
              : <>Press Search again — today&apos;s free credit is taken by the search itself.</>}
          </p>
          <div className="mt-16 flex flex-wrap gap-12">
            <Link href="/find/account" className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
              Record a weekly pass — TSh 3,000
            </Link>
            <Link href="/find/history" className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
              See my searches
            </Link>
          </div>
        </div>
      )}

      {/* ---------- results, directly under the box that produced them ---------- */}
      {board && (
        <section className="mt-24">
          <div className="mb-16 flex flex-wrap items-baseline justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {board.found} compan{board.found === 1 ? "y" : "ies"}
              {board.applied.kind ? ` · ${SERVES_LABELS[board.applied.kind]}` : ""}
              {regionName(board.applied.regionId) ? ` · ${regionName(board.applied.regionId)}` : ""}
              {board.applied.query ? ` · “${board.applied.query}”` : ""}
            </h2>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {board.freeClaimed
                ? "Today's free search"
                : board.remaining !== null ? `${board.remaining} left on this pass` : "—"}
              {" · page "}{page}/{pages}
            </p>
          </div>

          {(board.applied.route || optionSummary(board.applied)) && (
            <p className="mb-16 -mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              {board.applied.route && (
                <>Route {board.applied.route.originRegion}
                  {board.applied.route.originText ? ` (${board.applied.route.originText})` : ""}
                  {" → "}{board.applied.route.destRegion}
                  {board.applied.route.destText ? ` (${board.applied.route.destText})` : ""}
                  {board.applied.route.corridor
                    ? ` · ${board.applied.route.corridor}`
                    : " · the two ends only"}
                </>
              )}
              {board.applied.route && optionSummary(board.applied) ? " · " : ""}
              {optionSummary(board.applied)}
            </p>
          )}

          {board.results.length === 0 ? (
            <div className={card} style={cardStyle}>
              <p className="text-sm" style={{ color: "var(--ink)" }}>Nothing matches this search.</p>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Clear the chips above and pick a wider region, or type a corridor instead of a city.
                Narrowing what is already on the screen costs nothing; a new search costs one credit.
              </p>
            </div>
          ) : (
            <div className="grid gap-12 md:grid-cols-2">
              {board.results.map(c => (
                <Link key={c.id} href={`/find/companies/${c.id}?searchId=${board.searchId}`}
                  className="rounded-card border bg-surface p-24 transition-transform hover:-translate-y-[2px]"
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
                onClick={() => void reread(board.applied, Math.max(0, board.offset - PAGE))}
                className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                Previous
              </button>
              <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                {Math.min(board.offset + 1, board.found)}–{Math.min(board.offset + PAGE, board.found)} of {board.found}
                {" · narrowing and paging this search is free"}
              </span>
              <button type="button" disabled={busy || board.offset + PAGE >= board.found}
                onClick={() => void reread(board.applied, board.offset + PAGE)}
                className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </section>
      )}

      {!board && !blocked && meterReady && (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>
          Results open right here. A company card shows the contact it chose to publish.
        </p>
      )}
    </div>
  );
}
