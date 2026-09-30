"use client";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * Shared auth-aware fetch for all transporter-portal pages.
 * - Attaches the access token from sessionStorage
 * - On 401: silently refreshes the token once and retries
 * - On refresh failure: redirects to /login
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
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
      window.location.href = "/login";
      throw new Error("session ended");
    }
  }

  return res;
}