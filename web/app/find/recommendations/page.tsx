"use client";
import { seekerFetch } from "../api-client";
import { RecommendationBox } from "@/components/RecommendationBox";

/**
 * A seeker has no office to telephone and no director to corner, which is exactly why
 * this box is mounted on the seeker shell too (070). Same register, same desk, same answer.
 */
export default function FindRecommendationsPage() {
  return (
    <div className="mx-auto max-w-[720px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Recommendations</h1>
      <p className="mt-8 max-w-[600px] text-sm" style={{ color: "var(--ink-soft)" }}>
        Found something missing, or something that did not work the way you expected? Write it
        here and the WAISHA team reads it — the answer comes back to this page.
      </p>
      <RecommendationBox fetcher={seekerFetch} prefix="/seeker/recommendations"
        who="This goes to the WAISHA platform team, not to any transporter or CFA." />
    </div>
  );
}
