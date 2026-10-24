import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The office's book (133; task #344) — the chart, the movements, and the three hands that can touch
 * them: read, write, stop.
 *
 * Every door in 133 takes the book as its first argument, and this file takes that argument from
 * `req.control.tenant_id` and from nowhere else. A control session is platform-only since 099, so
 * that is the office's own book; a body or a param that named a tenant would be an invitation to
 * post into a company's ledger with the office's pen, and 133's own guard — the seat must belong to
 * the book it signs — would refuse it with a sentence about a uuid nobody can act on. The API role
 * is BYPASSRLS, so nothing below is protected by a policy. It is protected by the book it hands in.
 *
 * **There is no edit here.** A movement is written once and, if it was wrong, answered by its mirror
 * through `/postings/:id/reverse`, which mints its own number and points back at the paper it undoes.
 * The tables refuse UPDATE and DELETE at the trigger, so a route that could not say so would be the
 * weakest part of the strongest table in the schema.
 *
 * **A retry is not a second movement.** `Idempotency-Key` is required on the posting door rather than
 * honoured when somebody remembers it, because the desk's own double-click and a pooler's dropped
 * response are the two ways an office ends up paying a supplier twice, and neither is visible from
 * the screen that did it. 098 made the key unique per book; 133 replays the movement it already made
 * and says `replayed`, and the audit row carries that word too, so the register and the history agree
 * about what the second request actually did.
 *
 * **The arithmetic belongs to the book.** This file checks the *shape* of a leg — a uuid, one of two
 * sides, a figure with at most two decimals — and never adds anything up. The door totals the legs
 * before the header exists and the deferred trigger asks the same question at commit, so a route that
 * balanced the legs itself would be one more place for the two sides to disagree.
 *
 * Reading the book and writing in it are separate duties, and freezing an account is a third, charged
 * to the seat that settles disputes rather than to whoever holds a pen — which is why a finance
 * officer can post and cannot stop, and a compliance officer can stop and cannot post.
 */

const VIEW = "control.money.view";
const POST = "control.money.post";
const FREEZE = "control.money.freeze";

/** 133's thirteen kinds, spelled as the row spells them. `manual` and `adjustment` are the office's
 *  own pen; the rest name the registers that settle into this book in the stages after 133. */
const sourceKind = z.enum([
  "opening", "manual", "adjustment", "reversal",
  "invoice", "payment", "refund", "payout", "fee", "escrow", "cost", "payroll", "tax"]);
/** 126's pair, unchanged. A movement that changes money is two movements and an exchange line. */
const currency = z.enum(["TZS", "USD"]);
const direction = z.enum(["debit", "credit"]);

const KINDS = ["asset", "liability", "equity", "income", "expense"] as const;

const UUID = z.string().uuid();
const SENTENCE = z.string().trim().min(8).max(600);
const CODE = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/,
  "A code is letters, digits, dashes or underscores, 2 to 30 long.");
/** Sent as text and bound as a `date`: a timestamp would land on the wrong side of midnight for a
 *  desk keeping a book by day (090's lesson, applied to the ledger). */
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The day is sent as the papers carry it.");
/** A figure is text, because `1.005` out of a JavaScript number and `1,500.00` out of a
 *  locale-aware input are both refused by the book, and the door's sentence naming both sides is
 *  worth more to the desk than a float that quietly rounded. */
const FIGURE = z.string().trim().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/);
const LEG = z.object({
  account: UUID,
  direction,
  amount: FIGURE,
  detail: z.string().trim().min(3).max(200).optional()
}).strict();
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
const OFFSET = z.coerce.number().int().min(0).max(20000).default(0);
const SEARCH = z.string().trim().min(1).max(140).optional();

/** Params: book. */
const BOOK_SQL = "select platform_auth.money_book($1) as b";
/** Params: book. */
const SQUARE_SQL = "select platform_auth.money_book_is_square($1) as s";
/** Params: book, status|null, currency|null, account|null, search|null, limit, offset. */
const REGISTER_SQL = "select platform_auth.money_register($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, posting. */
const DETAIL_SQL = "select platform_auth.money_posting_detail($1,$2) as r";
/** Params: book, account. */
const ACCOUNT_SQL = "select platform_auth.money_account_row($1,$2) as r";
/** Params: book, code, label, kind, currency|null, note|null, actor. */
const OPEN_SQL = "select platform_auth.open_money_account($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, day, memo, currency, kind, source_id|null, source_ref|null, idempotency, actor,
 *  legs. */
const POST_SQL = `select platform_auth.record_money_posting(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) as r`;
/** Params: book, posting, reason, actor. */
const REVERSE_SQL = "select platform_auth.reverse_money_posting($1,$2,$3,$4) as r";
/** Params: book, account, reason, actor, frozen. */
const FREEZE_SQL = "select platform_auth.freeze_money_account($1,$2,$3,$4,$5) as r";

const tenantOf = (req: any) => String(req.control.tenant_id);
const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
const uaOf = (req: any) => String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null;

function uuidOf(value: unknown, what: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

/**
 * The four answers 133's doors give when the row they were asked about is not in the shape they
 * need. None is a server fault: each is a movement or an account the book already holds and has said
 * so about, so the desk hears it as a conflict with a reference it can quote rather than as a 500.
 */
function definerRefusal(j: any, fallback: string): ApiError | null {
  if (!j || typeof j !== "object" || j.ok !== false) return null;
  if (j.error === "not_found") {
    return new ApiError("NOT_FOUND",
      "That row is not in the office's book. A movement is read from the book it was written in.",
      404);
  }
  if (j.error === "already") {
    return new ApiError("CONFLICT",
      `${j.label ?? "That account"} is already frozen: ${j.reason ?? "with no reason on it"}`, 409);
  }
  if (j.error === "already_open") {
    return new ApiError("CONFLICT",
      `${j.label ?? "That account"} is open. Nothing was changed.`, 409);
  }
  if (j.error === "already_reversed") {
    return new ApiError("CONFLICT",
      `${j.ref ?? "That movement"} has already been reversed. A book is answered, not corrected.`,
      409, [{ reason: "already_reversed", ref: j.ref ?? null }]);
  }
  return new ApiError("UPSTREAM_ERROR", fallback, 502);
}

/**
 * 133 raises in the words a clerk will read, and a raise arrives as P0001. The sentence goes out with
 * only the file's number taken off the front, because "15 legs carry 4000000.00 debited against
 * 3990000.00 credited (out by 10000.00)" is the whole answer and a paraphrase of it is worse.
 *
 * Two of them are collisions rather than bad typing — the book that already has that code, the
 * reversal of a movement that is itself a reversal — and a desk needs to hear those as 409s, because
 * the second one is decided by a row the desk could not have seen when it typed.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT",
      "That book already holds a row with that number or that code.", 409);
  }
  if (!["23514", "23503", "P0001", "42501"].includes(code)) return null;
  if (code === "42501") {
    return new ApiError("FORBIDDEN", "This seat is not allowed to write in the book.", 403);
  }
  const words = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^133:\s*/, "").trim();
  if (!words) return new ApiError("CONFLICT", fallback, 409);
  if (/already has an account|itself a reversal/.test(words)) {
    return new ApiError("CONFLICT", words, 409);
  }
  return new ApiError("VALIDATION_FAILED", words, 400);
}

/** A shape-only date is how `2026-02-30` reaches Postgres and comes back as a 22007, which the desk
 *  can only report as a server fault. The day is asked to print itself back. */
function realDay(s: string): string {
  const back = new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10);
  if (back !== s) {
    throw new ApiError("VALIDATION_FAILED", `There is no day ${s} on a calendar.`, 400,
      [{ field: "posted_on", message: "The day has to exist, not just look like one." }]);
  }
  return s;
}

/**
 * Run the door, then put the act beside it in one transaction, so a movement whose audit row was
 * lost is a movement that did not happen. The subject of the audit row is read out of the door's own
 * answer, because the reference and the id are minted there and nowhere else.
 */
async function write<T extends Record<string, any>>(req: any, fallback: string,
  door: (c: PoolClient) => Promise<T>,
  subject: (out: T) => { entity: string; entityId: string; action: string;
    before: unknown; after: unknown }): Promise<T> {
  return withTenant(tenantOf(req), async (c) => {
    let out: T;
    try {
      out = await door(c);
    } catch (e: any) {
      throw guardRefusal(e, fallback) ?? e;
    }
    const refusal = definerRefusal(out, fallback);
    if (refusal) throw refusal;
    const s = subject(out);
    await writeAudit(c, {
      tenantId: tenantOf(req), actorUserId: req.control.user_id, actorRole: role(req),
      ip: req.ip, userAgent: uaOf(req), requestId: req.requestId,
      entity: s.entity, entityId: s.entityId, action: s.action,
      before: s.before, after: s.after
    });
    return out;
  });
}

const ask = async (c: PoolClient, sql: string, params: unknown[]) =>
  (await c.query(sql, params)).rows[0]?.r;

/** A `date` column arrives as a Date at midnight in the server's own zone, so its JSON form lands on
 *  the day before east of Greenwich (090's lesson). The register prints the day as text already; the
 *  detail door hands back the column, so it is cut from the local parts that survive the trip. */
function dayOf(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
}

export async function controlMoneyRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================
  // THE READS — the chart, the register, one movement, whether it squares
  // ============================

  /**
   * The chart with both sets of figures on it: the running column the book keeps and the same
   * figures recomputed from the legs, side by side with a `drift` flag. A desk that only ever sees
   * its own cached total is a desk that cannot tell a stale trigger from an honest book.
   */
  app.get("/control/money/book", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-book:${req.control.user_id}`, 240, 60);
    const { rows } = await pool.query(BOOK_SQL, [tenantOf(req)]);
    return rows[0]?.b;
  });

  /** The question the book answers about itself, as counters rather than as an assertion. */
  app.get("/control/money/square", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-square:${req.control.user_id}`, 60, 60);
    const { rows } = await pool.query(SQUARE_SQL, [tenantOf(req)]);
    return rows[0]?.s;
  });

  /**
   * Movements newest first. `status` and `currency` are filtered against a closed list here rather
   * than passed through, because the register answers an unknown word with an empty page, and an
   * empty page of a book that holds six hundred movements reads as a quiet week rather than as a
   * typo in the query string.
   */
  app.get("/control/money/register", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-register:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: z.enum(["all", "posted", "reversed"]).default("all"),
      currency: currency.optional(),
      account: UUID.optional(),
      search: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    const { rows } = await pool.query(REGISTER_SQL, [tenantOf(req),
      q.status === "all" ? null : q.status, q.currency ?? null, q.account ?? null,
      q.search ?? null, q.limit, q.offset]);
    return rows[0]?.r;
  });

  app.get("/control/money/postings/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "movement");
    const { rows } = await pool.query(DETAIL_SQL, [tenantOf(req), id]);
    const d = rows[0]?.r;
    if (!d) throw new ApiError("NOT_FOUND", "No movement under that reference.", 404);
    d.posted_on = dayOf(d.posted_on);
    return d;
  });

  app.get("/control/money/accounts/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "account");
    const { rows } = await pool.query(ACCOUNT_SQL, [tenantOf(req), id]);
    const a = rows[0]?.r;
    if (!a) throw new ApiError("NOT_FOUND", "No account in the office's book under that id.", 404);
    return a;
  });

  // ============================
  // THE CHART — open an account, stop one, start one again
  // ============================

  app.post("/control/money/accounts", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, POST);
    await enforceRateLimit(`money-account-open:${req.control.user_id}`, 30, 3600);
    const body = z.object({
      code: CODE,
      label: z.string().trim().min(3).max(80),
      kind: z.enum(KINDS),
      currency: currency.optional(),
      note: SENTENCE.optional()
    }).strict().parse(req.body);
    return write(req, "The account could not be opened.",
      (c) => ask(c, OPEN_SQL, [tenantOf(req), body.code, body.label, body.kind,
        body.currency ?? null, body.note ?? null, req.control.user_id]),
      (a) => ({
        entity: "money_accounts", entityId: String(a.id),
        action: "control.money.account_open",
        before: null,
        after: { code: a.code, label: a.label, kind: a.kind, currency: a.currency }
      }));
  });

  /**
   * A freeze stops every movement that would touch the account and carries the sentence that says
   * why. Unfreezing clears the book's reason column — 133 keeps one reason per account, not a
   * history — so the words a seat gives for lifting it are kept here, in the audit row, where the
   * office's history actually lives.
   */
  const freezeDoor = (frozen: boolean) => async (req: any) => {
    await requireControlPermission(req, FREEZE);
    await enforceRateLimit(`money-account-${frozen ? "freeze" : "unfreeze"}`
      + `:${req.control.user_id}`, 30, 3600);
    const id = uuidOf(req.params.id, "account");
    const body = z.object({ reason: frozen ? SENTENCE : SENTENCE.optional() })
      .strict().parse(req.body ?? {});
    const before = (await pool.query(ACCOUNT_SQL, [tenantOf(req), id])).rows[0]?.r;
    if (!before) throw new ApiError("NOT_FOUND", "No account in the office's book.", 404);
    return write(req, "The account could not be moved.",
      (c) => ask(c, FREEZE_SQL,
        [tenantOf(req), id, body.reason ?? null, req.control.user_id, frozen]),
      (j) => ({
        entity: "money_accounts", entityId: id,
        action: frozen ? "control.money.account_freeze" : "control.money.account_unfreeze",
        before: { code: before.code, status: before.status,
          frozen_reason: before.frozen_reason ?? null },
        after: { code: before.code, status: j.account?.status, reason: body.reason ?? null }
      }));
  };

  app.post("/control/money/accounts/:id/freeze",
    { preHandler: [requireControl] }, freezeDoor(true));
  app.post("/control/money/accounts/:id/unfreeze",
    { preHandler: [requireControl] }, freezeDoor(false));

  // ============================
  // THE MOVEMENTS — post one, answer one
  // ============================

  /**
   * The one way a movement enters the book, and the only write on this desk that may be retried.
   *
   * The key is taken from the header rather than the body because it belongs to the request and not
   * to the money: the same paper posted twice by two retries carries one key, and a body field the
   * desk has to remember is a body field the desk forgets.
   */
  app.post("/control/money/postings", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, POST);
    await enforceRateLimit(`money-post:${req.control.user_id}`, 60, 3600);
    const key = String(req.headers["idempotency-key"] ?? "").trim();
    if (key.length < 8 || key.length > 140) {
      throw new ApiError("VALIDATION_FAILED",
        "An `Idempotency-Key` of 8 to 140 characters is required: without it, a retry books the "
        + "same money twice.", 400,
        [{ field: "Idempotency-Key", message: "A movement is written under a key, not twice." }]);
    }
    const body = z.object({
      posted_on: DAY,
      memo: z.string().trim().min(8).max(200),
      currency: currency.default("TZS"),
      source_kind: sourceKind,
      source_id: UUID.nullable().optional(),
      source_ref: z.string().trim().min(3).max(60).optional(),
      legs: z.array(LEG).min(2).max(60)
    }).strict().parse(req.body);
    return write(req, "The movement could not be posted.",
      (c) => ask(c, POST_SQL, [tenantOf(req), realDay(body.posted_on), body.memo, body.currency,
        body.source_kind, body.source_id ?? null, body.source_ref ?? null, key,
        req.control.user_id, JSON.stringify(body.legs)]),
      (j) => ({
        entity: "money_postings", entityId: String(j.posting?.id ?? ""),
        action: "control.money.posting_create", before: null,
        after: { ref: j.posting?.ref ?? null, replayed: j.replayed === true,
          memo: body.memo, currency: body.currency, total: j.posting?.total ?? null,
          source_kind: body.source_kind, legs: body.legs.length }
      }));
  });

  /**
   * Undo a movement by posting its mirror, never by touching it.
   *
   * `reversal_note` is the column 133's own CHECK ties to the status, so a reversal without a
   * sentence is refused before a row exists — and the reason is required here rather than defaulted,
   * because "correcting the book" is not a reason an auditor can read six months later.
   */
  app.post("/control/money/postings/:id/reverse",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, POST);
      await enforceRateLimit(`money-reverse:${req.control.user_id}`, 30, 3600);
      const id = uuidOf(req.params.id, "movement");
      const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
      const before = (await pool.query(DETAIL_SQL, [tenantOf(req), id])).rows[0]?.r;
      if (!before) throw new ApiError("NOT_FOUND", "No movement under that reference.", 404);
      return write(req, "The movement could not be reversed.",
        (c) => ask(c, REVERSE_SQL, [tenantOf(req), id, body.reason, req.control.user_id]),
        (j) => ({
          entity: "money_postings", entityId: id, action: "control.money.posting_reverse",
          before: { ref: before.ref, status: before.status },
          after: { reason: body.reason, original_ref: before.ref,
            reversal_ref: j.reversal?.ref ?? null }
        }));
    });
}
