import type { PoolClient } from "pg";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";

/**
 * Where a reported position is believed. These are the same four numbers the route builder
 * refuses a pin outside (`STOP_PIN_OUT_OF_RANGE` in routes.routes.ts), on purpose: a fleet
 * ledger that accepted a truck in a place the planner will not route to would put a marker
 * on the map that no trip could ever explain. Two copies of the box is a drift risk, and it
 * is noted here so the next reader looks for the other one rather than finding it by
 * accident.
 */
export const CORRIDOR_BOX = { minLat: -20, maxLat: 5, minLng: 25, maxLng: 45 } as const;

export type PositionSource = "device" | "manual" | "trip_departure" | "trip_arrival";

export interface PositionInput {
  tenantId: string;
  vesselId: string;
  lat: number;
  lng: number;
  source: PositionSource;
  tripId?: string | null;
  driverId?: string | null;
  accuracyM?: number | null;
  odometerKm?: number | null;
  note?: string | null;
  recordedAt?: string | null;
  recordedBy?: string | null;
}

/**
 * One append, always. There is no update or delete path for a position anywhere in the
 * platform: `vessel_positions` is granted select+insert to app_runtime, so a correction is a
 * new row beside the wrong one and the ledger keeps both claims and who made them.
 */
export async function insertPosition(c: PoolClient, p: PositionInput): Promise<string> {
  const id = uuidv7();
  await c.query(
    `insert into vessel_positions (id, tenant_id, vessel_id, trip_id, driver_id, lat, lng,
                                    source, accuracy_m, odometer_km, note, recorded_at, recorded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()), $13)`,
    [id, p.tenantId, p.vesselId, p.tripId ?? null, p.driverId ?? null, p.lat, p.lng,
     p.source, p.accuracyM ?? null, p.odometerKm ?? null, p.note ?? null,
     p.recordedAt ?? null, p.recordedBy ?? null]);
  return id;
}

export function inCorridorBox(lat: number, lng: number): boolean {
  return lat >= CORRIDOR_BOX.minLat && lat <= CORRIDOR_BOX.maxLat
    && lng >= CORRIDOR_BOX.minLng && lng <= CORRIDOR_BOX.maxLng;
}

/**
 * A trip leg leaves the vehicle at the route's own traced anchors, so a fleet map gets a
 * position from the paperwork the office already did rather than from a device nobody has.
 * Only `origin_lat/origin_lng` and `dest_lat/dest_lng` (075) are used: an estimated route
 * carries them too, and a straight-line anchor is still the town the trip was booked to.
 *
 * Returns false when the route has no coordinate for that end — no row is invented, and the
 * caller reports "not positioned" instead of guessing a centroid.
 */
export async function recordTripLegPosition(
  c: PoolClient,
  o: {
    tenantId: string; tripId: string; vesselId: string; routeId: string;
    driverId: string | null; reference: string | null;
    source: "trip_departure" | "trip_arrival"; actorId: string;
  }
): Promise<boolean> {
  const leg = await c.query(
    `select case when $3 = 'trip_departure' then r.origin_lat else r.dest_lat end as lat,
            case when $3 = 'trip_departure' then r.origin_lng else r.dest_lng end as lng,
            v.odometer_km
       from routes r
       join vessels v on v.id = $4 and v.tenant_id = r.tenant_id
      where r.id = $1 and r.tenant_id = $2`,
    [o.routeId, o.tenantId, o.source, o.vesselId]);
  const row = leg.rows[0];
  if (!row || row.lat == null || row.lng == null) return false;

  await insertPosition(c, {
    tenantId: o.tenantId,
    vesselId: o.vesselId,
    lat: Number(row.lat),
    lng: Number(row.lng),
    source: o.source,
    tripId: o.tripId,
    driverId: o.driverId,
    odometerKm: row.odometer_km ?? null,
    note: `Trip ${o.reference ?? "leg"} ${o.source === "trip_departure" ? "departed" : "arrived"}`,
    recordedBy: o.actorId
  });
  return true;
}

/**
 * Keep the register in step with `drivers.assigned_vessel_id` when the scalar moves from the
 * driver profile.
 *
 * The scalar is a projection of the register, so a write to it that ignores the register would
 * leave the two pages that read each of them telling different stories — the fleet desk would
 * say nobody holds the truck while the driver's own file names the driver. The register's two
 * open-row unique indexes exist to stop a vehicle sitting in two hands at once, and the scalar
 * path is the one door that could still walk around them, so this closes it: an old handover is
 * ended, a new one is opened, and a truck already in another driver's hands is refused in the
 * same words the fleet desk uses.
 */
export async function mirrorScalarAssignment(
  c: PoolClient,
  o: {
    tenantId: string; driverId: string;
    vesselId: string | null; previousVesselId: string | null; actorId: string;
  }
): Promise<{ openedId: string | null; endedId: string | null }> {
  if (o.vesselId === o.previousVesselId) return { openedId: null, endedId: null };

  // Both halves are proved to belong to this company before anything is written. 093 made the
  // pairing a foreign key, so the database refuses a mixed row outright; the checks here exist
  // to answer a dispatcher with the plate or the name that is wrong instead of a constraint
  // code, and to refuse before a handover has already been closed.
  const person = await c.query(
    `select full_name from drivers
      where id = $1 and tenant_id = $2 and deleted_at is null`,
    [o.driverId, o.tenantId]);
  if (!person.rowCount) {
    throw new ApiError("NOT_FOUND",
      "That driver is not one this company can hand a vehicle to.", 404);
  }

  let vessel: { name: string, plate_number: string } | null = null;
  if (o.vesselId) {
    const v = await c.query(
      `select name, plate_number from vessels
        where id = $1 and tenant_id = $2 and deleted_at is null`,
      [o.vesselId, o.tenantId]);
    if (!v.rowCount) {
      throw new ApiError("NOT_FOUND",
        "That vehicle is not one this company can assign.", 404);
    }
    vessel = v.rows[0];
    const taken = await c.query(
      `select d.full_name from vessel_assignments a
         join drivers d on d.id = a.driver_id
        where a.tenant_id = $1 and a.vessel_id = $2 and a.status = 'active'
          and a.deleted_at is null and a.driver_id <> $3`,
      [o.tenantId, o.vesselId, o.driverId]);
    if (taken.rowCount) {
      throw new ApiError("ASSIGNMENT_VESSEL_TAKEN",
        `${vessel!.name} (${vessel!.plate_number}) is already in the hands of `
        + `${taken.rows[0].full_name}. End that assignment before handing the vehicle over `
        + `from the driver's file.`, 409);
    }
  }

  const closed = await c.query(
    `update vessel_assignments
        set status = 'ended', ended_at = now(), ended_by = $3, updated_by = $3
      where tenant_id = $1 and driver_id = $2 and status = 'active' and deleted_at is null
      returning id`,
    [o.tenantId, o.driverId, o.actorId]);
  const endedId = closed.rows[0]?.id ?? null;
  if (!o.vesselId) return { openedId: null, endedId };

  const openedId = uuidv7();
  try {
    await c.query(
      `insert into vessel_assignments (id, tenant_id, vessel_id, driver_id, status,
                                       notes, assigned_by, created_by)
       values ($1,$2,$3,$4,'active',$5,$6,$6)`,
      [openedId, o.tenantId, o.vesselId, o.driverId,
       "Recorded from the driver's file, not the fleet desk.", o.actorId]);
  } catch (e: any) {
    if (e?.code === "23505") {
      throw new ApiError("ASSIGNMENT_TAKEN",
        `${person.rows[0].full_name} or ${vessel!.plate_number} was claimed in the same moment `
        + `by someone else. Reload the register before trying again.`, 409);
    }
    throw e;
  }
  return { openedId, endedId };
}
