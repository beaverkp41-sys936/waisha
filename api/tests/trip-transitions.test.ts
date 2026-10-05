import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const {
  tripCanTransition,
  nextTripStatuses,
  isTripStatus,
  tripStampsFor
} = await import("../src/operations/trip-status.js");

describe("tripCanTransition", () => {
  it("follows the happy path planned → in_transit → arrived → completed", () => {
    expect(tripCanTransition("planned", "in_transit")).toBe(true);
    expect(tripCanTransition("in_transit", "arrived")).toBe(true);
    expect(tripCanTransition("arrived", "completed")).toBe(true);
  });

  it("allows cancellation from every non-terminal status", () => {
    expect(tripCanTransition("planned", "cancelled")).toBe(true);
    expect(tripCanTransition("in_transit", "cancelled")).toBe(true);
    expect(tripCanTransition("arrived", "cancelled")).toBe(true);
  });

  it("rejects skips, reversals and terminal exits", () => {
    expect(tripCanTransition("planned", "completed")).toBe(false);
    expect(tripCanTransition("planned", "arrived")).toBe(false);
    expect(tripCanTransition("arrived", "in_transit")).toBe(false);
    expect(tripCanTransition("completed", "planned")).toBe(false);
    expect(tripCanTransition("cancelled", "planned")).toBe(false);
    expect(tripCanTransition("completed", "cancelled")).toBe(false);
  });
});

describe("nextTripStatuses", () => {
  it("lists allowed next statuses for UI selectors", () => {
    expect(nextTripStatuses("planned")).toEqual(["in_transit", "cancelled"]);
    expect(nextTripStatuses("in_transit")).toEqual(["arrived", "cancelled"]);
    expect(nextTripStatuses("completed")).toEqual([]);
    expect(nextTripStatuses("cancelled")).toEqual([]);
  });
});

describe("isTripStatus", () => {
  it("guards unknown values", () => {
    expect(isTripStatus("in_transit")).toBe(true);
    expect(isTripStatus("on_route")).toBe(false);
    expect(isTripStatus(null)).toBe(false);
  });
});

describe("tripStampsFor", () => {
  it("stamps departure on departure only", () => {
    expect(tripStampsFor("in_transit")).toEqual({ actualDeparture: "now" });
  });
  it("stamps arrival on arrive and complete, nothing else", () => {
    expect(tripStampsFor("arrived")).toEqual({ actualArrival: "now" });
    expect(tripStampsFor("completed")).toEqual({ actualArrival: "now" });
    expect(tripStampsFor("cancelled")).toEqual({});
    expect(tripStampsFor("planned")).toEqual({});
  });
});
