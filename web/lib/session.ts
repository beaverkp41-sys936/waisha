"use client";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const ACCESS = "waisha_access";

/** A token with less than this much life left is renewed before it is sent, not after
 *  it has already been refused. */
const REFRESH_AHEAD_SECONDS = 60;

/**
 * The refresh cookie rotates on every call, and `platform_auth.rotate_refresh` treats a
 * token it has already swapped as stolen: it revokes every session in the family and the
 * user is signed out of a session that was being renewed one request earlier. So a page
 * that fires several requests with an expired access token must not fire several
 * refreshes. One is in flight at a time and everybody waits for it.
 */
let refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    const attempt = (async (): Promise<string | null> => {
      try {
        const res = await fetch(`${API}/api/v1/auth/refresh`, { method: "POST", credentials: "include" });
        if (!res.ok) return null;
        const json = await res.json();
        if (typeof json.accessToken !== "string") return null;
        sessionStorage.setItem(ACCESS, json.accessToken);
        return json.accessToken;
      } catch {
        return null;
      }
    })();
    refreshInFlight = attempt;
    attempt.finally(() => { if (refreshInFlight === attempt) refreshInFlight = null; });
  }
  return refreshInFlight;
}

/** Seconds before the token stops verifying. Unreadable tokens are left alone — the 401
 *  path is the one that decides what to do about them. */
function secondsLeft(jwt: string): number {
  try {
    const body = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4)));
    return typeof payload.exp === "number" ? payload.exp - Math.floor(Date.now() / 1000) : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * The one place a Bearer token is attached to a request. `whenSessionEnds` runs only
 * when the refresh itself failed, so each shell decides where its own kind of user
 * lands: staff to /login, a shipper to the Shipper tab, a seeker to the Seeker tab.
 */
export async function authFetch(
  path: string,
  init?: RequestInit,
  whenSessionEnds: () => void = () => { }
): Promise<Response> {
  const run = (token: string | null) => fetch(`${API}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  let token = sessionStorage.getItem(ACCESS);
  if (token && secondsLeft(token) <= REFRESH_AHEAD_SECONDS) {
    token = await refreshAccessToken() ?? token;
  }

  let res = await run(token);
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (!fresh) {
      sessionStorage.removeItem(ACCESS);
      whenSessionEnds();
      throw new Error("session ended");
    }
    res = await run(fresh);
  }
  return res;
}
