/**
 * Trip lifecycle — the only allowed status transitions.
 *
 *   planned ──▶ in_transit ──▶ arrived ──▶ completed
 *      │             │             │
 *      └─────────────┴─────────────┴──▶ cancelled
 *
 * completed and cancelled are terminal. Departure/arrival stamps ride on
 * the same transition (see stampsFor), so callers never set them ad hoc.
 */

export const TRIP_STATUSES = [
  "planned",
  "in_transit",
  "arrived",
  "completed",
  "cancelled"
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

/** Statuses that hold the vessel and driver (a driver can't be on two active trips). */
export const ACTIVE_TRIP_STATUSES: TripStatus[] = ["planned", "in_transit"];

const TRIP_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  planned: ["in_transit", "cancelled"],
  in_transit: ["arrived", "cancelled"],
  arrived: ["completed", "cancelled"],
  completed: [],
  cancelled: []
};

export function tripCanTransition(from: TripStatus, to: TripStatus): boolean {
  return TRIP_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Next statuses for UI selectors; terminal statuses yield an empty list. */
export function nextTripStatuses(from: TripStatus): TripStatus[] {
  return [...(TRIP_TRANSITIONS[from] ?? [])];
}

export function isTripStatus(value: unknown): value is TripStatus {
  return TRIP_STATUSES.includes(value as TripStatus);
}

/**
 * Columns to stamp when a transition lands: departing sets actual_departure,
 * reaching/completing sets actual_arrival. The other column is left alone so
 * a re-transition never overwrites a real timestamp.
 */
export function tripStampsFor(
  to: TripStatus
): { actualDeparture?: "now"; actualArrival?: "now" } {
  if (to === "in_transit") return { actualDeparture: "now" };
  if (to === "arrived" || to === "completed") return { actualArrival: "now" };
  return {};
}
