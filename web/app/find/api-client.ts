"use client";

import { authFetch } from "@/lib/session";

/**
 * Auth-aware fetch for the seeker shell. Same session contract as the shipper portal
 * (Bearer access token + one rotating refresh cookie shared across the app), but a dead
 * session returns the seeker to the Seeker login tab: a seeker token is portal-only, so
 * the audience gate would answer 403 for any staff surface it wandered into.
 */
export function seekerFetch(path: string, init?: RequestInit): Promise<Response> {
  return authFetch(path, init, () => { window.location.href = "/login?tab=seeker"; });
}

