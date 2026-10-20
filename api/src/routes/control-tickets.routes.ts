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
 */

const VIEW = "control.tickets.view";
const MANAGE = "control.tickets.manage";

const CHANNELS = ["phone_call", "whatsapp", "email", "walk_in", "portal_message", "other"] as const;
const CATEGORIES = ["onboarding", "account_access", "licence_billing", "cargo_clearing",
  "transport_fleet", "marketplace_directory", "system_error", "complaint", "other"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const STATUSES = ["open", "allocated", "in_progress", "resolved", "closed"] as const;
const ACTIONS = ["logged", "allocated", "reallocated", "status_changed", "priority_changed",
  "note_added", "resolved", "reopened", "closed", "withdrawn"] as const;

/** The moves the desk is allowed to ask for. Anything else is refused in words, because
 *  "resolved → allocated" has no meaning anybody could defend out loud. */
const TO_WORK = ["allocated", "in_progress"] as const;

const REASON = z.string().trim().min(4).max(300);
const DAYS = z.coerce.number().int().min(1).max(365).default(60);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);

// ---------- statements ----------

/**
 * Log an incidence and mint its reference in one statement.
 *
 * The number comes from the global sequence, not from a count of rows: it is quoted over the
 * phone by somebody in another office, so two companies having a "ticket 7" is worse than
 * useless. nextval is atomic, the year prefix is cosmetic, and `ref` is unique anyway (101).
 *
 * Params: tenant, reporter, email, phone(enc|null), phone(search|null), channel,
 *         company tenant|null, company name, category, subject, body, priority,
 *         department|null, actor.
 */
export const INSERT_TICKET_SQL = `
  insert into support_tickets
    (tenant_id, ref, reporter_name, reporter_email, reporter_phone_encrypted,
     reporter_phone_search, channel, company_tenant_id, company_name, category,
     subject, body, priority, status, department_id, allocated_by, allocated_at, created_by)
  select $1,
         'CS-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('support_ticket_number_seq')::text, 5, '0'),
         $2, nullif($3, ''), $4::bytea, nullif($5, ''), $6, $7, $8, $9, $10, $11, $12,
         case when $13::uuid is null then 'open' else 'allocated' end,
         $13, case when $13::uuid is null then null else $14::uuid end,
         case when $13::uuid is null then null else now() end,
         $14
  returning id, ref, ts, status, department_id, priority`;

/**
 * The queue. `reporter_phone_encrypted` is not in this column list at all — a list endpoint
 * that could show a number is a list endpoint that will.
 *
 * Params: tenant, statuses[], department|null, departmentIds[]|null (the `mine` scope),
 *         category|null, priority|null, pattern|null, phoneHash|null, company|null,
 *         days, limit, offset.
 */
export const TICKETS_SQL = `
  select t.id, t.ref, t.ts, t.updated_at, t.reporter_name, t.reporter_email,
         t.channel, t.category, t.subject, t.priority, t.status,
         t.company_tenant_id, t.company_name, t.department_id, d.name as department_name,
         (t.reporter_phone_encrypted is not null) as has_phone,
         t.allocated_at, t.resolved_at,
         a.full_name as allocated_by_name,
         (select count(*)::int from support_ticket_events e where e.ticket_id = t.id) as events,
         (select e.ts from support_ticket_events e where e.ticket_id = t.id
           order by e.ts desc, e.id desc limit 1) as last_activity
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
    left join users a on a.id = t.allocated_by and a.tenant_id = t.tenant_id
   where t.tenant_id = $1 and t.deleted_at is null
     and ($2::text[] is null or t.status = any($2))
     and ($3::uuid is null or t.department_id = $3)
     and ($4::uuid[] is null or t.department_id = any($4))
     and ($5::text is null or t.category = $5)
     and ($6::text is null or t.priority = $6)
     and ($7::text is null or t.ref ilike $7 or t.subject ilike $7
                        or t.body ilike $7 or t.company_name ilike $7
                        or t.reporter_name ilike $7)
     and ($8::text is null or t.reporter_phone_search = $8)
     and ($9::uuid is null or t.company_tenant_id = $9)
     and t.ts >= now() - make_interval(days => $10::int)
   order by (t.priority = 'urgent') desc,
            (t.status in ('open','allocated','in_progress')) desc,
            t.ts desc
   limit $11 offset $12`;

/** The same filter without the cap, so the header and the rows cannot disagree. */
export const TICKETS_COUNT_SQL = `
  select count(*)::int as n,
         count(*) filter (where t.status = 'open')::int as unallocated,
         count(*) filter (where t.status in ('allocated','in_progress'))::int as working,
         count(*) filter (where t.status in ('resolved','closed'))::int as settled,
         count(*) filter (where t.priority in ('high','urgent')
                          and t.status in ('open','allocated','in_progress'))::int as pressing
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null
     and ($2::text[] is null or t.status = any($2))
     and ($3::uuid is null or t.department_id = $3)
     and ($4::uuid[] is null or t.department_id = any($4))
     and ($5::text is null or t.category = $5)
     and ($6::text is null or t.priority = $6)
     and ($7::text is null or t.ref ilike $7 or t.subject ilike $7
                        or t.body ilike $7 or t.company_name ilike $7
                        or t.reporter_name ilike $7)
     and ($8::text is null or t.reporter_phone_search = $8)
     and ($9::uuid is null or t.company_tenant_id = $9)
     and t.ts >= now() - make_interval(days => $10::int)`;

/** One incidence, this tenant's only, with the encrypted column for the detail read.
 *  Params: id, tenant. */
export const TICKET_SQL = `
  select t.id, t.ref, t.ts, t.updated_at, t.reporter_name, t.reporter_email,
         t.reporter_phone_encrypted, t.channel, t.category, t.subject, t.body,
         t.priority, t.status, t.company_tenant_id, t.company_name, t.department_id,
         d.name as department_name, d.key as department_key,
         t.allocated_at, t.resolved_at, t.resolution,
         a.full_name as allocated_by_name,
         r.full_name as resolved_by_name,
         c.full_name as created_by_name
    from support_tickets t
    left join platform_departments d on d.id = t.department_id
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

/** Hand it over, or send it back to the pool. Params: id, tenant, department|null, actor,
 *  status.
 *  Clearing the department also clears the allocation: 101's CHECK says a ticket with an
 *  allocated_at must have somebody to point at, and "back in the queue" means nobody has it. */
export const ALLOCATE_SQL = `
  update support_tickets
     set department_id = $3,
         status = case when $3::uuid is null then 'open' else 'allocated' end,
         allocated_by = case when $3::uuid is null then null else $4::uuid end,
         allocated_at = case when $3::uuid is null then null else now() end,
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, ref, status, department_id, allocated_at, updated_at`;

/** Start or restart work on an incidence a department already holds. Who did it is the
 *  event's business, not the row's — the row only has room for who allocated and who settled.
 *  Params: id, tenant, status. */
export const WORK_SQL = `
  update support_tickets
     set status = $3, updated_at = now(),
         resolved_at = null, resolved_by = null
   where id = $1 and tenant_id = $2 and deleted_at is null
     and department_id is not null
   returning id, ref, status, resolved_at, updated_at`;

/** Settle it. Params: id, tenant, outcome, resolution, actor. */
export const RESOLVE_SQL = `
  update support_tickets
     set status = $3, resolution = $4, resolved_by = $5, resolved_at = now(),
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and department_id is not null
   returning id, ref, status, resolution, resolved_at, updated_at`;

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
 *  to feed. Params: tenant. */
export const DEPARTMENT_LOAD_SQL = `
  select d.id, d.key, d.name, d.sort,
         coalesce(count(t.id) filter (where t.status = 'open'), 0)::int as unallocated,
         coalesce(count(t.id) filter (where t.status in ('allocated','in_progress')), 0)::int as working,
         coalesce(count(t.id) filter (where t.status in ('allocated','in_progress')
                                      and t.priority in ('high','urgent')), 0)::int as pressing,
         coalesce(count(t.id) filter (where t.status in ('resolved','closed')), 0)::int as settled,
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

/** An open department, for the picker and for the guard on every handover. Named apart from
 *  084's DEPARTMENT_SQL because that one carries heads and seat counts, and the register only
 *  needs to know the desk exists. Params: department, tenant. */
export const OPEN_DEPARTMENT_SQL = `
  select d.id, d.key, d.name
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
        q.phone ? phoneSearchTerm(q.phone) : null, q.company ?? null, q.days
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
          phone_searched: !!q.phone, company: q.company ?? null
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
      let dept: { id: string; name: string } | null = null;
      if (body.departmentId) {
        const d = await c.query(OPEN_DEPARTMENT_SQL, [body.departmentId, tenantId]);
        if (!d.rowCount) {
          throw new ApiError("VALIDATION_FAILED",
            "That department is not an open desk on the platform chart.", 400,
            [{ field: "departmentId" }]);
        }
        dept = d.rows[0];
      }

      const made = await c.query(INSERT_TICKET_SQL, [
        tenantId, body.reporterName, body.reporterEmail ?? "",
        body.reporterPhone ? encryptField(body.reporterPhone) : null,
        body.reporterPhone ? searchHash(body.reporterPhone) : "",
        body.channel, body.companyTenantId ?? null, company, body.category,
        body.subject, body.body, body.priority, dept?.id ?? null, req.control.user_id
      ]);
      const ticket = made.rows[0];

      await record(c, req, {
        ticket, action: "logged",
        toLabel: body.subject, deptTo: dept?.id ?? null,
        reason: body.reason ?? `Called in about: ${body.subject}.`,
        detail: {
          channel: body.channel, category: body.category, priority: body.priority,
          company, reporter: body.reporterName,
          callback_on_file: !!body.reporterPhone
        }
      });
      if (dept) {
        await record(c, req, {
          ticket, action: "allocated", toLabel: dept.name, deptTo: dept.id,
          reason: `Logged straight to ${dept.name}. ${body.reason ?? body.subject}.`
        });
      }
      return reply.code(201).send({ ...ticket, company_name: company, allocated_to: dept?.name ?? null });
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
        events: events.rows
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
      let to: { id: string; name: string } | null = null;
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
      } else if (!before.department_id) {
        throw new ApiError("CONFLICT",
          `${before.ref} is already in the unallocated queue — nobody holds it. Say which `
          + "department should.", 409, [{ field: "departmentId" }]);
      }
      const moved = await c.query(ALLOCATE_SQL, [id, tenantId, to?.id ?? null, req.control.user_id]);
      if (!moved.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);

      const action = to ? (before.department_id ? "reallocated" : "allocated") : "reallocated";
      await record(c, req, {
        ticket: { id, ref: before.ref }, action,
        fromLabel: before.department_name, toLabel: to?.name ?? "the unallocated queue",
        deptFrom: before.department_id, deptTo: to?.id ?? null,
        reason: body.reason,
        detail: { from_status: before.status, to_status: moved.rows[0].status }
      });
      return { ...moved.rows[0], department_name: to?.name ?? null };
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
      const moved = await c.query(WORK_SQL, [id, tenantId, body.status]);
      if (!moved.rowCount) throw new ApiError("NOT_FOUND", "That incidence is not in the register.", 404);

      await record(c, req, {
        ticket: { id, ref: before.ref },
        action: settled ? "reopened" : "status_changed",
        fromLabel: before.status, toLabel: moved.rows[0].status,
        deptFrom: before.department_id, deptTo: before.department_id,
        reason: body.reason,
        detail: settled ? {
          reopened_from: before.status, previous_resolution: before.resolution
        } : {}
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
      return { id: t.id, ts: t.ts, ref: found.rows[0].ref };
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
