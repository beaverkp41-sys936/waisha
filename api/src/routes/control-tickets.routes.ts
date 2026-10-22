import type { FastifyInstance } from "fastify";
import type { PoolClient, QueryResult } from "pg";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { decryptField, encryptField, searchHash } from "../util/crypto.js";
import { uuidv7 } from "../util/uuid.js";
import { sniffFileType } from "../util/upload.js";
import { requireControl } from "./control.routes.js";
import { controlHolds } from "./control-analytics.routes.js";
import { sanitizeFileName } from "./documents.routes.js";
import {
  storageConfigured, putObject, getObject, signObject, StorageUnavailableError
} from "../storage/supabase.js";
import { sendMail, mailConfigured } from "../mail/mail.js";
import { breachMail } from "../mail/breach-notice.js";
import {
  CANNED_TOKENS, contextForTicket, renderCanned, unknownTokens
} from "../inbox/replies.js";

/**
 * The customer service register (101; task #246) — every call written down, numbered, and
 * handed to a department that can be asked where it got to.
 *
 * Before this, the office's phone calls lived in whoever answered's memory, so the next call
 * was a fresh start, nobody could say how long a problem had been sitting, and "which
 * department has this?" was asked in a corridor. The register is the minimum that makes the
 * question answerable: an incidence number the caller can quote, who they said they are,
 * what they said the problem is, and a department that now owns it.
 *
 * It runs on `withTenant(platform)` like every other control desk, which is only defensible
 * because 099 made a control session impossible for a tenant seat: this is a platform-wide
 * register with a read-all gate, and the gate is now a platform person rather than anybody
 * with a company password.
 *
 * The state machine is the table's, not the route's — 101 states it as CHECKs (a ticket only
 * leaves `open` by being handed to a department; it only claims to be finished once somebody
 * has written what they did). What the route adds is the *words*: every write takes a reason
 * sentence and appends a line to support_ticket_events, which is append-only at the grant
 * level and again at 043's trigger. A register that can be edited is not evidence.
 *
 * The callback number follows the standing PII rule: AES-GCM with an HMAC search hash beside
 * it, never selected by a list statement, decrypted only by the detail read for a seat that
 * holds the view duty. The hash is why `?phone=` can answer "he rang last week about the same
 * thing" without anybody reading a number off the screen.
 *
 * 123 put a second half on this register, and it is the half an office actually runs on: a
 * desk that keeps its own hours, promises an answer inside them, and knows who is above it
 * when it cannot keep the promise. So an incidence now also carries the desk's own queue
 * number — BILLING-4, minted under a row lock and quoted back to the caller — two deadlines
 * counted in *working* minutes from the minute the phone rang, the stamp of the first human
 * act on it, and a move up the chain that keeps all of the above. What the platform refuses
 * to do is invent any of it: a desk with no SLA gets `none` rather than a deadline nobody
 * agreed to, a call that came in at 02:00 is recorded as after hours instead of breached, and
 * a ceiling stops a hand-over while saying so, but never stops an escalation, because a ticket
 * that cannot move is a ticket nobody is answering.
 *
 * 125 gave the register the rest of what an inbox is, and this file is where each of those
 * things is answered: eight channels so a WhatsApp is the same object as a phone call, a reopen
 * that a desk's own window can refuse, duplicates folded into one live line that keeps both
 * histories, tags, canned replies in the two languages the office works in, the photograph of
 * the licence beside the incidence about it, and the fact that a desk head was told a clock ran
 * out. Two rules of the house hold throughout. The state machine stays the table's — every one
 * of those moves is guarded by a trigger, and what the route adds is the sentence, never the
 * check the schema already makes. And a register line is never destroyed: a fold, a tag, a
 * filing and an alert all leave the row they touched readable, and the event log says who did it.
 */

const VIEW = "control.tickets.view";
const MANAGE = "control.tickets.manage";

/** 125 added `chat` (a live thread inside the portal) and `web_form` (the intake page that will
 *  one day post here). Both are accepted now so a call arriving from either is recorded rather
 *  than refused; neither has a gateway wired, and no route here pretends one exists. */
const CHANNELS = ["phone_call", "whatsapp", "email", "walk_in", "portal_message",
  "chat", "web_form", "other"] as const;
const CATEGORIES = ["onboarding", "account_access", "licence_billing", "cargo_clearing",
  "transport_fleet", "marketplace_directory", "system_error", "complaint", "other"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/** `merged` is 125's sixth state: a duplicate folded into a live line. It is filterable but it
 *  is not workable — a folded incidence answers no door, because the call it describes is being
 *  answered on the keeper. */
const STATUSES = ["open", "allocated", "in_progress", "resolved", "closed", "merged"] as const;
const SETTLED = ["resolved", "closed"] as const;
const LANGUAGES = ["en", "sw"] as const;
/** 123 added `routed` (a rule did it) and `escalated` (the desk above did it) to the table's
 *  own allowlist. They are not synonyms of `allocated`, which is a person moving a call by
 *  hand, and a register that cannot tell the three apart cannot answer "why did this land on
 *  us?" — which is the one question the desk is asked on Monday morning. 125 added the six
 *  words the inbox needed: the fold, the label going on and off, the file arriving and being
 *  taken away, and the desk head who was told a clock had run out. */
const ACTIONS = ["logged", "allocated", "reallocated", "routed", "escalated", "status_changed",
  "priority_changed", "note_added", "resolved", "reopened", "closed", "withdrawn",
  "merged", "tagged", "untagged", "file_attached", "file_dropped", "alerted"] as const;

/** The moves the desk is allowed to ask for. Anything else is refused in words, because
 *  "resolved → allocated" has no meaning anybody could defend out loud. */
const TO_WORK = ["allocated", "in_progress"] as const;

const REASON = z.string().trim().min(4).max(300);
const DAYS = z.coerce.number().int().min(1).max(365).default(60);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
/** What the clock looks like from where the desk is standing. Three words, because a list of
 *  six states is a legend nobody reads and a queue nobody filters. */
const CLOCKS = ["late", "on_time", "no_clock"] as const;

/** The three shapes 125 wrote as column CHECKs. They are restated here so a desk gets one
 *  sentence about its own typo instead of a violation naming a constraint number — the same
 *  reason 123 restated the SLA bounds in the terms form. */
const TAG_NAME = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9 ._+-]{1,27}$/,
    "A tag is 2 to 28 characters in lowercase: letters, numbers and spaces, dots, underscores, "
    + "plus and minus. It is what the queue reads, so keep it short.");
const TAG_COLOUR = z.string().trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #7dd3fc, or leave it empty.")
  .nullish();
const REPLY_SLUG = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/,
    "A slug is 3 to 30 characters, lowercase: letters, numbers and underscores. It is what a "
    + "clerk types when they are mid-call, so name the answer, not the mood.");

/** A licence photograph or a port PDF, on the incidence it is about. The same 8 MB the tenant
 *  vault accepts (028), and the same real-bytes test — a control seat is not a reason to let a
 *  renamed executable into the bucket. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/** How far a single desk may move the register at once. Below the write limiter, above what
 *  anybody can honestly hold in their head while they watch a list. */
const BULK_IDS = z.array(z.string().uuid()).min(1).max(50);

// ---------- statements ----------

/**
 * The two promises, read at the moment the queue is opened. The same fragment in the list and
 * in the detail so the header, the row and the panel can never disagree about what was shown.
 *
 * `met` / `late` are measured against the deadline, not against now: a call answered on the
 * Wednesday is `met` if the desk promised Tuesday and `late` if it promised Monday, and the
 * desk's own rate is computed from those two words. A NULL deadline means the desk never set
 * an SLA, and the honest answer to "is this on time?" about a promise nobody made is `none`.
 */
const CLOCK_STATES = `
         case when t.response_due_at is null then 'none'
              when t.first_response_at is null then
                   (case when t.response_due_at < now() then 'breached' else 'running' end)
              when t.first_response_at <= t.response_due_at then 'met' else 'late' end
           as response_state,
         case when t.resolution_due_at is null then 'none'
              when t.resolved_at is null then
                   (case when t.resolution_due_at < now() then 'breached' else 'running' end)
              when t.resolved_at <= t.resolution_due_at then 'met' else 'late' end
           as resolution_state,`;

/**
 * Log an incidence and mint its reference in one statement.
 *
 * The number comes from the global sequence, not from a count of rows: it is quoted over the
 * phone by somebody in another office, so two companies having a "ticket 7" is worse than
 * useless. nextval is atomic, the year prefix is cosmetic, and `ref` is unique anyway (101).
 *
 * Params: tenant, reporter, email, phone(enc|null), phone(search|null), channel,
 *         company tenant|null, company name, category, subject, body, priority,
 *         department|null, actor, language.
 *
 * The language is taken at the desk because 123's routing rules match on it — the office
 * answers in two of them and "Hakikisha unaweka KiSwahili kwenye record" is not something a
 * later reader can infer from a name.
 */
export const INSERT_TICKET_SQL = `
  insert into support_tickets
    (tenant_id, ref, reporter_name, reporter_email, reporter_phone_encrypted,
     reporter_phone_search, channel, company_tenant_id, company_name, category,
     subject, body, priority, status, department_id, allocated_by, allocated_at,
     created_by, language)
  select $1,
         'CS-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('support_ticket_number_seq')::text, 5, '0'),
         $2, nullif($3, ''), $4::bytea, nullif($5, ''), $6, $7, $8, $9, $10, $11, $12,
         case when $13::uuid is null then 'open' else 'allocated' end,
         $13, case when $13::uuid is null then null else $14::uuid end,
         case when $13::uuid is null then null else now() end,
         $14, coalesce(nullif($15, ''), 'en')
  returning id, ref, ts, status, department_id, priority, language, channel`;

/**
 * Ask one desk for its next queue number.
 *
 * The mint is a function call rather than a read-then-write in JavaScript because the row lock
 * 123 puts on the desk is the whole point: two clerks asking Billing for a number in the same
 * millisecond take it one at a time and come back one apart, and the unique index on
 * `(numbered_by, dept_number)` catches anything the lock somehow missed. It answers
 * `unavailable` for a desk that is not open, which the caller reports rather than guesses at.
 *
 * Params: department.
 */
export const MINT_DESK_NUMBER_SQL = `
  select platform_auth.next_ticket_number($1::uuid) as minted`;

/** Write the number the desk just issued. `dept_ref is null` is the guard: a call the caller
 *  has already been quoted BILLING-4 keeps that string for as long as the register lives,
 *  whichever desk it is standing on now (123).
 *  Params: ticket, tenant, number, ref, issuing department. */
export const STAMP_DESK_NUMBER_SQL = `
  update support_tickets
     set dept_number = $3::int, dept_ref = $4, numbered_by = $5, updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null and dept_ref is null
   returning id, ref, dept_number, dept_ref, numbered_by`;

/** Who takes this call when nobody at the desk chose. Params: tenant, channel, category,
 *  priority, language, region|null.
 *  The region is the linked company's head office and nothing else, so a caller who did not
 *  name a company — or a company with no branch on file — simply matches no region rule,
 *  which 123 prefers to quietly reading it as "any region". */
export const ROUTE_MATCH_SQL = `
  select platform_auth.route_ticket($1::uuid, $2, $3, $4, $5, $6::int) as matched`;

/** The rule named a desk; no person has said they are on it yet.
 *  101's CHECK lets a ticket hold a department while it is still `open`, and that is exactly
 *  the state a routed call is in: the queue number says whose problem it is, `open` says
 *  nobody has started. Params: ticket, tenant, department. */
export const POINT_ROUTED_SQL = `
  update support_tickets
     set department_id = $3, updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and status = 'open' and department_id is null
   returning id, ref, status, department_id, updated_at`;

/**
 * Start the desk's clock on an incidence that has just landed on it.
 *
 * Every promise is measured from `t.ts` — the minute the phone rang — not from the minute a
 * clerk got round to pointing the call at a desk, and `work_minutes` counts only the minutes
 * the desk is open, so a Friday-evening call owed to a desk that opens Monday at 08:00 is not
 * a breach at 03:00. A desk with no SLA gets NULL, because a deadline the platform invented on
 * a desk's behalf is a promise the platform would then have to keep.
 *
 * Coalesce is the statement: an escalation moves the work and must not reset the deadline the
 * first desk was already measured against. `$3` means "this act is the arrival" and is true
 * only when the call is first logged — that the call came in while the desk was shut is a fact
 * about the phone call, not about whoever last touched the row, and it never goes back to
 * false. Params: ticket, tenant, arrival.
 */
export const TICKET_CLOCK_SQL = `
  update support_tickets t
     set response_due_at = coalesce(t.response_due_at,
           case when d.first_response_minutes is null then null
                else platform_auth.work_minutes(
                       t.ts, d.first_response_minutes, d.business_hours) end),
         resolution_due_at = coalesce(t.resolution_due_at,
           case when d.resolve_minutes is null then null
                else platform_auth.work_minutes(
                       t.ts, d.resolve_minutes, d.business_hours) end),
         after_hours = t.after_hours
                       or ($3::boolean and not platform_auth.inside_hours(
                             t.ts, d.business_hours)),
         updated_at = now()
    from platform_departments d
   where d.id = t.department_id and d.tenant_id = t.tenant_id and d.deleted_at is null
     and t.id = $1 and t.tenant_id = $2 and t.deleted_at is null
   returning t.id, t.ts, t.status, t.response_due_at, t.resolution_due_at, t.after_hours,
            d.id as department_id, upper(d.key) as department_key, d.name as department_name,
            d.first_response_minutes, d.resolve_minutes,
            platform_auth.inside_hours(now(), d.business_hours) as desk_is_open_now`;

/** The first act that puts a human on the call stops the response clock — work, a note, or
 *  settling it. Never logging, and never an automatic receipt (123), because a desk that
 *  greens its own first-response rate while nobody has read the ticket is reporting a number
 *  it made up. Params: ticket, tenant. */
export const FIRST_RESPONSE_SQL = `
  update support_tickets
     set first_response_at = coalesce(first_response_at, now()), updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and department_id is not null and status in ('open','allocated','in_progress')
   returning id, ref, first_response_at, updated_at`;

/**
 * Hand it to the desk above, because the desk holding it could not answer in time.
 *
 * Everything the caller was told stays: the global number, the desk's own queue number and the
 * two deadlines all ride up with the work, and the two `escalated_*` columns say who failed to
 * answer and when. `department_id = $3` makes the write a compare-and-swap — if a second clerk
 * moved the call between the read and this statement, nobody gets an escalation logged against
 * a desk that no longer holds it. Params: ticket, tenant, from, to, actor.
 */
export const ESCALATE_SQL = `
  update support_tickets
     set department_id = $4, status = 'allocated',
         allocated_by = $5, allocated_at = now(),
         escalated_from_id = $3, escalated_at = now(),
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and department_id = $3 and status in ('open','allocated','in_progress')
   returning id, ref, dept_ref, status, department_id, allocated_at,
             escalated_from_id, escalated_at, updated_at`;

/**
 * The queue. `reporter_phone_encrypted` is not in this column list at all — a list endpoint
 * that could show a number is a list endpoint that will.
 *
 * Params: tenant, statuses[], department|null, departmentIds[]|null (the `mine` scope),
 *         category|null, priority|null, pattern|null, phoneHash|null, company|null,
 *         days, clock|null, channel|null, tag|null, limit, offset.
 *
 * The pattern searches `dept_ref` too, because that is the string the caller was given on the
 * phone: a register that cannot be searched by the number it read out is a register that gets
 * asked to re-find the call by its subject.
 *
 * The tags come back as one JSON array per row rather than as a second query, because the desk
 * reads them on every line and a queue that needs 60 round trips through a remote pooler to
 * draw its chips is a queue that gets its chips removed. A folded line is listed with the
 * keeper's number beside it — the row is evidence, and the desk has to be able to see both.
 */
export const TICKETS_SQL = `
  select t.id, t.ref, t.ts, t.updated_at, t.reporter_name, t.reporter_email,
         t.channel, t.category, t.subject, t.priority, t.status, t.language,
         t.company_tenant_id, t.company_name, t.department_id, d.name as department_name,
         t.dept_ref, t.dept_number, upper(n.key) as numbered_by_key, n.name as numbered_by_name,
         t.response_due_at, t.resolution_due_at, t.first_response_at,
         t.after_hours, t.escalated_at, ef.name as escalated_from_name,
         t.reopen_count, t.last_reopened_at,
         t.merged_into_id, mk.ref as merged_into_ref, t.merged_at,
         ${CLOCK_STATES}
         (t.reporter_phone_encrypted is not null) as has_phone,
         t.allocated_at, t.resolved_at,
         a.full_name as allocated_by_name,
         (select count(*)::int from support_ticket_events e where e.ticket_id = t.id) as events,
         (select count(*)::int from documents f
           where f.entity_type = 'support_ticket' and f.entity_id = t.id
             and f.tenant_id = t.tenant_id and f.deleted_at is null) as files,
         (select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'colour', g.colour)
                          order by g.name)
            from support_ticket_taggings gg
            join support_ticket_tags g on g.id = gg.tag_id and g.deleted_at is null
           where gg.ticket_id = t.id and gg.deleted_at is null
             and gg.tenant_id = t.tenant_id) as tags,
         (select e.ts from support_ticket_events e where e.ticket_id = t.id
           order by e.ts desc, e.id desc limit 1) as last_activity
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
    left join platform_departments n on n.id = t.numbered_by
    left join platform_departments ef on ef.id = t.escalated_from_id
    left join support_tickets mk on mk.id = t.merged_into_id and mk.tenant_id = t.tenant_id
    left join users a on a.id = t.allocated_by and a.tenant_id = t.tenant_id
   where t.tenant_id = $1 and t.deleted_at is null
     and ($2::text[] is null or t.status = any($2))
     and ($3::uuid is null or t.department_id = $3)
     and ($4::uuid[] is null or t.department_id = any($4))
     and ($5::text is null or t.category = $5)
     and ($6::text is null or t.priority = $6)
     and ($7::text is null or t.ref ilike $7 or t.dept_ref ilike $7
                        or t.subject ilike $7 or t.body ilike $7
                        or t.company_name ilike $7 or t.reporter_name ilike $7)
     and ($8::text is null or t.reporter_phone_search = $8)
     and ($9::uuid is null or t.company_tenant_id = $9)
     and t.ts >= now() - make_interval(days => $10::int)
     and ($11::text is null
          or ($11 = 'late' and t.status in ('open','allocated','in_progress')
              and ((t.first_response_at is null and t.response_due_at < now())
                   or t.resolution_due_at < now()))
          or ($11 = 'on_time' and t.status in ('open','allocated','in_progress')
              and (t.response_due_at is null or t.first_response_at is not null
                   or t.response_due_at >= now())
              and (t.resolution_due_at is null or t.resolution_due_at >= now()))
          or ($11 = 'no_clock' and t.status in ('open','allocated','in_progress')
              and t.response_due_at is null and t.resolution_due_at is null))
     and ($12::text is null or t.channel = $12)
     and ($13::uuid is null or exists (select 1 from support_ticket_taggings gg
                                        where gg.ticket_id = t.id and gg.tag_id = $13
                                          and gg.deleted_at is null))
   order by (t.priority = 'urgent') desc,
            (t.status in ('open','allocated','in_progress')) desc,
            t.ts desc
   limit $14 offset $15`;

/** The same filter without the cap, so the header and the rows cannot disagree.
 *  Params: as the queue, without limit and offset. */
export const TICKETS_COUNT_SQL = `
  select count(*)::int as n,
         count(*) filter (where t.status = 'open')::int as unallocated,
         count(*) filter (where t.status in ('allocated','in_progress'))::int as working,
         count(*) filter (where t.status in ('resolved','closed'))::int as settled,
         count(*) filter (where t.status = 'merged')::int as folded,
         count(*) filter (where t.priority in ('high','urgent')
                          and t.status in ('open','allocated','in_progress'))::int as pressing,
         count(*) filter (where t.status in ('open','allocated','in_progress')
                          and ((t.first_response_at is null and t.response_due_at < now())
                               or t.resolution_due_at < now()))::int as overdue,
         count(*) filter (where t.status in ('open','allocated','in_progress')
                          and t.first_response_at is null)::int as unanswered,
         count(*) filter (where t.status in ('open','allocated','in_progress')
                          and t.response_due_at is null
                          and t.resolution_due_at is null)::int as no_clock,
         count(*) filter (where t.status in ('open','allocated','in_progress')
                          and t.dept_ref is null)::int as unnumbered,
         count(*) filter (where t.status in ('allocated','in_progress')
                          and t.reopen_count > 0)::int as reopened
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null
     and ($2::text[] is null or t.status = any($2))
     and ($3::uuid is null or t.department_id = $3)
     and ($4::uuid[] is null or t.department_id = any($4))
     and ($5::text is null or t.category = $5)
     and ($6::text is null or t.priority = $6)
     and ($7::text is null or t.ref ilike $7 or t.dept_ref ilike $7
                        or t.subject ilike $7 or t.body ilike $7
                        or t.company_name ilike $7 or t.reporter_name ilike $7)
     and ($8::text is null or t.reporter_phone_search = $8)
     and ($9::uuid is null or t.company_tenant_id = $9)
     and t.ts >= now() - make_interval(days => $10::int)
     and ($11::text is null
          or ($11 = 'late' and t.status in ('open','allocated','in_progress')
              and ((t.first_response_at is null and t.response_due_at < now())
                   or t.resolution_due_at < now()))
          or ($11 = 'on_time' and t.status in ('open','allocated','in_progress')
              and (t.response_due_at is null or t.first_response_at is not null
                   or t.response_due_at >= now())
              and (t.resolution_due_at is null or t.resolution_due_at >= now()))
          or ($11 = 'no_clock' and t.status in ('open','allocated','in_progress')
              and t.response_due_at is null and t.resolution_due_at is null))
     and ($12::text is null or t.channel = $12)
     and ($13::uuid is null or exists (select 1 from support_ticket_taggings gg
                                        where gg.ticket_id = t.id and gg.tag_id = $13
                                          and gg.deleted_at is null))`;

/** One incidence, this tenant's only, with the encrypted column for the detail read.
 *  The desk's own terms come along on the same row — the hours it keeps, what it promised, who
 *  is above it and how long it lets a settled call come back — because a panel that shows a
 *  deadline without the week it was counted against is the panel that gets argued with, and a
 *  reopen button that does not know the window will be pressed and refused.
 *  Params: id, tenant. */
export const TICKET_SQL = `
  select t.id, t.ref, t.ts, t.updated_at, t.reporter_name, t.reporter_email,
         t.reporter_phone_encrypted, t.channel, t.category, t.subject, t.body,
         t.priority, t.status, t.language, t.company_tenant_id, t.company_name,
         t.department_id, d.name as department_name, d.key as department_key,
         t.dept_number, t.dept_ref, t.numbered_by,
         upper(n.key) as numbered_by_key, n.name as numbered_by_name,
         t.response_due_at, t.resolution_due_at, t.first_response_at, t.after_hours,
         t.escalated_at, t.escalated_from_id, ef.name as escalated_from_name,
         t.reopen_count, t.last_reopened_at,
         t.merged_into_id, t.merged_at, mk.ref as merged_into_ref,
         mk.status as merged_into_status, mk.dept_ref as merged_into_dept_ref,
         mb.full_name as merged_by_name,
         t.breach_alerted_at,
         d.first_response_minutes, d.resolve_minutes, d.business_hours,
         d.max_open_tickets, d.reopen_days, d.escalation_department_id, d.head_user_id,
         h.full_name as department_head_name,
         platform_auth.inside_hours(now(), d.business_hours) as desk_is_open_now,
         upper(ea.key) as escalation_key, ea.name as escalation_name,
         ${CLOCK_STATES}
         t.allocated_at, t.resolved_at, t.resolution,
         a.full_name as allocated_by_name,
         r.full_name as resolved_by_name,
         c.full_name as created_by_name,
         (select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'colour', g.colour)
                          order by g.name)
            from support_ticket_taggings gg
            join support_ticket_tags g on g.id = gg.tag_id and g.deleted_at is null
           where gg.ticket_id = t.id and gg.deleted_at is null
             and gg.tenant_id = t.tenant_id) as tags,
         (select count(*)::int from documents f
           where f.entity_type = 'support_ticket' and f.entity_id = t.id
             and f.tenant_id = t.tenant_id and f.deleted_at is null) as files
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
    left join platform_departments n on n.id = t.numbered_by
    left join platform_departments ef on ef.id = t.escalated_from_id
    left join platform_departments ea on ea.id = d.escalation_department_id
    left join support_tickets mk on mk.id = t.merged_into_id
                                 and mk.tenant_id = t.tenant_id
    left join users a on a.id = t.allocated_by and a.tenant_id = t.tenant_id
    left join users r on r.id = t.resolved_by and r.tenant_id = t.tenant_id
    left join users c on c.id = t.created_by and c.tenant_id = t.tenant_id
    left join users mb on mb.id = t.merged_by and mb.tenant_id = t.tenant_id
    left join users h on h.id = d.head_user_id
   where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null`;

/** Everything that has ever been done to it, oldest first — the desk reads it as a story.
 *  The actor is named from users; whether the line says "you" is the desk's call, since it
 *  knows whose session is reading. Params: ticket, tenant. */
export const TICKET_EVENTS_SQL = `
  select e.id, e.ts, e.action, e.reason, e.from_label, e.to_label,
         e.department_from_id, e.department_to_id, e.detail,
         e.actor_user_id, e.actor_role, a.full_name as actor_name
    from support_ticket_events e
    left join users a on a.id = e.actor_user_id and a.tenant_id = e.tenant_id
   where e.ticket_id = $1 and e.tenant_id = $2
   -- 104's sequence, not (ts, id): two acts of one request share the transaction's now(), and
   -- id is a random uuid, so ordering by it printed "allocated" above the "logged" that caused
   -- it. The desk shows this list as the story an operator quotes back to a caller.
   order by e.seq`;

/** Params: tenant, ticket, ref, actor, role, ip, requestId, action, fromLabel, toLabel,
 *  departmentFrom, departmentTo, reason, detail. */
export const INSERT_EVENT_SQL = `
  insert into support_ticket_events
    (tenant_id, ticket_id, ref, actor_user_id, actor_role, ip, request_id, action,
     from_label, to_label, department_from_id, department_to_id, reason, detail)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
  returning id, ts`;

/** Hand it over, or send it back to the pool. Params: id, tenant, department|null, actor.
 *  Clearing the department also clears the allocation: 101's CHECK says a ticket with an
 *  allocated_at must have somebody to point at, and "back in the queue" means nobody has it.
 *  The queue number is not touched — it belongs to the desk that issued it (123), and the
 *  caller is still quoting it. */
export const ALLOCATE_SQL = `
  update support_tickets
     set department_id = $3,
         status = case when $3::uuid is null then 'open' else 'allocated' end,
         allocated_by = case when $3::uuid is null then null else $4::uuid end,
         allocated_at = case when $3::uuid is null then null else now() end,
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, ref, dept_ref, status, department_id, allocated_at, updated_at`;

/** Start or restart work on an incidence a department already holds. Who did it is the
 *  event's business, not the row's — the row only has room for who allocated and who settled.
 *  Starting work is a human act, so it stops the response clock (123: an automatic receipt must
 *  not green a desk's own rate).
 *
 *  A reopen clears the stamp instead. "The caller says it is still not fixed" and "we answered
 *  that on Tuesday" cannot both be true of the same attempt: the deadline the desk is measured
 *  against is the one it owes *now*, and the answer that was already given stays where answers
 *  are kept — in the events register, which keeps every line the row ever had.
 *
 *  The two deadlines themselves are not touched here. 125's before-update trigger refuses a
 *  reopen that lands outside the desk's window and, when it allows one, re-makes both deadlines
 *  from the desk's terms and counts the attempt — so `reopen_count` is read back from the row
 *  it has already been written to, not from a second query.
 *  Params: id, tenant, status, reopened. */
export const WORK_SQL = `
  update support_tickets
     set status = $3, updated_at = now(),
         resolved_at = null, resolved_by = null,
         first_response_at = case when $4::boolean then null
                                  else coalesce(first_response_at, now()) end
   where id = $1 and tenant_id = $2 and deleted_at is null
     and department_id is not null
   returning id, ref, dept_ref, status, resolved_at, first_response_at, response_due_at,
             resolution_due_at, reopen_count, last_reopened_at, updated_at`;

/** Settle it. Params: id, tenant, outcome, resolution, actor. */
export const RESOLVE_SQL = `
  update support_tickets
     set status = $3, resolution = $4, resolved_by = $5, resolved_at = now(),
         first_response_at = coalesce(first_response_at, now()),
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and department_id is not null
   returning id, ref, dept_ref, status, resolution, resolved_at, first_response_at,
             response_due_at, resolution_due_at, updated_at`;

/** Re-rate it. Params: id, tenant, priority. */
export const PRIORITY_SQL = `
  update support_tickets set priority = $3, updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, ref, priority, updated_at`;

/** Take it off the boards without destroying it — the register keeps every line it has ever
 *  had, and a purged incidence is the one thing a support record cannot afford (101).
 *  Params: id, tenant, actor. */
export const TOMBSTONE_SQL = `
  update support_tickets set deleted_at = now(), deleted_by = $3, updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, ref`;

/**
 * Fold a duplicate into the line that stays (125).
 *
 * The status and the pointer are written together because `support_tickets_fold_is_whole` says
 * they must, and the guard trigger then refuses anything this statement is not supposed to do —
 * a fold into a retired line, into one that is itself folded, or back out again. The route's own
 * refusals are for the cases the desk could not act on; the trigger's are the floor under them.
 * Params: id, tenant, keeper, actor.
 */
export const MERGE_SQL = `
  update support_tickets
     set status = 'merged', merged_into_id = $3, merged_at = now(), merged_by = $4,
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and status <> 'merged' and merged_into_id is null
   returning id, ref, status, merged_into_id, merged_at, department_id, dept_ref`;

/** Everything the fold decision needs about the line that stays, and about the one that is
 *  going away, in one read. Params: keeper, duplicate, tenant. */
export const FOLD_PAIR_SQL = `
  select k.id, k.ref, k.status, k.subject, k.department_id, k.dept_ref,
         k.merged_into_id as keeper_merged_into, d.name as department_name,
         (select count(*)::int from support_tickets x
           where x.merged_into_id = k.id and x.deleted_at is null
             and x.tenant_id = k.tenant_id) as already_folded,
         g.id as dup_id, g.ref as dup_ref, g.status as dup_status,
         g.subject as dup_subject, g.merged_into_id as dup_merged_into,
         gd.name as dup_department_name
    from support_tickets k
    left join platform_departments d on d.id = k.department_id
    join support_tickets g on g.id = $2 and g.tenant_id = $3
    left join platform_departments gd on gd.id = g.department_id
   where k.id = $1 and k.tenant_id = $3`;

/** The lines already folded under a keeper, so the desk can see the whole shape of the call
 *  after it has made its decision. Params: keeper, tenant. */
export const FOLDED_UNDER_SQL = `
  select t.id, t.ref, t.subject, t.merged_at, u.full_name as merged_by_name
    from support_tickets t
    left join users u on u.id = t.merged_by and u.tenant_id = t.tenant_id
   where t.merged_into_id = $1 and t.tenant_id = $2 and t.deleted_at is null
   order by t.merged_at desc`;

// ---------- the tags the desk makes up for itself ----------

/** Every live tag, with how much work is wearing it. Params: tenant.
 *  `live` counts only incidences still on the boards: a tag whose three calls are all folded
 *  reads as a label nobody uses, which is the fact the desk needs before it retires it. */
export const TAGS_SQL = `
  select g.id, g.name, g.colour, g.note, g.created_at, g.updated_at,
         coalesce(c.live, 0)::int as live,
         coalesce(c.all_rows, 0)::int as tagged
    from support_ticket_tags g
    left join lateral (
      select count(*) filter (where t.status <> 'merged')::int as live,
             count(*)::int as all_rows
        from support_ticket_taggings gg
        join support_tickets t on t.id = gg.ticket_id and t.deleted_at is null
       where gg.tag_id = g.id and gg.deleted_at is null
    ) c on true
   where g.tenant_id = $1 and g.deleted_at is null
   order by lower(g.name)`;

/** One live tag. Params: tag, tenant. */
export const TAG_SQL = `
  select id, name, colour, note, created_at, updated_at
    from support_ticket_tags
   where id = $1 and tenant_id = $2 and deleted_at is null`;

/** Params: tenant, name, colour|null, note|null, actor. */
export const INSERT_TAG_SQL = `
  insert into support_ticket_tags (tenant_id, name, colour, note, created_by, updated_by)
  values ($1, lower($2), $3, nullif($4, ''), $5, $5)
  returning id, name, colour, note, created_at`;

/** Params: tag, tenant, actor, name, colour|null, note|null.
 *  Both halves are presence-tested for the same reason 123's terms are: a colour a desk
 *  deliberately cleared must not be re-filled by whatever was there before. */
export const UPDATE_TAG_SQL = `
  update support_ticket_tags
     set name = lower($4), colour = $5, note = nullif($6, ''), updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, name, colour, note, updated_at`;

/** Retire a label — the taggings under it stay, because "who had this marked port delay and
 *  when did they take it off" is the question a tag answers when something went wrong (125).
 *  Params: tag, tenant, actor. */
export const TOMBSTONE_TAG_SQL = `
  update support_ticket_tags
     set deleted_at = now(), deleted_by = $3, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, name`;

/** Put one label on one incidence. Params: tenant, ticket, tag, actor. */
export const APPLY_TAGGING_SQL = `
  insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
  values ($1, $2, $3, $4)
  returning id, ticket_id, tag_id, applied_at`;

/** Take it off again, by retiring the pairing rather than removing it.
 *  Params: tenant, ticket, tag, actor. */
export const RETIRE_TAGGING_SQL = `
  update support_ticket_taggings
     set deleted_at = now(), deleted_by = $4
   where tenant_id = $1 and ticket_id = $2 and tag_id = $3 and deleted_at is null
   returning id, tag_id, deleted_at`;

/** The tags a live incidence is wearing, in the shape the queue uses. Params: ticket, tenant. */
export const TICKET_TAGS_SQL = `
  select g.id, g.name, g.colour, gg.applied_at
    from support_ticket_taggings gg
    join support_ticket_tags g on g.id = gg.tag_id and g.deleted_at is null
   where gg.ticket_id = $1 and gg.tenant_id = $2 and gg.deleted_at is null
   order by lower(g.name)`;

/** Is this label already on that call? Params: tenant, ticket, tag.
 *  Read before the insert so the desk gets "it already wears that" instead of a unique-index
 *  violation naming a constraint. The index is still the guard — two clerks clicking at once
 *  is a thing that happens on a shared queue. */
export const TAG_ON_TICKET_SQL = `
  select gg.id from support_ticket_taggings gg
   where gg.tenant_id = $1 and gg.ticket_id = $2 and gg.tag_id = $3 and gg.deleted_at is null`;

/** A label looked up by the name the desk is about to type. Params: tenant, name. */
export const FIND_TAG_SQL = `
  select g.id, g.name from support_ticket_tags g
   where g.tenant_id = $1 and g.name = lower($2) and g.deleted_at is null`;

/** How many live calls wear this label, counted before it is retired. Params: tag, tenant. */
export const TAGGING_COUNT_SQL = `
  select count(*) filter (where t.deleted_at is null)::int as live, count(*)::int as rows
    from support_ticket_taggings gg
    join support_tickets t on t.id = gg.ticket_id
   where gg.tenant_id = $1 and gg.tag_id = $2 and gg.deleted_at is null`;

// ---------- the answers the office gives every week ----------

/** Params: tenant, category|null, language|null, pattern|null.
 *  `sw` and `en` are not two rows: one answer carries both texts, because the office writes the
 *  sentence once and the caller's own language decides which half goes out (125). A reply with
 *  no Swahili half is listed anyway and the desk chooses — forcing a translation into the column
 *  would put words in the office's mouth that the office never picked. */
export const REPLIES_SQL = `
  select r.id, r.slug, r.title, r.body_en, r.body_sw, r.category, r.is_active, r.note,
         r.created_at, r.updated_at,
         (u.full_name) as updated_by_name
    from support_canned_replies r
    left join users u on u.id = r.updated_by and u.tenant_id = r.tenant_id
   where r.tenant_id = $1 and r.deleted_at is null
     and ($2::text is null or r.category = $2)
     and ($3::text is null or (r.body_sw is not null and $3 = 'sw')
                            or ($3 = 'en'))
     and ($4::text is null or r.slug ilike $4 or r.title ilike $4
                            or r.body_en ilike $4 or r.body_sw ilike $4)
   order by r.is_active desc, lower(r.title)`;

/** Params: reply, tenant. */
export const REPLY_SQL = `
  select r.id, r.slug, r.title, r.body_en, r.body_sw, r.category, r.is_active, r.note,
         r.created_at, r.updated_at
    from support_canned_replies r
   where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null`;

/** A retired answer frees its name (125's unique index is partial), so this looks at live rows
 *  only — the same set the index covers, which is what lets the route answer "already an answer
 *  here" instead of tripping the index and reporting a constraint.
 *  Params: tenant, slug. */
export const FIND_REPLY_SQL = `
  select r.id, r.slug, r.title, r.is_active
    from support_canned_replies r
   where r.tenant_id = $1 and r.slug = lower($2) and r.deleted_at is null`;

/** Params: tenant, slug, title, body_en, body_sw|null, category|null, note|null, actor. */
export const INSERT_REPLY_SQL = `
  insert into support_canned_replies
    (tenant_id, slug, title, body_en, body_sw, category, note, created_by, updated_by)
  values ($1, lower($2), $3, $4, nullif($5, ''), $6, nullif($7, ''), $8, $8)
  returning id, slug, title, body_en, body_sw, category, note, is_active`;

/** Params: reply, tenant, actor, title, body_en, body_sw|null, category|null, note|null,
 *  isActive. */
export const UPDATE_REPLY_SQL = `
  update support_canned_replies
     set title = $4, body_en = $5, body_sw = nullif($6, ''),
         category = $7, note = nullif($8, ''), is_active = $9::boolean, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, slug, title, body_en, body_sw, category, note, is_active, updated_at`;

/** Params: reply, tenant, actor. */
export const TOMBSTONE_REPLY_SQL = `
  update support_canned_replies
     set deleted_at = now(), deleted_by = $3, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, slug, title`;

// ---------- the paper on an incidence ----------

/** Params: tenant, ticket. */
export const TICKET_FILES_SQL = `
  select f.id, f.kind, f.file_name, f.mime_type, f.size_bytes, f.created_at,
         u.full_name as uploaded_by_name
    from documents f
    left join users u on u.id = f.uploaded_by and u.tenant_id = f.tenant_id
   where f.tenant_id = $1 and f.entity_type = 'support_ticket' and f.entity_id = $2
     and f.deleted_at is null
   order by f.created_at desc`;

/** Params: document, tenant. */
export const FILE_SQL = `
  select f.id, f.entity_id, f.kind, f.file_name, f.mime_type, f.size_bytes,
         f.storage_path, f.created_at
    from documents f
   where f.id = $1 and f.tenant_id = $2 and f.entity_type = 'support_ticket'
     and f.deleted_at is null`;

/** Params: id, tenant, ticket, name, mime, bytes, path, actor. */
export const INSERT_FILE_SQL = `
  insert into documents (id, tenant_id, entity_type, entity_id, kind, file_name, mime_type,
                         size_bytes, storage_path, uploaded_by, created_by, updated_by)
  values ($1, $2, 'support_ticket', $3, 'attachment', $4, $5, $6, $7, $8, $8, $8)
  returning id, file_name, mime_type, size_bytes, created_at`;

/** Params: document, tenant, actor. */
export const RETIRE_FILE_SQL = `
  update documents set deleted_at = now(), updated_by = $3
   where id = $1 and tenant_id = $2 and entity_type = 'support_ticket'
     and deleted_at is null
   returning id, file_name`;

// ---------- the clock that ran out and the head who was told ----------

/** The breach board: live calls whose answer or finish is already past the desk's own promise.
 *  Params: tenant.
 *
 *  Grouped by desk, because the person who acts on a missed promise is the desk, not the row —
 *  and the desk head is the one the notice goes to. `unalerted` counts the lines nobody has been
 *  told about in the last twelve hours, which is what decides whether the button does anything. */
export const BREACH_BOARD_SQL = `
  select d.id as department_id, upper(d.key) as department_key, d.name as department_name,
         d.head_user_id, u.full_name as head_name,
         count(*)::int as breached,
         count(*) filter (where t.first_response_at is null
                          and t.response_due_at < now())::int as unanswered_over,
         count(*) filter (where t.resolution_due_at < now())::int as unresolved_over,
         count(*) filter (where t.breach_alerted_at is null
                          or t.breach_alerted_at < now() - interval '12 hours')::int as unalerted,
         max(t.breach_alerted_at) as last_alerted_at,
         min(least(coalesce(t.response_due_at, t.resolution_due_at),
                   coalesce(t.resolution_due_at, t.response_due_at))) as worst_overdue_since
    from support_tickets t
    join platform_departments d on d.id = t.department_id and d.tenant_id = t.tenant_id
    left join users u on u.id = d.head_user_id
   where t.tenant_id = $1 and t.deleted_at is null
     and t.status in ('open','allocated','in_progress')
     and ((t.first_response_at is null and t.response_due_at < now())
          or t.resolution_due_at < now())
   group by d.id, u.full_name
   order by count(*) desc, upper(d.name)`;

/** The live lines one desk owes an alert for right now. Params: tenant, department|null.
 *  The twelve hours is the route's decision about people, restated here so the read and the
 *  write agree: a desk that has already been told this morning is not told again at lunchtime,
 *  and a desk that was told yesterday is told again today. */
export const BREACH_ALERT_LIST_SQL = `
  select t.id, t.ref, t.subject, t.priority, t.channel, t.language, t.company_name,
         t.reporter_name, t.dept_ref, t.response_due_at, t.resolution_due_at,
         t.first_response_at, t.breach_alerted_at, t.department_id,
         count(*) over ()::int as total
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null
     and t.status in ('open','allocated','in_progress')
     and ($2::uuid is null or t.department_id = $2)
     and ((t.first_response_at is null and t.response_due_at < now())
          or t.resolution_due_at < now())
     and (t.breach_alerted_at is null
          or t.breach_alerted_at < now() - interval '12 hours')
   order by t.resolution_due_at, (t.priority = 'urgent') desc
   limit 100`;

/** Stamp the alert on the lines it went out about. Params: tenant, actor, ids[]. */
export const STAMP_BREACH_ALERT_SQL = `
  update support_tickets
     set breach_alerted_at = now(), breach_alerted_by = $2, updated_at = now()
   where tenant_id = $1 and deleted_at is null and id = any($3::uuid[])
     and status in ('open','allocated','in_progress')
   returning id, ref`;

/** The same overdue test as the board, summed over the whole tenant instead of desk by desk, so
 *  the panel cannot be read as "no desk is breached" when the work is sitting in a queue nobody
 *  has been given. Params: tenant. */
export const BREACH_TOTAL_SQL = `
  select count(*)::int as breached,
         count(*) filter (where t.first_response_at is null
                          and t.response_due_at < now())::int as unanswered_over,
         count(*) filter (where t.resolution_due_at < now())::int as unresolved_over,
         count(*) filter (where t.breach_alerted_at is null
                          or t.breach_alerted_at < now() - interval '12 hours')::int as unalerted,
         count(*) filter (where t.department_id is null)::int as unheld,
         min(least(coalesce(t.response_due_at, t.resolution_due_at),
                   coalesce(t.resolution_due_at, t.response_due_at))) as worst_overdue_since
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null
     and t.status in ('open','allocated','in_progress')
     and ((t.first_response_at is null and t.response_due_at < now())
          or t.resolution_due_at < now())`;

/** The calls with no desk at all. They are never "overdue" in the register's terms — with no
 *  desk there is no SLA, so 123 gives them no deadline and there is no promise to have missed.
 *  Said here as a wait instead, because an unallocated line nobody has promised anything to is
 *  exactly the call that falls between two offices. Params: tenant. */
export const BREACH_UNHELD_SQL = `
  select count(*)::int as n,
         min(t.ts) as oldest_since,
         count(*) filter (where t.ts < now() - interval '24 hours')::int as waiting_over_a_day
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null
     and t.department_id is null and t.status = 'open'`;

/** A desk head's own address, read only at the moment a notice is about to leave. Params: user,
 *  tenant. Never selected by a queue or a panel response — the register keeps callers' numbers
 *  encrypted, and a platform staff address is not something to print on every page load. */
export const DESK_HEAD_EMAIL_SQL = `
  select u.id, u.full_name, u.email, u.language
    from users u
   where u.id = $1 and u.tenant_id = $2 and u.deleted_at is null and u.status = 'active'`;

/** The seat writing the answer, for the `{agent}` a clerk's own name fills. Params: user, tenant.
 *  No `status` filter: requireControl has already said this seat may be at a desk, and a name
 *  that came back null here would silently drop the clerk out of a reply they can see on screen. */
export const ACTING_SEAT_SQL = `
  select u.id, u.full_name, u.language
    from users u
   where u.id = $1 and u.tenant_id = $2 and u.deleted_at is null`;

/** One incidence as the bulk desk needs it — enough to decide and to name the refusal, without
 *  the desk's terms, the tags and the clock that a detail read carries. The keeper's number is
 *  here for the same reason: a folded line is refused by name, and this read runs up to fifty
 *  times in one request.
 *  Params: id, tenant. */
export const BULK_ROW_SQL = `
  select t.id, t.ref, t.status, t.priority, t.department_id, t.merged_into_id,
         mk.ref as merged_into_ref, t.deleted_at, d.name as department_name
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
    left join support_tickets mk on mk.id = t.merged_into_id and mk.tenant_id = t.tenant_id
   where t.id = $1 and t.tenant_id = $2`;

/** The labels a bulk tagging is about to wear, checked in one read: a request that named a
 *  retired or foreign tag moves nothing at all rather than half-applying a list.
 *  Params: tenant, ids[]. */
export const TAGS_BY_ID_SQL = `
  select g.id, g.name from support_ticket_tags g
   where g.tenant_id = $1 and g.deleted_at is null and g.id = any($2::uuid[])`;

/** Where the work is sitting, desk by desk. This is the "their panel" the register exists
 *  to feed — and since 123 it is also the board that says which desk is past a promise, which
 *  one has no clock set at all, and how near its own ceiling it has come. Params: tenant. */
export const DEPARTMENT_LOAD_SQL = `
  select d.id, d.key, d.name, d.sort,
         d.first_response_minutes, d.resolve_minutes, d.max_open_tickets,
         d.escalation_department_id,
         platform_auth.inside_hours(now(), d.business_hours) as desk_is_open_now,
         coalesce(count(t.id) filter (where t.status = 'open'), 0)::int as unallocated,
         coalesce(count(t.id) filter (where t.status in ('allocated','in_progress')), 0)::int as working,
         coalesce(count(t.id) filter (where t.status in ('allocated','in_progress')
                                      and t.priority in ('high','urgent')), 0)::int as pressing,
         coalesce(count(t.id) filter (where t.status in ('resolved','closed')), 0)::int as settled,
         coalesce(count(t.id) filter (where t.status in ('open','allocated','in_progress')
             and ((t.first_response_at is null and t.response_due_at < now())
                  or t.resolution_due_at < now())), 0)::int as overdue,
         coalesce(count(t.id) filter (where t.status in ('open','allocated','in_progress')
                                      and t.first_response_at is null), 0)::int as unanswered,
         coalesce(count(t.id) filter (where t.status in ('open','allocated','in_progress')
                                      and t.response_due_at is null
                                      and t.resolution_due_at is null), 0)::int as no_clock,
         coalesce(count(t.id) filter (where t.status in ('open','allocated','in_progress')
                                      and t.dept_ref is null), 0)::int as unnumbered,
         coalesce(count(t.id) filter (where t.status in ('open','allocated','in_progress')), 0)::int
           as live_tickets,
         min(t.ts) filter (where t.status in ('allocated','in_progress')) as oldest_open
    from platform_departments d
    left join support_tickets t
           on t.department_id = d.id and t.tenant_id = $1 and t.deleted_at is null
    where d.tenant_id = $1 and d.deleted_at is null
    group by d.id
   order by d.sort, upper(d.name)`;

/** The desks the caller actually sits in. Params: user, tenant.
 *  The same live predicate 084's chart reads — a cover that ran out is not a desk. */
export const MY_DEPARTMENTS_SQL = `
  select m.department_id as id, d.name, d.key
    from platform_seat_departments m
    join platform_departments d on d.id = m.department_id
                                and d.deleted_at is null and d.tenant_id = $2
   where m.user_id = $1 and m.tenant_id = $2
     and m.released_at is null
     and (m.ends_at is null or m.ends_at > now())
   order by d.sort, upper(d.name)`;

/** An open department, with the terms it keeps. For the picker, for the guard on every
 *  handover, and for the ceiling the register reads before it adds to a desk's queue. Named
 *  apart from 084's DEPARTMENT_SQL because that one carries heads and seat counts, and the
 *  register only needs to know the desk exists and how full it is.
 *  Params: department, tenant. */
export const OPEN_DEPARTMENT_SQL = `
  select d.id, d.key, d.name,
         d.first_response_minutes, d.resolve_minutes, d.business_hours,
         d.max_open_tickets, d.escalation_department_id,
         platform_auth.inside_hours(now(), d.business_hours) as desk_is_open_now,
         (select count(*)::int from support_tickets t
           where t.department_id = d.id and t.tenant_id = $2 and t.deleted_at is null
             and t.status in ('open','allocated','in_progress')) as live_tickets
    from platform_departments d
   where d.id = $1 and d.tenant_id = $2 and d.deleted_at is null`;

/** Who the register is about, when it is a company on the platform. Params: id.
 *  A definer (102): the row belongs to somebody else's tenant and tenants_self (001:405)
 *  would otherwise hide it from the check that is supposed to protect the link. */
export const COMPANY_SQL = `select * from platform_auth.support_company_lookup($1)`;

/** The caller's own history with this number, so the desk can say "third time this month"
 *  before it picks up. Params: tenant, search hash. Never returns the number itself. */
export const CALLER_HISTORY_SQL = `
  select count(*)::int as calls,
         count(*) filter (where t.status in ('open','allocated','in_progress'))::int as still_open,
         count(*) filter (where t.ts >= now() - interval '30 days')::int as last_30d,
         min(t.ts) as first_call, max(t.ts) as last_call
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null and t.reporter_phone_search = $2`;

/** The region a company's head office sits in — the only geography a routing rule can match
 *  on, and the reason 123 says a company with no branch on file matches a region rule the
 *  same way a mismatch does: not at all. Params: company tenant.
 *  Bound by the company's own id, not by the session's: this read is made from the platform
 *  desk about somebody else's row, and this connection bypasses row-level security. */
export const COMPANY_HQ_REGION_SQL = `
  select b.region_id, g.name_en as region_name
    from branches b
    left join geo_regions g on g.id = b.region_id
   where b.tenant_id = $1 and b.kind = 'hq' and b.deleted_at is null
   limit 1`;

// ---------- gates ----------

async function requireTicketRead(req: any): Promise<boolean> {
  const held = await controlHolds(req, [VIEW, MANAGE]);
  const canManage = held.includes(MANAGE);
  if (!canManage && !held.includes(VIEW)) {
    throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
  }
  return canManage;
}

async function requireTicketManage(req: any) {
  if (!(await controlHolds(req, [MANAGE])).includes(MANAGE)) {
    throw new ApiError("FORBIDDEN",
      "Reading the register is one duty; logging a call, pointing it at a department and "
      + "settling it is another. Yours does not include it.", 403);
  }
}

function ticketId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(String(value ?? ""));
  if (!parsed.success) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
  return parsed.data;
}

/** The callback number, read back for the seat that is allowed to ring it. */
function phoneOf(row: any): { phone: string | null; phone_unreadable: boolean } {
  if (!row.reporter_phone_encrypted) return { phone: null, phone_unreadable: false };
  try {
    return { phone: decryptField(row.reporter_phone_encrypted), phone_unreadable: false };
  } catch {
    // A blob this key cannot open is a fact about the row, not a crash: the desk has to say
    // the number is on file and unreadable rather than print nothing at all.
    return { phone: null, phone_unreadable: true };
  }
}

/**
 * The register indexes the hash of the E.164 string, so a number search only finds the calls
 * it should when the term is hashed in that same shape. Two things break a match on the raw
 * query: Fastify's default parser decodes a "+" in a query string to a space, and an operator
 * types a number the way they heard it — "+255 717 601 440". Both used to hash a value no row
 * carries, so the desk answered "this number never called" with total confidence. Same
 * canonical form the login lookup uses (auth.routes.ts identitySearches).
 */
function phoneSearchTerm(raw: string): string {
  return searchHash("+" + raw.replace(/\D/g, ""));
}

/** Whether the desk has said "no more than this many live calls".
 *
 *  This is the ceiling 123 deliberately left out of the schema: a database rule that refuses
 *  the write would also refuse the one act that must always be allowed — an escalation into a
 *  busy desk, because a ticket that cannot move is a ticket nobody is answering. So it is a
 *  choice the register makes in words, at the two places a human is making a choice, and the
 *  escalation names the fact that it went over. */
function atCeiling(desk: { max_open_tickets: number | null; live_tickets: number }) {
  return desk.max_open_tickets !== null && desk.max_open_tickets <= desk.live_tickets;
}

/** Whether a line is finished work. Two of the doors below ask this before they let a clerk
 *  touch a settled incidence, and 125's sixth state needs the same question — a folded line is
 *  as unworkable as a closed one, by a different route. */
const isSettled = (status: string) => (SETTLED as readonly string[]).includes(status);

/**
 * 125's guards refuse with the codes that mean "this row is not allowed to change that way"
 * (23514, 22023), "the line you pointed at is not on the register" (23503) and "that write
 * crosses a tenant" (42501). None of the four is a server fault, and each already carries a
 * sentence written for the desk — the reopen window names the days and the ceiling, the fold
 * guard names the keeper and its own reason. So the doors pass the words through as a 409
 * instead of re-deriving them here and letting the two copies drift apart.
 *
 * The prefix is dropped because it names the *table*. An operator does not care that
 * `support_tickets` objected; they care that CS-2026-00114 was settled forty days ago.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = (err as any)?.code;
  if (!["23514", "22023", "P0001", "23503", "42501"].includes(String(code))) return null;
  const line = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^(support_tickets|support_ticket_taggings|support_canned_replies|platform_departments):\s*/i, "");
  return new ApiError("CONFLICT", line || fallback, 409);
}

/** Every door that changes work refuses a folded line, in the same words, and says where the
 *  call actually is. Without this the desk gets 125's CHECK violation about a pointer it did
 *  not know existed; with it, the answer is the keeper's number. */
function refuseFolded(row: any, verb: string): void {
  if (row.status !== "merged") return;
  throw new ApiError("CONFLICT",
    `${row.ref} is folded into ${row.merged_into_ref ?? "another incidence"}, which is where `
    + `this call is being answered — nothing ${verb} here. Open the keeper instead.`, 409);
}

export async function controlTicketRoutes(app: FastifyInstance, _opts: unknown) {
  const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;

  /** One act on one incidence: the register line first, then the ordinary audit row. Both on
   *  the caller's transaction, so an act that failed to record itself also failed to happen
   *  — the same rule 084's org chart runs on. */
  const record = async (c: PoolClient, req: any, row: {
    ticket: { id: string; ref: string };
    action: typeof ACTIONS[number];
    fromLabel?: string | null; toLabel?: string | null;
    deptFrom?: string | null; deptTo?: string | null;
    reason: string; detail?: object;
  }) => {
    const t = await c.query(INSERT_EVENT_SQL, [
      req.control.tenant_id, row.ticket.id, row.ticket.ref, req.control.user_id,
      role(req), req.ip ?? null, req.requestId ?? null, row.action,
      row.fromLabel ?? null, row.toLabel ?? null, row.deptFrom ?? null, row.deptTo ?? null,
      row.reason, JSON.stringify(row.detail ?? {})
    ]);
    await writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id,
      actorRole: role(req), ip: req.ip, requestId: req.requestId,
      userAgent: req.headers["user-agent"] ?? null,
      entity: "support_tickets", entityId: row.ticket.id,
      action: `control.tickets.${row.action}`,
      before: { ref: row.ticket.ref, from: row.fromLabel ?? null },
      after: { ref: row.ticket.ref, to: row.toLabel ?? null, reason: row.reason,
        event_id: t.rows[0].id }
    });
    return t.rows[0];
  };

  /**
   * Give the incidence its desk's queue number and start that desk's clock — the two acts 123
   * added to the register — in the same transaction as the write that put the call on the desk,
   * so a ticket is never sitting on one with neither a number to quote nor a date to be
   * answered by.
   *
   * A mint that comes back `unavailable` does not fail the write. The call was taken, and that
   * is the part nobody can redo after the phone hangs up; whoever next moves the work issues the
   * number, and `unnumbered` on the department board says how many are waiting for one.
   */
  const numberAndClock = async (c: PoolClient, req: any, ticket: {
    id: string; ref: string; dept_ref?: string | null;
  }, departmentId: string, arrival: boolean) => {
    const tenantId = req.control.tenant_id;
    const clocked = await c.query(TICKET_CLOCK_SQL, [ticket.id, tenantId, arrival]);
    if (ticket.dept_ref) {
      return { clock: clocked.rows[0] ?? null, dept_ref: ticket.dept_ref, mint: null };
    }
    const mint = (await c.query(MINT_DESK_NUMBER_SQL, [departmentId])).rows[0].minted;
    if (mint?.status !== "ok") return { clock: clocked.rows[0] ?? null, dept_ref: null, mint };
    const stamped = await c.query(STAMP_DESK_NUMBER_SQL, [
      ticket.id, tenantId, mint.number, mint.ref, mint.department_id
    ]);
    return { clock: clocked.rows[0] ?? null,
      dept_ref: stamped.rows[0]?.dept_ref ?? null, mint };
  };

  /** The one sentence about the clock that the desk cannot infer from the columns themselves —
   *  returned as `null` when there is nothing to explain, so the panel does not have to guess
   *  which of its own captions are warnings.
   *
   *  The third case is 123's: `work_minutes` gives up after 400 days rather than invent a date,
   *  so a desk that has shut its whole week gets "no date can be promised" instead of a NULL
   *  the caller would read as "no deadline". */
  const clockNote = (clock: any) => {
    if (!clock) {
      return "The desk this call landed on is no longer on the chart, so no answer time was set "
        + "for it. Allocate the incidence to an open desk to start a clock.";
    }
    if (clock.first_response_minutes === null && clock.resolve_minutes === null) {
      return `"${clock.department_name}" has set no answer time, so this call has no deadline — `
        + "the desk's terms are where that changes.";
    }
    if (clock.after_hours && !clock.desk_is_open_now) {
      return `Logged out of hours: ${clock.department_name}'s clock runs from the minute the `
        + "desk next opens.";
    }
    if ((clock.first_response_minutes !== null && !clock.response_due_at)
      || (clock.resolve_minutes !== null && !clock.resolution_due_at)) {
      return `No date can be promised: ${clock.department_name}'s working week does not contain `
        + "enough open time to answer this call.";
    }
    return null;
  };

  // ---------- the queue ----------
  app.get("/control/tickets", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireTicketRead(req);
    await enforceRateLimit(`tickets:uid:${req.control.user_id}`, 60, 60);
    const q = z.object({
      status: z.string().trim().max(200).optional(),
      department: z.string().uuid().optional(),
      // A query string only ever holds a string, and z.coerce.boolean() turns "false" into
      // true — the tab would stick on. Ask for one of the words that mean yes.
      mine: z.string().max(8).optional().transform((v) =>
        v === "1" || v === "true" || v === "yes"),
      category: z.enum(CATEGORIES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      q: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(24).optional().refine(
        (v) => v === undefined || v.replace(/\D/g, "").length >= 8,
        { message: "A number search needs at least eight digits, e.g. +255717601440." }),
      company: z.string().uuid().optional(),
      clock: z.enum(CLOCKS).optional(),
      // Which source the call came in on. The web tab labels it in words; the register holds
      // the table's own eight, so a filter that accepts a ninth would silently match nothing.
      channel: z.enum(CHANNELS).optional(),
      tag: z.string().uuid().optional(),
      days: DAYS,
      limit: LIMIT,
      offset: z.coerce.number().int().min(0).max(100_000).default(0)
    }).strict().parse(req.query ?? {});

    const statuses = q.status
      ? [...new Set(q.status.split(",").map((s) => s.trim()).filter(Boolean))] : null;
    if (statuses?.length) {
      const bad = statuses.filter((s) => !STATUSES.includes(s as any));
      if (bad.length) {
        throw new ApiError("VALIDATION_FAILED",
          `Not a state an incidence can be in: ${bad.join(", ")}`, 400, [{ field: "status" }]);
      }
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      // Read once: the tab needs its own desks whether or not it is filtered to them, and a
      // second round trip over the pooler for the same rows is the difference between a
      // queue that opens and one that stalls.
      const myDesks = (await c.query(MY_DEPARTMENTS_SQL, [req.control.user_id, tenantId])).rows;
      // An empty array means "this seat sits at no desk", and `= any('{}')` matches nothing —
      // which is the honest answer. Falling back to null here would show the whole platform
      // queue to somebody who asked for their own desk and does not have one.
      const mineIds = q.mine ? myDesks.map((m: any) => m.id as string) : null;
      const filter = [
        tenantId, statuses?.length ? statuses : null, q.department ?? null, mineIds,
        q.category ?? null, q.priority ?? null, q.q ? `%${q.q}%` : null,
        q.phone ? phoneSearchTerm(q.phone) : null, q.company ?? null, q.days,
        q.clock ?? null, q.channel ?? null, q.tag ?? null
      ];
      const rows = await c.query(TICKETS_SQL, [...filter, q.limit, q.offset]);
      const total = await c.query(TICKETS_COUNT_SQL, filter);
      const load = await c.query(DEPARTMENT_LOAD_SQL, [tenantId]);

      return {
        can_manage: canManage,
        window_days: q.days,
        filters: {
          status: statuses ?? null, department: q.department ?? null, mine: q.mine,
          category: q.category ?? null, priority: q.priority ?? null, q: q.q ?? null,
          phone_searched: !!q.phone, company: q.company ?? null, clock: q.clock ?? null,
          channel: q.channel ?? null, tag: q.tag ?? null
        },
        summary: total.rows[0] ?? {},
        departments: load.rows,
        my_departments: myDesks,
        // The register holds only timestamptz columns, so pg's Date serialises in UTC on its
        // own — the day-shift guard invoices needed is not needed here.
        items: rows.rows
      };
    });
  });

  // ---------- log a call ----------
  app.post("/control/tickets", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const body = z.object({
      reporterName: z.string().trim().min(2).max(140),
      reporterEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
      reporterPhone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).nullish(),
      channel: z.enum(CHANNELS).default("phone_call"),
      companyTenantId: z.string().uuid().nullish(),
      companyName: z.string().trim().min(2).max(140).nullish(),
      category: z.enum(CATEGORIES),
      subject: z.string().trim().min(4).max(140),
      body: z.string().trim().min(10).max(4000),
      priority: z.enum(PRIORITIES).default("normal"),
      language: z.enum(LANGUAGES).default("en"),
      departmentId: z.string().uuid().nullish(),
      reason: REASON.nullish()
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      let company = body.companyName ?? null;
      if (body.companyTenantId) {
        const found = await c.query(COMPANY_SQL, [body.companyTenantId]);
        if (!found.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "That company is not a live account on the platform. Type the name the caller "
            + "gave instead — the register keeps what was said.", 400, [{ field: "companyTenantId" }]);
        }
        // The platform's own spelling wins: the link and the label must not be able to
        // disagree about who a call was about.
        company = found.rows[0].name;
      }
      if (!company) {
        throw new ApiError("VALIDATION_FAILED",
          "Say which company rang. If it is not on the platform yet, type the name as the "
          + "caller said it.", 400, [{ field: "companyName" }]);
      }
      let dept: any = null;
      if (body.departmentId) {
        const d = await c.query(OPEN_DEPARTMENT_SQL, [body.departmentId, tenantId]);
        if (!d.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "That department is not an open desk on the platform chart.", 400,
            [{ field: "departmentId" }]);
        }
        // A clerk choosing a full desk by hand is a human choice, so the ceiling 123 left out
        // of the schema is checked here — but logging is the one act that must never be
        // refused, because the call has already happened and the register exists to keep it.
        // So the call is taken, pointed at the desk, and the desk is told it is over its own
        // line; the same figure is what stops a later hand-over at the allocate door.
        dept = d.rows[0];
      }

      // Nobody chose a desk, so the rules get to. This is the "who takes this call" question
      // 123 was written for, and it is answered by the register rather than by whoever happened
      // to pick up the phone.
      let routed: any = null;
      let region: { id: number; name: string | null } | null = null;
      if (!dept) {
        let regionId: number | null = null;
        if (body.companyTenantId) {
          const hq = (await c.query(COMPANY_HQ_REGION_SQL, [body.companyTenantId])).rows[0];
          if (hq && hq.region_id !== null) {
            regionId = hq.region_id;
            region = { id: hq.region_id, name: hq.region_name ?? null };
          }
        }
        const match = (await c.query(ROUTE_MATCH_SQL, [
          tenantId, body.channel, body.category, body.priority, body.language, regionId
        ])).rows[0].matched;
        // The definer only ever names a desk that is open, so a rule cannot route work into a
        // drawer somebody filed away.
        if (match?.status === "rule") routed = match;
      }

      const made = await c.query(INSERT_TICKET_SQL, [
        tenantId, body.reporterName, body.reporterEmail ?? "",
        body.reporterPhone ? encryptField(body.reporterPhone) : null,
        body.reporterPhone ? searchHash(body.reporterPhone) : "",
        body.channel, body.companyTenantId ?? null, company, body.category,
        body.subject, body.body, body.priority, dept?.id ?? null, req.control.user_id,
        body.language
      ]);
      const ticket = made.rows[0];

      // A routed call keeps 101's `open` state and takes the desk the rule named: the number
      // says whose problem it is, and `open` says nobody has started on it yet.
      const heldId = dept?.id ?? routed?.department_id ?? null;
      if (!dept && routed) {
        await c.query(POINT_ROUTED_SQL, [ticket.id, tenantId, routed.department_id]);
      }

      const numbered = heldId
        ? await numberAndClock(c, req, ticket, heldId, true)
        : { clock: null, dept_ref: null, mint: null };

      const overCeiling = dept ? atCeiling(dept)
        : routed ? atCeiling({ max_open_tickets: routed.max_open_tickets,
            live_tickets: routed.open_tickets }) : false;

      await record(c, req, {
        ticket, action: "logged",
        toLabel: body.subject, deptTo: heldId,
        reason: body.reason ?? `Called in about: ${body.subject}.`,
        detail: {
          channel: body.channel, category: body.category, priority: body.priority,
          language: body.language, company, reporter: body.reporterName,
          callback_on_file: !!body.reporterPhone,
          dept_ref: numbered.dept_ref,
          response_due_at: numbered.clock?.response_due_at ?? null,
          resolution_due_at: numbered.clock?.resolution_due_at ?? null,
          after_hours: numbered.clock?.after_hours ?? false
        }
      });
      if (dept) {
        await record(c, req, {
          ticket, action: "allocated", toLabel: dept.name, deptTo: dept.id,
          reason: `Logged straight to ${dept.name}. ${body.reason ?? body.subject}.`,
          detail: {
            dept_ref: numbered.dept_ref, by: "the clerk who took the call",
            over_ceiling: overCeiling, ceiling: dept.max_open_tickets,
            open_tickets: dept.live_tickets
          }
        });
      } else if (routed) {
        // `fired` on the rules board counts this line, which is why the rule's id is in the
        // detail rather than only its name: a rule renamed next month still has to be able to
        // show what it did.
        await record(c, req, {
          ticket, action: "routed",
          toLabel: `${routed.department_name} (by rule "${routed.rule_name}")`,
          deptTo: routed.department_id,
          reason: `No desk was named, so the rule "${routed.rule_name}" at precedence `
            + `${routed.precedence} sent it to ${routed.department_name}.`,
          detail: {
            rule_id: routed.rule_id, rule_name: routed.rule_name,
            precedence: routed.precedence, matched_by: routed.matched_by,
            region_tested: region?.id ?? null, region_name: region?.name ?? null,
            dept_ref: numbered.dept_ref,
            over_ceiling: overCeiling, ceiling: routed.max_open_tickets,
            open_tickets: routed.open_tickets
          }
        });
      }

      return reply.code(201).send({
        ...ticket,
        company_name: company,
        allocated_to: dept?.name ?? routed?.department_name ?? null,
        routed_by_rule: routed ? routed.rule_name : null,
        dept_ref: numbered.dept_ref,
        dept_number: numbered.mint?.number ?? null,
        number_note: heldId && !numbered.dept_ref
          ? String(numbered.mint?.message
              ?? "That desk could not issue a queue number for this call.")
          : null,
        over_ceiling: overCeiling,
        clock: numbered.clock ? {
          department: numbered.clock.department_name,
          desk_is_open_now: numbered.clock.desk_is_open_now,
          after_hours: numbered.clock.after_hours,
          first_response_minutes: numbered.clock.first_response_minutes,
          resolve_minutes: numbered.clock.resolve_minutes,
          response_due_at: numbered.clock.response_due_at,
          resolution_due_at: numbered.clock.resolution_due_at
        } : null,
        clock_note: heldId ? clockNote(numbered.clock)
          // Nothing fits this call and nobody has pointed it anywhere. Saying so is the
          // register's honest answer — the queue will show it, and a rule that should have
          // caught it is the thing to go and write.
          : "No routing rule fits a call like this and no desk was named, so nobody holds it "
            + "and no clock has started. Point it at a department, or write the rule."
      });
    });
  });

  // ---------- one incidence, in full ----------
  app.get("/control/tickets/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketRead(req);
    await enforceRateLimit(`tickets-one:uid:${req.control.user_id}`, 60, 60);
    const id = ticketId(req.params.id);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(TICKET_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const ticket = found.rows[0];
      const { phone, phone_unreadable } = phoneOf(ticket);
      const events = await c.query(TICKET_EVENTS_SQL, [id, tenantId]);
      const history = phone
        ? await c.query(CALLER_HISTORY_SQL, [tenantId, searchHash(phone)])
        : null;

      const { reporter_phone_encrypted, ...rest } = ticket;
      return {
        ticket: {
          ...rest, phone, phone_unreadable,
          // The number of calls this caller has made is a fact the desk needs before it
          // picks up; the number itself stays behind the view duty and off every list.
          caller_history: history?.rows[0] ?? null
        },
        events: events.rows,
        // Same three words the write returns, so the panel that opened a call and the panel
        // that reopened it a week later explain a missing deadline the same way.
        clock_note: ticket.department_id ? clockNote(ticket)
          : "Nobody holds this incidence, so no desk has promised anything about it.",
        can_escalate: !!ticket.department_id
          && !isSettled(ticket.status) && ticket.status !== "merged",
        // The two doors the panel offers next to the status line. A folded line has neither:
        // the keeper answers it, and the panel that greyed them out has to say why in the same
        // breath — which is what merged_into_ref is for.
        can_work: ticket.status !== "merged"
      };
    });
  });

  // ---------- hand it to a department ----------
  app.post("/control/tickets/:id/allocate", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({
      departmentId: z.string().uuid().nullable(), reason: REASON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TICKET_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const before = was.rows[0];
      refuseFolded(before, "is handed over");
      // 101's CHECK will not be broken by this — resolved_at stays set and the state stays
      // legal — but a settled incidence pointed at a new desk reads as work restarted while
      // the row still claims it was finished. Reopen it in words, then hand it over.
      if (isSettled(before.status)) {
        throw new ApiError("CONFLICT",
          `${before.ref} is already ${before.status}. Reopen it first — that is the move that `
          + "says somebody has it again.", 409, [{ field: "reason" }]);
      }
      let to: any = null;
      if (body.departmentId) {
        if (body.departmentId === before.department_id) {
          throw new ApiError("CONFLICT",
            `${before.department_name ?? "That desk"} already holds ${before.ref}.`, 409,
            [{ field: "departmentId" }]);
        }
        const d = await c.query(OPEN_DEPARTMENT_SQL, [body.departmentId, tenantId]);
        if (!d.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "That department is not an open desk on the platform chart.", 400,
            [{ field: "departmentId" }]);
        }
        to = d.rows[0];
        // The ceiling bites here and not at logging: this is the moment a person is choosing to
        // put more work on a desk that has already said how much it can answer. It names its own
        // two figures, and it names the way out, because "full" with no alternative is how a
        // queue ends up silently ignored.
        if (atCeiling(to)) {
          throw new ApiError("CONFLICT",
            `"${to.name}" is at the ceiling it set for itself — ${to.live_tickets} live calls, `
            + `${to.max_open_tickets} allowed. Escalate the incidence to the desk above, or free `
            + "that desk up before handing it more work.", 409, [{ field: "departmentId" }]);
        }
      } else if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `${before.ref} is already in the unallocated queue — nobody holds it. Say which `
          + "department should.", 409, [{ field: "departmentId" }]);
      }
      const moved = await c.query(ALLOCATE_SQL, [id, tenantId, to?.id ?? null, req.control.user_id]);
      if (!moved.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);

      // A call that arrives at a desk by hand gets the same two things one gets by rule: the
      // desk's own queue number, if it does not already have one, and the desk's clock, if the
      // clock has not already started. Neither is invented — a desk with no SLA leaves the
      // deadlines empty and says so.
      const numbered = to
        ? await numberAndClock(c, req,
            { ...before, dept_ref: moved.rows[0].dept_ref }, to.id, false)
        : { clock: null, dept_ref: moved.rows[0].dept_ref ?? null, mint: null };

      const action = to ? (before.department_id ? "reallocated" : "allocated") : "reallocated";
      await record(c, req, {
        ticket: { id, ref: before.ref }, action,
        fromLabel: before.department_name, toLabel: to?.name ?? "the unallocated queue",
        deptFrom: before.department_id, deptTo: to?.id ?? null,
        reason: body.reason,
        detail: {
          from_status: before.status, to_status: moved.rows[0].status,
          dept_ref: numbered.dept_ref, kept_number: !!before.dept_ref,
          response_due_at: numbered.clock?.response_due_at ?? null,
          resolution_due_at: numbered.clock?.resolution_due_at ?? null
        }
      });
      return { ...moved.rows[0], dept_ref: numbered.dept_ref, department_name: to?.name ?? null,
        clock: numbered.clock ? {
          department: numbered.clock.department_name,
          desk_is_open_now: numbered.clock.desk_is_open_now,
          first_response_minutes: numbered.clock.first_response_minutes,
          resolve_minutes: numbered.clock.resolve_minutes,
          response_due_at: numbered.clock.response_due_at,
          resolution_due_at: numbered.clock.resolution_due_at
        } : null,
        clock_note: to ? clockNote(numbered.clock) : null };
    });
  });

  // ---------- start, or restart, work on it ----------
  app.post("/control/tickets/:id/work", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({
      status: z.enum(TO_WORK), reason: REASON,
      reopen: z.boolean().default(false)
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TICKET_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const before = was.rows[0];
      refuseFolded(before, "restarts work");
      if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `${before.ref} is nobody's yet. Allocate it to a department before saying work has `
          + "started — that is what the number means to the caller.", 409);
      }
      const settled = isSettled(before.status);
      if (settled && !body.reopen) {
        throw new ApiError("CONFLICT",
          `${before.ref} is already ${before.status}. Tick "the caller rang back" to take it `
          + "back into work — a second attempt at a finished job is a reopened one, not a "
          + "quiet edit.", 409, [{ field: "reopen" }]);
      }
      if (!settled && before.status === body.status) {
        throw new ApiError("CONFLICT", `That incidence is already ${body.status}.`, 409);
      }
      // Settling the reopen window is 125's job, not this route's: the trigger reads the
      // settled timestamp, the desk's own reopen_days and the clock, and refuses in a sentence
      // that names all three. Re-deriving "is 40 days inside 30?" here would be a second copy
      // of a rule that would then be free to disagree with the first.
      let moved: QueryResult<any>;
      try {
        moved = await c.query(WORK_SQL, [id, tenantId, body.status, settled]);
      } catch (err) {
        const refusal = guardRefusal(err,
          `${before.ref} refused to come back into work. Read the register again.`);
        if (refusal) throw refusal;
        throw err;
      }
      if (!moved.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);

      await record(c, req, {
        ticket: { id, ref: before.ref },
        action: settled ? "reopened" : "status_changed",
        fromLabel: before.status, toLabel: moved.rows[0].status,
        deptFrom: before.department_id, deptTo: before.department_id,
        reason: body.reason,
        detail: settled ? {
          reopened_from: before.status, previous_resolution: before.resolution,
          // A reopen re-makes both deadlines from the desk's terms — the second attempt is
          // measured, not a bonus period on the first — and the attempt count that says so
          // lives on the row. The first attempt stays in this register's own history.
          reopen_count: moved.rows[0].reopen_count,
          response_due_at: moved.rows[0].response_due_at,
          resolution_due_at: moved.rows[0].resolution_due_at
        } : { first_response_at: moved.rows[0].first_response_at }
      });
      return moved.rows[0];
    });
  });

  // ---------- settle it ----------
  app.post("/control/tickets/:id/resolve", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({
      outcome: z.enum(["resolved", "closed"]),
      resolution: z.string().trim().min(4).max(2000),
      reason: REASON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TICKET_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const before = was.rows[0];
      refuseFolded(before, "settles");
      if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `Nobody holds ${before.ref} yet, so nobody can say it is finished. Allocate it first.`,
          409);
      }
      if (before.status === "closed") {
        throw new ApiError("CONFLICT", `${before.ref} is closed. Reopen it to change that.`, 409);
      }
      if (before.status === "resolved" && body.outcome === "resolved") {
        throw new ApiError("CONFLICT", `${before.ref} is already resolved.`, 409);
      }
      const done = await c.query(RESOLVE_SQL,
        [id, tenantId, body.outcome, body.resolution, req.control.user_id]);
      if (!done.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);

      await record(c, req, {
        ticket: { id, ref: before.ref },
        action: body.outcome === "resolved" ? "resolved" : "closed",
        fromLabel: before.status, toLabel: body.outcome,
        deptFrom: before.department_id, deptTo: before.department_id,
        reason: body.reason, detail: { resolution: body.resolution.slice(0, 500) }
      });
      return done.rows[0];
    });
  });

  // ---------- re-rate it ----------
  app.post("/control/tickets/:id/priority", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({ priority: z.enum(PRIORITIES), reason: REASON })
      .strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TICKET_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      refuseFolded(was.rows[0], "re-rates");
      if (was.rows[0].priority === body.priority) {
        throw new ApiError("CONFLICT",
          `${was.rows[0].ref} is already ${body.priority}.`, 409, [{ field: "priority" }]);
      }
      const moved = await c.query(PRIORITY_SQL, [id, tenantId, body.priority]);
      if (!moved.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      await record(c, req, {
        ticket: { id, ref: was.rows[0].ref }, action: "priority_changed",
        fromLabel: was.rows[0].priority, toLabel: body.priority,
        deptFrom: was.rows[0].department_id, deptTo: was.rows[0].department_id,
        reason: body.reason
      });
      return moved.rows[0];
    });
  });

  // ---------- say something about it, without changing anything ----------
  app.post("/control/tickets/:id/note", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({ reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(TICKET_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      // A line written on a duplicate is a line nobody reading the keeper will find: events do
      // not follow the fold. The desk is told where the sentence belongs.
      refuseFolded(found.rows[0], "is written");
      const t = await record(c, req, {
        ticket: { id, ref: found.rows[0].ref }, action: "note_added",
        fromLabel: found.rows[0].status, toLabel: found.rows[0].status,
        deptFrom: found.rows[0].department_id, deptTo: found.rows[0].department_id,
        reason: body.reason
      });
      // Somebody has now written a sentence about this call while a desk holds it, which is a
      // human answer whatever the status column says — so the response clock stops here too.
      // On an unallocated incidence the update matches no row and the clock keeps running,
      // which is the honest read: a note in the margin is not an answer to the caller.
      const answered = await c.query(FIRST_RESPONSE_SQL, [id, tenantId]);
      return {
        id: t.id, ts: t.ts, ref: found.rows[0].ref,
        first_response_at: answered.rows[0]?.first_response_at ?? null,
        response_state: found.rows[0].response_state
      };
    });
  });

  // ---------- send it to the desk above ----------
  /**
   * Escalate: the desk holding the call could not answer it inside its own promise, so the desk
   * it named above takes it.
   *
   * Nothing the caller was told changes — the global number, the desk's queue number and both
   * deadlines ride up with the work, because 123 keeps `numbered_by` precisely so that
   * "BILLING-4" still means the call it was issued for after Billing has dropped it. What does
   * change is who is on the hook, and `escalated_from_id` is the column that says so: an
   * escalation is evidence about the desk that could not answer, not a fresh start.
   *
   * The ceiling is read and named but never used to stop this move. That is the case 123 wrote
   * the rule for: a ticket that cannot move is a ticket nobody is answering.
   */
  app.post("/control/tickets/:id/escalate", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({
      departmentId: z.string().uuid().nullish(), reason: REASON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TICKET_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const before = was.rows[0];
      refuseFolded(before, "escalates");
      if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `Nobody holds ${before.ref}, so there is no desk above it. Allocate it first — an `
          + "escalation is a desk saying it cannot answer, not a way into the queue.", 409);
      }
      if (isSettled(before.status)) {
        throw new ApiError("CONFLICT",
          `${before.ref} is already ${before.status}. Reopen it if the caller says it is not `
          + "fixed — escalating a finished job only moves the paperwork.", 409);
      }
      const target = body.departmentId ?? before.escalation_department_id ?? null;
      if (!target) {
        throw new ApiError("CONFLICT",
          `Nothing is above "${before.department_name}". Name the desk that should take it, or `
          + "set an escalation target on that desk's terms first.", 409,
          [{ field: "departmentId" }]);
      }
      if (target === before.department_id) {
        throw new ApiError("VALIDATION_FAILED",
          `"${before.department_name}" already holds ${before.ref} — escalating a call to the `
          + "desk that is already failing to answer it moves nothing.", 400,
          [{ field: "departmentId" }]);
      }
      const up = await c.query(OPEN_DEPARTMENT_SQL, [target, tenantId]);
      if (!up.rowCount) {
        throw new ApiError("VALIDATION_FAILED",
          "That department is not an open desk on the platform chart.", 400,
          [{ field: "departmentId" }]);
      }
      const desk = up.rows[0];
      const overCeiling = atCeiling(desk);

      const went = await c.query(ESCALATE_SQL, [
        id, tenantId, before.department_id, desk.id, req.control.user_id
      ]);
      if (!went.rowCount) {
        throw new ApiError("CONFLICT",
          `${before.ref} moved while this escalation was being written. Read the register again `
          + "and say who should hold it now.", 409);
      }
      // Only the deadlines that were never started are recomputed; the ones the first desk was
      // already measured against stay exactly where they were.
      const numbered = await numberAndClock(c, req,
        { id, ref: before.ref, dept_ref: went.rows[0].dept_ref }, desk.id, false);

      await record(c, req, {
        ticket: { id, ref: before.ref }, action: "escalated",
        fromLabel: before.department_name, toLabel: desk.name,
        deptFrom: before.department_id, deptTo: desk.id,
        reason: body.reason,
        detail: {
          kept_number: went.rows[0].dept_ref ?? before.dept_ref,
          over_ceiling: overCeiling, ceiling: desk.max_open_tickets,
          open_tickets: desk.live_tickets,
          response_state: before.response_state,
          response_due_at: numbered.clock?.response_due_at ?? null,
          resolution_due_at: numbered.clock?.resolution_due_at ?? null
        }
      });
      return { ...went.rows[0], dept_ref: numbered.dept_ref, department_name: desk.name,
        escalated_from_name: before.department_name, over_ceiling: overCeiling,
        clock: numbered.clock ? {
          department: numbered.clock.department_name,
          desk_is_open_now: numbered.clock.desk_is_open_now,
          first_response_minutes: numbered.clock.first_response_minutes,
          resolve_minutes: numbered.clock.resolve_minutes,
          response_due_at: numbered.clock.response_due_at,
          resolution_due_at: numbered.clock.resolution_due_at
        } : null,
        clock_note: clockNote(numbered.clock) };
    });
  });

  // ---------- take it off the boards ----------
  app.post("/control/tickets/:id/tombstone", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 20, 3600);
    const id = ticketId(req.params.id);
    const body = z.object({ reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TICKET_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const before = was.rows[0];
      refuseFolded(before, "withdraws");
      if (before.status !== "closed") {
        // The row stays reachable until somebody has written the sentence that ends it, so a
        // removal cannot be the way out of an unfinished job.
        throw new ApiError("CONFLICT",
          `Close ${before.ref} first — hiding an incidence that is still open is how a `
          + "call goes away without an answer.", 409);
      }
      // A fold pointer is a foreign key to a live line, and 125's cascade only re-points the
      // duplicates when the keeper is folded *onward*. Withdrawing the keeper would leave them
      // pointing at a door that no longer opens, so the desk has to close the call properly.
      const folds = await c.query(FOLDED_UNDER_SQL, [id, tenantId]);
      if (folds.rowCount) {
        throw new ApiError("CONFLICT",
          `${folds.rows.length} duplicate(s) are folded into ${before.ref} — `
          + `${folds.rows.map((f: any) => f.ref).join(", ")} among them. Withdraw those first, `
          + "or re-fold them onto a line that stays on the boards.", 409);
      }
      const gone = await c.query(TOMBSTONE_SQL, [id, tenantId, req.control.user_id]);
      if (!gone.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      await record(c, req, {
        ticket: { id, ref: before.ref }, action: "withdrawn",
        fromLabel: "visible in the register", toLabel: "withdrawn from the register",
        deptFrom: before.department_id, deptTo: before.department_id,
        reason: body.reason, detail: { withdrawn: true }
      });
      return { id, ref: gone.rows[0].ref, withdrawn: true };
    });
  });

  // ---------- fold a duplicate onto the line that is being answered ----------
  /**
   * Merge: two register lines for one call, and the caller does not care which one the desk
   * wrote first. The queue does — a call worked in two places is answered in neither — so the
   * duplicate stops being work: it becomes `merged`, points at its keeper, and every door that
   * changes work refuses it from here on.
   *
   * What does *not* happen is a merge of content. The subjects stay in their own rows, the
   * events stay on the line they were written on, and the keeper's deadlines and queue number
   * are untouched. A fold is a decision about who answers, not an edit of the history — which
   * is exactly why the duplicate is kept rather than deleted (101: a purged incidence is the
   * one thing a support register cannot afford).
   */
  app.post("/control/tickets/:id/merge", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({ intoId: z.string().uuid(), reason: REASON })
      .strict().parse(req.body);
    if (body.intoId === id) {
      throw new ApiError("VALIDATION_FAILED",
        "A call cannot be folded into itself.", 400, [{ field: "intoId" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(BULK_ROW_SQL, [id, tenantId]);
      if (!was.rowCount || was.rows[0].deleted_at) {
        throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      }
      const dup = was.rows[0];
      if (dup.status === "merged") {
        throw new ApiError("CONFLICT",
          `${dup.ref} is already folded into ${dup.merged_into_ref ?? "another line"}. A fold `
          + "is followed onward, never moved — that would rewrite a decision the register has "
          + "already written down.", 409);
      }
      // One read for both halves: the keeper's own state and how many lines it already carries,
      // so a third duplicate arriving at a line that is already the keeper of two is said out
      // loud rather than silently piling up.
      const pair = await c.query(FOLD_PAIR_SQL, [body.intoId, id, tenantId]);
      if (!pair.rowCount) {
        throw new ApiError("NOT_FOUND",
          "The line to keep is not in this register. Search the queue for the number the "
          + "caller gave you and pick that one.", 404, [{ field: "intoId" }]);
      }
      const keeper = pair.rows[0];
      if (keeper.status === "merged" || keeper.keeper_merged_into) {
        throw new ApiError("CONFLICT",
          `"${keeper.ref}" is itself folded into another line. Fold both duplicates into the `
          + "keeper, not into a line that has already been folded away.", 409,
          [{ field: "intoId" }]);
      }

      // The register, not this route, decides what a fold may land on: a line that has been
      // withdrawn from the chart is retired, and folding work onto it would hide it from every
      // queue at once. Its refusal is a sentence a desk can act on, so it is carried out of the
      // trigger as a 409 instead of becoming an unexplained 500.
      let folded: { rowCount: number | null };
      try {
        folded = await c.query(MERGE_SQL, [id, tenantId, body.intoId, req.control.user_id]);
      } catch (err) {
        throw guardRefusal(err, `${dup.ref} cannot be folded into that incidence.`) ?? err;
      }
      if (!folded.rowCount) {
        throw new ApiError("CONFLICT",
          `${dup.ref} moved while this fold was being written. Read the register again and say `
          + "which line stays.", 409);
      }
      // Everything the desk wrote on the duplicate is now evidence, not work — so the number of
      // lines under the keeper is read back and returned, which is what the panel shows beside
      // "this call was made three times".
      const under = await c.query(FOLDED_UNDER_SQL, [body.intoId, tenantId]);

      await record(c, req, {
        ticket: { id, ref: dup.ref }, action: "merged",
        fromLabel: dup.status, toLabel: keeper.ref,
        deptFrom: dup.department_id, deptTo: keeper.department_id,
        reason: body.reason,
        detail: {
          merged_into: body.intoId, merged_into_ref: keeper.ref,
          merged_into_department: keeper.department_name,
          dup_department: dup.department_name, dup_status: dup.status,
          keeper_holds_now: (under.rowCount ?? 0)
        }
      });
      return {
        id, ref: dup.ref, status: "merged", merged_into_id: body.intoId,
        merged_into_ref: keeper.ref, merged_into_subject: keeper.subject,
        folded_under: under.rows,
        // The folded line is no longer the one to work, so the answer the desk needs next is
        // where the work actually is — not a bare "ok".
        answer: `${dup.ref} is folded into ${keeper.ref}, which ${keeper.department_name
          ? `"${keeper.department_name}" is answering` : "nobody holds yet"}.`
      };
    });
  });

  // ---------- the same act, several times ----------
  /**
   * Bulk: the Monday-morning shape of the queue. Twelve calls arrived on one channel from one
   * company, and clicking allocate twelve times is not a feature, it is a reason the desk
   * stops using the register.
   *
   * Each line is applied on its own savepoint. That is the whole design: a desk that selects
   * fifty and gets three refusals must still have the other forty-seven moved, with the three
   * named in words — because "the request failed" would leave it unable to tell which of its
   * own calls went nowhere, and it would start again from the top and double the work.
   */
  app.post("/control/tickets/bulk", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-bulk:uid:${req.control.user_id}`, 12, 300);
    const body = z.object({
      ids: BULK_IDS,
      action: z.enum(["allocate", "escalate", "priority", "tags_add", "tags_drop"]),
      departmentId: z.string().uuid().nullish(),
      priority: z.enum(PRIORITIES).optional(),
      tagIds: z.array(z.string().uuid()).min(1).max(10).optional(),
      reason: REASON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    const needDesk = body.action === "allocate" || body.action === "escalate";
    if (needDesk && !body.departmentId) {
      throw new ApiError("VALIDATION_FAILED",
        `Bulk ${body.action} needs the desk to move the calls to.`, 400,
        [{ field: "departmentId" }]);
    }
    if (body.action === "priority" && !body.priority) {
      throw new ApiError("VALIDATION_FAILED",
        "Bulk re-rate needs the rating to give them.", 400, [{ field: "priority" }]);
    }
    if ((body.action === "tags_add" || body.action === "tags_drop") && !body.tagIds) {
      throw new ApiError("VALIDATION_FAILED",
        `Bulk ${body.action === "tags_add" ? "tag" : "unlabel"} needs the labels.`, 400,
        [{ field: "tagIds" }]);
    }

    return withTenant(tenantId, async (c) => {
      let desk: any = null;
      if (needDesk) {
        const d = await c.query(OPEN_DEPARTMENT_SQL, [body.departmentId, tenantId]);
        if (!d.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "That department is not an open desk on the platform chart.", 400,
            [{ field: "departmentId" }]);
        }
        desk = d.rows[0];
        // Refused before a single line moves. Half a bulk allocation onto a desk that has said
        // how much it can carry is worse than none: the queue would show forty of fifty on a
        // desk that promised twenty, and nobody could tell which ten went nowhere.
        if (body.action === "allocate" && atCeiling(desk)) {
          throw new ApiError("CONFLICT",
            `"${desk.name}" is at the ceiling it set for itself — ${desk.live_tickets} live `
            + `calls, ${desk.max_open_tickets} allowed. Nothing was moved. Escalate them to the `
            + "desk above instead, or free that desk up first.", 409, [{ field: "departmentId" }]);
        }
      }
      const tags = body.tagIds?.length
        ? (await c.query(TAGS_BY_ID_SQL, [tenantId, body.tagIds])).rows
        : [];
      if (tags.length !== (body.tagIds?.length ?? 0)) {
        throw new ApiError("VALIDATION_FAILED",
          "One of those labels is not on this register, or has been retired. Nothing was moved.",
          400, [{ field: "tagIds" }]);
      }

      const applied: any[] = [];
      const refused: any[] = [];
      for (const rowId of body.ids) {
        let ref: string | null = null;
        await c.query("savepoint bulk_row");
        try {
          const found = await c.query(BULK_ROW_SQL, [rowId, tenantId]);
          if (!found.rowCount) throw new ApiError("NOT_FOUND",
            "That incidence is not in the register.", 404);
          const row = found.rows[0];
          ref = row.ref;
          if (row.deleted_at) throw new ApiError("CONFLICT",
            `${row.ref} has already been withdrawn.`, 409);
          // The same sentence the single doors give, for the same reason: a folded line cannot
          // be worked, and the desk has to be told where the call is rather than that it failed.
          refuseFolded(row, "moves in bulk");

          let note: string;
          if (body.action === "allocate" || body.action === "escalate") {
            if (row.department_id === desk.id) {
              throw new ApiError("CONFLICT",
                `${row.ref} is already on "${desk.name}".`, 409);
            }
            if (body.action === "escalate" && !row.department_id) {
              throw new ApiError("CONFLICT",
                `Nobody holds ${row.ref}, so there is no desk above it. Allocate it first.`, 409);
            }
            if (isSettled(row.status)) {
              throw new ApiError("CONFLICT",
                `${row.ref} is already ${row.status}. Reopen it before moving the work.`, 409);
            }
            const went = body.action === "allocate"
              ? await c.query(ALLOCATE_SQL, [rowId, tenantId, desk.id, req.control.user_id])
              : await c.query(ESCALATE_SQL, [rowId, tenantId, row.department_id, desk.id,
                req.control.user_id]);
            if (!went.rowCount) throw new ApiError("CONFLICT",
              `${row.ref} moved while this was being written.`, 409);
            // A call that lands on a desk gets the desk's number and the desk's clock, in the
            // same transaction — the same rule the single door runs on, and bulk is not a
            // reason to leave forty calls on a board with no deadlines.
            const numbered = await numberAndClock(c, req,
              { id: rowId, ref: row.ref, dept_ref: went.rows[0].dept_ref }, desk.id, false);
            await record(c, req, {
              ticket: { id: rowId, ref: row.ref },
              action: body.action === "allocate"
                ? (row.department_id ? "reallocated" : "allocated") : "escalated",
              fromLabel: body.action === "allocate"
                ? (row.department_name ?? "the unallocated queue") : row.department_name,
              toLabel: desk.name,
              deptFrom: row.department_id, deptTo: desk.id,
              reason: body.reason,
              detail: { bulk: true, from_status: row.status, to_status: went.rows[0].status,
                dept_ref: numbered.dept_ref,
                response_due_at: numbered.clock?.response_due_at ?? null,
                resolution_due_at: numbered.clock?.resolution_due_at ?? null }
            });
            note = `${went.rows[0].status}, numbered ${numbered.dept_ref ?? "not yet"}`;
          } else if (body.action === "priority") {
            if (row.priority === body.priority) {
              throw new ApiError("CONFLICT", `${row.ref} is already ${body.priority}.`, 409);
            }
            const moved = await c.query(PRIORITY_SQL, [rowId, tenantId, body.priority]);
            if (!moved.rowCount) throw new ApiError("NOT_FOUND",
              "That incidence is not in the register.", 404);
            await record(c, req, {
              ticket: { id: rowId, ref: row.ref }, action: "priority_changed",
              fromLabel: row.priority, toLabel: body.priority,
              deptFrom: row.department_id, deptTo: row.department_id,
              reason: body.reason, detail: { bulk: true, from_status: row.status }
            });
            note = row.status === "resolved" || row.status === "closed"
              ? `rated ${body.priority} — the call is still ${row.status}, and a rating does not `
              + "reopen work" : `rated ${body.priority}`;
          } else {
            const add = body.action === "tags_add";
            // Read what the line already wears instead of letting the unique live index reject
            // it: a desk that has selected "port delay" on twelve calls, four of which already
            // have it, wants "eight labelled, four already were", not a pg constraint number.
            const wearing = new Set((await c.query(TICKET_TAGS_SQL, [rowId, tenantId]))
              .rows.map((r: any) => r.id as string));
            const touched: string[] = [];
            for (const tag of tags) {
              if (add ? wearing.has(tag.id) : !wearing.has(tag.id)) continue;
              if (add) await c.query(APPLY_TAGGING_SQL,
                [tenantId, rowId, tag.id, req.control.user_id]);
              else await c.query(RETIRE_TAGGING_SQL,
                [tenantId, rowId, tag.id, req.control.user_id]);
              await record(c, req, {
                ticket: { id: rowId, ref: row.ref }, action: add ? "tagged" : "untagged",
                fromLabel: add ? null : tag.name, toLabel: add ? tag.name : null,
                deptFrom: row.department_id, deptTo: row.department_id,
                reason: body.reason,
                detail: { bulk: true, tag: tag.name, tag_id: tag.id }
              });
              touched.push(tag.name);
            }
            if (!touched.length) {
              throw new ApiError("CONFLICT",
                `${row.ref} ${add ? "already wears" : "does not wear"} every one of those `
                + "labels.", 409);
            }
            note = `${add ? "labelled" : "unlabelled"} ${touched.join(", ")}`;
          }
          await c.query("release savepoint bulk_row");
          applied.push({ id: rowId, ref, note });
        } catch (err) {
          await c.query("rollback to savepoint bulk_row");
          const line = err instanceof ApiError
            ? err.message : guardRefusal(err, "")?.message ?? String(err).slice(0, 200);
          refused.push({ id: rowId, ref, note: line
            || `${ref ?? "That call"} is folded into another line, which is where it is being `
            + "answered. Open the keeper instead." });
        }
      }

      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_tickets", entityId: null,
        action: `control.tickets.bulk_${body.action}`,
        before: { asked: body.ids.length, ids: body.ids },
        after: { applied: applied.length, refused: refused.map((r) => ({ id: r.id, ref: r.ref })),
          reason: body.reason, department_id: desk?.id ?? null,
          priority: body.priority ?? null, tags: tags.map((t: any) => t.name) }
      });
      return {
        action: body.action, asked: body.ids.length,
        applied: applied.length, refused: refused.length,
        lines: [...applied, ...refused],
        department: desk ? { id: desk.id, name: desk.name, over_ceiling: atCeiling(desk) } : null,
        note: applied.length === 0
          ? "Nothing moved. Every line above says why."
          : `${applied.length} of ${body.ids.length} moved; ${refused.length} left exactly where `
            + "they were."
      };
    });
  });

  // ---------- the labels the desk invents for itself ----------
  /**
   * Tags are the register's one free-handed surface: a routing rule is a decision about who
   * answers, but "port delay" is a word the office uses when it talks to itself, and no
   * migration can guess it. So the desk writes them, and 125 keeps the list honest with a live
   * unique name — two labels differing only in case are two labels an afternoon gets spent
   * working out are the same one.
   */
  app.get("/control/ticket-tags", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireTicketRead(req);
    await enforceRateLimit(`ticket-tags:uid:${req.control.user_id}`, 60, 60);
    const rows = await withTenant(req.control.tenant_id,
      (c) => c.query(TAGS_SQL, [req.control.tenant_id]));
    return { can_manage: canManage, items: rows.rows };
  });

  app.post("/control/ticket-tags", { preHandler: [requireControl] }, async (req: any, reply: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`ticket-tags-write:uid:${req.control.user_id}`, 30, 300);
    const body = z.object({ name: TAG_NAME, colour: TAG_COLOUR, note: z.string().trim().max(160).nullish() })
      .strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const clash = await c.query(FIND_TAG_SQL, [tenantId, body.name]);
      if (clash.rowCount) {
        throw new ApiError("CONFLICT",
          `A label called "${body.name}" is already on the register. Put the old one to work, `
          + "or retire it first — two names for one problem is what the filter cannot show.", 409,
          [{ field: "name" }]);
      }
      let made: QueryResult<any>;
      try {
        made = await c.query(INSERT_TAG_SQL, [tenantId, body.name, body.colour ?? null,
          body.note ?? null, req.control.user_id]);
      } catch (err) {
        const refusal = guardRefusal(err,
          `"${body.name}" is not a label this register can hold.`);
        if (refusal) throw refusal;
        if ((err as any)?.code === "23505") {
          throw new ApiError("CONFLICT", `A label called "${body.name}" already exists.`, 409,
            [{ field: "name" }]);
        }
        throw err;
      }
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_ticket_tags", entityId: made.rows[0].id,
        action: "control.ticket_tags.created",
        before: null, after: { name: made.rows[0].name, colour: made.rows[0].colour ?? null }
      });
      return reply.code(201).send({ ...made.rows[0], live: 0, tagged: 0 });
    });
  });

  app.put("/control/ticket-tags/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`ticket-tags-write:uid:${req.control.user_id}`, 30, 300);
    const id = ticketId(req.params.id);
    // The whole label, every time: a tag is three short fields, and a panel that sends two of
    // them would leave the desk unable to tell an omitted colour from a cleared one.
    const body = z.object({ name: TAG_NAME, colour: TAG_COLOUR,
      note: z.string().trim().max(160).nullish() }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TAG_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "No such label on this register.", 404);
      const before = was.rows[0];
      const clash = await c.query(FIND_TAG_SQL, [tenantId, body.name]);
      if (clash.rowCount && clash.rows[0].id !== id) {
        throw new ApiError("CONFLICT",
          `"${clash.rows[0].name}" is already a label on this register.`, 409,
          [{ field: "name" }]);
      }
      let renamed: QueryResult<any>;
      try {
        renamed = await c.query(UPDATE_TAG_SQL, [id, tenantId, req.control.user_id, body.name,
          body.colour ?? null, body.note ?? ""]);
      } catch (err) {
        const refusal = guardRefusal(err, `"${body.name}" is not a label this register can hold.`);
        if (refusal) throw refusal;
        if ((err as any)?.code === "23505") {
          throw new ApiError("CONFLICT", `A label called "${body.name}" already exists.`, 409,
            [{ field: "name" }]);
        }
        throw err;
      }
      if (!renamed.rowCount) throw new ApiError("NOT_FOUND", "No such label on this register.", 404);
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_ticket_tags", entityId: id, action: "control.ticket_tags.updated",
        before: { name: before.name, colour: before.colour, note: before.note },
        after: { name: renamed.rows[0].name, colour: renamed.rows[0].colour,
          note: renamed.rows[0].note }
      });
      return renamed.rows[0];
    });
  });

  app.post("/control/ticket-tags/:id/tombstone", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`ticket-tags-write:uid:${req.control.user_id}`, 20, 3600);
    const id = ticketId(req.params.id);
    const body = z.object({ reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(TAG_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "No such label on this register.", 404);
      // (tenant, tag) — the order the read is written in. Reversed, every retirement answers
      // "0 live call(s) still carry it" on a label the register is wearing.
      const wearing = await c.query(TAGGING_COUNT_SQL, [tenantId, id]);
      const gone = await c.query(TOMBSTONE_TAG_SQL, [id, tenantId, req.control.user_id]);
      if (!gone.rowCount) throw new ApiError("NOT_FOUND", "No such label on this register.", 404);
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_ticket_tags", entityId: id, action: "control.ticket_tags.retired",
        before: { name: was.rows[0].name },
        after: { name: gone.rows[0].name, reason: body.reason,
          left_on_calls: wearing.rows[0]?.live ?? 0 }
      });
      return {
        id, name: gone.rows[0].name, retired: true,
        // Retiring a label does not unlabel the calls that wore it — 125 keeps the taggings as
        // history. The desk has to be told that, or it will read the empty list as a deletion.
        note: `${wearing.rows[0]?.live ?? 0} live call(s) still carry "${was.rows[0].name}". `
          + "Taking the label off is done on each incidence, not here."
      };
    });
  });

  // ---------- put a label on one call, take it off again ----------
  app.post("/control/tickets/:id/tags", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({ tagId: z.string().uuid(), reason: REASON })
      .strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(BULK_ROW_SQL, [id, tenantId]);
      if (!found.rowCount || found.rows[0].deleted_at) {
        throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      }
      const row = found.rows[0];
      refuseFolded(row, "is labelled");
      const tag = (await c.query(TAG_SQL, [body.tagId, tenantId])).rows[0];
      if (!tag) {
        throw new ApiError("VALIDATION_FAILED",
          "That label is not on this register, or has been retired. Make it first.", 400,
          [{ field: "tagId" }]);
      }
      const already = (await c.query(TAG_ON_TICKET_SQL, [tenantId, id, body.tagId])).rowCount;
      if (already) {
        throw new ApiError("CONFLICT",
          `${row.ref} already wears "${tag.name}".`, 409, [{ field: "tagId" }]);
      }
      try {
        await c.query(APPLY_TAGGING_SQL, [tenantId, id, body.tagId, req.control.user_id]);
      } catch (err) {
        const refusal = guardRefusal(err, `"${tag.name}" cannot go on ${row.ref}.`);
        if (refusal) throw refusal;
        if ((err as any)?.code === "23505") {
          throw new ApiError("CONFLICT", `${row.ref} already wears "${tag.name}".`, 409,
            [{ field: "tagId" }]);
        }
        throw err;
      }
      await record(c, req, {
        ticket: { id, ref: row.ref }, action: "tagged",
        fromLabel: null, toLabel: tag.name,
        deptFrom: row.department_id, deptTo: row.department_id,
        reason: body.reason, detail: { tag_id: body.tagId }
      });
      return { id, ref: row.ref, tags: (await c.query(TICKET_TAGS_SQL, [id, tenantId])).rows };
    });
  });

  app.post("/control/tickets/:id/tags/drop", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({ tagId: z.string().uuid(), reason: REASON })
      .strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(BULK_ROW_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const row = found.rows[0];
      const tag = (await c.query(TAG_SQL, [body.tagId, tenantId])).rows[0]
        ?? { name: row.ref, id: body.tagId };
      // The read is by tag id alone, so a label retired since can still be taken off a call
      // that is wearing it — which is the one thing a retired tag must still allow.
      const off = await c.query(RETIRE_TAGGING_SQL, [tenantId, id, body.tagId, req.control.user_id]);
      if (!off.rowCount) {
        throw new ApiError("CONFLICT",
          `${row.ref} does not wear that label. Nothing was taken off.`, 409,
          [{ field: "tagId" }]);
      }
      await record(c, req, {
        ticket: { id, ref: row.ref }, action: "untagged",
        fromLabel: tag.name, toLabel: null,
        deptFrom: row.department_id, deptTo: row.department_id,
        reason: body.reason, detail: { tag_id: body.tagId, tag_name: tag.name }
      });
      return { id, ref: row.ref, tags: (await c.query(TICKET_TAGS_SQL, [id, tenantId])).rows };
    });
  });

  // ---------- the answers the office gives every week ----------
  /**
   * Canned replies exist because the same three questions arrive every day — a code that did
   * not land, a licence paid and not filed, a cargo stuck at the port — and a clerk who writes
   * the answer from memory writes it twelve different ways.
   *
   * One row holds both languages. The caller's own `language` on the incidence picks which
   * half goes out, so the office writes the sentence once and Kiswahili is not an afterthought
   * somebody remembers under pressure. Swahili stays optional per reply: a customs form is a
   * customs form, and forcing a machine-translation into the column would put words in the
   * office's mouth that the office never chose.
   */
  app.get("/control/canned-replies", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireTicketRead(req);
    await enforceRateLimit(`canned:uid:${req.control.user_id}`, 60, 60);
    const q = z.object({
      category: z.enum(CATEGORIES).optional(),
      language: z.enum(LANGUAGES).optional(),
      q: z.string().trim().max(120).optional()
    }).strict().parse(req.query ?? {});
    const rows = await withTenant(req.control.tenant_id, (c) => c.query(REPLIES_SQL,
      [req.control.tenant_id, q.category ?? null, q.language ?? null,
        q.q ? `%${q.q}%` : null]));
    return {
      can_manage: canManage,
      filters: { category: q.category ?? null, language: q.language ?? null, q: q.q ?? null },
      tokens: CANNED_TOKENS,
      items: rows.rows
    };
  });

  app.post("/control/canned-replies", { preHandler: [requireControl] },
    async (req: any, reply: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`canned-write:uid:${req.control.user_id}`, 30, 300);
    const body = z.object({
      slug: REPLY_SLUG,
      title: z.string().trim().min(3).max(80),
      bodyEn: z.string().trim().min(4).max(1200),
      bodySw: z.string().trim().min(4).max(1200).nullish(),
      category: z.enum(CATEGORIES).nullish(),
      note: z.string().trim().max(240).nullish()
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;
    // Checked here as well as in the trigger, because only the route can say which half of the
    // form has the bad brace and put the field label back on it.
    const invented = [...new Set([...unknownTokens(body.bodyEn),
      ...unknownTokens(body.bodySw ?? "")])];
    if (invented.length) {
      throw new ApiError("VALIDATION_FAILED",
        `A reply can only use the placeholders the register fills in. Not understood: `
        + `${invented.join(", ")}.`, 400, [{ field: "bodyEn" }, { field: "bodySw" }]);
    }

    return withTenant(tenantId, async (c) => {
      const clash = await c.query(FIND_REPLY_SQL, [tenantId, body.slug]);
      if (clash.rowCount) {
        throw new ApiError("CONFLICT",
          `"${body.slug}" is already an answer on this register (${clash.rows[0].title}). `
          + "Edit that one, or give this a different name.", 409, [{ field: "slug" }]);
      }
      let made: QueryResult<any>;
      try {
        made = await c.query(INSERT_REPLY_SQL, [tenantId, body.slug, body.title, body.bodyEn,
          body.bodySw ?? null, body.category ?? null, body.note ?? null, req.control.user_id]);
      } catch (err) {
        const refusal = guardRefusal(err, `"${body.slug}" is not an answer this register can hold.`);
        if (refusal) throw refusal;
        if ((err as any)?.code === "23505") {
          throw new ApiError("CONFLICT", `"${body.slug}" is already an answer here.`, 409,
            [{ field: "slug" }]);
        }
        throw err;
      }
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_canned_replies", entityId: made.rows[0].id,
        action: "control.canned_replies.created",
        before: null,
        after: { slug: made.rows[0].slug, title: made.rows[0].title,
          category: made.rows[0].category ?? null, has_sw: !!made.rows[0].body_sw }
      });
      // A create answers 201 like every other write that makes a new row on this register — the
      // clerk who just saved an answer should not have to wonder whether it landed.
      return reply.code(201).send(made.rows[0]);
    });
  });

  app.put("/control/canned-replies/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`canned-write:uid:${req.control.user_id}`, 30, 300);
    const id = ticketId(req.params.id);
    // The slug is not in this form: it is what a clerk types mid-call, and renaming an answer
    // out from under the people who have memorised it is worse than the typo it fixes. Fix a
    // wrong slug by retiring the reply and writing a new one.
    const body = z.object({
      title: z.string().trim().min(3).max(80),
      bodyEn: z.string().trim().min(4).max(1200),
      bodySw: z.string().trim().min(4).max(1200).nullish(),
      category: z.enum(CATEGORIES).nullish(),
      note: z.string().trim().max(240).nullish(),
      isActive: z.boolean()
    }).strict().parse(req.body);
    const invented = [...new Set([...unknownTokens(body.bodyEn),
      ...unknownTokens(body.bodySw ?? "")])];
    if (invented.length) {
      throw new ApiError("VALIDATION_FAILED",
        `A reply can only use the placeholders the register fills in. Not understood: `
        + `${invented.join(", ")}.`, 400, [{ field: "bodyEn" }, { field: "bodySw" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(REPLY_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "No such answer on this register.", 404);
      const before = was.rows[0];
      let edited: QueryResult<any>;
      try {
        edited = await c.query(UPDATE_REPLY_SQL, [id, tenantId, req.control.user_id, body.title,
          body.bodyEn, body.bodySw ?? "", body.category ?? null, body.note ?? "",
          body.isActive]);
      } catch (err) {
        const refusal = guardRefusal(err, "That answer is not one this register can hold.");
        if (refusal) throw refusal;
        throw err;
      }
      if (!edited.rowCount) throw new ApiError("NOT_FOUND", "No such answer on this register.", 404);
      const after = edited.rows[0];
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_canned_replies", entityId: id,
        action: "control.canned_replies.updated",
        before: { slug: before.slug, title: before.title, category: before.category ?? null,
          is_active: before.is_active, has_sw: !!before.body_sw },
        after: { slug: after.slug, title: after.title, category: after.category ?? null,
          is_active: after.is_active, has_sw: !!after.body_sw }
      });
      return after;
    });
  });

  app.post("/control/canned-replies/:id/tombstone", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`canned-write:uid:${req.control.user_id}`, 20, 3600);
    const id = ticketId(req.params.id);
    const body = z.object({ reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const gone = await c.query(TOMBSTONE_REPLY_SQL, [id, tenantId, req.control.user_id]);
      if (!gone.rowCount) throw new ApiError("NOT_FOUND", "No such answer on this register.", 404);
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId,
        userAgent: req.headers["user-agent"] ?? null,
        entity: "support_canned_replies", entityId: id,
        action: "control.canned_replies.retired",
        before: { slug: gone.rows[0].slug }, after: { slug: gone.rows[0].slug,
          title: gone.rows[0].title, reason: body.reason }
      });
      return { id, slug: gone.rows[0].slug, retired: true };
    });
  });

  /** Fill the placeholders in without saving or sending anything. The desk uses this while it is
   *  writing an answer, and again on a call it has picked one for, so what it sees is what the
   *  caller would get — including the holes: a reply rendered against a call with no company on
   *  it reads "Hello ," and that is exactly what the preview has to show. */
  app.post("/control/canned-replies/preview", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketRead(req);
    await enforceRateLimit(`canned:uid:${req.control.user_id}`, 60, 60);
    const body = z.object({
      replyId: z.string().uuid().optional(),
      body: z.string().trim().max(1200).optional(),
      language: z.enum(LANGUAGES).optional(),
      ticketId: z.string().uuid().optional()
    }).strict().parse(req.body);
    if (!body.replyId && !body.body) {
      throw new ApiError("VALIDATION_FAILED",
        "Give the reply to preview: its id, or the words themselves.", 400,
        [{ field: "replyId" }, { field: "body" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const ticket = body.ticketId
        ? (await c.query(TICKET_SQL, [body.ticketId, tenantId])).rows[0] ?? null : null;
      const seat = (await c.query(ACTING_SEAT_SQL, [req.control.user_id, tenantId])).rows[0] ?? null;
      let text = body.body ?? null;
      let language = body.language ?? null;
      let reply: any = null;
      if (body.replyId) {
        reply = (await c.query(REPLY_SQL, [body.replyId, tenantId])).rows[0] ?? null;
        if (!reply) throw new ApiError("NOT_FOUND", "No such answer on this register.", 404);
        language = language ?? ticket?.language ?? "en";
        text = language === "sw" ? (reply.body_sw ?? reply.body_en) : reply.body_en;
        // Said out loud rather than fixed in silence: a desk that asked for Kiswahili and got
        // English because the office never translated this one answer needs to know that.
      }
      const rendered = renderCanned(text ?? "", contextForTicket(ticket ?? {},
        seat?.full_name ?? null));
      return {
        language,
        asked_for: body.language ?? ticket?.language ?? "en",
        fell_back: Boolean(reply && body.language === "sw" && !reply.body_sw)
          || Boolean(ticket?.language === "sw" && !reply?.body_sw && !!reply),
        reply: reply ? { id: reply.id, slug: reply.slug, title: reply.title } : null,
        text: rendered.text,
        unfilled: rendered.unfilled,
        note: rendered.unfilled.length
          ? `This call cannot fill: ${rendered.unfilled.map((t) => `{${t}}`).join(", ")}.`
          : null
      };
    });
  });

  // ---------- say the standard answer, on the line ----------
  /**
   * The reply is written into the incidence's own register, not mailed by the platform.
   *
   * 112's delivery purposes are a closed list, and 125 widened it on purpose rather than
   * letting a support answer be filed under `tenant_notice` — a register that lies about why a
   * message went out is worse than one with a line missing. There is no `support_reply` purpose
   * and no caller-facing mail gateway here, so this records the words the desk chose and the
   * channel it chose them for, and the desk sends them through the channel the call came in on.
   * What it does move is the answer clock: a human has now said something to this caller.
   */
  app.post("/control/tickets/:id/answer", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-write:uid:${req.control.user_id}`, 40, 300);
    const id = ticketId(req.params.id);
    const body = z.object({
      replyId: z.string().uuid().optional(),
      text: z.string().trim().min(4).max(2000).optional(),
      language: z.enum(LANGUAGES).optional(),
      channel: z.enum(CHANNELS).optional(),
      reason: REASON
    }).strict().parse(req.body);
    if (!body.replyId && !body.text) {
      throw new ApiError("VALIDATION_FAILED",
        "Say what was answered: pick a reply, or write the words.", 400,
        [{ field: "replyId" }, { field: "text" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(TICKET_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      const ticket = found.rows[0];
      refuseFolded(ticket, "is answered");
      const seat = (await c.query(ACTING_SEAT_SQL, [req.control.user_id, tenantId])).rows[0] ?? null;
      let text = body.text ?? null;
      let language = body.language ?? ticket.language ?? "en";
      let reply: any = null;
      let unfilled: string[] = [];
      if (body.replyId) {
        reply = (await c.query(REPLY_SQL, [body.replyId, tenantId])).rows[0] ?? null;
        if (!reply) {
          throw new ApiError("VALIDATION_FAILED",
            "That answer is not on this register.", 400, [{ field: "replyId" }]);
        }
        if (!reply.is_active) {
          throw new ApiError("CONFLICT",
            `"${reply.title}" has been retired by the office — it is not what we tell callers `
            + "any more. Write the answer yourself if this call needs it.", 409,
            [{ field: "replyId" }]);
        }
        text = language === "sw" ? (reply.body_sw ?? reply.body_en) : reply.body_en;
      }
      const rendered = renderCanned(text ?? "", contextForTicket(ticket, seat?.full_name ?? null));
      unfilled = rendered.unfilled;

      const t = await record(c, req, {
        ticket: { id, ref: ticket.ref }, action: "note_added",
        fromLabel: ticket.status, toLabel: ticket.status,
        deptFrom: ticket.department_id, deptTo: ticket.department_id,
        reason: body.reason,
        detail: {
          answered: true, language,
          channel: body.channel ?? ticket.channel,
          reply_slug: reply?.slug ?? null, reply_title: reply?.title ?? null,
          text: rendered.text.slice(0, 2000), unfilled
        }
      });
      const answered = await c.query(FIRST_RESPONSE_SQL, [id, tenantId]);
      return {
        id: t.id, ts: t.ts, ref: ticket.ref, language,
        text: rendered.text, unfilled,
        fell_back: language === "sw" && !reply?.body_sw,
        first_response_at: answered.rows[0]?.first_response_at ?? null,
        response_state: answered.rows[0]?.response_state ?? ticket.response_state
      };
    });
  });

  // ---------- the paper on an incidence ----------
  app.get("/control/tickets/:id/files", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketRead(req);
    await enforceRateLimit(`tickets-one:uid:${req.control.user_id}`, 60, 60);
    const id = ticketId(req.params.id);
    const tenantId = req.control.tenant_id;
    const rows = await withTenant(tenantId, (c) => c.query(TICKET_FILES_SQL, [tenantId, id]));
    return { items: rows.rows, storage_configured: storageConfigured() };
  });

  /**
   * Attach the photograph of the licence to the incidence about it, not to the company that
   * sent it — the reason 125 gave the platform's own file table a `support_ticket` kind.
   *
   * The bytes go through the same sniffing the tenant vault runs: a control seat renaming an
   * executable to .jpg is not a reason to let it into the bucket, and the file will be opened
   * by whoever next works the call.
   */
  app.post("/control/tickets/:id/files", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireTicketManage(req);
    const id = ticketId(req.params.id);
    const tenantId = req.control.tenant_id;
    if (!storageConfigured()) {
      throw new ApiError("STORAGE_UNAVAILABLE",
        "Uploads are not configured yet — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);
    }
    await enforceRateLimit(`ticket-files:uid:${req.control.user_id}`, 20, 3600);

    const data = await req.file();
    if (!data) throw new ApiError("VALIDATION_FAILED", "Attach a file first.", 400,
      [{ field: "file" }]);
    // Fields ride on the file part, and they must be appended before it — the same order the
    // tenant vault depends on, because a part that arrives after the file has never been seen.
    const fields = data.fields as Record<string, any>;
    const reason = z.string().trim().min(4).max(300).safeParse(fields.reason?.value ?? "");
    if (!reason.success) {
      throw new ApiError("VALIDATION_FAILED",
        "Say why this paper belongs on the call.", 400, [{ field: "reason" }]);
    }
    const bytes = await data.toBuffer();
    if (bytes.length === 0) throw new ApiError("VALIDATION_FAILED", "The file is empty.", 400);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ApiError("VALIDATION_FAILED", "Files are limited to 8 MB.", 400, [{ field: "file" }]);
    }
    const mime = (data.mimetype || "").toLowerCase();
    if (!FILE_MIMES.includes(mime) || sniffFileType(bytes) !== mime) {
      throw new ApiError("VALIDATION_FAILED",
        "A file on a call must be a real JPEG, PNG, WebP or PDF.", 400, [{ field: "file" }]);
    }

    return withTenant(tenantId, async (c) => {
      const found = await c.query(BULK_ROW_SQL, [id, tenantId]);
      if (!found.rowCount || found.rows[0].deleted_at) {
        throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      }
      const row = found.rows[0];
      // Evidence follows the call it answers: a file attached to a folded duplicate is invisible
      // on the keeper's panel, which is the one place nobody will look for it again.
      refuseFolded(row, "is filed");
      const docId = uuidv7();
      const path = `${tenantId}/support_ticket/${id}/${docId}-${sanitizeFileName(data.filename)}`;
      try {
        await putObject(path, bytes, mime);
      } catch (e) {
        if (e instanceof StorageUnavailableError) throw e;
        req.log.error(e, "storage upload failed (control ticket file)");
        throw new ApiError("INTERNAL", "The file could not be stored. Try again.", 502);
      }
      const made = await c.query(INSERT_FILE_SQL, [docId, tenantId, id,
        sanitizeFileName(data.filename), mime, bytes.length, path, req.control.user_id]);
      await record(c, req, {
        ticket: { id, ref: row.ref }, action: "file_attached",
        fromLabel: null, toLabel: made.rows[0].file_name,
        deptFrom: row.department_id, deptTo: row.department_id,
        reason: reason.data,
        detail: { document_id: docId, file_name: made.rows[0].file_name, mime_type: mime,
          size_bytes: bytes.length }
      });
      return reply.status(201).send(made.rows[0]);
    });
  });

  app.get("/control/tickets/:id/files/:docId", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketRead(req);
    const { id, docId } = req.params as { id: string; docId: string };
    const tid = ticketId(id); const did = ticketId(docId);
    if (!storageConfigured()) {
      throw new ApiError("STORAGE_UNAVAILABLE", "Pictures are not configured yet.", 503);
    }
    const row = await withTenant(req.control.tenant_id,
      (c) => c.query(FILE_SQL, [did, req.control.tenant_id]));
    if (!row.rowCount || row.rows[0].entity_id !== tid) {
      throw new ApiError("NOT_FOUND", "No such file on that incidence.", 404);
    }
    try {
      return { id: did, file_name: row.rows[0].file_name, mime_type: row.rows[0].mime_type,
        size_bytes: row.rows[0].size_bytes, url: await signObject(row.rows[0].storage_path, 900) };
    } catch (e) {
      req.log.error(e, "storage sign failed (control ticket file)");
      throw new ApiError("INTERNAL", "Could not open the file.", 502);
    }
  });

  /** Through the API rather than a bucket link, so the same duty that read the incidence is
   *  what opened the paper, and the file never needs a public URL. */
  app.get("/control/tickets/:id/files/:docId/content", { preHandler: [requireControl] },
    async (req: any, reply) => {
      await requireTicketRead(req);
      const { id, docId } = req.params as { id: string; docId: string };
      const tid = ticketId(id); const did = ticketId(docId);
      if (!storageConfigured()) {
        throw new ApiError("STORAGE_UNAVAILABLE", "Files are not configured yet.", 503);
      }
      const row = await withTenant(req.control.tenant_id,
        (c) => c.query(FILE_SQL, [did, req.control.tenant_id]));
      if (!row.rowCount || row.rows[0].entity_id !== tid) {
        throw new ApiError("NOT_FOUND", "No such file on that incidence.", 404);
      }
      try {
        const got = await getObject(row.rows[0].storage_path);
        // The stored mime is the one that passed the byte sniff at upload, and `inline` only for
        // the three image types: a PDF opened in the tab is a document, anything else is a
        // download, and nothing is ever rendered as markup.
        const inline = got.contentType?.startsWith("image/")
          || row.rows[0].mime_type.startsWith("image/");
        return reply
          .header("Content-Type", got.contentType ?? row.rows[0].mime_type)
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition",
            `${inline ? "inline" : "attachment"}; filename="${sanitizeFileName(row.rows[0].file_name)}"`)
          .send(got.bytes);
      } catch (e) {
        req.log.error(e, "storage download failed (control ticket file)");
        throw new ApiError("INTERNAL", "Could not read the file.", 502);
      }
    });

  app.post("/control/tickets/:id/files/:docId/tombstone", { preHandler: [requireControl] },
    async (req: any) => {
      await requireTicketManage(req);
      await enforceRateLimit(`ticket-files:uid:${req.control.user_id}`, 20, 3600);
      const { id, docId } = req.params as { id: string; docId: string };
      const tid = ticketId(id); const did = ticketId(docId);
      const body = z.object({ reason: REASON }).strict().parse(req.body);
      const tenantId = req.control.tenant_id;

      return withTenant(tenantId, async (c) => {
        const found = await c.query(BULK_ROW_SQL, [tid, tenantId]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
        const row = found.rows[0];
        const file = await c.query(FILE_SQL, [did, tenantId]);
        if (!file.rowCount || file.rows[0].entity_id !== tid) {
          throw new ApiError("NOT_FOUND", "No such file on that incidence.", 404);
        }
        const gone = await c.query(RETIRE_FILE_SQL, [did, tenantId, req.control.user_id]);
        if (!gone.rowCount) throw new ApiError("NOT_FOUND", "No such file on that incidence.", 404);
        // The row is retired, the bytes stay: a call that was answered on the strength of a
        // photograph keeps the photograph's record even after the desk takes it off the panel.
        await record(c, req, {
          ticket: { id: tid, ref: row.ref }, action: "file_dropped",
          fromLabel: gone.rows[0].file_name, toLabel: null,
          deptFrom: row.department_id, deptTo: row.department_id,
          reason: body.reason, detail: { document_id: did, file_name: gone.rows[0].file_name }
        });
        return { id: did, file_name: gone.rows[0].file_name, retired: true };
      });
    });

  // ---------- the clock that ran out, and the head who was told ----------
  /**
   * The breach board: live calls whose answer or finish is already past the promise the desk
   * itself made in 123. It is grouped by desk because the person who can act on a missed
   * promise is the desk, and the desk head is the one who is told.
   *
   * Calls with no desk at all are counted separately and said out loud. They are the honest
   * hole in this surface: nobody is overdue for them in the register's own terms, because
   * nobody promised anything — which is exactly how an unallocated queue reads as somebody
   * else's problem on Monday morning.
   */
  app.get("/control/tickets/breaches", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireTicketRead(req);
    await enforceRateLimit(`tickets-breach:uid:${req.control.user_id}`, 30, 60);
    const q = z.object({ department: z.string().uuid().optional() })
      .strict().parse(req.query ?? {});
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const board = await c.query(BREACH_BOARD_SQL, [tenantId]);
      const lines = await c.query(BREACH_ALERT_LIST_SQL, [tenantId, q.department ?? null]);
      const unheldRes = await c.query(BREACH_UNHELD_SQL, [tenantId]);
      const overdue = await c.query(BREACH_TOTAL_SQL, [tenantId]);
      // Both are plain aggregates with no GROUP BY, so each returns exactly one row — an empty
      // one full of zeroes when nothing is overdue, never no row at all.
      const totals = overdue.rows[0];
      const unheld = unheldRes.rows[0];
      return {
        can_manage: canManage,
        mail_configured: mailConfigured(),
        overdue: totals,
        unheld,
        board: board.rows,
        // The lines a notice would go out about right now — the twelve-hour rule is the same in
        // both places, so what the desk sees is what the button will do. The list is capped at
        // one hundred rows and says so, because a desk head told about 100 of 300 calls needs
        // to know the second half exists before they read "100" as the size of the problem.
        waiting: lines.rows,
        waiting_total: lines.rows[0]?.total ?? 0,
        note: mailConfigured()
          ? null
          : "No mail transport is configured, so a desk head could not be told. The board is "
            + "still true; the notice is the part that cannot happen."
      };
    });
  });

  /**
   * Tell the desk heads. One mail per desk, listing the calls that desk owes, through 112's
   * transport so the send leaves a line in the delivery register like every other message.
   *
   * Nothing is stamped unless the provider took the message. `breach_alerted_at` is the column
   * that says "a human was told", and stamping it on a send that failed is how a breach gets
   * quietly forgotten: the twelve-hour rule would then hold the notice back all afternoon while
   * nobody in fact received anything. A failed send returns its reason and leaves the line
   * waiting for the next clerk to press the button.
   */
  app.post("/control/tickets/breaches/notify", { preHandler: [requireControl] }, async (req: any) => {
    await requireTicketManage(req);
    await enforceRateLimit(`tickets-breach-notify:uid:${req.control.user_id}`, 6, 3600);
    const body = z.object({
      department: z.string().uuid().nullish(),
      reason: REASON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    const lines = await withTenant(tenantId,
      (c) => c.query(BREACH_ALERT_LIST_SQL, [tenantId, body.department ?? null]));
    const board = await withTenant(tenantId, (c) => c.query(BREACH_BOARD_SQL, [tenantId]));
    const desks = new Map(board.rows.map((r: any) => [r.department_id, r]));

    const byDesk = new Map<string, any[]>();
    let skippedUnheld = 0;
    for (const line of lines.rows) {
      if (!line.department_id) { skippedUnheld++; continue; }
      const list = byDesk.get(line.department_id) ?? [];
      list.push(line);
      byDesk.set(line.department_id, list);
    }

    const receipts: any[] = [];
    for (const [departmentId, owed] of byDesk) {
      const desk = desks.get(departmentId) ?? {};
      const names = owed.map((l: any) => l.dept_ref ?? l.ref);
      if (!mailConfigured()) {
        receipts.push({ department_id: departmentId, department_name: desk.department_name ?? null,
          lines: names.length, delivered: false,
          error: "RESEND_API_KEY is not set — nothing was sent and nothing was stamped." });
        continue;
      }
      if (!desk.head_user_id) {
        receipts.push({ department_id: departmentId, department_name: desk.department_name ?? null,
          lines: names.length, delivered: false,
          error: `"${desk.department_name ?? "That desk"}" has no head on the chart, so there is `
          + "nobody to tell. Name the desk head on the departments panel." });
        continue;
      }
      const head = (await withTenant(tenantId,
        (c) => c.query(DESK_HEAD_EMAIL_SQL, [desk.head_user_id, tenantId]))).rows[0];
      if (!head?.email) {
        receipts.push({ department_id: departmentId, department_name: desk.department_name ?? null,
          lines: names.length, delivered: false,
          head: desk.head_name ?? null,
          error: head ? `${head.full_name} has no address on the register, and a breach notice `
            + "cannot go to a seat that is no longer active."
            : "That desk head is not an active seat on this platform." });
        continue;
      }
      const deskArg = {
        id: departmentId,
        name: desk.department_name ?? "the desk",
        worst_overdue_since: desk.worst_overdue_since
          ? new Date(desk.worst_overdue_since).toISOString() : null
      };
      const owedLines = owed.map((l: any) => ({
        id: l.id, ref: l.ref, dept_ref: l.dept_ref ?? null, subject: l.subject,
        priority: l.priority, channel: l.channel, company_name: l.company_name ?? null,
        first_response_at: l.first_response_at ? new Date(l.first_response_at).toISOString() : null,
        resolution_due_at: l.resolution_due_at ? new Date(l.resolution_due_at).toISOString() : null
      }));
      const receipt = await sendMail(
        breachMail({ full_name: head.full_name, email: head.email, language: head.language ?? null },
          deskArg, owedLines),
        { purpose: "sla_breach", tenantId, userId: head.id });

      if (!receipt.delivered) {
        receipts.push({ department_id: departmentId, department_name: desk.department_name,
          head: head.full_name, lines: names.length, delivered: false,
          attempts: receipt.attempts, error: receipt.error ?? "the provider refused the message" });
        continue;
      }
      const stamped = await withTenant(tenantId, async (c) => {
        const ids = owed.map((l: any) => l.id);
        const done = await c.query(STAMP_BREACH_ALERT_SQL, [tenantId, req.control.user_id, ids]);
        for (const line of done.rows) {
          await record(c, req, {
            ticket: { id: line.id, ref: line.ref }, action: "alerted",
            fromLabel: null, toLabel: head.full_name,
            deptFrom: line.department_id ?? null, deptTo: line.department_id ?? null,
            reason: body.reason,
            detail: { provider_message_id: receipt.providerMessageId, desk: desk.department_name,
              recipient_masked: `${head.email.slice(0, 1)}***@${head.email.split("@")[1]}`,
              attempts: receipt.attempts }
          });
        }
        return done;
      });
      receipts.push({ department_id: departmentId, department_name: desk.department_name,
        head: head.full_name, lines: names.length, delivered: true,
        stamped: stamped.rowCount ?? 0, provider_message_id: receipt.providerMessageId,
        attempts: receipt.attempts });
    }

    const sent = receipts.filter((r) => r.delivered);
    return {
      mail_configured: mailConfigured(),
      desks: receipts.length,
      told: sent.reduce((n, r) => n + (r.stamped ?? 0), 0),
      waiting: skippedUnheld,
      receipts,
      note: !mailConfigured()
        ? "No mail transport is configured. Nothing left this server, so nothing was stamped."
        : sent.length
          ? `${sent.length} desk head(s) were told. The lines they were told about will not be `
            + "raised again for twelve hours."
          : "Nobody was told — every desk above says why, and none of the lines were stamped."
    };
  });
}
