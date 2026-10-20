import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";

const { readProof, roundCoord, ProofRejected, PROOF_MAX_ACCURACY_M } =
  await import("../src/util/geo-proof.js");

function refuse(input: Parameters<typeof readProof>[0]): string {
  try {
    readProof(input);
  } catch (e) {
    if (e instanceof ProofRejected) return e.reason;
    throw e;
  }
  throw new Error("readProof accepted it");
}

describe("roundCoord", () => {
  it("keeps three decimals, about 100 m", () => {
    expect(roundCoord(-6.7923815)).toBe(-6.792);
    expect(roundCoord(39.2083913)).toBe(39.208);
    expect(roundCoord(0.0004)).toBe(0);
    expect(roundCoord(0.0006)).toBe(0.001);
  });
});

describe("readProof — a location", () => {
  it("stores the coarse numbers a device reports", () => {
    expect(readProof({ proof: "location", lat: "-6.7923815", lng: "39.2083913", accuracyM: "12.4" }))
      .toEqual({ kind: "location", lat: -6.792, lng: 39.208, accuracyM: 12 });
  });

  it("takes numbers as easily as the strings multipart hands over", () => {
    expect(readProof({ proof: "location", lat: -6.7923815, lng: 39.2083913 }))
      .toEqual({ kind: "location", lat: -6.792, lng: 39.208, accuracyM: null });
  });

  it("treats an absent accuracy as unknown, never as zero metres", () => {
    for (const absent of [undefined, null, ""]) {
      expect(readProof({ proof: "location", lat: "-6.792", lng: "39.208", accuracyM: absent }).accuracyM)
        .toBeNull();
    }
  });

  it("shrugs off the case and padding a hand-typed form brings", () => {
    expect(readProof({ proof: " LOCATION ", lat: "6.8", lng: "39.1" }).kind).toBe("location");
  });

  it("refuses a position that is off the planet", () => {
    expect(refuse({ proof: "location", lat: "91", lng: "39" })).toBe("lat");
    expect(refuse({ proof: "location", lat: "-91", lng: "39" })).toBe("lat");
    expect(refuse({ proof: "location", lat: "6.8", lng: "181" })).toBe("lng");
    expect(refuse({ proof: "location", lat: "6.8", lng: "-181" })).toBe("lng");
  });

  it("refuses a reading that is not a reading", () => {
    expect(refuse({ proof: "location", lat: "not a number", lng: "39" })).toBe("lat");
    expect(refuse({ proof: "location", lat: "6.8", lng: "" })).toBe("lng");
    expect(refuse({ proof: "location", lat: "Infinity", lng: "39" })).toBe("lat");
  });

  it("refuses the middle of the Atlantic: a phone answering 0,0 found nobody", () => {
    expect(refuse({ proof: "location", lat: "0", lng: "0" })).toBe("location-has-no-position");
    expect(refuse({ proof: "location", lat: "0.0001", lng: "-0.0001" })).toBe("location-has-no-position");
    // A real ward on the equator or the prime meridian is still a position.
    expect(readProof({ proof: "location", lat: "0", lng: "39.2" }).lat).toBe(0);
  });

  it("refuses an accuracy beyond what a phone ever claims", () => {
    expect(readProof({ proof: "location", lat: "6.8", lng: "39.2", accuracyM: 0 }).accuracyM).toBe(0);
    expect(readProof({ proof: "location", lat: "6.8", lng: "39.2", accuracyM: PROOF_MAX_ACCURACY_M }).accuracyM)
      .toBe(PROOF_MAX_ACCURACY_M);
    expect(refuse({ proof: "location", lat: "6.8", lng: "39.2", accuracyM: -1 })).toBe("accuracyM");
    expect(refuse({ proof: "location", lat: "6.8", lng: "39.2", accuracyM: PROOF_MAX_ACCURACY_M + 1 }))
      .toBe("accuracyM");
  });

  it("refuses a confirmation that named no proof at all", () => {
    expect(refuse({ lat: "6.8", lng: "39.2" })).toBe("proof");
    expect(refuse({ proof: "gps", lat: "6.8", lng: "39.2" })).toBe("proof");
    expect(refuse({ proof: "", lat: "6.8", lng: "39.2" })).toBe("proof");
  });
});

describe("readProof — a photograph", () => {
  it("carries no numbers: the file is the evidence", () => {
    expect(readProof({ proof: "photo" })).toEqual({ kind: "photo", lat: null, lng: null, accuracyM: null });
  });

  it("refuses a picture sent alongside a position", () => {
    expect(refuse({ proof: "photo", lat: "6.8" })).toBe("photo-has-coordinates");
    expect(refuse({ proof: "photo", lng: "39.2", accuracyM: "10" })).toBe("photo-has-coordinates");
    // An empty field a form still submits is not a coordinate.
    expect(readProof({ proof: "photo", lat: "", accuracyM: undefined }).kind).toBe("photo");
  });
});
