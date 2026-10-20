/**
 * The one reading of "confirm my day with my location" that both the route and its tests
 * share (task #182). Two rules it exists to enforce, neither of which is a route's business:
 *
 *   * A device reports a *place*, so the numbers that get stored are rounded to three
 *     decimals — about 100 m at this latitude. The office asked whether somebody was around
 *     work, not which chair they sat in, and a form field is trivially forged anyway; the
 *     honest value is the coarse one.
 *   * Multipart fields arrive as strings, so the same numbers arrive here in two shapes.
 *     Coercion lives in one place rather than in whichever route remembered it — a `null`
 *     silently becoming 0,0 is exactly the bug that would file a person at sea.
 */

/** 3 decimals ≈ 100 m: the precision a daily confirmation is worth. */
export const PROOF_COORD_PLACES = 3;
export const PROOF_MAX_ACCURACY_M = 20_000;

export type ProofInput = {
  proof?: unknown;
  lat?: unknown;
  lng?: unknown;
  accuracyM?: unknown;
};

export type ProofReason =
  | "proof" | "lat" | "lng" | "accuracyM"
  | "location-has-no-position" | "photo-has-coordinates";

export class ProofRejected extends Error {
  constructor(readonly reason: ProofReason) {
    super(reason);
  }
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

export function roundCoord(value: number): number {
  const f = 10 ** PROOF_COORD_PLACES;
  return Math.round(value * f) / f;
}

/**
 * Returns the values as they will be stored, or says which field refused and why. A photo
 * confirmation carries no numbers at all — its proof is the file, checked by the route.
 */
export function readProof(input: ProofInput): {
  kind: "location"; lat: number; lng: number; accuracyM: number | null;
} | { kind: "photo"; lat: null; lng: null; accuracyM: null } {
  const kind = typeof input.proof === "string" ? input.proof.trim().toLowerCase() : "";
  if (kind === "photo") {
    if (number(input.lat) !== null || number(input.lng) !== null || number(input.accuracyM) !== null) {
      throw new ProofRejected("photo-has-coordinates");
    }
    return { kind, lat: null, lng: null, accuracyM: null };
  }
  if (kind !== "location") throw new ProofRejected("proof");

  const lat = number(input.lat);
  const lng = number(input.lng);
  if (lat === null) throw new ProofRejected("lat");
  if (lng === null) throw new ProofRejected("lng");
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    // One field cannot be blamed for a pair that is off the planet together.
    throw new ProofRejected(lng < -180 || lng > 180 ? "lng" : "lat");
  }
  const rLat = roundCoord(lat);
  const rLng = roundCoord(lng);
  // 0,0 is the middle of the Atlantic. A phone that answers with it did not find the person,
  // and "I was at null island" is not a day's evidence — it is a broken reader.
  if (rLat === 0 && rLng === 0) throw new ProofRejected("location-has-no-position");

  const rawAccuracy = number(input.accuracyM);
  if (rawAccuracy !== null && (rawAccuracy < 0 || rawAccuracy > PROOF_MAX_ACCURACY_M)) {
    throw new ProofRejected("accuracyM");
  }
  return {
    kind, lat: rLat, lng: rLng,
    accuracyM: rawAccuracy === null ? null : Math.round(rawAccuracy)
  };
}
