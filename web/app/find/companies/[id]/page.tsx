"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { seekerFetch } from "../../api-client";
import { useMeter } from "../../meter";
import {
  errorCode, errorText, fmtDate, hm, LICENCE_COLORS, LICENCE_LABELS, SERVES_LABELS
} from "../../labels";

type Company = {
  id: string; company_name: string; serves: string[]; headline: string | null;
  description: string | null; services_offered: string | null; corridors_served: string | null;
  home_base: string | null; region_names: string[]; website: string | null;
  fleet_size_declared: number | null; year_established: number | null;
  licence_valid_to: string | null; licence_state: string; contact_name: string;
  contact_channel: string; is_verified: boolean; published_at: string;
};

const LINE = { borderColor: "var(--line)" };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid gap-8 border-b py-12 sm:grid-cols-[180px_1fr]" style={LINE}>
      <span className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        {label}
      </span>
      <span className="text-sm" style={{ color: "var(--ink)" }}>{value}</span>
    </div>
  );
}

export default function FindCompanyCardPage() {
  const params = useParams<{ id: string }>();
  const { state, refresh } = useMeter();
  const [company, setCompany] = useState<Company | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("searchId");
    if (q) setSearchId(q);
  }, []);

  const load = useCallback(async () => {
    if (!searchId) return;
    setReady(false); setError(null); setMissing(null); setExpired(false);
    try {
      const res = await seekerFetch(`/directory/companies/${params.id}?searchId=${searchId}`);
      const json = await res.json().catch(() => ({}));
      if (res.ok) setCompany(json as Company);
      else if (res.status === 410) setExpired(true);
      else if (res.status === 403) setMissing(errorText(json, "This account cannot read the directory."));
      else if (res.status === 404) setMissing("No live company under that reference.");
      else setError(errorText(json, "Could not load this company."));
    } catch (e: any) {
      if (e?.message !== "session ended") setError("Could not load this company.");
    } finally {
      setReady(true);
    }
  }, [params.id, searchId]);

  useEffect(() => { load(); }, [load]);

  /** A deliberate open is the one read the company is allowed to count. It spends its
   *  own credit on purpose: card_opens in 062 is a lead signal, and counting every
   *  drive-by click would make it mean nothing. */
  async function recordOpen() {
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await seekerFetch("/directory/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: params.id })
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setNote(`${company?.company_name ?? "This company"} is recorded in your searches — `
          + "their office will see that a seeker opened their card.");
        await refresh();
        return;
      }
      const code = errorCode(json);
      if (code === "SEARCH_PASS_EXHAUSTED" || code === "FREE_SEARCH_NOT_READY") {
        setNote(errorText(json, "That takes a search credit."));
      } else {
        setError(errorText(json, "Could not record this open."));
      }
    } catch (e: any) {
      if (e?.message !== "session ended") setError("Could not record this open.");
    } finally {
      setBusy(false);
    }
  }

  const card = "rounded-card border bg-surface p-24";

  /* Recording an open goes through the same POST /directory/search the board uses, and that
     route claims the day's free credit itself when nothing is live. So the button is only dead
     when the meter holds neither a pass nor an unlocked free claim. */
  const wait = Math.max(0, state?.free_wait_minutes ?? 0);
  const canRecord = state?.found === true && (state.live_pass_id !== null || wait === 0);

  if (!searchId) {
    return (
      <div className="mx-auto max-w-[720px] px-16 py-64">
        <div className={card} style={LINE}>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Run a search first</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            A company card opens from the results of a search you have paid for. Start one and pick
            a company from the list.
          </p>
          <Link href="/find" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-sm font-semibold">
            Search the directory
          </Link>
        </div>
      </div>
    );
  }

  if (expired) {
    return (
      <div className="mx-auto max-w-[720px] px-16 py-64">
        <div className={card} style={LINE}>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>This search timed out</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            A search stays open for five minutes. Run a new one to read this card again — it costs a
            search only if you have none left today.
          </p>
          <Link href="/find" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-sm font-semibold">
            Back to search
          </Link>
        </div>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="mx-auto max-w-[720px] px-16 py-64">
        <div className={card} style={LINE}>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>{missing}</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            A company can withdraw its listing, or be suspended by the office, at any time. Nothing
            you already recorded is lost — it stays in your searches.
          </p>
          <Link href="/find" className="on-photo-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
            Search again
          </Link>
        </div>
      </div>
    );
  }

  if (!ready) {
    return <div className="px-16 py-64 text-center text-sm" style={{ color: "var(--ink-soft)" }}>Loading company…</div>;
  }

  return (
    <div className="mx-auto max-w-[720px] px-16 py-32">
      {/* The page's only way back, and it stands on the photo — so it takes the pane
          note's white rather than brand blue, which measured 4.13:1 over a bright sky. */}
      <Link href="/find" className="pane-note text-xs underline">
        ← Back to search
      </Link>

      {company && (
        <>
          <header className="mt-16">
            <div className="flex flex-wrap items-center gap-12">
              <h1 className="text-2xl font-bold leading-tight" style={{ color: "var(--ink)" }}>
                {company.company_name}
              </h1>
              {company.is_verified && (
                <span className="rounded-input px-8 py-4 text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ background: "var(--pane-bg)", color: "var(--gold-green-on-photo)" }}>
                  Verified
                </span>
              )}
            </div>
            <div className="mt-12 flex flex-wrap gap-8">
              {/* These chips sit on the photo, not on glass, so a 16% wash of the pane's own
                  gold only lightened the sky behind them — white on that read 4.4:1. The
                  plate has to be the dark one, and the hue the on-photo end of the palette. */}
              {company.serves.map(s => (
                <span key={s} className="rounded-input px-8 py-4 text-[10px] font-bold uppercase tracking-[0.1em]"
                  style={{ background: "var(--pane-bg)", color: "var(--gold-on-photo)" }}>
                  {SERVES_LABELS[s] ?? s}
                </span>
              ))}
            </div>
            {company.headline && (
              <p className="mt-16 text-base leading-snug" style={{ color: "var(--ink)" }}>{company.headline}</p>
            )}
          </header>

          {error && (
            <div role="alert" className="mt-16 px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
              {error}
            </div>
          )}

          <section className={`${card} mt-24`} style={LINE}>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              What they publish
            </h2>
            <div className="mt-8">
              <Row label="About" value={company.description} />
              <Row label="Services" value={company.services_offered} />
              <Row label="Corridors" value={company.corridors_served} />
              <Row label="Home base" value={company.home_base} />
              <Row label="Regions" value={company.region_names?.length ? company.region_names.join(", ") : null} />
              <Row label="Fleet declared" value={company.fleet_size_declared !== null ? `${company.fleet_size_declared} vehicles` : null} />
              <Row label="Established" value={company.year_established} />
              <Row label="Website" value={company.website} />
              <Row label="Published" value={fmtDate(company.published_at)} />
            </div>
          </section>

          <section className={`${card} mt-24`} style={LINE}>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Licence they declare
            </h2>
            <p className="mt-8 text-sm" style={{ color: LICENCE_COLORS[company.licence_state] ?? "var(--ink)" }}>
              {LICENCE_LABELS[company.licence_state] ?? company.licence_state}
              {company.licence_valid_to ? ` — valid to ${fmtDate(company.licence_valid_to)}` : ""}
            </p>
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              The date is copied from the company profile the day they saved it. WAISHA does not hold
              the licence number and does not check it with any authority.
            </p>
          </section>

          <section className={`${card} mt-24`} style={LINE}>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Who to talk to
            </h2>
            <div className="mt-8">
              <Row label="Contact" value={company.contact_name} />
              <Row label="Channel" value={company.contact_channel} />
            </div>
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              This is the only person the company chose to publish. Phone numbers, TIN and BRLA
              stay sealed in their own account.
            </p>

            <div className="mt-16">
              <button type="button" onClick={recordOpen}
                disabled={busy || !canRecord}
                className="waisha-btn w-full rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
                {busy ? "Recording" : "Record this open"}
              </button>
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                {state?.live_pass_id != null
                  ? "Uses one search credit and tells the company that a seeker opened their card."
                  : canRecord
                    ? "This takes today's free search — nothing to claim first — and tells the "
                      + "company that a seeker opened their card."
                    : `Today's free search is spent and no pass is live, so this waits ${hm(wait)} `
                      + "for the next one."}
              </p>
              {note && (
                <p role="status" className="mt-12 px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                  {note}
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
