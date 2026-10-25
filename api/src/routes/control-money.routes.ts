import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import { buildPdf } from "../export/pdf.js";
import { buildXlsx } from "../export/xlsx.js";
import { fileName, money as moneyText, type PreparedTable } from "../export/table.js";

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
 *
 * **The count is a fourth duty, and it is not a pen.** 135 raised `control.money.recon` for the seats
 * that check the book against the papers, because a reconciliation a seat can raise merely because it
 * can post is a report that cannot catch that seat. The three writes below — raise, sign, throw away —
 * and the two reads of a run all ask that key; a statement, which is only a read of the book, stays on
 * `control.money.view` so an office can hand its own accountant a line of the ledger.
 *
 * **These two sections write no audit rows, with one exception.** 135's doors each call
 * `platform_auth.money_audit(...)` inside their own transaction, so a route that filed a second row
 * would give the office's history two answers to the same act — and the door's row carries the
 * figures it actually used, which a route could only guess at. The exception is a printed statement:
 * it is the route that read the book and built the file, so the route is the only thing that can say
 * who held the paper and when.
 *
 * **A statement file is built here, not posted from the desk.** `/exports/table` takes the rows a
 * browser already has, which is the right contract for a screen's own register and the wrong one for
 * a statement: the figure a clerk is handed by an office must be the figure the book holds, so the
 * walk below asks `money_statement` for every page of the window and prints what the door answered,
 * including the opening and closing balances no page of the register shows.
 */

const VIEW = "control.money.view";
const POST = "control.money.post";
const FREEZE = "control.money.freeze";
const RECON = "control.money.recon";

/** 133's thirteen kinds, spelled as the row spells them. `manual` and `adjustment` are the office's
 *  own pen; the rest name the registers that settle into this book in the stages after 133. */
const sourceKind = z.enum([
  "opening", "manual", "adjustment", "reversal",
  "invoice", "payment", "refund", "payout", "fee", "escrow", "cost", "payroll", "tax"]);
/** 126's pair, unchanged. A movement that changes money is two movements and an exchange line. */
const currency = z.enum(["TZS", "USD"]);
const direction = z.enum(["debit", "credit"]);

/** 135's seven scopes, spelled as the run row spells them. The board filters against the same list,
 *  because a door that is handed a word it does not know answers an empty page, and an empty page of
 *  counts reads as a quiet month rather than as a typo. */
const SCOPE = z.enum(["book", "wallet", "escrow", "payout", "refund", "gateway", "all"]);

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

/** Params: book, scope|null, status|null, currency|null, search|null, limit, offset. */
const RECON_BOARD_SQL = "select platform_auth.money_recon_board($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, run. */
const RECON_DETAIL_SQL = "select platform_auth.money_recon_detail($1,$2) as r";
/** Params: book, scope, currency, from, to, actor, role, ip, ua. */
const RECON_RUN_SQL = `select platform_auth.run_money_reconciliation($1,$2,$3,$4,$5,$6,$7,$8,$9) as r`;
/** Params: book, run, note, actor, role, ip, ua. */
const RECON_SIGN_SQL = "select platform_auth.sign_money_reconciliation_run($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, run, reason, actor, role, ip, ua. */
const RECON_DISCARD_SQL = "select platform_auth.delete_money_reconciliation_run($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: book, account, from, to, limit, offset. */
const STATEMENT_SQL = "select platform_auth.money_statement($1,$2,$3,$4,$5,$6) as r";

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

/** One definer call, one answer. A door that needs no audit row of its own — because it writes the
 *  audit row itself, inside its transaction — does not need a client to be held open for it. */
const read = async (sql: string, params: unknown[]) =>
  (await pool.query(sql, params as any[])).rows[0]?.r;

/**
 * 135's three count doors answer `{ok:false, error:'…', message:'…'}` and the message is already the
 *  sentence a clerk can act on — it names the run, the seat that raised it, the day it was signed and
 *  the number of attempts spent. So nothing here paraphrases it. The table below only decides which
 *  HTTP status the desk hears it under, and the `error` word travels in `details` so the web can
 *  branch on the fact rather than on the prose.
 *
 * Anything unrecognised is a 400 about the form rather than a 502: every branch of these doors that
 *  answers `ok:false` writes a message first, so a new word is a new refusal somebody typed, not a
 *  failure of the server.
 */
const COUNT_REFUSALS: Record<string, [string, number]> = {
  not_the_office: ["FORBIDDEN", 403],
  not_found: ["NOT_FOUND", 404],
  already_signed: ["CONFLICT", 409],
  signed_and_kept: ["CONFLICT", 409],
  same_seat: ["CONFLICT", 409],
  attempts_spent: ["CONFLICT", 409]
};

function countRefusal(j: any, fallback: string): ApiError | null {
  if (!j || typeof j !== "object" || j.ok !== false) return null;
  const words = typeof j.message === "string" && j.message.trim() ? j.message : fallback;
  const reason = String(j.error ?? "");
  const [code, status] = COUNT_REFUSALS[reason] ?? ["VALIDATION_FAILED", 400];
  return new ApiError(code, words, status, [{ reason: reason || null }]);
}

/**
 * 135's reads answer `{rows: [], error: '…'}` instead of raising, so an empty page is a fact the door
 *  decided and not a filter that found nothing. Three of its sentences are about the session or the
 *  window rather than the row, and the desk has to hear them differently: a seat that is not the
 *  office's book is a 403, a day that has not happened yet is a 400, anything else is the account or
 *  the run the desk quoted not being in this book.
 */
function readRefusal(j: any): ApiError | null {
  if (!j || typeof j !== "object" || typeof j.error !== "string" || !j.error.trim()) return null;
  const words = j.error;
  if (/not that (book|desk)/i.test(words)) return new ApiError("FORBIDDEN", words, 403);
  if (/no day|window runs backwards|which days/i.test(words)) {
    return new ApiError("VALIDATION_FAILED", words, 400);
  }
  return new ApiError("NOT_FOUND", words, 404);
}

/** A `date` column arrives as a Date at midnight in the server's own zone, so its JSON form lands on
 *  the day before east of Greenwich (090's lesson). The register prints the day as text already; the
 *  detail door hands back the column, so it is cut from the local parts that survive the trip. */
function dayOf(value: unknown): unknown {
  if (!(value instanceof Date)) return value;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
}

// ============================
// THE STATEMENT FILE
// ============================

/** 135 clamps a statement page to 500 legs; a file is walked a page at a time until the window's own
 *  `legs` count is spent. */
const STATEMENT_PAGE = 500;
/** Eight thousand legs on one line is years of the office's own book. A window wider than that is not
 *  a statement, it is a data dump, and the desk that asks for one wants a month at a time. */
const STATEMENT_MAX = 8000;
/** The printed page stops earlier for the reason `/exports/table` gives: a file that size is hundreds
 *  of pages of drawText on the API box, and Excel is the register for that. */
const STATEMENT_PDF_MAX = 3000;

/** The statement's own columns, in the order a ledger is read. `running` is text because a column that
 *  is a balance has no total — the writers add one to every numeric column, and a sum of running
 *  balances is a number that means nothing standing beside the closing figure that means everything. */
const STATEMENT_COLUMNS: PreparedTable["columns"] = [
  { key: "line", label: "Line", type: "text", width: 52 },
  { key: "day", label: "Day", type: "date", width: 92 },
  { key: "ref", label: "Movement", type: "text", width: 150 },
  { key: "memo", label: "Memo", type: "text", width: 240 },
  { key: "direction", label: "Side", type: "text", width: 66 },
  { key: "amount", label: "Amount", type: "money", width: 110 },
  { key: "moved", label: "In the account's own side", type: "money", width: 130 },
  { key: "running", label: "Running", type: "text", width: 110 },
  { key: "other_side", label: "Other side", type: "text", width: 150 },
  { key: "source_kind", label: "Source", type: "text", width: 96 },
  { key: "source_ref", label: "Source reference", type: "text", width: 140 },
  { key: "posting_status", label: "Status", type: "text", width: 80 },
  { key: "posted_by", label: "Posted by", type: "text", width: 140 },
  { key: "detail", label: "Leg detail", type: "text", width: 180 }
];

/** The door's own row shape, which is what a CSV is: every field a statement leg carries, named as the
 *  book names it, with no formatting a spreadsheet would have to undo. */
const STATEMENT_FIELDS = [...STATEMENT_COLUMNS.map((c) => c.key), "raised_at"];

/** The book's figures are `numeric(14,2)` and arrive through jsonb as numbers; a column the door did
 *  not print as text is asked to print itself before it reaches a page. */
function figure(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Walk the window. The refusal and the row ceiling both come from the first page's own header, so a
 *  file that cannot fit is refused before a single further query is spent on it. */
async function walkStatement(tenant: string, account: string, from: string, to: string,
  cap: number): Promise<{ head: Record<string, any>; rows: Record<string, any>[] }> {
  const head = await read(STATEMENT_SQL, [tenant, account, from, to, STATEMENT_PAGE, 0]);
  const refusal = readRefusal(head);
  if (refusal) throw refusal;
  const legs = Number(head.legs ?? 0);
  if (legs > cap) {
    throw new ApiError("VALIDATION_FAILED",
      `${head.code} moved ${legs} legs between ${from} and ${to}, and a statement file stops at `
      + `${cap}. Narrow the days, or read the register on the desk one page at a time.`, 413);
  }
  const rows: Record<string, any>[] = [...(head.rows ?? [])];
  for (let offset = rows.length; offset < legs; offset += STATEMENT_PAGE) {
    const page = await read(STATEMENT_SQL, [tenant, account, from, to, STATEMENT_PAGE, offset]);
    const more: Record<string, any>[] = page?.rows ?? [];
    if (!more.length) break;
    rows.push(...more);
  }
  return { head, rows };
}

function statementTable(head: Record<string, any>, rows: Record<string, any>[],
  actor: string, generatedAt: Date): PreparedTable {
  const cur = String(head.currency ?? "TZS");
  const drift = head.drift ?? {};
  const agrees = drift.agrees === null || drift.agrees === undefined
    ? "not checked (the window does not close today)"
    : drift.agrees ? "yes — the cached total equals this statement's closing figure"
      : `NO — cached ${moneyText(figure(drift.cached_balance) ?? 0)} ${cur} against `
        + `statement ${moneyText(figure(drift.statement_balance) ?? 0)} ${cur}`;
  return {
    report: "money-statement",
    title: `Statement of ${head.code}`,
    subtitle: `The office's own book, ${head.label}`,
    meta: [
      { label: "Account", value: `${head.code} — ${head.label} (${head.kind}, natural side `
        + `${head.natural_side})` },
      { label: "Currency", value: cur },
      { label: "Days", value: `${head.from_day} to ${head.to_day}` },
      { label: "Opening", value: `${moneyText(figure(head.opening) ?? 0)} ${cur}` },
      { label: "Debited", value: `${moneyText(figure(head.debited) ?? 0)} ${cur}` },
      { label: "Credited", value: `${moneyText(figure(head.credited) ?? 0)} ${cur}` },
      { label: "Moved", value: `${moneyText(figure(head.moved) ?? 0)} ${cur}` },
      { label: "Closing", value: `${moneyText(figure(head.closing) ?? 0)} ${cur}` },
      { label: "Legs in window", value: String(head.legs ?? 0) },
      { label: "Book agrees", value: agrees }
    ],
    columns: STATEMENT_COLUMNS,
    cells: rows.map((r) => [
      String(r.line ?? ""), r.day ?? null, r.ref ?? null, r.memo ?? null, r.direction ?? null,
      figure(r.amount), figure(r.moved),
      r.running === null || r.running === undefined ? null : moneyText(figure(r.running) ?? 0),
      r.other_side ?? null, r.source_kind ?? null, r.source_ref ?? null,
      r.posting_status ?? null, r.posted_by ?? null, r.detail ?? null
    ]),
    generatedAt,
    actor
  };
}

/** Control characters are legal in a memo typed at a desk, and a purpose that starts with an operator
 *  is a formula the moment the CSV reaches a spreadsheet — so text is neutralised. A figure is not: a
 *  statement's `moved` column is negative half the time, and `'-1,000` is a number a spreadsheet can
 *  no longer add. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function statementCsv(rows: Record<string, any>[]): string {
  return [STATEMENT_FIELDS.join(","),
  ...rows.map((r) => STATEMENT_FIELDS.map((f) => csvCell(r[f])).join(","))].join("\r\n");
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

  // ============================
  // THE COUNT — raise a run, read the pile, sign for a second seat, throw a draft away
  // ============================

  /**
   * The runs this book has already made, newest first, with the three worst exceptions folded onto
   * each row and the whole window's figures in the heading.
   *
   * A board that only said "12 findings, net 4,000.00" cannot be triaged from, so the door carries the
   * three lines an exception count is a name for; the rest is one read away in the detail.
   */
  app.get("/control/money/recon", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, RECON);
    await enforceRateLimit(`money-recon-board:${req.control.user_id}`, 240, 60);
    const q = z.object({
      scope: SCOPE.optional(),
      status: z.enum(["all", "open", "reviewed"]).default("all"),
      currency: currency.optional(),
      search: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    // `all` is the desk's word for "do not filter", not a scope a run can be filed under — so it is
    // answered here as a null. Left to the door, a board asked for `scope=all` would answer with an
    // empty pile, because no run is ever written with that word in its scope column.
    const j = await read(RECON_BOARD_SQL, [tenantOf(req),
      q.scope && q.scope !== "all" ? q.scope : null,
      q.status === "all" ? null : q.status, q.currency ?? null, q.search ?? null,
      q.limit, q.offset]);
    const refusal = readRefusal(j);
    if (refusal) throw refusal;
    return j;
  });

  /**
   * Ask the book and the papers the same question over a window of days, and write down everywhere
   * they disagree.
   *
   * `from` and `to` are the days the desk means, and the door refuses a window that runs backwards or
   * ends on a day that has not happened yet — both said in its own words, because either one is the
   * desk's typo and not the server's fault. The run is the office's own row: 135's checks read the
   * registers, never another company's book, and the answers travel as `details` so the desk can name
   * the scope that was refused without reading a sentence back to itself.
   *
   * The run is minted here and audited by the door that minted it, with the figures it used. A route
   * that filed its own audit row would give the office's history two versions of the same count.
   */
  app.post("/control/money/recon/run", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, RECON);
    await enforceRateLimit(`money-recon-run:${req.control.user_id}`, 12, 3600);
    const body = z.object({
      scope: SCOPE.default("all"),
      currency: currency.default("TZS"),
      from: DAY,
      to: DAY
    }).strict().parse(req.body ?? {});
    const j = await read(RECON_RUN_SQL, [tenantOf(req), body.scope, body.currency,
      realDay(body.from), realDay(body.to), req.control.user_id, role(req), req.ip, uaOf(req)]);
    const refusal = countRefusal(j, "The count could not be raised.");
    if (refusal) throw refusal;
    return j.run;
  });

  /** One run whole: every exception, the checks counted by name, and whether this desk may still sign. */
  app.get("/control/money/recon/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, RECON);
    await enforceRateLimit(`money-recon-detail:${req.control.user_id}`, 240, 60);
    const id = uuidOf(req.params.id, "count");
    const j = await read(RECON_DETAIL_SQL, [tenantOf(req), id]);
    const refusal = readRefusal(j);
    if (refusal) throw refusal;
    return j;
  });

  /**
   * Sign for a count another seat raised.
   *
   * The note is required and the door refuses it if it is shorter than eight characters, because the
   * sentence beside these figures months from now is the whole product of the second pair of eyes —
   * and the door refuses the seat that raised the run, which is the only reason a signature on a
   * report means anything. Both refusals arrive here as the door's own words.
   */
  app.post("/control/money/recon/:id/sign", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, RECON);
    await enforceRateLimit(`money-recon-sign:${req.control.user_id}`, 20, 3600);
    const id = uuidOf(req.params.id, "count");
    const body = z.object({ note: SENTENCE }).strict().parse(req.body ?? {});
    const j = await read(RECON_SIGN_SQL,
      [tenantOf(req), id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
    const refusal = countRefusal(j, "The count could not be signed.");
    if (refusal) throw refusal;
    return j.run;
  });

  /**
   * Throw a draft count away.
   *
   * A `POST …/discard` rather than a `DELETE`, because the reason is the row's remaining value: the
   * findings go with the run, so this sentence is the only thing that will explain the gap in the
   * numbering — and a DELETE whose body a proxy dropped would leave that gap with nothing beside it.
   * A signed run refuses: 135's guard keeps a paper somebody answered for.
   */
  app.post("/control/money/recon/:id/discard", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, RECON);
    await enforceRateLimit(`money-recon-discard:${req.control.user_id}`, 20, 3600);
    const id = uuidOf(req.params.id, "count");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body ?? {});
    const j = await read(RECON_DISCARD_SQL,
      [tenantOf(req), id, body.reason, req.control.user_id, role(req), req.ip, uaOf(req)]);
    const refusal = countRefusal(j, "The count could not be discarded.");
    if (refusal) throw refusal;
    return { status: "discarded", ref: j.discarded?.ref ?? null, discarded: j.discarded };
  });

  // ============================
  // THE STATEMENT — one line of the book over a window of days, on screen or on paper
  // ============================

  /** Both ends of a window, typed as the papers carry them, in the order the door wants them. */
  const windowOf = (q: { from: string; to: string }) => {
    const from = realDay(q.from);
    const to = realDay(q.to);
    if (from > to) {
      throw new ApiError("VALIDATION_FAILED",
        "The window runs backwards: the first day has to be the earlier one.", 400,
        [{ field: "to", message: "The end day is before the start day." }]);
    }
    return { from, to };
  };

  const STATEMENT_QUERY = z.object({ from: DAY, to: DAY }).strict();
  const STATEMENT_LIMIT = z.coerce.number().int().min(1).max(STATEMENT_PAGE).default(200);

  /**
   * One page of a statement, with the opening, the window's totals and the closing above it.
   *
   * The figures in the heading are the whole window's and not this page's — the door says so in its
   * own `basis` sentence — so a desk that paginates a statement never has to add anything up to find
   * the balance, which is the one thing a clerk is asked for.
   */
  app.get("/control/money/accounts/:id/statement", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-statement:${req.control.user_id}`, 120, 60);
    const q = z.object({
      from: DAY, to: DAY, limit: STATEMENT_LIMIT, offset: OFFSET
    }).strict().parse(req.query);
    const days = windowOf(q);
    const j = await read(STATEMENT_SQL, [tenantOf(req), uuidOf(req.params.id, "account"),
      days.from, days.to, q.limit, q.offset]);
    const refusal = readRefusal(j);
    if (refusal) throw refusal;
    return j;
  });

  /**
   * The same statement as a file, walked off the book rather than posted up from the desk.
   *
   * Three formats of one read: the CSV is the door's own row shape for anyone who will add up the
   * column themselves, and the workbook and the printed page carry the header figures the book
   * produced, so the closing balance on a file an accountant is handed is the closing balance the
   * office holds.
   *
   * This is the one route in the two new sections that files an audit row, and it is the one act here
   * that is not a definer door: the seat that printed the office's book out of it is a fact only the
   * route knows.
   */
  const statementFile = (ext: "csv" | "xlsx" | "pdf") => async (req: any, reply: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`money-statement-${ext}:${req.control.user_id}`, 20, 3600);
    const days = windowOf(STATEMENT_QUERY.parse(req.query));
    const account = uuidOf(req.params.id, "account");
    const { head, rows } = await walkStatement(tenantOf(req), account, days.from, days.to,
      ext === "pdf" ? STATEMENT_PDF_MAX : STATEMENT_MAX);

    const generatedAt = new Date();
    const table = statementTable(head, rows, String(req.control.full_name ?? req.control.user_id),
      generatedAt);
    const text = ext === "csv" ? statementCsv(rows) : null;
    const bytes = text === null
      ? await (ext === "pdf" ? buildPdf(table) : buildXlsx(table))
      : Buffer.from(text, "utf8");

    await withTenant(tenantOf(req), (c) => writeAudit(c, {
      tenantId: tenantOf(req), actorUserId: req.control.user_id, actorRole: role(req),
      ip: req.ip, userAgent: uaOf(req), requestId: req.requestId,
      entity: "money_accounts", entityId: account, action: `control.money.statement_${ext}`,
      before: null,
      after: { code: head.code, currency: head.currency, from_day: days.from, to_day: days.to,
        legs: head.legs, rows: rows.length, opening: head.opening, closing: head.closing,
        agrees: head.drift?.agrees ?? null, bytes: bytes.length }
    }));

    reply.header("Content-Disposition", `attachment; filename="${fileName(table, ext)}"`);
    reply.header("Cache-Control", "no-store");
    reply.type(ext === "pdf" ? "application/pdf"
      : ext === "csv" ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return bytes;
  };

  app.get("/control/money/accounts/:id/statement.csv",
    { preHandler: [requireControl] }, statementFile("csv"));
  app.get("/control/money/accounts/:id/statement.xlsx",
    { preHandler: [requireControl] }, statementFile("xlsx"));
  app.get("/control/money/accounts/:id/statement.pdf",
    { preHandler: [requireControl] }, statementFile("pdf"));
}
