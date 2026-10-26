import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The charges that sit on top of a price (141; task #420) — the office's surcharges and its discount
 * codes, the places a code has given away, and the composer that answers what a whole job costs.
 *
 * Every door takes the book from `req.control.tenant_id` and from nowhere else. The API role is
 * BYPASSRLS, so the tenant bound into the first parameter is the only guard there is — the same
 * arrangement 133, 134, 135 and 140 run under.
 *
 * **This file writes no audit rows.** Each 141 door calls `platform_auth.money_audit(...)` inside its own
 * statement, so a charge opened, a figure typed, a paper raised and a place taken are recorded by the
 * same write that makes them. A route that audited on top would double every line in the register.
 *
 * **The second seat is not at this desk.** `POST /charges/:id/publish` raises the paper and prints the
 * figure it was cut on; it cannot make the charge live. `apply_pricing_addendum` is deliberately not a
 * route here — it is 121's effect `addendum_publish`, run in the register's own order (decide → claim →
 * apply → settle) by the seat that signed, in `api/src/control/approvals.ts`. A desk that could publish
 * from this file would be a desk that signs its own discount.
 *
 * **A charge refuses to invent arithmetic, and it refuses to be a second price list.** The two kinds are
 * rows in `pricing_addendum_kinds`, so nothing below names `surcharge` or `promo`: the board answers its
 * own kind chips and its own basis words, and a third charge added to 141's section 1 appears here
 * without this file being edited. `GET /job` is the register answering "what does this cost" — freight
 * from 140, every levy that stands on the job added in the register's own order, then the named codes
 * clipped to what is left. A figure this file manufactured would be exactly what the register exists to
 * prevent.
 *
 * **Taking a place is a clerk's act, not a quotation.** `GET /job` reports which codes are available and
 * refuses one that is spent; it never consumes a place, because a quote is not a booking. The place is
 * taken afterwards, deliberately, by `POST /charges/:id/claims`.
 */

const VIEW = "control.pricing.view";
/** Opening and editing a draft, putting a figure on it, cloning a version, stopping a charge, and taking
 *  or giving back a place on a code. 141's section 13 keeps the claim here rather than under a fourth
 *  duty: filling a line and handing out a discount are the same clerk's work. */
const MANAGE = "control.pricing.manage";
/** Putting a charge up for a second seat, and refusing a paper that is out. */
const PUBLISH = "control.pricing.publish";

const UUID = z.string().uuid();
const SENTENCE = z.string().trim().min(8).max(600);
const LABEL = z.string().trim().min(3).max(80);
/** A figure is `numeric(14,4)`: four decimals, because a per-kilometre levy rounded to two is a
 *  different charge on a 900 km corridor — 140's argument, inherited unchanged. */
const FIGURE = z.string().trim().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/,
  "A figure is whole units or up to four decimals, with no separators.");
/** A ceiling, a floor, a freight and a discount taken off are `numeric(14,2)` — figures a clerk says
 *  out loud, not quarters of a cent. */
const MONEY = z.string().trim().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/,
  "That is not a figure in whole units or two decimals.");
const QUANTITY = z.string().trim().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/,
  "That is not a quantity.");
const WHOLE = z.coerce.number().int().min(1).max(10000);
/** A code is typed however it is said; 141 upper-cases and underscores it, keeps its kind across
 *  versions and answers `bad_code` with its own rule. */
const CODE = z.string().trim().min(2).max(30);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The day is sent as the papers carry it.");
/** Kind, basis, class and container are not enums here: `bad_kind` and `bad_basis` are the register's
 *  sentences, and both name the words it actually knows — a `promo` says which bases it is worked out
 *  on, and that list is a column of `pricing_addendum_kinds`, not something 141's author would want to
 *  retype into a route. */
const WORD = z.string().trim().regex(/^[a-z0-9][a-z0-9_]{1,29}$/, "Name it as the register spells it.");
/** A read filter is a question, not a spelling. `pricing_addenda` and `pricing_addenda_in_force` both
 *  lower-case status, kind, class and container before they compare, and this file already upper-cases a
 *  code on the way in (`codeOf`), so `?kind=PROMO` asks the question the register answers. Refusing it
 *  here would be a rule the door does not hold. The lower-casing has to happen before the shape is
 *  checked: `WORD`'s pattern is the register's own spelling and would refuse `PROMO` on its way into a
 *  transform, so this word is trimmed and folded first, then held to the same pattern. */
const WORDI = z.string().trim().transform((v) => v.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_]{1,29}$/, "Name it as the register spells it."));
const LIMIT = z.coerce.number().int().min(1).max(200).default(30);
const OFFSET = z.coerce.number().int().min(0).max(20000).default(0);
const SEARCH = z.string().trim().min(1).max(140).optional();
/** Five codes is 141's own ceiling on one quote, and the door counts them. */
const CODES = z.string().trim().max(200);

/** Params: book, status|null, search|null, kind|null, code|null, limit, offset. */
const BOARD_SQL = "select platform_auth.pricing_addenda($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, charge. */
const DETAIL_SQL = "select platform_auth.pricing_addendum_detail($1,$2) as r";
/** Params: book, charge, limit, offset. */
const MEMORY_SQL = "select platform_auth.pricing_addendum_memory($1,$2,$3,$4) as r";
/** Params: book, day|null, kind|null, code|null, route|null, class|null, container|null. */
const IN_FORCE_SQL = "select platform_auth.pricing_addenda_in_force($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, day|null, code|null, route|null, class|null, container|null, basis|null,
 *  tonnes|null, teu|null, cbm|null, days|null, promo-codes|null. */
const JOB_SQL = `select platform_auth.price_a_job(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r`;

/** Params: book, kind, code, label, basis, value, cap|null, min|null, max_uses|null, currency,
 *  route|null, class|null, container|null, effective_from|null, note, actor, role, ip, ua. */
const OPEN_SQL = `select platform_auth.open_pricing_addendum(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) as r`;
/** Params: book, charge, label|null, basis|null, value|null, cap|null, min|null, max_uses|null,
 *  route|null, class|null, container|null, effective_from|null, note|null, clear, actor, role, ip, ua. */
const EDIT_SQL = `select platform_auth.edit_pricing_addendum(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) as r`;
/** Params: book, charge, reason, actor, role, ip, ua. */
const DISCARD_SQL = "select platform_auth.discard_pricing_addendum($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, charge, effective_from|null, note|null, actor, role, ip, ua. */
const CLONE_SQL = "select platform_auth.clone_pricing_addendum($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, charge, reason, actor, role, ip, ua. */
const PROPOSE_SQL = "select platform_auth.propose_pricing_addendum($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, charge, note, actor, role, ip, ua. */
const REFUSE_SQL = "select platform_auth.refuse_pricing_addendum($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, charge, effective_to, reason, actor, role, ip, ua. */
const WITHDRAW_SQL = "select platform_auth.withdraw_pricing_addendum($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, charge, subject kind, subject id, job ref|null, freight|null, taken|null, note|null,
 *  actor, role, ip, ua. */
const CLAIM_SQL = `select platform_auth.claim_pricing_addendum(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r`;
/** Params: book, claim, reason, actor, role, ip, ua. */
const VOID_SQL = "select platform_auth.void_pricing_addendum_claim($1,$2,$3,$4,$5,$6,$7) as r";

const tenantOf = (req: any) => String(req.control.tenant_id);
const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
const uaOf = (req: any) => String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null;
const seats = (req: any) => [req.control.user_id, role(req), req.ip, uaOf(req)];
/** The register stores a code the way it is said out loud; the desk may type it either way. */
const codeOf = (s?: string) => (s ? s.toUpperCase().replace(/ /g, "_") : null);

function uuidOf(value: unknown, what: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

/**
 * 141 answers in its own shape — `{ok:false, error:'<code>', message:'…'}` — and the sentence is the
 * useful half: `PRM-2026-00004 has given all 50 of its places away. The discount is spent, not hidden —
 * say so to the customer rather than trying twice` is the answer a clerk needs, and no paraphrase here
 * improves it. So the words pick the status code and the door's message goes out unchanged.
 *
 * `promo_unknown` is a 404 rather than a 400 because it is an honest statement about the book — this
 * register has never published that code — the same reasoning 140 uses for `no_price`. A code that is
 * live but lapsed, out of scope, or of the wrong sign is a conflict: the row exists and says something
 * different from what the request assumed.
 *
 * `no_price` is in the 404 list even though no 141 door answers it: `price_a_job` calls 140's resolver
 * first and hands back its refusal unchanged, and a quote asked of a scope nobody has priced must be a
 * 404 at both desks or the same missing figure reads as a typing error on one and as no price on the other.
 */
const NOT_FOUND = new Set(["not_found", "no_book", "approval_missing", "promo_unknown", "no_price"]);
const CONFLICT = new Set(["conflict", "already_open", "already_lived", "already_signed",
  "already_spent", "already_claimed", "already_voided", "nothing_open", "nothing_to_clone",
  "not_a_draft", "not_live", "paper_is_out", "paper_moved", "refused_the_signature_first",
  "places_taken", "kind_moved", "kind_is_not_counted", "empty_window", "rewriting_history",
  "back_dating", "no_start", "promo_lapsed", "promo_spent", "promo_wrong_scope", "promo_wrong_kind"]);

function definerRefusal(j: any, fallback: string): ApiError | null {
  if (!j || typeof j !== "object" || j.ok !== false) return null;
  const code = String(j.error ?? "");
  const words = typeof j.message === "string" ? j.message : fallback;
  const { ok, error, message, ...extra } = j;
  const details = Object.keys(extra).length ? [extra] : [];
  if (NOT_FOUND.has(code)) return new ApiError("NOT_FOUND", words, 404, details);
  if (code === "unauthorised" || code === "not_a_seat") {
    return new ApiError("FORBIDDEN", words, 403, details);
  }
  if (CONFLICT.has(code)) return new ApiError("CONFLICT", words, 409, details);
  return new ApiError("VALIDATION_FAILED", words, 400, details);
}

/**
 * What the tables answer before a door's jsonb is built: 141's seven guards raise with `141: ` on the
 * front of a sentence written for a clerk, and the one-live-place index answers 23505. The prefix comes
 * off and the sentence goes out — `a surcharge has no places to run out of` is the whole answer, and it
 * is a conflict, because the state that makes it untrue is a row the desk is staring at.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT",
      "That book already holds a charge with that number, that code and that version — or this account "
      + "already holds a live place on it.", 409);
  }
  if (!["23514", "23503", "P0001", "42501", "22007"].includes(code)) return null;
  if (code === "42501") {
    return new ApiError("FORBIDDEN", "This seat is not allowed to write in the charge register.", 403);
  }
  const words = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^141:\s*/, "").trim();
  if (!words) return new ApiError("CONFLICT", fallback, 409);
  if (/already|another|kept|cannot|not editable|no open |stays stopped|never had|once/i.test(words)) {
    return new ApiError("CONFLICT", words, 409);
  }
  return new ApiError("VALIDATION_FAILED", words, 400);
}

/** A shape-only date is how `2026-02-30` reaches Postgres and comes back as a 22007 nobody can read. */
function realDay(s: string, field: string): string {
  const back = new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10);
  if (back !== s) {
    throw new ApiError("VALIDATION_FAILED", `There is no day ${s} on a calendar.`, 400,
      [{ field, message: "The day has to exist, not just look like one." }]);
  }
  return s;
}

/** Every read and write here is one definer call: `guardRefusal` for what the tables answer,
 *  `definerRefusal` for the door's own answer. */
async function door<T extends Record<string, any>>(req: any, fallback: string,
  sql: string, params: unknown[]): Promise<T> {
  return withTenant(tenantOf(req), async (c) => {
    let out: T;
    try {
      out = (await c.query(sql, params as any[])).rows[0]?.r;
    } catch (e: any) {
      throw guardRefusal(e, fallback) ?? e;
    }
    const refusal = definerRefusal(out, fallback);
    if (refusal) throw refusal;
    return out;
  });
}

/** The half of a draft that is cleared rather than replaced: absent keeps the column, and a word in
 *  `clear` empties it. The register owns the list and answers `bad_clear` on a word it does not. */
const CLEARS = ["cap", "min_amount", "max_uses", "route", "vehicle_class", "container"];

export async function controlPricingAddendaRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================================================
  // the reads — the board, one charge, its places, what stands on a job, what a job costs
  // ============================================================

  /** Every chip on the desk's heading comes from the door, including `kinds` — the two words the
   *  register knows, with their prefix, their sign and their basis list. The desk builds its form from
   *  that rather than from a constant so 141's promise (a third kind needs no code change) survives. */
  app.get("/control/pricing/charges", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`charges-board:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: WORDI.optional(), kind: WORDI.optional(), code: CODE.optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).strict().parse(req.query);
    return door(req, "The charge board could not be read.", BOARD_SQL,
      [tenantOf(req), q.status ?? null, q.search ?? null, q.kind ?? null, codeOf(q.code),
        q.limit, q.offset]);
  });

  /** Which charges stand on one scope on one day, and how many places are left on each. This is the
   *  availability the composer reports without spending: a clerk asked "can this customer still use
   *  NEWYEAR" is answered from here. */
  app.get("/control/pricing/charges/in-force", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`charges-in-force:${req.control.user_id}`, 240, 60);
    const q = z.object({
      day: DAY.optional(), kind: WORDI.optional(), code: CODE.optional(),
      route: UUID.optional(), vehicle_class: WORDI.optional(), container: WORDI.optional()
    }).strict().parse(req.query);
    return door(req, "The charges in force could not be read.", IN_FORCE_SQL,
      [tenantOf(req), q.day ? realDay(q.day, "day") : null, q.kind ?? null, codeOf(q.code),
        q.route ?? null, q.vehicle_class ?? null, q.container ?? null]);
  });

  /** One charge whole: its figure, its scope, its version ladder, the paper out against it, its memory
   *  and the places taken on it. A draft is opened from this shape, so the desk reads back exactly what
   *  it wrote rather than what it typed. */
  app.get("/control/pricing/charges/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "charge");
    return door(req, "That charge could not be read.", DETAIL_SQL, [tenantOf(req), id]);
  });

  /** What the office signed, who took a place, and who voided it. A claim row is never deleted, so this
   *  is the only place a mistake on a promo can be seen after the ceiling moved. */
  app.get("/control/pricing/charges/:id/history", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "charge");
    const q = z.object({ limit: LIMIT, offset: OFFSET }).strict().parse(req.query);
    return door(req, "The charge memory could not be read.", MEMORY_SQL,
      [tenantOf(req), id, q.limit, q.offset]);
  });

  /**
   * The whole quote: 140's freight, the levies stacked on it, the named codes taken off, and the working
   * printed beside the total.
   *
   * It is a GET because it writes nothing. The register's arithmetic does the rest: a surcharge is capped
   * by its own ceiling, a code is clipped to what is payable so no quote can come back negative, and a
   * code written in another money than the card is refused rather than converted.
   */
  app.get("/control/pricing/job", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`pricing-job:${req.control.user_id}`, 240, 60);
    const q = z.object({
      day: DAY.optional(), code: CODE.optional(), route: UUID.optional(),
      vehicle_class: WORD.optional(), container: WORD.optional(), basis: WORD.optional(),
      tonnes: QUANTITY.optional(), teu: WHOLE.optional(), cbm: QUANTITY.optional(),
      days: WHOLE.optional(), promo_codes: CODES.optional()
    }).strict().parse(req.query);
    return door(req, "The job could not be priced.", JOB_SQL,
      [tenantOf(req), q.day ? realDay(q.day, "day") : null, codeOf(q.code),
        q.route ?? null, q.vehicle_class ?? null, q.container ?? null, q.basis ?? null,
        q.tonnes ?? null, q.teu ?? null, q.cbm ?? null, q.days ?? null,
        q.promo_codes?.trim() ? q.promo_codes.trim().toUpperCase() : null]);
  });

  // ============================================================
  // the drafts — a charge, its figure, its scope, its window
  // ============================================================

  /** Open a charge with its figure on it. Unlike a rate card, a charge is one number, so a draft with no
   *  number in it would be nothing for a second seat to read. */
  app.post("/control/pricing/charges", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-open:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      kind: WORD, code: CODE, label: LABEL, basis: WORD, value: FIGURE,
      cap: MONEY.optional(), min_amount: MONEY.optional(),
      max_uses: z.coerce.number().int().min(1).max(1000000).optional(),
      currency: z.enum(["TZS", "USD"]).default("TZS"),
      route: UUID.optional(), vehicle_class: WORD.optional(), container: WORD.optional(),
      effective_from: DAY.optional(), note: SENTENCE
    }).strict().parse(req.body);
    return door(req, "The charge could not be opened.", OPEN_SQL,
      [tenantOf(req), body.kind, body.code, body.label, body.basis, body.value,
        body.cap ?? null, body.min_amount ?? null, body.max_uses ?? null, body.currency,
        body.route ?? null, body.vehicle_class ?? null, body.container ?? null,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.note, ...seats(req)]);
  });

  /** Change a draft. Absent keys keep what the row holds and `clear` empties a column, because a draft
   *  whose ceiling can only be raised is a draft a clerk has to throw away to fix. The money cannot be
   *  swapped: a TZS levy relabelled USD is 138's defect one table away from the register that caught it,
   *  and the door refuses the field rather than editing it into silence. */
  app.patch("/control/pricing/charges/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-edit:${req.control.user_id}`, 120, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({
      label: LABEL.optional(), basis: WORD.optional(), value: FIGURE.optional(),
      cap: MONEY.optional(), min_amount: MONEY.optional(),
      max_uses: z.coerce.number().int().min(1).max(1000000).optional(),
      route: UUID.optional(), vehicle_class: WORD.optional(), container: WORD.optional(),
      effective_from: DAY.optional(), note: SENTENCE.optional(),
      clear: z.array(z.enum(CLEARS as [string, ...string[]])).max(CLEARS.length).optional()
    }).strict().superRefine((b, i) => {
      // An empty patch is not a no-op: the door audits every call that reaches it, so a body that asks
      // for nothing would fill the register with edits nobody made.
      if (Object.keys(b).length === 0) {
        i.addIssue({ code: z.ZodIssueCode.custom,
          message: "Say which part changes: label, basis, value, cap, min_amount, max_uses, route, "
            + "vehicle_class, container, effective_from, note or clear." });
      }
      for (const w of b.clear ?? []) {
        if (w === "cap" && b.cap !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "cap is either given a figure or cleared, not both." });
        }
        if (w === "min_amount" && b.min_amount !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "min_amount is either given a figure or cleared, not both." });
        }
        if (w === "max_uses" && b.max_uses !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "max_uses is either given a ceiling or cleared, not both." });
        }
        if (w === "route" && b.route !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "route is either named or cleared, not both." });
        }
      }
    }).parse(req.body);
    return door(req, "The charge could not be changed.", EDIT_SQL,
      [tenantOf(req), id, body.label ?? null, body.basis ?? null, body.value ?? null,
        body.cap ?? null, body.min_amount ?? null, body.max_uses ?? null,
        body.route ?? null, body.vehicle_class ?? null, body.container ?? null,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.note ?? null, (body.clear ?? []).join(","), ...seats(req)]);
  });

  /** Throw away a draft that was never signed. A charge that has been a live levy is not a draft, and the
   *  door keeps it: the figure a customer was quoted for stays in the book. */
  app.post("/control/pricing/charges/:id/discard", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-discard:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The draft could not be discarded.", DISCARD_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Raise a new version off one that is signed, published, superseded or stopped. This is how a live
   *  levy is changed: the figure that was quoted is never edited. */
  app.post("/control/pricing/charges/:id/clone", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-clone:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({
      effective_from: DAY.optional(), note: SENTENCE.optional()
    }).strict().parse(req.body);
    return door(req, "The version could not be cloned.", CLONE_SQL,
      [tenantOf(req), id,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.note ?? null, ...seats(req)]);
  });

  /** Stop a live charge from a day that is not in the past. One seat, no signature, and never earlier
   *  than today: it stops the levy being quoted tomorrow and does not un-charge a job already billed. */
  app.post("/control/pricing/charges/:id/withdraw", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-withdraw:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({ effective_to: DAY, reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The charge could not be stopped.", WITHDRAW_SQL,
      [tenantOf(req), id, realDay(body.effective_to, "effective_to"), body.reason, ...seats(req)]);
  });

  // ============================================================
  // the signature — raised here, spent on Approvals
  // ============================================================

  /**
   * Put a charge up for a second seat.
   *
   * The door reads the figure, the ceiling, the places and the dates out of the row and hashes them, so
   * what the register holds is the paper the other seat signs — and `pricing_addendum_detail` prints the
   * same hash, which is how a desk can prove the figure moved after the signature was asked for
   * (`paper_moved`). Nothing below publishes it.
   */
  app.post("/control/pricing/charges/:id/publish", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PUBLISH);
    await enforceRateLimit(`charge-publish:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The charge could not be put up for a signature.", PROPOSE_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Answer a paper with a no. It is the second seat's own duty, and it frees the draft to be edited. */
  app.post("/control/pricing/charges/:id/refuse", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PUBLISH);
    await enforceRateLimit(`charge-refuse:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body);
    return door(req, "The paper could not be refused.", REFUSE_SQL,
      [tenantOf(req), id, body.note, ...seats(req)]);
  });

  // ============================================================
  // the places — taken by a clerk, given back by a correction
  // ============================================================

  /**
   * Give a customer, company, person or vehicle one place on a code.
   *
   * The ceiling is counted from these rows, never stored on the charge, so this call is the only thing
   * that makes a promo run out. The freight and the figure actually taken are kept on the place because
   * the question a month later is "what did we really give away on that job", and the code's own value
   * cannot answer it after the code is re-versioned.
   */
  app.post("/control/pricing/charges/:id/claims", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-claim:${req.control.user_id}`, 120, 3600);
    const id = uuidOf(req.params.id, "charge");
    const body = z.object({
      subject_kind: z.enum(["tenant", "customer", "user", "vehicle", "driver"]),
      subject_id: UUID, job_ref: z.string().trim().min(3).max(60).optional(),
      freight: MONEY.optional(), taken: MONEY.optional(), note: z.string().trim().max(600).optional()
    }).strict().parse(req.body);
    return door(req, "The place could not be taken.", CLAIM_SQL,
      [tenantOf(req), id, body.subject_kind, body.subject_id, body.job_ref ?? null,
        body.freight ?? null, body.taken ?? null, body.note ?? null, ...seats(req)]);
  });

  /** Cancel a place that was taken by mistake. The row is kept and the ceiling moves back — a void is not
   *  a delete, because the voiding is the evidence that the mistake happened and who corrected it. */
  app.post("/control/pricing/claims/:id/void", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`charge-claim-void:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "claim");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The place could not be given back.", VOID_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });
}
