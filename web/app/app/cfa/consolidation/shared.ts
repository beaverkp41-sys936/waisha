/** Shared pieces of the consolidator module — the carrier register, the legs and
 * the LCL parcels on them. Kept out of the page files so the entry form and the
 * printed manifest never say different things. */

export const MODES = ["road", "marine", "air", "rail"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  road: "Mainland road — truck, trailer, tanker",
  marine: "Marine — lake, river and coastal vessel",
  air: "Air freight",
  rail: "Rail wagon"
};

export const MODE_SHORT: Record<Mode, string> = {
  road: "Road", marine: "Marine", air: "Air", rail: "Rail"
};

export const UNIT_TYPES = [
  "truck_head", "trailer", "tanker", "flatbed", "tipper", "reefer", "box_truck",
  "van", "pickup", "lowbed", "barge", "boat", "cargo_ship", "ferry", "tank_barge",
  "rail_wagon", "air_freighter", "air_charter"
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const UNIT_LABELS: Record<UnitType, string> = {
  truck_head: "Truck head (tractor)", trailer: "Trailer", tanker: "Tanker",
  flatbed: "Flatbed", tipper: "Tipper", reefer: "Reefer / temperature control",
  box_truck: "Box truck", van: "Van", pickup: "Pickup", lowbed: "Lowbed",
  barge: "Barge", boat: "Boat", cargo_ship: "Cargo ship", ferry: "Ferry",
  tank_barge: "Tank barge", rail_wagon: "Rail wagon",
  air_freighter: "Air freighter", air_charter: "Air charter"
};

/** The unit list follows the mode the clerk picked, so a vessel can never be
 * filed as a mainland truck. The API checks the same pairing again. */
export const UNITS_BY_MODE: Record<Mode, UnitType[]> = {
  road: ["truck_head", "trailer", "tanker", "flatbed", "tipper", "reefer", "box_truck",
    "van", "pickup", "lowbed"],
  marine: ["barge", "boat", "cargo_ship", "ferry", "tank_barge"],
  air: ["air_freighter", "air_charter"],
  rail: ["rail_wagon"]
};

export const CAPACITY_UNITS = ["tonnes", "kg", "teu", "m3"] as const;
export type CapacityUnit = (typeof CAPACITY_UNITS)[number];

export const CAPACITY_LABELS: Record<CapacityUnit, string> = {
  tonnes: "tonnes", kg: "kilograms", teu: "TEU (container slots)", "m3": "cubic metres"
};

export const CAPACITY_HINT: Record<CapacityUnit, string> = {
  tonnes: "Payload the unit may legally carry, in tonnes.",
  kg: "For a light unit — enter the plate payload in kilograms.",
  teu: "Container slots. Weight on board is then not judged against capacity.",
  "m3": "Cube for loose or bulky loads. Weight on board is then not judged against capacity."
};

export const SPECIALISATIONS = [
  "general", "dry_bulk", "liquid_bulk", "refrigerated", "hazardous", "live_animals"
] as const;
export type Specialisation = (typeof SPECIALISATIONS)[number];

export const SPECIALISATION_LABELS: Record<Specialisation, string> = {
  general: "General cargo", dry_bulk: "Dry bulk", liquid_bulk: "Liquid bulk",
  refrigerated: "Refrigerated / perishable", hazardous: "Hazardous / DG",
  live_animals: "Live animals"
};

export const SPECIALISATION_NOTE: Record<Specialisation, string> = {
  general: "Crated, palletised and bagged goods with no handling condition.",
  dry_bulk: "Unpacked bulk — grain, cement, minerals.",
  liquid_bulk: "Tankered liquids — fuel, chemicals in solution, water.",
  refrigerated: "Temperature-controlled, frozen or fresh produce.",
  hazardous: "Dangerous goods — needs the unit's DG paperwork on board.",
  live_animals: "Livestock and animals in transit."
};

export const MANIFEST_STATUSES = ["draft", "manifested", "in_transit", "delivered", "cancelled"] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

export const STATUS_LABELS: Record<ManifestStatus, string> = {
  draft: "Draft", manifested: "Manifested", in_transit: "In transit",
  delivered: "Delivered", cancelled: "Cancelled"
};

export const STATUS_COLORS: Record<ManifestStatus, string> = {
  draft: "var(--ink-soft)", manifested: "var(--brand)", in_transit: "var(--gold)",
  delivered: "var(--success)", cancelled: "var(--danger)"
};

/** Mirror of the server's state machine — it only decides which buttons to
 * offer. The API is what refuses an illegal move. */
export const NEXT_STATUSES: Record<ManifestStatus, ManifestStatus[]> = {
  draft: ["manifested", "cancelled"],
  manifested: ["in_transit", "cancelled", "draft"],
  in_transit: ["delivered", "cancelled"],
  delivered: [],
  cancelled: ["draft"]
};

/** Once the load has arrived or the leg was called off, its lines are evidence. */
export const FROZEN_STATUSES: ManifestStatus[] = ["delivered", "cancelled"];

export const CONTAINER_TYPES = ["20ft", "40ft", "loose_cargo", "car"] as const;
export const CONTAINER_LABELS: Record<string, string> = {
  "20ft": "20 ft container", "40ft": "40 ft container",
  loose_cargo: "Loose / LCL cargo", car: "Vehicle"
};

export const CURRENCIES = [
  { code: "TZS", label: "TZS — Tanzanian Shilling" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — Pound Sterling" },
  { code: "KES", label: "KES — Kenyan Shilling" },
  { code: "CNY", label: "CNY — Chinese Yuan" }
];

export const PAYMENT_LABELS: Record<string, string> = {
  unpaid: "Unpaid", partial: "Partially paid", paid: "Paid"
};
export const PAYMENT_COLORS: Record<string, string> = {
  unpaid: "var(--danger)", partial: "var(--gold)", paid: "var(--success)"
};

// ---------------- server rows ----------------

export interface Carrier {
  id: string; mode: Mode; unit_type: UnitType; display_name: string;
  operator_name: string | null; registration: string | null; vessel_id: string | null;
  make: string | null; model: string | null; year_manufactured: number | null;
  capacity_unit: CapacityUnit; capacity_max: string | null; specialisations: string[];
  home_base: string | null; is_active: boolean; notes: string | null;
  live_manifests?: number;
}

export interface Manifest {
  id: string; manifest_number: string; status: ManifestStatus; carrier_id: string;
  origin_region_id: number | null; origin_district_id: number | null;
  origin_ward_id: number | null; origin_text: string | null;
  dest_region_id: number | null; dest_district_id: number | null;
  dest_ward_id: number | null; dest_text: string | null;
  route_id: string | null; shipment_id: string | null;
  bill_of_lading: string | null; container_no: string | null; seal_no: string | null;
  container_type: string | null; departure_date: string | null; arrival_date: string | null;
  weight_on_board_kg: string; cbm_total: string; parcel_count: number; currency: string;
  transport_fee_total: string; amount_paid_total: string; balance_due: number;
  routing_notes: string | null;
  carrier_name: string; carrier_mode: Mode; unit_type: UnitType;
  capacity_unit: CapacityUnit; capacity_max: string | null; specialisations: string[];
  operator_name: string | null; registration: string | null;
  file_number?: string | null;
}

export interface Parcel {
  id: string; seq: number; tracking_number: string;
  consignor_name: string; consignor_phone: string | null; consignor_email: string | null;
  consignor_address: string | null; goods_description: string;
  package_count: number; package_kind: string | null; marks_numbers: string | null;
  net_weight_kg: string; length_m: string | null; width_m: string | null;
  height_m: string | null; cbm: string; specialisation: Specialisation | null;
  transport_fee: string; amount_paid: string; currency: string;
  payment_reference: string | null; paid_at: string | null; notes: string | null;
  payment_status: "unpaid" | "partial" | "paid"; balance_due: number;
}

export interface LegDetail extends Manifest {
  origin_label: string | null; destination_label: string | null;
  letterhead: Letterhead | null;
  route: { id: string; name: string; corridor: string | null; distance_km: string | null;
    expected_duration_hours: string | null } | null;
  carrier: Carrier;
  parcels: Parcel[];
  capacity: {
    unit: CapacityUnit; max: number | null; stated_in_mass: boolean;
    weight_on_board_kg: number; over_capacity: boolean; utilisation_pct: number | null;
  };
  settlement: {
    billed: number; collected: number; balance_due: number;
    parcels_paid: number; parcels_partial: number; parcels_unpaid: number;
  };
}

export interface Letterhead {
  company_name: string | null; tin_display: string | null; brela_number: string | null;
  vat_number: string | null; website: string | null; postal_address: string | null;
  street: string | null; branch_email: string | null; logo_document_id: string | null;
}

export interface Kpis {
  manifests: number; billed: number; collected: number; outstanding: number; in_transit: number;
}

export interface GeoEnd {
  regionId: string; districtId: string; wardId: string; text: string;
}

export const GEO_EMPTY: GeoEnd = { regionId: "", districtId: "", wardId: "", text: "" };

// ---------------- parcel drafts ----------------

/** The lines are edited as strings; numbers are parsed only at the boundary. */
export interface ParcelDraft {
  key: string;
  /** null until the row has been created — a new line is saved on its own, so
   * the manifest number and sequence come from the server, never from the page. */
  id: string | null;
  trackingNumber: string;
  consignorName: string;
  consignorPhone: string;
  /** What the row was loaded with, so a blank box means "keep it" and not "clear it". */
  storedPhone: string;
  consignorEmail: string;
  consignorAddress: string;
  goodsDescription: string;
  packageCount: string;
  packageKind: string;
  marksNumbers: string;
  netWeightKg: string;
  lengthM: string;
  widthM: string;
  heightM: string;
  specialisation: Specialisation | "";
  transportFee: string;
  amountPaid: string;
  paymentStatus: "unpaid" | "partial" | "paid";
  paymentReference: string;
  paidAt: string;
  notes: string;
}

let seed = 0;
const uid = () => `pc${++seed}-${Math.random().toString(36).slice(2, 7)}`;

export function newParcelDraft(patch: Partial<ParcelDraft> = {}): ParcelDraft {
  return {
    key: uid(), id: null, trackingNumber: "",
    consignorName: "", consignorPhone: "", storedPhone: "", consignorEmail: "",
    consignorAddress: "", goodsDescription: "", packageCount: "1", packageKind: "",
    marksNumbers: "", netWeightKg: "", lengthM: "", widthM: "", heightM: "",
    specialisation: "", transportFee: "", amountPaid: "0",
    paymentStatus: "unpaid", paymentReference: "", paidAt: "", notes: "",
    ...patch
  };
}

export function parcelFromRow(p: Parcel): ParcelDraft {
  const num = (v: string | null) => (v === null ? "" : String(Number(v)));
  return newParcelDraft({
    id: p.id, trackingNumber: p.tracking_number,
    consignorName: p.consignor_name, consignorPhone: p.consignor_phone ?? "",
    storedPhone: p.consignor_phone ?? "", consignorEmail: p.consignor_email ?? "",
    consignorAddress: p.consignor_address ?? "", goodsDescription: p.goods_description,
    packageCount: String(p.package_count), packageKind: p.package_kind ?? "",
    marksNumbers: p.marks_numbers ?? "", netWeightKg: num(p.net_weight_kg),
    lengthM: num(p.length_m), widthM: num(p.width_m), heightM: num(p.height_m),
    specialisation: p.specialisation ?? "", transportFee: num(p.transport_fee),
    amountPaid: num(p.amount_paid), paymentStatus: p.payment_status,
    paymentReference: p.payment_reference ?? "", paidAt: p.paid_at ?? "",
    notes: p.notes ?? ""
  });
}

/** The whole line is sent: it was loaded from the server, so what the clerk
 * left in the box is what the row should read. Only the phone keeps the
 * drivers-style presence rule below. */
export function parcelPayload(d: ParcelDraft) {
  const numOrNull = (v: string) => (v.trim() === "" ? null : Math.max(0, Number(v) || 0));
  const body: Record<string, any> = {
    consignorName: d.consignorName.trim(),
    goodsDescription: d.goodsDescription.trim(),
    packageCount: Math.max(1, Math.round(Number(d.packageCount) || 1)),
    netWeightKg: Math.max(0, Number(d.netWeightKg) || 0),
    transportFee: Math.max(0, Number(d.transportFee) || 0),
    consignorEmail: d.consignorEmail.trim() || null,
    consignorAddress: d.consignorAddress.trim() || null,
    packageKind: d.packageKind.trim() || null,
    marksNumbers: d.marksNumbers.trim() || null,
    notes: d.notes.trim() || null,
    lengthM: numOrNull(d.lengthM),
    widthM: numOrNull(d.widthM),
    heightM: numOrNull(d.heightM),
    specialisation: d.specialisation || null
  };
  // A blank phone means "keep the stored number" — the same contract the driver
  // records use, so nobody clears a consignor's line by editing the load.
  const phone = d.consignorPhone.trim();
  if (phone && phone !== d.storedPhone && /^\+[1-9]\d{7,14}$/.test(phone)) {
    body.consignorPhone = phone;
  }
  return body;
}

export function cbmOf(d: Pick<ParcelDraft, "lengthM" | "widthM" | "heightM">) {
  const l = Number(d.lengthM), w = Number(d.widthM), h = Number(d.heightM);
  if (!l || !w || !h) return 0;
  return Math.round(l * w * h * 1000) / 1000;
}

export function parcelBalance(d: ParcelDraft) {
  return money(Math.max(0, (Number(d.transportFee) || 0) - (Number(d.amountPaid) || 0)));
}

export function paymentStatusOf(d: ParcelDraft): ParcelDraft["paymentStatus"] {
  const fee = Number(d.transportFee) || 0;
  const paid = Number(d.amountPaid) || 0;
  if (fee > 0 && paid >= fee) return "paid";
  return paid > 0 ? "partial" : "unpaid";
}

// ---------------- formatting ----------------

export const money = (n: number) => Math.round(n * 100) / 100;
export const fmt = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Weights and volumes print to three places — a parcel is weighed, not rounded. */
export const qty = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { maximumFractionDigits: 3 });

export const num = (v: string | number | null | undefined) =>
  typeof v === "number" ? v : Number(v ?? 0) || 0;

export function capacityText(c: { capacity_unit: CapacityUnit; capacity_max: string | number | null }) {
  if (c.capacity_max === null || c.capacity_max === undefined || String(c.capacity_max) === "") return "capacity not stated";
  return `${qty(num(c.capacity_max))} ${CAPACITY_LABELS[c.capacity_unit]}`;
}

export function unitText(c: { mode: Mode; unit_type: UnitType }) {
  return `${UNIT_LABELS[c.unit_type] ?? c.unit_type} · ${MODE_SHORT[c.mode]}`;
}

export function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  // A detail can name the offending field without carrying its own sentence —
  // the message above already says it. Only the ones with text belong in the banner.
  const notes = Array.isArray(d)
    ? d.map((x: any) => x?.message).filter((m: any) => typeof m === "string" && m.trim())
    : [];
  return (json?.error?.message ?? fallback) + (notes.length ? ` (${notes.join("; ")})` : "");
}

/** "Kawe, Ilala, Dar es Salaam" built from the picks while the leg is unsaved. */
export function geoLabel(pick: GeoEnd, names: {
  region?: string; district?: string; ward?: string;
}): string | null {
  const parts = [names.ward, names.district, names.region, pick.text.trim() || null]
    .filter(Boolean) as string[];
  return parts.length ? parts.join(", ") : null;
}
