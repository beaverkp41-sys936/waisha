"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { seekerFetch } from "../../api-client";
import { useMeter } from "../../meter";
import {
  errorCode, errorText, fmtDate, fmtDateTime, hm, LICENCE_COLORS, LICENCE_LABELS, SERVES_LABELS
} from "../../labels";

type Company = {
  id: string; company_name: string; serves: string[]; headline: string | null;
  description: string | null; services_offered: string | null; corridors_served: string | null;
  home_base: string | null; region_names: string[]; website: string | null;
  fleet_size_declared: number | null; year_established: number | null;
  licence_valid_to: string | null; licence_state: string; contact_name: string;
  contact_channel: string; is_verified: boolean; published_at: string;
};

/** 131's seeker-facing read: the marks that count, and the mean worked out on the same predicate
 *  the office's board shows. `rater_name` is already the constant for a seeker. */
type Mark = {
  id: string; stars: number; comment: string | null; basis: string;
  rater_name: string | null; rater_kind: string; created_at: string;
  reply: string | null; replied_at: string | null;
};

type MarkSummary = {
  marks: number; mean: string | number; five: number; four: number; three: number;
  two: number; one: number; from_companies: number; from_seekers: number;
  answered: number; since: string | null;
};

/** `/directory/ratings/mine` is the author's own list, so it carries the states a reader of the
 *  board never sees: withdrawn, and hidden by the office. */
type MyMark = {
  id: string; listing_id: string; stars: number; comment: string | null; basis: string;
  created_at: string; updated_at: string; reply: string | null; replied_at: string | null;
  withdrawn_at: string | null; hidden_at: string | null;
};

const LINE = { borderColor: "var(--line)" };

function Stars({ n, dim }: { n: number; dim?: boolean }) {
  return (
    <span aria-label={`${n} out of 5`} className="text-sm font-bold tracking-[0.12em]"
      style={{ color: dim ? "var(--ink-soft)" : "var(--gold-green)" }}>
      {"★★★★★".slice(0, n)}
      <span style={{ color: "var(--line)" }}>{"★★★★★".slice(n)}</span>
    </span>
  );
}

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

  // ---------- the marks on this card ----------
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [summary, setSummary] = useState<MarkSummary | null>(null);
  const [myMark, setMyMark] = useState<MyMark | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const [markNotice, setMarkNotice] = useState<string | null>(null);
  const [markBusy, setMarkBusy] = useState(false);
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  // A mark stands on a card the seeker opened, not on the list that showed it — 131's trigger
  // refuses the second, so the write form only belongs on screen once an open is in hand.
  const [openSearchId, setOpenSearchId] = useState<string | null>(null);

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

  // The marks board rides on the same claim the card does, so it reads on whichever search is
  // live — the open once there is one, because that is the row a mark is allowed to stand on.
  const claimId = openSearchId ?? searchId;

  const loadMarks = useCallback(async () => {
    if (!claimId) return;
    const res = await seekerFetch(
      `/directory/companies/${params.id}/ratings?searchId=${claimId}&limit=50`);
    const json = await res.json().catch(() => ({}));
    if (res.ok) { setMarks(json.marks ?? []); setSummary(json.summary ?? null); }
    else if (res.status === 410) setMarks(null);
  }, [params.id, claimId]);

  // Reading your own words back is not a permission, so this call carries no claim check and can
  // answer even after the search has expired — which is what lets the page say "you marked this".
  const loadMine = useCallback(async () => {
    const res = await seekerFetch("/directory/ratings/mine?limit=100");
    if (!res.ok) return;
    const json = await res.json().catch(() => ({}));
    const found = ((json.marks ?? []) as MyMark[])
      .find((m) => m.listing_id === params.id && !m.withdrawn_at) ?? null;
    setMyMark(found);
    if (found) setStars(found.stars);
  }, [params.id]);

  useEffect(() => { loadMarks(); loadMine(); }, [loadMarks, loadMine]);

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
        // The open writes its own metered row, and that row is the proof 131 wants for a mark: the
        // search that came from the results list opened a board, not this card. Keep the new id
        // rather than overwriting `searchId`, which would re-read the card and flash the page.
        if (json.searchId) setOpenSearchId(json.searchId);
        setNote(`${company?.company_name ?? "This company"} is recorded in your searches — `
          + "their office will see that a seeker opened their card. That open is also what lets you "
          + "say what dealing with them was like.");
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

  /** One mark per person per card, and taking the first one back does not free the slot. So a
   *  refusal that names another mark is read as "yours is already on the register" and the page
   *  re-reads it, rather than leaving a seeker with a form that keeps failing for no reason. */
  async function writeMark() {
    if (!openSearchId || stars < 1) return;
    setMarkBusy(true); setMarkError(null); setMarkNotice(null);
    try {
      const res = await seekerFetch("/directory/ratings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchId: openSearchId, stars, comment: comment.trim() || null })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMarkError(errorText(json, "The mark could not be recorded."));
        if (res.status === 409) { await loadMine(); await loadMarks(); }
        return;
      }
      setComment("");
      setMarkNotice("On the board. The company sees your stars and your words under their card, and "
        + "can answer once. Nobody is shown your name.");
      await Promise.all([loadMine(), loadMarks()]);
    } catch (e: any) {
      if (e?.message !== "session ended") setMarkError("The mark could not be recorded.");
    } finally {
      setMarkBusy(false);
    }
  }

  /** The author's own words, and only until the company answers — after that the mark is evidence
   *  of a conversation, and retyping it would move the ground under the reply. */
  async function saveEdit() {
    if (!myMark || stars < 1) return;
    setMarkBusy(true); setMarkError(null); setMarkNotice(null);
    try {
      const res = await seekerFetch(`/directory/ratings/${myMark.id}/edit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars, comment: comment.trim() || null })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMarkError(errorText(json, "Your words could not be retyped.")); return; }
      setEditing(false); setComment("");
      setMarkNotice("Changed. Both your mark and the register carry the new stars.");
      await Promise.all([loadMine(), loadMarks()]);
    } catch (e: any) {
      if (e?.message !== "session ended") setMarkError("Your words could not be retyped.");
    } finally {
      setMarkBusy(false);
    }
  }

  async function withdrawMark() {
    if (!myMark) return;
    setMarkBusy(true); setMarkError(null); setMarkNotice(null);
    try {
      const res = await seekerFetch(`/directory/ratings/${myMark.id}/withdraw`,
        { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMarkError(errorText(json, "The mark could not be taken back.")); return; }
      setWithdrawing(false); setStars(0);
      setMarkNotice("Taken back — it no longer counts toward their mean. Note that this card is "
        + "closed to a second mark from you: withdrawing does not free the slot.");
      await Promise.all([loadMine(), loadMarks()]);
    } catch (e: any) {
      if (e?.message !== "session ended") setMarkError("The mark could not be taken back.");
    } finally {
      setMarkBusy(false);
    }
  }

  /* Recording an open goes through the same POST /directory/search the board uses, and that
     route claims the day's free credit itself when nothing is live. So the button is only dead
     when the meter holds neither a pass nor an unlocked free claim. */
  const wait = Math.max(0, state?.free_wait_minutes ?? 0);
  const canRecord = state?.found === true && (state.live_pass_id !== null || wait === 0);

  // 131's gate in the register's own terms: stars one to five, and a comment that is either
  // nothing at all or at least eight characters. The write form and the edit form stand on the
  // same two rules, so the button never promises a save the definer is going to refuse.
  const wordsOk = comment.trim().length === 0
    || (comment.trim().length >= 8 && comment.trim().length <= 600);
  const markReady = stars >= 1 && stars <= 5 && wordsOk;

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
                disabled={busy || !canRecord || openSearchId !== null}
                className="waisha-btn w-full rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
                {busy ? "Recording" : openSearchId !== null ? "Open recorded" : "Record this open"}
              </button>
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                {openSearchId !== null
                  ? "Recorded. This is the proof your mark stands on — you can write it below."
                  : state?.live_pass_id != null
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

          <section className={`${card} mt-24`} style={LINE}>
            <div className="flex flex-wrap items-baseline justify-between gap-12">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                What dealing with them was like
              </h2>
              {summary && Number(summary.marks) > 0 && (
                <p className="flex items-center gap-8 text-sm">
                  <Stars n={Math.round(Number(summary.mean))} />
                  <strong style={{ color: "var(--ink)" }}>{Number(summary.mean)}</strong>
                  <span style={{ color: "var(--ink-soft)" }}>
                    {summary.marks} mark{summary.marks === 1 ? "" : "s"}
                  </span>
                </p>
              )}
            </div>

            {marks === null ? (
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Marks are read on the same five-minute claim as the card, and this search has run
                out. Record the open above — it re-reads the board with a fresh claim.
              </p>
            ) : summary && Number(summary.marks) > 0 ? (
              <div className="mt-12">
                {BARS.map(([n, key]) => {
                  const c = Number(summary[key] ?? 0);
                  const pct = Math.round((c / Number(summary.marks)) * 100);
                  return (
                    <div key={n} className="flex items-center gap-8 py-4">
                      <span className="w-40 shrink-0 text-[11px] font-semibold" style={{ color: "var(--ink-soft)" }}>
                        {n} ★
                      </span>
                      <span className="h-6 flex-1 overflow-hidden rounded-input" style={{ background: "var(--line)" }}>
                        <span className="block h-full" style={{ width: `${pct}%`, background: "var(--gold-green)" }} />
                      </span>
                      <span className="w-40 shrink-0 text-right text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {c}
                      </span>
                    </div>
                  );
                })}
                <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {Number(summary.answered) > 0
                    ? `They have answered ${summary.answered} of the ${summary.marks} marks on their `
                      + `card. ${summary.from_seekers} came from seekers, ${summary.from_companies} from `
                      + "another company they did business with."
                    : `Nobody at their desk has answered any of the ${summary.marks} marks yet.`}
                </p>
              </div>
            ) : (
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Nothing is on their card yet. A mark here is written by a seeker who opened the card,
                or by a company that actually did a job with them — never by somebody who guessed.
              </p>
            )}

            {markError && (
              <div role="alert" className="mt-16 px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
                {markError}
              </div>
            )}
            {markNotice && (
              <p role="status" className="mt-16 px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--gold-green) 10%, transparent)", borderLeft: "4px solid var(--gold-green)" }}>
                {markNotice}
              </p>
            )}

            {myMark ? (
              <div className="mt-16 rounded-card p-16" style={{ background: "var(--milk)" }}>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Your mark
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-8">
                  <Stars n={myMark.stars} />
                  <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {fmtDateTime(myMark.updated_at || myMark.created_at)}
                  </span>
                  {myMark.hidden_at && (
                    <span className="text-[11px] font-semibold" style={{ color: "var(--warning)" }}>
                      the office has taken it off their board
                    </span>
                  )}
                </div>
                {myMark.comment && (
                  <p className="mt-8 text-sm leading-relaxed" style={{ color: "var(--ink)" }}>{myMark.comment}</p>
                )}
                {myMark.reply && (
                  <p className="mt-8 border-l-4 px-12 py-8 text-sm"
                    style={{ borderColor: "var(--gold-green)", background: "var(--surface)" }}>
                    <span className="block text-[10px] font-bold uppercase tracking-[0.12em]"
                      style={{ color: "var(--ink-soft)" }}>
                      Their answer
                    </span>
                    {myMark.reply}
                  </p>
                )}
                {editing ? (
                  <div className="mt-12">
                    <Pick label="Stars" stars={stars} setStars={setStars} disabled={markBusy} />
                    <Words comment={comment} setComment={setComment} disabled={markBusy} />
                    <div className="mt-12 flex flex-wrap gap-8">
                      <button type="button" onClick={saveEdit}
                        disabled={markBusy || !markReady}
                        className="waisha-btn rounded-input px-16 py-8 text-sm font-semibold disabled:opacity-50">
                        {markBusy ? "Saving" : "Save my new words"}
                      </button>
                      <button type="button" disabled={markBusy}
                        onClick={() => { setEditing(false); setComment(""); setStars(myMark.stars); setMarkError(null); }}
                        className="rounded-input border px-16 py-8 text-sm font-semibold"
                        style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                        Leave it be
                      </button>
                    </div>
                    {!markReady && (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        Pick your stars, and either write nothing or at least eight characters.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-12 flex flex-wrap gap-8">
                    {!myMark.reply && (
                      <button type="button" disabled={markBusy}
                        onClick={() => { setEditing(true); setComment(myMark.comment ?? ""); setStars(myMark.stars); setMarkError(null); setMarkNotice(null); }}
                        className="rounded-input border px-16 py-8 text-sm font-semibold"
                        style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                        Change my mark
                      </button>
                    )}
                    {!withdrawing ? (
                      <button type="button" disabled={markBusy}
                        onClick={() => { setWithdrawing(true); setMarkError(null); setMarkNotice(null); }}
                        className="rounded-input border px-16 py-8 text-xs font-semibold"
                        style={{ borderColor: "var(--line)", color: "var(--danger)" }}>
                        Take it back…
                      </button>
                    ) : (
                      <div className="mt-4 w-full">
                        <p className="text-xs" style={{ color: "var(--ink)" }}>
                          Taking it back stops it counting toward their mean. It does not let you mark
                          them again — one mark per person per card, and withdrawing is not how a
                          second one is earned.
                        </p>
                        <div className="mt-8 flex flex-wrap gap-8">
                          <button type="button" disabled={markBusy} onClick={withdrawMark}
                            className="rounded-input border px-16 py-8 text-sm font-semibold"
                            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                            {markBusy ? "Taking it back" : "Yes, take it back"}
                          </button>
                          <button type="button" disabled={markBusy}
                            onClick={() => setWithdrawing(false)}
                            className="rounded-input border px-16 py-8 text-sm font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                            Keep it on the card
                          </button>
                        </div>
                      </div>
                    )}
                    {myMark.reply && (
                      <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        Their answer is already under your words, so the mark now reads as it was
                        answered — retyping it would move the ground under their reply.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : openSearchId ? (
              <div className="mt-16 rounded-card p-16" style={{ background: "var(--milk)" }}>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Say what it was like
                </p>
                <div className="mt-12">
                  <Pick label="Stars" stars={stars} setStars={setStars} disabled={markBusy} />
                  <Words comment={comment} setComment={setComment} disabled={markBusy} />
                </div>
                <button type="button" onClick={writeMark} disabled={markBusy || !markReady}
                  className="waisha-btn mt-12 w-full rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
                  {markBusy ? "Writing" : "Put my mark on their card"}
                </button>
                <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {markReady
                    ? "One mark per person per card. The company sees it and can answer once; nobody "
                      + "is shown your name, and the office can take a mark off the board but never "
                      + "deletes one."
                    : "Pick your stars first, and either write nothing or at least eight characters."}
                </p>
              </div>
            ) : (
              <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                You can read what others said, but marking them takes a recorded open above — a mark
                stands on a card you opened, not on the list that showed it.
              </p>
            )}

            {!!marks?.length && (
              <ul className="mt-20">
                {marks.map((m) => (
                  <li key={m.id} className="border-t py-16 first:border-t-0" style={LINE}>
                    <div className="flex flex-wrap items-baseline justify-between gap-8">
                      <Stars n={m.stars} dim={m.id === myMark?.id} />
                      <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {fmtDateTime(m.created_at)}
                      </span>
                    </div>
                    <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.1em]"
                      style={{ color: "var(--ink-soft)" }}>
                      {m.rater_name ?? "a seeker on WAISHA"}
                      {m.id === myMark?.id ? " — that is you" : ""}
                      {" · "}
                      {m.basis === "booking" ? "left on a booked job" : "left after opening their card"}
                    </p>
                    {m.comment && (
                      <p className="mt-8 text-sm leading-relaxed" style={{ color: "var(--ink)" }}>{m.comment}</p>
                    )}
                    {m.reply && (
                      <p className="mt-10 border-l-4 px-12 py-8 text-sm"
                        style={{ borderColor: "var(--gold-green)", background: "var(--milk)" }}>
                        <span className="block text-[10px] font-bold uppercase tracking-[0.12em]"
                          style={{ color: "var(--ink-soft)" }}>
                          Their answer
                        </span>
                        {m.reply}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** The five bars under the mean. `marks` in the summary is the count of what counts — written,
 *  not withdrawn, not hidden — so every bar is a share of the same total the mean divides. */
const BARS: [number, keyof MarkSummary][] =
  [[5, "five"], [4, "four"], [3, "three"], [2, "two"], [1, "one"]];

function Pick({ label, stars, setStars, disabled }:
  { label: string; stars: number; setStars: (n: number) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-8">
      <span className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        {label}
      </span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={disabled} onClick={() => setStars(n)}
          aria-label={`${n} out of 5`} aria-pressed={stars === n}
          className="rounded-input border px-10 py-4 text-sm font-bold"
          style={{
            borderColor: stars >= n ? "var(--gold-green)" : "var(--line)",
            color: stars >= n ? "var(--gold-green)" : "var(--ink-soft)",
            background: stars === n ? "color-mix(in srgb, var(--gold-green) 14%, transparent)" : undefined
          }}>
          ★
        </button>
      ))}
      {stars > 0 && (
        <span className="text-[11px] font-semibold" style={{ color: "var(--ink)" }}>{stars} of 5</span>
      )}
    </div>
  );
}

function Words({ comment, setComment, disabled }:
  { comment: string; setComment: (v: string) => void; disabled: boolean }) {
  const len = comment.trim().length;
  return (
    <div className="mt-12">
      <textarea value={comment} disabled={disabled} rows={3} maxLength={600}
        onChange={(e) => setComment(e.target.value)}
        aria-label="What happened, in your words"
        placeholder="Optional. What they did well, or what you would tell the next seeker."
        className="w-full rounded-input border px-12 py-8 text-sm"
        style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--surface)" }} />
      <p className="mt-4 text-[11px]" style={{ color: len > 0 && len < 8 ? "var(--danger)" : "var(--ink-soft)" }}>
        {len === 0
          ? "Stars alone are a mark. Words are optional."
          : len < 8
            ? `${len} characters — write at least 8, or clear the box and send the stars alone.`
            : `${len} of 600.`}
      </p>
    </div>
  );
}
