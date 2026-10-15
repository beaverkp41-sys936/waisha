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

/**
 * Server-sent events over fetch. EventSource cannot set a header, and a token
 * in the query string would end up in proxies and server logs — so the stream
 * reads the body by hand and keeps the same header auth as every other call.
 */
export async function apiStream(
  path: string,
  onEvent: (name: string, data: any) => void,
  signal: AbortSignal
): Promise<Response> {
  const doFetch = (t: string | null) => fetch(`${API}/api/v1${path}`, {
    headers: { Accept: "text/event-stream", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    credentials: "include",
    signal
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

  // Resolves when the socket ends, so the caller decides whether to reconnect.
  if (res.ok && res.body) await readFrames(res.body, onEvent, signal);
  return res;
}

async function readFrames(
  body: ReadableStream<Uint8Array>,
  onEvent: (name: string, data: any) => void,
  signal: AbortSignal
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut = buf.indexOf("\n\n");
      while (cut >= 0) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        cut = buf.indexOf("\n\n");
        let name = "message";
        let data: any = null;
        for (const line of raw.split("\n")) {
          // ":" lines are comment heartbeats — they keep the socket warm only.
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            try { data = JSON.parse(line.slice(5).trim()); } catch { data = null; }
          }
        }
        if (data) onEvent(name, data);
      }
    }
  } catch {
    // Aborted or dropped: the caller reconnects.
  } finally {
    reader.cancel().catch(() => { });
  }
}
