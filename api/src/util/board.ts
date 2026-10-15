import { pool } from "../db/pool.js";

/**
 * The notice board card — RULE 0's only cross-tenant surface.
 *
 * Two allowlists guard it. In the database, board_requests() is a SECURITY
 * DEFINER function that returns a fixed composite type (board_card) and
 * app_runtime holds EXECUTE, never SELECT, so another company's row is
 * reachable only through those declared columns. Here, `toCard` names every
 * field again, so a widened composite type still cannot reach a browser
 * through an accidental object spread.
 *
 * What is absent is the point: no tenant_id, job_id, shipment_id, route_id,
 * contact_user_id, disclosed_by, no file number, consignee, cost, declaration
 * or document reference. A transporter sees a load, a route and a company.
 */
export interface BoardCard {
  id: string;
  cargoLabel: string;
  containerType: string | null;
  containerCount: number | null;
  weightTonnes: number | null;
  cbm: number | null;
  vehicleTypes: string[];
  routeLabel: string | null;
  distanceKm: number | null;
  expectedDurationHours: number | null;
  pickupText: string;
  destText: string;
  viaLabel: string | null;
  requiredDate: string;
  pickupRegionId: number | null;
  pickupRegionName: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  destRegionId: number | null;
  destRegionName: string | null;
  destLat: number | null;
  destLng: number | null;
  contactName: string;
  contactChannel: string;
  publicNote: string | null;
  companyName: string;
  companyDescription: string | null;
  companyServices: string | null;
  companyCorridors: string | null;
  companyWebsite: string | null;
  fleetSizeDeclared: number | null;
  yearEstablished: number | null;
  disclosedAt: string;
}

/** Column order of board_card — declared once, asserted by verify-board-sql. */
export const BOARD_CARD_COLUMNS = [
  "id", "cargo_label", "container_type", "container_count", "weight_tonnes", "cbm",
  "vehicle_types", "route_label", "distance_km", "expected_duration_hours",
  "pickup_text", "dest_text", "via_label", "required_date",
  "pickup_region_id", "pickup_region_name", "pickup_lat", "pickup_lng",
  "dest_region_id", "dest_region_name", "dest_lat", "dest_lng",
  "contact_name", "contact_channel", "public_note",
  "company_name", "company_description", "company_services", "company_corridors",
  "company_website", "fleet_size_declared", "year_established",
  "disclosed_at", "total"
] as const;

/** Anything a board response must never carry, checked against real payloads. */
export const BOARD_FORBIDDEN_KEYS = [
  "tenant_id", "tenantId", "job_id", "jobId", "shipment_id", "shipmentId",
  "route_id", "routeId", "contact_user_id", "contactUserId", "disclosed_by",
  "disclosedBy", "cancelled_by", "cancelledBy", "cancelled_at", "cancelledAt",
  "file_number", "fileNumber", "consignee", "consigneeName", "consignor",
  "consignorName", "cost", "amount", "rate", "margin", "note", "notes",
  "declaration", "tanad", "rcn", "container_number", "containerNumber", "nida"
];

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * A pg row of board_card columns to the client shape. Explicit on purpose:
 * numeric arrives as a string from pg and dates must stay plain text, so this
 * is also where the wire types are pinned.
 */
function toCard(r: any): BoardCard {
  return {
    id: r.id,
    cargoLabel: r.cargo_label,
    containerType: r.container_type ?? null,
    containerCount: r.container_count === null ? null : Number(r.container_count),
    weightTonnes: num(r.weight_tonnes),
    cbm: num(r.cbm),
    vehicleTypes: r.vehicle_types ?? [],
    routeLabel: r.route_label ?? null,
    distanceKm: r.distance_km === null ? null : Number(r.distance_km),
    expectedDurationHours:
      r.expected_duration_hours === null ? null : Number(r.expected_duration_hours),
    pickupText: r.pickup_text,
    destText: r.dest_text,
    viaLabel: r.via_label ?? null,
    requiredDate: r.required_date,
    pickupRegionId: r.pickup_region_id === null ? null : Number(r.pickup_region_id),
    pickupRegionName: r.pickup_region_name ?? null,
    pickupLat: num(r.pickup_lat),
    pickupLng: num(r.pickup_lng),
    destRegionId: r.dest_region_id === null ? null : Number(r.dest_region_id),
    destRegionName: r.dest_region_name ?? null,
    destLat: num(r.dest_lat),
    destLng: num(r.dest_lng),
    contactName: r.contact_name,
    contactChannel: r.contact_channel,
    publicNote: r.public_note ?? null,
    companyName: r.company_name,
    companyDescription: r.company_description ?? null,
    companyServices: r.company_services ?? null,
    companyCorridors: r.company_corridors ?? null,
    companyWebsite: r.company_website ?? null,
    fleetSizeDeclared: r.fleet_size_declared === null ? null : Number(r.fleet_size_declared),
    yearEstablished: r.year_established === null ? null : Number(r.year_established),
    disclosedAt: r.disclosed_at instanceof Date ? r.disclosed_at.toISOString() : String(r.disclosed_at)
  };
}

export interface BoardFilters {
  vehicle?: string | null;
  regionId?: number | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

/**
 * The board never runs as a tenant: there is no withTenant here on purpose.
 * The function is the only door, and it is bounded server-side (limit <= 100).
 */
export async function listBoard(f: BoardFilters): Promise<{ rows: BoardCard[]; total: number }> {
  const { rows } = await pool.query(
    `select * from board_requests($1, $2, $3::date, $4::date, $5, $6, $7)`,
    [f.vehicle ?? null, f.regionId ?? null, f.from ?? null, f.to ?? null,
      f.search?.trim() || null, f.limit ?? 40, f.offset ?? 0]);
  return { rows: rows.map(toCard), total: Number(rows[0]?.total ?? 0) };
}

/** One card, or null when the request is not on the board (booked, withdrawn, private). */
export async function getBoardCard(id: string): Promise<BoardCard | null> {
  const { rows } = await pool.query(
    `select (board_request_card($1)).*`, [id]);
  const r = rows[0];
  // A composite-returning SQL function gives one all-null row when it found nothing.
  if (!r || r.id === null) return null;
  return toCard(r);
}

/** Open count for the stream's hello frame — the same door, one row. */
export async function boardSummary(): Promise<{ open: number; newest: string | null }> {
  const { rows } = await pool.query(
    `select * from board_requests(null, null, null, null, null, 1, 0)`);
  return { open: rows[0]?.total ?? 0, newest: rows[0]?.disclosed_at ?? null };
}
