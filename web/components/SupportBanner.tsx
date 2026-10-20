"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/app/app/api-client";
import { sessionIsBorrowed } from "@/lib/session";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The banner that says a platform seat is looking through a company's window (task #177).
 *
 * The admin asked for a "hidden mode". It is hidden from the company in the only sense that
 * matters operationally — there is no pop-up, no shared channel, nothing that interrupts a
 * director at their desk — and it is loud in the one browser that is actually doing the
 * looking. That distinction is deliberate: the thing worth hiding from a customer is a
 * support visit, the thing worth hiding from the platform is somebody reading their books
 * without a record, and the second one is what turns a helpful tool into a way of
 * disappearing.
 *
 * Every word in it comes from the server (`GET /support/session`), not from the token the
 * page already holds. A banner that names the company from local state is a banner that can
 * name the wrong company, and this is the one caption on the page whose job is to say where
 * you are.
 */
interface SupportView {
  borrowed: boolean;
  ended?: boolean;
  sessionId?: string;
  tenantName?: string;
  seatName?: string;
  seatType?: string;
  actorName?: string;
  expiresAt?: string;
}

const clock = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return "0:00";
  const m = Math.floor(ms / 60000);
  return `${m}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
};

export function SupportBanner() {
  const [view, setView] = useState<SupportView | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      const res = await apiFetch("/support/session");
      if (!res.ok) return;
      const j = (await res.json()) as SupportView;
      setView(j?.borrowed ? j : null);
    } catch { /* the shell paints without it */ }
  }, []);

  useEffect(() => {
    // Only a borrowed token has anything to ask about. The claim is readable straight off
    // the JWT this tab already holds, so asking first costs a query on every mount of every
    // normal seat to be told it is not borrowed.
    if (!sessionIsBorrowed()) return;
    read();
  }, [read]);

  useEffect(() => {
    if (!view?.expiresAt) return;
    setLeft(clock(view.expiresAt));
    const t = setInterval(() => setLeft(clock(view.expiresAt!)), 1000);
    const poll = setInterval(read, 60_000);
    return () => { clearInterval(t); clearInterval(poll); };
  }, [view?.expiresAt, read]);

  if (!view?.borrowed) return null;
  // Taken out of state so `leave` holds a value, not a dereference of a nullable.
  const sessionId = view.sessionId;

  async function leave() {
    setBusy(true);
    // Cookie-authed, like every other control desk call, and it must stay that way: the
    // read-only guard exempts /control on purpose so leaving is never itself refused.
    try {
      if (sessionId) {
        await fetch(`${API}/api/v1/control/support/sessions/${sessionId}/close`, {
          // A POST with a JSON content-type and no body is refused before it reaches the
          // handler, and this route takes no input, so say {} out loud.
          method: "POST", headers: { "Content-Type": "application/json" },
          credentials: "include", body: "{}"
        });
      }
    } finally {
      sessionStorage.removeItem("waisha_access");
      window.location.href = "/control/tenants";
    }
  }

  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-12 px-16 py-10 text-sm"
      style={{ background: "var(--navy-deep)", color: "#fff", borderBottom: "3px solid var(--gold)" }}>
      <span className="flex flex-wrap items-center gap-8">
        <b style={{ color: "var(--gold-on-photo)", textTransform: "uppercase", fontSize: 11, letterSpacing: ".06em" }}>
          Platform support view
        </b>
        {view.ended ? (
          <span>This support view has ended. Nothing was saved.</span>
        ) : (
          <span className="tabular-nums">
            Looking as <b>{view.tenantName}</b> · seat <b>{view.seatName}</b>
            {view.actorName ? ` · held by ${view.actorName}` : ""} · read-only
            {left !== null ? ` · ${left} left` : ""}
          </span>
        )}
      </span>
      <button type="button" onClick={leave} disabled={busy}
        className="rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50"
        style={{ background: "var(--gold)", color: "var(--navy-deep)" }}>
        {busy ? "Closing…" : "Switch back to admin view"}
      </button>
    </div>
  );
}
