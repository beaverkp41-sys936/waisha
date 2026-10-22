import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { requireControl } from "./control.routes.js";
import { controlHolds } from "./control-analytics.routes.js";
import {
  COMPANY_HQ_REGION_SQL, COMPANY_SQL, INSERT_EVENT_SQL
} from "./control-tickets.routes.js";

/**
 * The platform's own org chart (084; task #130c) — the departments the office is organised
 * into, which seat sits in which, and the register of every move with the reason a person
 * would defend out loud.
 *
 * No SECURITY DEFINER here, deliberately, for the standing 067 reason: every row on this
 * desk belongs to the one platform tenant, so withTenant(platform) sees precisely its own
 * community through the ordinary tenant policy and a definer would only have opened a wider
 * door. What makes this different from the roster is the register — append-only twice over
 * (no UPDATE or DELETE is granted to app_runtime, and 043's trigger raises anyway), so a
 * seat can add to the record of who moved where but cannot rewrite it.
 *
 * Two duties, not one: reading the chart is control.departments.view (the seat that needs
 * to know who answers for billing), reshaping it is control.departments.manage. Every write
 * takes a `reason`, because "who took over from Omar" is the question this desk exists to
 * answer and an org chart that cannot say why is a rumour.
 *
 * A cover is a membership with an end date, and it expires by being read —
 * `released_at is null and (ends_at is null or ends_at > now())` — so there is no sweeper
 * to run on boot and no state to settle while the API was down. The date a desk picks is a
 * day, not an instant, so Postgres ends it at the close of that day in Dar es Salaam, which
 * is the same moment whether Render runs UTC or this laptop does not.
 *
 * Every statement is exported and named so verify-departments-sql.ts executes these exact
 * strings as app_runtime instead of re-typing them.
 *
 * 123 turned the chart into something with a memory of its own promises: each desk now keeps
 * its working week (Dar es Salaam wall clock), the two SLA figures it owes on a call, the desk
 * above it, the load it will accept before it says so, and a counter that hands out its own
 * queue number. This file is the desk for those columns — `PUT /:id/terms` — plus the routing
 * rules that decide who takes a call nobody pointed anywhere, and the detail read that answers
 * "is this desk drowning?" in one page.
 *
 * Two of the five new facts are guarded in SQL, not here, and the handler says so out loud
 * rather than pretending it did the arithmetic: an escalation chain that comes back to itself
 * and a desk filed away while calls are still on it are both refused by 123's triggers. Their
 * sentences are already written for a person, so they are passed through as a 409 instead of
 * being reported as a broken database — Postgres codes a CHECK violation with a status that
 * the platform's error handler cannot tell from a real fault.
 */

const VIEW = "control.departments.view";
const MANAGE = "control.departments.manage";

/** The live predicate, written once because seven statements have to agree on it. */
const LIVE = `m.released_at is null and (m.ends_at is null or m.ends_at > now())`;

const DAYS = z.coerce.number().int().min(1).max(365).default(30);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
const REASON = z.string().trim().min(4).max(300);

/** The words the register uses for a call, repeated here so a rule can be refused before it
 *  is written rather than sitting on the desk never matching anything. 123's own CHECKs are
 *  the backstop — a rule with 'phonecall' in it would be stored happily and route nothing. */
const RULE_CHANNELS = ["phone_call", "whatsapp", "email", "walk_in", "portal_message", "other"] as const;
const RULE_CATEGORIES = ["onboarding", "account_access", "licence_billing", "cargo_clearing",
  "transport_fleet", "marketplace_directory", "system_error", "complaint", "other"] as const;
const RULE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const RULE_LANGUAGES = ["en", "sw"] as const;
const RULE_LISTS = ["channels", "categories", "priorities", "languages", "regionIds"] as const;

/** One shape for both writes, with the ceilings set to the size of 123's own allowlists: a
 *  rule that cannot match any call is refused before it is stored rather than left on the desk
 *  silently routing nothing. The five lists are the predicates; the CHECK on the table is the
 *  backstop that at least one of them narrows, and the handlers say which one in words. */
const RULE_FIELDS = {
  name: z.string().trim().min(3).max(70),
  departmentId: z.string().uuid(),
  channels: z.array(z.enum(RULE_CHANNELS)).max(RULE_CHANNELS.length).nullish(),
  categories: z.array(z.enum(RULE_CATEGORIES)).max(RULE_CATEGORIES.length).nullish(),
  priorities: z.array(z.enum(RULE_PRIORITIES)).max(RULE_PRIORITIES.length).nullish(),
  languages: z.array(z.enum(RULE_LANGUAGES)).max(RULE_LANGUAGES.length).nullish(),
  regionIds: z.array(z.number().int().min(1).max(100000)).max(40).nullish(),
  precedence: z.number().int().min(1).max(999),
  isActive: z.boolean(),
  note: z.string().trim().max(240).nullish(),
  reason: REASON
};
const RULE_CREATE = z.object({
  ...RULE_FIELDS,
  precedence: RULE_FIELDS.precedence.optional().default(100),
  isActive: RULE_FIELDS.isActive.optional().default(true)
}).strict();
/** Presence decides, as it does for a desk's terms — with one difference worth naming: a list
 *  sent empty (or as null) is a real answer, "stop narrowing on channel", and is written. The
 *  handler then checks that the rule still narrows on *something*. */
const RULE_PATCH = z.object({
  name: RULE_FIELDS.name.optional(),
  departmentId: RULE_FIELDS.departmentId.optional(),
  channels: RULE_FIELDS.channels,
  categories: RULE_FIELDS.categories,
  priorities: RULE_FIELDS.priorities,
  languages: RULE_FIELDS.languages,
  regionIds: RULE_FIELDS.regionIds,
  precedence: RULE_FIELDS.precedence.optional(),
  isActive: RULE_FIELDS.isActive.optional(),
  note: RULE_FIELDS.note,
  reason: RULE_FIELDS.reason
}).strict();

/** One day of the desk's week: an open minute and a close minute in Dar es Salaam wall clock,
 *  or nothing at all when the desk is shut that day. HH:MM sorts as text, so the ordering
 *  check needs no parsing — and the same zero padding the DB regex demands makes it exact. */
const WEEKDAY = z.object({
  open: z.string().trim().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/,
    "Use a 24-hour time like 08:00."),
  close: z.string().trim().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/,
    "Use a 24-hour time like 17:30.")
}).strict().refine((d) => d.open < d.close,
  "A desk cannot close at or before the minute it opens.");

const WEEK = z.object({
  mon: WEEKDAY.nullish(), tue: WEEKDAY.nullish(), wed: WEEKDAY.nullish(),
  thu: WEEKDAY.nullish(), fri: WEEKDAY.nullish(), sat: WEEKDAY.nullish(), sun: WEEKDAY.nullish()
}).strict();
const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** The week as the column keeps it: a closed day is written as null rather than left out, so
 *  a desk that shuts Sunday says so on the page instead of the reader guessing. */
function weekJson(raw: z.infer<typeof WEEK>): string {
  const out: Record<string, unknown> = {};
  for (const d of WEEK_DAYS) out[d] = raw[d] ?? null;
  return JSON.stringify(out);
}

function weekIsOpen(raw: Record<string, unknown> | null): boolean {
  return !!raw && WEEK_DAYS.some((d) => {
    const v = raw[d];
    return v !== null && v !== undefined && typeof v === "object";
  });
}

/** The five figures a desk sets about itself, in the order the statement reads them. Presence
 *  decides: a key the desk did not send keeps what it said, a key it sent as null clears it. */
const TERM_KEYS = ["firstResponseMinutes", "resolveMinutes", "businessHours",
  "escalationDepartmentId", "maxOpenTickets"] as const;

/** 123's guards refuse with codes that mean "this row is not allowed to exist" (23514) and
 *  "this value is not the shape we asked for" (22023). Neither one is a server fault, and both
 *  already carry a sentence written for the desk, so the handlers turn them into the 409 the
 *  operator can act on instead of a red banner about the database. */
function sqlRefusal(err: unknown, fallback: string): ApiError | null {
  const code = (err as any)?.code;
  if (code !== "23514" && code !== "22023" && code !== "P0001") return null;
  const line = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^platform_departments:\s*/i, "");
  return new ApiError("CONFLICT", line || fallback, 409);
}

/** 23:59 in Dar es Salaam, which is UTC+3 all year: the same instant the database computes
 *  from the day the desk picks, so the two never disagree about whether a cover has run. */
function coverEndsAt(day: string): number {
  return Date.parse(`${day}T20:59:00Z`);
}

/** A cover that already ran out, or one stretched past two years, is refused in words here —
 *  084's `ends_at > starts_at + interval '1 hour'` would otherwise answer a picked date that
 *  lapsed this evening with a raw check violation, at an hour of the day nobody tests. */
const ENDS_ON = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$|^$/,
    "Use a date like 2026-11-30 — a cover ends at the close of that day — or leave it empty.")
  .nullish()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || (coverEndsAt(v) > Date.now() + 3_600_000
    && coverEndsAt(v) < Date.now() + 730 * 86_400_000),
    "Name a day still ahead — a cover that has run out is not a cover, and past two years "
    + "it is a posting, so leave the date empty.");
const UUIDS = z.array(z.string().uuid()).min(1).max(20);

const ACTIONS = ["department_created", "department_updated", "department_closed",
  "department_reopened", "seat_joined", "seat_moved", "seat_released",
  "head_appointed", "head_released"] as const;

// ---------- statements ----------

/**
 * The whole chart in one read. Params: tenant.
 *
 * The seat list is a nested subquery rather than a join because the ordering that matters
 * is per department (head first, then alphabetically) and a flat join would have to be
 * re-grouped in JavaScript — and a head ordered by name is how a desk loses its answer.
 *
 * The work lateral carries the same three figures the register's own desk shows, because a
 * chart that names a team but not the queue standing on it is a photo, not an org chart.
 * `t.tenant_id = $1` is not decoration: this connection bypasses row-level security, so the
 * desk's own tenant is the only thing that keeps another community's calls off the count.
 */
export const DEPARTMENTS_SQL = `
  select d.id, d.key, d.name, d.purpose, d.sort, d.is_active,
         d.head_user_id, h.full_name as head_name,
         d.first_response_minutes, d.resolve_minutes, d.business_hours,
         d.max_open_tickets, d.ticket_seq::int as ticket_seq,
         d.escalation_department_id, upper(e.key) as escalation_key,
         e.name as escalation_name,
         coalesce(w.live_tickets, 0)::int as live_tickets,
         coalesce(w.breached_tickets, 0)::int as breached_tickets,
         w.oldest_open,
         coalesce(s.seat_count, 0)::int as seat_count,
         coalesce(s.live_covers, 0)::int as live_covers,
         coalesce(s.seats, '[]'::jsonb) as seats
    from platform_departments d
    left join users h on h.id = d.head_user_id
    left join platform_departments e on e.id = d.escalation_department_id
    left join lateral (
      select count(*) filter (where t.status in ('open','allocated','in_progress'))::int
               as live_tickets,
             count(*) filter (where t.status in ('open','allocated','in_progress')
                                  and ((t.first_response_at is null and t.response_due_at is not null
                                        and t.response_due_at < now())
                                    or (t.resolution_due_at is not null
                                        and t.resolution_due_at < now())))::int
               as breached_tickets,
             min(t.ts) filter (where t.status in ('open','allocated','in_progress'))
               as oldest_open
        from support_tickets t
       where t.department_id = d.id and t.tenant_id = $1 and t.deleted_at is null
    ) w on true
    left join lateral (
      select count(*)::int as seat_count,
             count(*) filter (where x.ends_at is not null)::int as live_covers,
             jsonb_agg(json_build_object(
               'membership_id', x.id, 'user_id', x.user_id, 'full_name', x.full_name,
               'job_title', x.job_title, 'status', x.status, 'standing', x.standing,
               'starts_at', x.starts_at, 'ends_at', x.ends_at, 'note', x.note,
               'last_login_at', x.last_login_at, 'duties', x.duties)
               order by (x.standing = 'head') desc, upper(x.full_name)) as seats
        from (
          select m.id, m.user_id, m.starts_at, m.ends_at, m.standing, m.note,
                 u.full_name, u.job_title, u.status, u.last_login_at,
                 coalesce(dz.duties, '{}'::text[]) as duties
            from platform_seat_departments m
            join users u on u.id = m.user_id
            left join lateral (
              select array_agg(r.key order by r.key) as duties
                from user_roles ur
                join roles r on r.id = ur.role_id
               where ur.user_id = m.user_id and r.tenant_id is null and r.deleted_at is null
                 and (ur.expires_at is null or ur.expires_at > now())
            ) dz on true
           where m.department_id = d.id and ${LIVE}
             and u.deleted_at is null and u.user_type = 'platform'
        ) x
    ) s on true
   where d.tenant_id = $1 and d.deleted_at is null
   order by d.sort, upper(d.name)`;

/** Platform seats the chart has not placed. Params: tenant. */
export const UNASSIGNED_SQL = `
  select u.id as user_id, u.full_name, u.job_title, u.status, u.last_login_at,
         coalesce(dz.duties, '{}'::text[]) as duties
    from users u
    left join lateral (
      select array_agg(r.key order by r.key) as duties
        from user_roles ur
        join roles r on r.id = ur.role_id
       where ur.user_id = u.id and r.tenant_id is null and r.deleted_at is null
         and (ur.expires_at is null or ur.expires_at > now())
    ) dz on true
   where u.tenant_id = $1 and u.deleted_at is null and u.user_type = 'platform'
     and not exists (
       select 1 from platform_seat_departments m
        where m.user_id = u.id and ${LIVE})
   order by upper(coalesce(u.full_name, 'un'))`;

/** The desks somebody shut, and who did it. Params: tenant. */
export const CLOSED_DEPARTMENTS_SQL = `
  select d.id, d.key, d.name, d.deleted_at as closed_at,
         b.full_name as closed_by,
         (select count(*)::int from platform_duty_transitions t
           where t.to_department_id = d.id or t.from_department_id = d.id) as register_rows
    from platform_departments d
    left join users b on b.id = d.deleted_by
   where d.tenant_id = $1 and d.deleted_at is not null
   order by d.deleted_at desc limit 50`;

/** One line for the header. Params: tenant, days. */
export const DEPT_SUMMARY_SQL = `
  select (select count(*)::int from platform_departments
           where tenant_id = $1 and deleted_at is null) as departments,
         (select count(distinct m.user_id)::int from platform_seat_departments m
           join users u on u.id = m.user_id and u.deleted_at is null
                                    and u.user_type = 'platform'
          where m.tenant_id = $1 and ${LIVE}) as placed_seats,
         (select count(*)::int from platform_seat_departments m
          where m.tenant_id = $1 and ${LIVE} and m.ends_at is not null) as live_covers,
         (select count(*)::int from platform_seat_departments m
          where m.tenant_id = $1 and ${LIVE} and m.ends_at is not null
            and m.ends_at <= now() + interval '7 days') as covers_ending_7d,
         (select count(*)::int from users u
          where u.tenant_id = $1 and u.deleted_at is null
            and u.user_type = 'platform') as seats,
         (select count(*)::int from platform_duty_transitions t
          where t.tenant_id = $1
            and t.ts >= now() - make_interval(days => $2::int)) as register_rows`;

/** An open department, with the promises it keeps. Params: department, tenant. */
export const DEPARTMENT_SQL = `
  select d.id, d.key, d.name, d.purpose, d.sort, d.is_active, d.head_user_id,
         h.full_name as head_name,
         d.first_response_minutes, d.resolve_minutes, d.business_hours,
         d.max_open_tickets, d.ticket_seq::int as ticket_seq,
         d.escalation_department_id, upper(e.key) as escalation_key,
         e.name as escalation_name,
         (select count(*)::int from support_tickets t
           where t.department_id = d.id and t.tenant_id = $2 and t.deleted_at is null
             and t.status in ('open','allocated','in_progress')) as live_tickets,
         (select count(*)::int from platform_seat_departments m
           where m.department_id = d.id and ${LIVE}) as live_seats
    from platform_departments d
    left join users h on h.id = d.head_user_id
    left join platform_departments e on e.id = d.escalation_department_id
   where d.id = $1 and d.tenant_id = $2 and d.deleted_at is null`;

/**
 * What a desk owes, when it is open to hear about it, who is above it, and how much it will
 * take before it says it is full. Params: department, tenant, actor, then five pairs of
 * "did the desk send this?" and the value it sent (a sent null clears the column).
 *
 * Presence is a flag rather than a coalesce because every one of these five can honestly be
 * set to nothing: a desk that cancels its ceiling or its escalation target has to be able to
 * say so, and `coalesce($n, col)` reads a clearing as an unchanged column. Two of the writes
 * fire 123's guards — an unparseable week and a chain that comes back to itself — and the
 * handler passes their sentences through rather than re-deriving them.
 */
export const SET_DEPARTMENT_TERMS_SQL = `
  update platform_departments
     set first_response_minutes = case when $4::bool then $5::int
                                      else first_response_minutes end,
         resolve_minutes = case when $6::bool then $7::int else resolve_minutes end,
         business_hours = case when $8::bool then $9::jsonb else business_hours end,
         escalation_department_id = case when $10::bool then $11::uuid
                                         else escalation_department_id end,
         max_open_tickets = case when $12::bool then $13::int else max_open_tickets end,
         updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
  returning id, key, name, first_response_minutes, resolve_minutes, business_hours,
            escalation_department_id, max_open_tickets, ticket_seq::int as ticket_seq,
            updated_at`;

/** The chain above one desk, nearest first. Params: department, tenant.
 *  The 24-step budget is the same one 123's walk uses: the trigger keeps a stored chain
 *  acyclic, and a depth cap is what stops a hand-edited row from hanging the read that is
 *  about to complain about it. */
export const ESCALATION_UP_SQL = `
  with recursive above as (
    select d.id, d.escalation_department_id, upper(d.key) as key, d.name, 1 as depth
      from platform_departments d
     where d.id = $1 and d.tenant_id = $2 and d.deleted_at is null
    union all
    select n.id, n.escalation_department_id, upper(n.key), n.name, a.depth + 1
      from above a
      join platform_departments n on n.id = a.escalation_department_id
     where n.tenant_id = $2 and n.deleted_at is null and a.depth < 24
  )
  select id, key, name, depth from above where depth > 1 order by depth`;

/** The desks that send their work *here* when they cannot answer. Params: department, tenant. */
export const ESCALATION_DOWN_SQL = `
  select d.id, upper(d.key) as key, d.name, d.head_user_id,
         (select count(*)::int from support_tickets t
           where t.department_id = d.id and t.tenant_id = $2 and t.deleted_at is null
             and t.status in ('open','allocated','in_progress')) as live_tickets
    from platform_departments d
   where d.escalation_department_id = $1 and d.tenant_id = $2 and d.deleted_at is null
   order by d.sort, upper(d.name)`;

/** The calls still standing on a desk, newest promise first. Params: department, tenant.
 *  This is the list the archive guard refuses for: the desk has to be told which calls, not
 *  just that there are some. */
export const DEPT_OPEN_TICKETS_SQL = `
  select t.id, t.ref, t.dept_ref, t.subject, t.status, t.priority, t.channel,
         t.company_name, t.ts, t.response_due_at, t.resolution_due_at,
         (t.first_response_at is not null) as answered,
         a.full_name as holder
    from support_tickets t
    left join users a on a.id = t.allocated_by and a.tenant_id = t.tenant_id
   where t.department_id = $1 and t.tenant_id = $2 and t.deleted_at is null
     and t.status in ('open','allocated','in_progress')
   order by (t.priority in ('urgent','high')) desc,
            coalesce(t.response_due_at, t.resolution_due_at, t.ts), t.ts
   limit 40`;

/** Carry a desk's live work to another one — the way out the archive guard itself names.
 *  The queue number does not move with it: the caller was told BILLING-4 by the desk that
 *  minted it, and 123 keeps the issuing desk in `numbered_by` for exactly that reason.
 *  Params: from department, tenant, to department, actor. */
export const MOVE_DEPT_TICKETS_SQL = `
  update support_tickets
     set department_id = $3, updated_at = now()
   where department_id = $1 and tenant_id = $2 and deleted_at is null
     and status in ('open','allocated','in_progress')
  returning id, ref, dept_ref, subject, priority, status, department_id`;

/** Closed or not — a reopen has to read the row it is opening. Params: department, tenant. */
export const DEPARTMENT_ANY_SQL = `
  select d.id, d.key, d.name, d.is_active, d.deleted_at, d.head_user_id
    from platform_departments d
   where d.id = $1 and d.tenant_id = $2`;

/** The seats that would lose their desk if this one closed. Params: department. */
export const DEPT_LIVE_SEATS_SQL = `
  select m.id as membership_id, m.user_id, m.standing, u.full_name
    from platform_seat_departments m
    join users u on u.id = m.user_id
   where m.department_id = $1 and ${LIVE}
   order by (m.standing = 'head') desc, upper(u.full_name)`;

/** Which of these ids are platform seats of this tenant, and what they are called.
 *  Params: ids, tenant. */
export const PLATFORM_SEATS_SQL = `
  select u.id as user_id, u.full_name, u.status
    from users u
   where u.id = any($1::uuid[]) and u.tenant_id = $2
     and u.deleted_at is null and u.user_type = 'platform'`;

/** One person by id, for the name the register copies. Params: user. */
export const SEAT_NAME_SQL = `select id, full_name from users where id = $1`;

/** Every live membership of one seat, with the team it names. Params: user. */
export const SEAT_MEMBERSHIPS_SQL = `
  select m.id as membership_id, m.department_id, d.name, m.standing,
         (m.ends_at is not null) as is_cover
    from platform_seat_departments m
    join platform_departments d on d.id = m.department_id
   where m.user_id = $1 and ${LIVE}
   order by upper(d.name)`;

/**
 * Place seats in a department, skipping any that already sit there.
 * Params: tenant, department, actor, ids, endsOn(date|null), note, standing.
 *
 * The exists-guard is part of the statement, not just the handler's pre-check: a company
 * seat or a foreign platform seat must be unplaceable here even if a future caller forgets
 * to ask, because a chart that lists a person the desk cannot see is a lie about who is
 * answerable.
 */
export const INSERT_MEMBERSHIPS_SQL = `
  insert into platform_seat_departments
    (tenant_id, user_id, department_id, standing, ends_at, note, assigned_by)
  select $1, s.user_id, $2, $7,
         case when $5::date is null then null
              else ($5::date + time '23:59') at time zone 'Africa/Dar_es_Salaam' end,
         $6, $3
    from unnest($4::uuid[]) as s(user_id)
    join users u on u.id = s.user_id and u.tenant_id = $1
                and u.user_type = 'platform' and u.deleted_at is null
   where not exists (
     select 1 from platform_seat_departments m
      where m.user_id = s.user_id and m.department_id = $2 and ${LIVE})
  returning id, user_id`;

/** Params: user, actor. Everything the seat holds, a headship included. */
export const RELEASE_SEAT_MEMBERSHIPS_SQL = `
  update platform_seat_departments
     set released_at = now(), released_by = $2
   where user_id = $1 and released_at is null
  returning id, department_id, standing`;

/** Params: department, actor. */
export const RELEASE_DEPT_MEMBERSHIPS_SQL = `
  update platform_seat_departments
     set released_at = now(), released_by = $2
   where department_id = $1 and released_at is null
  returning id, user_id, standing`;

/** Params: department, actor. A cover that ran out is invisible to every read but still
 *  holds its seat in the unique index, so a desk that is about to place somebody settles
 *  the old paper first instead of colliding with it. Nothing sweeps on boot: this runs the
 *  moment a write cares. */
export const SETTLE_EXPIRED_COVERS_SQL = `
  update platform_seat_departments
     set released_at = now(), released_by = $2
   where department_id = $1 and released_at is null
     and ends_at is not null and ends_at <= now()
  returning id, user_id`;

/** Params: department, actor. A head that is replaced stays on the desk — they step down,
 *  they are not thrown off it. The actor is written into assigned_by so the row the chart
 *  reads says who took the answerability away, exactly as a promotion says who gave it. */
export const DEMOTE_HEAD_MEMBERSHIP_SQL = `
  update platform_seat_departments
     set standing = 'member', assigned_by = $2
   where department_id = $1 and standing = 'head' and released_at is null
  returning id, user_id`;

/** Params: user, department, actor, endsOn(date|null). A seat already at the desk is
 *  promoted in place, and a cover date named with the appointment is adopted — an acting
 *  head is a head with an end date, so the date has to land on the membership or the chart
 *  says "answerable" forever. Without a date the membership keeps whatever it said. */
export const PROMOTE_MEMBERSHIP_SQL = `
  update platform_seat_departments
     set standing = 'head',
         assigned_by = $3,
         ends_at = case when $4::date is null then ends_at
                       else ($4::date + time '23:59') at time zone 'Africa/Dar_es_Salaam' end
   where user_id = $1 and department_id = $2 and released_at is null`;

/** Params: tenant, key, name, purpose, sort, actor. */
export const INSERT_DEPARTMENT_SQL = `
  insert into platform_departments (tenant_id, key, name, purpose, sort, created_by, updated_by)
  values ($1,$2,$3,$4,$5,$6,$6)
  returning id, key, name, purpose, sort, is_active`;

/** Params: department, tenant, name|null, purpose|null, sort|null, actor. */
export const UPDATE_DEPARTMENT_SQL = `
  update platform_departments
     set name = coalesce($3, name),
         purpose = coalesce($4, purpose),
         sort = coalesce($5, sort),
         updated_by = $6
   where id = $1 and tenant_id = $2 and deleted_at is null
  returning id, key, name, purpose, sort, is_active`;

/** Params: department, tenant, actor. The head steps down with the desk. */
export const CLOSE_DEPARTMENT_SQL = `
  update platform_departments
     set deleted_at = now(), deleted_by = $3, head_user_id = null,
         is_active = false, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null`;

/** Params: department, tenant, actor. */
export const REOPEN_DEPARTMENT_SQL = `
  update platform_departments
     set deleted_at = null, deleted_by = null, is_active = true, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is not null`;

/** Params: department, user|null, actor. */
export const SET_HEAD_SQL = `
  update platform_departments set head_user_id = $2, updated_by = $3 where id = $1`;

/** Params: tenant, key, department|null (a reopen must see whether the key was taken). */
export const KEY_TAKEN_SQL = `
  select id, name from platform_departments
   where tenant_id = $1 and key = $2 and deleted_at is null
     and ($3::uuid is null or id <> $3::uuid)`;

/** The register, newest first. Params: tenant, action, user, pattern, days, limit. */
export const REGISTER_SQL = `
  select t.id, t.ts, t.action, t.user_id, t.seat_name, t.from_label, t.to_label,
         t.from_department_id, t.to_department_id, t.reason, t.detail,
         t.actor_role, t.ip, t.request_id, a.full_name as actor_name
    from platform_duty_transitions t
    left join users a on a.id = t.actor_user_id
   where t.tenant_id = $1
     and ($2::text is null or t.action = $2)
     and ($3::uuid is null or t.user_id = $3)
     and ($4::text is null or coalesce(t.seat_name,'') ilike $4
                        or coalesce(t.from_label,'') ilike $4
                        or coalesce(t.to_label,'') ilike $4
                        or t.reason ilike $4)
     and t.ts >= now() - make_interval(days => $5::int)
   order by t.ts desc, t.id desc limit $6`;

/** The same filter without the cap, so the header and the rows cannot disagree. */
export const REGISTER_COUNT_SQL = `
  select count(*)::int as n,
         (count(*) filter (where t.ts >= now() - interval '7 days'))::int as last_7
    from platform_duty_transitions t
   where t.tenant_id = $1
     and ($2::text is null or t.action = $2)
     and ($3::uuid is null or t.user_id = $3)
     and ($4::text is null or coalesce(t.seat_name,'') ilike $4
                        or coalesce(t.from_label,'') ilike $4
                        or coalesce(t.to_label,'') ilike $4
                        or t.reason ilike $4)
     and t.ts >= now() - make_interval(days => $5::int)`;

/** One row per recorded act. Params: tenant, user, actor, role, ip, requestId, action,
 *  seatName, fromLabel, toLabel, fromDept, toDept, reason, detail. */
export const INSERT_TRANSITION_SQL = `
  insert into platform_duty_transitions
    (tenant_id, user_id, actor_user_id, actor_role, ip, request_id, action,
     seat_name, from_label, to_label, from_department_id, to_department_id, reason, detail)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
  returning id, ts`;

/**
 * The desk's own numbers, for the page that answers "is this team drowning?".
 * Params: department, days, tenant.
 *
 * Two windows on purpose: `live` is everything standing on the desk *now*, because the
 * ceiling and the breach are about the work as it sits, while the medians and the rates are
 * read over settled calls inside the window the desk picked. A "median response" computed
 * across all history would flatter a desk that stopped answering in March.
 *
 * `met_response` counts only settled calls that had a clock: a desk with no SLA set has not
 * broken a promise, and reporting 0 of 0 as 0% would say the opposite of the truth.
 */
export const DEPT_KPI_SQL = `
  with on_desk as (
    select t.* from support_tickets t
     where t.department_id = $1 and t.tenant_id = $3 and t.deleted_at is null
  ), live as (
    select * from on_desk where status in ('open','allocated','in_progress')
  ), settled as (
    select * from on_desk
     where status in ('resolved','closed') and resolved_at is not null
       and resolved_at >= now() - make_interval(days => $2::int)
  )
  select (select count(*)::int from live) as live,
         (select count(*)::int from live where status = 'open') as unworked,
         (select count(*)::int from live where status = 'allocated') as waiting,
         (select count(*)::int from live where status = 'in_progress') as in_progress,
         (select count(*)::int from live
           where first_response_at is null and response_due_at is not null
             and response_due_at < now()) as response_breached,
         (select count(*)::int from live
           where first_response_at is null and response_due_at is not null
             and response_due_at >= now()
             and response_due_at < now() + interval '60 minutes') as response_at_risk,
         (select count(*)::int from live
           where resolved_at is null and resolution_due_at is not null
             and resolution_due_at < now()) as resolution_breached,
         (select count(*)::int from live
           where resolution_due_at is not null and resolution_due_at >= now()
             and resolution_due_at < now() + interval '24 hours') as resolution_due_24h,
         (select count(*)::int from live where response_due_at is null) as no_clock,
         (select count(*)::int from live where after_hours) as after_hours,
         (select count(*)::int from live where escalated_at is not null) as escalated_in,
         (select min(ts) from live) as oldest,
         (select count(*)::int from settled) as settled,
         (select coalesce(percentile_cont(0.5) within group (
             order by extract(epoch from (first_response_at - ts)) / 60.0), 0)::int
            from settled where first_response_at is not null) as median_response_minutes,
         (select coalesce(percentile_cont(0.5) within group (
             order by extract(epoch from (resolved_at - ts)) / 60.0), 0)::int
            from settled) as median_resolution_minutes,
         (select count(*)::int from settled
           where first_response_at is not null and response_due_at is not null
             and first_response_at <= response_due_at) as met_response,
         (select count(*)::int from settled
           where resolved_at is not null and resolution_due_at is not null
             and resolved_at <= resolution_due_at) as met_resolution,
         (select count(*)::int from settled where first_response_at is not null) as answered,
         (select count(*)::int from on_desk where numbered_by = $1) as numbers_issued,
         (select count(*)::int from on_desk
           where status in ('open','allocated','in_progress')
             and escalated_from_id = $1) as escalated_out`;

/** The work standing on one desk, with the clock states the page colours by.
 *  Params: department, tenant, limit. No callback number in this column list — the register
 *  detail read owns that, behind the view duty. */
export const DEPT_TICKETS_SQL = `
  select t.id, t.ref, t.dept_ref, t.dept_number, t.ts, t.updated_at, t.reporter_name,
         t.channel, t.category, t.subject, t.priority, t.status, t.language,
         t.company_name, t.response_due_at, t.resolution_due_at, t.first_response_at,
         t.resolved_at, t.after_hours, t.escalated_at, t.allocated_at,
         a.full_name as holder, e.name as escalated_from,
         (t.reporter_phone_encrypted is not null) as has_phone,
         case when t.response_due_at is null then null
              when t.first_response_at is not null then 'kept'
              when t.response_due_at < now() then 'breached'
              when t.response_due_at < now() + interval '60 minutes' then 'at_risk'
              else 'on_time' end as response_clock,
         case when t.resolution_due_at is null then null
              when t.resolved_at is not null and t.resolved_at <= t.resolution_due_at then 'kept'
              when t.resolved_at is not null then 'late'
              when t.resolution_due_at < now() then 'breached'
              when t.resolution_due_at < now() + interval '24 hours' then 'at_risk'
              else 'on_time' end as resolution_clock
    from support_tickets t
    left join users a on a.id = t.allocated_by and a.tenant_id = t.tenant_id
    left join platform_departments e on e.id = t.escalated_from_id
   where t.department_id = $1 and t.tenant_id = $2 and t.deleted_at is null
   order by (t.status in ('open','allocated','in_progress')) desc,
            (t.priority = 'urgent') desc,
            coalesce(t.response_due_at, t.resolution_due_at, t.ts)
   limit $3`;

// ---------- the routing rules: who takes a call nobody pointed anywhere ----------

/** Every live rule, in the order the matcher reads them. Params: tenant. */
export const ROUTE_RULES_SQL = `
  select r.id, r.name, r.department_id, upper(d.key) as department_key,
         d.name as department_name, d.sort as department_sort,
         r.channels, r.categories, r.priorities, r.languages, r.region_ids,
         coalesce(rg.regions, '[]'::jsonb) as regions,
         r.precedence, r.is_active, r.note, r.created_at, r.updated_at,
         u.full_name as created_by_name,
         coalesce(f.fired, 0)::int as fired
    from support_ticket_routes r
    join platform_departments d on d.id = r.department_id
    left join lateral (
      select jsonb_agg(json_build_object('id', g.id, 'name', g.name_en) order by g.id) as regions
        from geo_regions g where g.id = any(r.region_ids)
    ) rg on true
    left join users u on u.id = r.created_by
    -- One pass over the routed lines, grouped by the rule that fired, rather than one scan of
    -- the event register per rule.
    left join (
      select e.detail ->> 'rule_id' as rule_id, count(*)::int as fired
        from support_ticket_events e
       where e.tenant_id = $1 and e.action = 'routed' and e.detail ? 'rule_id'
       group by 1
    ) f on f.rule_id = r.id::text
   where r.tenant_id = $1 and r.deleted_at is null
   order by r.precedence, upper(r.name)`;

/** One rule, retired or not — a retire has to be able to say what it retired, and so does a
 *  call that landed on a desk three months ago. Params: rule, tenant. */
export const ROUTE_RULE_SQL = `
  select r.id, r.name, r.department_id, r.channels, r.categories, r.priorities, r.languages,
         r.region_ids, r.precedence, r.is_active, r.note, r.deleted_at, r.created_at,
         upper(d.key) as department_key, d.name as department_name, d.deleted_at as desk_closed,
         (select count(*)::int from support_ticket_events e
           where e.tenant_id = $2 and e.action = 'routed'
             and e.detail ->> 'rule_id' = r.id::text) as fired
    from support_ticket_routes r
    left join platform_departments d on d.id = r.department_id
   where r.id = $1 and r.tenant_id = $2`;

/** Params: tenant, name, rule|null (an edit may keep its own name). */
export const ROUTE_RULE_NAME_TAKEN_SQL = `
  select id, name, precedence from support_ticket_routes
   where tenant_id = $1 and name = $2 and deleted_at is null
     and ($3::uuid is null or id <> $3::uuid)`;

/** Params: tenant, name, department, channels, categories, priorities, languages, regions,
 *  precedence, is_active, note, actor. */
export const INSERT_ROUTE_RULE_SQL = `
  insert into support_ticket_routes
    (tenant_id, name, department_id, channels, categories, priorities, languages, region_ids,
     precedence, is_active, note, created_by, updated_by)
  values ($1,$2,$3,$4::text[],$5::text[],$6::text[],$7::text[],$8::int[],$9,$10,$11,$12,$12)
  returning id, name, department_id, channels, categories, priorities, languages, region_ids,
            precedence, is_active, note, created_at, updated_at`;

/** The same presence rules as the desk's terms, with one difference: a list sent as empty is
 *  a real answer ("stop narrowing on channel") and is written, while a key the desk did not
 *  send is left alone. Only `note` needs a flag, because it is the one column that can be
 *  cleared to nothing.
 *  Params: rule, tenant, actor, name, department, channels, categories, priorities, languages,
 *  regions, precedence, is_active, note_provided, note. */
export const UPDATE_ROUTE_RULE_SQL = `
  update support_ticket_routes
     set name = coalesce($4, name),
         department_id = coalesce($5, department_id),
         channels = coalesce($6::text[], channels),
         categories = coalesce($7::text[], categories),
         priorities = coalesce($8::text[], priorities),
         languages = coalesce($9::text[], languages),
         region_ids = coalesce($10::int[], region_ids),
         precedence = coalesce($11, precedence),
         is_active = coalesce($12::bool, is_active),
         note = case when $13::bool then $14::text else note end,
         updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
  returning id, name, department_id, channels, categories, priorities, languages, region_ids,
            precedence, is_active, note, updated_at`;

/** Retiring is not deleting: the register keeps the rule that fired last month so a desk can
 *  still ask why a call landed where it did. Params: rule, tenant, actor. */
export const RETIRE_ROUTE_RULE_SQL = `
  update support_ticket_routes
     set deleted_at = now(), deleted_by = $3, is_active = false, updated_by = $3
   where id = $1 and tenant_id = $2 and deleted_at is null
  returning id, name, precedence`;

/** What the matcher would do with a call shaped like this. Params: tenant, channel, category,
 *  priority, language, region|null. The definer reads no tenant setting of its own — the id
 *  is bound, the same reason every other statement on this desk binds it. */
export const ROUTE_MATCH_SQL = `
  select platform_auth.route_ticket($1::uuid,$2,$3,$4,$5,$6::int) as m`;

/** The regions a rule names, by the name a person would recognise. Params: ids. */
export const REGION_NAMES_SQL = `
  select id, name_en as name from geo_regions where id = any($1::int[]) order by id`;

/** The picker: every region a rule is allowed to name. Params: none.
 *  A rule that points at an inactive region still fires, so the desk is only ever offered
 *  the ones the office still routes to. */
export const ALL_REGIONS_SQL = `
  select id, code, name_en as name, name_sw from geo_regions
   where is_active order by name_en`;

// ---------- gates ----------

/** Reads accept either key; the boolean is whether this seat may also reshape the chart. */
async function requireDeptRead(req: any): Promise<boolean> {
  const held = await controlHolds(req, [VIEW, MANAGE]);
  const canManage = held.includes(MANAGE);
  if (!canManage && !held.includes(VIEW)) {
    throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
  }
  return canManage;
}

async function requireDeptManage(req: any) {
  if (!(await controlHolds(req, [MANAGE])).includes(MANAGE)) {
    throw new ApiError("FORBIDDEN",
      "Reading the departments is one duty, moving people between them is another. "
      + "Yours does not include it.", 403);
  }
}

/** The label the register keeps — a name copied now outlives the row it came from. */
function labels(rows: any[]): string {
  return rows.map((r: any) => r.name ?? "?").join(", ");
}

function deptId(value: unknown, missing = "That is not on this desk."): string {
  const parsed = z.string().uuid().safeParse(String(value ?? ""));
  if (!parsed.success) throw new ApiError("NOT_FOUND", missing, 404);
  return parsed.data;
}

/** Which predicates a rule actually narrows on. An empty list asks nothing, and 123's CHECK
 *  demands that at least one asks something: a rule that narrows on nothing is a catch-all
 *  that takes the whole queue to one desk — the rule a tired clerk writes at 17:55. */
function narrowing(lists: Record<(typeof RULE_LISTS)[number], unknown[] | null | undefined>) {
  const sent = RULE_LISTS.filter((k) => (lists[k] ?? []).length > 0);
  return { sent, words: sent.join(", ") };
}

/** The rule as the one sentence the register keeps, so a desk can answer "why did this land
 *  on us?" without reading five arrays off a row. `regions` is whatever the caller has on hand
 *  — the jsonb the list read builds, or the rows REGION_NAMES_SQL returns — keyed by `name`. */
function ruleSentence(rule: Record<string, any>, deskName: string, regions: any[]) {
  const parts: string[] = [];
  if (rule.channels?.length) parts.push(`called on ${rule.channels.join(" / ")}`);
  if (rule.categories?.length) parts.push(`about ${rule.categories.join(" / ")}`);
  if (rule.priorities?.length) parts.push(`at ${rule.priorities.join(" / ")} urgency`);
  if (rule.languages?.length) parts.push(`spoken in ${rule.languages.join(" / ")}`);
  if (rule.region_ids?.length) {
    const named = (regions ?? []).map((g: any) => g?.name).filter(Boolean).join(" / ");
    parts.push(`from ${named || `${rule.region_ids.length} region(s)`}`);
  }
  return `A call ${parts.join(", ")} goes to ${deskName}.`;
}

/** The matcher's own test, written once in TypeScript so the dry run can name the rules that
 *  also fitted and lost. 123's `route_ticket` is the answer the register acts on; this is only
 *  ever a picture of it, and the page says so. */
function ruleFits(r: any, call: { channel: string; category: string; priority: string;
  language: string; regionId: number | null }) {
  return (!r.channels?.length || r.channels.includes(call.channel))
    && (!r.categories?.length || r.categories.includes(call.category))
    && (!r.priorities?.length || r.priorities.includes(call.priority))
    && (!r.languages?.length || r.languages.includes(call.language))
    && (!r.region_ids?.length
      || (call.regionId !== null && r.region_ids.includes(call.regionId)));
}

export async function controlDepartmentRoutes(app: FastifyInstance, _opts: unknown) {
  const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;

  /**
   * One act: the register row first, then the ordinary audit row. Both are inside the
   * caller's transaction, so a move that failed to record itself also failed to happen.
   */
  const record = async (c: any, req: any, row: {
    userId: string; action: typeof ACTIONS[number];
    seatName?: string | null; fromLabel?: string | null; toLabel?: string | null;
    fromDept?: string | null; toDept?: string | null;
    reason: string; detail?: object;
    entity: string; entityId: string | null; before?: object; after?: object;
  }) => {
    const t = await c.query(INSERT_TRANSITION_SQL, [
      req.control.tenant_id, row.userId, req.control.user_id, role(req), req.ip ?? null,
      req.requestId ?? null, row.action, row.seatName ?? null, row.fromLabel ?? null,
      row.toLabel ?? null, row.fromDept ?? null, row.toDept ?? null, row.reason,
      JSON.stringify(row.detail ?? {})
    ]);
    await writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id,
      actorRole: role(req), ip: req.ip, requestId: req.requestId,
      entity: row.entity, entityId: row.entityId,
      action: `control.departments.${row.action}`,
      before: row.before,
      after: { ...(row.after ?? {}), reason: row.reason, transition_id: t.rows[0].id }
    });
    return t.rows[0];
  };

  // ---------- the chart ----------
  app.get("/control/departments", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireDeptRead(req);
    await enforceRateLimit(`dept:uid:${req.control.user_id}`, 60, 60);
    const { days } = z.object({ days: DAYS }).strict().parse(req.query ?? {});
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const departments = await c.query(DEPARTMENTS_SQL, [tenantId]);
      const unassigned = await c.query(UNASSIGNED_SQL, [tenantId]);
      const closed = await c.query(CLOSED_DEPARTMENTS_SQL, [tenantId]);
      const summary = await c.query(DEPT_SUMMARY_SQL, [tenantId, days]);
      return {
        can_manage: canManage,
        window_days: days,
        summary: summary.rows[0] ?? {},
        departments: departments.rows,
        unassigned: unassigned.rows,
        closed: closed.rows
      };
    });
  });

  // ---------- the register of moves ----------
  app.get("/control/departments/register", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptRead(req);
    await enforceRateLimit(`dept-register:uid:${req.control.user_id}`, 60, 60);
    const q = z.object({
      action: z.enum(ACTIONS).optional(),
      user: z.string().uuid().optional(),
      q: z.string().trim().max(120).optional(),
      days: DAYS,
      limit: LIMIT
    }).strict().parse(req.query ?? {});
    const tenantId = req.control.tenant_id;
    const pattern = q.q ? `%${q.q}%` : null;
    const filter = [tenantId, q.action ?? null, q.user ?? null, pattern, q.days];

    return withTenant(tenantId, async (c) => {
      const rows = await c.query(REGISTER_SQL, [...filter, q.limit]);
      const total = await c.query(REGISTER_COUNT_SQL, filter);
      return {
        window_days: q.days,
        filters: { action: q.action ?? null, user: q.user ?? null, q: q.q ?? null },
        total: total.rows[0]?.n ?? 0,
        last_7: total.rows[0]?.last_7 ?? 0,
        items: rows.rows
      };
    });
  });

  // ---------- open a desk ----------
  app.post("/control/departments", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const body = z.object({
      key: z.string().trim().toLowerCase()
        .regex(/^[a-z][a-z0-9_]{1,39}$/,
          "Use lowercase letters, digits or underscores, starting with a letter."),
      name: z.string().trim().min(2).max(70),
      purpose: z.string().trim().max(240).default(""),
      sort: z.number().int().min(0).max(9999).default(100)
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const taken = await c.query(KEY_TAKEN_SQL, [tenantId, body.key, null]);
      if (taken.rowCount) {
        throw new ApiError("CONFLICT",
          `A department already answers to "${body.key}" — it belongs to ${taken.rows[0].name}.`,
          409, [{ field: "key" }]);
      }
      const made = await c.query(INSERT_DEPARTMENT_SQL,
        [tenantId, body.key, body.name, body.purpose, body.sort, req.control.user_id]);
      const dept = made.rows[0];
      await record(c, req, {
        userId: req.control.user_id, action: "department_created",
        toLabel: dept.name, toDept: dept.id, entity: "platform_departments", entityId: dept.id,
        after: { key: dept.key, name: dept.name, sort: dept.sort },
        reason: body.purpose || `A new desk called ${dept.name} was needed.`
      });
      return dept;
    });
  });

  // ---------- renamed, reworded, re-ordered ----------
  app.patch("/control/departments/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const body = z.object({
      name: z.string().trim().min(2).max(70).optional(),
      purpose: z.string().trim().max(240).optional(),
      sort: z.number().int().min(0).max(9999).optional()
    }).strict().parse(req.body);
    if (body.name === undefined && body.purpose === undefined && body.sort === undefined) {
      throw new ApiError("VALIDATION_FAILED", "Say what to change.", 400, [{ field: "name" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const now = await c.query(UPDATE_DEPARTMENT_SQL, [id, tenantId,
        body.name ?? null, body.purpose ?? null, body.sort ?? null, req.control.user_id]);
      if (!now.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const after = now.rows[0];
      const changed = body.name !== undefined ? `Renamed${body.purpose === undefined
        && body.sort === undefined ? ` from ${body.name}` : ""}.`
        : (body.purpose !== undefined ? "Its purpose was rewritten." : "It moved in the order.");
      await record(c, req, {
        userId: req.control.user_id, action: "department_updated",
        toLabel: after.name, toDept: after.id, entity: "platform_departments", entityId: after.id,
        after: { name: after.name, purpose: after.purpose, sort: after.sort },
        reason: body.name ? `Now called ${after.name}. ${changed}` : changed
      });
      return after;
    });
  });

  // ---------- what this desk owes, and who it goes to when it cannot pay ----------
  app.put("/control/departments/:id/terms", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const raw = (req.body ?? {}) as Record<string, any>;
    const body = z.object({
      firstResponseMinutes: z.number().int().min(5).max(4320).nullish()
        .refine((v) => v === null || v === undefined || v >= 5,
          "A first answer inside five minutes is not a promise a desk can keep. "
          + "Use 5 to 4320 minutes, or leave it empty for no clock."),
      resolveMinutes: z.number().int().min(15).max(20160).nullish(),
      businessHours: WEEK.nullish(),
      escalationDepartmentId: z.string().uuid().nullish(),
      maxOpenTickets: z.number().int().min(1).max(500).nullish(),
      reason: REASON
    }).strict().parse(raw);
    const sent = TERM_KEYS.filter((k) => k in raw);
    if (!sent.length) {
      throw new ApiError("VALIDATION_FAILED",
        "Say which of the desk's terms to change — the hours, the two clocks, the desk above "
        + "it, or the load it will accept.", 400, [{ field: "businessHours" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(DEPARTMENT_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const d = found.rows[0];

      // The week the desk will actually be read against: the one it just sent, or the one
      // already stored when this write only changed a clock.
      const week = "businessHours" in raw ? body.businessHours : d.business_hours;
      const responseMinutes = "firstResponseMinutes" in raw
        ? body.firstResponseMinutes : d.first_response_minutes;
      const resolveMinutes = "resolveMinutes" in raw ? body.resolveMinutes : d.resolve_minutes;

      if (responseMinutes && resolveMinutes && responseMinutes > resolveMinutes) {
        throw new ApiError("VALIDATION_FAILED",
          `An answer in ${responseMinutes} minutes cannot be promised on a call that is owed `
          + `in ${resolveMinutes}. The first response has to fit inside the resolution.`,
          400, [{ field: "firstResponseMinutes" }, { field: "resolveMinutes" }]);
      }

      if (body.escalationDepartmentId) {
        if (body.escalationDepartmentId === id) {
          throw new ApiError("VALIDATION_FAILED",
            `${d.name} cannot send its own work to itself — that is a call nobody answers. `
            + "Leave the desk above empty to end the chain here.", 400,
            [{ field: "escalationDepartmentId" }]);
        }
        const target = await c.query(DEPARTMENT_SQL, [body.escalationDepartmentId, tenantId]);
        if (!target.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "The desk above has to be an open department on this chart.", 400,
            [{ field: "escalationDepartmentId" }]);
        }
        // 123's trigger walks the same chain and refuses the write; the walk here is what
        // names the desks instead of leaving the desk with a sentence about itself.
        const chain = await c.query(ESCALATION_UP_SQL, [target.rows[0].id, tenantId]);
        const back = chain.rows.find((r: any) => r.id === id);
        if (back) {
          throw new ApiError("CONFLICT",
            `${target.rows[0].name} already sends its work up through ${back.name}, which is `
            + `${d.name} itself. Escalation has to end somewhere — point the top desk at no desk.`,
            409, [{ field: "escalationDepartmentId" }]);
        }
      }

      let wrote: any;
      try {
        wrote = await c.query(SET_DEPARTMENT_TERMS_SQL, [
          id, tenantId, req.control.user_id,
          "firstResponseMinutes" in raw, body.firstResponseMinutes ?? null,
          "resolveMinutes" in raw, body.resolveMinutes ?? null,
          "businessHours" in raw,
          week === null || week === undefined ? null : weekJson(week as any),
          "escalationDepartmentId" in raw, body.escalationDepartmentId ?? null,
          "maxOpenTickets" in raw, body.maxOpenTickets ?? null
        ]);
      } catch (err) {
        const refused = sqlRefusal(err, `${d.name}'s terms were refused by the register.`);
        if (refused) throw refused;
        throw err;
      }
      if (!wrote.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const after = wrote.rows[0];

      // Read the new desk above this one off the chart so the sentence the register keeps names
      // it; the write has already happened, so this is a label, not a check.
      const above = after.escalation_department_id
        ? (await c.query(DEPARTMENT_SQL, [after.escalation_department_id, tenantId])).rows[0]
        : null;

      const changedWords = sent.map((k) => {
        if (k === "firstResponseMinutes") {
          return after.first_response_minutes === null
            ? "No first-response clock is promised."
            : `A first answer is owed within ${after.first_response_minutes} working minutes.`;
        }
        if (k === "resolveMinutes") {
          return after.resolve_minutes === null
            ? "No resolution clock is promised."
            : `A resolution is owed within ${after.resolve_minutes} working minutes.`;
        }
        if (k === "businessHours") {
          return weekIsOpen(after.business_hours)
            ? "Its working week was rewritten."
            : "It is now shut on every day of the week.";
        }
        if (k === "escalationDepartmentId") {
          return above ? `Work it cannot answer goes up to ${above.name}.`
            : "Nothing is escalated above it any more.";
        }
        return after.max_open_tickets === null
          ? "It will not say when it is full."
          : `It will hold ${after.max_open_tickets} live call(s) before the register says so.`;
      });

      await record(c, req, {
        userId: req.control.user_id, action: "department_updated",
        toLabel: d.name, toDept: id, entity: "platform_departments", entityId: id,
        before: { first_response_minutes: d.first_response_minutes,
          resolve_minutes: d.resolve_minutes, business_hours: d.business_hours,
          escalation_department_id: d.escalation_department_id,
          max_open_tickets: d.max_open_tickets },
        after: { first_response_minutes: after.first_response_minutes,
          resolve_minutes: after.resolve_minutes, business_hours: after.business_hours,
          escalation_department_id: after.escalation_department_id,
          max_open_tickets: after.max_open_tickets, changed: sent },
        reason: body.reason,
        detail: { terms: changedWords }
      });

      // Honest about the one state where a clock exists but can never be met.
      const clock_note = weekIsOpen(after.business_hours)
        || (after.first_response_minutes === null && after.resolve_minutes === null)
        ? null
        : "This desk promises an answer but is shut every day of the week, so no call can be "
          + "given a due date. Open the desk, or clear the clock.";
      return { ...after, changed: sent, clock_note };
    });
  });

  // ---------- one desk, with its numbers ----------
  app.get("/control/departments/:id", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireDeptRead(req);
    await enforceRateLimit(`dept-one:uid:${req.control.user_id}`, 60, 60);
    const id = deptId(req.params.id);
    const { days, limit } = z.object({ days: DAYS, limit: LIMIT }).strict().parse(req.query ?? {});
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(DEPARTMENT_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const dept = found.rows[0];
      const kpi = (await c.query(DEPT_KPI_SQL, [id, days, tenantId])).rows[0] ?? {};
      const tickets = await c.query(DEPT_TICKETS_SQL, [id, tenantId, limit]);
      const chart = await c.query(ROUTE_RULES_SQL, [tenantId]);
      return {
        can_manage: canManage,
        window_days: days,
        department: dept,
        kpi,
        // The ceiling is a figure the register reads, not a wall: it says how close the desk
        // is to refusing new work, and an escalation is allowed past it by design.
        headroom: dept.max_open_tickets === null ? null
          : dept.max_open_tickets - (kpi.live ?? 0),
        escalation: {
          up: (await c.query(ESCALATION_UP_SQL, [id, tenantId])).rows,
          down: (await c.query(ESCALATION_DOWN_SQL, [id, tenantId])).rows
        },
        // The same one sentence the board and the writes keep, so a desk answering "why did
        // this land on us?" reads the register's words rather than five arrays off a row.
        rules: chart.rows
          .filter((r: any) => r.department_id === id)
          .map((r: any) => ({
            ...r,
            sentence: ruleSentence(r, r.department_name ?? dept.name, r.regions ?? [])
          })),
        tickets: tickets.rows,
        open_week: weekIsOpen(dept.business_hours)
      };
    });
  });

  // ---------- close a desk, with somewhere for its people to go ----------
  app.post("/control/departments/:id/close", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const body = z.object({
      reason: REASON, moveTo: z.string().uuid().nullish(),
      moveTicketsTo: z.string().uuid().nullish()
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(DEPARTMENT_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const d = found.rows[0];
      const seats = await c.query(DEPT_LIVE_SEATS_SQL, [id]);
      let moved = 0;

      // The calls standing on the desk are read before the write, not after, because 123's
      // archive guard makes the database refuse the close either way and the desk is far
      // better served by the list of calls than by the number of them.
      const live = await c.query(DEPT_OPEN_TICKETS_SQL, [id, tenantId]);
      let ticketsMoved = 0;
      if (live.rowCount) {
        const named = live.rows.slice(0, 6).map((t: any) =>
          // Both numbers, because two people read this sentence: the desk, which knows its own
          // queue position, and whoever has to ring the caller, who only ever said a CS number.
          `${t.dept_ref ? `${t.dept_ref} (${t.ref})` : t.ref} — ${t.subject}`).join("; ");
        if (!body.moveTicketsTo) {
          throw new ApiError("CONFLICT",
            `${d.name} still has ${live.rowCount} incidence(s) being worked: ${named}`
            + (live.rowCount! > 6 ? "…" : "")
            + ". Settle them, or name the desk they move to — a desk cannot be filed away "
            + "while calls are standing on it.", 409, [{ field: "moveTicketsTo" }]);
        }
        if (body.moveTicketsTo === id) {
          throw new ApiError("VALIDATION_FAILED",
            "The calls have to go to a different desk than the one being closed.", 400,
            [{ field: "moveTicketsTo" }]);
        }
        const refuge = await c.query(DEPARTMENT_SQL, [body.moveTicketsTo, tenantId]);
        if (!refuge.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "The desk to move the calls to is not an open department on this chart.", 400,
            [{ field: "moveTicketsTo" }]);
        }
        const r = refuge.rows[0];
        // The statement takes three: the desk keeps no column for who moved its calls, because
        // 101's trigger owns `updated_at` and the person's name goes in the event line below.
        const carried = await c.query(MOVE_DEPT_TICKETS_SQL, [id, tenantId, r.id]);
        ticketsMoved = carried.rowCount ?? 0;
        for (const t of carried.rows) {
          // The incidence keeps the number the closing desk minted — the caller was quoted
          // that ref, and 123 keeps `numbered_by` for exactly this moment. What moves is the
          // desk answerable for it, and the register has to be able to say who moved it.
          await c.query(INSERT_EVENT_SQL, [tenantId, t.id, t.ref, req.control.user_id,
            role(req), req.ip ?? null, req.requestId ?? null, "reallocated",
            d.name, r.name, id, r.id,
            `Closing ${d.name}: ${body.reason}`,
            JSON.stringify({ moved_by: "department_closed", desk_ref: t.dept_ref,
              priority: t.priority })]);
        }
      }

      if (seats.rowCount) {
        if (!body.moveTo) {
          // Closing a team with people in it is not a reorganisation, it is a disappearance.
          throw new ApiError("CONFLICT",
            `${d.name} still holds ${d.live_seats} seat(s). Name the department they move to, `
            + "or release them first.", 409, [{ field: "moveTo" }]);
        }
        if (body.moveTo === id) {
          throw new ApiError("VALIDATION_FAILED", "A department cannot absorb itself.", 400,
            [{ field: "moveTo" }]);
        }
        const target = await c.query(DEPARTMENT_SQL, [body.moveTo, tenantId]);
        if (!target.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "The department to move them to does not exist.", 400, [{ field: "moveTo" }]);
        }
        const t = target.rows[0];
        await c.query(SETTLE_EXPIRED_COVERS_SQL, [t.id, req.control.user_id]);
        // Every moved seat lands as a plain member: one head per department is the rule,
        // and two heads arriving at the same desk is how a handover becomes an argument.
        const inserted = await c.query(INSERT_MEMBERSHIPS_SQL,
          [tenantId, t.id, req.control.user_id,
            seats.rows.map((s: any) => s.user_id), null,
            `Moved from ${d.name} when it closed.`, "member"]);
        moved = inserted.rowCount ?? 0;
        const byId = new Map(seats.rows.map((s: any) => [s.user_id, s.full_name]));
        const placed = new Set(inserted.rows.map((r: any) => r.user_id));
        for (const row of inserted.rows) {
          await record(c, req, {
            userId: row.user_id, action: "seat_moved",
            seatName: byId.get(row.user_id) ?? null,
            fromLabel: d.name, toLabel: t.name, fromDept: id, toDept: t.id,
            entity: "platform_seat_departments", entityId: row.id,
            reason: `Closing ${d.name}: ${body.reason}`
          });
        }
        // A seat that already sat at the target is not placed again, but it does leave this
        // desk — and a closing team must not be able to drop somebody out of the record.
        for (const s of seats.rows.filter((r: any) => !placed.has(r.user_id))) {
          await record(c, req, {
            userId: s.user_id, action: "seat_released", seatName: s.full_name,
            fromLabel: d.name, toLabel: t.name, fromDept: id, toDept: t.id,
            entity: "platform_seat_departments", entityId: null,
            detail: { already_at: t.name },
            reason: `Closing ${d.name}: already sat in ${t.name}. ${body.reason}`
          });
        }
      }

      const released = await c.query(RELEASE_DEPT_MEMBERSHIPS_SQL, [id, req.control.user_id]);
      let closed: any;
      try {
        closed = await c.query(CLOSE_DEPARTMENT_SQL, [id, tenantId, req.control.user_id]);
      } catch (err) {
        // A call logged between the read above and this write is the one case the pre-check
        // cannot cover, so the guard's own sentence is passed back rather than the transaction
        // aborting into a generic 500.
        const refused = sqlRefusal(err, `${d.name} still has work standing on it.`);
        if (refused) throw refused;
        throw err;
      }
      if (!closed.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      await record(c, req, {
        userId: req.control.user_id, action: "department_closed",
        fromLabel: d.name, fromDept: id, entity: "platform_departments", entityId: id,
        before: { is_active: true, seats: d.live_seats, live_tickets: d.live_tickets },
        after: { is_active: false, seats_released: released.rowCount ?? 0, seats_moved: moved,
          tickets_moved: ticketsMoved },
        reason: body.reason
      });
      return { id, closed: true, seats_released: released.rowCount ?? 0, seats_moved: moved,
        tickets_moved: ticketsMoved };
    });
  });

  app.post("/control/departments/:id/reopen", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const body = z.object({ reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(DEPARTMENT_ANY_SQL, [id, tenantId]);
      if (!was.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      if (!was.rows[0].deleted_at) throw new ApiError("CONFLICT", "That desk is already open.", 409);
      const taken = await c.query(KEY_TAKEN_SQL, [tenantId, was.rows[0].key, id]);
      if (taken.rowCount) {
        throw new ApiError("CONFLICT",
          `Another department has taken the key "${was.rows[0].key}" since it closed. `
          + "Open a new desk instead.", 409);
      }
      const reopened = await c.query(REOPEN_DEPARTMENT_SQL, [id, tenantId, req.control.user_id]);
      if (!reopened.rowCount) throw new ApiError("CONFLICT", "That desk is already open.", 409);
      await record(c, req, {
        userId: req.control.user_id, action: "department_reopened",
        toLabel: was.rows[0].name, toDept: id, entity: "platform_departments", entityId: id,
        before: { is_active: false }, after: { is_active: true }, reason: body.reason
      });
      return { id, closed: false };
    });
  });

  // ---------- give a desk seats ----------
  app.post("/control/departments/:id/seats", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const body = z.object({
      userIds: UUIDS, reason: REASON, endsOn: ENDS_ON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(DEPARTMENT_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const d = found.rows[0];
      const ids = [...new Set(body.userIds)];
      const valid = await c.query(PLATFORM_SEATS_SQL, [ids, tenantId]);
      if (valid.rowCount !== ids.length) {
        const known = new Set(valid.rows.map((r: any) => r.user_id));
        throw new ApiError("VALIDATION_FAILED",
          `Not a platform seat of this desk: ${ids.filter((i) => !known.has(i)).join(", ")}`,
          400, [{ field: "userIds" }]);
      }
      const inactive = valid.rows.filter((r: any) => r.status !== "active")
        .map((r: any) => r.full_name);
      if (inactive.length) {
        // Placing a seat that is not on the desk makes the chart lie about who is working.
        throw new ApiError("CONFLICT",
          `Not active, so not placeable: ${inactive.join(", ")}. Change their status first.`,
          409, [{ field: "userIds" }]);
      }

      await c.query(SETTLE_EXPIRED_COVERS_SQL, [d.id, req.control.user_id]);
      const inserted = await c.query(INSERT_MEMBERSHIPS_SQL, [tenantId, d.id,
        req.control.user_id, ids, body.endsOn ?? null, body.reason.slice(0, 240), "member"]);
      const byId = new Map(valid.rows.map((r: any) => [r.user_id, r.full_name]));
      for (const row of inserted.rows) {
        await record(c, req, {
          userId: row.user_id, action: "seat_joined",
          seatName: byId.get(row.user_id) ?? null,
          toLabel: d.name, toDept: d.id, entity: "platform_seat_departments",
          entityId: row.id, detail: { ends_on: body.endsOn ?? null, cover: !!body.endsOn },
          reason: body.reason
        });
      }
      return {
        department: d.id, placed: inserted.rowCount ?? 0,
        already_seated: ids.filter((i) => !(inserted.rows as any[]).some((r) => r.user_id === i))
          .map((i) => byId.get(i) ?? i)
      };
    });
  });

  // ---------- move one seat ----------
  app.post("/control/departments/move", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const body = z.object({
      userId: z.string().uuid(), toDepartmentId: z.string().uuid(),
      reason: REASON, endsOn: ENDS_ON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const seat = await c.query(PLATFORM_SEATS_SQL, [[body.userId], tenantId]);
      if (!seat.rowCount) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
      if (seat.rows[0].status !== "active") {
        throw new ApiError("CONFLICT", "That seat is not active, so it cannot be moved.", 409);
      }
      const target = await c.query(DEPARTMENT_SQL, [body.toDepartmentId, tenantId]);
      if (!target.rowCount) {
        throw new ApiError("NOT_FOUND", "The department to move them to does not exist.", 404);
      }
      const held = await c.query(SEAT_MEMBERSHIPS_SQL, [body.userId]);
      if (held.rowCount === 1 && held.rows[0].department_id === target.rows[0].id) {
        throw new ApiError("CONFLICT",
          `${seat.rows[0].full_name} already sits in ${target.rows[0].name} and nowhere else.`, 409);
      }
      const from = labels(held.rows);
      const released = await c.query(RELEASE_SEAT_MEMBERSHIPS_SQL, [body.userId, req.control.user_id]);
      // A head that leaves a desk cannot stay answerable for it. Read the standing off the
      // rows that were just released, not off the live list: a headship carried by a cover
      // that ran out is invisible to the read but still points at this person.
      const wasHeadOf = released.rows.filter((r: any) => r.standing === "head")
        .map((r: any) => r.department_id);
      for (const dept of wasHeadOf) {
        await c.query(SET_HEAD_SQL, [dept, null, req.control.user_id]);
      }
      await c.query(SETTLE_EXPIRED_COVERS_SQL, [target.rows[0].id, req.control.user_id]);
      const joined = await c.query(INSERT_MEMBERSHIPS_SQL, [tenantId, target.rows[0].id,
        req.control.user_id, [body.userId], body.endsOn ?? null, body.reason.slice(0, 240),
        "member"]);
      await record(c, req, {
        userId: body.userId, action: "seat_moved", seatName: seat.rows[0].full_name,
        fromLabel: from || null, toLabel: target.rows[0].name, toDept: target.rows[0].id,
        entity: "platform_seat_departments", entityId: joined.rows[0]?.id ?? null,
        detail: { ends_on: body.endsOn ?? null, left: released.rowCount ?? 0,
          headships_released: wasHeadOf.length,
          already_seated: (joined.rowCount ?? 0) === 0 },
        reason: body.reason
      });
      return {
        user_id: body.userId, from, to: target.rows[0].name,
        released: released.rowCount ?? 0, joined: joined.rowCount ?? 0
      };
    });
  });

  // ---------- take a seat off every desk ----------
  app.post("/control/departments/leave", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const body = z.object({ userId: z.string().uuid(), reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const seat = await c.query(PLATFORM_SEATS_SQL, [[body.userId], tenantId]);
      if (!seat.rowCount) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
      const held = await c.query(SEAT_MEMBERSHIPS_SQL, [body.userId]);
      if (!held.rowCount) {
        throw new ApiError("CONFLICT",
          `${seat.rows[0].full_name} does not sit in a department right now.`, 409);
      }
      const released = await c.query(RELEASE_SEAT_MEMBERSHIPS_SQL, [body.userId, req.control.user_id]);
      const wasHeadOf = released.rows.filter((r: any) => r.standing === "head")
        .map((r: any) => r.department_id);
      for (const dept of wasHeadOf) {
        await c.query(SET_HEAD_SQL, [dept, null, req.control.user_id]);
      }
      await record(c, req, {
        userId: body.userId, action: "seat_released", seatName: seat.rows[0].full_name,
        fromLabel: labels(held.rows), entity: "platform_seat_departments", entityId: null,
        detail: { left: released.rowCount ?? 0, headships_released: wasHeadOf.length },
        reason: body.reason
      });
      return { user_id: body.userId, released: released.rowCount ?? 0 };
    });
  });

  // ---------- who answers for this desk ----------
  app.post("/control/departments/:id/head", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const body = z.object({
      userId: z.string().uuid().nullable(), reason: REASON, endsOn: ENDS_ON
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(DEPARTMENT_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const d = found.rows[0];

      if (!body.userId) {
        if (!d.head_user_id) throw new ApiError("CONFLICT", `${d.name} has no head.`, 409);
        const wasHead = await c.query(SEAT_NAME_SQL, [d.head_user_id]);
        await c.query(DEMOTE_HEAD_MEMBERSHIP_SQL, [id, req.control.user_id]);
        await c.query(SET_HEAD_SQL, [id, null, req.control.user_id]);
        await record(c, req, {
          userId: d.head_user_id, action: "head_released",
          seatName: wasHead.rows[0]?.full_name ?? null,
          fromLabel: d.name, fromDept: id, entity: "platform_departments", entityId: id,
          before: { head: wasHead.rows[0]?.full_name ?? null }, after: { head: null },
          reason: body.reason
        });
        return { department: id, head_user_id: null };
      }

      const seat = await c.query(PLATFORM_SEATS_SQL, [[body.userId], tenantId]);
      if (!seat.rowCount) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
      if (seat.rows[0].status !== "active") {
        throw new ApiError("CONFLICT", "A seat that is not active cannot answer for a desk.", 409);
      }
      const previous = d.head_user_id === body.userId ? null
        : d.head_user_id
          ? (await c.query(SEAT_NAME_SQL, [d.head_user_id])).rows[0]
          : null;
      if (!previous && d.head_user_id === body.userId) {
        throw new ApiError("CONFLICT",
          `${seat.rows[0].full_name} already heads ${d.name}.`, 409);
      }
      // One head per department is an index, not a convention: the old one steps down in
      // the same breath as the new one is named, or the insert would abort the transaction.
      // Covers that ran out are settled first for the same reason — they are read as gone
      // but still hold both the seat and the headship slot until somebody stamps them.
      await c.query(SETTLE_EXPIRED_COVERS_SQL, [id, req.control.user_id]);
      const stepped = await c.query(DEMOTE_HEAD_MEMBERSHIP_SQL, [id, req.control.user_id]);
      const already = await c.query(SEAT_MEMBERSHIPS_SQL, [body.userId]);
      const inThisDesk = already.rows.some((r: any) => r.department_id === id);
      if (inThisDesk) {
        await c.query(PROMOTE_MEMBERSHIP_SQL,
          [body.userId, id, req.control.user_id, body.endsOn ?? null]);
      } else {
        await c.query(INSERT_MEMBERSHIPS_SQL, [tenantId, id, req.control.user_id,
          [body.userId], body.endsOn ?? null, `Named head of ${d.name}.`, "head"]);
      }
      await c.query(SET_HEAD_SQL, [id, body.userId, req.control.user_id]);

      if (previous) {
        await record(c, req, {
          userId: previous.id, action: "head_released", seatName: previous.full_name,
          fromLabel: d.name, fromDept: id, entity: "platform_departments", entityId: id,
          reason: `Handed ${d.name} to ${seat.rows[0].full_name}. ${body.reason}`
        });
      }
      const t = await record(c, req, {
        userId: body.userId, action: "head_appointed", seatName: seat.rows[0].full_name,
        toLabel: d.name, toDept: id, entity: "platform_departments", entityId: id,
        before: { head: previous?.full_name ?? null }, after: { head: seat.rows[0].full_name },
        detail: { ends_on: body.endsOn ?? null, acting: !!body.endsOn,
          seats_stepped_down: stepped.rowCount ?? 0 },
        reason: body.reason
      });
      return { department: id, head_user_id: body.userId, transition_id: t.id };
    });
  });

  // ---------- the routing rules: who takes a call nobody pointed anywhere ----------
  //
  // 123's `route_ticket` is the matcher and the order it reads in is the desk's answer, so what
  // these handlers own is the *shape* of a rule: which predicates still narrow, whether the
  // region ids and the desk it names are real, and whether the rule narrows on anything at all.
  // Every write is refused before it reaches the table's own CHECKs, because a rule that can
  // never match a call is not an error anybody sees — it is a queue that quietly stops routing.

  const noNarrowing = () => new ApiError("VALIDATION_FAILED",
    "A rule that narrows on nothing would send every call on the platform to one desk. Name at "
    + "least one predicate — the channel, the subject, the urgency, the language or the region "
    + "— or leave the call for a clerk to point at a desk by hand.", 400,
    RULE_LISTS.map((k) => ({ field: k })));

  const uniq = (v: readonly any[] | null | undefined) => Array.from(new Set(v ?? []));

  const ruleSnapshot = (r: any) => ({ name: r.name, department_id: r.department_id,
    channels: r.channels, categories: r.categories, priorities: r.priorities,
    languages: r.languages, region_ids: r.region_ids, precedence: r.precedence,
    is_active: r.is_active, note: r.note });

  /** A rule may only name regions that exist: 123 keeps `region_ids` a plain int[] with no
   *  foreign key, so a stale id would be stored happily and match nothing — the same dead rule
   *  under a different name. */
  const readRegions = async (c: any, ids: number[]) => {
    if (!ids.length) return [] as any[];
    const rows = await c.query(REGION_NAMES_SQL, [ids]);
    const known = rows.rows.map((r: any) => r.id);
    const unknown = ids.filter((i) => !known.includes(i));
    if (unknown.length) {
      throw new ApiError("VALIDATION_FAILED",
        `There is no region ${unknown.join(", ")} on this platform. Choose from the regions the `
        + "desk offers — a rule that names an id nobody recognises routes nothing.", 400,
        [{ field: "regionIds" }]);
    }
    return rows.rows;
  };

  /** Every rule write ends with the desk it points at being an open one. A rule aimed at a
   *  filed-away desk never fires, and leaving it switched on is how an office loses calls
   *  without anybody deciding to stop taking them. */
  const openDesk = async (c: any, id: string, tenantId: string) => {
    const rows = await c.query(DEPARTMENT_SQL, [id, tenantId]);
    if (!rows.rowCount) {
      throw new ApiError("VALIDATION_FAILED",
        "The desk a rule points at has to be an open department on this chart.", 400,
        [{ field: "departmentId" }]);
    }
    return rows.rows[0];
  };

  /** Everything 123's guards on this table can refuse is validated above, so reaching one means
   *  a race — a second clerk naming a rule the same thing in the same breath. The desk is told
   *  that, rather than about a constraint it cannot act on. */
  const ruleRefusal = (err: any, name: string): ApiError | null => {
    if (err?.code === "23505") {
      return new ApiError("CONFLICT",
        `Another rule was given the name "${name}" while this one was being written. Two rules `
        + "that answer to one name cannot be told apart on the phone.", 409, [{ field: "name" }]);
    }
    if (["23514", "22023", "P0001"].includes(err?.code)) {
      return new ApiError("CONFLICT",
        `The register will not keep a rule called "${name}" shaped like that — the name, one of `
        + "the five predicates, the precedence or the note is outside what it accepts. "
        + "Nothing was saved.", 409);
    }
    return null;
  };

  app.get("/control/departments/routes", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireDeptRead(req);
    await enforceRateLimit(`dept-rules:uid:${req.control.user_id}`, 60, 60);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const rules = await c.query(ROUTE_RULES_SQL, [tenantId]);
      const regions = await c.query(ALL_REGIONS_SQL, []);
      const chart = await c.query(DEPARTMENTS_SQL, [tenantId]);
      // Two rules at one precedence are legal — 123 breaks the tie by name — but a clerk who
      // does not know that spends an evening asking why "their" rule never fired.
      const at = new Map<number, string[]>();
      for (const r of rules.rows) at.set(r.precedence, [...(at.get(r.precedence) ?? []), r.name]);
      return {
        can_manage: canManage,
        rules: rules.rows.map((r: any) => ({ ...r,
          sentence: ruleSentence(r, r.department_name,
            (r.regions ?? []).map((g: any) => g.name)) })),
        precedence_clashes: [...at.entries()]
          .filter(([, names]) => names.length > 1)
          .map(([precedence, names]) => ({ precedence, names }))
          .sort((a, b) => a.precedence - b.precedence),
        desks: chart.rows.map((d: any) => ({ id: d.id, key: d.key, name: d.name, sort: d.sort,
          max_open_tickets: d.max_open_tickets, live_tickets: d.live_tickets,
          breached_tickets: d.breached_tickets })),
        regions: regions.rows
      };
    });
  });

  app.post("/control/departments/routes", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-rules-write:uid:${req.control.user_id}`, 20, 300);
    const body = RULE_CREATE.parse(req.body);
    const lists = {
      channels: uniq(body.channels), categories: uniq(body.categories),
      priorities: uniq(body.priorities), languages: uniq(body.languages),
      regionIds: uniq(body.regionIds)
    };
    const { sent, words } = narrowing(lists);
    if (!sent.length) throw noNarrowing();
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const desk = await openDesk(c, body.departmentId, tenantId);
      const regionRows = await readRegions(c, lists.regionIds);
      const taken = await c.query(ROUTE_RULE_NAME_TAKEN_SQL, [tenantId, body.name, null]);
      if (taken.rowCount) {
        throw new ApiError("CONFLICT",
          `"${body.name}" is already a rule on this chart, at precedence ${taken.rows[0].precedence}. `
          + "Two rules that answer to one name cannot be told apart on the phone.", 409,
          [{ field: "name" }]);
      }
      let wrote: any;
      try {
        wrote = await c.query(INSERT_ROUTE_RULE_SQL, [
          tenantId, body.name, desk.id, lists.channels, lists.categories, lists.priorities,
          lists.languages, lists.regionIds, body.precedence, body.isActive,
          body.note ?? null, req.control.user_id]);
      } catch (err) {
        const refused = ruleRefusal(err, body.name);
        if (refused) throw refused;
        throw err;
      }
      const rule = wrote.rows[0];
      const sentence = ruleSentence(rule, desk.name, regionRows);
      await record(c, req, {
        userId: req.control.user_id, action: "department_updated",
        toLabel: desk.name, toDept: desk.id, entity: "support_ticket_routes", entityId: rule.id,
        after: { rule: rule.name, rule_id: rule.id, precedence: rule.precedence,
          narrows: sent },
        reason: body.reason,
        detail: { rule_created: sentence, predicates: words, switched_on: body.isActive }
      });
      return { ...rule, department_name: desk.name, narrows: sent, sentence, fired: 0,
        headroom: desk.max_open_tickets === null
          ? null : desk.max_open_tickets - desk.live_tickets };
    });
  });

  app.patch("/control/departments/routes/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-rules-write:uid:${req.control.user_id}`, 20, 300);
    const id = deptId(req.params.id, "That routing rule is not in the register.");
    const raw = (req.body ?? {}) as Record<string, any>;
    const body = RULE_PATCH.parse(raw);
    const touched = Object.keys(raw).filter((k) => k !== "reason");
    if (!touched.length) {
      throw new ApiError("VALIDATION_FAILED",
        "Say which part of the rule to change — its name, its desk, one of the five predicates, "
        + "its precedence, whether it is switched on, or its note.", 400, [{ field: "name" }]);
    }
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(ROUTE_RULE_SQL, [id, tenantId]);
      if (!was.rowCount) {
        throw new ApiError("NOT_FOUND", "That routing rule is not in the register.", 404);
      }
      const cur = was.rows[0];
      if (cur.deleted_at) {
        throw new ApiError("CONFLICT",
          `"${cur.name}" was retired and the register keeps a retired rule exactly as it fired, `
          + "so it cannot be edited. Write a new rule and name its precedence.", 409);
      }
      const merged = {
        channels: "channels" in raw ? uniq(body.channels) : uniq(cur.channels),
        categories: "categories" in raw ? uniq(body.categories) : uniq(cur.categories),
        priorities: "priorities" in raw ? uniq(body.priorities) : uniq(cur.priorities),
        languages: "languages" in raw ? uniq(body.languages) : uniq(cur.languages),
        regionIds: "regionIds" in raw ? uniq(body.regionIds) : uniq(cur.region_ids)
      };
      const { sent, words } = narrowing(merged);
      if (!sent.length) {
        throw new ApiError("VALIDATION_FAILED",
          `"${cur.name}" would then narrow on nothing and send every call on the platform to `
          + `${cur.department_name}. Keep at least one predicate, or retire the rule.`, 400,
          RULE_LISTS.map((k) => ({ field: k })));
      }
      const name = body.name ?? cur.name;
      const desk = await openDesk(c, body.departmentId ?? cur.department_id, tenantId);
      const regionRows = await readRegions(c, merged.regionIds);
      const taken = await c.query(ROUTE_RULE_NAME_TAKEN_SQL, [tenantId, name, id]);
      if (taken.rowCount) {
        throw new ApiError("CONFLICT",
          `Another rule is already called "${name}", at precedence ${taken.rows[0].precedence}.`,
          409, [{ field: "name" }]);
      }
      let wrote: any;
      try {
        wrote = await c.query(UPDATE_ROUTE_RULE_SQL, [
          id, tenantId, req.control.user_id,
          "name" in raw ? body.name : null,
          "departmentId" in raw ? body.departmentId : null,
          "channels" in raw ? merged.channels : null,
          "categories" in raw ? merged.categories : null,
          "priorities" in raw ? merged.priorities : null,
          "languages" in raw ? merged.languages : null,
          "regionIds" in raw ? merged.regionIds : null,
          "precedence" in raw ? body.precedence : null,
          "isActive" in raw ? body.isActive : null,
          "note" in raw, body.note ?? null]);
      } catch (err) {
        const refused = ruleRefusal(err, name);
        if (refused) throw refused;
        throw err;
      }
      if (!wrote.rowCount) {
        throw new ApiError("NOT_FOUND", "That routing rule is not in the register.", 404);
      }
      const rule = wrote.rows[0];
      const sentence = ruleSentence(rule, desk.name, regionRows);
      await record(c, req, {
        userId: req.control.user_id, action: "department_updated",
        toLabel: desk.name, toDept: desk.id, entity: "support_ticket_routes", entityId: id,
        before: ruleSnapshot(cur), after: { ...ruleSnapshot(rule), touched },
        reason: body.reason,
        detail: { rule: sentence, predicates: words }
      });
      return { ...rule, department_name: desk.name, narrows: sent, sentence,
        fired: cur.fired, changed: touched,
        headroom: desk.max_open_tickets === null
          ? null : desk.max_open_tickets - desk.live_tickets };
    });
  });

  /** One rule, retired or not. This is the read that answers "why did this land on Billing three
   *  months ago?" after the rule has been switched off — a register that can only show today's
   *  rules cannot explain yesterday's calls. Params: rule, tenant. */
  app.get("/control/departments/routes/:id", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireDeptRead(req);
    await enforceRateLimit(`dept-rules:uid:${req.control.user_id}`, 60, 60);
    const id = deptId(req.params.id, "That routing rule is not in the register.");
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const rows = await c.query(ROUTE_RULE_SQL, [id, tenantId]);
      if (!rows.rowCount) throw new ApiError("NOT_FOUND", "That routing rule is not in the register.", 404);
      const r = rows.rows[0];
      const regionRows = await readRegions(c, uniq(r.region_ids));
      return {
        ...r, can_manage: canManage, regions: regionRows,
        sentence: ruleSentence(r, r.department_name ?? "a desk no longer on the chart",
          regionRows),
        // The desk the rule names may have been filed away since it last fired; the matcher
        // requires an open desk, so the page has to be able to say that rather than imply the
        // rule is still taking work.
        desk_is_open: !r.desk_closed
      };
    });
  });

  /** Retiring is not deleting. The rule keeps its row so the routed lines already written can
   *  still be read back, and `is_active` goes false in the same breath so the matcher skips it. */
  app.post("/control/departments/routes/:id/retire", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-rules-write:uid:${req.control.user_id}`, 20, 300);
    const id = deptId(req.params.id, "That routing rule is not in the register.");
    const body = z.object({ reason: REASON }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const was = await c.query(ROUTE_RULE_SQL, [id, tenantId]);
      if (!was.rowCount) {
        throw new ApiError("NOT_FOUND", "That routing rule is not in the register.", 404);
      }
      const cur = was.rows[0];
      if (cur.deleted_at) {
        throw new ApiError("CONFLICT",
          `"${cur.name}" was already retired on ${String(cur.deleted_at).slice(0, 10)}.`, 409);
      }
      const retired = await c.query(RETIRE_ROUTE_RULE_SQL, [id, tenantId, req.control.user_id]);
      if (!retired.rowCount) {
        throw new ApiError("CONFLICT",
          `"${cur.name}" was retired while this was open.`, 409);
      }
      const regionRows = await readRegions(c, uniq(cur.region_ids));
      const sentence = ruleSentence(cur,
        cur.department_name ?? "a desk no longer on the chart", regionRows);
      await record(c, req, {
        userId: req.control.user_id, action: "department_updated",
        toLabel: cur.department_name, toDept: cur.department_id,
        entity: "support_ticket_routes", entityId: id,
        before: { ...ruleSnapshot(cur), retired: false },
        after: { ...ruleSnapshot(cur), retired: true, is_active: false,
          fired_so_far: cur.fired },
        reason: body.reason,
        detail: { rule_retired: sentence, fired_so_far: cur.fired }
      });
      return { id, retired: true, name: retired.rows[0].name, sentence,
        fired_so_far: cur.fired };
    });
  });

  /** What the matcher would do with a call shaped like this — nothing written, nothing logged.
   *  The desk needs this to debug a queue that "ignores" a rule it can see on the page, and the
   *  answer to that is almost always precedence, not the predicate lists. */
  app.post("/control/departments/routes/match", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireDeptRead(req);
    await enforceRateLimit(`dept-rules:uid:${req.control.user_id}`, 60, 60);
    const body = z.object({
      channel: z.enum(RULE_CHANNELS),
      category: z.enum(RULE_CATEGORIES),
      priority: z.enum(RULE_PRIORITIES),
      language: z.enum(RULE_LANGUAGES).optional().default("en"),
      regionId: z.number().int().min(1).max(100000).nullish(),
      companyId: z.string().uuid().nullish()
    }).strict().parse(req.body ?? {});
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const call = { channel: body.channel, category: body.category, priority: body.priority,
        language: body.language, regionId: body.regionId ?? null };
      let company: string | null = null;
      let regionName: string | null = null;
      let regionNote: string | null = null;
      if (body.companyId) {
        const who = await c.query(COMPANY_SQL, [body.companyId]);
        if (!who.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "That is not a live company on the platform, so its region cannot be read. Name a "
            + "region instead, or leave both out.", 400, [{ field: "companyId" }]);
        }
        company = who.rows[0].name;
        const hq = await c.query(COMPANY_HQ_REGION_SQL, [body.companyId]);
        if (hq.rowCount && hq.rows[0].region_id) {
          call.regionId = hq.rows[0].region_id;
          regionName = hq.rows[0].region_name;
        } else {
          // 123's own words: a company with no head office region matches a region rule not at
          // all, rather than as "any region". Saying so is the difference between a dry run the
          // desk trusts and one it has to double-check by hand.
          regionNote = `${company} has no head office region on file, so a rule that names `
            + "regions cannot match this call — the register treats it as no region at all.";
        }
      }

      const rules = await c.query(ROUTE_RULES_SQL, [tenantId]);
      const matched = (await c.query(ROUTE_MATCH_SQL, [tenantId, call.channel, call.category,
        call.priority, call.language, call.regionId])).rows[0]?.m ?? { status: "no_rule" };
      // The same test the definer runs, read out of the rules already in hand, so the desk can
      // see which rules fitted and lost on precedence instead of only the one that won.
      const fitting = rules.rows.filter((r: any) => r.is_active && ruleFits(r, call));
      const won = matched.status === "rule" ? matched : null;

      return {
        can_manage: canManage,
        call,
        company, region_name: regionName, region_note: regionNote,
        routed_to: won ? {
          rule_id: won.rule_id, rule_name: won.rule_name, precedence: won.precedence,
          department_id: won.department_id, department_key: won.department_key,
          department_name: won.department_name, open_tickets: won.open_tickets,
          max_open_tickets: won.max_open_tickets,
          headroom: won.max_open_tickets === null
            ? null : won.max_open_tickets - won.open_tickets
        } : null,
        rules_that_fit: fitting.map((r: any) => ({ id: r.id, name: r.name,
          precedence: r.precedence, department_name: r.department_name,
          won: won?.rule_id === r.id })),
        note: won
          ? `${won.rule_name} at precedence ${won.precedence} would take it. Asking where a `
            + "call goes does not log it — the register only routes a call somebody actually took."
          : "No live rule fits a call shaped like this, so it would sit in the queue until a "
            + "clerk points it at a desk. Nothing was written."
      };
    });
  });
}
