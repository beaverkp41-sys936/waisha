import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The count the office keeps of the money in, and the figure it means to earn (143; task #421b) — the
 * register of readings, the four cuts a reading carries, the window that folds readings against ambitions,
 * and the two doors that write.
 *
 * **This file does arithmetic on nothing.** Every figure a desk shows here came out of 133's book through
 * one definer read, and this layer's only job is to ask the door the question and carry its answer. The
 * reason is 138's defect: a second arithmetic path is how a screen ends up showing one figure while the
 * book carries another. A route that summed a `snapshots` array, or divided a bucket by an income, would
 * be that second path.
 *
 * **A reading is not a re-derivation.** 066, 068 and 088 answer the revenue screen by walking `invoices`
 * again on every press; those doors stay where they are. What lives here answers a different question —
 * *what did the book say on the 26th* — and keeps the answer, with the seat and the minute that took it,
 * so a month the office reported can be produced again after the rows underneath it move.
 *
 * **One money, always.** TZS and USD are never added and never exchanged: `revenue_snapshot_list`,
 * `revenue_window`, `revenue_cut` and `revenue_target_list` all refuse a sum that crosses the two, and the
 * desk asks for one of them. Nothing below defaults the pair together.
 *
 * **This file writes no audit rows.** Each 143 door calls `platform_auth.money_audit(...)` inside its own
 * statement, so a day counted, a promise raised and a stopped ambition are recorded by the same write that
 * makes them. A route that audited on top would double every line in the register.
 *
 * **Why there is no nightly clock here.** 143's section 11 is the door a sweep needs, and it refuses
 * anything but a live platform seat (`not_a_seat`) because the reading it writes carries `taken_by` into a
 * register nobody may rewrite. A clock has no seat: pointed at the oldest one on the roster it would put
 * an automated act behind a named person's signature and make the register say something untrue about who
 * counted the 26th. So `POST /book/sweep` is the act for now — a seat presses it, the office can press it
 * every morning, and `GET /book/state` reports the days the book moved and the register never read rather
 * than letting them pass as zeros. A clock needs a seat that *is* a clock, which is a row this schema does
 * not have yet.
 */

const VIEW = "control.revenue.view";
/** Counting a day, sweeping a window, re-taking a reading and throwing away an empty one. */
const COUNT = "control.revenue.count";
/** Setting the figure the office means to earn, and stopping one. */
const TARGET = "control.revenue.target";

const UUID = z.string().uuid();
const SENTENCE = z.string().trim().min(8).max(600);
/** `numeric(14,2)` — a figure a clerk says out loud, in whole units and two decimals at most. */
const MONEY = z.string().trim().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/,
  "That is not a figure in whole units or two decimals.");
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The day is sent as the papers carry it.");
/** The register counts one money at a time and refuses a third word with `name_the_money`. Asking the
 *  same thing here is not a second rule: it puts the sentence beside the field instead of under the page. */
const ONE_MONEY = z.enum(["TZS", "USD"]);
const PERIOD = z.enum(["day", "week", "month"]);
const CUT = z.enum(["account", "source", "desk", "route"]);

/** Params: book, days. */
const STATE_SQL = "select platform_auth.revenue_count_state($1,$2) as r";
/** Params: book, money, from|null, to|null, limit, offset. */
const REGISTER_SQL = "select platform_auth.revenue_snapshot_list($1,$2,$3,$4,$5,$6) as r";
/** Params: book, reading. */
const READING_SQL = "select platform_auth.revenue_snapshot_detail($1,$2) as r";
/** Params: book, kind, from, to|null, money. */
const WINDOW_SQL = "select platform_auth.revenue_window($1,$2,$3,$4,$5) as r";
/** Params: book, cut, from|null, to|null, money, limit. */
const CUT_SQL = "select platform_auth.revenue_cut($1,$2,$3,$4,$5,$6) as r";
/** Params: book, money, kind|null, from|null, to|null, include_withdrawn. */
const TARGETS_SQL = "select platform_auth.revenue_target_list($1,$2,$3,$4,$5,$6) as r";
/** Params: book, target. */
const AMBITION_SQL = "select platform_auth.revenue_target_detail($1,$2) as r";
/** Params: book, day, money|null, note|null, actor, role, ip, ua. */
const TAKE_SQL = "select platform_auth.take_revenue_day($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, from, to, actor, role, ip, ua. */
const SWEEP_SQL = "select platform_auth.count_revenue_days($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, reading, reason, actor, role, ip, ua. */
const DROP_SQL = "select platform_auth.discard_revenue_day($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, kind, day, amount, money|null, note|null, actor, role, ip, ua. */
const SET_SQL = "select platform_auth.set_revenue_target($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r";
/** Params: book, target, reason, actor, role, ip, ua. */
const STOP_SQL = "select platform_auth.withdraw_revenue_target($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, target, reason, actor, role, ip, ua. */
const THROW_SQL = "select platform_auth.discard_revenue_target($1,$2,$3,$4,$5,$6,$7) as r";

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
 * 143 answers in its own shape — `{ok:false, error:'<code>', message:'…'}` — and the sentence is the half
 * a clerk needs: `RTG-2026-00004 already promises 7500000.00 TZS for October 2026. A promise is changed by
 * withdrawing it and setting the new figure as its own target, so the office can still say what it first
 * meant to earn` says what to press next, and no paraphrase here improves it. So the code picks the status
 * and the door's message goes out unchanged.
 *
 * `counted_a_day_that_moved`, `stop_is_recorded`, `already_counted_against` and `already_withdrawn` are
 * conflicts because the state that makes the press illegal is a row the desk is looking at, not a typing
 * error. The day-range refusals are 400s because the clerk can answer them by choosing another day.
 */
const NOT_FOUND = new Set(["not_found", "no_book"]);
const FORBIDDEN = new Set(["not_a_seat"]);
const CONFLICT = new Set(["target_exists", "already_withdrawn", "already_counted_against",
  "stop_is_recorded", "counted_a_day_that_moved"]);

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
 * What the tables answer before a door's jsonb is built: 143's guards raise with `143: ` on the front of a
 * sentence written for a clerk, and the one-live-promise-per-period index answers 23505 when two seats
 * press the same month at the same moment. The prefix comes off and the sentence goes out.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT",
      "That book already holds a live target for that period, or a reading of that day in that money "
      + "taken at the same moment as this one.", 409);
  }
  if (!["23514", "23503", "P0001", "42501", "22007"].includes(code)) return null;
  if (code === "42501") {
    return new ApiError("FORBIDDEN", "This seat is not allowed to write in the revenue register.", 403);
  }
  const words = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^143:\s*/, "").trim();
  if (!words) return new ApiError("CONFLICT", fallback, 409);
  if (/already|another|kept|cannot|not editable|no open |frozen|stays|never had|once|refus|sums to/i
    .test(words)) {
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

/** Every read and every write here is one definer call: `guardRefusal` for what the tables answer,
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

export async function controlRevenueCountRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================================================
  // the reads — how current the register is, the readings, the fold, the cuts, the promises
  // ============================================================

  /** How current the register is, per money: the last day counted, and the days inside the window the book
   *  moved income on and the office never read. A gap list is the whole point of this read — a month
   *  reported from a register that stopped on the 21st is part of a month reported as all of it. */
  app.get("/control/revenue/book/state", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`revenue-state:${req.control.user_id}`, 240, 60);
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(120) })
      .strict().parse(req.query);
    return door(req, "The register's own state could not be read.", STATE_SQL,
      [tenantOf(req), q.days]);
  });

  /** The register: one reading per day per money, newest day first. The count and the window total travel
   *  with the page over the whole filtered window rather than over the rows on it, because a clerk shown
   *  twelve readings and a figure from a different twelve adds the column by hand and gets the wrong sum. */
  app.get("/control/revenue/book", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`revenue-book:${req.control.user_id}`, 240, 60);
    const q = z.object({
      currency: ONE_MONEY.optional(), from: DAY.optional(), to: DAY.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(40),
      offset: z.coerce.number().int().min(0).max(20000).default(0)
    }).strict().superRefine((b, i) => {
      if (b.from && b.to && b.to < b.from) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["to"],
          message: "The last day cannot come before the first day." });
      }
    }).parse(req.query);
    return door(req, "The register could not be read.", REGISTER_SQL,
      [tenantOf(req), q.currency ?? null,
        q.from ? realDay(q.from, "from") : null, q.to ? realDay(q.to, "to") : null,
        q.limit, q.offset]);
  });

  /** One reading, with its four cuts, the reading it replaced, and the ambitions its day falls inside. */
  app.get("/control/revenue/book/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "a reading");
    return door(req, "That count could not be read.", READING_SQL, [tenantOf(req), id]);
  });

  /** Actual against ambition, folded by day, week or month. A period the book moved inside without a
   *  reading is printed with its `uncounted_days`, so a figure cannot be shown beside a window that is
   *  missing eleven days without the answer saying so. */
  app.get("/control/revenue/window", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`revenue-window:${req.control.user_id}`, 120, 60);
    const q = z.object({
      kind: PERIOD.default("month"), from: DAY, to: DAY.optional(), currency: ONE_MONEY.optional()
    }).strict().superRefine((b, i) => {
      if (b.to && b.to < b.from) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["to"],
          message: "The last day cannot come before the first day." });
      }
    }).parse(req.query);
    return door(req, "The window could not be folded.", WINDOW_SQL,
      [tenantOf(req), q.kind, realDay(q.from, "from"),
        q.to ? realDay(q.to, "to") : null, q.currency ?? null]);
  });

  /** One cut of the register across a window: by account, by the kind of movement, by the desk whose seat
   *  raised it, or by the road the movement names. `income` is the whole window's figure even when only
   *  the top buckets are printed, so a share is a share of what the desk also claims to have earned. */
  app.get("/control/revenue/cut/:kind", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`revenue-cut:${req.control.user_id}`, 240, 60);
    const kind = CUT.safeParse(req.params.kind);
    if (!kind.success) {
      throw new ApiError("VALIDATION_FAILED",
        "The four cuts the register keeps are account, source, desk and route.", 400);
    }
    const q = z.object({
      from: DAY.optional(), to: DAY.optional(), currency: ONE_MONEY.optional(),
      limit: z.coerce.number().int().min(1).max(60).default(12)
    }).strict().superRefine((b, i) => {
      if (b.from && b.to && b.to < b.from) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["to"],
          message: "The last day cannot come before the first day." });
      }
    }).parse(req.query);
    return door(req, "The register could not be cut that way.", CUT_SQL,
      [tenantOf(req), kind.data, q.from ? realDay(q.from, "from") : null,
        q.to ? realDay(q.to, "to") : null, q.currency ?? null, q.limit]);
  });

  /** The ambitions, each with what the register has already said against it. Withdrawn ones are listed only
   *  when asked for: "we promised 8M and stopped promising it in March" is a fact the office has to be able
   *  to say, and it is a different fact from the one a live target carries. */
  app.get("/control/revenue/targets", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`revenue-targets:${req.control.user_id}`, 240, 60);
    const q = z.object({
      currency: ONE_MONEY.optional(), kind: PERIOD.optional(),
      from: DAY.optional(), to: DAY.optional(),
      // `z.coerce.boolean()` turns the string "false" into true, and a query flag arrives as a string.
      withdrawn: z.enum(["true", "false"]).default("false").transform((v) => v === "true")
    }).strict().superRefine((b, i) => {
      if (b.from && b.to && b.to < b.from) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["to"],
          message: "The last day cannot come before the first day." });
      }
    }).parse(req.query);
    return door(req, "The office's promises could not be read.", TARGETS_SQL,
      [tenantOf(req), q.currency ?? null, q.kind ?? null,
        q.from ? realDay(q.from, "from") : null, q.to ? realDay(q.to, "to") : null, q.withdrawn]);
  });

  /** One promise on its own — the read a renewal or a budget conversation quotes from. */
  app.get("/control/revenue/targets/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "a target");
    return door(req, "That promise could not be read.", AMBITION_SQL, [tenantOf(req), id]);
  });

  // ============================================================
  // the writes — count a day, sweep a window, throw away an empty reading
  // ============================================================

  /** Count one day. Naming no money counts every money the book moved income in that day; naming one asks
   *  for that money's figure even when the day holds nothing in it, which is the only way an honest zero
   *  can be written. The figures are never arguments: the door reads the book and stores what it says. */
  app.post("/control/revenue/book/take", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, COUNT);
    await enforceRateLimit(`revenue-take:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      day: DAY, currency: ONE_MONEY.optional(), note: SENTENCE.optional()
    }).strict().parse(req.body);
    return door(req, "The day could not be counted.", TAKE_SQL,
      [tenantOf(req), realDay(body.day, "day"), body.currency ?? null, body.note ?? null,
        ...seats(req)]);
  });

  /** Count every day in a window the book moved income in, and re-check every day already counted inside
   *  it. The re-check is the half that makes the register trustworthy: it is what proves that the figure a
   *  month was reported by has not drifted under the desk. Days with nothing to read are reported as passed
   *  over rather than written as zeros. */
  app.post("/control/revenue/book/sweep", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, COUNT);
    await enforceRateLimit(`revenue-sweep:${req.control.user_id}`, 6, 3600);
    const body = z.object({ from: DAY, to: DAY }).strict().superRefine((b, i) => {
      if (b.to < b.from) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["to"],
          message: "The last day cannot come before the first day." });
      }
      if ((new Date(`${b.to}T00:00:00Z`).getTime()
        - new Date(`${b.from}T00:00:00Z`).getTime()) / 86400000 + 1 > 92) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["from"],
          message: "A sweep reads at most 92 days at a time on this connection. Count the book a quarter "
            + "at a time." });
      }
    }).parse(req.body);
    return door(req, "The window could not be counted.", SWEEP_SQL,
      [tenantOf(req), realDay(body.from, "from"), realDay(body.to, "to"), ...seats(req)]);
  });

  /** Throw away a reading of a day that held nothing. This is the only erase in the register, and the door
   *  refuses any day that moved money in the same words the guard does, so a clerk is never told that a
   *  press broke. */
  app.post("/control/revenue/book/:id/discard", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, COUNT);
    await enforceRateLimit(`revenue-discard-day:${req.control.user_id}`, 30, 3600);
    const id = uuidOf(req.params.id, "a reading");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The count could not be thrown away.", DROP_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  // ============================================================
  // the promises — set a figure, stop one, throw away a slip
  // ============================================================

  /** Promise a figure for a day, a week or a month. The day named is only a way of pointing at a period:
   *  the door works out where that period starts and says so, because a week promised on a Wednesday and a
   *  week starting on Monday would otherwise be two different promises with one label. */
  app.post("/control/revenue/targets", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, TARGET);
    await enforceRateLimit(`revenue-target-set:${req.control.user_id}`, 30, 3600);
    const body = z.object({
      kind: PERIOD.default("month"), day: DAY, amount: MONEY,
      currency: ONE_MONEY.optional(), note: SENTENCE.optional()
    }).strict().superRefine((b, i) => {
      if (Number(b.amount) <= 0) {
        i.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"],
          message: "A target of nothing is not an ambition. Name the figure the office means to earn." });
      }
    }).parse(req.body);
    return door(req, "The promise could not be set.", SET_SQL,
      [tenantOf(req), body.kind, realDay(body.day, "day"), body.amount,
        body.currency ?? null, body.note ?? null, ...seats(req)]);
  });

  /** Stop a promise. The row and its reason stay, because a register that let an ambition be un-said would
   *  leave the months it was counted against without the figure they were measured by. */
  app.post("/control/revenue/targets/:id/withdraw", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, TARGET);
    await enforceRateLimit(`revenue-target-stop:${req.control.user_id}`, 30, 3600);
    const id = uuidOf(req.params.id, "a target");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The promise could not be stopped.", STOP_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });

  /** Throw away a target that was never counted against — a slip, not a decision. Anything the register has
   *  measured is kept by the door, and said as `already_counted_against`. */
  app.post("/control/revenue/targets/:id/discard", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, TARGET);
    await enforceRateLimit(`revenue-target-discard:${req.control.user_id}`, 30, 3600);
    const id = uuidOf(req.params.id, "a target");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The target could not be thrown away.", THROW_SQL,
      [tenantOf(req), id, body.reason, ...seats(req)]);
  });
}
