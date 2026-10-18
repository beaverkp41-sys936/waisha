import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { requireControl } from "./control.routes.js";
import { controlHolds } from "./control-analytics.routes.js";

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
 */

const VIEW = "control.departments.view";
const MANAGE = "control.departments.manage";

/** The live predicate, written once because seven statements have to agree on it. */
const LIVE = `m.released_at is null and (m.ends_at is null or m.ends_at > now())`;

const DAYS = z.coerce.number().int().min(1).max(365).default(30);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
const REASON = z.string().trim().min(4).max(300);

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
 */
export const DEPARTMENTS_SQL = `
  select d.id, d.key, d.name, d.purpose, d.sort, d.is_active,
         d.head_user_id, h.full_name as head_name,
         coalesce(s.seat_count, 0)::int as seat_count,
         coalesce(s.live_covers, 0)::int as live_covers,
         coalesce(s.seats, '[]'::jsonb) as seats
    from platform_departments d
    left join users h on h.id = d.head_user_id
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

/** An open department. Params: department, tenant. */
export const DEPARTMENT_SQL = `
  select d.id, d.key, d.name, d.purpose, d.sort, d.is_active, d.head_user_id,
         h.full_name as head_name,
         (select count(*)::int from platform_seat_departments m
           where m.department_id = d.id and ${LIVE}) as live_seats
    from platform_departments d
    left join users h on h.id = d.head_user_id
   where d.id = $1 and d.tenant_id = $2 and d.deleted_at is null`;

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

function deptId(value: unknown): string {
  const parsed = z.string().uuid().safeParse(String(value ?? ""));
  if (!parsed.success) throw new ApiError("NOT_FOUND", "That is not on this desk.", 404);
  return parsed.data;
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

  // ---------- close a desk, with somewhere for its people to go ----------
  app.post("/control/departments/:id/close", { preHandler: [requireControl] }, async (req: any) => {
    await requireDeptManage(req);
    await enforceRateLimit(`dept-write:uid:${req.control.user_id}`, 40, 300);
    const id = deptId(req.params.id);
    const body = z.object({ reason: REASON, moveTo: z.string().uuid().nullish() })
      .strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const found = await c.query(DEPARTMENT_SQL, [id, tenantId]);
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      const d = found.rows[0];
      const seats = await c.query(DEPT_LIVE_SEATS_SQL, [id]);
      let moved = 0;

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
      const closed = await c.query(CLOSE_DEPARTMENT_SQL, [id, tenantId, req.control.user_id]);
      if (!closed.rowCount) throw new ApiError("NOT_FOUND", "That department does not exist.", 404);
      await record(c, req, {
        userId: req.control.user_id, action: "department_closed",
        fromLabel: d.name, fromDept: id, entity: "platform_departments", entityId: id,
        before: { is_active: true, seats: d.live_seats },
        after: { is_active: false, seats_released: released.rowCount ?? 0, seats_moved: moved },
        reason: body.reason
      });
      return { id, closed: true, seats_released: released.rowCount ?? 0, seats_moved: moved };
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
}
