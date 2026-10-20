"use client";

import { WorkshopDesk } from "@/components/WorkshopDesk";

/**
 * The workshop register for the whole company. Every button and refusal on it comes from the
 * register's own answer, so this page carries no rule of its own.
 */
export default function WorkshopPage() {
  return (
    <div className="mx-auto max-w-[1080px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Workshop</h1>
      <p className="mt-8 max-w-[720px] text-sm" style={{ color: "var(--ink-soft)" }}>
        Every service, repair and accident job a plate has been sent for — at a garage or in
        house, against a named mechanic, with the bill attached. A card writes a line into the
        vehicle's own journal but never moves the money: the figures stay on the card so the
        workshop's cost can be read per plate, per kind and per garage.
      </p>
      <div className="mt-24">
        <WorkshopDesk />
      </div>
    </div>
  );
}
