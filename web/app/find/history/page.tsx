"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { seekerFetch } from "../api-client";
import { useMeter } from "../meter";
import { errorText, fmtDateTime, hm, SERVES_LABELS } from "../labels";

type SearchRow = {
  id: string; query: string | null; kind: string | null; region_id: number | null;
  region_name: string | null; found: number | null; credits_left: number | null;
  created_at: string; opened_company: string | null;
  origin_region: string | null; dest_region: string | null;
  origin_text: string | null; dest_text: string | null;
};

export default function FindHistoryPage() {
  const { state } = useMeter();
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    seekerFetch("/seeker/searches?limit=50")
      .then(async res => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(errorText(j, "Could not load your searches."));
        else setRows(Array.isArray(j) ? j : []);
      })
      .catch(() => { })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>My searches</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Every search WAISHA recorded against your account, newest first. This log is yours — the
        companies you searched never learn who searched them.
      </p>

      {state?.found && (
        <div className={`${card} mt-24 flex flex-wrap gap-24`} style={cardStyle}>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Searches run
            </p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
              {state.searches_total}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Left on this pass
            </p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
              {state.live_pass_id ? state.live_remaining ?? 0 : 0}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Next free search
            </p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
              {state.free_wait_minutes > 0 ? hm(state.free_wait_minutes) : "ready now"}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mt-24 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      )}

      {!ready ? (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className={`${card} mt-24`} style={cardStyle}>
          <p className="text-sm" style={{ color: "var(--ink)" }}>No searches yet.</p>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Look for a transporter or a clearing agent on the search page — your first search of the
            day is free, and the results you got will be listed here.
          </p>
          <Link href="/find" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-sm font-semibold">
            Search the directory
          </Link>
        </div>
      ) : (
        <div className="mt-24 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">When</th><th className="p-12">Looked for</th>
                <th className="p-12">Region</th><th className="p-12">Found</th>
                <th className="p-12">Company opened</th><th className="p-12">Credit left</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmtDateTime(r.created_at)}</td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    {r.opened_company
                      ? <span className="text-xs italic">opened a card</span>
                      : r.query ?? (r.kind ? SERVES_LABELS[r.kind] : "All companies")}
                    {/* A route search has no words in it, so without this line the log would
                        read as "looked for nothing" while holding a road the seeker asked for. */}
                    {r.origin_region && r.dest_region && (
                      <span className="mt-4 block text-xs" style={{ color: "var(--ink-soft)" }}>
                        route {r.origin_region}{r.origin_text ? ` (${r.origin_text})` : ""}
                        {" → "}{r.dest_region}{r.dest_text ? ` (${r.dest_text})` : ""}
                      </span>
                    )}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                    {r.region_name ?? (r.origin_region ? "On a route" : "—")}
                  </td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>
                    {r.found === null ? "—" : r.found}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{r.opened_company ?? "—"}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{r.credits_left}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
