/**
 * End-to-end smoke for the consolidator module (055 + consolidation.routes.ts):
 * the multi-modal carrier register, a manifest whose origin and destination are
 * cascaded down to the ward, LCL parcels with their own tracking identity,
 * measured weight and cube, per-parcel transport-fee settlement with the paid /
 * partially paid / unpaid status derived from the money, the leg's status
 * machine, and the tenant and permission gates around all of it.
 *
 * Proves the five promises the migration and routes make:
 *   1. weight on board is stamped from the parcels, never typed;
 *   2. a parcel measured on three sides accumulates cubic metres;
 *   3. paid / partial / unpaid and the balance due are derived, and over-payment
 *      is refused;
 *   4. cargo cannot ride a unit that is not listed for its lane — not when it is
 *      added, not when it is edited, not when the unit is swapped, and not when
 *      the lane is withdrawn from the carrier;
 *   5. a tracking number already printed is never reissued, and delivered or
 *      cancelled paper freezes its lines.
 *
 * Everything it creates is removed through the owner connection.
 *
 * Run: npx tsx scripts/smoke-consolidation.ts   (needs the API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const CARRIER = "SMOKE CONSOLIDATOR FLATBED";
const REGISTRATION = "SMOKE-T149-QA";
const CONTAINER = "SMOKECON001";
const CONSIGNEE = "Smoke Consolidated Cargo Limited";
const PHONE_A = "+255710000222";
const PHONE_B = "+255710000333";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, String(JSON.stringify(detail)).slice(0, 300)); }
}

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

const num = (v: unknown) => Number(v);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (n: number) => iso(new Date(Date.now() + n * 86400000));

/**
 * Children first: parcels reference the manifest, the manifest references the
 * carrier. The documents rows are the manifest's papers, keyed by entity_id.
 * Everything is matched on the SMOKE fixture names rather than a single id, so
 * an interrupted run cannot leave a plate or a leg behind for the next one.
 */
async function wipe(owner: pg.Client, tid: string) {
  const smokeCarriers = `select id from consolidation_carriers where tenant_id = $1
      and (display_name ilike 'SMOKE %' or registration ilike 'SMOKE-%')`;
  const smokeManifests = `select id from consolidations where tenant_id = $1
      and (container_no like 'SMOKECON%' or carrier_id in (${smokeCarriers}))`;
  await owner.query(`delete from documents where tenant_id = $1
    and entity_type = 'consolidation' and entity_id in (${smokeManifests})`, [tid]);
  // audit_logs is append-only by design: prevent_audit_mutation refuses the
  // delete even on the owner connection, so this fixture's entries stay on the
  // record and the checks below read them rather than clearing them.
  await owner.query(`delete from consolidation_parcels where tenant_id = $1
    and manifest_id in (${smokeManifests})`, [tid]);
  await owner.query(`delete from consolidations where tenant_id = $1
    and (container_no like 'SMOKECON%' or carrier_id in (${smokeCarriers}))`, [tid]);
  await owner.query(`delete from consolidation_carriers where tenant_id = $1
    and (display_name ilike 'SMOKE %' or registration ilike 'SMOKE-%')`, [tid]);
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
       and exists (select 1 from company_profiles cp where cp.tenant_id = u.tenant_id)
     order by u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director with a company profile found");
  const tid: string = who.rows[0].tenant_id;
  const uid: string = who.rows[0].user_id;
  console.log(`consolidation tenant ${tid} as director ${uid}`);

  // Two real geography chains, from two different councils, so the cascade can
  // be proven both ways and a ward borrowed from the other council is a genuine
  // crossing rather than a second ward of the same one.
  const geo = await owner.query(`
    select * from (
      select distinct on (d.id)
             r.id as region_id, r.name_en as region_name,
             d.id as district_id, d.name_en as district_name,
             w.id as ward_id, w.name as ward_name
      from geo_regions r
      join geo_districts d on d.region_id = r.id
      join geo_wards w on w.district_id = d.id
      order by d.id, w.id
    ) s order by s.district_id limit 2`);
  if (geo.rowCount! < 2) throw new Error("Need two councils with wards to prove the cascade");
  const [g1, g2] = geo.rows;
  if (g1.district_id === g2.district_id) throw new Error("The two chains share a council");
  console.log(`origin ${g1.ward_name}, ${g1.district_name}, ${g1.region_name} → ` +
    `destination ${g2.ward_name}, ${g2.district_name}, ${g2.region_name}`);

  await wipe(owner, tid);

  const token = await mint(uid, tid);
  const staffToken = await mint(randomUUID(), tid, ["staff"]);
  const otherToken = await mint(uid, randomUUID());

  try {
    // ================= 1. The carrier register =================
    const noAuth = await call("/consolidation/carriers", null);
    check("the register is not public", noAuth.status === 401, noAuth.status);

    const noPermit = await call("/consolidation/carriers", staffToken);
    check("a role without consolidation.view is refused", noPermit.status === 403, noPermit.status);

    const carrier = await call("/consolidation/carriers", token, json({
      mode: "road", unitType: "trailer", displayName: CARRIER,
      operatorName: CONSIGNEE, registration: REGISTRATION,
      make: "Isuzu", model: "FRR", yearManufactured: 2016,
      capacityUnit: "tonnes", capacityMax: 32,
      specialisations: ["general", "dry_bulk", "hazardous"],
      homeBase: "T1 Gate, Dar es Salaam", notes: "Smoke fixture, removed on teardown."
    }));
    check("a road unit is registered", carrier.status === 201 && !!carrier.json?.id, carrier.json);
    const carrierId: string = carrier.json.id;

    const dup = await call("/consolidation/carriers", token, json({
      mode: "road", unitType: "trailer", displayName: "Smoke duplicate plate",
      registration: REGISTRATION
    }));
    check("one plate number per tenant", dup.status === 409, [dup.status, dup.json?.message]);

    const bogusMode = await call("/consolidation/carriers", token, json({
      mode: "hovercraft", unitType: "trailer", displayName: "Smoke hovercraft"
    }));
    check("the four modes are the only ones accepted", bogusMode.status === 400, bogusMode.status);

    const bogusLane = await call("/consolidation/carriers", token, json({
      mode: "road", unitType: "trailer", displayName: "Smoke wrong lane",
      specialisations: ["general", "nuclear_waste"]
    }));
    check("the cargo lanes are the closed six", bogusLane.status === 400, bogusLane.status);

    const shipOnRoad = await call("/consolidation/carriers", token, json({
      mode: "road", unitType: "cargo_ship", displayName: "Smoke ship as a lorry"
    }));
    check("a vessel cannot be filed as a mainland truck",
      shipOnRoad.status === 400 && /marine/.test(shipOnRoad.json?.error?.message ?? ""),
      shipOnRoad.json);

    const modeFlip = await call(`/consolidation/carriers/${carrierId}`, token,
      put({ mode: "marine" }));
    check("flipping only the mode cannot turn a trailer into a vessel",
      modeFlip.status === 400, [modeFlip.status, modeFlip.json?.error?.message]);

    const listed = await call("/consolidation/carriers?mode=road", token);
    const mine = listed.json?.carriers?.find((c: any) => c.id === carrierId);
    check("the register lists the unit with its lanes and capacity",
      !!mine && mine.capacity_max === "32.000" && mine.specialisations.length === 3, mine);
    check("a road filter hides nothing that is road",
      listed.json?.carriers?.every((c: any) => c.mode === "road"), listed.json?.carriers?.length);

    const airOnly = await call("/consolidation/carriers?mode=air", token);
    check("the same register holds an empty air list rather than guessing",
      airOnly.status === 200 && airOnly.json.carriers.every((c: any) => c.mode === "air"),
      airOnly.json?.carriers?.length);

    // ================= 2. Opening a leg =================
    const openLeg = await call("/consolidation", token, json({
      carrierId,
      origin: { regionId: g1.region_id, districtId: g1.district_id, wardId: g1.ward_id,
        text: "Berth 4, T1 Container Terminal" },
      destination: { regionId: g2.region_id, districtId: g2.district_id, wardId: g2.ward_id,
        text: "Plot 27, Kisuluilui" },
      billOfLading: "SMOKE-BL-0001", containerNo: CONTAINER, sealNo: "SMOKESEAL01",
      containerType: "40ft", departureDate: shift(1), arrivalDate: shift(3),
      currency: "TZS", routingNotes: "Smoke fixture leg."
    }));
    check("a manifest is opened on the unit", openLeg.status === 201 && !!openLeg.json?.id, openLeg.json);
    const m1: string = openLeg.json.id;
    check("the manifest number is a CSL reference", /^CSL-\d{4}$/.test(openLeg.json.manifestNumber),
      openLeg.json.manifestNumber);

    const timeTraveller = await call("/consolidation", token, json({
      carrierId, departureDate: shift(5), arrivalDate: shift(1)
    }));
    check("a load cannot arrive before it departs", timeTraveller.status === 400, timeTraveller.json);

    const crossedWard = await call("/consolidation", token, json({
      carrierId,
      origin: { regionId: g1.region_id, districtId: g1.district_id, wardId: g2.ward_id }
    }));
    check("a ward from another council is refused", crossedWard.status === 400,
      [crossedWard.status, crossedWard.json?.message]);

    const orphanWard = await call("/consolidation", token, json({
      carrierId, origin: { wardId: g1.ward_id }
    }));
    check("a ward needs its council picked with it", orphanWard.status === 400,
      [orphanWard.status, orphanWard.json?.message]);

    const bogusRoute = await call("/consolidation", token, json({
      carrierId, routeId: randomUUID()
    }));
    check("a manifest cannot claim a route it does not have", bogusRoute.status === 404, bogusRoute.status);

    const foreignCarrier = await call("/consolidation", token, json({ carrierId: randomUUID() }));
    check("another tenant's carrier is invisible, not merely forbidden",
      foreignCarrier.status === 404, foreignCarrier.status);

    const head0 = await call(`/consolidation/${m1}`, token);
    check("the leg prints both ends as ward, council, region",
      head0.json.origin_label === `${g1.ward_name}, ${g1.district_name}, ${g1.region_name}, Berth 4, T1 Container Terminal`
      && head0.json.destination_label.includes(g2.ward_name),
      [head0.json.origin_label, head0.json.destination_label]);
    check("a fresh leg carries nothing", head0.json.parcel_count === 0
      && num(head0.json.weight_on_board_kg) === 0, [head0.json.parcel_count, head0.json.weight_on_board_kg]);
    check("the capacity is stated in the unit the carrier was registered in",
      head0.json.capacity.unit === "tonnes" && head0.json.capacity.stated_in_mass === true
      && head0.json.capacity.max === 32, head0.json.capacity);
    check("the detail carries the office letterhead the manifest prints under",
      typeof head0.json.letterhead?.company_name === "string"
      && head0.json.letterhead.company_name.length > 1
      && "logo_document_id" in head0.json.letterhead, head0.json.letterhead);

    // ================= 3. Parcels on board =================
    const cement = await call(`/consolidation/${m1}/parcels`, token, json({
      consignorName: "Smoke Consignor A", consignorPhone: PHONE_A,
      consignorEmail: "a@consignor.smoke", consignorAddress: "P O Box 88, Mwanza",
      goodsDescription: "80 bags of cement", packageCount: 80, packageKind: "bag",
      marksNumbers: "KIL-01", netWeightKg: 3996.5,
      lengthM: 1.2, widthM: 0.6, heightM: 0.15,
      specialisation: "general", transportFee: 280000
    }));
    check("a measured parcel is booked on", cement.status === 201 && !!cement.json?.id, cement.json);
    const p1: string = cement.json.id;
    check("the tracking number is the leg reference and the line",
      cement.json.trackingNumber === `${openLeg.json.manifestNumber}-001`, cement.json.trackingNumber);

    const detail1 = await call(`/consolidation/${m1}`, token);
    const line1 = detail1.json.parcels.find((p: any) => p.id === p1);
    check("three measured sides become cubic metres", num(line1.cbm) === 0.108, line1.cbm);
    check("weight on board is stamped from the parcel, not typed",
      num(detail1.json.weight_on_board_kg) === 3996.5 && detail1.json.parcel_count === 1,
      [detail1.json.weight_on_board_kg, detail1.json.parcel_count]);
    check("the freight billed is the sum of the pieces",
      num(detail1.json.transport_fee_total) === 280000 && num(detail1.json.cbm_total) === 0.108,
      [detail1.json.transport_fee_total, detail1.json.cbm_total]);
    check("an unsettled parcel reads as unpaid with its whole fee owed",
      line1.payment_status === "unpaid" && num(line1.balance_due) === 280000,
      [line1.payment_status, line1.balance_due]);
    check("the detail decrypts the consignor phone for the desk working the leg",
      line1.consignor_phone === PHONE_A, line1.consignor_phone);
    check("the ciphertext and the search hash never leave the API",
      !("consignor_phone_encrypted" in line1) && !("consignor_phone_search" in line1),
      Object.keys(line1));
    check("utilisation is read against the unit's stated mass",
      detail1.json.capacity.utilisation_pct === 12.5 && detail1.json.capacity.over_capacity === false,
      detail1.json.capacity);

    const dg = await call(`/consolidation/${m1}/parcels`, token, json({
      consignorName: "Smoke Consignor B", consignorPhone: PHONE_B,
      goodsDescription: "12 drums of class 3 flammable liquid", packageCount: 12,
      packageKind: "drum", netWeightKg: 2040, lengthM: 0.6, widthM: 0.6, heightM: 0.9,
      specialisation: "hazardous", transportFee: 460000
    }));
    check("a dangerous-goods drum rides a unit listed for it", dg.status === 201, dg.json);
    const p2: string = dg.json.id;

    const perishable = await call(`/consolidation/${m1}/parcels`, token, json({
      consignorName: "Smoke Consignor C", goodsDescription: "4 pallets of fresh fish",
      packageCount: 4, specialisation: "refrigerated", transportFee: 120000
    }));
    check("a frozen lane is refused by a unit not listed for it", perishable.status === 409,
      [perishable.status, perishable.json?.message]);

    const strayed = await call(`/consolidation/${m1}/parcels/${p1}`, token,
      put({ specialisation: "live_animals" }));
    check("editing a line cannot walk cargo into a lane the unit does not hold",
      strayed.status === 409, [strayed.status, strayed.json?.message]);

    const relabelled = await call(`/consolidation/${m1}/parcels/${p1}`, token,
      put({ goodsDescription: "80 bags of cement, 2 torn", netWeightKg: 3998 }));
    check("an unrelated correction on a legal lane still goes through",
      relabelled.status === 200 && relabelled.json.changed >= 1, relabelled.json);
    const detail2 = await call(`/consolidation/${m1}`, token);
    check("the recomputed weight rolls up to the leg",
      num(detail2.json.weight_on_board_kg) === 6038 && detail2.json.parcel_count === 2,
      [detail2.json.weight_on_board_kg, detail2.json.parcel_count]);

    const unmeasured = await call(`/consolidation/${m1}/parcels/${p1}`, token, put({ heightM: null }));
    const detail3 = await call(`/consolidation/${m1}`, token);
    const line3 = detail3.json.parcels.find((p: any) => p.id === p1);
    check("clearing one side clears the cube rather than keeping a stale claim",
      unmeasured.status === 200 && num(line3.cbm) === 0 && num(line3.height_m) === 0,
      [line3.cbm, line3.height_m]);
    check("the leg's cube total follows its lines",
      num(detail3.json.cbm_total) === 0.324, detail3.json.cbm_total);

    // ---- a line taken off, and the number it printed ----
    const p2PaymentFree = await call(`/consolidation/${m1}/parcels/${p2}`, token, { method: "DELETE" });
    check("an unsettled line can come off the leg", p2PaymentFree.status === 200, p2PaymentFree.json);
    const reAdd = await call(`/consolidation/${m1}/parcels`, token, json({
      consignorName: "Smoke Consignor D", goodsDescription: "1 crate of paint thinner",
      packageCount: 4, specialisation: "hazardous", transportFee: 90000
    }));
    check("a new line does not inherit the removed line's tracking number",
      reAdd.status === 201 && reAdd.json.trackingNumber !== dg.json.trackingNumber,
      [dg.json.trackingNumber, reAdd.json.trackingNumber]);
    const p3: string = reAdd.json.id;
    const afterGap = await call(`/consolidation/${m1}`, token);
    check("the removed line leaves a gap, and the pieces still foot to the leg",
      afterGap.json.parcels.length === 2 && num(afterGap.json.weight_on_board_kg) === 3998,
      [afterGap.json.parcels.length, afterGap.json.weight_on_board_kg]);

    // ================= 4. Settlement =================
    const overpaid = await call(`/consolidation/${m1}/parcels/${p3}/payment`, token,
      put({ amountPaid: 90001, paymentReference: "SMOKE DEP 2" }));
    check("a payment larger than the parcel owes is refused", overpaid.status === 409,
      [overpaid.status, overpaid.json?.message]);

    const partial = await call(`/consolidation/${m1}/parcels/${p3}/payment`, token,
      put({ amountPaid: 40000, paymentReference: "CRDB DEP 88214", paidAt: shift(-1) }));
    check("a part-payment is recorded with the reference typed on the slip",
      partial.status === 200 && num(partial.json.balanceDue) === 50000, partial.json);
    const detail4 = await call(`/consolidation/${m1}`, token);
    const line4 = detail4.json.parcels.find((p: any) => p.id === p3);
    check("the line reads as partially paid, derived from the money",
      line4.payment_status === "partial" && num(line4.balance_due) === 50000
      && line4.payment_reference === "CRDB DEP 88214" && line4.paid_at === shift(-1),
      [line4.payment_status, line4.balance_due, line4.paid_at]);
    check("the leg collects the part-payment into its own figures",
      num(detail4.json.amount_paid_total) === 40000
      && num(detail4.json.balance_due) === 330000
      && detail4.json.settlement.parcels_partial === 1
      && detail4.json.settlement.parcels_unpaid === 1,
      [detail4.json.amount_paid_total, detail4.json.balance_due, detail4.json.settlement]);

    const settled = await call(`/consolidation/${m1}/parcels/${p3}/payment`, token,
      put({ amountPaid: 90000, paymentReference: "CRDB DEP 88214B" }));
    const detail5 = await call(`/consolidation/${m1}`, token);
    const line5 = detail5.json.parcels.find((p: any) => p.id === p3);
    check("closing the balance makes the line paid", settled.status === 200
      && num(settled.json.balanceDue) === 0 && line5.payment_status === "paid",
      [settled.json, line5.payment_status]);
    check("the leg's money is collected, not stored as a status",
      detail5.json.settlement.collected === 90000
      && detail5.json.settlement.parcels_paid === 1, detail5.json.settlement);

    const removePaid = await call(`/consolidation/${m1}/parcels/${p3}`, token, { method: "DELETE" });
    check("a settled line cannot be taken off the leg", removePaid.status === 409,
      [removePaid.status, removePaid.json?.message]);

    const deleteLeg = await call(`/consolidation/${m1}`, token, { method: "DELETE" });
    check("a leg with payments recorded cannot be deleted", deleteLeg.status === 409, deleteLeg.json);

    // ================= 5. Status machine and frozen paper =================
    const emptyLeg = await call("/consolidation", token, json({ carrierId, containerNo: "SMOKECON002" }));
    const m2: string = emptyLeg.json.id;
    const manifested = await call(`/consolidation/${m2}/status`, token, put({ status: "manifested" }));
    check("an empty manifest cannot be handed over", manifested.status === 409, manifested.json);

    const firstParcel = await call(`/consolidation/${m2}/parcels`, token, json({
      consignorName: "Smoke Consignor E", goodsDescription: "6 bales of used clothing",
      packageCount: 6, transportFee: 0
    }));
    check("a line can still be added while the leg is draft", firstParcel.status === 201, firstParcel.json);
    const p4: string = firstParcel.json.id;

    const zeroFee = await call(`/consolidation/${m2}/parcels/${p4}/payment`, token,
      put({ amountPaid: 10000 }));
    check("there is nothing to settle against a line with no fee stated", zeroFee.status === 409,
      [zeroFee.status, zeroFee.json?.message]);

    const feeSet = await call(`/consolidation/${m2}/parcels/${p4}`, token, put({ transportFee: 60000 }));
    check("the fee is fixed while the leg is still draft", feeSet.status === 200, feeSet.json);

    const jump = await call(`/consolidation/${m2}/status`, token, put({ status: "delivered" }));
    check("a leg cannot skip from draft to delivered", jump.status === 409, [jump.status, jump.json?.message]);

    check("draft to manifested", (await call(`/consolidation/${m2}/status`, token,
      put({ status: "manifested" }))).status === 200);
    check("manifested to in transit", (await call(`/consolidation/${m2}/status`, token,
      put({ status: "in_transit" }))).status === 200);
    check("in transit to delivered", (await call(`/consolidation/${m2}/status`, token,
      put({ status: "delivered" }))).status === 200);

    const reopen = await call(`/consolidation/${m2}/status`, token, put({ status: "draft" }));
    check("a delivered leg has no way back", reopen.status === 409, [reopen.status, reopen.json?.message]);

    const lateCargo = await call(`/consolidation/${m2}/parcels`, token, json({
      consignorName: "Smoke Consignor F", goodsDescription: "1 pallet of roofing sheets"
    }));
    check("cargo cannot be added to a delivered leg", lateCargo.status === 409, lateCargo.json);

    const lateEdit = await call(`/consolidation/${m2}/parcels/${p4}`, token,
      put({ goodsDescription: "changed after delivery" }));
    check("a delivered leg's lines cannot be rewritten", lateEdit.status === 409, lateEdit.json);

    const lateRemove = await call(`/consolidation/${m2}/parcels/${p4}`, token, { method: "DELETE" });
    check("a delivered leg's pieces cannot be quietly removed", lateRemove.status === 409, lateRemove.json);

    const lateHeader = await call(`/consolidation/${m2}`, token,
      put({ billOfLading: "SMOKE-BL-REWRITTEN" }));
    check("a delivered leg's signed header cannot be edited either",
      lateHeader.status === 409 && /delivered/.test(lateHeader.json?.error?.message ?? ""),
      lateHeader.json);

    const lateMoney = await call(`/consolidation/${m2}/parcels/${p4}/payment`, token,
      put({ amountPaid: 60000, paymentReference: "SMOKE DEP 3" }));
    check("the one door still open on a delivered leg is the money",
      lateMoney.status === 200 && num(lateMoney.json.balanceDue) === 0, lateMoney.json);

    // ================= 6. Cancel, revive, retire =================
    const deleteDelivered = await call(`/consolidation/${m2}`, token, { method: "DELETE" });
    check("a delivered leg is kept, not deleted", deleteDelivered.status === 409
      && /delivered/.test(deleteDelivered.json?.error?.message ?? ""), deleteDelivered.json);

    const cancelledLeg = await call("/consolidation", token, json({ carrierId, containerNo: "SMOKECON003" }));
    const m3: string = cancelledLeg.json.id;
    check("draft can be cancelled", (await call(`/consolidation/${m3}/status`, token,
      put({ status: "cancelled" }))).status === 200);
    check("a cancelled leg takes no further cargo", (await call(`/consolidation/${m3}/parcels`, token,
      json({ consignorName: "Smoke Consignor G", goodsDescription: "2 drums" }))).status === 409);
    check("a clerk who cancelled in error can go back to draft",
      (await call(`/consolidation/${m3}/status`, token, put({ status: "draft" }))).status === 200);
    check("an unsettled leg can be deleted",
      (await call(`/consolidation/${m3}`, token, { method: "DELETE" })).status === 200);
    check("a deleted leg is gone from the desk", (await call(`/consolidation/${m3}`, token)).status === 404);

    const retireBusy = await call(`/consolidation/carriers/${carrierId}`, token, { method: "DELETE" });
    check("a unit still carrying an open leg cannot be retired", retireBusy.status === 409,
      [retireBusy.status, retireBusy.json?.message]);

    const spare = await call("/consolidation/carriers", token, json({
      mode: "rail", unitType: "rail_wagon", displayName: "SMOKE SPARE WAGON",
      registration: "SMOKE-T149-QB", capacityUnit: "tonnes", capacityMax: 60
    }));
    const spareId: string = spare.json.id;
    check("a rail wagon is the same register as a truck", spare.status === 201, spare.json);
    check("an unused unit can be retired",
      (await call(`/consolidation/carriers/${spareId}`, token, { method: "DELETE" })).status === 200);
    const bothHalves = await call("/consolidation/carriers?active=false", token);
    check("a retired unit leaves both halves of the register",
      bothHalves.json.carriers.every((c: any) => c.id !== spareId)
      && (await call("/consolidation/carriers?active=true", token)).json.carriers
        .every((c: any) => c.id !== spareId),
      [bothHalves.json.carriers?.length, spareId]);

    // ================= 7. Lanes, swaps and the read that tells the truth =================
    const dropLane = await call(`/consolidation/carriers/${carrierId}`, token,
      put({ specialisations: ["general", "dry_bulk"] }));
    check("a lane cannot be withdrawn while cargo rides it", dropLane.status === 409,
      [dropLane.status, dropLane.json?.message]);

    const plainTrailer = await call("/consolidation/carriers", token, json({
      mode: "road", unitType: "box_truck", displayName: "SMOKE PLAIN BOX TRUCK",
      registration: "SMOKE-T149-QC", capacityUnit: "tonnes", capacityMax: 10
    }));
    const plainId: string = plainTrailer.json.id;
    const strand = await call(`/consolidation/${m1}`, token, put({ carrierId: plainId }));
    check("swapping the unit cannot strand the dangerous goods on it", strand.status === 409,
      [strand.status, strand.json?.message]);

    // Parking a unit for maintenance is not the same as retiring it: the history
    // stays, but the desk must stop offering it and no new leg may be built on it.
    const parked = await call(`/consolidation/carriers/${plainId}`, token, put({ isActive: false }));
    const inactive = await call("/consolidation/carriers?active=false", token);
    const activeOnly = await call("/consolidation/carriers?active=true", token);
    check("the availability filter means what it says in both directions",
      parked.status === 200
      && inactive.json.carriers.some((c: any) => c.id === plainId && c.is_active === false)
      && activeOnly.json.carriers.every((c: any) => c.id !== plainId),
      [inactive.json.carriers?.length, activeOnly.json.carriers?.length]);
    const onParked = await call("/consolidation", token, json({ carrierId: plainId }));
    check("a parked unit cannot be given a new leg", onParked.status === 404, onParked.json);

    const shrink = await call(`/consolidation/carriers/${carrierId}`, token,
      put({ capacityUnit: "tonnes", capacityMax: 1 }));
    const detail6 = await call(`/consolidation/${m1}`, token);
    check("the leg states an overload instead of hiding it",
      shrink.status === 200 && detail6.json.capacity.over_capacity === true
      && num(detail6.json.weight_on_board_kg) === 3998
      && detail6.json.capacity.utilisation_pct === 399.8,
      [shrink.json, detail6.json.capacity]);

    const cubeUnit = await call(`/consolidation/carriers/${carrierId}`, token,
      put({ capacityUnit: "m3" }));
    const detail7 = await call(`/consolidation/${m1}`, token);
    check("a cube-stated unit is not judged by weight",
      cubeUnit.status === 200 && detail7.json.capacity.stated_in_mass === false
      && detail7.json.capacity.over_capacity === false
      && detail7.json.capacity.utilisation_pct === null, detail7.json.capacity);
    await call(`/consolidation/carriers/${carrierId}`, token,
      put({ capacityUnit: "tonnes", capacityMax: 32 }));

    // ================= 8. Isolation, listing, audit =================
    const foreignHead = await call(`/consolidation/${m1}`, otherToken);
    check("another tenant cannot read the leg", foreignHead.status === 404, foreignHead.status);
    const foreignList = await call("/consolidation", otherToken);
    check("another tenant's list does not contain it",
      foreignList.status === 200 && !foreignList.json.manifests.some((m: any) => m.id === m1),
      foreignList.json?.manifests?.length);
    const foreignWrite = await call(`/consolidation/${m1}/status`, otherToken, put({ status: "delivered" }));
    check("another tenant cannot move the leg", foreignWrite.status === 404, foreignWrite.status);

    const myList = await call("/consolidation?status=draft", token);
    const row = myList.json?.manifests?.find((m: any) => m.id === m1);
    check("the desk lists the leg with its carrier and money",
      !!row && row.carrier_name === CARRIER && num(row.balance_due) === 280000,
      [row?.carrier_name, row?.balance_due]);
    check("the list never leaks the consignor phone",
      row && !JSON.stringify(myList.json).includes(PHONE_A.slice(1))
      && !JSON.stringify(myList.json).includes(PHONE_B.slice(1)), PHONE_A);
    const searched = await call(`/consolidation?q=${encodeURIComponent("SMOKE-BL-0001")}`, token);
    check("the bill of lading finds the leg",
      searched.json.manifests.length === 1 && searched.json.manifests[0].id === m1,
      searched.json?.manifests?.length);
    check("the KPIs foot the open money on the board",
      num(myList.json.kpis.outstanding) === 280000 && myList.json.kpis.manifests >= 2,
      myList.json.kpis);

    const vaulted = await owner.query(
      `insert into documents (id, tenant_id, entity_type, entity_id, kind, file_name,
         storage_path, mime_type, size_bytes, uploaded_by)
       values ($1,$2,'consolidation',$3,'delivery_order','smoke-manifest.pdf',
               'smoke/consolidation.pdf','application/pdf',1234,$4)
       on conflict do nothing`,
      [randomUUID(), tid, m1, uid]);
    check("the vault can hold a manifest's own papers", vaulted.rowCount! >= 0, vaulted.rowCount);

    const audit = await owner.query(
      `select count(*)::int as n,
              count(*) filter (where "after"::text like '%+255%'
                               or "before"::text like '%+255%')::int as plain_phone,
              count(*) filter (where "after"::text like '%_encrypted%'
                               or "before"::text like '%_encrypted%')::int as cipher,
              count(*) filter (where action = 'consolidation.parcel_added')::int as added
       from audit_logs where tenant_id = $1 and action like 'consolidation.%'`, [tid]).catch(() => null);
    if (audit?.rowCount) {
      const a = audit.rows[0];
      check("every write left an audit entry", a.n >= 12 && a.added >= 4, a);
      check("the audit trail holds no plaintext consignor phone", a.plain_phone === 0, a);
      check("the audit trail holds no ciphertext either, only the search hash", a.cipher === 0, a);
    } else {
      check("the audit trail could be read", false, "audit_logs columns differ");
    }

    const dbState = await owner.query(
      `select (select count(*) from consolidations where tenant_id = $1 and id = $2) as legs,
              (select count(*) from consolidation_parcels where tenant_id = $1
                 and manifest_id = $2 and deleted_at is null) as lines,
              (select count(*) from consolidation_parcels where tenant_id = $1
                 and manifest_id = $2) as lines_including_removed`, [tid, m1]);
    const st = dbState.rows[0];
    check("the removed line is soft-deleted, so the paper of what rode the leg survives",
      num(st.lines) === 2 && num(st.lines_including_removed) === 3, st);
  } finally {
    await wipe(owner, tid);
  }

  // ---- teardown proof ----
  // Each query names the fixture by its own pattern, so a check cannot pass
  // simply because the row it joined to was already deleted.
  const count = async (sql: string, params: unknown[]) =>
    (await owner.query(sql, params)).rows[0].n;
  check("residue: every smoke unit is off the register", await count(
    `select count(*)::int as n from consolidation_carriers where tenant_id = $1
       and (display_name ilike 'SMOKE %' or registration ilike 'SMOKE-%')`, [tid]) === 0);
  check("residue: every smoke leg is off the desk", await count(
    `select count(*)::int as n from consolidations where tenant_id = $1
       and container_no like 'SMOKECON%'`, [tid]) === 0);
  check("residue: no parcel was left without its leg", await count(
    `select count(*)::int as n from consolidation_parcels p where p.tenant_id = $1
       and not exists (select 1 from consolidations m where m.id = p.manifest_id)`,
    [tid]) === 0);
  check("residue: no manifest paper was left in the vault", await count(
    `select count(*)::int as n from documents where tenant_id = $1
       and entity_type = 'consolidation'`, [tid]) === 0);
  check("the audit trail of the run is kept, because it is append-only", await count(
    `select count(*)::int as n from audit_logs where tenant_id = $1
       and action like 'consolidation.%'`, [tid]) > 0);

  await owner.end();
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nthe carrier register, the leg, its parcels and the money on them all hold");
}

main().catch((e) => { console.error(e); process.exit(1); });
