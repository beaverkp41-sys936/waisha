import type { PoolClient } from "pg";
import { ApiError } from "../util/errors.js";
import { bookOf } from "./books.js";

/**
 * The two code lists an office declares from, and the one door that hands them to a desk.
 *
 * 130 made both of them tables: the six EAC modes of transport, each naming the document it travels
 * on, and the customs procedure codes, each bound to the movement its own first digit names. The
 * form used to offer a free-text "declaration mode" and nothing else, so a CPC was typed by hand and
 * a movement had no code at all while its file number carried one.
 *
 * The prefixes below are the other half of that interlink, and 130's CHECK holds the same four pairs
 * in SQL. They are written here once, and every route that needs a prefix — the file number, the
 * refusal of a code from another movement, the door itself — reads this const instead of keeping a
 * third copy. A desk must never be shown a number that is not the one printed on the file.
 */
export const SHIPMENT_TYPES = [
  { value: "import", label: "Import", prefix: "4" },
  { value: "export", label: "Export", prefix: "1" },
  { value: "transhipment", label: "Transhipment", prefix: "7" },
  { value: "transit", label: "Transit", prefix: "8" }
] as const;

export type ShipmentType = (typeof SHIPMENT_TYPES)[number]["value"];

/** The digit a file number of this movement starts with. */
export const FILE_PREFIX: Record<string, string> = {};
for (const t of SHIPMENT_TYPES) FILE_PREFIX[t.value] = t.prefix;

/**
 * The five transport documents 111 lets a master sheet name, in the words a clerk reads.
 *
 * The sheet's own route held the only copy, so a desk that wanted to say "this file moves by air,
 * so its paper is an air waybill" had to spell the words out again. One author here; the master
 * route imports it, and `/cargo/codes` hands the words to the form with each mode that names them.
 */
export const BILL_LABEL: Record<string, string> = {
  bill_of_lading: "Bill of lading", sea_waybill: "Sea waybill", air_waybill: "Air waybill",
  rail_waybill: "Rail waybill", road_waybill: "Road waybill"
};

/** Both lists, whole. They are platform reference data, so no tenant predicate is needed — and
 *  none would work: neither table has a tenant column to bind. */
const MODES_SQL = `
  select code, key, label, carrier_word, bill_kind, note
    from mode_of_transport order by sort`;

const PROCEDURES_SQL = `
  select code, label, shipment_type, note
    from customs_procedure_code order by sort`;

/**
 * A code that is not in the list, or is in it for a different movement, is answered here with the
 * name of the box — not by a database constraint reaching the desk as a 500.
 *
 * 130's trigger refuses the same write whatever this route believes, so the check is a second pair
 * of eyes and never the only one: `shipmentType` is the movement the row carries or will carry,
 * which for an edit is the stored one, since a file's movement is immutable.
 */
export async function assertCodesFit(
  c: PoolClient, shipmentType: string,
  modeCode: number | null | undefined, cpcCode: string | null | undefined
) {
  if (modeCode !== undefined && modeCode !== null) {
    const mode = await c.query(`select label from mode_of_transport where code = $1`, [modeCode]);
    if (!mode.rowCount) {
      throw new ApiError("VALIDATION_FAILED",
        `Mode of transport ${modeCode} is not one of the six the community publishes.`,
        400, [{ field: "modeCode" }]);
    }
  }
  if (cpcCode !== undefined && cpcCode !== null) {
    const proc = await c.query(
      `select label, shipment_type from customs_procedure_code where code = $1`, [cpcCode]);
    if (!proc.rowCount) {
      throw new ApiError("VALIDATION_FAILED",
        `CPC ${cpcCode} is not a procedure the office declares under.`, 400, [{ field: "cpcCode" }]);
    }
    const owns = proc.rows[0].shipment_type as string;
    if (owns !== shipmentType) {
      throw new ApiError("VALIDATION_FAILED",
        `CPC ${cpcCode} (${proc.rows[0].label}) is a procedure for ${owns}. This file's movement `
        + `is ${shipmentType} and its number begins ${FILE_PREFIX[shipmentType] ?? "?"}, so the `
        + "code does not belong on it.", 400, [{ field: "cpcCode" }]);
    }
  }
}

/**
 * The desk's one read: the four movements with their prefixes and books, the six modes, and every
 * procedure a file can declare under.
 *
 * Procedures are handed over whole and filtered on the desk, because the form changes the movement
 * in the same breath it opens the CPC block — a list refetched per keystroke would make the block
 * blink. The two lists together are twelve rows of statutory words.
 */
export async function readCodes(c: PoolClient) {
  const [modes, procedures] = await Promise.all([
    c.query(MODES_SQL),
    c.query(PROCEDURES_SQL)
  ]);
  return {
    types: SHIPMENT_TYPES.map(t => ({
      value: t.value, label: t.label, prefix: t.prefix, book: bookOf(t.value)
    })),
    // The document's words travel with the mode that names it, so a desk says "Bill of lading"
    // without keeping a sixth copy of 111's vocabulary.
    modes: modes.rows.map((m: any) => ({
      ...m, bill_label: m.bill_kind ? BILL_LABEL[m.bill_kind] ?? m.bill_kind : null
    })),
    procedures: procedures.rows
  };
}
