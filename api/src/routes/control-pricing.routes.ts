import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The price that carries its own dates (140; task #417) — the office's freight price lists, their
 * versions, their memory, the corridors they price and the two doors that answer what a job costs.
 *
 * Every door takes the book from `req.control.tenant_id` and from nowhere else. The API role is
 * BYPASSRLS, so the tenant bound into the first parameter is the only guard there is — the same
 * arrangement 133, 134 and 135 run under.
 *
 * **This file writes no audit rows.** Each 140 door calls `platform_auth.money_audit(...)` inside its
 * own statement, so a card opened, a figure typed and a price published are recorded by the same write
 * that makes them. A route that audited on top would double every line in the register.
 *
 * **The second seat is not at this desk.** `POST /cards/:id/publish` raises the paper and prints the
 * figures it was cut on; it cannot make the price live. `apply_pricing_publish` is deliberately not a
 * route here — it is 121's effect `price_publish`, run in the register's own order (decide → claim →
 * apply → settle) by the seat that signed, in `api/src/control/approvals.ts`. A desk that could publish
 * from this file would be a desk that signs its own price.
 *
 * **A price refuses to invent arithmetic.** `GET /rate` and `GET /quote` are the register answering a
 * question, and their refusals are the point: `no_price` says the price is not zero, it has not been
 * set; `no_distance` says a per-kilometre price has no corridor measured to multiply. Those come back as
 * 404 and 400 with the door's own sentence, because a number this file manufactured would be exactly
 * what the register exists to prevent.
 */

const VIEW = "control.pricing.view";
/** Opening and editing a draft, putting figures on it, filing a corridor, cloning a version, stopping a
 *  price. Withdrawal is here rather than under `.publish` because it is the act that stops a wrong price
 *  being quoted an hour longer, and it needs no second signature. */
const MANAGE = "control.pricing.manage";
/** Putting a list up for a second seat, and refusing a paper that is out. */
const PUBLISH = "control.pricing.publish";

const UUID = z.string().uuid();
const SENTENCE = z.string().trim().min(8).max(600);
const LABEL = z.string().trim().min(3).max(80);
/** A rate is `numeric(14,4)`: four decimals, because 140's whole argument is that a per-kilometre figure
 *  rounded to two decimals is a different price on a 900 km corridor. */
const RATE = z.string().trim().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/,
  "A rate is whole units or up to four decimals, with no separators.");
/** A minimum is `numeric(14,2)` — the floor is a figure a clerk says out loud, not a fourth of a cent. */
const MINIMUM = z.string().trim().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/,
  "A minimum is whole units or up to two decimals.");
/** Quantities the simulator multiplies: tonnage and volume to three places, containers and days whole. */
const QUANTITY = z.string().trim().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/,
  "That is not a quantity.");
const WHOLE = z.coerce.number().int().min(1).max(10000);
/** A list code is typed however it is said; 140 upper-cases and underscores it, then answers `bad_code`
 *  with its own rule. A route that insisted on capitals would be a second spelling of the same rule. */
const CODE = z.string().trim().min(2).max(30);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The day is sent as the papers carry it.");
/** Status, class, container and basis are not enums here: `bad_status` and `bad_basis` are the register's
 *  sentences, and both name the words it actually knows. A list copied into this file is a list that has
 *  to be edited every time 140 adds a basis — the same reason 134 reads its rails out of the book.
 *  The shape is 140's own `pricing_dimensions_key` check, and the leading digit matters: `20ft` and `40ft`
 *  are container keys because 034 spelled them that way, and a pattern that insisted on a letter would
 *  shut the desk out of the two most-used lines on a freight list. */
const WORD = z.string().trim().regex(/^[a-z0-9][a-z0-9_]{1,29}$/, "Name it as the register spells it.");
const LIMIT = z.coerce.number().int().min(1).max(200).default(30);
const OFFSET = z.coerce.number().int().min(0).max(20000).default(0);
const SEARCH = z.string().trim().min(1).max(140).optional();

/** Params: book, status|null, search|null, code|null, limit, offset. */
const BOARD_SQL = "select platform_auth.pricing_board($1,$2,$3,$4,$5,$6) as r";
/** Params: book, card. */
const CARD_SQL = "select platform_auth.pricing_card_detail($1,$2) as r";
/** Params: book, card, limit, offset. */
const HISTORY_SQL = "select platform_auth.pricing_history($1,$2,$3,$4) as r";
/** Params: book, search|null, limit, offset. */
const CORRIDORS_SQL = "select platform_auth.pricing_corridors($1,$2,$3,$4) as r";
/** Params: book, day|null, code|null, route|null, class|null, container|null, basis|null. */
const RATE_SQL = "select platform_auth.pricing_rate_in_force($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, day|null, code|null, route|null, class|null, container|null, basis|null,
 *  tonnes|null, teu|null, cbm|null, days|null. */
const QUOTE_SQL = `select platform_auth.price_a_freight(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r`;
/** The vocabulary the doors check a line against — vehicle classes, container kinds and bases with the
 *  noun each one needs. It is the one read in this file that is a plain select: 140 granted it to the app
 *  role as reference data, and a route that copied the ten classes into a constant would be the second
 *  author of a list 140 made into data on purpose. */
const DIMENSIONS_SQL = `select kind, key, label, needs, sort from pricing_dimensions
   order by kind, sort, key`;

/** Params: book, name, origin, dest, distance_km|null, actor, role, ip, ua. */
const CORRIDOR_FILE_SQL = "select platform_auth.file_pricing_corridor($1,$2,$3,$4,$5,$6,$7,$8,$9) as r";
/** Params: book, code, label, currency, effective_from|null, note, actor, role, ip, ua. */
const CARD_OPEN_SQL = "select platform_auth.open_pricing_card($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r";
/** Params: book, card, label|null, currency|null, effective_from|null, note|null, actor, role, ip, ua. */
const CARD_EDIT_SQL = "select platform_auth.edit_pricing_card($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r";
/** Params: book, card, route|null, class|null, container|null, basis, rate, min|null,
 *  actor, role, ip, ua. */
const LINE_SET_SQL = `select platform_auth.set_pricing_line(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r`;
/** Params: book, line, actor, role, ip, ua. */
const LINE_REMOVE_SQL = "select platform_auth.remove_pricing_line($1,$2,$3,$4,$5,$6) as r";
/** Params: book, card, reason, actor, role, ip, ua. */
const CARD_DISCARD_SQL = "select platform_auth.discard_pricing_card($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, card, effective_from|null, note|null, actor, role, ip, ua. */
const CARD_CLONE_SQL = "select platform_auth.clone_pricing_card($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, card, reason, actor, role, ip, ua. */
const PUBLISH_PROPOSE_SQL = "select platform_auth.propose_pricing_publish($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, card, note, actor, role, ip, ua. */
const PUBLISH_REFUSE_SQL = "select platform_auth.refuse_pricing_publish($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, card, effective_to, reason, actor, role, ip, ua. */
const CARD_WITHDRAW_SQL = "select platform_auth.withdraw_pricing_card($1,$2,$3,$4,$5,$6,$7,$8) as r";

const tenantOf = (req: any) => String(req.control.tenant_id);
const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
const uaOf = (req: any) => String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null;

const seats = (req: any) => [req.control.user_id, role(req), req.ip, uaOf(req)];

function uuidOf(value: unknown, what: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

/**
 * 140 answers in its own shape — `{ok:false, error:'<code>', message:'…'}` — and the sentence is the
 *  useful half: `PRC-2026-00012 is published, so its prices are kept` names the register's own rule
 *  better than any paraphrase this file could write. So the words pick the status code and the door's
 *  message goes out unchanged.
 *
 * `no_price` is a 404 rather than a 400 because it is an honest answer about the book: there is no price
 *  for that scope on that day. `no_distance`, `no_tonnes` and their siblings stay 400 — the register is
 *  refusing to invent the missing half of a multiplication, and that is the caller's to fix.
 */
const NOT_FOUND = new Set(["not_found", "no_book", "approval_missing", "no_price"]);
const CONFLICT = new Set(["conflict", "already_open", "already_lived", "already_signed",
  "nothing_open", "nothing_to_clone", "no_prices", "not_a_draft", "not_live", "paper_is_out",
  "paper_moved", "refused_the_signature_first", "corridor_taken", "figures_are_typed"]);

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
 * What the tables answer before a door's jsonb is built: 140's five triggers raise with `140: ` on the
 *  front of a sentence written for a clerk, and a unique index answers 23505. The prefix comes off and
 *  the sentence goes out — `a rate line cannot be UPDATE without the card it belongs to` is the whole
 *  answer, and it is a conflict, because the row the trigger is protecting is the one the desk is staring at.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT", "That book already holds a row with that number or that name.", 409);
  }
  if (!["23514", "23503", "P0001", "42501", "22007"].includes(code)) return null;
  if (code === "42501") {
    return new ApiError("FORBIDDEN", "This seat is not allowed to write in the price register.", 403);
  }
  const words = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^140:\s*/, "").trim();
  if (!words) return new ApiError("CONFLICT", fallback, 409);
  if (/already|another|kept|cannot|not editable|no open |stays stopped/i.test(words)) {
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

/** The scope a line is keyed on, cut to the shape 140 stores: an absent half is `*`, and the same scope
 *  written twice is one line, so the route is a PUT and not a POST. */
const scopeOf = (b: { route?: string; vehicle_class?: string; container?: string }) => ({
  route: b.route ?? null, class: b.vehicle_class ?? null, cont: b.container ?? null,
});

export async function controlPricingRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================================================
  // the reads — the board, one card, its memory, its corridors, and what a job would cost
  // ============================================================

  app.get("/control/pricing/board", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`pricing-board:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: WORD.optional(), code: CODE.optional(), search: SEARCH,
      limit: LIMIT, offset: OFFSET
    }).strict().parse(req.query);
    return door(req, "The price board could not be read.", BOARD_SQL,
      [tenantOf(req), q.status ?? null, q.search ?? null,
        q.code ? q.code.toUpperCase().replace(/ /g, "_") : null, q.limit, q.offset]);
  });

  /** The words a price may be keyed on, as the register holds them: ten vehicle classes, four container
   *  kinds, seven bases and the noun each basis multiplies by. The desk builds its pickers from this
   *  rather than from a constant, so a basis 141 adds appears without a route being edited. */
  app.get("/control/pricing/dimensions", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`pricing-dimensions:${req.control.user_id}`, 120, 60);
    const rows = (await pool.query(DIMENSIONS_SQL)).rows;
    return { rows, clock: new Date().toISOString() };
  });

  /** The corridors this book can price, with the two facts the pricing form needs about each: whether
   *  anybody has ever measured it, and how many of this book's lists already carry a line along it. */
  app.get("/control/pricing/corridors", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`pricing-corridors:${req.control.user_id}`, 240, 60);
    const q = z.object({ search: SEARCH, limit: LIMIT, offset: OFFSET }).strict().parse(req.query);
    return door(req, "The corridors could not be read.", CORRIDORS_SQL,
      [tenantOf(req), q.search ?? null, q.limit, q.offset]);
  });

  /** One card whole: its header, its lines, the paper that is out against it and its own refusals. */
  app.get("/control/pricing/cards/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "price list");
    return door(req, "That price list could not be read.", CARD_SQL, [tenantOf(req), id]);
  });

  /** The memory 140's trigger keeps: what changed, who changed it and what the card was signed as. A
   *  desk asking "why is this price different from last month" is answered from here. */
  app.get("/control/pricing/cards/:id/history", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "price list");
    const q = z.object({ limit: LIMIT, offset: OFFSET }).strict().parse(req.query);
    return door(req, "The price memory could not be read.", HISTORY_SQL,
      [tenantOf(req), id, q.limit, q.offset]);
  });

  /**
   * What one scope costs on one day — the question the register answers, not a row this file filters.
   *
   * Asked with no basis it returns the most specific line and names the other bases that also stand for
   * that scope, so a desk that reads "4 250 per km" is not being shown half the answer.
   */
  app.get("/control/pricing/rate", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`pricing-rate:${req.control.user_id}`, 240, 60);
    const q = z.object({
      day: DAY.optional(), code: CODE.optional(), route: UUID.optional(),
      vehicle_class: WORD.optional(), container: WORD.optional(), basis: WORD.optional()
    }).strict().parse(req.query);
    return door(req, "The price could not be read.", RATE_SQL,
      [tenantOf(req), q.day ? realDay(q.day, "day") : null,
        q.code ? q.code.toUpperCase().replace(/ /g, "_") : null,
        q.route ?? null, q.vehicle_class ?? null, q.container ?? null, q.basis ?? null]);
  });

  /**
   * The simulator: the price, the quantity it multiplies and the working printed beside it.
   *
   * It is a GET because it writes nothing — it is the quote a clerk reads out before the job is booked,
   *  and the minimum charge, the distance and the rounding all come from the register's own arithmetic.
   */
  app.get("/control/pricing/quote", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`pricing-quote:${req.control.user_id}`, 240, 60);
    const q = z.object({
      day: DAY.optional(), code: CODE.optional(), route: UUID.optional(),
      vehicle_class: WORD.optional(), container: WORD.optional(), basis: WORD.optional(),
      tonnes: QUANTITY.optional(), teu: WHOLE.optional(), cbm: QUANTITY.optional(),
      days: WHOLE.optional()
    }).strict().parse(req.query);
    return door(req, "The quote could not be worked out.", QUOTE_SQL,
      [tenantOf(req), q.day ? realDay(q.day, "day") : null,
        q.code ? q.code.toUpperCase().replace(/ /g, "_") : null,
        q.route ?? null, q.vehicle_class ?? null, q.container ?? null, q.basis ?? null,
        q.tonnes ?? null, q.teu ?? null, q.cbm ?? null, q.days ?? null]);
  });

  // ============================================================
  // the drafts — a corridor, a list, its figures
  // ============================================================

  /** File a corridor of this book, with or without its distance. 140 owns the insert because `routes` is
   *  the portal's table and the app role can only read it from a control session. */
  app.post("/control/pricing/corridors", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-corridor-file:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      name: z.string().trim().min(3).max(120),
      origin: z.string().trim().min(2).max(80),
      dest: z.string().trim().min(2).max(80),
      distance_km: QUANTITY.optional()
    }).strict().parse(req.body);
    return door(req, "The corridor could not be filed.", CORRIDOR_FILE_SQL,
      [tenantOf(req), body.name, body.origin, body.dest, body.distance_km ?? null, ...seats(req)]);
  });

  /** Open a draft list. The version is minted by the register off the code, so a second draft named
   *  FREIGHT-STD is version 2 and the door says so. */
  app.post("/control/pricing/cards", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-card-open:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      code: CODE, label: LABEL,
      currency: z.enum(["TZS", "USD"]).default("TZS"),
      effective_from: DAY.optional(), note: SENTENCE
    }).strict().parse(req.body);
    return door(req, "The price list could not be opened.", CARD_OPEN_SQL,
      [tenantOf(req), body.code, body.label, body.currency,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.note, ...seats(req)]);
  });

  /** Change a draft's header. Absent keys keep what the card holds; the money is the field that cannot
   *  be swapped once the card carries figures, and the door answers that in its own sentence. */
  app.patch("/control/pricing/cards/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-card-edit:${req.control.user_id}`, 120, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({
      label: LABEL.optional(), currency: z.enum(["TZS", "USD"]).optional(),
      effective_from: DAY.optional(), note: SENTENCE.optional()
    }).strict().superRefine((b, i) => {
      // An empty patch is not a no-op: the door audits every call that reaches it, so a body that asks
      // for nothing would fill the register with edits nobody made.
      if (Object.keys(b).length === 0) {
        i.addIssue({ code: z.ZodIssueCode.custom,
          message: "Say which part changes: label, currency, effective_from or note." });
      }
    }).parse(req.body);
    return door(req, "The price list could not be changed.", CARD_EDIT_SQL,
      [tenantOf(req), id, body.label ?? null, body.currency ?? null,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.note ?? null, ...seats(req)]);
  });

  /** Put a figure on one scope, or replace the figure that is already there. */
  app.put("/control/pricing/cards/:id/lines", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-line-set:${req.control.user_id}`, 240, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({
      route: UUID.optional(), vehicle_class: WORD.optional(), container: WORD.optional(),
      basis: WORD, rate: RATE, min_charge: MINIMUM.optional()
    }).strict().parse(req.body);
    const s = scopeOf(body);
    return door(req, "The price could not be written.", LINE_SET_SQL,
      [tenantOf(req), id, s.route, s.class, s.cont, body.basis, body.rate,
        body.min_charge ?? null, ...seats(req)]);
  });

  app.delete("/control/pricing/lines/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-line-remove:${req.control.user_id}`, 120, 3600);
    const id = uuidOf(req.params.id, "price line");
    return door(req, "The price could not be removed.", LINE_REMOVE_SQL,
      [tenantOf(req), id, ...seats(req)]);
  });

  /** Throw away a draft that was never signed. A card that has been a live price is not a draft, and the
   *  door keeps it: the version a customer was quoted for stays in the book. */
  app.post("/control/pricing/cards/:id/discard", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-card-discard:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The draft could not be discarded.", CARD_DISCARD_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Raise a new version off one that is signed, published, superseded or stopped. This is how a live
   *  price is changed: the version that was quoted is never edited. */
  app.post("/control/pricing/cards/:id/clone", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-card-clone:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({
      effective_from: DAY.optional(), note: SENTENCE.optional()
    }).strict().parse(req.body);
    return door(req, "The version could not be cloned.", CARD_CLONE_SQL,
      [tenantOf(req), id,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.note ?? null, ...seats(req)]);
  });

  /** Stop a live price from a day that is not in the past. One seat, no signature: it is the act that
   *  keeps a wrong figure out of tomorrow's quotes. */
  app.post("/control/pricing/cards/:id/withdraw", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`pricing-card-withdraw:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({ effective_to: DAY, reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The price could not be stopped.", CARD_WITHDRAW_SQL,
      [tenantOf(req), id, realDay(body.effective_to, "effective_to"), body.reason, ...seats(req)]);
  });

  // ============================================================
  // the signature — raised here, spent on Approvals
  // ============================================================

  /**
   * Put a list up for a second seat.
   *
   * The door reads the card's own figures and hashes them, so what the register holds is the paper the
   *  other seat signs — and `pricing_card_detail` prints the same hash, which is how a desk can prove the
   *  price moved after the signature was asked for (`paper_moved`). Nothing below publishes it.
   */
  app.post("/control/pricing/cards/:id/publish", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PUBLISH);
    await enforceRateLimit(`pricing-publish:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The price could not be put up for a signature.", PUBLISH_PROPOSE_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Answer a paper with a no. It is the second seat's own duty, and it frees the draft to be edited. */
  app.post("/control/pricing/cards/:id/refuse", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PUBLISH);
    await enforceRateLimit(`pricing-refuse:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "price list");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body);
    return door(req, "The paper could not be refused.", PUBLISH_REFUSE_SQL,
      [tenantOf(req), id, body.note, ...seats(req)]);
  });
}
