"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/** Two letters out of whatever the seat is called — the fallback when no picture is on file. */
export function initials(name: string | null, email: string) {
  const parts = (name || email || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

interface Props {
  userId: string;
  /** The roster row already carries this; the face is only fetched when it is set. */
  avatarDocumentId: string | null;
  name: string | null;
  email: string;
  size?: number;
}

/**
 * The face, or the monogram.
 *
 * The signed URL is short-lived, so it is fetched per mount rather than stored —
 * a roster of twenty seats means twenty small requests, and none of them can serve a
 * stale picture after someone replaces it.
 */
export function SeatFace({ userId, avatarDocumentId, name, email, size = 44 }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!avatarDocumentId) { setUrl(null); return; }
    let live = true;
    fetch(`${API}/api/v1/control/staff/${userId}/avatar`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: any) => { if (live && j?.url) setUrl(String(j.url)); })
      .catch(() => { /* no picture is a normal state, not an error */ });
    return () => { live = false; };
  }, [userId, avatarDocumentId]);

  if (url) {
    return <img src={url} alt={name ?? email} width={size} height={size}
      style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover",
        border: "2px solid var(--adm-accent-soft)", flex: "0 0 auto" }} />;
  }
  return <span aria-hidden style={{
    width: size, height: size, borderRadius: "50%", display: "inline-flex", flex: "0 0 auto",
    alignItems: "center", justifyContent: "center", fontSize: size * 0.36, fontWeight: 700,
    background: "var(--adm-accent-soft)", color: "var(--adm-accent)",
    border: "1px solid var(--adm-line)"
  }}>{initials(name, email)}</span>;
}
