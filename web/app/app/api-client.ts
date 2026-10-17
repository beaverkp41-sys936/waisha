"use client";

import { authFetch } from "@/lib/session";

/**
 * Shared auth-aware fetch for all transporter-portal pages.
 * - Attaches the access token from sessionStorage
 * - On 401: silently refreshes the token once and retries
 * - On refresh failure: redirects to /login
 *
 * The refresh itself is single-flight and shared with the shipper and seeker shells
 * (see lib/session.ts): the cookie rotates on every call, so two portal pages
 * refreshing at the same used to look like token theft and revoke the whole family.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return authFetch(path, init, () => { window.location.href = "/login"; });
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
  const res = await authFetch(path, {
    headers: { Accept: "text/event-stream" },
    signal
  }, () => { window.location.href = "/login"; });

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
