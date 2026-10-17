"use client";

import { authFetch } from "@/lib/session";

/**
 * Auth-aware fetch for shipper-portal pages. Same session contract as the
 * internal portal (Bearer access token + one shared rotating refresh cookie), but a
 * failed refresh sends the shipper back to the Shipper login tab.
 */
export function portalFetch(path: string, init?: RequestInit): Promise<Response> {
  return authFetch(path, init, () => { window.location.href = "/login?tab=shipper"; });
}
