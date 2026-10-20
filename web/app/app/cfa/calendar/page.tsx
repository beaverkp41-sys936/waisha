"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";

interface CalendarEvent {
  date: string;
  type: string;
  label: string;
  detail: string;
  href: string;
}

const TYPE_COLORS: Record<string, string> = {
  eta: "var(--brand)", discharge: "var(--brand)", carry_in: "var(--brand)",
  trip_departure: "var(--gold-green)", trip_arrival: "var(--gold-green)",
  invoice_due: "var(--gold)", task_due: "var(--warning)", doc_expiry: "var(--danger)"
};
const TYPE_LABELS: Record<string, string> = {
  eta: "Cargo ETA", discharge: "Discharge", carry_in: "Carry-in",
  trip_departure: "Trip departure", trip_arrival: "Trip arrival",
  invoice_due: "Invoice due", task_due: "Task deadline", doc_expiry: "Document expiry"
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const key = monthKey(cursor);

  const load = useCallback(async (m: string) => {
    const res = await apiFetch(`/calendar/events?month=${m}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(j?.error?.message ?? "Could not load the calendar."); return; }
    setEvents(j.events ?? []);
  }, []);

  useEffect(() => { load(key); }, [load, key]);

  // Month grid: leading blanks so Monday is the first column.
  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
    const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
    return cells;
  }, [cursor]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [events]);

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const upcoming = useMemo(() => {
    const todayStr = todayKey.slice(0, 10);
    return events.filter(e => e.date >= todayStr).slice(0, 10);
  }, [events, todayKey]);

  const prevMonth = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  const nextMonth = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));

  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Calendar</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            ETAs, trip dates, invoice due dates, task deadlines and document renewals — in one month view.
          </p>
        </div>
        <div className="flex items-center gap-8">
          <button type="button" onClick={prevMonth} aria-label="Previous month"
            className="on-photo-btn px-12 py-8 text-xs font-semibold">Prev</button>
          <span className="pane-note min-w-[130px] text-center text-sm font-bold">
            {cursor.toLocaleDateString([], { month: "long", year: "numeric" })}
          </span>
          <button type="button" onClick={nextMonth} aria-label="Next month"
            className="on-photo-btn px-12 py-8 text-xs font-semibold">Next</button>
        </div>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      <div className="mt-24 grid grid-cols-1 gap-16 lg:grid-cols-[1fr_260px]">
        {/* Month grid */}
        <section className={card} style={cardStyle}>
          <div className="cal-scroll">
            <div className="cal-grid grid grid-cols-7 gap-4 text-center text-[10px] font-bold uppercase tracking-[0.1em]"
              style={{ color: "var(--ink-soft)" }}>
              {WEEKDAYS.map(d => <div key={d} className="py-8">{d}</div>)}
            </div>
            <div className="cal-grid grid grid-cols-7 gap-4">
              {grid.map((day, i) => {
                if (day === null) return <div key={`blank-${i}`} />;
                const dateStr = `${key}-${String(day).padStart(2, "0")}`;
                const dayEvents = byDate.get(dateStr) ?? [];
                const isToday = dateStr === todayKey;
                return (
                  <div key={dateStr}
                    className="min-h-[76px] rounded-input border p-4"
                    style={{
                      borderColor: isToday ? "var(--gold)" : dayEvents.length ? "var(--line)" : "transparent",
                      background: isToday ? "color-mix(in srgb, var(--gold) 12%, var(--surface))" : "transparent"
                    }}>
                    <p className={"text-[11px] font-bold tabular-nums" + (isToday ? " inline-block rounded-sm px-4" : "")} style={{
                      color: isToday ? "var(--on-solid)" : "var(--ink-soft)",
                      background: isToday ? "var(--gold)" : undefined
                    }}>{day}</p>
                    <div className="mt-2 space-y-2">
                      {dayEvents.slice(0, 3).map((e, n) => (
                        <Link key={`${e.type}-${n}`} href={e.href} title={`${e.label} — ${e.detail}`}
                          className="cal-chip block truncate rounded-sm px-4 text-[9px] font-semibold"
                          style={{
                            background: `color-mix(in srgb, ${TYPE_COLORS[e.type] ?? "var(--ink-soft)"} 16%, transparent)`,
                            borderLeft: `2px solid ${TYPE_COLORS[e.type] ?? "var(--ink-soft)"}`,
                            color: "var(--ink)"
                          }}>
                          {e.label}
                        </Link>
                      ))}
                      {dayEvents.length > 3 && (
                        <p className="px-4 text-[9px]" style={{ color: "var(--ink-soft)" }}>
                          +{dayEvents.length - 3} more
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="mt-16 flex flex-wrap gap-x-16 gap-y-4 border-t pt-12 text-[10px]" style={{ borderColor: "var(--line)" }}>
            {Object.entries(TYPE_LABELS).map(([t, l]) => (
              <span key={t} className="flex items-center gap-4" style={{ color: "var(--ink-soft)" }}>
                <span className="inline-block h-8 w-8 rounded-sm"
                  style={{ background: `color-mix(in srgb, ${TYPE_COLORS[t]} 45%, transparent)` }} />
                {l}
              </span>
            ))}
          </div>
        </section>

        {/* Upcoming sidebar */}
        <section className={card} style={cardStyle}>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Upcoming
          </h2>
          <div className="mt-16 space-y-8">
            {upcoming.map((e, i) => (
              <Link key={`${e.type}-${i}-${e.label}`} href={e.href}
                className="block rounded-input border px-12 py-8" style={cardStyle}>
                <p className="text-xs font-semibold" style={{ color: TYPE_COLORS[e.type] ?? "var(--ink)" }}>{e.label}</p>
                <p className="mt-2 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {new Date(e.date + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
                  {e.detail ? ` — ${e.detail}` : ""}
                </p>
              </Link>
            ))}
            {upcoming.length === 0 && (
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                Nothing scheduled for the rest of this month.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
