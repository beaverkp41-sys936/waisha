import { describe, expect, it } from "vitest";
import { disclosureWarnings, type PreviewFields } from "../src/util/transport.js";

const base: PreviewFields = {
  cargoLabel: "Steel coils", containerType: "20ft", containerCount: 2, weightTonnes: 24,
  cbm: 30, vehicleTypes: ["truck_head"], routeId: null, routeLabel: null, distanceKm: 610,
  expectedDurationHours: 14, pickupText: "ICD Tema", pickupRegionId: null, destText: "Arusha",
  destRegionId: null, viaLabel: null, requiredDate: "2026-10-20", contactUserId: null,
  contactName: "Amani Salum", contactChannel: "amani@waisha.example", publicNote: null
};
const CLIENTS = ["Kilimanjaro Steel Ltd", "Beijing Metals Ltd"];

describe("disclosureWarnings", () => {
  it("passes clean operational text", () => {
    expect(disclosureWarnings(base, CLIENTS)).toEqual([]);
  });

  it("flags public text that names the consignee", () => {
    const w = disclosureWarnings(
      { ...base, publicNote: "Deliver to Kilimanjaro Steel warehouse, gate 4" }, CLIENTS);
    expect(w.some((x) => x.includes("Kilimanjaro Steel"))).toBe(true);
  });

  it("does not accuse on one shared generic word", () => {
    // "Kilimanjaro" is a region every transporter knows; a single token is too weak.
    expect(disclosureWarnings({ ...base, destText: "Kilimanjaro" }, CLIENTS)).toEqual([]);
  });

  it("does not accuse on one shared generic word", () => {
    // "Kilimanjaro" is a region every transporter knows; a single token is too weak.
    expect(disclosureWarnings({ ...base, destText: "Kilimanjaro" }, CLIENTS)).toEqual([]);
  });

  it("does not accuse when the name tokens are scattered across the advert", () => {
    // Both words of "Kilimanjaro Steel" appear, but nowhere as a name.
    expect(disclosureWarnings(
      { ...base, cargoLabel: "Steel bars", pickupText: "Dar port", destText: "Kilimanjaro" },
      CLIENTS)).toEqual([]);
  });

  it("catches a client name split by a legal suffix in the typed text", () => {
    const w = disclosureWarnings({ ...base, destText: "Kilimanjaro Steel Limited depot" }, CLIENTS);
    expect(w.some((x) => x.includes("Kilimanjaro Steel"))).toBe(true);
  });

  it("flags the contact line when it is the client", () => {
    const w = disclosureWarnings({ ...base, contactName: "Kilimanjaro Steel Agency" }, CLIENTS);
    expect(w.length).toBe(1);
  });

  it("flags container numbers and TINs pasted into public text", () => {
    expect(disclosureWarnings({ ...base, cargoLabel: "Container MSKU1234567" }, [])).toHaveLength(1);
    expect(disclosureWarnings({ ...base, publicNote: "TIN 123-456-789" }, [])).toHaveLength(1);
  });
});
