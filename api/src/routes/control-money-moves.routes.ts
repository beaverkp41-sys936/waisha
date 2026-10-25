import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import { decryptField, encryptField, searchHash } from "../util/crypto.js";
import { REASON_CODES } from "../control/approvals.js";

/**
 * The money that waits and the money that leaves (134; task #401) — wallets, escrow holds and
 * payouts, the three registers that sit on top of 133's book.
 *
 * Like 133's file, every door here takes the office's book from `req.control.tenant_id` and from
 * nowhere else, and like it, nothing below is protected by a row-level policy: the API role is
 * BYPASSRLS, so the tenant bound into the first parameter is the only guard there is.
 *
 * **This file writes no audit rows, with one exception.** 134's doors each call
 * `platform_auth.money_audit(...)` inside their own transaction, so a movement, a hold and a payout
 * are recorded by the same statement that makes them. A route that audited on top of that would
 * double every line in the register and be the version of the history that drifts. The exception is
 * the payee-line reveal: opening a stored number is not something a definer can do — no door in 134
 * decrypts — so the seat that asks is recorded here, before the value is returned, the same way 127
 * records a NIDA reveal.
 *
 * **The second seat is not at this desk.** A plan and a payout are proposed here and signed on
 * Approvals: `money.escrow` and `money.payout` are kinds in 121's register, and their effects run in
 * its order (decide → claim → apply → settle) in `api/src/control/approvals.ts`. Nothing below can
 * release its own signature, which is the point of the whole arrangement.
 *
 * **A payee line leaves this file in three pieces and never as one.** The whole number is encrypted
 * by the API and stored as bytea; the board and the detail carry its tail and a boolean; the keyed
 * hash goes in so a desk can ask "is this the same M-Pesa line as last month" without anybody being
 * able to read it. `money_payout_detail` does return that hash, and it is stripped here: an
 * attacker with a board dump and a phone book has a 10^9 search space, and a hash is only a
 * protection while the value behind it is not the last four digits of a name.
 */

const VIEW = "control.money.view";
/** Putting money somewhere and taking it out of the office: the wallet doors that move money, every
 *  payout door and the batches that carry them. */
const PAY = "control.money.pay";
/** Parking money against a job, planning what happens to it — and stopping or restarting a holder's
 *  wallet, which 134's own description of the duty hands to this key rather than to `pay`. */
const ESCROW = "control.money.escrow";
/** Reading one payee line back in the clear. */
const REVEAL = "control.money.reveal";

const currency = z.enum(["TZS", "USD"]);
const UUID = z.string().uuid();
const SENTENCE = z.string().trim().min(8).max(600);
/** A figure is text, for 133's reason: `1.005` from a float and `1,500.00` from a locale-aware input
 *  are both refused by the book, and the door's sentence naming the balance is worth more than a
 *  number that quietly rounded itself into a different payout. */
const FIGURE = z.string().trim().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/,
  "A figure is whole units or up to two decimals, with no separators.");
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The day is sent as the papers carry it.");
/** Rails are read out of `money_payout_rails` rather than spelled out here, so a rail the office
 *  retires or adds in 135 is answered by the register — with its own label — and not by a 400 from
 *  a file that has to be edited to learn the world changed. */
const RAIL = z.string().trim().regex(/^[a-z][a-z0-9_-]{1,19}$/, "Name the rail as the register spells it.");
const MEMO = z.string().trim().min(8).max(200);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
const OFFSET = z.coerce.number().int().min(0).max(20000).default(0);
const SEARCH = z.string().trim().min(1).max(140).optional();
/** The words a hold is raised for are 121's seven, and the escrow door checks them against the same
 *  list; one of them spelled differently in two files is a reason a desk cannot park money. */
const REASON = z.enum(REASON_CODES);
const SUBJECT = z.enum(["booking", "cargo_file", "call", "dispute"]);
const PAYEE_KIND = z.enum(["company", "driver", "staff", "other"]);
const SOURCE_KIND = z.enum(["manual", "refund", "payroll", "wallet_withdrawal", "cost"]);
/** `gateway` is accepted by the fund door and refused by it for USD — money the rail has only
 *  reported waits there until 135 reconciles it. A hold has no gateway option at all. */
const INFLOW = z.enum(["bank", "cash", "gateway"]);

/** Params: book. */
const RAILS_SQL = "select platform_auth.money_rails($1) as r";
/** Params: book, status|null, currency|null, search|null, limit, offset. */
const WALLETS_SQL = "select platform_auth.money_wallet_board($1,$2,$3,$4,$5,$6) as r";
/** Params: book, wallet. */
const WALLET_SQL = "select platform_auth.money_wallet_detail($1,$2) as r";
/** Params: book, status|null, currency|null, subject kind|null, limit, offset. */
const ESCROWS_SQL = "select platform_auth.money_escrow_board($1,$2,$3,$4,$5,$6) as r";
/** Params: book, hold. */
const ESCROW_SQL = "select platform_auth.money_escrow_detail($1,$2) as r";
/** Params: book, status|null, currency|null, payee kind|null, rail|null, batch|null, search|null,
 *  limit, offset. */
const PAYOUTS_SQL = "select platform_auth.money_payout_board($1,$2,$3,$4,$5,$6,$7,$8,$9) as r";
/** Params: book, payout. */
const PAYOUT_SQL = "select platform_auth.money_payout_detail($1,$2) as r";
/** Params: book, status|null, currency|null, search|null, limit, offset. */
const BATCHES_SQL = "select platform_auth.money_payout_batch_board($1,$2,$3,$4,$5,$6) as r";
/** Params: book, batch. */
const BATCH_SQL = "select platform_auth.money_payout_batch_detail($1,$2) as r";
/** Params: book. */
const PAYABLE_SQL = "select platform_auth.money_payable($1) as r";
/** Params: book, kind, search|null, limit. */
const PAYEES_SQL = "select platform_auth.money_payees($1,$2,$3,$4) as r";
/** Params: book, kind, search|null, limit. */
const SUBJECTS_SQL = "select platform_auth.money_subjects($1,$2,$3,$4) as r";

/** Params: book, owner company, currency, note|null, actor, role, ip, ua. */
const WALLET_OPEN_SQL = "select platform_auth.open_money_wallet($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, wallet, amount, from, memo, day|null, actor, role, ip, ua, key. */
const WALLET_FUND_SQL = "select platform_auth.fund_money_wallet($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r";
/** Params: book, from wallet, to wallet, amount, memo, day|null, actor, role, ip, ua, key. */
const WALLET_MOVE_SQL = "select platform_auth.move_money_wallet($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r";
/** Params: book, wallet, reason|null, actor, frozen, role, ip, ua. */
const WALLET_FREEZE_SQL = "select platform_auth.freeze_money_wallet($1,$2,$3,$4,$5,$6,$7,$8) as r";

/** Params: book, subject kind, subject id, amount, currency, payer wallet|null, from|null,
 *  reason code, reason, day|null, actor, role, ip, ua, key. */
const ESCROW_RAISE_SQL = `select platform_auth.raise_money_escrow(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) as r`;
/** Params: book, hold, kind, to payee|null, back to payer|null, fee|null, payee wallet|null,
 *  plan note, actor, role, ip, ua. */
const ESCROW_PLAN_SQL = `select platform_auth.propose_escrow_discharge(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r`;
/** Params: book, hold, note, actor, role, ip, ua. */
const ESCROW_REFUSE_SQL = "select platform_auth.refuse_escrow_discharge($1,$2,$3,$4,$5,$6,$7) as r";

/** Params: book, payee kind, payee id|null, payee name|null, rail, line bytea|null, tail|null,
 *  hash|null, amount, fee, currency, source kind, source id|null, source ref|null, purpose,
 *  batch|null, actor, role, ip, ua. */
const PAYOUT_RAISE_SQL = `select platform_auth.raise_money_payout(
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) as r`;
/** Params: book, payout, reason, actor, role, ip, ua. */
const PAYOUT_PROPOSE_SQL = "select platform_auth.propose_money_payout($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, payout, note, actor, role, ip, ua. */
const PAYOUT_DECLINE_SQL = "select platform_auth.decline_money_payout($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, payout, note, day|null, actor, role, ip, ua. */
const PAYOUT_PAID_SQL = "select platform_auth.mark_money_payout_paid($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: book, payout, reason, actor, role, ip, ua. */
const PAYOUT_FAILED_SQL = "select platform_auth.mark_money_payout_failed($1,$2,$3,$4,$5,$6,$7) as r";

/** Params: book, label, currency, actor, role, ip, ua. */
const BATCH_OPEN_SQL = "select platform_auth.open_money_payout_batch($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, batch, reason, actor, role, ip, ua. */
const BATCH_PROPOSE_SQL = "select platform_auth.propose_money_payout_batch($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, batch, note, actor, role, ip, ua. */
const BATCH_DECLINE_SQL = "select platform_auth.decline_money_payout_batch($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, batch, note, actor, role, ip, ua. */
const BATCH_CLOSE_SQL = "select platform_auth.close_money_payout_batch($1,$2,$3,$4,$5,$6,$7) as r";

/** The one statement in this file that reads a payee line in the clear. It is a table read rather
 *  than a definer because 134 deliberately has no decrypt door: the number only ever leaves through
 *  here, and only through here can a seat be recorded as having asked. */
const LINE_SQL = `select p.id, p.ref, p.status, p.payee_kind, p.payee_name, p.currency,
                         p.amount, p.rail_code, r.label as rail_label, r.needs as rail_needs,
                         p.payee_ref_tail as line_tail,
                         (p.payee_ref_encrypted is not null) as line_sealed,
                         p.payee_ref_encrypted as encrypted, p.payee_tenant_id
                    from money_payouts p
                    join money_payout_rails r on r.code = p.rail_code
                   where p.id = $1 and p.tenant_id = $2`;

const tenantOf = (req: any) => String(req.control.tenant_id);
const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
const uaOf = (req: any) => String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null;

function uuidOf(value: unknown, what: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

/**
 * 134's doors answer in their own shape — `{ok:false, error:'<code>', message:'…'}` — which is not
 * 121's `status` words, and the difference matters: a refund paper, an erasure and a hold are
 *  refused by 121's deciders, while a payout that is already paid, a wallet that is stopped and a
 *  plan that does not add up are answered by these doors.
 *
 * The message is passed through rather than paraphrased. `The three figures are the whole of the
 * money held, or the plan is not a plan` names the hold's own figure and the desk's own three boxes,
 * and no sentence this file could invent about arithmetic is better than that.
 */
const NOT_FOUND = new Set(["not_found", "payer_not_found", "payee_not_found", "wallet_not_found",
  "from_not_found", "to_not_found", "batch_not_found", "refund_not_found", "run_not_found",
  "approval_missing"]);
const CONFLICT = new Set(["conflict", "already_open", "already_held", "already_released",
  "already_closed", "already", "in_a_batch", "in_a_signed_batch", "lines_outstanding",
  "batch_closed", "prior_refusal", "refused_the_signature_first", "reversal_refusal",
  "reversal_refused", "empty_batch"]);

function definerRefusal(j: any, fallback: string): ApiError | null {
  if (!j || typeof j !== "object" || j.ok !== false) return null;
  const code = String(j.error ?? "");
  const words = typeof j.message === "string" ? j.message : fallback;
  const { ok, error, message, ...extra } = j;
  const details = Object.keys(extra).length ? [extra] : [];
  if (NOT_FOUND.has(code)) {
    return new ApiError("NOT_FOUND", words, 404, details);
  }
  if (code === "unauthorised" || code === "not_a_seat") {
    return new ApiError("FORBIDDEN", words, 403, details);
  }
  if (CONFLICT.has(code)) {
    return new ApiError("CONFLICT", words, 409, details);
  }
  return new ApiError("VALIDATION_FAILED", words, 400, details);
}

/**
 * A guard that fires before the door's own answer — 133's leg check, a unique index, a wallet column
 * CHECK — arrives as P0001 or a constraint code, with `134: ` on the front of a sentence written for
 * a clerk. The number is taken off and the sentence goes out: `already parked 500000.00 TZS in this
 * book — that movement is the money, and it is not held twice under two papers` is the whole answer
 * to a desk whose button was pressed twice, and it is a conflict, because the second request is
 * refused by a row the desk cannot see.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT",
      "That book already holds a row with that number, that code or that key.", 409);
  }
  if (!["23514", "23503", "P0001", "42501", "22007"].includes(code)) return null;
  if (code === "42501") {
    return new ApiError("FORBIDDEN", "This seat is not allowed to write in the book.", 403);
  }
  const words = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^134:\s*/, "").trim();
  if (!words) return new ApiError("CONFLICT", fallback, 409);
  if (/already|another|not be swapped|no open /i.test(words)) {
    return new ApiError("CONFLICT", words, 409);
  }
  return new ApiError("VALIDATION_FAILED", words, 400);
}

/** A shape-only date is how `2026-02-30` reaches Postgres and comes back as a 22007 nobody can read.
 *  134's doors take a `date`, so the day is asked to print itself back before it is bound. */
function realDay(s: string): string {
  const back = new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10);
  if (back !== s) {
    throw new ApiError("VALIDATION_FAILED", `There is no day ${s} on a calendar.`, 400,
      [{ field: "posted_on", message: "The day has to exist, not just look like one." }]);
  }
  return s;
}

/** A read that answers `{error: 'There is no hold in this book.'}` instead of nothing. */
function notFound(j: any, what: string): ApiError | null {
  if (j && typeof j === "object" && typeof j.error === "string" && !("rows" in j)) {
    return new ApiError("NOT_FOUND", j.error || what, 404);
  }
  return null;
}

/** Every write in this file is one definer call. `guardRefusal` catches what the tables answer
 *  before the door's own jsonb gets built, and `definerRefusal` turns the door's answer into HTTP. */
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

const read = async (sql: string, params: unknown[]) =>
  (await pool.query(sql, params as any[])).rows[0]?.r;

/** A board walked to the last page it holds, so an export carries every row the filters still name
 *  rather than the sixty the screen asked for. 2,000 payouts is the office's whole month of them. */
async function walkPayouts(tenant: string, status: string | null, cur: string | null,
  kind: string | null, rail: string | null, batch: string | null, search: string | null) {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const b = await read(PAYOUTS_SQL, [tenant, status, cur, kind, rail, batch, search, 100, offset]);
    const page = (b?.rows ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // A purpose is typed by whoever sat at the desk, and a cell that starts with an operator is a
  // formula the moment the CSV reaches a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const csvHead = (h: string) => (/[",\r\n]/.test(h) ? csvCell(h) : h);
const csv = (head: string[], rows: Record<string, unknown>[]): string => [
  head.map(csvHead).join(","),
  ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))
].join("\r\n");

/**
 * The payee line, canonicalised before it is encrypted and hashed.
 *
 * A phone is stored as `+2557…` because that is the shape 126's call register indexes, so the same
 * number on a payout and on a call is provably the same number — two shapes of one number is how a
 * desk ends up paying a line it stopped paying. An account is the alphanumerics the bank printed,
 * upper-cased, because a branch writes `DS/0123/4` and the teller reads `ds01234`.
 *
 * The tail is what the board shows: the last four digits, which is the whole of the desk's ability to
 * say "is this the right person" out loud over a phone without reading a number to a stranger.
 */
function phoneLine(raw: string): { value: string; tail: string } {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("0")) d = `255${d.slice(1)}`;
  if (d.length === 9 && /^[67]/.test(d)) d = `255${d}`;
  if (!/^255[67]\d{8}$/.test(d)) {
    throw new ApiError("VALIDATION_FAILED",
      "A mobile-money line is a Tanzanian number on the series the rails pay: 06…, 07…, +2556… or "
      + "+2557… — nothing else is a shape a rail can send. An 08 number is not payable here.", 400,
      [{ field: "payee_line", message: "The rail needs a phone number, typed any way you heard it." }]);
  }
  return { value: `+${d}`, tail: d.slice(-4) };
}

function accountLine(raw: string): { value: string; tail: string } {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 4 || s.length > 30) {
    throw new ApiError("VALIDATION_FAILED",
      "A bank line is the account number as the bank printed it, 4 to 30 letters and digits once the "
      + "spaces and slashes are gone.", 400,
      [{ field: "payee_line", message: "Type the account number, not a branch address." }]);
  }
  return { value: s, tail: s.slice(-4) };
}

/** The three pieces the door takes, or nothing at all for a rail that pays no number. */
function payeeLine(needs: string, raw: string | undefined) {
  if (needs === "none") {
    if (raw !== undefined && raw !== "") {
      throw new ApiError("VALIDATION_FAILED",
        "That rail hands the money over at the desk, so the paper must carry no account line — a cash "
        + "payout with a number on it is a number read out to the wrong person.", 400,
        [{ field: "payee_line", message: "Remove the line, or pay on a rail that needs one." }]);
    }
    return { encrypted: null as Buffer | null, tail: null as string | null, hash: null as string | null };
  }
  if (raw === undefined || raw === "") {
    throw new ApiError("VALIDATION_FAILED",
      `This rail pays a ${needs === "phone" ? "number" : "account"}, and the paper has to carry it.`, 400,
      [{ field: "payee_line", message: "The whole line is stored encrypted; only its tail comes back." }]);
  }
  const line = needs === "phone" ? phoneLine(raw) : accountLine(raw);
  return { encrypted: encryptField(line.value), tail: line.tail, hash: searchHash(line.value) };
}

/** What a rail asks for is read out of the register before the desk's line is encrypted, so a phone
 *  number never reaches a door that pays by account. */
async function railNeeds(req: any, code: string): Promise<string> {
  const rails = await read(RAILS_SQL, [tenantOf(req)]);
  const r = ((rails?.rows ?? []) as any[]).find((x) => x.code === code);
  if (!r) {
    throw new ApiError("VALIDATION_FAILED",
      `The office does not pay on a rail called "${code}".`, 400,
      [{ field: "rail", message: "Pick one of the rails the payout board lists." }]);
  }
  if (r.retired) {
    throw new ApiError("CONFLICT",
      `${r.label} was retired as a rail — a payout is not raised on a line the office stopped using.`,
      409);
  }
  return String(r.needs);
}

/** `Idempotency-Key`, required on the three doors that put money somewhere, for 133's reason: a
 *  desk's double-click and a pooler's dropped response are the two ways an office parks the same
 *  500,000 twice, and neither is visible from the screen that did it. */
function idemKey(req: any): string {
  const key = String(req.headers["idempotency-key"] ?? "").trim();
  if (key.length < 8 || key.length > 140) {
    throw new ApiError("VALIDATION_FAILED",
      "An `Idempotency-Key` of 8 to 140 characters is required: without it, a retry books the same "
      + "money twice.", 400,
      [{ field: "Idempotency-Key", message: "A movement is written under a key, not twice." }]);
  }
  return key;
}

export async function controlMoneyMovesRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================================================
  // the reads — the rails, the wallets, the holds, the payouts, what is owed
  // ============================================================

  /** The rails with their counts, so the form offers what the book pays on rather than a list this
   *  file maintains. */
  app.get("/control/money/rails", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-rails:${req.control.user_id}`, 240, 60);
    return read(RAILS_SQL, [tenantOf(req)]);
  });

  app.get("/control/money/wallets", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-wallets:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: z.enum(["all", "open", "frozen"]).default("all"),
      currency: currency.optional(),
      search: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return read(WALLETS_SQL, [tenantOf(req), q.status === "all" ? null : q.status,
      q.currency ?? null, q.search ?? null, q.limit, q.offset]);
  });

  /** One wallet: its own balance from the legs, the twelve movements on its line, the holds it is a
   *  party to and the withdrawals raised against it. */
  app.get("/control/money/wallets/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "wallet");
    const w = await read(WALLET_SQL, [tenantOf(req), id]);
    const miss = notFound(w, "No wallet in the office's book under that id.");
    if (miss) throw miss;
    return w;
  });

  app.get("/control/money/escrow", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-escrow:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: z.enum(["all", "raised", "held", "pending_discharge", "discharged"])
        .default("pending_discharge").superRefine((v, i) => {
          // `held` is what the board calls a paper waiting on a plan, and `raised` never survives the
          // door: the hold is `held` the moment its movement is booked, in the same call that made it.
          if (v === "raised") {
            i.addIssue({ code: z.ZodIssueCode.custom, message: "A hold is held from the moment its "
              + "movement is booked; look at `held`." });
          }
        }),
      currency: currency.optional(),
      subject_kind: SUBJECT.optional(),
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return read(ESCROWS_SQL, [tenantOf(req), q.status === "all" ? null : q.status,
      q.currency ?? null, q.subject_kind ?? null, q.limit, q.offset]);
  });

  /** A hold read whole, including the plan's three figures and whether they still add up to the
   *  money — a desk that is about to sign a plan has to see that question answered. */
  app.get("/control/money/escrow/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "hold");
    const h = await read(ESCROW_SQL, [tenantOf(req), id]);
    const miss = notFound(h, "No hold in the office's book under that id.");
    if (miss) throw miss;
    return h;
  });

  /** The payouts board. `batch` is an id or nothing: the definer takes the filter as text because a
   *  desk types the number off a printed sheet, and a filter that is not an uuid is no rows rather
   *  than a 22P02 nobody can interpret. */
  app.get("/control/money/payouts", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-payouts:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: z.enum(["all", "raised", "pending_signature", "released", "paid", "failed", "declined"])
        .default("all"),
      currency: currency.optional(),
      payee_kind: PAYEE_KIND.optional(),
      rail: RAIL.optional(),
      batch: UUID.optional(),
      search: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return read(PAYOUTS_SQL, [tenantOf(req), q.status === "all" ? null : q.status,
      q.currency ?? null, q.payee_kind ?? null, q.rail ?? null, q.batch ?? null,
      q.search ?? null, q.limit, q.offset]);
  });

  /**
   * The payout register as one file.
   *
   * There is no column for the payee line. A sheet that leaves the office is read by whoever picks it
   * up, and the tail is enough to check a payment against a receipt — the number itself stays where
   * only a seat with `control.money.reveal` can reach it, and every reveal is in the register.
   */
  app.get("/control/money/payouts.csv", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-payouts-csv:${req.control.user_id}`, 20, 3600);
    const q = z.object({
      status: z.enum(["all", "raised", "pending_signature", "released", "paid", "failed", "declined"])
        .default("all"),
      currency: currency.optional(),
      payee_kind: PAYEE_KIND.optional(),
      rail: RAIL.optional(),
      batch: UUID.optional(),
      search: SEARCH
    }).strict().parse(req.query);
    const rows = await walkPayouts(tenantOf(req), q.status === "all" ? null : q.status,
      q.currency ?? null, q.payee_kind ?? null, q.rail ?? null, q.batch ?? null, q.search ?? null);
    const head = ["ref", "status", "payee_kind", "payee_name", "rail", "rail_label", "line_tail",
      "amount", "fee", "total", "currency", "source_kind", "source_ref", "purpose", "batch",
      "payable", "accrual", "payment", "approval", "raised_by", "raised_at", "released_at",
      "paid_at", "failed_at", "failure_reason", "declined_at"];
    reply.header("Content-Disposition",
      `attachment; filename="payouts-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.type("text/csv; charset=utf-8");
    return csv(head, rows);
  });

  app.get("/control/money/payouts/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "payout");
    const p = await read(PAYOUT_SQL, [tenantOf(req), id]);
    const miss = notFound(p, "No payout in the office's book under that id.");
    if (miss) throw miss;
    const { payee_ref_hash: _dropped, ...rest } = p;
    return rest;
  });

  /** The one read that asks the papers and the book the same question separately and prints both:
   *  the payable lines, escrow, and the holds and payouts counted off the registers. */
  app.get("/control/money/payable", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-payable:${req.control.user_id}`, 60, 60);
    return read(PAYABLE_SQL, [tenantOf(req)]);
  });

  /**
   * Who the office can pay, picked off a register rather than typed off a sheet.
   *
   * `payout_names_its_payee` refuses a payout aimed at a person the office has no paper for, and a
   * desk that guesses an uuid from memory gets `the office has no driver …` after it has already
   * typed a figure. This is the read that lets it choose instead — and it answers the two doors' own
   * rules, so `can_wallet` is false on every row the wallet form would be refused a hold for.
   *
   * A name and the company it belongs to is the whole answer. No phone, no NIDA, no account line:
   * the number the money travels on is typed once by the seat that holds it and is encrypted on the
   * way in, so a picker that listed the numbers would make `control.money.reveal` decorative.
   *
   * `other` is deliberately not a kind here — a payee the registers have no row for is named by the
   * desk itself, and this door cannot list people who do not exist in the book.
   */
  app.get("/control/money/payees", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-payees:${req.control.user_id}`, 120, 60);
    const q = z.object({
      kind: z.enum(["company", "driver", "staff"]).default("company"),
      search: z.string().trim().min(2).max(140).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(25)
    }).strict().parse(req.query ?? {});
    return read(PAYEES_SQL, [tenantOf(req), q.kind, q.search ?? null, q.limit]);
  });

  /**
   * What a hold can wait on, picked off a register rather than typed off a sheet.
   *
   * `raise_money_escrow` takes a `subject_id` for one of four registers — a booking, a cargo file, a
   * call, a dispute — and `escrow_names_its_subject` refuses an id that has no live row. The four
   * registers belong to four different modules and none of them is readable from a control session,
   * so without this door the desk could only park money against a job whose uuid it already knew.
   *
   * It prints the reference the guard itself builds (`BK-` plus the booking's id tail, the cargo file
   * number, the ticket or dispute ref) so the line the clerk reads out on the phone is the line the
   * register will hold. `can_hold` is the guard's own rule: a booking with no route, no cargo label
   * and no company name has nothing to name the hold by, and the guard would refuse it.
   *
   * No figures and no contact details. A hold is raised against a job, and the money is typed next.
   */
  app.get("/control/money/subjects", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-subjects:${req.control.user_id}`, 120, 60);
    const q = z.object({
      kind: z.enum(["booking", "cargo_file", "call", "dispute"]).default("call"),
      search: z.string().trim().min(2).max(140).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(25)
    }).strict().parse(req.query ?? {});
    return read(SUBJECTS_SQL, [tenantOf(req), q.kind, q.search ?? null, q.limit]);
  });

  app.get("/control/money/batches", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-batches:${req.control.user_id}`, 240, 60);
    const q = z.object({
      status: z.enum(["all", "open", "pending_signature", "released", "closed"]).default("all"),
      currency: currency.optional(),
      search: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return read(BATCHES_SQL, [tenantOf(req), q.status === "all" ? null : q.status,
      q.currency ?? null, q.search ?? null, q.limit, q.offset]);
  });

  app.get("/control/money/batches/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "batch");
    const b = await read(BATCH_SQL, [tenantOf(req), id]);
    const miss = notFound(b, "No batch in the office's book under that id.");
    if (miss) throw miss;
    return b;
  });

  // ============================================================
  // the wallets — open one, put money in, move it, stop it
  // ============================================================

  /** A wallet is a liability line and a holder's name. The line's code is minted from the company and
   *  the money, so one company one money is one balance and a desk cannot open a second place to put
   *  the same holder's money. */
  app.post("/control/money/wallets", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-wallet-open:${req.control.user_id}`, 30, 3600);
    const body = z.object({
      owner_tenant: UUID,
      currency: currency.default("TZS"),
      note: SENTENCE.optional()
    }).strict().parse(req.body);
    return door(req, "The wallet could not be opened.", WALLET_OPEN_SQL,
      [tenantOf(req), body.owner_tenant, body.currency, body.note ?? null,
        req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  /** Money into a holder's wallet from the office's bank, its till, or the gateway line. */
  app.post("/control/money/wallets/:id/fund", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-wallet-fund:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "wallet");
    const body = z.object({
      amount: FIGURE,
      from: INFLOW,
      memo: MEMO,
      posted_on: DAY.optional()
    }).strict().parse(req.body);
    return door(req, "The wallet could not be funded.", WALLET_FUND_SQL,
      [tenantOf(req), id, body.amount, body.from, body.memo,
        body.posted_on ? realDay(body.posted_on) : null,
        req.control.user_id, role(req), req.ip, uaOf(req), idemKey(req)]);
  });

  /** One holder paying another, inside the office's own book. No money enters or leaves. */
  app.post("/control/money/wallets/move", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-wallet-move:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      from_wallet: UUID,
      to_wallet: UUID,
      amount: FIGURE,
      memo: MEMO,
      posted_on: DAY.optional()
    }).strict().parse(req.body);
    if (body.from_wallet === body.to_wallet) {
      throw new ApiError("VALIDATION_FAILED",
        "A wallet cannot pay itself. That would be a movement with nothing in it.", 400,
        [{ field: "to_wallet", message: "Name a second holder." }]);
    }
    return door(req, "The money could not be moved.", WALLET_MOVE_SQL,
      [tenantOf(req), body.from_wallet, body.to_wallet, body.amount, body.memo,
        body.posted_on ? realDay(body.posted_on) : null,
        req.control.user_id, role(req), req.ip, uaOf(req), idemKey(req)]);
  });

  /** Stop a holder's money. The wallet and its book line are frozen together, because 133's leg guard
   *  is the thing that actually refuses a movement.
   *
   *  This costs `control.money.escrow` rather than `control.money.pay`, which is what the register's
   *  own words for the two duties say: the seat that adjudicates a job — parking money against a
   *  dispute, planning its end — is the seat that stops a holder's money, and 133 keeping the freeze
   *  out of the pen is the same reasoning one level down. */
  const walletFreeze = (frozen: boolean) => async (req: any) => {
    await requireControlPermission(req, ESCROW);
    await enforceRateLimit(`money-wallet-${frozen ? "freeze" : "unfreeze"}:${req.control.user_id}`,
      30, 3600);
    const id = uuidOf(req.params.id, "wallet");
    const body = z.object({ reason: frozen ? SENTENCE : SENTENCE.optional() })
      .strict().parse(req.body ?? {});
    return door(req, frozen ? "The wallet could not be stopped."
      : "The wallet could not be started again.", WALLET_FREEZE_SQL,
      [tenantOf(req), id, body.reason ?? null, req.control.user_id, frozen,
        role(req), req.ip, uaOf(req)]);
  };
  app.post("/control/money/wallets/:id/freeze", { preHandler: [requireControl] }, walletFreeze(true));
  app.post("/control/money/wallets/:id/unfreeze",
    { preHandler: [requireControl] }, walletFreeze(false));

  // ============================================================
  // the holds — park money against a job, plan its end, refuse a plan
  // ============================================================

  /**
   * Money waits. Either it comes out of a holder's wallet — which has to be big enough and in the same
   * money — or it is parked from the office's own bank or till.
   *
   * A job holds at most one live paper, and the door answers a second one with the ref, the figure and
   * the state of the first. That answer is the desk's whole conversation with a caller who says their
   * money is already held, so it goes out as a conflict with the row in its details rather than as a
   * sentence about an index.
   */
  app.post("/control/money/escrow", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, ESCROW);
    await enforceRateLimit(`money-escrow-raise:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      subject_kind: SUBJECT,
      subject_id: UUID,
      amount: FIGURE,
      currency: currency.default("TZS"),
      payer_wallet: UUID.optional(),
      from: INFLOW.optional(),
      reason_code: REASON,
      reason: SENTENCE,
      posted_on: DAY.optional()
    }).strict().parse(req.body);
    if (!body.payer_wallet && !body.from) {
      throw new ApiError("VALIDATION_FAILED",
        "A hold says where the money came from: a holder's wallet, or the office's bank or till.", 400,
        [{ field: "from", message: "Name the line the money is parked from." }]);
    }
    return door(req, "The money could not be parked.", ESCROW_RAISE_SQL,
      [tenantOf(req), body.subject_kind, body.subject_id, body.amount, body.currency,
        body.payer_wallet ?? null, body.from ?? null, body.reason_code, body.reason,
        body.posted_on ? realDay(body.posted_on) : null,
        req.control.user_id, role(req), req.ip, uaOf(req), idemKey(req)]);
  });

  /**
   * Put a plan on a hold and ask a second seat to sign it.
   *
   * The three figures are taken as text and bound as `numeric`, and the door asks the whole question
   * the table asks — do they add up to the money held — in the words a clerk reads. A desk that sent
   * two boxes and got a `does_not_add_up` back with `held`, `to_payee`, `back_to_payer` and `fee` in
   * the details has the arithmetic in front of it; a desk that was told "invalid input" has nothing.
   *
   * Naming this door `plan` rather than `discharge` is deliberate: nothing here moves money. The
   * movement happens on Approvals, under a signature this seat cannot give itself.
   */
  app.post("/control/money/escrow/:id/plan", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, ESCROW);
    await enforceRateLimit(`money-escrow-plan:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "hold");
    const body = z.object({
      kind: z.enum(["released", "refunded", "split"]),
      to_payee: FIGURE.optional(),
      back_to_payer: FIGURE.optional(),
      fee_amount: FIGURE.optional(),
      payee_wallet: UUID.optional(),
      reason: SENTENCE
    }).strict().parse(req.body);
    if (body.kind === "refunded" && body.payee_wallet) {
      throw new ApiError("VALIDATION_FAILED",
        "A refunded plan sends every unit back to the wallet it came from, so it cannot name a payee.",
        400, [{ field: "payee_wallet", message: "Leave it out, or plan a split." }]);
    }
    if (body.kind !== "refunded" && !body.payee_wallet) {
      throw new ApiError("VALIDATION_FAILED",
        "Money out of escrow goes to a holder's wallet. Open one, or refund the hold.", 400,
        [{ field: "payee_wallet", message: "Which wallet takes the money?" }]);
    }
    return door(req, "The plan could not be put on the hold.", ESCROW_PLAN_SQL,
      [tenantOf(req), id, body.kind, body.to_payee ?? null, body.back_to_payer ?? null,
        body.fee_amount ?? null, body.payee_wallet ?? null, body.reason,
        req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  /** Say no to the plan. The signature is answered first and the paper stamped from the answer, so a
   *  desk cannot leave a proposal standing open on a plan it has just refused. The money stays
   *  parked: a refused plan is a hold that has to be planned again. */
  app.post("/control/money/escrow/:id/refuse", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, ESCROW);
    await enforceRateLimit(`money-escrow-refuse:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "hold");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body);
    return door(req, "The plan could not be refused.", ESCROW_REFUSE_SQL,
      [tenantOf(req), id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  // ============================================================
  // the payouts — raise a paper, sign it, pay it, fail it
  // ============================================================

  /**
   * One payout paper, with the payee's line encrypted on the way in.
   *
   * No money moves here and nothing is owed yet: the paper is a draft until a second seat signs it,
   * and it stays in the register from here to the day it is answered. What the desk is charged for is
   * writing the figures down once, which is why the payee line is canonicalised before it is stored
   * rather than typed again on the payment.
   */
  app.post("/control/money/payouts", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-payout-raise:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      payee_kind: PAYEE_KIND,
      payee_id: UUID.optional(),
      payee_name: z.string().trim().min(2).max(120).optional(),
      rail: RAIL,
      payee_line: z.string().trim().min(4).max(40).optional(),
      amount: FIGURE,
      fee_amount: FIGURE.default("0"),
      currency: currency.default("TZS"),
      source_kind: SOURCE_KIND,
      source_id: UUID.optional(),
      source_ref: z.string().trim().min(3).max(60).optional(),
      purpose: SENTENCE,
      batch_id: UUID.optional()
    }).strict().parse(req.body);

    if (body.payee_kind === "other") {
      if (!body.payee_name) {
        throw new ApiError("VALIDATION_FAILED",
          "A payee the registers do not know has to be named by the desk that pays them.", 400,
          [{ field: "payee_name", message: "Two characters at least — it is the name on the receipt." }]);
      }
      if (body.payee_id) {
        throw new ApiError("VALIDATION_FAILED",
          "`other` is the kind for a payee nobody has a paper for, so it cannot carry an id.", 400,
          [{ field: "payee_id", message: "Clear the id, or pick company, driver or staff." }]);
      }
    } else {
      if (!body.payee_id) {
        throw new ApiError("VALIDATION_FAILED",
          "The office pays a company, a driver or a staff member it already has a paper for.", 400,
          [{ field: "payee_id", message: "Name the register's own row, or use `other`." }]);
      }
      if (body.payee_name) {
        throw new ApiError("VALIDATION_FAILED",
          "The register names that payee, so the paper takes its name from the row rather than from "
          + "what the desk typed beside it.", 400,
          [{ field: "payee_name", message: "Leave the name out — it is read off the company, driver "
            + "or staff record." }]);
      }
    }
    if (body.source_kind !== "manual" && body.source_kind !== "cost" && !body.source_id) {
      throw new ApiError("VALIDATION_FAILED",
        `A payout raised as a ${body.source_kind.replace(/_/g, " ")} stands on the paper it names, so `
        + "that paper's id has to be on this one.", 400,
        [{ field: "source_id", message: "Name the refund, the run or the wallet, or raise it as the "
          + "office's own pen." }]);
    }
    if (body.source_kind === "cost" && !body.source_ref) {
      throw new ApiError("VALIDATION_FAILED",
        "A cost payout says which cost it settles, in the reference the office keeps on it.", 400,
        [{ field: "source_ref", message: "3 to 60 characters, as the papers carry it." }]);
    }

    const needs = await railNeeds(req, body.rail);
    const line = payeeLine(needs, body.payee_line);
    return door(req, "The payout could not be raised.", PAYOUT_RAISE_SQL,
      [tenantOf(req), body.payee_kind, body.payee_id ?? null,
        body.payee_kind === "other" ? body.payee_name : null, body.rail,
        line.encrypted, line.tail, line.hash, body.amount, body.fee_amount, body.currency,
        body.source_kind, body.source_id ?? null, body.source_ref ?? null, body.purpose,
        body.batch_id ?? null, req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  /** Ask a second seat to sign one payout. The figures in the payload are read out of the row by the
   *  door, so what the other seat signs is provably this paper. */
  const proposeDoor = (batch: boolean) => async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-${batch ? "batch" : "payout"}-propose:${req.control.user_id}`,
      60, 3600);
    const id = uuidOf(req.params.id, batch ? "batch" : "payout");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The signature could not be asked for.",
      batch ? BATCH_PROPOSE_SQL : PAYOUT_PROPOSE_SQL,
      [tenantOf(req), id, body.reason, req.control.user_id, role(req), req.ip, uaOf(req)]);
  };
  app.post("/control/money/payouts/:id/propose",
    { preHandler: [requireControl] }, proposeDoor(false));
  app.post("/control/money/batches/:id/propose",
    { preHandler: [requireControl] }, proposeDoor(true));

  /** Say no to a paper. The signature is answered first, exactly as 129 refuses an erasure, so a
   *  payout cannot be marked declined while its proposal still stands open. */
  const declineDoor = (batch: boolean) => async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-${batch ? "batch" : "payout"}-decline:${req.control.user_id}`,
      60, 3600);
    const id = uuidOf(req.params.id, batch ? "batch" : "payout");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body);
    return door(req, "The payout could not be declined.",
      batch ? BATCH_DECLINE_SQL : PAYOUT_DECLINE_SQL,
      [tenantOf(req), id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
  };
  app.post("/control/money/payouts/:id/decline",
    { preHandler: [requireControl] }, declineDoor(false));
  app.post("/control/money/batches/:id/decline",
    { preHandler: [requireControl] }, declineDoor(true));

  /** The cash left. This is the second movement 133's header said a paid register has to add: the
   *  obligation was booked on the signature, the money is answered on the day it actually goes. */
  app.post("/control/money/payouts/:id/paid", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-payout-paid:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "payout");
    const body = z.object({ note: SENTENCE, posted_on: DAY.optional() }).strict().parse(req.body);
    return door(req, "The payment could not be confirmed.", PAYOUT_PAID_SQL,
      [tenantOf(req), id, body.note, body.posted_on ? realDay(body.posted_on) : null,
        req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  /** The rail said no. The accrual is answered by its mirror rather than deleted — the office owed the
   *  money, tried to pay it, and the book keeps both facts. */
  app.post("/control/money/payouts/:id/failed", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-payout-failed:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "payout");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    return door(req, "The failure could not be recorded.", PAYOUT_FAILED_SQL,
      [tenantOf(req), id, body.reason, req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  // ============================================================
  // the batches
  // ============================================================

  /** A batch is a label and one money. Its total is not typed — it is copied off the lines standing
   *  under it at the moment the desk asks for a signature, and then frozen by trigger. */
  app.post("/control/money/batches", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-batch-open:${req.control.user_id}`, 30, 3600);
    const body = z.object({
      label: z.string().trim().min(3).max(80),
      currency
    }).strict().parse(req.body);
    return door(req, "The batch could not be opened.", BATCH_OPEN_SQL,
      [tenantOf(req), body.label, body.currency, req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  /** A batch is finished when every line under it has answered, which is why the door refuses while
   *  one is still owed. Nothing is booked here. */
  app.post("/control/money/batches/:id/close", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, PAY);
    await enforceRateLimit(`money-batch-close:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "batch");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body);
    return door(req, "The batch could not be closed.", BATCH_CLOSE_SQL,
      [tenantOf(req), id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
  });

  // ============================================================
  // the one door that opens a payee line
  // ============================================================

  /**
   * The whole line, for the seat that has to read it to the bank.
   *
   * Twelve an hour, because the number a payout travels on is only needed when money is actually
   * leaving or a payee is on the phone about one paper — and a desk that could page a board of six
   * hundred payouts open, one reveal at a time, would otherwise be a way to buy a list of numbers.
   *
   * The audit row is written inside the same transaction as the read and before the value is
   * returned: a reveal that left no trace is a reveal the office cannot answer for, and 127's
   * customers desk is the precedent for putting the request on the register rather than the response.
   */
  app.get("/control/money/payouts/:id/line", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, REVEAL);
    await enforceRateLimit(`money-payee-line-reveal:${req.control.user_id}`, 12, 3600);
    const id = uuidOf(req.params.id, "payout");
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const { rows } = await c.query(LINE_SQL, [id, tenant]);
      if (!rows.length) {
        throw new ApiError("NOT_FOUND", "That payout is not in the office's book.", 404);
      }
      const l = rows[0];
      if (!l.line_sealed || !l.encrypted) {
        throw new ApiError("NOT_FOUND",
          `${l.ref} is paid ${l.rail_label.toLowerCase()}, so no line was ever written on it. A cash `
          + "payout is handed over at the desk.", 404);
      }
      let value: string;
      try {
        value = decryptField(l.encrypted as Buffer);
      } catch {
        // A blob this key cannot open is a fact about the row, not a crash, and it is still a seat
        // asking for a payee's number: the read is recorded, and the answer says it is unreadable.
        await writeAudit(c, {
          tenantId: tenant, actorUserId: req.control.user_id, actorRole: role(req),
          ip: req.ip, userAgent: uaOf(req), requestId: req.requestId,
          entity: "money_payouts", entityId: id, action: "control.money.payee_line_unreadable",
          before: null, after: { ref: l.ref, rail: l.rail_code, line_tail: l.line_tail }
        });
        throw new ApiError("CONFLICT",
          "The stored line on that payout could not be opened with this key. It is on the paper and "
          + "unreadable — do not raise a second payout for the same money.", 409,
          [{ reason: "line_unreadable", ref: l.ref }]);
      }
      await writeAudit(c, {
        tenantId: tenant, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, userAgent: uaOf(req), requestId: req.requestId,
        entity: "money_payouts", entityId: id, action: "control.money.payee_line_revealed",
        before: null,
        after: { ref: l.ref, payee_kind: l.payee_kind, payee_name: l.payee_name,
          rail: l.rail_code, line_tail: l.line_tail, payee_tenant_id: l.payee_tenant_id }
      });
      return { id: l.id, ref: l.ref, status: l.status, payee_kind: l.payee_kind,
        payee_name: l.payee_name, rail: l.rail_code, rail_label: l.rail_label,
        needs: l.rail_needs, line_tail: l.line_tail, currency: l.currency, amount: l.amount,
        payee_tenant_id: l.payee_tenant_id, line: value };
    });
  });
}
