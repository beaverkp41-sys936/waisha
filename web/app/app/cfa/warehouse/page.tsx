"use client";

import { WarehouseDesk } from "@/components/WarehouseDesk";

/**
 * The warehouse register for the whole company. Every quantity, day and charge on it is the
 * server's answer — this page holds no rule of its own, only the words that say what a hold is.
 */
export default function WarehousePage() {
  return (
    <div className="mx-auto max-w-[1120px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Warehouse</h1>
      <p className="mt-8 max-w-[760px] text-sm" style={{ color: "var(--ink-soft)" }}>
        Goods that are standing in a store for you — held for a cargo file, not owned by you. Count
        a delivery in on an entry docket, let it out on a gate pass, set the tariff and its free
        period, and the days between are what the file is billed. The book keeps its mistakes: a
        docket filed wrong is voided with your name and your reason on it, never deleted.
      </p>
      <div className="mt-24">
        <WarehouseDesk />
      </div>
    </div>
  );
}
