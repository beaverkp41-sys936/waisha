"use client";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * Auth-aware fetch for shipper-portal pages. Same session contract as the
 * internal portal (Bearer access token + rotating refresh cookie), but a
 * failed refresh sends the shipper back to the Shipper login tab.
 */
export async function portalFetch(path: string, init?: RequestInit): Promise<Response> {
  const doFetch = (t: string | null) => fetch(`${API}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.headers ?? {}),
      ...(t ? { Authorization: `Bearer ${t}` } : {})
    }
  });

  let res = await doFetch(sessionStorage.getItem("waisha_access"));

  if (res.status === 401) {
    const refresh = await fetch(`${API}/api/v1/auth/refresh`, {
      method: "POST",
      credentials: "include"
    });
    if (refresh.ok) {
      const j = await refresh.json();
      sessionStorage.setItem("waisha_access", j.accessToken);
      res = await doFetch(j.accessToken);
    } else {
      sessionStorage.removeItem("waisha_access");
      window.location.href = "/login?tab=shipper";
      throw new Error("session ended");
    }
  }

  return res;
}
