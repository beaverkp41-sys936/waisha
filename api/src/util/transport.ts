import type { PoolClient } from "pg";
import { ApiError } from "./errors.js";
import { nameTokens, textTokens } from "./name-match.js";

/**
 * RULE 0 projection for the transport notice board.
 *
 * Everything another company could ever see about a job is built here, in one
 * place, from a fixed allowlist. There is deliberately no generic "spread the
 * shipment" path: fields with no entry in `PreviewFields` cannot reach the
 * board, so adding a column to cargo_shipments in a later wave publishes
 * nothing by accident.
 */

export const VEHICLE_TYPES = ["truck_head", "trailer", "tanker", "flatbed", "tipper",
  "reefer", "box_truck", "van", "pickup", "lowbed"] as const;

/** Shown in the preview so the CFA sees what stays inside their company. */
export const WITHHELD_FIELDS = [
  "Consignee and consignor names",
  "Cargo file number",
  "Costs, processing fees and payment status",
  "Internal notes",
  "HS code, declaration mode, TANAD, RCN, bill and reference numbers",
  "Container numbers and cabinet position",
  "Uploaded documents",
  "Shipping line, ETA, discharge and order dates",
  "Staff other than the one named contact",
  "TIN, VAT, BRELA, licence and bank details"
];

export interface PreviewFields {
  cargoLabel: string;
  containerType: string | null;
  containerCount: number | null;
  weightTonnes: number | null;
  cbm: number | null;
  vehicleTypes: string[];
  routeId: string | null;
  routeLabel: string | null;
  distanceKm: number | null;
  expectedDurationHours: number | null;
  pickupText: string;
  pickupRegionId: number | null;
  destText: string;
  destRegionId: number | null;
  viaLabel: string | null;
  requiredDate: string | null;
  contactUserId: string | null;
  contactName: string;
  contactChannel: string;
  publicNote: string | null;
}

export interface CompanyCard {
  companyName: string;
  description: string | null;
  services: string | null;
  corridors: string | null;
  website: string | null;
  fleetSizeDeclared: number | null;
  yearEstablished: number | null;
}

/** Containers need a chassis; loose cargo needs a flat deck. Only a hint. */
function suggestVehicles(containerType: string | null): string[] {
  if (containerType === "20ft" || containerType === "40ft") return ["truck_head", "trailer"];
  if (containerType === "car") return ["lowbed"];
  return ["flatbed", "box_truck"];
}

/**
 * True when the text spells the client out: two of their name tokens side by
 * side (one of them distinctive), or a one-word company name anywhere.
 * Scattered tokens are deliberately not enough — client names are built from
 * the same cargo and place words an advert must use, so "Steel coils"
 * on a load bound for "Kilimanjaro" is not a leak of "Kilimanjaro Steel Ltd".
 */
function namesClient(name: string, hay: string): boolean {
  const tokens = nameTokens(name);
  if (!tokens.length) return false;
  if (tokens.length === 1) return tokens[0].length >= 4 && hay.includes(tokens[0]);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const [a, b] = [tokens[i], tokens[i + 1]];
    if (a.length < 4 && b.length < 4) continue;
    if (hay.includes(`${a} ${b}`)) return true;
  }
  return false;
}

/**
 * Public text must not name the client or quote a private reference. Matches
 * are flagged, not blocked — the CFA reads the warning and edits the field.
 */
export function disclosureWarnings(fields: PreviewFields, privateNames: string[]): string[] {
  const warn: string[] = [];
  // The contact line counts too: a CFA who names the consignee as the contact
  // has just published the client.
  const publicText = [fields.cargoLabel, fields.pickupText, fields.destText,
    fields.viaLabel, fields.publicNote, fields.contactName]
    .filter((x): x is string => !!x);
  // Two views: tokens for name adjacency, raw text for the code patterns,
  // which are written with separators a tokeniser would destroy.
  const raw = publicText.join(" | ").toUpperCase();
  const hay = publicText.flatMap(textTokens).join(" ");

  for (const name of privateNames) {
    if (nameTokens(name).length && namesClient(name, hay)) {
      warn.push(`"${name}" may be named in the text you are publishing. ` +
        `Reword it — transporters must not see whose cargo this is.`);
    }
  }
  if (/[A-Z]{4}[\s-]?\d{7}/.test(raw)) {
    warn.push("The text looks like it contains a container number. Keep container numbers private.");
  }
  if (/\b\d{3}[-\s]\d{3}[-\s]\d{3}\b/.test(raw)) {
    warn.push("The text looks like it contains a TIN. Keep tax numbers private.");
  }
  return warn;
}

export interface PreviewSource {
  fields: PreviewFields;
  company: CompanyCard;
  routes: { id: string; label: string; distance_km: number | null;
    expected_duration_hours: number | null; dest_region_id: number | null }[];
  regions: { id: number; name: string }[];
  staff: { id: string; full_name: string; email: string | null }[];
  warnings: string[];
  withheld: string[];
}

/**
 * Assemble the exact field set a published request would carry, from the job's
 * shipment, the CFA's own company profile and the acting user as contact.
 * Nothing is written — the CFA reviews this, then publishes the approved copy.
 */
export async function buildPreview(
  c: PoolClient, tenantId: string, jobId: string, actorUserId: string
): Promise<PreviewSource> {
  const job = await c.query(
    `select j.id, j.shipment_id, j.status, j.record_kind, j.transport_needed, j.transport_consent,
            s.file_number, s.shipment_type, s.cargo_description, s.container_type,
            s.container_count, s.weight_tonnes, s.cbm, s.consignee_name, s.consignor_name,
            s.nominated_icd, s.border_point, s.carry_in_date::text as carry_in_date,
            s.eta::text as eta
       from jobs j
       join cargo_shipments s on s.id = j.shipment_id and s.tenant_id = j.tenant_id
      where j.id = $1 and j.tenant_id = $2 and j.deleted_at is null and s.deleted_at is null`,
    [jobId, tenantId]);
  if (!job.rowCount) throw new ApiError("NOT_FOUND", "Job not found", 404);
  const j = job.rows[0];

  const [profile, contact, routes, regions, staff] = await Promise.all([
    c.query(
      `select company_name, description, services_offered, corridors_served, website,
              fleet_size_declared, year_established
         from company_profiles where tenant_id = $1`, [tenantId]),
    c.query(
      `select id, full_name, email from users
        where id = $1 and tenant_id = $2 and deleted_at is null`,
      [actorUserId, tenantId]),
    c.query(
      `select r.id,
              coalesce(r.name, concat_ws(' - ', ro.name_en, rd.name_en)) as label,
              r.distance_km, r.expected_duration_hours, r.dest_region_id
         from routes r
         left join geo_regions ro on ro.id = r.origin_region_id
         left join geo_regions rd on rd.id = r.dest_region_id
        where r.tenant_id = $1 and r.deleted_at is null and r.is_active
        order by label limit 200`, [tenantId]),
    c.query(
      `select id, name_en as name from geo_regions
        where is_active and country = 'TZ' order by name_en`),
    c.query(
      `select id, full_name, email from users
        where tenant_id = $1 and deleted_at is null and status = 'active'
          and user_type in ('director','staff')
        order by full_name limit 200`, [tenantId])
  ]);

  const company: CompanyCard = profile.rowCount
    ? {
        companyName: profile.rows[0].company_name,
        description: profile.rows[0].description ?? null,
        services: profile.rows[0].services_offered ?? null,
        corridors: profile.rows[0].corridors_served ?? null,
        website: profile.rows[0].website ?? null,
        fleetSizeDeclared: profile.rows[0].fleet_size_declared ?? null,
        yearEstablished: profile.rows[0].year_established ?? null
      }
    : { companyName: "", description: null, services: null, corridors: null,
        website: null, fleetSizeDeclared: null, yearEstablished: null };

  const actor = contact.rowCount ? contact.rows[0] : null;
  const fields: PreviewFields = {
    cargoLabel: j.cargo_description?.trim() || `${j.shipment_type} cargo`,
    containerType: j.container_type ?? null,
    containerCount: j.container_count ?? null,
    weightTonnes: j.weight_tonnes === null ? null : Number(j.weight_tonnes),
    cbm: j.cbm === null ? null : Number(j.cbm),
    vehicleTypes: suggestVehicles(j.container_type ?? null),
    routeId: null,
    routeLabel: null,
    distanceKm: null,
    expectedDurationHours: null,
    // Pickup starts at the terminal the cargo sits in (a place, not a person);
    // for exports the CFA types the loading point themselves.
    pickupText: j.nominated_icd?.trim() ?? "",
    pickupRegionId: null,
    destText: "",
    destRegionId: null,
    viaLabel: j.border_point?.trim() || null,
    requiredDate: j.carry_in_date ?? j.eta ?? null,
    contactUserId: actor?.id ?? null,
    contactName: actor?.full_name ?? "",
    contactChannel: actor?.email ?? "",
    publicNote: null
  };

  return {
    fields,
    company,
    routes: routes.rows,
    regions: regions.rows,
    staff: staff.rows,
    warnings: disclosureWarnings(fields, [j.consignee_name, j.consignor_name]),
    withheld: WITHHELD_FIELDS
  };
}

/**
 * A route is the CFA's own data, so distance and labels are re-read server-side
 * at publish time — never taken from whatever the browser echoes back.
 */
export async function copyRoute(
  c: PoolClient, tenantId: string, routeId: string | null
): Promise<{ route_id: string; route_label: string | null; distance_km: number | null;
             expected_duration_hours: number | null; dest_region_id: number | null } | null> {
  if (!routeId) return null;
  const r = await c.query(
    `select r.id,
            coalesce(r.name, concat_ws(' - ', ro.name_en, rd.name_en)) as route_label,
            r.distance_km, r.expected_duration_hours, r.dest_region_id
       from routes r
       left join geo_regions ro on ro.id = r.origin_region_id
       left join geo_regions rd on rd.id = r.dest_region_id
      where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null`,
    [routeId, tenantId]);
  if (!r.rowCount) {
    throw new ApiError("VALIDATION_FAILED", "That route belongs to another company profile.",
      400, [{ field: "routeId" }]);
  }
  const x = r.rows[0];
  return { route_id: x.id, route_label: x.route_label, distance_km: x.distance_km,
    expected_duration_hours: x.expected_duration_hours, dest_region_id: x.dest_region_id };
}
