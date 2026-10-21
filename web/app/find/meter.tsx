"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { seekerFetch } from "./api-client";
import { errorDetail, errorCode, errorText } from "./labels";

/** Exactly what platform_auth.seeker_pass_state returns (061). One read drives every
 *  screen state in this shell, because the database — not the client — decides whether
 *  a search is allowed. */
export type PassState = {
  found: boolean;
  verified: boolean;
  live_pass_id: string | null;
  live_kind: string | null;
  live_remaining: number | null;
  live_expires_at: string | null;
  free_wait_minutes: number;
  awaiting_count: number;
  searches_total: number;
  products: {
    key: string; name: string; description: string | null;
    window_hours: number; searches_allowed: number;
    price: string; currency: string;
  }[];
};

export type MeterAction =
  | { ok: true; json: any; state: PassState | null }
  | { ok: false; status: number; code: string; message: string; detail: any };

type MeterValue = {
  state: PassState | null;
  ready: boolean;
  failed: string | null;
  refresh: () => Promise<PassState | null>;
  recordWeekly: (reference: string, method: string) => Promise<MeterAction>;
};

const Ctx = createContext<MeterValue | null>(null);

async function call(path: string, body: any): Promise<MeterAction> {
  const res = await seekerFetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, json, state: null };
  return {
    ok: false, status: res.status, code: errorCode(json),
    message: errorText(json, "That did not work."), detail: errorDetail(json)
  };
}

export function MeterProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PassState | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await seekerFetch("/seeker/passes");
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setFailed(errorText(json, "Could not read your search credits."));
        return null;
      }
      setState(json as PassState);
      setFailed(null);
      return json as PassState;
    } catch (e: any) {
      if (e?.message !== "session ended") setFailed("Could not read your search credits.");
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const withState = useCallback(async (action: Promise<MeterAction>): Promise<MeterAction> => {
    const r = await action;
    // Every meter action changes the number the header shows, so the read that proves
    // it happens here once rather than in whichever page triggered it.
    const fresh = await refresh();
    return r.ok ? { ...r, state: fresh } : r;
  }, [refresh]);

  const value: MeterValue = {
    state,
    ready,
    failed,
    refresh,
    // There is no claim action here on purpose: POST /directory/search takes the day's free
    // credit itself, in the transaction that spends it, so no page can offer a claim that
    // leaves the seeker holding a credit they never used.
    recordWeekly: (reference, method) => withState(call("/seeker/passes/weekly", { reference, method }))
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMeter(): MeterValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMeter must be used inside the seeker shell");
  return v;
}
