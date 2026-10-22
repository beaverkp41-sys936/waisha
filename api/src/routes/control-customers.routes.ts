import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { decryptField, encryptField, searchHash } from "../util/crypto.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import {
  ANSWERS, CHECK_KINDS, CHECK_STATES, KIND_LABELS, OPEN_STATES, REFERENCE_MAX,
  EXPIRING_WORDS, normaliseReference, expiresOnKind, referenceTail, type CheckKind
} from "../customers/checks.js";

/**
 * The Customers desk (127; task #342) — who an account is, what the office has looked at, and
 * what all of that is worth at the moment the question is asked.
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
 * The register is platform-owned, exactly as 101's and 126's are: `req.control.tenant_id` is the
 * office's tenant and the account a line is about sits beside it in `company_tenant_id`. Nothing
 * here reads a caller's phone number or password — an account is found by name, email or TIN.
 */

const VIEW = "control.customers.view";
const VERIFY = "control.customers.verify";
const MANAGE = "control.customers.manage";

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
    .replace(/^(customer_verifications|customer_notes|customer_tags|customer_taggings|documents):\s*/i, "");
  return new ApiError("CONFLICT", line || fallback, 409);
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

// ---------- the check queue ----------

/** Params: register, state|null|'open', kind|null, search|null, limit, offset.
 *  Only the tail and a boolean leave this statement — never `reference_encrypted`. `open` is
 *  answered inside the statement rather than by filtering the page afterwards, because a desk that
 *  asked for open lines and got 30 rows of which four were open would read `total` as the number
 *  of open lines, and it is not. */
const CHECKS_SQL = `
  select c.id, c.kind, c.status, c.reference_tail,
         to_char(c.expires_on, 'YYYY-MM-DD') as expires_on, c.reason, c.document_id,
         c.raised_at, ru.full_name as raised_name, c.decided_at, du.full_name as decided_name,
         c.company_tenant_id, t.name as company_name, t.type as company_type,
         (c.reference_encrypted is not null) as has_reference,
         count(*) over () as total
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
         count(*) over () as total
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
         count(*) over () as total
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

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // A note and a reason are typed by whoever sat at the desk, and a cell that starts with an
  // operator is a formula the moment the CSV reaches a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const csv = (head: string[], rows: Record<string, unknown>[]): string => [
  head.map(csvCell).join(","),
  ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))
].join("\r\n");

const REGISTERS = ["accounts", "checks", "notes", "tags"] as const;

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
    const q = z.object({ search: SEARCH, account: UUID.optional() }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      if (q.account) return { rows: [await account(c, q.account)] };
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
  // the CSV every tab is asked to carry
  // ============================================================

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
      checks: [...CHECK_STATES, "open"], notes: ["live", "withdrawn"], tags: ["live", "retired"]
    };
    const state = !q.status || q.status === "all" ? null : q.status;
    if (state && !STATES[q.register].includes(state)) {
      throw new ApiError("VALIDATION_FAILED",
        `${q.register} has no state "${state}". It has: ${STATES[q.register].join(", ")}.`, 400,
        [{ field: "status" }]);
    }
    const kind = !q.kind || q.kind === "all" ? null : q.kind;
    if (kind && !CHECK_KINDS.includes(kind as CheckKind)) {
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
    } else {
      head = ["company_name", "name", "colour", "applied_by_name", "applied_at",
        "removed_by_name", "removed_at"];
      rows = (await withTenant(tenant,
        (c) => c.query(TAG_EXPORT_SQL, [tenant, state, q.search || null]))).rows;
    }
    // The account export is the one register whose rows are read through a definer rather than a
    // statement of their own, and the board's own filters are the desk's; nothing here re-counts.
    reply.header("Content-Disposition",
      `attachment; filename="customers-${q.register}-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.type("text/csv; charset=utf-8");
    return csv(head, rows);
  });
}
