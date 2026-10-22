import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { decryptField, encryptField, searchHash } from "../util/crypto.js";
import { requireControl } from "./control.routes.js";
import { controlHolds } from "./control-analytics.routes.js";

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
 */

const VIEW = "control.tickets.view";
const MANAGE = "control.tickets.manage";

const CHANNELS = ["phone_call", "whatsapp", "email", "walk_in", "portal_message", "other"] as const;
const CATEGORIES = ["onboarding", "account_access", "licence_billing", "cargo_clearing",
  "transport_fleet", "marketplace_directory", "system_error", "complaint", "other"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const STATUSES = ["open", "allocated", "in_progress", "resolved", "closed"] as const;
const LANGUAGES = ["en", "sw"] as const;
/** 123 added `routed` (a rule did it) and `escalated` (the desk above did it) to the table's
 *  own allowlist. They are not synonyms of `allocated`, which is a person moving a call by
 *  hand, and a register that cannot tell the three apart cannot answer "why did this land on
 *  us?" — which is the one question the desk is asked on Monday morning. */
const ACTIONS = ["logged", "allocated", "reallocated", "routed", "escalated", "status_changed",
  "priority_changed", "note_added", "resolved", "reopened", "closed", "withdrawn"] as const;

/** The moves the desk is allowed to ask for. Anything else is refused in words, because
 *  "resolved → allocated" has no meaning anybody could defend out loud. */
const TO_WORK = ["allocated", "in_progress"] as const;

const REASON = z.string().trim().min(4).max(300);
const DAYS = z.coerce.number().int().min(1).max(365).default(60);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
/** What the clock looks like from where the desk is standing. Three words, because a list of
 *  six states is a legend nobody reads and a queue nobody filters. */
const CLOCKS = ["late", "on_time", "no_clock"] as const;

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
  returning id, ref, ts, status, department_id, priority, language`;

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
 *         days, clock|null, limit, offset.
 *
 * The pattern searches `dept_ref` too, because that is the string the caller was given on the
 * phone: a register that cannot be searched by the number it read out is a register that gets
 * asked to re-find the call by its subject.
 */
export const TICKETS_SQL = `
  select t.id, t.ref, t.ts, t.updated_at, t.reporter_name, t.reporter_email,
         t.channel, t.category, t.subject, t.priority, t.status, t.language,
         t.company_tenant_id, t.company_name, t.department_id, d.name as department_name,
         t.dept_ref, t.dept_number, upper(n.key) as numbered_by_key, n.name as numbered_by_name,
         t.response_due_at, t.resolution_due_at, t.first_response_at,
         t.after_hours, t.escalated_at, ef.name as escalated_from_name,
         ${CLOCK_STATES}
         (t.reporter_phone_encrypted is not null) as has_phone,
         t.allocated_at, t.resolved_at,
         a.full_name as allocated_by_name,
         (select count(*)::int from support_ticket_events e where e.ticket_id = t.id) as events,
         (select e.ts from support_ticket_events e where e.ticket_id = t.id
           order by e.ts desc, e.id desc limit 1) as last_activity
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
    left join platform_departments n on n.id = t.numbered_by
    left join platform_departments ef on ef.id = t.escalated_from_id
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
   order by (t.priority = 'urgent') desc,
            (t.status in ('open','allocated','in_progress')) desc,
            t.ts desc
   limit $12 offset $13`;

/** The same filter without the cap, so the header and the rows cannot disagree.
 *  Params: as the queue, without limit and offset. */
export const TICKETS_COUNT_SQL = `
  select count(*)::int as n,
         count(*) filter (where t.status = 'open')::int as unallocated,
         count(*) filter (where t.status in ('allocated','in_progress'))::int as working,
         count(*) filter (where t.status in ('resolved','closed'))::int as settled,
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
                          and t.dept_ref is null)::int as unnumbered
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
              and t.response_due_at is null and t.resolution_due_at is null))`;

/** One incidence, this tenant's only, with the encrypted column for the detail read.
 *  The desk's own terms come along on the same row — the hours it keeps, what it promised and
 *  who is above it — because a panel that shows a deadline without the week it was counted
 *  against is the panel that gets argued with.
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
         d.first_response_minutes, d.resolve_minutes, d.business_hours,
         d.max_open_tickets, d.escalation_department_id,
         platform_auth.inside_hours(now(), d.business_hours) as desk_is_open_now,
         upper(ea.key) as escalation_key, ea.name as escalation_name,
         ${CLOCK_STATES}
         t.allocated_at, t.resolved_at, t.resolution,
         a.full_name as allocated_by_name,
         r.full_name as resolved_by_name,
         c.full_name as created_by_name
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
    left join platform_departments n on n.id = t.numbered_by
    left join platform_departments ef on ef.id = t.escalated_from_id
    left join platform_departments ea on ea.id = d.escalation_department_id
    left join users a on a.id = t.allocated_by and a.tenant_id = t.tenant_id
    left join users r on r.id = t.resolved_by and r.tenant_id = t.tenant_id
    left join users c on c.id = t.created_by and c.tenant_id = t.tenant_id
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
             resolution_due_at, updated_at`;

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
        q.clock ?? null
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
          phone_searched: !!q.phone, company: q.company ?? null, clock: q.clock ?? null
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
          && ticket.status !== "resolved" && ticket.status !== "closed"
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
      // 101's CHECK will not be broken by this — resolved_at stays set and the state stays
      // legal — but a settled incidence pointed at a new desk reads as work restarted while
      // the row still claims it was finished. Reopen it in words, then hand it over.
      if (before.status === "resolved" || before.status === "closed") {
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
      if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `${before.ref} is nobody's yet. Allocate it to a department before saying work has `
          + "started — that is what the number means to the caller.", 409);
      }
      const settled = before.status === "resolved" || before.status === "closed";
      if (settled && !body.reopen) {
        throw new ApiError("CONFLICT",
          `${before.ref} is already ${before.status}. Tick "the caller rang back" to take it `
          + "back into work — a second attempt at a finished job is a reopened one, not a "
          + "quiet edit.", 409, [{ field: "reopen" }]);
      }
      if (!settled && before.status === body.status) {
        throw new ApiError("CONFLICT", `That incidence is already ${body.status}.`, 409);
      }
      const moved = await c.query(WORK_SQL, [id, tenantId, body.status, settled]);
      if (!moved.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);

      await record(c, req, {
        ticket: { id, ref: before.ref },
        action: settled ? "reopened" : "status_changed",
        fromLabel: before.status, toLabel: moved.rows[0].status,
        deptFrom: before.department_id, deptTo: before.department_id,
        reason: body.reason,
        detail: settled ? {
          reopened_from: before.status, previous_resolution: before.resolution,
          // The deadlines do not move on a reopen and that is deliberate: a desk cannot make
          // its own breach disappear by declaring a second attempt. What resets is the answer
          // clock, and the first attempt stays in this register's own history.
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
      if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `Nobody holds ${before.ref}, so there is no desk above it. Allocate it first — an `
          + "escalation is a desk saying it cannot answer, not a way into the queue.", 409);
      }
      if (before.status === "resolved" || before.status === "closed") {
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
      if (was.rows[0].status !== "closed") {
        // The row stays reachable until somebody has written the sentence that ends it, so a
        // removal cannot be the way out of an unfinished job.
        throw new ApiError("CONFLICT",
          `Close ${was.rows[0].ref} first — hiding an incidence that is still open is how a `
          + "call goes away without an answer.", 409);
      }
      const gone = await c.query(TOMBSTONE_SQL, [id, tenantId, req.control.user_id]);
      if (!gone.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);
      await record(c, req, {
        ticket: { id, ref: was.rows[0].ref }, action: "withdrawn",
        fromLabel: "visible in the register", toLabel: "withdrawn from the register",
        deptFrom: was.rows[0].department_id, deptTo: was.rows[0].department_id,
        reason: body.reason, detail: { withdrawn: true }
      });
      return { id, ref: gone.rows[0].ref, withdrawn: true };
    });
  });
}
