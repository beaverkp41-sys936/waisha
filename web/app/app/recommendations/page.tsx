"use client";
import { apiFetch } from "../api-client";
import { RecommendationBox } from "@/components/RecommendationBox";

/**
 * The author's own desk (070). Every role that works in the product lands here — the
 * list is only ever this account's notes, so a dispatcher reading it sees what they sent,
 * not what the company sent. The register itself is on the platform panel.
 */
export default function RecommendationsPage() {
  return (
    <div className="mx-auto max-w-[760px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Recommendations</h1>
      <p className="mt-8 max-w-[620px] text-sm" style={{ color: "var(--ink-soft)" }}>
        Tell the people who build WAISHA what is wrong or what is missing. This goes to the
        platform team, not to your employer — and you get their answer back on this page.
      </p>
      <RecommendationBox fetcher={apiFetch} prefix="/recommendations"
        who="Nobody in your company sees this — it reaches the platform team." />
    </div>
  );
}
