import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The cut and the money it is cut from (142; task #420b) — the office's commission agreements per company,
 * per plan and its own standing cut, and the readings that say a cut was taken against one transaction.
 *
 * Every door takes the book from `req.control.tenant_id` and from nowhere else, and every door binds that
 * uuid in every statement. The API role is BYPASSRLS, so the book named in the first parameter is the only
 * guard there is — the same arrangement 133, 134, 135, 140 and 141 run under. 142 goes one step further
 * than those: a cut is the office's own act, so the doors refuse a book that is not the platform tenant
 * (`not_the_office`) rather than accepting whichever tenant a desk happens to be looking at.
 *
 * **This file writes no audit rows.** Each 142 door calls `platform_auth.money_audit(...)` inside its own
 * statement, so an agreement opened, a figure moved, a paper raised and a cut taken are recorded by the same
 * write that makes them. A route that audited on top would double every line in the register.
 *
 * **The second seat is not at this desk.** `POST /cuts/:id/publish` raises the paper and prints the figure
 * it was cut on; it cannot make the agreement live. `apply_pricing_commission_rate` is deliberately not a
 * route here — it is 121's effect `commission_publish`, run in the register's own order (decide → claim →
 * apply → settle) by the seat that signed, in `api/src/control/approvals.ts`.
 *
 * **No figure is invented below.** A commission is arithmetic on a transaction, not a price: the desk asks
 * `GET /cuts/ask` and the register answers with the rung that spoke, the transaction's own money, the raw
 * figure and the figure after the agreement's least and most. A route that multiplied a percentage by an
 * amount would be a second arithmetic path, and two paths is how a desk shows one figure while the book
 * carries another — 138's defect.
 *
 * **A reading is a reading, not a movement.** `POST /readings` takes the cut the register computed and
 * writes nothing to 133's book. Saying a cut has been *carried* is a different act: it points at a payout
 * or a posting and the door reads that movement's figure out of the book and refuses the pointer when the
 * movement does not carry what the register computed. That is why it asks for `control.money.post` as well
 * as the pricing duty — the hand that may claim the book already moved is the hand that may move it.
 */

const VIEW = "control.pricing.view";
/** Opening and editing a draft, cloning a version, stopping an agreement, taking a cut and cancelling one. */
const MANAGE = "control.pricing.manage";
/** Putting an agreement up for a second seat, and refusing a paper that is out. */
const PUBLISH = "control.pricing.publish";
/** 133's duty, not a fourth pricing one: carrying a cut asserts a fact about the book. */
const MONEY_POST = "control.money.post";

const UUID = z.string().uuid();
const SENTENCE = z.string().trim().min(8).max(600);
/** `numeric(14,4)` — four decimals, because a percent rounded to two is a different cut on a small invoice. */
const FIGURE = z.string().trim().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/,
  "A figure is whole units or up to four decimals, with no separators.");
/** A least and a most are figures a clerk says out loud, so `numeric(14,2)`. */
const MONEY = z.string().trim().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/,
  "That is not a figure in whole units or two decimals.");
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The day is sent as the papers carry it.");
const WORD = z.string().trim().regex(/^[a-z0-9][a-z0-9_]{1,29}$/, "Name it as the register spells it.");
/** The board and the readings lower-case their own filter words, so `?status=PUBLISHED` asks the question
 *  the door answers. The fold happens before the shape check because the pattern is the register's spelling. */
const WORDI = z.string().trim().transform((v) => v.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_]{1,29}$/, "Name it as the register spells it."));
const LIMIT = z.coerce.number().int().min(1).max(200).default(30);
const OFFSET = z.coerce.number().int().min(0).max(20000).default(0);
const SEARCH = z.string().trim().min(1).max(140).optional();

/** Params: book, status|null, subject|null, source|null, search|null, limit, offset. */
const BOARD_SQL = "select platform_auth.pricing_commission_rates($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, agreement. */
const DETAIL_SQL = "select platform_auth.pricing_commission_rate_detail($1,$2) as r";
/** Params: book, agreement, limit, offset. */
const MEMORY_SQL = "select platform_auth.pricing_commission_rate_memory($1,$2,$3,$4) as r";
/** Params: book, kind, search|null, limit. */
const CHOICES_SQL = "select platform_auth.pricing_commission_choices($1,$2,$3,$4) as r";
/** Params: book, company|null, transaction kind, transaction id. The book is the office whose ladder is
 *  walked — a platform rung's key is the register's nil uuid and is the same in every office's book. */
const ASK_SQL = "select platform_auth.commission_on($1,$2,$3,$4) as r";
/** Params: book, status|null, source|null, search|null, from|null, to|null, limit, offset. */
const READINGS_SQL = `select platform_auth.pricing_commission_assessments(
  $1,$2,$3,$4,$5,$6,$7,$8) as r`;
/** Params: book, reading. */
const READING_SQL = "select platform_auth.pricing_commission_reading_detail($1,$2) as r";
/** Params: book, from|null, to|null. */
const SUMMARY_SQL = "select platform_auth.pricing_commission_summary($1,$2,$3) as r";

/** Params: book, subject kind, subject company|null, subject plan|null, transaction kind, payee kind,
 *  payee id|null, basis, value, currency|null, least|null, most|null, from|null, to|null, note,
 *  actor, role, ip, ua. */
const OPEN_SQL = `select platform_auth.open_pricing_commission_rate(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) as r`;
/** Params: book, agreement, value|null, least|null, most|null, from|null, to|null, note|null, clear,
 *  actor, role, ip, ua. */
const EDIT_SQL = `select platform_auth.edit_pricing_commission_rate(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as r`;
/** Params: book, agreement, reason, actor, role, ip, ua. */
const DISCARD_SQL = "select platform_auth.discard_pricing_commission_rate($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, agreement, effective_from, note|null, actor, role, ip, ua. */
const CLONE_SQL = "select platform_auth.clone_pricing_commission_rate($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, agreement, reason, actor, role, ip, ua. */
const PROPOSE_SQL = "select platform_auth.propose_pricing_commission_rate($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, agreement, note, actor, role, ip, ua. */
const REFUSE_SQL = "select platform_auth.refuse_pricing_commission_rate($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, agreement, effective_to, reason, actor, role, ip, ua. */
const WITHDRAW_SQL = `select platform_auth.withdraw_pricing_commission_rate(
  $1,$2,$3,$4,$5,$6,$7,$8) as r`;
/** Params: book, transaction kind, transaction id, note|null, actor, role, ip, ua. */
const ASSESS_SQL = "select platform_auth.assess_commission($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, reading, carrier kind, carrier id, note, actor, role, ip, ua. */
const DISCHARGE_SQL = `select platform_auth.discharge_commission_assessment(
  $1,$2,$3,$4,$5,$6,$7,$8,$9) as r`;
/** Params: book, reading, reason, actor, role, ip, ua. */
const VOID_SQL = "select platform_auth.void_commission_assessment($1,$2,$3,$4,$5,$6,$7) as r";

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
 * 142 answers in its own shape — `{ok:false, error:'<code>', message:'…'}` — and the sentence is the
 * useful half: `CMR-2026-00007 is a flat cut in USD and INV-2026-00114 is in TZS. A figure in one money is
 * not taken out of another; make a second agreement in TZS` is the answer a clerk needs, and no paraphrase
 * here improves it. So the words pick the status code and the door's message goes out unchanged.
 *
 * `no_rate`, `no_source`, `source_is_not_real`, `no_such_payout`, `no_such_posting` and `rate_missing` are
 * 404s for 140's reason: each is an honest statement that a row this book does not have was named, and a
 * desk that gets a 400 from it teaches the clerk to retype the number instead of looking for the paper.
 * `not_the_office` and `no_money_duty` are 403s because the register is refusing the *seat* — one is a book
 * that cannot hold a cut, the other a duty the seat never held — and both name the thing to ask for.
 */
const NOT_FOUND = new Set(["not_found", "no_book", "approval_missing", "no_rate", "no_source",
  "source_is_not_real", "no_such_payout", "no_such_posting", "rate_missing"]);
const FORBIDDEN = new Set(["unauthorised", "not_a_seat", "not_the_office", "no_money_duty"]);
const CONFLICT = new Set(["conflict", "already_open", "already_lived", "already_signed",
  "already_carried", "already_assessed", "already_voided", "nothing_open", "not_a_draft", "not_live",
  "paper_is_out", "paper_moved", "refused_the_signature_first", "kept", "empty_window", "no_start",
  "days_are_taken", "has_not_lived", "nothing_to_cut", "floor_above_the_money", "money_mismatch",
  "is_voided", "payout_has_not_moved", "fee_is_not_booked_yet", "posting_is_reversed",
  "carrier_does_not_carry_the_cut", "carrier_is_other_money", "carrier_has_no_such_leg",
  "carrier_is_another_payee", "stop_is_in_the_past", "no_stop_day", "source_is_empty"]);

function definerRefusal(j: any, fallback: string): ApiError | null {
  if (!j || typeof j !== "object" || j.ok !== false) return null;
  const code = String(j.error ?? "");
  const words = typeof j.message === "string" ? j.message : fallback;
  const { ok, error, message, ...extra } = j;
  const details = Object.keys(extra).length ? [extra] : [];
  if (NOT_FOUND.has(code)) return new ApiError("NOT_FOUND", words, 404, details);
  if (FORBIDDEN.has(code)) return new ApiError("FORBIDDEN", words, 403, details);
  if (CONFLICT.has(code)) return new ApiError("CONFLICT", words, 409, details);
  return new ApiError("VALIDATION_FAILED", words, 400, details);
}

/**
 * What the tables answer before a door's jsonb is built: 142's guards raise with `142: ` on the front of a
 * sentence written for a clerk, and `pricing_commission_rate_one_version_per_ladder` answers 23505. The
 * prefix comes off and the sentence goes out — the state that makes it untrue is a row the desk is staring
 * at, so it is a conflict, not a typing error.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT",
      "That book already holds a commission agreement with that number, or one version of this rung for "
      + "this transaction already carries those days.", 409);
  }
  if (!["23514", "23503", "P0001", "42501", "22007"].includes(code)) return null;
  if (code === "42501") {
    return new ApiError("FORBIDDEN", "This seat is not allowed to write in the commission register.", 403);
  }
  const words = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^142:\s*/, "").trim();
  if (!words) return new ApiError("CONFLICT", fallback, 409);
  if (/already|another|kept|cannot|not editable|no open |frozen|stays|never had|once|refus/i.test(words)) {
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

/** The half of a draft that is cleared rather than replaced — the register's own list, and it answers
 *  `bad_clear` on a word outside it. */
const CLEARS = ["floor_amount", "cap", "effective_to"];

export async function controlPricingCommissionRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================================================
  // the reads — the ladder's board, one agreement, the readings, the count
  // ============================================================

  /** The agreements with their rung, their transaction and their payee, plus `subjects` and `sources` —
   *  the two registers the desk builds its dropdowns from. Nothing below names `tenant`, `plan` or
   *  `payout`: 142's whole argument for making them tables is that a fourth rung or a sixth transaction is
   *  a row, not an edit to this file. */
  app.get("/control/pricing/cuts", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`cuts-board:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: WORDI.optional(), subject: WORDI.optional(), source: WORDI.optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).strict().parse(req.query);
    return door(req, "The cut register could not be read.", BOARD_SQL,
      [tenantOf(req), q.status ?? null, q.subject ?? null, q.source ?? null, q.search ?? null,
        q.limit, q.offset]);
  });

  /**
   * What may be named in an id — the ten lists the desk picks a company, a plan, a payee, a transaction or
   * a carrying movement off, in one door rather than ten.
   *
   * A rung is agreed with a company or inherited from a plan, a cut owed out names a company, a driver or a
   * staff member, a reading is taken against one of the five transactions, and a reading is carried by a
   * payout or a posting. Those ten registers belong to other modules and a pricing seat cannot read them,
   * so without this door every one of those fields is an uuid a clerk pastes off another desk — which is
   * 141's precedent for a code's subject, and the wrong
   * one here, because the paste can be a live row the register will happily price and the agreement will be
   * filed under somebody else. `kind` is not an enum below: the five transaction words are
   * `pricing_commission_sources`'s rows, and a list written into this file is a sixth transaction that
   * cannot be added without editing it. The door answers `bad_kind` with its own words instead.
   *
   * The names come out of the same columns `pricing_commission_names_its_book` copies onto the row, and the
   * validity rules are the resolver's, so a picker cannot offer an id the register would refuse. No PII
   * rides along: a driver or staff row is a name, the company it belongs to and whether it is archived.
   */
  app.get("/control/pricing/cuts/choices", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`cuts-choices:${req.control.user_id}`, 240, 60);
    const q = z.object({
      kind: WORD, search: z.string().trim().max(140).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20)
    }).strict().parse(req.query);
    return door(req, "The lists could not be read.", CHOICES_SQL,
      [tenantOf(req), q.kind, q.search ?? null, q.limit]);
  });

  /**
   * What the office takes out of one named transaction, and whether it has already been taken.
   *
   * It is a GET because it writes nothing, and it is the door rather than the desk because the figure needs
   * three things a client cannot be trusted to combine: the rung that speaks (a negotiated cut beats the
   * plan's, which beats the office's own standing cut), the transaction's own money and day, and the
   * agreement's least and most. The answer names the rung and the paper, so a desk never shows a figure
   * with no author.
   */
  app.get("/control/pricing/cuts/ask", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`cuts-ask:${req.control.user_id}`, 240, 60);
    const q = z.object({
      company: UUID.optional(), source: WORD, source_id: UUID
    }).strict().parse(req.query);
    return door(req, "The cut could not be worked out.", ASK_SQL,
      [tenantOf(req), q.company ?? null, q.source, q.source_id]);
  });

  /** One agreement whole: its rung, its figure, its version ladder, the paper out against it, its memory
   *  and the readings it has produced. A draft is opened and edited against this shape, so the desk reads
   *  back what the register holds rather than what somebody typed. */
  app.get("/control/pricing/cuts/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "agreement");
    return door(req, "That agreement could not be read.", DETAIL_SQL, [tenantOf(req), id]);
  });

  /** What the office signed and what moved afterwards. A memory row is never deleted, so this is the only
   *  place a figure that changed under a paper can be seen after the version was published. */
  app.get("/control/pricing/cuts/:id/history", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "agreement");
    const q = z.object({ limit: LIMIT, offset: OFFSET }).strict().parse(req.query);
    return door(req, "The agreement memory could not be read.", MEMORY_SQL,
      [tenantOf(req), id, q.limit, q.offset]);
  });

  /** The readings board, asked by transaction first and by agreement second, because "has this invoice
   *  been cut?" is the question a clerk actually has. */
  app.get("/control/pricing/readings", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`readings-board:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: WORDI.optional(), source: WORDI.optional(), search: SEARCH,
      from: DAY.optional(), to: DAY.optional(), limit: LIMIT, offset: OFFSET
    }).strict().parse(req.query);
    return door(req, "The readings could not be read.", READINGS_SQL,
      [tenantOf(req), q.status ?? null, q.source ?? null, q.search ?? null,
        q.from ? realDay(q.from, "from") : null, q.to ? realDay(q.to, "to") : null,
        q.limit, q.offset]);
  });

  /** One reading with the paper it was cut under and the movement that carried it. */
  app.get("/control/pricing/readings/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "reading");
    return door(req, "That reading could not be read.", READING_SQL, [tenantOf(req), id]);
  });

  /** The office's own count of what it cut, grouped by money and never summed across one. 138's defect is
   *  the reason this is a door: a client that added a TZS cut to a USD cut would answer a question the
   *  book cannot support, and the figure would look exactly like an answer. */
  app.get("/control/pricing/summary", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`cuts-summary:${req.control.user_id}`, 120, 60);
    const q = z.object({ from: DAY.optional(), to: DAY.optional() }).strict().parse(req.query);
    return door(req, "The cut count could not be read.", SUMMARY_SQL,
      [tenantOf(req), q.from ? realDay(q.from, "from") : null, q.to ? realDay(q.to, "to") : null]);
  });

  // ============================================================
  // the drafts — a rung, a transaction, a payee, a figure, a window
  // ============================================================

  /** Open an agreement. The subject, the transaction and the payee are fixed here and frozen by the guard
   *  in 142's section 6, because a desk that could move a cut from one company to another after the fact
   *  is a desk that can retarget a signed paper. */
  app.post("/control/pricing/cuts", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-open:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      subject_kind: WORD, subject_tenant: UUID.optional(), subject_plan: UUID.optional(),
      source_kind: WORD, payee_kind: WORD.optional(), payee_id: UUID.optional(),
      basis: z.enum(["percent_of_amount", "flat"]), value: FIGURE,
      currency: z.enum(["TZS", "USD"]).optional(),
      floor: MONEY.optional(), cap: MONEY.optional(),
      effective_from: DAY.optional(), effective_to: DAY.optional(), note: SENTENCE
    }).strict().superRefine((b, i) => {
      // The register refuses these two shapes with `two_subjects` and `payee_has_no_id`. Refusing them
      // here too is not a second rule — it is the same rule asked before a row is written, so the clerk
      // gets the sentence beside the field they left empty rather than after a failed press.
      if (b.subject_kind === "tenant" && !b.subject_tenant) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["subject_tenant"],
          message: "A cut agreed with a company has to say which company." });
      }
      if (b.subject_kind === "plan" && !b.subject_plan) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["subject_plan"],
          message: "A cut inherited from a plan has to say which plan." });
      }
      if (b.subject_kind === "platform" && (b.subject_tenant || b.subject_plan)) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["subject_kind"],
          message: "The office's own standing cut names no company and no plan." });
      }
      if (b.basis === "flat" && !b.currency) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"],
          message: "A flat cut has to be named in a money: TZS or USD." });
      }
      if (b.basis === "percent_of_amount" && b.currency) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["currency"],
          message: "A percentage is worked out in the transaction's own money, so it carries none." });
      }
    }).parse(req.body);
    return door(req, "The agreement could not be opened.", OPEN_SQL,
      [tenantOf(req), body.subject_kind, body.subject_tenant ?? null, body.subject_plan ?? null,
        body.source_kind, body.payee_kind ?? null, body.payee_id ?? null, body.basis, body.value,
        body.currency ?? null, body.floor ?? null, body.cap ?? null,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.effective_to ? realDay(body.effective_to, "effective_to") : null,
        body.note, ...seats(req)]);
  });

  /** Change a draft. Absent keys keep what the row holds and `clear` empties a column. The basis cannot
   *  move: a percentage and a flat sum are two promises, and a second seat that signed one cannot be made
   *  to have signed the other by an edit. */
  app.patch("/control/pricing/cuts/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-edit:${req.control.user_id}`, 120, 3600);
    const id = uuidOf(req.params.id, "agreement");
    const body = z.object({
      value: FIGURE.optional(), floor: MONEY.optional(), cap: MONEY.optional(),
      effective_from: DAY.optional(), effective_to: DAY.optional(), note: SENTENCE.optional(),
      clear: z.array(z.enum(CLEARS as [string, ...string[]])).max(CLEARS.length).optional()
    }).strict().superRefine((b, i) => {
      if (Object.keys(b).length === 0) {
        i.addIssue({ code: z.ZodIssueCode.custom,
          message: "Say which part changes: value, floor, cap, effective_from, effective_to, note "
            + "or clear." });
      }
      for (const w of b.clear ?? []) {
        if (w === "floor_amount" && b.floor !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "floor_amount is either given a figure or cleared, not both." });
        }
        if (w === "cap" && b.cap !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "cap is either given a figure or cleared, not both." });
        }
        if (w === "effective_to" && b.effective_to !== undefined) {
          i.addIssue({ code: z.ZodIssueCode.custom, path: ["clear"],
            message: "effective_to is either given a day or cleared, not both." });
        }
      }
    }).parse(req.body);
    return door(req, "The agreement could not be changed.", EDIT_SQL,
      [tenantOf(req), id, body.value ?? null, body.floor ?? null, body.cap ?? null,
        body.effective_from ? realDay(body.effective_from, "effective_from") : null,
        body.effective_to ? realDay(body.effective_to, "effective_to") : null,
        body.note ?? null, (body.clear ?? []).join(","), ...seats(req)]);
  });

  /** Throw away a draft that was never signed. An agreement that has been live is not a draft, and the
   *  door keeps it: the cut a company was billed under stays in the book. */
  app.post("/control/pricing/cuts/:id/discard", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-discard:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "agreement");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The draft could not be discarded.", DISCARD_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Raise a new version off an agreement that has lived, with the day the new cut starts. The figure is
   *  copied forward rather than retyped, so a version chain is one agreement's history. */
  app.post("/control/pricing/cuts/:id/clone", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-clone:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "agreement");
    const body = z.object({ effective_from: DAY, note: SENTENCE.optional() })
      .strict().parse(req.body);
    return door(req, "The version could not be cloned.", CLONE_SQL,
      [tenantOf(req), id, realDay(body.effective_from, "effective_from"), body.note ?? null,
        ...seats(req)]);
  });

  /** Stop a live agreement on a day that is not in the past. One seat, no signature: it stops the office
   *  asking for a cut tomorrow and does not unmake the days it was quoted under. */
  app.post("/control/pricing/cuts/:id/withdraw", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-withdraw:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "agreement");
    const body = z.object({ effective_to: DAY, reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The agreement could not be stopped.", WITHDRAW_SQL,
      [tenantOf(req), id, realDay(body.effective_to, "effective_to"), body.reason, ...seats(req)]);
  });

  // ============================================================
  // the signature — raised here, spent on Approvals
  // ============================================================

  /** Put an agreement up for a second seat. The door reads the rung, the transaction, the payee, the
   *  figure and the window out of the row and hashes them, so what the register holds is the paper the
   *  other seat signs; `pricing_commission_rate_detail` prints the same hash, which is how a desk can show
   *  that a figure moved after the signature was asked for. Nothing below publishes it. */
  app.post("/control/pricing/cuts/:id/publish", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PUBLISH);
    await enforceRateLimit(`cut-publish:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "agreement");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The agreement could not be put up for a signature.", PROPOSE_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Answer a paper with a no. It is the second seat's own duty, and it frees the draft to be edited. */
  app.post("/control/pricing/cuts/:id/refuse", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PUBLISH);
    await enforceRateLimit(`cut-refuse:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "agreement");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body);
    return door(req, "The paper could not be refused.", REFUSE_SQL,
      [tenantOf(req), id, body.note, ...seats(req)]);
  });

  // ============================================================
  // the readings — taken against one transaction, carried by one movement
  // ============================================================

  /** Take the cut. The door resolves the rung itself, reads the transaction's own figure and day out of
   *  the register, and refuses a second reading of the same cut for the same payee — a reading of a cut is
   *  the one place this book can double-count, so it is the one place it refuses twice. */
  app.post("/control/pricing/readings", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-assess:${req.control.user_id}`, 240, 3600);
    const body = z.object({
      source_kind: WORD, source_id: UUID, note: z.string().trim().max(600).optional()
    }).strict().parse(req.body);
    return door(req, "The cut could not be taken.", ASSESS_SQL,
      [tenantOf(req), body.source_kind, body.source_id, body.note ?? null, ...seats(req)]);
  });

  /**
   * Say a cut has been carried, by pointing at the movement that carried it.
   *
   * The pointer is a 134 payout or a 133 posting, never a figure: the door reads the money out of the book
   * and refuses a payout that has not moved, a reversed posting, a movement in another money, a movement
   * aimed at another payee, and a leg that does not equal the cut. This writes no leg — 133 and 134 still
   * own the book, and the duty asked for here is the duty that may write in it.
   */
  app.post("/control/pricing/readings/:id/discharge",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await requireControlPermission(req, MONEY_POST);
      await enforceRateLimit(`cut-discharge:${req.control.user_id}`, 120, 3600);
      const id = uuidOf(req.params.id, "reading");
      const body = z.object({
        carrier_kind: z.enum(["payout", "posting"]), carrier_id: UUID, note: SENTENCE
      }).strict().parse(req.body);
      return door(req, "The movement could not be checked against the cut.", DISCHARGE_SQL,
        [tenantOf(req), id, body.carrier_kind, body.carrier_id, body.note, ...seats(req)]);
    });

  /** Cancel a reading that was taken by mistake. The row is kept and leaves the count, because the voiding
   *  is the evidence that the mistake happened and who corrected it. */
  app.post("/control/pricing/readings/:id/void", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`cut-void:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "reading");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The reading could not be cancelled.", VOID_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });
}
