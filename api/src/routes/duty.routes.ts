import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "../security/jwt.js";
import { calculateDuty } from "../operations/duty-calculator.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

interface RateRow {
  id: string; kind: string; hs_code: string | null; category: string | null;
  label: string; basis: string; rate_type: string; rate_value: string;
}

/** The duty_rates version in force today; if none (rates lapsed awaiting the
 *  new Finance Act edition), fall back to the newest version flagged expired. */
async function activeVersion(): Promise<{
  version: string; effective_from: string; effective_to: string | null; expired: boolean;
}> {
  const current = await pool.query(
    `select version, max(effective_from)::text as effective_from, max(effective_to)::text as effective_to
     from duty_rates
     where is_active and effective_from <= current_date
       and (effective_to is null or effective_to >= current_date)
     group by version
     order by max(effective_from) desc
     limit 1`);
  if (current.rowCount) return { ...current.rows[0], expired: false };
  const fallback = await pool.query(
    `select version, max(effective_from)::text as effective_from, max(effective_to)::text as effective_to
     from duty_rates
     where is_active
     group by version
     order by max(effective_from) desc
     limit 1`);
  if (!fallback.rowCount) throw new ApiError("NOT_FOUND", "No duty rate version has been published.", 404);
  return { ...fallback.rows[0], expired: true };
}

async function ratesForVersion(version: string): Promise<RateRow[]> {
  const r = await pool.query(
    `select id, kind, hs_code, category, label, basis, rate_type, rate_value::text
     from duty_rates where version = $1 and is_active`, [version]);
  return r.rows;
}

export async function dutyRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Rates for the calculator ----------
  app.get("/duty/rates", { preHandler: [requireAuth] }, async () => {
    const v = await activeVersion();
    const rows = await ratesForVersion(v.version);

    const core = (label: string) => rows.find(r => r.kind === "vat" && r.label.startsWith(label));
    return {
      version: v.version,
      effectiveFrom: v.effective_from,
      effectiveTo: v.effective_to,
      expired: v.expired,
      bands: rows.filter(r => r.kind === "import_band"),
      idl: rows.filter(r => r.kind === "idl"),
      excise: rows.filter(r => r.kind === "excise"),
      core: {
        vatRate: Number(core("VAT — taxable imports")?.rate_value ?? 18),
        whVatGoods: Number(rows.find(r => r.label.includes("Withholding VAT — goods"))?.rate_value ?? 3),
        whVatServices: Number(rows.find(r => r.label.includes("Withholding VAT — services"))?.rate_value ?? 6),
        railwayLevyRate: Number(rows.find(r => r.label.includes("Railway"))?.rate_value ?? 2),
        customsProcessingRate: Number(rows.find(r => r.label.includes("Customs Processing"))?.rate_value ?? 0.6)
      }
    };
  });

  // ---------- HS / label search within the active version ----------
  app.get("/duty/hs", { preHandler: [requireAuth] }, async (req: any) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(40) }).parse(req.query);
    const v = await activeVersion();
    const r = await pool.query(
      `select id, kind, hs_code, label, basis, rate_type, rate_value::text
       from duty_rates
       where version = $1 and is_active and (kind = 'idl' or kind = 'excise')
         and (hs_code ilike $2 or label ilike $2)
       order by hs_code nulls last, label
       limit 20`,
      [v.version, `%${q}%`]);
    return r.rows;
  });

  // ---------- Tariff multi-filter search (duties, VAT, levies, fees) ----------
  app.get("/duty/tariff", { preHandler: [requireAuth] }, async (req: any) => {
    const q = z.object({
      kinds: z.string().trim().max(120).optional(),   // csv of kinds: vat,levy,fee,import_band,idl,excise
      query: z.string().trim().max(60).optional(),     // label / hs_code text
      minRate: z.coerce.number().min(0).max(1_000_000).optional(),
      maxRate: z.coerce.number().min(0).max(1_000_000).optional()
    }).parse(req.query);

    const v = await activeVersion();
    const kinds = q.kinds ? q.kinds.split(",").map(k => k.trim()).filter(Boolean) : [];
    const text = q.query ? `%${q.query}%` : null;

    const r = await pool.query(
      `select id, kind, hs_code, category, label, basis, rate_type, rate_value::text
       from duty_rates
       where version = $1 and is_active
         and ($2::text[] is null or kind = any($2::text[]))
         and ($3::text is null or label ilike $3 or hs_code ilike $3)
         and rate_value >= $4 and rate_value <= $5
       order by
         case kind when 'vat' then 1 when 'levy' then 2 when 'fee' then 3
                   when 'import_band' then 4 when 'idl' then 5 else 6 end,
         hs_code nulls last, label
       limit 100`,
      [v.version,
       kinds.length ? kinds : null,
       text,
       q.minRate ?? 0,
       q.maxRate ?? 1_000_000]);
    return { version: v.version, expired: v.expired, rows: r.rows };
  });

  // ---------- Calculate ----------
  app.post("/duty/calculate", { preHandler: [requireAuth] }, async (req: any) => {
    const body = z.object({
      fob: z.number().nonnegative(),
      freight: z.number().nonnegative().default(0),
      insurance: z.number().nonnegative().default(0),
      currency: z.string().trim().min(3).max(8).default("USD"),
      exchangeRate: z.number().positive(),
      rateId: z.string().uuid(),          // import_band or idl row
      exciseId: z.string().uuid().nullable().optional(),
      exciseUnits: z.number().nonnegative().nullable().optional()
    }).parse(req.body);

    const v = await activeVersion();
    const rows = await ratesForVersion(v.version);

    const rateRow = rows.find(r => r.id === body.rateId);
    if (!rateRow || !["import_band", "idl"].includes(rateRow.kind)) {
      throw new ApiError("VALIDATION_FAILED", "Pick a valid import duty band or HS rate.", 400);
    }
    const exciseRow = body.exciseId ? rows.find(r => r.id === body.exciseId) : null;
    if (body.exciseId && !exciseRow) {
      throw new ApiError("VALIDATION_FAILED", "Unknown excise item.", 400);
    }

    const breakdown = calculateDuty(
      { fob: body.fob, freight: body.freight, insurance: body.insurance, exchangeRate: body.exchangeRate },
      {
        vatRate: Number(rows.find(r => r.kind === "vat" && r.label.startsWith("VAT — taxable imports"))?.rate_value ?? 18),
        railwayLevyRate: Number(rows.find(r => r.label.includes("Railway"))?.rate_value ?? 2),
        customsProcessingRate: Number(rows.find(r => r.label.includes("Customs Processing"))?.rate_value ?? 0.6),
        importDutyRate: Number(rateRow.rate_value),
        excise: exciseRow ? {
          basis: exciseRow.basis as "duty_paid_value" | "per_unit",
          rate: Number(exciseRow.rate_value)
        } : null,
        exciseUnits: body.exciseUnits ?? undefined
      }
    );

    return {
      version: v.version,
      expired: v.expired,
      currency: body.currency,
      exchangeRate: body.exchangeRate,
      importDutyLabel: rateRow.label,
      exciseLabel: exciseRow?.label ?? null,
      ...breakdown
    };
  });
}
