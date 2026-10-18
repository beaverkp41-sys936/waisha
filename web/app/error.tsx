"use client";

import { useEffect } from "react";
import Link from "next/link";
import { reportClientError } from "@/lib/client-errors";

/**
 * The render-error boundary for every screen in the app (Next gives each segment its own,
 * and this is the one under all of them).
 *
 * Before this file a component that threw during render produced Next's own stack page —
 * useful to a developer, alarming to a clearing agent, and invisible to the register. Now
 * the seat sees a sentence, and the failure lands in `app_errors` with the digest the
 * server wrote to its log so the two halves can be matched up.
 */
export default function AppError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError({
      message: error?.message || "A screen failed to render",
      code: error?.name ?? "RenderError",
      source: "boundary",
      detail: typeof error?.stack === "string" ? error.stack : undefined,
      requestId: error?.digest
    });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-[640px] flex-col justify-center px-24 py-32">
      <div className="rounded-card border p-24"
        style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
          style={{ color: "var(--danger)" }}>
          This screen stopped
        </p>
        <h1 className="mt-12 text-xl font-bold" style={{ color: "var(--ink)" }}>
          Something on this page could not be drawn
        </h1>
        <p className="mt-10 text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          Nothing you typed was lost on purpose, and nothing was sent anywhere it should not
          be. The details reached the platform desk on its own, so an engineer can see it
          even if nobody reports it. Try again, or go back where you were.
        </p>

        <p className="mt-16 break-words rounded-input px-12 py-8 font-mono text-[11px]"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--ink)" }}>
          {error?.message || "unknown"}
          {error?.digest ? ` · ref ${error.digest}` : ""}
        </p>

        <div className="mt-24 flex flex-wrap items-center gap-12">
          <button type="button" onClick={reset}
            className="waisha-btn rounded-input px-16 py-8 text-sm font-semibold">
            Try again
          </button>
          <Link href="/"
            className="rounded-input border px-16 py-8 text-sm font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            Back to the start
          </Link>
        </div>
      </div>
    </div>
  );
}
