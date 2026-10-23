import { createHash } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { decryptField, encryptField, searchHash } from "../util/crypto.js";
import { ZipWriter } from "../export/zip.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import {
  ANSWERS, CHECK_KINDS, CHECK_STATES, KIND_LABELS, OPEN_STATES, REFERENCE_MAX,
  EXPIRING_WORDS, normaliseReference, expiresOnKind, referenceTail, type CheckKind
} from "../customers/checks.js";
import {
  CATEGORIES, DATA_REQUEST_KINDS, HEX_PLAIN_NAMES, REQUEST_STATUSES,
  type DataCategory, type DataRequestKind
} from "../customers/data-request.js";

/**
 * The Customers desk (127 and 128; task #342) — who an account is, what the office has looked at,
 * what all of that is worth at the moment the question is asked, and, since 128, what the office
 * says when two accounts turn out to be one company or somebody else is signed in as you.
 *
 * The office already had three of the six things this module is asked for. A ban and its two
 * signatures are 078's and 121's, on `/control/tenants` and `/control/approvals`; the exit is
 * 086's churn register. What was missing, and is here, is the KYC queue, the office's own notes
 * and labels about an account, the trust read, and a timeline that tells one account's story out
 * of the trails that already exist.
 *
 * Three rules this file obeys rather than invents:
 *
 * **The state is in the table.** A terminal answer cannot be edited, a line cannot move to another
 * account, an approval without a number cannot exist, an expiry only belongs on the three kinds
 * that lapse, a note keeps its author, a label names a live pair. Every one of those is a CHECK or
 * a trigger in 127, so a refusal reaches the desk in the register's own words (see `guardRefusal`)
 * and a second route that writes the same row cannot drift from the first. What the handlers add is
 * the sentence, the duty, the limiter and the audit row — never a check the schema already makes.
 *
 * **An identity number is encrypted, and only its tail leaves a read.** No board, dossier, queue or
 * CSV returns a whole number: they return `reference_tail`, four characters, and a boolean that
 * says whether the line has a number at all. Reading the whole value is one route
 * (`GET /control/customers/checks/:id/reference`), gated on the duty that answers checks, limited to
 * twelve reads an hour per seat, and written into the audit register as it happens — with the tail
 * in the row, never the number, because an unmasked copy in `audit_logs` would only move the PII
 * somewhere with a longer retention.
 *
 * **A decision about an account's liberty is not this desk's.** Nothing here blocks, closes, or
 * releases money. A check line answers "is this paper what it says it is"; the verdict that stops a
 * company trading is a ban, and a ban is raised on `/control/approvals` and applied by a second
 * seat's signature. So this file holds no two-seat paper of its own — the four acts the office's
 * rule names (money, prices, bans, permission changes) live on the desks that already enforce it.
 * A KYC answer is single-seat on purpose: it is terminal, it names the seat that gave it, it cannot
 * be edited, and re-checking an account opens a new line beside the old one rather than replacing
 * it. That is what makes it answerable, which is what a second signature is for.
 *
 * 128 adds two more acts, and both obey the same rule rather than bending it. A duplicate is
 * **claimed**, never merged: the trigger will not accept a claim whose extra account is still live,
 * so the closure that has to come first is 078's two-seat act, and this desk only records what that
 * act already decided. And a cut-off ends sessions without shutting anybody out of the platform —
 * the person whose session ended signs in again, and the act that would stop them coming back is
 * still a block on the tenants desk. Neither needed a second signature: one is downstream of a
 * closure that had two, and the other is a minute-old answer to "somebody else has my password".
 *
 * The register is platform-owned, exactly as 101's and 126's are: `req.control.tenant_id` is the
 * office's tenant and the account a line is about sits beside it in `company_tenant_id`. Nothing
 * here reads a caller's phone number or password — an account is found by name, email or TIN.
 */

const VIEW = "control.customers.view";
const VERIFY = "control.customers.verify";
const MANAGE = "control.customers.manage";
/** 128's two duties. `merge` is kept apart from `manage` on purpose: the seat that can annotate an
 *  account is not thereby able to record that two accounts were one, because a claim leans on a
 *  closure that took two signatures elsewhere. `disconnect` is the cut-off, and the agent who takes
 *  "somebody else is in my account" must be able to end it without opening a second desk. */
const MERGE = "control.customers.merge";
const DISCONNECT = "control.customers.disconnect";
/** 129's two duties, and the split is the whole design of the tab. `gdpr` reads the register, opens
 *  a preview and hands a copy over — a bundle that holds the account's contact book, its drivers
 *  and the office's notes about it, which is not a duty for the desk that answers the phone.
 *  `erase` raises an erasure paper and asks for the signature; spending it is `control.approvals
 *  .decide` on another desk, held by a different seat. */
const GDPR = "control.customers.gdpr";
const ERASE = "control.customers.erase";

const SENTENCE = z.string().trim().min(8).max(600);
const NOTE_BODY = z.string().trim().min(4).max(2000);
const REFERENCE = z.string().trim().min(4).max(REFERENCE_MAX);
const LIMIT = z.coerce.number().int().min(1).max(100).default(30);
const OFFSET = z.coerce.number().int().min(0).default(0);
const SEARCH = z.string().trim().max(140).optional();
/** A day, as the desk chose it, sent to Postgres as text so a `date` column never goes through a
 *  JavaScript Date on the way in. Parsed at noon in the web for the same reason (094). */
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "give the day as YYYY-MM-DD");
const UUID = z.string().uuid();
/** `?closed=1` asks the picker for the accounts behind their tombstones. A flag rather than a
 *  boolean because a query string carries neither, and `z.coerce.boolean()` reads "false" as true. */
const CLOSED = z.enum(["1", "0"]).optional();

function uuidOf(value: unknown, what: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

/**
 * 127's guards refuse with 23514 (a row that is not allowed to exist), 23503 (a pointer at a line
 * that is not there) and P0001 (a definer that answered `conflict`); the three partial unique
 * indexes refuse with 23505. None of the five is a server fault and each trigger sentence was
 * written for the person at the desk, so the words go through as a 409 with only the table's name
 * taken off the front. A 23505 carries no sentence meant for a human — it names an index — so the
 * caller supplies what the clash means at that desk: `clash` is why the same write reaches three
 * different sentences, and a generic "a line like that exists" would send a clerk looking at the
 * wrong register.
 */
function guardRefusal(err: unknown, fallback: string, clash?: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT", clash ?? "The register already holds a row like that.", 409);
  }
  if (!["23514", "23503", "22023", "P0001", "42501"].includes(code)) return null;
  const raw = String((err as any)?.message ?? "");
  // A trigger's sentence is the register speaking, and a desk can act on it. The driver's own
  // "violates check constraint "customer_verifications_check3"" is a table complaining about a
  // number nobody outside a migration has read — so that shape answers with the caller's sentence
  // and leaves the constraint name in the error register, where it is useful.
  if (/violates (?:check|not-null|foreign key) constraint/.test(raw)) {
    return new ApiError("CONFLICT", fallback, 409);
  }
  const line = raw.split("\n")[0]
    .replace(/^(customer_verifications|customer_notes|customer_tags|customer_taggings|customer_duplicate_claims|customer_data_requests|documents):\s*/i, "");
  return new ApiError("CONFLICT", line || fallback, 409);
}

/**
 * 128's definers answer in the same three shapes — `ok`, `invalid` with a sentence written for the
 * person at the desk, `not_found` naming which side of a pair (or which claim, or which account)
 * the register has never seen. Mapping them once here is what keeps five routes from each inventing
 * its own HTTP code for the same refusal, and a definer's sentence is the only words a clerk acting
 * on a claim will ever read, so they go out unchanged.
 */
function definerRefusal(j: any): ApiError | null {
  if (!j || typeof j !== "object") return null;
  if (j.status === "ok") return null;
  if (j.status === "invalid") {
    return new ApiError("CONFLICT", String(j.message ?? "The register refused that."), 409);
  }
  if (j.status === "not_found") {
    if (j.side === "survivor" || j.side === "loser") {
      return new ApiError("NOT_FOUND",
        `${j.side === "survivor" ? "The account that would carry on" : "The account named as the extra one"} `
        + `is not one the office has (${String(j.id ?? "").slice(0, 8)}).`, 404);
    }
    if (j.claim) return new ApiError("NOT_FOUND", "That claim is not on the register.", 404);
    // 129's doors name the paper they were asked about rather than a side of a pair, because a
    // data request is one row: the desk typed its number into a box and the register has not seen it.
    if (j.request) {
      return new ApiError("NOT_FOUND",
        `No data request ${String(j.request).slice(0, 8)} on the register. It was never raised, or `
        + "it belongs to another office.", 404);
    }
    return new ApiError("NOT_FOUND",
      `No account ${String(j.company_id ?? "").slice(0, 8)} on the platform.`, 404);
  }
  return new ApiError("CONFLICT",
    String(j.message ?? "The register gave an answer this desk cannot read."), 409);
}

/** A reference the desk typed, checked against the kind it belongs to, and cut into the two halves
 *  the register stores: the bytes and the tail. */
function referencePair(kind: string, raw: string) {
  let value: string;
  try {
    value = normaliseReference(kind, raw);
  } catch (e) {
    throw new ApiError("VALIDATION_FAILED", (e as Error).message, 400, [{ field: "reference" }]);
  }
  return { encrypted: encryptField(value), tail: referenceTail(value) };
}

// ---------- the accounts the lines stand on ----------

/** One account, enough to name it and to say whether it can still be checked. Params: id. */
const ACCOUNT_SQL = `
  select t.id, t.name, t.type, t.status as account_status, t.slug, t.created_at, t.deleted_at,
         (t.phone_encrypted is not null) as phone_on_file,
         (t.tin_search is not null) as tin_on_file
    from tenants t
   where t.id = $1 and t.type <> 'platform'`;

/** The picker every write is opened from. Params: search. No phone, no TIN value, no email of a
 *  seat: a clerk finds an account by the name it trades under. */
const ACCOUNTS_SQL = `
  select t.id, t.name, t.type, t.status as account_status, t.slug, t.created_at,
         (select count(*)::int from customer_verifications c
           where c.company_tenant_id = t.id and c.status in ('awaiting','submitted')) as open_checks,
         (select count(*)::int from customer_verifications c
           where c.company_tenant_id = t.id and c.status = 'approved') as approved,
         (select count(*)::int from customer_notes n
           where n.company_tenant_id = t.id and n.tenant_id = $1 and n.voided_at is null) as notes,
         (select count(*)::int from customer_taggings g
           where g.company_tenant_id = t.id and g.tenant_id = $1 and g.deleted_at is null) as labels
    from tenants t
   where t.type in ('transporter','shipper','seeker') and t.deleted_at is null
     and ($2::text is null or t.name ilike '%' || $2 || '%'
          or t.email ilike '%' || $2 || '%' or t.slug ilike '%' || $2 || '%')
   order by t.created_at desc
   limit 25`;

/** The picker a duplicate claim chooses its extra account from. Params: search.
 *
 *  The live list above cannot serve this: a claim's loser is by definition already closed, so a
 *  clerk told to name the duplicate would be choosing from a list the account is not on. Nothing
 *  here is per-register — a tombstone is the same tombstone in every desk's eyes — and no check
 *  count is carried, because the account is shut and 128 refuses a claim on a survivor that is. */
const CLOSED_ACCOUNTS_SQL = `
  select t.id, t.name, t.type, t.status as account_status, t.slug, t.created_at, t.deleted_at
    from tenants t
   where t.type in ('transporter','shipper','seeker') and t.deleted_at is not null
     and ($1::text is null or t.name ilike '%' || $1 || '%' or t.slug ilike '%' || $1 || '%')
   order by t.deleted_at desc
   limit 25`;

// ---------- the check queue ----------

/** Params: register, state|null|'open', kind|null, search|null, limit, offset.
 *  Only the tail and a boolean leave this statement — never `reference_encrypted`. `open` is
 *  answered inside the statement rather than by filtering the page afterwards, because a desk that
 *  asked for open lines and got 30 rows of which four were open would read `total` as the number
 *  of open lines, and it is not. The `::int` is what makes the desk's `total: number` true: pg
 *  answers a bare `count(*)` as a bigint and JSON hands the page a string. */
const CHECKS_SQL = `
  select c.id, c.kind, c.status, c.reference_tail,
         to_char(c.expires_on, 'YYYY-MM-DD') as expires_on, c.reason, c.document_id,
         c.raised_at, ru.full_name as raised_name, c.decided_at, du.full_name as decided_name,
         c.company_tenant_id, t.name as company_name, t.type as company_type,
         (c.reference_encrypted is not null) as has_reference,
         count(*) over ()::int as total
    from customer_verifications c
    join tenants t on t.id = c.company_tenant_id
    left join users ru on ru.id = c.raised_by
    left join users du on du.id = c.decided_by
   where c.tenant_id = $1
     and ($2::text is null
          or ($2 = 'open' and c.status in ('awaiting','submitted'))
          or c.status = $2)
     and ($3::text is null or c.kind = $3)
     and ($4::text is null or t.name ilike '%' || $4 || '%'
          or t.email ilike '%' || $4 || '%' or c.reference_tail ilike '%' || $4 || '%')
   order by c.raised_at desc, c.id
   limit $5 offset $6`;

/** Params: register. The chips beside the queue, counted over the whole register. */
const CHECK_COUNTS_SQL = `
  select count(*)::int as total,
         count(*) filter (where c.status = 'awaiting')::int as awaiting,
         count(*) filter (where c.status = 'submitted')::int as submitted,
         count(*) filter (where c.status = 'approved')::int as approved,
         count(*) filter (where c.status in ('rejected','needs_more'))::int as refused,
         count(*) filter (where c.status = 'needs_more')::int as awaiting_more,
         count(*) filter (where c.status = 'approved' and c.expires_on is not null
                            and c.expires_on < current_date)::int as expired,
         count(distinct c.company_tenant_id)::int as accounts
    from customer_verifications c
   where c.tenant_id = $1`;

// ---------- the writes ----------

/** Params: register, company, kind, status, encrypted|null, tail|null, expires|null, document|null,
 *  actor. A raise never carries a reason: the table refuses an open line that holds one. */
const INSERT_CHECK_SQL = `
  insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
      reference_encrypted, reference_tail, expires_on, document_id, raised_by)
  values ($1, $2, $3, $4, $5::bytea, $6, $7::date, $8, $9)
  returning id, kind, status, reference_tail, to_char(expires_on, 'YYYY-MM-DD') as expires_on,
            document_id, raised_at, company_tenant_id`;

/** Paper has arrived, or been read. Params: line, register, encrypted|null, tail|null,
 *  expires|null, document|null. `status = 'awaiting'` in the WHERE is the desk's own version of
 *  127's rule that an answered line is finished: a line that has been approved does not go back to
 *  waiting because somebody pressed a button twice. */
const SUBMIT_CHECK_SQL = `
  update customer_verifications
     set status = 'submitted',
         reference_encrypted = coalesce($3::bytea, reference_encrypted),
         reference_tail = coalesce($4, reference_tail),
         expires_on = coalesce($5::date, expires_on),
         document_id = coalesce($6, document_id)
   where id = $1 and tenant_id = $2 and status = 'awaiting'
   returning id, kind, status, reference_tail, to_char(expires_on, 'YYYY-MM-DD') as expires_on`;

/** The terminal answer. Params: register, line, status, actor, reason|null, encrypted|null,
 *  tail|null, expires|null, document|null.
 *  Everything is `coalesce`d onto the stored value because the number is usually read when the
 *  paper arrives and only repeated when the seat that answers wants a different one. The table's
 *  CHECKs refuse an approval that ends up with neither a number nor, on the three kinds that
 *  lapse, a day — so a desk cannot answer "approved" on a line it never read. */
const DECIDE_CHECK_SQL = `
  update customer_verifications
     set status = $3, decided_by = $4, decided_at = now(), reason = $5,
         reference_encrypted = coalesce($6::bytea, reference_encrypted),
         reference_tail = coalesce($7, reference_tail),
         expires_on = coalesce($8::date, expires_on),
         document_id = coalesce($9, document_id)
   where id = $1 and tenant_id = $2 and status in ('awaiting','submitted')
   returning id, kind, status, reason, reference_tail, decided_at,
             to_char(expires_on, 'YYYY-MM-DD') as expires_on, company_tenant_id`;

/** Params: register, line. Read before the answer so a seat that presses twice is told which
 *  answer is already on the line, by whom, and when — rather than watching a button do nothing. */
const LINE_SQL = `
  select c.id, c.kind, c.status, c.reason, c.reference_tail, c.document_id, c.raised_at,
         to_char(c.expires_on, 'YYYY-MM-DD') as expires_on, c.company_tenant_id,
         (c.reference_encrypted is not null) as has_reference,
         (c.reference_encrypted) as encrypted,
         ru.full_name as raised_name, du.full_name as decided_name, c.decided_at
    from customer_verifications c
    left join users ru on ru.id = c.raised_by
    left join users du on du.id = c.decided_by
   where c.id = $1 and c.tenant_id = $2`;

const INSERT_NOTE_SQL = `
  insert into customer_notes (tenant_id, company_tenant_id, body, author)
  values ($1, $2, $3, $4)
  returning id, body, author, created_at`;

/** An edit keeps its author — 127's trigger says so and stamps `edited_at`. Params: register,
 *  note, body. */
const EDIT_NOTE_SQL = `
  update customer_notes set body = $3
   where id = $1 and tenant_id = $2 and voided_at is null
   returning id, body, author, created_at, edited_at`;

/** Params: register, note, actor, reason. */
const VOID_NOTE_SQL = `
  update customer_notes
     set voided_at = now(), voided_by = $3, void_reason = $4
   where id = $1 and tenant_id = $2 and voided_at is null
   returning id, body, voided_at, void_reason`;

/** The office's own words, across every account, so a clerk can search for a sentence rather than
 *  for the company it was written about. Params: register, state|null, search|null, limit, offset.
 *  A withdrawn note stays in the list — the withdrawal is the register's answer, and a desk that
 *  filters to `live` and finds nothing still has to be able to see that a note was taken off. */
const NOTE_LIST_SQL = `
  select n.id, n.body, n.created_at, n.edited_at, n.voided_at, n.void_reason,
         n.author, n.company_tenant_id, u.full_name as author_name,
         vu.full_name as voided_by_name, t.name as company_name, t.type as company_type,
         count(*) over ()::int as total
    from customer_notes n
    join tenants t on t.id = n.company_tenant_id
    left join users u on u.id = n.author
    left join users vu on vu.id = n.voided_by
   where n.tenant_id = $1
     and ($2::text is null or ($2 = 'live' and n.voided_at is null)
                          or ($2 = 'withdrawn' and n.voided_at is not null))
     and ($3::text is null or t.name ilike '%' || $3 || '%' or n.body ilike '%' || $3 || '%')
   order by n.created_at desc, n.id
   limit $4 offset $5`;

/** Params: register. */
const NOTE_COUNTS_SQL = `
  select count(*)::int as total,
         count(*) filter (where n.voided_at is null)::int as live,
         count(*) filter (where n.voided_at is not null)::int as withdrawn,
         count(*) filter (where n.edited_at is not null)::int as edited,
         count(distinct n.company_tenant_id)::int as accounts
    from customer_notes n where n.tenant_id = $1`;

const TAG_LIBRARY_SQL = `
  select g.id, g.name, g.colour, g.note, g.created_at, g.deleted_at,
         count(*) filter (where t.deleted_at is null)::int as live,
         count(*)::int as worn,
         count(*) over ()::int as total
    from customer_tags g
    left join customer_taggings t on t.tag_id = g.id
   where g.tenant_id = $1
     and ($2::text is null or ($2 = 'live' and g.deleted_at is null)
                          or ($2 = 'retired' and g.deleted_at is not null))
     and ($3::text is null or g.name ilike '%' || $3 || '%' or coalesce(g.note, '') ilike '%' || $3 || '%')
   group by g.id
   order by (g.deleted_at is not null), lower(g.name)
   limit $4 offset $5`;

/** Params: register. So the tab can say how big the library is when the filter box is empty. */
const TAG_COUNTS_SQL = `
  select count(*)::int as in_library,
         count(*) filter (where g.deleted_at is null)::int as live,
         count(*) filter (where g.deleted_at is not null)::int as retired
    from customer_tags g where g.tenant_id = $1`;

/** Params: register, tag. The retirement refusal says "3 accounts still wear that" — this is the
 *  read that names the three, so the desk can take the label off instead of arguing with the count. */
const TAG_WEARERS_SQL = `
  select tg.id as tagging_id, tg.company_tenant_id, tg.applied_at,
         t.name as company_name, t.type as company_type, t.status as account_status,
         u.full_name as applied_by_name
    from customer_taggings tg
    join tenants t on t.id = tg.company_tenant_id
    left join users u on u.id = tg.applied_by
   where tg.tenant_id = $1 and tg.tag_id = $2 and tg.deleted_at is null
   order by tg.applied_at desc
   limit 200`;

const INSERT_TAG_SQL = `
  insert into customer_tags (tenant_id, name, colour, note, created_by, updated_by)
  values ($1, lower($2), $3, $4, $5, $5)
  returning id, name, colour, note, created_at`;

/** Params: tag, register, actor. */
const RETIRE_TAG_SQL = `
  update customer_tags
     set deleted_at = now(), deleted_by = $3, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, name`;

/** How many live pairings hang off a label, counted before it is retired — the number that tells a
 *  desk whether retiring it is a tidy-up or a statement about forty companies. It is the same test
 *  as the `live` column of TAG_LIBRARY_SQL above, because a desk that reads "3" on the chip and is
 *  refused with "40 accounts still wear it" stops believing the chip. Params: register, tag. */
const TAGGING_COUNT_SQL = `
  select count(*)::int as live
    from customer_taggings g
   where g.tenant_id = $1 and g.tag_id = $2 and g.deleted_at is null`;

const APPLY_TAG_SQL = `
  insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
  values ($1, $2, $3, $4)
  returning id, company_tenant_id, tag_id, applied_at`;

/** Take a label off by retiring the pairing, not by removing it: who had this account marked
 *  `duplicate-kyc`, and when did they take it off, is the question a label answers when something
 *  went wrong. Params: register, company, tag, actor. */
const RETIRE_TAGGING_SQL = `
  update customer_taggings
     set deleted_at = now(), deleted_by = $4
   where tenant_id = $1 and company_tenant_id = $2 and tag_id = $3 and deleted_at is null
   returning id, tag_id, deleted_at`;

/** Params: register, company, tag. Read before the insert so two clerks clicking the same chip at
 *  once get "it already wears that" instead of a constraint name. The partial unique index stays
 *  the guard. */
const TAG_ON_ACCOUNT_SQL = `
  select g.id from customer_taggings g
   where g.tenant_id = $1 and g.company_tenant_id = $2 and g.tag_id = $3
     and g.deleted_at is null`;

// ---------- 128: the claims register, read ----------

/**
 * The claim register read back. Both halves are joined by name because a claim is only legible
 * with both: "closed account X is the extra one of Y". Params: register, state|null, search|null,
 * limit, offset. `state` means the same here as in the CSV, so a chip on the tab and the file
 * beside it cannot disagree.
 */
const CLAIM_LIST_SQL = `
  select c.id, c.status, c.reason, c.carried_kinds, c.raised_at, c.voided_at, c.void_reason,
         ru.full_name as raised_name, vu.full_name as voided_name,
         s.id as survivor_id, s.name as survivor_name, s.type as survivor_type,
         s.status as survivor_status,
         l.id as loser_id, l.name as loser_name, l.type as loser_type,
         l.status as loser_status, l.deleted_at as loser_closed_at,
         count(*) over ()::int as total
    from customer_duplicate_claims c
    join tenants s on s.id = c.survivor_tenant_id
    join tenants l on l.id = c.loser_tenant_id
    left join users ru on ru.id = c.raised_by
    left join users vu on vu.id = c.voided_by
   where c.tenant_id = $1
     and ($2::text is null or c.status = $2)
     and ($3::text is null or s.name ilike '%' || $3 || '%' or l.name ilike '%' || $3 || '%'
          or c.reason ilike '%' || $3 || '%')
   order by c.raised_at desc
   limit $4 offset $5`;

/** How many claims the register holds, in each state, so a tab can say what it filtered out of.
 *  Params: register. */
const CLAIM_COUNTS_SQL = `
  select count(*)::int as all,
         count(*) filter (where c.status = 'declared')::int as standing,
         count(*) filter (where c.status = 'voided')::int as withdrawn,
         count(*) filter (where c.status = 'declared' and c.carried_kinds <> '{}')::int as carried
    from customer_duplicate_claims c where c.tenant_id = $1`;

/** One claim with both accounts, for the void route's before-shape. Params: register, claim. */
const CLAIM_ONE_SQL = `
  select c.id, c.status, c.reason, c.carried_kinds, c.raised_at, c.raised_by, c.voided_at,
         c.void_reason, s.name as survivor_name, l.name as loser_name, l.deleted_at as loser_closed_at
    from customer_duplicate_claims c
    join tenants s on s.id = c.survivor_tenant_id
    join tenants l on l.id = c.loser_tenant_id
   where c.tenant_id = $1 and c.id = $2`;

/** The claim that already stands on a closed account, whichever survivor holds it. The partial
 *  unique index is the guard, but a 23505 answers with an index name; the desk needs the sentence
 *  that ends the conversation — this account is already somebody's extra one, and here is who.
 *  Params: register, loser. */
const CLAIM_STANDING_SQL = `
  select c.id, c.status, to_char(c.raised_at, 'YYYY-MM-DD') as raised_day,
         s.id as survivor_id, s.name as survivor_name
    from customer_duplicate_claims c
    join tenants s on s.id = c.survivor_tenant_id
   where c.tenant_id = $1 and c.loser_tenant_id = $2 and c.status = 'declared'`;

/** The open lines a survivor holds, so a claim's carry can be read back after the write instead of
 *  being taken on trust from the definer's own count. Params: register, company. */
const OPEN_KINDS_SQL = `
  select distinct c.kind from customer_verifications c
   where c.tenant_id = $1 and c.company_tenant_id = $2
     and c.status in ('awaiting','submitted') order by 1`;

// ---------- the CSV every tab is asked to carry ----------

/** Each export takes the same `search` the tab is showing. A desk that filters a register down to
 *  the four lines it cares about and is handed a file of every line in the table did not get what
 *  it asked for, and a desk that filters down to nothing and gets a full file believes the filter
 *  worked. Params: register, state|null, kind|null, search|null. */
const CHECK_EXPORT_SQL = `
  select c.id, t.name as company_name, t.type as company_type, c.kind, c.status,
         c.reference_tail, to_char(c.expires_on, 'YYYY-MM-DD') as expires_on, c.reason,
         ru.full_name as raised_name, c.raised_at, du.full_name as decided_name, c.decided_at,
         (c.reference_encrypted is not null) as has_reference
    from customer_verifications c
    join tenants t on t.id = c.company_tenant_id
    left join users ru on ru.id = c.raised_by
    left join users du on du.id = c.decided_by
   where c.tenant_id = $1
     and ($2::text is null
          or ($2 = 'open' and c.status in ('awaiting','submitted'))
          or c.status = $2)
     and ($3::text is null or c.kind = $3)
     and ($4::text is null or t.name ilike '%' || $4 || '%'
          or t.email ilike '%' || $4 || '%' or c.reference_tail ilike '%' || $4 || '%')
   order by c.raised_at desc`;

const NOTE_EXPORT_SQL = `
  select n.id, t.name as company_name, n.body, u.full_name as author_name, n.created_at,
         n.edited_at, vu.full_name as voided_by_name, n.voided_at, n.void_reason
    from customer_notes n
    join tenants t on t.id = n.company_tenant_id
    left join users u on u.id = n.author
    left join users vu on vu.id = n.voided_by
   where n.tenant_id = $1 and ($2::text is null or ($2 = 'live' and n.voided_at is null)
                               or ($2 = 'withdrawn' and n.voided_at is not null))
     and ($3::text is null or t.name ilike '%' || $3 || '%' or n.body ilike '%' || $3 || '%')
   order by n.created_at desc`;

const TAG_EXPORT_SQL = `
  select g.id, t.name as company_name, tg.name, tg.colour, u.full_name as applied_by_name,
         g.applied_at, vu.full_name as removed_by_name, g.deleted_at as removed_at
    from customer_taggings g
    join customer_tags tg on tg.id = g.tag_id
    join tenants t on t.id = g.company_tenant_id
    left join users u on u.id = g.applied_by
    left join users vu on vu.id = g.deleted_by
   where g.tenant_id = $1 and ($2::text is null or ($2 = 'live' and g.deleted_at is null)
                               or ($2 = 'retired' and g.deleted_at is not null))
     and ($3::text is null or t.name ilike '%' || $3 || '%' or tg.name ilike '%' || $3 || '%')
   order by g.applied_at desc`;

const CLAIM_EXPORT_SQL = `
  select t.name as survivor_name, l.name as loser_name, l.deleted_at as loser_closed_at,
         c.status, c.reason, array_to_string(c.carried_kinds, ' ') as carried_kinds,
         ru.full_name as raised_name, c.raised_at,
         vu.full_name as voided_name, c.voided_at, c.void_reason
    from customer_duplicate_claims c
    join tenants t on t.id = c.survivor_tenant_id
    join tenants l on l.id = c.loser_tenant_id
    left join users ru on ru.id = c.raised_by
    left join users vu on vu.id = c.voided_by
   where c.tenant_id = $1 and ($2::text is null or c.status = $2)
     and ($3::text is null or t.name ilike '%' || $3 || '%' or l.name ilike '%' || $3 || '%'
          or c.reason ilike '%' || $3 || '%')
   order by c.raised_at desc`;

// ---------- the data-request register (129) ----------

/** Every door on 129 is a definer that answers in JSON, so the route holds no SQL over these
 *  tables at all. Params are in the order each function declares them. */
/** Params: register, status|null|'all', kind|null|'all', search|null, limit, offset. */
const DATA_REQUESTS_SQL =
  "select platform_auth.data_requests_board($1,$2,$3,$4,$5,$6) as b";
/** Params: request. */
const DATA_REQUEST_SQL = "select platform_auth.data_request_detail($1) as d";
/** Params: company, kind. */
const DATA_PREVIEW_SQL = "select platform_auth.data_request_preview($1,$2) as p";
/** Params: register, company, kind, categories, reason, asked_in, actor, role, ip. */
const RAISE_REQUEST_SQL =
  "select platform_auth.raise_data_request($1,$2,$3,$4,$5,$6,$7,$8,$9) as j";
/** Params: request, reason, actor, role, ip, ua. */
const PROPOSE_ERASURE_SQL =
  "select platform_auth.propose_data_erasure($1,$2,$3,$4,$5,$6) as j";
/** Params: request, note, actor, role, ip, ua. */
const REFUSE_REQUEST_SQL =
  "select platform_auth.refuse_data_request($1,$2,$3,$4,$5,$6) as j";
/** Params: request, register. The copy is one read: 129's own words on why. */
const DATA_EXPORT_SQL = "select platform_auth.data_export($1,$2) as e";
/** Params: request, actor, role, ip, sha256, bytes, entries. */
const STAMP_DELIVERY_SQL =
  "select platform_auth.mark_data_request_delivered($1,$2,$3,$4,$5,$6,$7) as j";

/** One section of the copy, exactly as `data_export` hands it over. */
type CopySection = {
  key: string; label?: string; held?: number; truncated?: boolean;
  withheld?: string; rows?: Record<string, unknown>[];
};

/** The register's category counts, flattened for a spreadsheet cell: `account=1 seats=12`. */
const pairsCell = (j: unknown) => {
  if (!j || typeof j !== "object") return "";
  return Object.entries(j as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v ?? 0)}`).join(" ");
};

/** The keeps record, flattened to the keys it names — the count per key is in the JSON the desk
 *  already returned, and a CSV cell that holds twelve sentences is a cell nobody reads. */
const keepsCell = (j: unknown) => {
  if (!Array.isArray(j)) return "";
  return j.map((k: any) => k?.key).filter(Boolean).join(" ");
};

/**
 * A stored value, read back from the hex the definer was forced to hand over.
 *
 * The key lives in the API and not in Postgres, so `data_export` can only carry ciphertext (its
 * own comment says so). This is the one place the plain value appears, in the bundle a data subject
 * is owed — never in a response body, a log line or an audit row. `null` means the column is empty;
 * `undefined` means the bytes did not decrypt with this deployment's key, which the README states
 * rather than hides, because a blank cell in a copy is exactly the thing a supervisory authority
 * asks about.
 */
function readPlain(hex: unknown): string | null | undefined {
  if (hex === null || hex === undefined) return null;
  const s = String(hex);
  if (!/^[0-9a-f]{8,}$/i.test(s)) return undefined;
  try {
    return decryptField(Buffer.from(s, "hex"));
  } catch {
    return undefined;
  }
}

/** A section's rows with every `*_hex` column replaced by the value it hides, under the name a
 *  subject reads. An unknown `*_hex` key is kept and counted as unread rather than dropped: the
 *  manifest would otherwise claim a field the bundle never carried. */
function plainRows(rows: Record<string, unknown>[], unread: string[]) {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const plainName = HEX_PLAIN_NAMES[key as keyof typeof HEX_PLAIN_NAMES];
      if (!plainName) {
        if (key.endsWith("_hex")) unread.push(key);
        out[key] = value;
        continue;
      }
      const plain = readPlain(value);
      if (plain === undefined) unread.push(key);
      out[plainName] = plain ?? null;
    }
    return out;
  });
}

/** Header order a sheet is written in: the union of the keys, in the order they first appear. */
function keysOf(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/** A folder name out of a label a person typed into a migration. Anything that is not a letter or
 *  a digit is a dash, so an entry name cannot carry `../` into the archive (`safeEntryPath` in
 *  113's writer refuses those, and a name that never needed refusing is better). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // A note and a reason are typed by whoever sat at the desk, and a cell that starts with an
  // operator is a formula the moment the CSV reaches a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** A column name is this file's own word, not a value somebody typed, so it is written bare: a
 *  quoted header is what makes a spreadsheet show `"ref"` in the first row and a script looking for
 *  a column named `ref` find nothing. A name that does carry a comma or a quote still gets the cell
 *  treatment, because at that point it is not a name. */
const csvHead = (h: string) => (/[",\r\n]/.test(h) ? csvCell(h) : h);

const csv = (head: string[], rows: Record<string, unknown>[]): string => [
  head.map(csvHead).join(","),
  ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))
].join("\r\n");

const REGISTERS = ["accounts", "checks", "notes", "tags", "claims", "requests"] as const;

/** The board walks the definer a page at a time, so an export carries the whole filtered queue and
 *  not the twenty-five rows a screen asked for. Params: register, search, tin|null, status|null,
 *  kind|null, limit, offset. */
async function boardRows(tenant: string, search: string | null, tin: string | null,
  status: string | null, kind: string | null) {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const { rows } = await pool.query(
      "select platform_auth.customer_board($1,$2,$3,$4,$5,100,$6) as b",
      [tenant, search, tin, status, kind, offset]);
    const page = (rows[0]?.b?.rows ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

/** The data-request board, walked a page at a time for the same reason as the one above: a clerk
 *  who exports the register wants every ask the office is holding, not the thirty on the screen.
 *  Params: register, status|null|'all', kind|null|'all', search|null. */
async function requestRows(tenant: string, status: string | null, kind: string | null,
  search: string | null) {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const { rows } = await pool.query(DATA_REQUESTS_SQL,
      [tenant, status, kind, search, 100, offset]);
    const page = (rows[0]?.b?.rows ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

/** 129's two definers record the device the ask was made from, the same column 121 caps at 300
 *  characters. It is a header, so it is capped here rather than trusted. */
const uaOf = (req: any) => String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null;

/**
 * The one file in the copy that needs no software to read.
 *
 * Article 15 asks for a structured, machine-readable copy, and the CSV and JSON beside it are that.
 * Seventeen sheets are not an answer to the person who asked "what do you hold on me", so the README
 * states the request the archive answers, the minute the bytes were taken, what each part holds and
 * every cap the register applied — read out of the manifest rather than the definer's sections, so
 * the counts a person sees here cannot disagree with the files they are checking them against.
 */
function dataCopyReadme(
  e: Record<string, any>, manifest: Record<string, unknown>[],
  unread: string[], generatedAt: Date): string {
  const req = (e.request ?? {}) as Record<string, any>;
  const company = (e.company ?? {}) as Record<string, any>;
  const cap = Number(e.cap ?? 0);
  const when = generatedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const rows = manifest as { key: string; label: string; held: number; rows_written: number;
    truncated: boolean; withheld: string | null; csv: string; json: string }[];
  const lines: string[] = [
    "Waisha — a copy of the data held about this account",
    "".padEnd(52, "="),
    "",
    `Copy made          ${when}`,
    `Request            ${req.ref ?? "—"}`,
    `Account            ${company.name ?? "—"}${company.type ? ` (${company.type})` : ""}`,
    `Account ID         ${company.id ?? "—"}`,
    company.closed_at
      ? `Account closed     ${String(company.closed_at).slice(0, 16).replace("T", " ")} UTC`
      : "Account closed     not closed — this copy is of a live account",
    `Raised             ${req.raised_at ? String(req.raised_at).slice(0, 16).replace("T", " ") + " UTC" : "—"} by ${req.raised_by ?? "the office"}`,
    `Asked in           ${req.asked_in ?? "the office did not record how the ask arrived"}`,
    `Reason on the file ${req.reason ?? "—"}`,
    "",
    "HOW THIS ARCHIVE IS PUT TOGETHER",
    "".padEnd(34, "-"),
    "Every part of the copy is here twice: a .csv that opens in a spreadsheet and a .json that",
    "carries the same rows exactly as the register answered them. Both are under sections/.",
    "Nothing was chosen out of the answer. Where a part could not be carried whole, the line",
    "below says so and gives the number the register actually holds.",
    // The ceiling is the definer's own, carried out with the rows — a README that promised a cap
    // the SQL does not apply would be a document lying about the copy.
    ...(cap > 0 ? [
      `No part of this copy carries more than ${cap} rows. Where the register holds more than`,
      `that, the line below says "cut at ${cap}" and gives the number actually held, and the`,
      "remainder is still on the register — ask for it by the request number above."
    ] : []),
    "",
    `WHAT IS IN IT (${rows.length} parts)`,
    "".padEnd(24, "-")
  ];
  rows.forEach((s, i) => {
    const held = Number(s.held ?? 0);
    const written = Number(s.rows_written ?? 0);
    const state = s.truncated
      ? `${written} of ${held} rows (cut at ${cap})`
      : held === written ? `${written} row${written === 1 ? "" : "s"}`
        : `${written} of ${held} rows`;
    lines.push(`${String(i + 1).padStart(2, " ")}. ${s.label} — ${state}`);
    if (s.withheld) lines.push(`    Held back: ${String(s.withheld).replace(/\s+/g, " ").trim()}`);
    if (held === 0) lines.push("    Nothing on this register for this part.");
  });

  lines.push("", "ENCRYPTED VALUES", "".padEnd(16, "-"));
  if (unread.length === 0) {
    lines.push("The account's TIN, the phone numbers, the NIDA numbers and the identity numbers on");
    lines.push("the office's checks are stored encrypted. They are opened here, in plain text, and");
    lines.push("written into the sheets under those names.");
  } else {
    lines.push("These columns were handed to the copy still encrypted and could not be opened with");
    lines.push(`this deployment's key: ${[...new Set(unread)].join(", ")}. Their cells are empty.`);
    lines.push("Say so to the office and quote the request number above — an empty cell in a copy");
    lines.push("is a thing that has to be answered, not a gap to be quietly accepted.");
  }

  lines.push("", "CHECKING THIS COPY", "".padEnd(16, "-"));
  lines.push("manifest.json   every part, its row count, its cap and what it withheld.");
  lines.push("SHA256SUMS.txt  the checksum of every file above. From inside the unzipped archive:");
  lines.push("                  sha256sum -c SHA256SUMS.txt");
  lines.push("The platform keeps the SHA-256 of this whole archive against the request number, so");
  lines.push("a copy produced later can be proved to be — or not be — the one handed over now.");

  lines.push("", "IF SOMETHING IS MISSING OR WRONG", "".padEnd(29, "-"));
  lines.push("Quote the request number above to the office. Rectification is Article 16 and needs no");
  lines.push("form. Erasure is Article 17: it is raised as its own request on this register, it names");
  lines.push("the categories it reaches, and inside the platform a second person has to sign it");
  lines.push("before any value is masked. Refusing an ask is also written on the register, with the");
  lines.push("reason, so the answer a caller was given can be read back later.");
  return lines.join("\n") + "\n";
}

/** A trust number flattened enough for a spreadsheet: the score, the band and the factors as one
 *  readable line. The register does not store a score, so an export that carried one per row would
 *  be a copy that disagrees with the desk by Friday. */
const trustCell = (row: Record<string, unknown>) => {
  const t = row.trust as { score?: number; band?: string; factors?: { label: string; points: number }[] } | undefined;
  if (!t || typeof t.score !== "number") return "";
  const factors = (t.factors ?? []).slice(0, 4).map((f) =>
    `${f.points > 0 ? "+" : ""}${f.points} ${f.label}`).join("; ");
  return `${t.score} (${t.band ?? "—"}${factors ? ` — ${factors}` : ""})`;
};

export async function controlCustomersRoutes(app: FastifyInstance, _opts: unknown) {
  const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
  const tenantOf = (req: any) => req.control.tenant_id as string;

  /** A plain audit row: this register has no event table of its own, because 127's lines already
   *  carry who raised them, who answered them and when — the audit row is the act, the line is the
   *  answer. */
  const audit = async (c: PoolClient, req: any, entity: string, id: string,
    action: string, before: unknown, after: unknown) => {
    await writeAudit(c, {
      tenantId: tenantOf(req), actorUserId: req.control.user_id, actorRole: role(req),
      ip: req.ip, requestId: req.requestId, userAgent: req.headers["user-agent"] ?? null,
      entity, entityId: id, action, before, after
    });
  };

  /** The account a write is about. Read on the office's transaction so the guard's sentence about
   *  a closed or platform account is the register's, not this handler's guess. */
  const account = async (c: PoolClient, id: string) => {
    const r = await c.query(ACCOUNT_SQL, [id]);
    if (!r.rowCount) throw new ApiError("NOT_FOUND", `No account ${id} on the platform.`, 404);
    return r.rows[0];
  };

  const line = async (c: PoolClient, id: string, tenant: string) => {
    const r = await c.query(LINE_SQL, [id, tenant]);
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "That check is not on the register.", 404);
    return r.rows[0];
  };

  /** A line as it may leave the API. `LINE_SQL` carries the encrypted number so the reveal route
   *  has something to decrypt; every other read of the same row returns the tail and the boolean
   *  and nothing else, so one forgotten `delete` cannot put a NIDA number in a board response. */
  const shown = (r: any) => {
    const { encrypted, ...rest } = r;
    return rest;
  };

  // ============================================================
  // the board, the queue and one account
  // ============================================================

  app.get("/control/customers/board", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-board:${req.control.user_id}`, 120, 60);
    const q = z.object({
      search: SEARCH, tin: z.string().trim().regex(/^\d{6,20}$/).optional(),
      status: z.enum(["waiting", "refused", "expired", "clear", "none"]).or(z.literal("all")).optional(),
      kind: z.enum(CHECK_KINDS).optional(), limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    // A TIN is typed into a search box and searched as a hash, exactly as 078's lookup does: the
    // column is encrypted, so there is nothing to compare the plain text against.
    const tinHash = q.tin ? searchHash(q.tin) : null;
    const { rows } = await pool.query(
      "select platform_auth.customer_board($1,$2,$3,$4,$5,$6,$7) as b",
      [tenantOf(req), q.search || null, tinHash,
        q.status && q.status !== "all" ? q.status : null, q.kind ?? null, q.limit, q.offset]);
    return rows[0].b;
  });

  app.get("/control/customers/accounts", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-accounts:${req.control.user_id}`, 120, 60);
    const q = z.object({ search: SEARCH, account: UUID.optional(), closed: CLOSED })
      .parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      if (q.account) return { rows: [await account(c, q.account)] };
      if (q.closed === "1") {
        const r = await c.query(CLOSED_ACCOUNTS_SQL, [q.search || null]);
        return { rows: r.rows };
      }
      const r = await c.query(ACCOUNTS_SQL, [tenant, q.search || null]);
      return { rows: r.rows };
    });
  });

  // The queue every clerk opens first: lines, not accounts. The board answers "who is not clear";
  // this answers "what does the office still owe an answer on, and what did it say last time".
  app.get("/control/customers/checks", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-checks:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(CHECK_STATES).or(z.literal("open")).or(z.literal("all")).optional(),
      kind: z.enum(CHECK_KINDS).optional(), search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    const state = !q.status || q.status === "all" ? null : q.status;
    return withTenant(tenant, async (c) => {
      const rows = await c.query(CHECKS_SQL, [tenant, state, q.kind ?? null, q.search || null,
        q.limit, q.offset]);
      const counts = (await c.query(CHECK_COUNTS_SQL, [tenant])).rows[0];
      return { rows: rows.rows, counts };
    });
  });

  app.get("/control/customers/checks/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "check line");
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const l = await line(c, id, tenant);
      return shown(l);
    });
  });

  /** Everything this register knows about one account, plus the account's own filed papers, its
   *  seats, 078's actions and 086's exit — read through 127's definer because the answer spans
   *  tenants and `pool.query` has no `app.tenant_id` to hand RLS. */
  app.get("/control/customers/:id/dossier", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-dossier:${req.control.user_id}`, 120, 60);
    const id = uuidOf(req.params.id, "account");
    const { rows } = await pool.query("select platform_auth.customer_dossier($1,$2) as d",
      [tenantOf(req), id]);
    const d = rows[0]?.d;
    if (!d || d.status !== "ok") throw new ApiError("NOT_FOUND", `No account ${id}.`, 404);
    return d;
  });

  /** One account's story, assembled from the trails that already exist. */
  app.get("/control/customers/:id/timeline", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-timeline:${req.control.user_id}`, 120, 60);
    const q = z.object({
      // The words are the definer's own `source` values, not this file's guesses: `customer_timeline`
      // filters with `source = p_kind`, so a chip named for a source it never emits shows an empty
      // story and reads as "nothing happened to this account".
      source: z.enum(["account", "decision", "verification", "note", "tag", "call", "service",
        "exit", "office"]).or(z.literal("all")).optional(),
      limit: z.coerce.number().int().min(1).max(300).default(80)
    }).parse(req.query ?? {});
    const id = uuidOf(req.params.id, "account");
    const { rows } = await pool.query(
      "select platform_auth.customer_timeline($1,$2,$3) as t",
      [id, q.source && q.source !== "all" ? q.source : null, q.limit]);
    const t = rows[0]?.t;
    if (!t || t.status !== "ok") throw new ApiError("NOT_FOUND", `No account ${id}.`, 404);
    return t;
  });

  // ============================================================
  // raising and answering a check
  // ============================================================

  /**
   * Open a line. The kind is chosen from five, never typed, and the number is optional: a check
   * that has only just been asked for has no paper to read yet, and a desk forced to invent a
   * number to open the queue would type the one from last year's file.
   */
  app.post("/control/customers/:id/checks", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-check-open:${req.control.user_id}`, 40, 3600);
    const companyId = uuidOf(req.params.id, "account");
    const body = z.object({
      kind: z.enum(CHECK_KINDS),
      status: z.enum(OPEN_STATES).default("awaiting"),
      reference: REFERENCE.optional(),
      expiresOn: DAY.optional(),
      documentId: UUID.optional()
    }).strict().refine(
      (b) => !b.expiresOn || expiresOnKind(b.kind),
      { message: `Only a ${EXPIRING_WORDS} carries a day. A national ID and a TIN do not lapse here.`,
        path: ["expiresOn"] }
    ).parse(req.body);
    const tenant = tenantOf(req);
    const pair = body.reference ? referencePair(body.kind, body.reference) : null;
    if (body.expiresOn && body.expiresOn < "1900-01-01") {
      throw new ApiError("VALIDATION_FAILED", "That day is not a day a licence was issued on.",
        400, [{ field: "expiresOn" }]);
    }

    return withTenant(tenant, async (c) => {
      const company = await account(c, companyId);
      // Read first, so the refusal names the line standing in front of the clerk instead of the
      // index that stopped the insert. The partial unique index stays the guard for two seats that
      // raise the same check in the same second.
      const open = await c.query(
        `select id, status, raised_at from customer_verifications
          where tenant_id = $1 and company_tenant_id = $2 and kind = $3
            and status in ('awaiting','submitted')`,
        [tenant, companyId, body.kind]);
      if (open.rowCount) {
        throw new ApiError("CONFLICT",
          `${KIND_LABELS[body.kind as CheckKind]} on ${company.name} is already ${open.rows[0].status}, raised `
          + `${new Date(open.rows[0].raised_at).toLocaleDateString("en-GB")}. Answer that line `
          + "before opening a second one.", 409, [{ field: "kind" }]);
      }
      let made;
      try {
        made = await c.query(INSERT_CHECK_SQL, [tenant, companyId, body.kind, body.status,
          pair?.encrypted ?? null, pair?.tail ?? null, body.expiresOn ?? null,
          body.documentId ?? null, req.control.user_id]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that check.",
          "That account already has an open line for this kind. Answer it first, then raise a "
          + "second one — a decided line stays as history beside it.") ?? e;
      }
      const row = made.rows[0];
      await audit(c, req, "customer_verifications", row.id, "control.customers.check_raised", null, {
        company_tenant_id: companyId, company_name: company.name, kind: row.kind,
        status: row.status, reference_tail: row.reference_tail ?? null,
        expires_on: row.expires_on ?? null, document_id: row.document_id ?? null
      });
      return reply.code(201).send({
        check: shown(await line(c, row.id, tenant)),
        account: { id: company.id, name: company.name, type: company.type,
          account_status: company.account_status }
      });
    });
  });

  /** The paper reached the office. Params are the values read off it, because the seat that takes
   *  the envelope is usually the first one to have the number in front of it. */
  app.post("/control/customers/checks/:id/submit", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-check-submit:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "check line");
    const body = z.object({
      reference: REFERENCE.optional(),
      expiresOn: DAY.optional(),
      documentId: UUID.optional()
    }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const before = await line(c, id, tenant);
      if (before.status !== "awaiting") {
        throw new ApiError("CONFLICT",
          before.status === "submitted"
            ? "That paper is already in and waiting on an answer."
            : `${KIND_LABELS[before.kind as CheckKind]} was answered ${before.status} on ${
                new Date(before.decided_at).toLocaleDateString("en-GB")
              } — an answer is kept. Raise a new line to check it again.`,
          409);
      }
      if (body.expiresOn && !expiresOnKind(before.kind)) {
        throw new ApiError("VALIDATION_FAILED",
          `A ${KIND_LABELS[before.kind as CheckKind]} does not lapse on this register, so it cannot `
          + `carry a day. Only a ${EXPIRING_WORDS} does.`, 400, [{ field: "expiresOn" }]);
      }
      const pair = body.reference ? referencePair(before.kind, body.reference) : null;
      let done;
      try {
        done = await c.query(SUBMIT_CHECK_SQL, [id, tenant, pair?.encrypted ?? null,
          pair?.tail ?? null, body.expiresOn ?? null, body.documentId ?? null]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that paper.") ?? e;
      }
      await audit(c, req, "customer_verifications", id, "control.customers.check_submitted",
        { status: before.status, reference_tail: before.reference_tail },
        { status: "submitted", reference_tail: done.rows[0].reference_tail ?? null,
          expires_on: done.rows[0].expires_on ?? null, document_id: body.documentId ?? null });
      return done.rows[0];
    });
  });

  /**
   * Answer a line — the act the desk exists for.
   *
   * One seat, and 127's trigger then keeps it: the answer cannot be edited into a different answer,
   * so the name on this write is the name the office will quote in three years. `approved` refuses
   * to be written on a line that has no number, because an approval that cannot say which paper it
   * read is an opinion, and the CHECK says so in the table rather than in a handler that the next
   * route would not copy.
   */
  app.post("/control/customers/checks/:id/decide", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VERIFY);
    await enforceRateLimit(`customers-check-decide:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "check line");
    const body = z.object({
      status: z.enum(ANSWERS),
      reason: SENTENCE.optional(),
      reference: REFERENCE.optional(),
      expiresOn: DAY.optional(),
      documentId: UUID.optional()
    }).strict().refine(
      (b) => b.status === "approved" || !!b.reason,
      { message: "A refusal, or an answer of ‘send more’, has to say what was wrong. "
        + "The account is told those words.", path: ["reason"] }
    ).parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const before = await line(c, id, tenant);
      if (!OPEN_STATES.includes(before.status)) {
        throw new ApiError("CONFLICT",
          `That line was answered ${before.status} on ${new Date(before.decided_at)
            .toLocaleDateString("en-GB")}${before.decided_name ? ` by ${before.decided_name}` : ""}. `
          + "An answer is kept — to check this account again, raise a new line.", 409);
      }
      const pair = body.reference ? referencePair(before.kind, body.reference) : null;
      // An approval that cannot say which paper it read is an opinion, and the table's CHECK says
      // so — but a constraint name is not a sentence a desk can act on, so the number is asked for
      // here first, before the day the kind also needs.
      if (body.status === "approved" && !pair && !before.has_reference) {
        throw new ApiError("VALIDATION_FAILED",
          `An approval has to name the ${KIND_LABELS[before.kind as CheckKind]} it read. Type the `
          + "number from the paper, or open the line that holds it, before answering.",
          400, [{ field: "reference" }]);
      }
      if (body.expiresOn && !expiresOnKind(before.kind)) {
        throw new ApiError("VALIDATION_FAILED",
          `A ${KIND_LABELS[before.kind as CheckKind]} does not lapse on this register, so it cannot `
          + `carry a day. Only a ${EXPIRING_WORDS} does.`, 400, [{ field: "expiresOn" }]);
      }
      // A number read for the first time at the answer has to be typed with its day when the kind
      // needs one, so the desk is told here rather than after the trigger has refused.
      if (body.status === "approved" && expiresOnKind(before.kind)
        && !body.expiresOn && !before.expires_on) {
        throw new ApiError("VALIDATION_FAILED",
          `A ${KIND_LABELS[before.kind as CheckKind]} approval needs the day it runs out, `
          + "because that is the next thing the office has to watch.", 400, [{ field: "expiresOn" }]);
      }
      let done;
      try {
        done = await c.query(DECIDE_CHECK_SQL, [id, tenant, body.status, req.control.user_id,
          body.reason ?? null, pair?.encrypted ?? null, pair?.tail ?? null,
          body.expiresOn ?? null, body.documentId ?? null]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that answer.") ?? e;
      }
      if (!done.rowCount) {
        // Somebody answered it between the read and the write. The line is re-read so the desk sees
        // the answer that beat them rather than a 409 about nothing.
        const now = await line(c, id, tenant);
        throw new ApiError("CONFLICT",
          `That line is now ${now.status} — answered${now.decided_name ? ` by ${now.decided_name}` : ""}.`, 409);
      }
      const row = done.rows[0];
      await audit(c, req, "customer_verifications", id, "control.customers.check_decided",
        { status: before.status, reference_tail: before.reference_tail ?? null,
          expires_on: before.expires_on ?? null },
        { status: row.status, reason: row.reason, reference_tail: row.reference_tail ?? null,
          expires_on: row.expires_on ?? null, decided_at: row.decided_at });
      return row;
    });
  });

  /**
   * Read a whole identity number.
   *
   * The only door in the platform that decrypts a check reference. Gated on the duty that answers
   * checks — the seat allowed to certify a number is the seat allowed to see it — limited to twelve
   * reads an hour, and written into the audit register before the value goes out, with the kind and
   * the tail and never the number itself. A desk that reveals a number to tell the account what is
   * on file is doing its job, and that is exactly the act a platform has to be able to list
   * afterwards.
   */
  app.get("/control/customers/checks/:id/reference",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, VERIFY);
      await enforceRateLimit(`customers-reference-reveal:${req.control.user_id}`, 12, 3600);
      const id = uuidOf(req.params.id, "check line");
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const l = await line(c, id, tenant);
        if (!l.has_reference) {
          throw new ApiError("NOT_FOUND",
            `Nothing was ever written on that line — ${l.kind} is still ${l.status} with no number `
            + "read off a paper.", 404);
        }
        const reference = decryptField(l.encrypted as Buffer);
        await audit(c, req, "customer_verifications", id, "control.customers.reference_revealed",
          null, { kind: l.kind, reference_tail: l.reference_tail, company_tenant_id: l.company_tenant_id });
        return {
          id, kind: l.kind, status: l.status, reference,
          reference_tail: l.reference_tail, company_tenant_id: l.company_tenant_id
        };
      });
    });

  // ============================================================
  // the office's own words about an account
  // ============================================================

  /** The notes register across accounts — the tab a clerk opens to search for a sentence. The
   *  per-account list comes with the dossier; this is the same rows seen sideways. */
  app.get("/control/customers/notes", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-notes:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(["live", "withdrawn"]).or(z.literal("all")).optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const rows = await c.query(NOTE_LIST_SQL, [tenant,
        q.status && q.status !== "all" ? q.status : null, q.search || null, q.limit, q.offset]);
      const counts = (await c.query(NOTE_COUNTS_SQL, [tenant])).rows[0];
      return { rows: rows.rows, counts };
    });
  });

  app.post("/control/customers/:id/notes", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-note:${req.control.user_id}`, 60, 3600);
    const companyId = uuidOf(req.params.id, "account");
    const body = z.object({ text: NOTE_BODY }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const company = await account(c, companyId);
      let made;
      try {
        made = await c.query(INSERT_NOTE_SQL, [tenant, companyId, body.text, req.control.user_id]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that note.") ?? e;
      }
      const row = made.rows[0];
      await audit(c, req, "customer_notes", row.id, "control.customers.note_written", null,
        { company_tenant_id: companyId, company_name: company.name, body: row.body });
      return reply.code(201).send(row);
    });
  });

  /** An edit, kept as an edit. The author cannot change (127's trigger), the text is stamped, and
   *  the words that were there before go into the audit row — because the question "what did the
   *  office believe when it answered that check" is answered from the audit register, not from the
   *  note, which now says something else. */
  app.post("/control/customers/notes/:id/edit", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-note-edit:${req.control.user_id}`, 60, 3600);
    const id = uuidOf(req.params.id, "note");
    const body = z.object({ text: NOTE_BODY }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const before = await c.query(
        "select id, body, author, created_at, voided_at from customer_notes where id = $1 and tenant_id = $2",
        [id, tenant]);
      if (!before.rowCount) throw new ApiError("NOT_FOUND", "No such note on the register.", 404);
      if (before.rows[0].voided_at) {
        throw new ApiError("CONFLICT",
          "That note is withdrawn. Its text is the thing the withdrawal was about — say what you "
          + "mean in a new note.", 409);
      }
      const r = await c.query(EDIT_NOTE_SQL, [id, tenant, body.text]);
      await audit(c, req, "customer_notes", id, "control.customers.note_edited",
        { body: before.rows[0].body }, { body: r.rows[0].body, edited_at: r.rows[0].edited_at });
      return r.rows[0];
    });
  });

  app.post("/control/customers/notes/:id/void", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-note-void:${req.control.user_id}`, 40, 3600);
    const id = uuidOf(req.params.id, "note");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const before = await c.query(
        "select id, body, author, voided_at from customer_notes where id = $1 and tenant_id = $2",
        [id, tenant]);
      if (!before.rowCount) throw new ApiError("NOT_FOUND", "No such note on the register.", 404);
      if (before.rows[0].voided_at) {
        throw new ApiError("CONFLICT", "That note is already withdrawn.", 409);
      }
      let done;
      try {
        done = await c.query(VOID_NOTE_SQL, [id, tenant, req.control.user_id, body.reason]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that withdrawal.") ?? e;
      }
      await audit(c, req, "customer_notes", id, "control.customers.note_withdrawn",
        { body: before.rows[0].body }, { void_reason: body.reason, voided_at: done.rows[0].voided_at });
      return done.rows[0];
    });
  });

  // ============================================================
  // the labels
  // ============================================================

  app.get("/control/customers/tags", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-tags:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(["live", "retired"]).or(z.literal("all")).optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const rows = await c.query(TAG_LIBRARY_SQL, [tenant,
        q.status && q.status !== "all" ? q.status : null, q.search || null, q.limit, q.offset]);
      const counts = (await c.query(TAG_COUNTS_SQL, [tenant])).rows[0];
      return { rows: rows.rows, counts };
    });
  });

  /** The accounts a live label is currently on. Params: register, tag. */
  app.get("/control/customers/tags/:id/wearers", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-wearers:${req.control.user_id}`, 120, 60);
    const id = uuidOf(req.params.id, "label");
    const tenant = tenantOf(req);
    const r = await withTenant(tenant, (c) => c.query(TAG_WEARERS_SQL, [tenant, id]));
    return { rows: r.rows };
  });

  /** Create a label. Lowercased by the table's own CHECK, so `KYC-Hold` and `kyc-hold` are one
   *  label and an office does not spend an afternoon working out whether they were ever two. */
  app.post("/control/customers/tags", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-tag-create:${req.control.user_id}`, 20, 3600);
    const body = z.object({
      name: z.string().trim().regex(/^[a-z0-9][a-z0-9 ._+-]{1,27}$/i,
        "2 to 28 characters: letters, digits, space, dot, underscore, dash or plus"),
      colour: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      note: z.string().trim().max(160).optional()
    }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      let made;
      try {
        made = await c.query(INSERT_TAG_SQL, [tenant, body.name, body.colour ?? null,
          body.note ?? null, req.control.user_id]);
      } catch (e) {
        throw guardRefusal(e, "The library refused that label.",
          "The library already holds a live label of that name. Retire it first if the words have "
          + "changed meaning.") ?? e;
      }
      const row = made.rows[0];
      await audit(c, req, "customer_tags", row.id, "control.customers.tag_created", null,
        { name: row.name, colour: row.colour, note: row.note });
      return reply.code(201).send(row);
    });
  });

  /** Retire a label from the library. The pairings under it stay, because "which accounts were
   *  marked as duplicates, and when did that stop" is the question a label answers when something
   *  went wrong (125). A label still being worn by live accounts is refused until the desk has
   *  taken it off them, which is the difference between tidying and quietly unlabelling forty
   *  companies. */
  app.post("/control/customers/tags/:id/retire", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-tag-retire:${req.control.user_id}`, 20, 3600);
    const id = uuidOf(req.params.id, "label");
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const worn = (await c.query(TAGGING_COUNT_SQL, [tenant, id])).rows[0]?.live ?? 0;
      if (worn > 0) {
        throw new ApiError("CONFLICT",
          `${worn} account${worn === 1 ? "" : "s"} still wear${worn === 1 ? "s" : ""} that label. `
          + "Take it off them first — retiring a label out of the library is not the same act as "
          + "unlabelling a company.", 409, [{ field: "live" }]);
      }
      const r = await c.query(RETIRE_TAG_SQL, [id, tenant, req.control.user_id]);
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "No such live label.", 404);
      await audit(c, req, "customer_tags", id, "control.customers.tag_retired",
        { name: r.rows[0].name }, { name: r.rows[0].name, retired: true });
      return r.rows[0];
    });
  });

  app.post("/control/customers/:id/tags", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-tag-apply:${req.control.user_id}`, 60, 3600);
    const companyId = uuidOf(req.params.id, "account");
    const body = z.object({ tagId: UUID }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const company = await account(c, companyId);
      const already = await c.query(TAG_ON_ACCOUNT_SQL, [tenant, companyId, body.tagId]);
      if (already.rowCount) {
        throw new ApiError("CONFLICT", "That account already wears that label.", 409);
      }
      let made;
      try {
        made = await c.query(APPLY_TAG_SQL, [tenant, companyId, body.tagId, req.control.user_id]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that label.",
          "That account already wears that label.") ?? e;
      }
      const name = (await c.query(
        "select name from customer_tags where id = $1 and tenant_id = $2",
        [body.tagId, tenant])).rows[0]?.name ?? null;
      await audit(c, req, "customer_taggings", made.rows[0].id, "control.customers.tag_applied", null,
        { company_tenant_id: companyId, company_name: company.name, tag_id: body.tagId, tag_name: name });
      return reply.code(201).send({ ...made.rows[0], tag_name: name });
    });
  });

  app.post("/control/customers/:id/tags/retire", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`customers-tag-remove:${req.control.user_id}`, 60, 3600);
    const companyId = uuidOf(req.params.id, "account");
    const body = z.object({ tagId: UUID }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      let done;
      try {
        done = await c.query(RETIRE_TAGGING_SQL, [tenant, companyId, body.tagId, req.control.user_id]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that.") ?? e;
      }
      if (!done.rowCount) throw new ApiError("NOT_FOUND", "That account is not wearing that label.", 404);
      const name = (await c.query(
        "select name from customer_tags where id = $1 and tenant_id = $2",
        [body.tagId, tenant])).rows[0]?.name ?? null;
      await audit(c, req, "customer_taggings", done.rows[0].id, "control.customers.tag_removed",
        { tag_name: name }, { company_tenant_id: companyId, tag_id: body.tagId,
          tag_name: name, removed_at: done.rows[0].deleted_at });
      return done.rows[0];
    });
  });

  // ============================================================
  // 128: two accounts that were one, and the seats on an account
  // ============================================================

  /**
   * The claims register, newest first.
   *
   * Read with `view` rather than `merge`: the seat that asks "is this account already declared a
   * duplicate of that one?" is usually the one looking before it decides, and a queue only the
   * merger can see is a queue that gets raised twice.
   */
  app.get("/control/customers/duplicates", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-claims:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(["declared", "voided"]).or(z.literal("all")).optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const rows = await c.query(CLAIM_LIST_SQL, [tenant,
        q.status && q.status !== "all" ? q.status : null, q.search || null, q.limit, q.offset]);
      const counts = (await c.query(CLAIM_COUNTS_SQL, [tenant])).rows[0];
      return { claims: rows.rows, counts, clock: new Date().toISOString() };
    });
  });

  /**
   * What a claim would do, before anybody writes one.
   *
   * `duplicate_preview` answers the same six questions as the trigger that will refuse the insert,
   * in the order it asks them, so the sentence on the screen is the sentence the write would have
   * raised. The desk reads it live — which open checks move, which kinds the survivor already holds,
   * and the count of everything that stays behind on the closed account — because "merged" is the
   * word a clerk uses loosely and this register is not loose about it: only the unanswered checks
   * move, and they move as new lines.
   */
  app.get("/control/customers/duplicates/:survivor/:loser",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, VIEW);
      await enforceRateLimit(`customers-duplicate-preview:${req.control.user_id}`, 120, 60);
      const survivor = uuidOf(req.params.survivor, "account that would carry on");
      const loser = uuidOf(req.params.loser, "account named as the extra one");
      const { rows } = await pool.query(
        "select platform_auth.duplicate_preview($1,$2) as p", [survivor, loser]);
      const p = rows[0]?.p;
      const refusal = definerRefusal(p);
      if (refusal) throw refusal;
      return p;
    });

  /**
   * Declare two accounts one account.
   *
   * The write is 128's definer, so nothing here repeats the register's own tests: the hand that
   * raises the claim, the account it is raised on and the reason all go in as arguments and the
   * trigger decides whether the pair is legal. Two things make this single-seat rather than
   * two-seat, and both are the register's: the closure the claim leans on already needed a second
   * signature on the tenants desk, and the only thing that moves is work the office has not
   * answered yet, which arrives as new lines that still have to be checked.
   */
  app.post("/control/customers/:id/duplicates", { preHandler: [requireControl] },
    async (req: any, reply) => {
      await requireControlPermission(req, MERGE);
      await enforceRateLimit(`customers-duplicate-claim:${req.control.user_id}`, 12, 3600);
      const survivor = uuidOf(req.params.id, "account");
      const body = z.object({ loser: UUID, reason: SENTENCE }).strict().parse(req.body);
      if (body.loser === survivor) {
        throw new ApiError("VALIDATION_FAILED",
          "A claim needs two accounts — the one that carries on and the extra one. You gave the same "
          + "account twice.", 400, [{ field: "loser" }]);
      }
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const keep = await account(c, survivor);
        const standing = (await c.query(CLAIM_STANDING_SQL, [tenant, body.loser])).rows[0];
        if (standing) {
          throw new ApiError("CONFLICT",
            `That closed account is already declared the extra one of ${standing.survivor_name} `
            + `(claim raised ${standing.raised_day}). Withdraw that claim before raising another.`,
            409);
        }
        let made;
        try {
          made = await c.query(
            "select platform_auth.claim_duplicate($1,$2,$3,$4,$5) as j",
            [tenant, survivor, body.loser, body.reason, req.control.user_id]);
        } catch (e) {
          throw guardRefusal(e, "The register refused that claim.",
            "That closed account is already declared the extra one of another survivor. One closed "
            + "account is the duplicate of one account only.") ?? e;
        }
        const j = made.rows[0]?.j;
        const refusal = definerRefusal(j);
        if (refusal) throw refusal;
        // Read the survivor's open kinds back from the register rather than trusting the count the
        // definer returned: a claim that promised to carry a licence check and left the desk with
        // nothing to answer is the failure this panel exists to prevent.
        const open = await c.query(OPEN_KINDS_SQL, [tenant, survivor]);
        await audit(c, req, "customer_duplicate_claims", j.claim.id,
          "control.customers.duplicate_claimed", null, {
            survivor_id: survivor, survivor_name: keep.name,
            loser_id: j.claim.loser.id, loser_name: j.claim.loser.name,
            loser_closed_at: j.claim.loser.closed_at, reason: j.claim.reason,
            carried_kinds: j.claim.carried_kinds, note_id: j.note_id
          });
        return reply.code(201).send({ ...j, survivor_open_kinds: open.rows.map((r: any) => r.kind) });
      });
    });

  /**
   * Take a claim back.
   *
   * A withdrawal is a write of its own, not an edit: the pair, the reason and the carry-list stay
   * exactly as they were raised and the register adds who took it back, when and why. The carried
   * lines stay on the survivor too — 127 keeps an answer once given and a carried line is the
   * survivor's own check by then — so the definer's counter-note says that out loud rather than
   * leaving two stories about the same licence on one file.
   */
  app.post("/control/customers/duplicates/:id/void", { preHandler: [requireControl] },
    async (req: any) => {
      await requireControlPermission(req, MERGE);
      await enforceRateLimit(`customers-claim-void:${req.control.user_id}`, 12, 3600);
      const claim = uuidOf(req.params.id, "claim");
      const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const before = (await c.query(CLAIM_ONE_SQL, [tenant, claim])).rows[0];
        if (!before) {
          throw new ApiError("NOT_FOUND", "That claim is not on this office's register.", 404);
        }
        let made;
        try {
          made = await c.query(
            "select platform_auth.void_duplicate_claim($1,$2,$3,$4) as j",
            [tenant, claim, body.reason, req.control.user_id]);
        } catch (e) {
          throw guardRefusal(e, "The register refused that withdrawal.") ?? e;
        }
        const j = made.rows[0]?.j;
        const refusal = definerRefusal(j);
        if (refusal) throw refusal;
        const after = (await c.query(CLAIM_ONE_SQL, [tenant, claim])).rows[0];
        await audit(c, req, "customer_duplicate_claims", claim,
          "control.customers.duplicate_claim_voided",
          { status: before.status, reason: before.reason, carried_kinds: before.carried_kinds },
          { status: after.status, void_reason: after.void_reason, voided_at: after.voided_at,
            note_id: j.note_id, carried_kinds_stay: after.carried_kinds });
        return j;
      });
    });

  /**
   * Who is signed in to an account, right now.
   *
   * One row per person, with the last activity and the device — names, not emails, because the
   * question at a desk is "which director is in there", and the email is already on the staff desk.
   * Gated on `disconnect` rather than `view` and audited as it happens: a live session list is not a
   * register read, it is a look into a company's building while the lights are on.
   */
  app.get("/control/customers/:id/access", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, DISCONNECT);
    await enforceRateLimit(`customers-access:${req.control.user_id}`, 30, 60);
    const companyId = uuidOf(req.params.id, "account");
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const { rows } = await c.query("select platform_auth.customer_access($1) as a", [companyId]);
      const a = rows[0]?.a;
      const refusal = definerRefusal(a);
      if (refusal) throw refusal;
      await audit(c, req, "tenants", companyId, "control.customers.access_read", null,
        { company_name: a.company.name, live: a.live, seats: a.seats,
          borrowed_views: a.borrowed_views, sessions_cut_before: a.cut_offs.sessions_cut });
      return a;
    });
  });

  /**
   * End every session on an account.
   *
   * The act a desk reaches for on the call that says "somebody else has my password", which is why
   * it is one seat and why it asks for a sentence: a cut-off is recoverable by signing in again, and
   * the reason is the thing a clerk needs three weeks later when the account says it was cut twice.
   * The response carries the honest limit of the act in the same breath as the count — an access
   * token is a signed key with no row behind it, so it stays usable for the rest of its fifteen
   * minutes unless the account is blocked, and blocking is 078's two-seat act.
   */
  app.post("/control/customers/:id/cut-off", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, DISCONNECT);
    await enforceRateLimit(`customers-cut-off:${req.control.user_id}`, 8, 3600);
    const companyId = uuidOf(req.params.id, "account");
    const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const company = await account(c, companyId);
      const seen = await c.query("select platform_auth.customer_access($1) as a", [companyId]);
      const before = seen.rows[0]?.a;
      let made;
      try {
        made = await c.query("select platform_auth.customer_force_logout($1) as j", [companyId]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that cut-off.") ?? e;
      }
      const j = made.rows[0]?.j;
      const refusal = definerRefusal(j);
      if (refusal) throw refusal;
      await audit(c, req, "sessions", companyId, "control.customers.seat_cut_off",
        { company_name: company.name, live: before?.live ?? null,
          borrowed_views: before?.borrowed_views ?? null, reason: body.reason },
        { sessions_revoked: j.sessions_revoked, of_which_borrowed_views: j.of_which_borrowed_views,
          seats: j.seats, blocked: j.company.blocked, window: j.window, reason: body.reason });
      return { ...j, reason: body.reason, previous_cut_offs: before?.cut_offs ?? null };
    });
  });

  // ============================================================
  // the data-request register (129) — the copy and the erasure
  // ============================================================
  //
  // A data subject rang, wrote, or walked in with a letter, and the office has to answer with a
  // document rather than a opinion. 129 keeps the register and does the two hard things in SQL: it
  // reads the copy (`data_export`) and it runs the mask (`apply_data_erasure`). What is here is the
  // desk around that — the duty, the limiter, the sentence, and the streaming of 17 sections onto a
  // socket without holding them in memory twice.
  //
  // Three rules this tab keeps:
  //
  // **The handler adds no check the register already makes.** Whether the account is closed,
  // whether an erasure named something, whether a copy carries a category list, whether a paper is
  // already open, whether a signature is spent or lapsed or signed by the seat holding it — all of
  // it is a definer's answer or a trigger's sentence, and each one goes out in the register's own
  // words (409, or 404 when the row simply is not there). A route that re-tested "is the account
  // closed" would be a second opinion nobody asked for, and the first one to drift.
  //
  // **A copy leaves as bytes, and the bytes are hashed on the way out.** `data_export` hands back
  // ciphertext hex for every encrypted column because the key is not in the database, so this route
  // is the one place a plain TIN, phone or NIDA is written — into the archive the subject is owed,
  // never into a response body, a log or an audit row. The bundle's SHA-256 is of the whole ZIP as
  // it left the socket, and it is stamped only once every byte has been handed over — a download the
  // caller closed halfway is not a copy anybody received — but before the response closes, so the
  // desk that watches its own file land reads a hand-over and not a register one step behind.
  //
  // **An erasure is not this desk's act.** `erase-signature` writes a proposal and a hash and stops.
  // The mask runs from `/control/approvals`, in the transaction that spends a signature a *different*
  // seat gave, and 121's register is what refuses the one who asked. That is why this file has no
  // `apply_data_erasure` statement at all.

  /** Refusing an ask is the answer to the paper it is written on: the seat that may raise an
   *  erasure is the seat that may say no to one, and the same for a copy. */
  const dutyForKind = (kind: string) => (kind === "erase" ? ERASE : GDPR);

  /** The paper, read through the definer, because a route may not decide what a register row is
   *  from a body it was handed. Params: request. */
  const dataRequest = async (id: string) => {
    const { rows } = await pool.query(DATA_REQUEST_SQL, [id]);
    const d = rows[0]?.d;
    if (!d || d.status === "not_found") {
      // The definer's `not_found` is the only answer it gives for an id it cannot see, so the
      // sentence has to hold both causes a clerk can be standing in: a number that was mistyped,
      // and a number the office never wrote down. It must not claim the paper is another desk's —
      // the register is platform-wide, and a wrong accusation is worse than a bare 404.
      throw new ApiError("NOT_FOUND",
        `No data request ${String(d?.request ?? id).slice(0, 8)} — this register has never raised `
        + "a paper under that number.", 404);
    }
    return d as Record<string, any>;
  };

  /** Params: register, status|null, kind|null, search|null, limit, offset. */
  app.get("/control/customers/data-requests", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, GDPR);
    await enforceRateLimit(`customers-data-requests:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum([...REQUEST_STATUSES, "all"]).optional(),
      kind: z.enum([...DATA_REQUEST_KINDS, "all"]).optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const { rows } = await pool.query(DATA_REQUESTS_SQL, [
      tenantOf(req), q.status && q.status !== "all" ? q.status : null,
      q.kind && q.kind !== "all" ? q.kind : null, q.search || null, q.limit, q.offset]);
    const b = rows[0]?.b ?? { rows: [], counts: {} };
    return { ...b, clock: new Date().toISOString() };
  });

  /**
   * One paper, whole.
   *
   * The detail is what a second seat reads before signing and what the desk reads back after a
   * download: the categories, the reason the caller gave, who raised it, the hash the signature is
   * against, the rows the mask reached and the twelve keeps entries that say what it did not. All of
   * it is one definer's read, so the counters beside the numbers are the ones on the board.
   */
  app.get("/control/customers/data-requests/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, GDPR);
    await enforceRateLimit(`customers-data-request:${req.control.user_id}`, 120, 60);
    return await dataRequest(uuidOf(req.params.id, "data request"));
  });

  /**
   * What a request would touch, before anybody raises it.
   *
   * `data_request_preview` answers the same two questions the mask will ask — what is there, and
   * what stays — out of the live registers, in the words the row itself will carry. A desk raises an
   * erasure from this screen and not from a description of one, which is the reason the counts come
   * from SQL rather than from a list of tables in the page. Reading it costs `gdpr` and nothing
   * else: a preview writes no row, promises nothing, and the seat that will sign a paper has to be
   * able to see it.
   */
  app.get("/control/customers/:id/data-preview", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, GDPR);
    await enforceRateLimit(`customers-data-preview:${req.control.user_id}`, 120, 60);
    const company = uuidOf(req.params.id, "account");
    const q = z.object({ kind: z.enum(DATA_REQUEST_KINDS) }).parse(req.query ?? {});
    const { rows } = await pool.query(DATA_PREVIEW_SQL, [company, q.kind]);
    const p = rows[0]?.p;
    const refusal = definerRefusal(p);
    if (refusal) throw refusal;
    return p;
  });

  /**
   * Raise the ask.
   *
   * One route for both kinds, because the register is one table and the difference between a copy
   * and an erasure is a CHECK and a duty rather than two code paths. The definer answers with the
   * row *and* the preview of it, so the desk that raised the paper is looking at the same counts the
   * second seat will be asked to sign — no page of its own arithmetic in between.
   *
   * That preview is why an erasure costs both duties rather than only `erase`: a paper about a mask
   * carries the counts of what the mask reaches, and a seat that may not read the register may not
   * be handed them. 129 seeds the pair onto the same two roles, so nothing in the office is narrowed
   * by the rule — it is only unable to raise a paper it cannot see.
   */
  app.post("/control/customers/:id/data-requests", { preHandler: [requireControl] },
    async (req: any, reply) => {
      const body = z.object({
        kind: z.enum(DATA_REQUEST_KINDS),
        categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(),
        reason: SENTENCE,
        askedIn: z.string().trim().min(3).max(80).optional()
      }).strict().parse(req.body);
      await requireControlPermission(req, GDPR);
      if (body.kind === "erase") await requireControlPermission(req, ERASE);
      await enforceRateLimit(`customers-data-raise:${req.control.user_id}`, 12, 3600);
      const company = uuidOf(req.params.id, "account");
      const tenant = tenantOf(req);
      // A copy that arrived with a menu is the desk asking to withhold part of an Article 15
      // answer. The register refuses it (129's own sentence), and a body that cannot even name the
      // words is a client bug, so that half is caught here where it can be answered with a list.
      const seen = new Set(body.categories ?? []);
      for (const c of seen) {
        if (!CATEGORIES.includes(c as DataCategory)) {
          throw new ApiError("VALIDATION_FAILED",
            `Nothing on this register erases "${c}". The categories are: ${CATEGORIES.join(", ")}.`,
            400, [{ field: "categories" }]);
        }
      }
      let made;
      try {
        made = await pool.query(RAISE_REQUEST_SQL, [
          tenant, company, body.kind, [...seen], body.reason, body.askedIn ?? null,
          req.control.user_id, role(req), req.ip]);
      } catch (e) {
        throw guardRefusal(e, "The register refused that request.",
          "That account already has an open request of this kind. Hand the copy over, erase it, or "
          + "refuse it before raising another.") ?? e;
      }
      const j = made.rows[0]?.j;
      const refusal = definerRefusal(j);
      if (refusal) throw refusal;
      return reply.code(201).send(j);
    });

  /**
   * Say no, with the reason the caller will be quoted.
   *
   * A refusal is not a delete: the row stays, the register keeps the note, and the open slot is
   * freed so the office can answer the same person properly next month. An erasure paper with a
   * signature still waiting on it is answered first — 126's order for a refund paper, kept because
   * the failure it prevents is the same one: a desk refusing a paper while a colleague's "yes" is
   * still open on the board.
   *
   * Both duties again, in this order: the paper is read through the register's own door, so the
   * read duty is asked for before anything is fetched rather than after a row is already in hand.
   */
  app.post("/control/customers/data-requests/:id/refuse", { preHandler: [requireControl] },
    async (req: any) => {
      const id = uuidOf(req.params.id, "data request");
      await requireControlPermission(req, GDPR);
      const before = await dataRequest(id);
      await requireControlPermission(req, dutyForKind(String(before.kind)));
      await enforceRateLimit(`customers-data-refuse:${req.control.user_id}`, 12, 3600);
      const body = z.object({ note: SENTENCE }).strict().parse(req.body);
      const { rows } = await pool.query(REFUSE_REQUEST_SQL,
        [id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
      const j = rows[0]?.j;
      const refusal = definerRefusal(j);
      if (refusal) throw refusal;
      return { ...j, company_name: before.company?.name ?? null };
    });

  /**
   * Ask a second seat to sign the erasure.
   *
   * This is the whole of what this desk may do with an erasure. `propose_data_erasure` reads the
   * account, the categories and the closed date out of the row, hashes what it read, and writes a
   * `customer.erase` proposal against that hash — so the bytes the second seat signs are provably
   * this paper, and the mask that runs later re-checks the hash before it touches a column. The
   * paper moves to `pending_signature` and nothing else happens until somebody who is not the
   * proposer presses approve on `/control/approvals`.
   */
  app.post("/control/customers/data-requests/:id/erase-signature",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      const id = uuidOf(req.params.id, "data request");
      await requireControlPermission(req, GDPR);
      const before = await dataRequest(id);
      await requireControlPermission(req, ERASE);
      await enforceRateLimit(`customers-data-propose:${req.control.user_id}`, 12, 3600);
      if (before.kind !== "erase") {
        throw new ApiError("VALIDATION_FAILED",
          `${before.ref} is a copy, and a copy asks for no signature — it hands over what the `
          + "registers already hold. An erasure is raised as its own request.", 400,
          [{ field: "kind" }]);
      }
      const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
      const { rows } = await pool.query(PROPOSE_ERASURE_SQL,
        [id, body.reason, req.control.user_id, role(req), req.ip, uaOf(req)]);
      const j = rows[0]?.j;
      const refusal = definerRefusal(j);
      if (refusal) throw refusal;
      return reply.code(201).send({ ...j, reason: body.reason,
        categories: before.categories ?? [], company_name: before.company?.name ?? null });
    });

  /**
   * Hand the copy over.
   *
   * Seventeen sections, one folder each as CSV and as JSON, a README a person can read without
   * software, a manifest that states every cap and every withheld field, and a checksum list. The
   * archive is written onto the socket as it is assembled — the same reason 113's batch export
   * streams: a company with four hundred sign-ins and four hundred cargo files is not a Buffer.
   *
   * Two things make this a write rather than a download. The row is stamped with the SHA-256 of the
   * bytes that actually left, the first time only (so a re-download cannot move the evidence of what
   * the subject was handed), and the register counts every hand-over. Both happen after the socket
   * closes, because a download the caller abandoned half way is not a copy anybody received.
   */
  app.post("/control/customers/data-requests/:id/bundle",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      await requireControlPermission(req, GDPR);
      await enforceRateLimit(`customers-data-bundle:${req.control.user_id}`, 6, 3600);
      const id = uuidOf(req.params.id, "data request");
      const tenant = tenantOf(req);

      // Everything that can still be answered with a status code is answered here, before a byte
      // of the archive exists: a half-written download is worse than a refusal, and the definer's
      // own `refused` / `not an export` sentences are the desk's answer.
      const read = await pool.query(DATA_EXPORT_SQL, [id, tenant]);
      const e = read.rows[0]?.e;
      const refusal = definerRefusal(e);
      if (refusal) throw refusal;

      const sections = (e.sections ?? []) as CopySection[];
      const ref = String(e.request?.ref ?? id);
      const generatedAt = new Date();
      const unread: string[] = [];

      reply.hijack();
      const res: ServerResponse = reply.raw;
      const headers: Record<string, string> = {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="data-copy-${ref.replace(/[^A-Za-z0-9-]/g, "")}.zip"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (/^access-control-/i.test(key) && value !== undefined) headers[key] = String(value);
      }
      res.writeHead(200, headers);

      const zip = new ZipWriter();
      const digest = createHash("sha256");
      const manifest: Record<string, unknown>[] = [];
      /** The checksum of every file that actually left, under the name it was filed. A subject is
       *  told to run `sha256sum -c` against this list, so a list of the manifest rows' JSON would be
       *  a verification step that verifies nothing — and an entry abandoned half way through an
       *  aborted download is not in it, because that file is not in the archive either. */
      const sums: { name: string; sha: string }[] = [];
      let aborted = false;
      let failure: string | null = null;
      const stop = new AbortController();
      res.on("close", () => { if (!res.writableEnded) { aborted = true; stop.abort(); } });

      const put = async (name: string, data: Buffer) => {
        if (aborted) return name;
        const entry = zip.add(name, data);
        for (const chunk of entry.chunks) {
          if (aborted || res.writableEnded) return entry.name;
          digest.update(chunk);
          if (!res.write(chunk)) await once(res, "drain", { signal: stop.signal }).catch(() => {});
        }
        sums.push({ name: entry.name, sha: createHash("sha256").update(data).digest("hex") });
        return entry.name;
      };

      try {
        for (let i = 0; i < sections.length; i++) {
          if (aborted) break;
          const s = sections[i];
          const rows = plainRows(s.rows ?? [], unread);
          const head = keysOf(rows);
          const stem = `sections/${String(i + 1).padStart(2, "0")}-${slug(s.key)}`;
          const csvName = await put(`${stem}.csv`,
            Buffer.from(csv(head, rows), "utf8"));
          const jsonName = await put(`${stem}.json`,
            Buffer.from(JSON.stringify({ key: s.key, label: s.label ?? s.key,
              held: s.held ?? rows.length, truncated: s.truncated === true,
              withheld: s.withheld ?? null, rows }, null, 2), "utf8"));
          manifest.push({ key: s.key, label: s.label ?? s.key, held: s.held ?? rows.length,
            rows_written: rows.length, truncated: s.truncated === true,
            withheld: s.withheld ?? null, csv: csvName, json: jsonName });
        }

        const readme = dataCopyReadme(e, manifest, unread, generatedAt);
        const readmeName = await put("README.txt", Buffer.from(readme, "utf8"));
        await put("manifest.json", Buffer.from(JSON.stringify({
          request: e.request, company: e.company, cap: e.cap ?? null, generated_at: generatedAt,
          sections: manifest, encrypted_values_unread: [...new Set(unread)],
          readme: readmeName, checksums: "SHA256SUMS.txt"
        }, null, 2), "utf8"));
        // Written last, because an archive cannot carry the checksum of its own checksum list.
        await put("SHA256SUMS.txt",
          Buffer.from(sums.map((s) => `${s.sha}  ${s.name}`).join("\n") + "\n", "utf8"));

        for (const chunk of zip.finish()) {
          if (aborted || res.writableEnded) break;
          digest.update(chunk);
          if (!res.write(chunk)) await once(res, "drain", { signal: stop.signal }).catch(() => {});
        }
      } catch (err: any) {
        failure = String(err?.message ?? err).slice(0, 300);
        req.log.error({ err }, "data copy failed");
      }

      if (!res.writableEnded) {
        // The stamp goes on the row *before* the response is closed. Every byte has already been
        // handed to the socket, so a download the caller abandoned still records nothing — but a
        // desk that reloads the paper the moment the file lands reads a hand-over rather than a
        // register that has never heard of it. Stamping after `end()` made the register one read
        // behind its own download, which is exactly the window a clerk stands in.
        let stamp: Record<string, any> | null = null;
        const archiveSha = digest.digest("hex");
        if (!aborted && !failure) {
          try {
            const r = await pool.query(STAMP_DELIVERY_SQL, [
              id, req.control.user_id, role(req), req.ip, archiveSha,
              BigInt(zip.bytesWritten), zip.entryCount]);
            stamp = (r.rows[0]?.j ?? null) as Record<string, any> | null;
          } catch (err: any) {
            req.log.error({ err }, "data copy stamp failed");
          }
        }
        const delivered = stamp?.status === "ok";
        if (!delivered) {
          // The definer writes the register's own audit row when it stamps a hand-over. This is the
          // other case — an incomplete one, which is exactly the act a later question about the copy
          // would need a record of, and the reason the branch exists rather than a second row always.
          try {
            await withTenant(tenant, (c) => writeAudit(c, {
              tenantId: tenant, actorUserId: req.control.user_id, actorRole: role(req),
              ip: req.ip, userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
              entity: "customer_data_requests", entityId: id,
              action: "control.customers.data_bundle_incomplete",
              before: { ref, status: e.request?.status ?? null },
              after: { ref, sections: manifest.length, entries: zip.entryCount,
                bytes: zip.bytesWritten, aborted, failure, sha256: archiveSha,
                stamp: stamp?.message ?? stamp?.status ?? null,
                company_name: e.company?.name ?? null }
            }));
          } catch (err: any) {
            req.log.error({ err }, "data copy audit failed");
          }
        }
        req.log.info({ request: id, sections: manifest.length, entries: zip.entryCount,
          bytes: zip.bytesWritten, aborted, failure, delivered }, "data copy streamed");
        res.end();
      }
    });


  app.get("/control/customers/export", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`customers-export:${req.control.user_id}`, 12, 3600);
    const q = z.object({
      register: z.enum(REGISTERS),
      status: z.string().trim().max(32).optional(),
      kind: z.string().trim().max(32).optional(),
      search: SEARCH
    }).strict().parse(req.query ?? {});
    const tenant = tenantOf(req);

    // The same rule 126 learned: a typo in a filter is not a server error, it is an empty file, and
    // a desk that exports an empty file believes the register is empty. The words are the tab's own
    // filters, so `status` means the same thing to a list route and to the file beside it. `tags` is
    // the one register whose CSV carries the pairings rather than the library — `retired` there means
    // a label taken off an account, which is the line the desk needs when something went wrong.
    const STATES: Record<(typeof REGISTERS)[number], readonly string[]> = {
      accounts: ["waiting", "refused", "expired", "clear", "none"],
      checks: [...CHECK_STATES, "open"], notes: ["live", "withdrawn"], tags: ["live", "retired"],
      // The two words the claim register itself uses, so a filter that reads like the table's own
      // `status` column cannot quietly mean something else in the file.
      claims: ["declared", "voided"],
      // 129's five words, taken from the same vocabulary the board filters on.
      requests: [...REQUEST_STATUSES]
    };
    const state = !q.status || q.status === "all" ? null : q.status;
    if (state && !STATES[q.register].includes(state)) {
      throw new ApiError("VALIDATION_FAILED",
        `${q.register} has no state "${state}". It has: ${STATES[q.register].join(", ")}.`, 400,
        [{ field: "status" }]);
    }
    const kind = !q.kind || q.kind === "all" ? null : q.kind;
    // Two registers carry a `kind`, and they do not share a word list: a check is a licence or an
    // ID, a data request is a copy or an erasure. Asking the checks register for `export` would
    // otherwise be an empty file, which 126 already learned is a lie a desk believes.
    if (kind && q.register === "requests" && !DATA_REQUEST_KINDS.includes(kind as DataRequestKind)) {
      throw new ApiError("VALIDATION_FAILED",
        `No data request is of the kind "${kind}". The register has: ${DATA_REQUEST_KINDS.join(", ")}.`,
        400, [{ field: "kind" }]);
    }
    if (kind && q.register !== "requests" && !CHECK_KINDS.includes(kind as CheckKind)) {
      throw new ApiError("VALIDATION_FAILED",
        `No check is of the kind "${kind}". The register has: ${CHECK_KINDS.join(", ")}.`, 400,
        [{ field: "kind" }]);
    }

    let head: string[];
    let rows: Record<string, unknown>[];
    if (q.register === "accounts") {
      const page = await boardRows(tenant, q.search || null, null, state, kind);
      head = ["name", "type", "account_status", "slug", "plan_name", "created_at",
        "trial_ends_at", "licence_expires_at", "open_checks", "approved", "refused",
        "expired", "seats", "tags", "trust", "blocked_note", "last_note"];
      rows = page.map((r) => ({
        ...r,
        open_checks: (r.checks as any)?.open, approved: (r.checks as any)?.approved,
        refused: (r.checks as any)?.refused, expired: (r.checks as any)?.expired,
        tags: ((r.tags as any[]) ?? []).map((t) => t.name).join(" "),
        trust: trustCell(r)
      }));
    } else if (q.register === "checks") {
      head = ["company_name", "company_type", "kind", "status", "reference_tail", "expires_on",
        "reason", "raised_name", "raised_at", "decided_name", "decided_at", "has_reference"];
      rows = (await withTenant(tenant,
        (c) => c.query(CHECK_EXPORT_SQL, [tenant, state, kind, q.search || null]))).rows;
    } else if (q.register === "notes") {
      head = ["company_name", "body", "author_name", "created_at", "edited_at",
        "voided_by_name", "voided_at", "void_reason"];
      rows = (await withTenant(tenant,
        (c) => c.query(NOTE_EXPORT_SQL, [tenant, state, q.search || null]))).rows;
    } else if (q.register === "tags") {
      head = ["company_name", "name", "colour", "applied_by_name", "applied_at",
        "removed_by_name", "removed_at"];
      rows = (await withTenant(tenant,
        (c) => c.query(TAG_EXPORT_SQL, [tenant, state, q.search || null]))).rows;
    } else if (q.register === "claims") {
      // A claim is a sentence about two accounts, so the file carries both names and the day the
      // extra one was shut — the three things a desk needs to check the claim still holds.
      head = ["survivor_name", "loser_name", "loser_closed_at", "status", "reason",
        "carried_kinds", "raised_name", "raised_at", "voided_name", "voided_at", "void_reason"];
      rows = (await withTenant(tenant,
        (c) => c.query(CLAIM_EXPORT_SQL, [tenant, state, q.search || null]))).rows;
    } else {
      // The data-request register, walked a page at a time out of the board definer. `kept` and
      // `erased_rows` are the two columns a supervisory question is actually about — what the mask
      // reached, and what it was told to leave — so both are flattened rather than dropped, and the
      // bundle's SHA is carried so a copy produced later can be compared with the one handed over.
      head = ["ref", "kind", "request_status", "company_name", "company_closed_at", "categories",
        "asked_in", "reason", "raised_name", "raised_at", "approval_status", "signed_name",
        "payload_sha256", "delivered_at", "deliveries", "bundle_sha256", "bundle_bytes",
        "erased_at", "erased_name", "erased_rows", "kept", "refused_at", "refused_note"];
      rows = (await requestRows(tenant, state, kind, q.search || null)).map((r) => ({
        ...r,
        categories: ((r.categories as string[] | null) ?? []).join(" "),
        erased_rows: pairsCell(r.erased_rows), kept: keepsCell(r.kept)
      }));
    }
    // The account export is the one register whose rows are read through a definer rather than a
    // statement of their own, and the board's own filters are the desk's; nothing here re-counts.
    reply.header("Content-Disposition",
      `attachment; filename="customers-${q.register}-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.type("text/csv; charset=utf-8");
    return csv(head, rows);
  });
}
