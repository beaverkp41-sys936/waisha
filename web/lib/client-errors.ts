"use client";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const INTAKE = "/api/v1/client-errors";

export type ClientErrorSource = "boundary" | "window" | "rejection" | "fetch";

export type ClientErrorItem = {
  message: string;
  code?: string;
  source?: ClientErrorSource;
  path?: string;
  status?: number;
  detail?: string;
  requestId?: string;
};

const MAX_MESSAGE = 500;
const MAX_DETAIL = 4000;
const MAX_CODE = 60;
const MAX_PATH = 300;
/** The intake door takes at most five per call, so the queue ships at five. */
const BATCH = 5;
const FLUSH_MS = 4000;
/** One page load may contribute this many distinct bugs, however long it stays open. */
const SESSION_CAP = 40;

/**
 * The browser's half of the error register (082).
 *
 * A page that breaks should still tell us. Everything here is built on one rule: a
 * collector must never become the incident — so every entry point swallows its own
 * failures, holds no state the app can read, and sends nothing but what a failure
 * already says about itself.
 *
 * What it never sends: an access credential, a cookie, a header, a form value, or a
 * response body.
 * The message and stack are the browser's own text; the server scrubs contact-shaped
 * strings and collapses ids before it stores or hashes any of it.
 */

/** One report per distinct bug per page load. A load that fails twice on the same
 *  line only ever proves the line once. */
const seen = new Set<string>();
let pending: ClientErrorItem[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function clamp(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

function where(): string {
  try {
    return typeof window === "undefined" ? "" : window.location.pathname;
  } catch {
    return "";
  }
}

function keyOf(item: ClientErrorItem): string {
  return [item.source, item.code, item.status, item.message].join("|");
}

export function reportClientError(input: ClientErrorItem): void {
  try {
    const item: ClientErrorItem = {
      message: clamp(input.message, MAX_MESSAGE) ?? "",
      code: clamp(input.code, MAX_CODE),
      source: input.source,
      path: clamp(input.path ?? where(), MAX_PATH),
      status: input.status,
      detail: clamp(input.detail, MAX_DETAIL),
      requestId: clamp(input.requestId, 64)
    };
    if (!item.message) return;
    if (item.path?.includes(INTAKE)) return;
    const key = keyOf(item);
    if (seen.has(key) || seen.size >= SESSION_CAP) return;
    seen.add(key);
    pending.push(item);
    if (pending.length >= BATCH) flushClientErrors();
    else schedule();
  } catch {
    // The page is already broken; this is not the place to throw.
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushClientErrors();
  }, FLUSH_MS);
}

/**
 * Fire and forget, and only ever once per queued item: an intake that is refused, offline
 * or simply slow is not retried, because a retry loop against an error endpoint is how one
 * bad deploy turns into a denial of its own API.
 */
export function flushClientErrors(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!pending.length) return;
  const batch = pending.splice(0, BATCH);
  try {
    void fetch(`${API}${INTAKE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ errors: batch }),
      keepalive: true
    }).catch(() => { });
  } catch {
    // Nothing to do: the report is already lost and the page is the user's problem now.
  }
}

/**
 * A 5xx from our own API, with the two things that make it findable on the server: the
 * status it answered with and the `x-request-id` it stamped on the reply. The body is read
 * from a clone, because the caller still has the original stream to consume.
 */
export async function reportFetchError(path: string, res: Response): Promise<void> {
  try {
    if (res.status < 500 || path.includes(INTAKE)) return;
    let code: string | undefined;
    let message: string | undefined;
    try {
      const json = await res.clone().json();
      const e = json?.error;
      if (typeof e === "object" && e) {
        code = typeof e.code === "string" ? e.code : undefined;
        message = typeof e.message === "string" ? e.message : undefined;
      }
    } catch {
      // A 500 with no readable body still deserves a line.
    }
    reportClientError({
      message: message ?? `The API answered ${res.status} for ${path}`,
      code: code ?? `API_${res.status}`,
      source: "fetch",
      path,
      status: res.status,
      requestId: res.headers.get("x-request-id") ?? undefined
    });
  } catch {
    // Reporting a failed call must not fail the call.
  }
}
