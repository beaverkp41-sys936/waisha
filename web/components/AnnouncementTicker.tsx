"use client";
import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

interface Announcement {
  id: string;
  message: string;
  kind: string;
  created_at: string;
}

const KIND_META: Record<string, { label: string; color: string }> = {
  info: { label: "Notice", color: "#ffffff" },
  update: { label: "Update", color: "#8fd0ff" },
  upgrade: { label: "Upgrade", color: "#d9b25f" },
  maintenance: { label: "Maintenance", color: "#7fd8d8" },
  warning: { label: "Warning", color: "#ffcf70" }
};

/** Admin-posted notices scrolling through the middle of every header. */
export function AnnouncementTicker() {
  const [items, setItems] = useState<Announcement[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch(`${API}/api/v1/announcements`)
      .then(r => (r.ok ? r.json() : []))
      .then(j => { if (!cancelled) setItems(Array.isArray(j) ? j : []); })
      .catch(() => { });
    load();
    // Long-lived sessions: fresh notices arrive without a full reload.
    const timer = setInterval(load, 120000);
    // Instant refresh when the admin posts from the control page (same window).
    const onChanged = () => load();
    window.addEventListener("waisha:announcements", onChanged);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("waisha:announcements", onChanged);
    };
  }, []);

  if (items.length === 0) return null;

  // Constant reading speed: longer content scrolls proportionally longer.
  const chars = items.reduce((n, a) => n + a.message.length + 24, 0);
  const duration = Math.min(90, Math.max(18, Math.round(chars * 0.28)));

  const seq = (hidden: boolean) => (
    <span className="announce-seq" aria-hidden={hidden || undefined}>
      {items.map(a => {
        const meta = KIND_META[a.kind] ?? KIND_META.info;
        return (
          <span key={a.id} className="announce-item">
            <span className="announce-kind" style={{ color: meta.color }}>{meta.label}</span>
            <span>{a.message}</span>
            <span aria-hidden className="announce-dot" style={{ color: meta.color }}>•</span>
          </span>
        );
      })}
    </span>
  );

  return (
    <div className="announce-ticker" role="status" aria-label="System announcements">
      <span className="announce-pin" aria-hidden>
        <Megaphone size={12} strokeWidth={2.2} />
      </span>
      <div className="announce-viewport">
        <div className="announce-track" style={{ "--announce-dur": `${duration}s` } as React.CSSProperties}>
          {seq(false)}
          {seq(true)}
        </div>
      </div>
    </div>
  );
}
