"use client";
import { portalFetch } from "../api-client";
import { RecommendationBox } from "@/components/RecommendationBox";

/**
 * The shipper's copy of the recommendation box (070). A client's complaint reaches the
 * office by telephone today and is then remembered by whoever answered it; this writes it
 * down in the same register the platform team reads.
 */
export default function PortalRecommendationsPage() {
  return (
    <div className="mx-auto max-w-[720px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Recommendations</h1>
      <p className="mt-8 max-w-[600px] text-sm" style={{ color: "var(--ink-soft)" }}>
        How this portal could work better for you — or something the transporter side should
        have changed. The WAISHA platform team reads it; it is not sent to the company that
        gave you this account.
      </p>
      <RecommendationBox fetcher={portalFetch} prefix="/portal/recommendations"
        who="The platform team reads this, not the company that opened your account." />
    </div>
  );
}
