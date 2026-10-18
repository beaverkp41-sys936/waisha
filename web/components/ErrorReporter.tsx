"use client";

import { useEffect } from "react";
import { flushClientErrors, reportClientError } from "@/lib/client-errors";

/**
 * The window's own failures, collected once for every screen.
 *
 * Mounted in the root layout, so a crash on the sign-in page is caught too — that is the
 * page a broken build actually kills, and the one where nobody is around to report it.
 *
 * Three doors, because a browser fails in three different ways:
 *  - `error` with a capture listener, so a resource that never loaded (a chunk 404'd after
 *    a deploy) is visible as well as a thrown script;
 *  - `unhandledrejection`, which is where an awaited call that nobody caught disappears;
 *  - `pagehide`, which flushes what is still queued before the document goes away.
 *
 * Nothing here renders, and nothing here can break the page: a listener that throws is
 * worse than the bug it was trying to record.
 */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      try {
        const target: any = event.target;
        // A failed <script>/<link>/<img> carries no message — only its own node. What is
        // worth knowing is which kind of asset the browser could not fetch, so the tag and
        // the tail of its name are all this reads off it.
        if (target && target !== window && typeof target.tagName === "string") {
          const src = String(target.src || target.href || "");
          reportClientError({
            message: `Could not load ${target.tagName.toLowerCase()} ${src.split("/").pop()?.slice(0, 120) || "(no address)"}`,
            code: "ResourceLoadError",
            source: "window"
          });
          return;
        }
        if (/ResizeObserver loop/i.test(event.message ?? "")) return;
        if (!event.error && !event.message) return;
        reportClientError({
          message: event.message || event.error?.message || "Uncaught error",
          code: event.error?.name ?? "WindowError",
          source: "window",
          detail: typeof event.error?.stack === "string" ? event.error.stack : undefined
        });
      } catch {
        // never throw out of a listener
      }
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      try {
        const reason: any = event.reason;
        const message = typeof reason === "string" ? reason
          : reason?.message || "Unhandled promise rejection";
        reportClientError({
          message,
          code: reason?.name ?? "UnhandledRejection",
          source: "rejection",
          detail: typeof reason?.stack === "string" ? reason.stack : undefined
        });
      } catch {
        // never throw out of a listener
      }
    };

    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", flushClientErrors);
    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", flushClientErrors);
    };
  }, []);

  return null;
}
