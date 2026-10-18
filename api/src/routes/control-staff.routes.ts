import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { sniffFileType } from "../util/upload.js";
import { uuidv7 } from "../util/uuid.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { controlHolds } from "./control-analytics.routes.js";
import {
  storageConfigured, putObject, signObject, StorageUnavailableError
} from "../storage/supabase.js";

/**
 * The platform's own desk: who holds which duty, what each of them has done, and the
 * picture next to the name (spec §8; task #103, on 067's read/write duty split).
 *
 * There is no SECURITY DEFINER in this file, deliberately. Every row it reads belongs
 * to the single platform tenant — the staff, their grants, their sessions, their own
 * trail, their avatars — so withTenant(platform) sees precisely the right set through
 * the policies that already exist, and a definer wrapper would only have widened the
 * surface. Cross-tenant aggregates are the ones that need a definer, and those live in
 * 066's analytics reader.
 *
 * The gates are the role_permissions matrix: 005 seeded control.staff.manage and no
 * route ever enforced it, so reading the roster required the right to rewrite it. 067
 * added control.staff.view for the seats whose duty is only to read.
 *
 * Every statement is exported and named. verify-control-staff-sql.ts runs these exact
 * strings as app_runtime under the platform tenant's RLS, because a script that
 * re-typed them would have been proving its own transcription.
 */

const VIEW = "control.staff.view";
const MANAGE = "control.staff.manage";

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
// A face in a table cell does not need the vault's 8 MB, and the panel does no resizing.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const DAYS = z.coerce.number().int().min(7).max(180).default(30);
const SEAT = z.string().uuid();

// ---------- statements ----------

/** A live platform seat inside this tenant. Params: user, tenant. */
export const SEAT_SQL = `
  select id, full_name, job_title, email, status, user_type, language, timezone,
         totp_enabled, last_login_at, created_at
    from users
   where id = $1 and tenant_id = $2 and deleted_at is null and user_type = 'platform'`;

/** The duties that count right now — a lapsed delegation is not a duty. Params: user. */
export const LIVE_ROLE_KEYS_SQL = `
  select r.key from user_roles ur
    join roles r on r.id = ur.role_id
   where ur.user_id = $1 and r.tenant_id is null and r.deleted_at is null
     and (ur.expires_at is null or ur.expires_at > now())`;

/**
 * How many seats can still administer the platform, and whether the target is one of
 * them. Params: tenant, target user.
 */
export const ADMIN_HELD_SQL = `
  select count(*)::int as total,
         (count(*) filter (where u.id = $2))::int as this_seat
    from users u
    join user_roles ur on ur.user_id = u.id
    join roles r on r.id = ur.role_id
                 and r.tenant_id is null and r.key = 'super_admin' and r.deleted_at is null
   where u.tenant_id = $1 and u.deleted_at is null and u.status = 'active'
     and (ur.expires_at is null or ur.expires_at > now())`;

/**
 * The roster. Params: tenant, name/email/title pattern, role key.
 *
 * The five lateral joins are aggregate subqueries — each returns exactly one row per
 * seat — except the avatar, which is a LEFT JOIN: a person with no picture is still on
 * the roster, and that is the one difference between this and an inner join that would
 * have silently dropped them.
 */
export const ROSTER_SQL = `
  select u.id as user_id, u.full_name, u.job_title, u.email, u.status,
         u.totp_enabled, u.last_login_at, u.created_at,
         coalesce(a.roles, '{}') as roles,
         coalesce(a.role_names, '{}') as role_names,
         pc.permission_count,
         w.events_30d, w.events_7d,
         coalesce(s.active_sessions, 0) as active_sessions,
         av.id as avatar_document_id
    from users u
    cross join lateral (
      select array_agg(r.key order by r.key) as roles,
             array_agg(r.name order by r.key) as role_names
        from user_roles ur
        join roles r on r.id = ur.role_id
       where ur.user_id = u.id and r.tenant_id is null and r.deleted_at is null
         and (ur.expires_at is null or ur.expires_at > now())
    ) a
    cross join lateral (
      select coalesce(count(distinct rp.permission_key), 0)::int as permission_count
        from user_roles ur
        join roles r on r.id = ur.role_id
        join role_permissions rp on rp.role_id = ur.role_id
       where ur.user_id = u.id and r.tenant_id is null and r.deleted_at is null
         and (ur.expires_at is null or ur.expires_at > now())
    ) pc
    cross join lateral (
      select (count(*) filter (where al.ts >= now() - interval '30 days'))::int as events_30d,
             (count(*) filter (where al.ts >= now() - interval '7 days'))::int as events_7d
        from audit_logs al
       where al.actor_user_id = u.id and al.tenant_id = u.tenant_id
    ) w
    cross join lateral (
      select count(*)::int as active_sessions
        from sessions ss
       where ss.user_id = u.id and ss.tenant_id = u.tenant_id
         and ss.revoked_at is null and ss.expires_at > now()
    ) s
    left join lateral (
      select d.id from documents d
       where d.tenant_id = u.tenant_id and d.entity_type = 'user' and d.entity_id = u.id
         and d.kind = 'avatar' and d.deleted_at is null
       order by d.created_at desc limit 1
    ) av on true
   where u.tenant_id = $1 and u.deleted_at is null and u.user_type = 'platform'
     and ($2::text is null or u.full_name ilike $2 or u.email ilike $2
          or coalesce(u.job_title, '') ilike $2)
     and ($3::text is null or $3 = any (a.roles))
   order by u.last_login_at desc nulls last,
            upper(coalesce(u.full_name, u.email, ''))`;

/**
 * What makes a global role a *platform duty*: it has to actually grant control-panel keys.
 * `roles` carries no scope column, and 17 of the 23 global rows are company templates —
 * offering `director` on this desk would hand one seat 207 keys over a company's own data.
 */
const IS_PLATFORM_DUTY = `
  exists (select 1 from role_permissions rp
           where rp.role_id = r.id and rp.permission_key like 'control.%')`;

/** The duty catalogue: what each platform role is actually allowed to do. Params: tenant. */
export const ROLE_CATALOG_SQL = `
  select r.key, r.name, r.is_system,
         (select count(*)::int from user_roles ur
            join users u on u.id = ur.user_id
           where ur.role_id = r.id and u.tenant_id = $1
             and u.user_type = 'platform' and u.deleted_at is null
             and (ur.expires_at is null or ur.expires_at > now())) as holders,
         coalesce((select jsonb_agg(jsonb_build_object(
                        'key', rp.permission_key, 'description', p.description)
                    order by rp.permission_key)
                     from role_permissions rp
                     left join permissions p on p.key = rp.permission_key
                    where rp.role_id = r.id), '[]') as permissions
    from roles r
   where r.tenant_id is null and r.deleted_at is null and ${IS_PLATFORM_DUTY}
   order by r.key`;

/** One seat's duties, with the keys each grants. Params: user. */
export const DUTIES_SQL = `
  select r.key, r.name, ur.granted_at, ur.expires_at,
         coalesce((select jsonb_agg(jsonb_build_object(
                        'key', rp.permission_key, 'description', p.description)
                    order by rp.permission_key)
                     from role_permissions rp
                     left join permissions p on p.key = rp.permission_key
                    where rp.role_id = r.id), '[]') as permissions
    from user_roles ur
    join roles r on r.id = ur.role_id
   where ur.user_id = $1 and r.tenant_id is null and r.deleted_at is null
     and (ur.expires_at is null or ur.expires_at > now())
   order by r.key`;

/**
 * Two windows, so "progress" is a comparison and not a bare count. The day buckets are
 * Dar es Salaam because Render runs UTC, and a chart that lands someone's Tuesday on
 * their Monday reads as laziness. Params: user, days, tenant.
 */
export const STATS_SQL = `
  select (count(*) filter (where al.ts >= now() - make_interval(days => $2::int)))::int as in_window,
         (count(*) filter (where al.ts >= now() - make_interval(days => $2::int * 2)
                             and al.ts <  now() - make_interval(days => $2::int)))::int as previous,
         (count(*) filter (where al.ts >= now() - interval '7 days'))::int as last_7,
         (count(distinct al.entity)
            filter (where al.ts >= now() - make_interval(days => $2::int)))::int as entities,
         (count(distinct (al.ts at time zone 'Africa/Dar_es_Salaam')::date)
            filter (where al.ts >= now() - make_interval(days => $2::int)))::int as days_active,
         max(al.ts) as last_event
    from audit_logs al
   where al.actor_user_id = $1 and al.tenant_id = $3`;

/** to_char, not a date column: a pg `date` arrives as a local-midnight Date and then
 *  serialises a day earlier in UTC. Params: user, days, tenant. */
export const WORKLOAD_SQL = `
  select to_char(gs.d, 'YYYY-MM-DD') as day, coalesce(x.events, 0)::int as events
    from (select generate_series(
            (now() at time zone 'Africa/Dar_es_Salaam')::date - ($2::int - 1),
            (now() at time zone 'Africa/Dar_es_Salaam')::date,
            '1 day')::date as d) gs
    left join (
      select (al.ts at time zone 'Africa/Dar_es_Salaam')::date as d, count(*)::int as events
        from audit_logs al
       where al.actor_user_id = $1 and al.tenant_id = $3
       group by 1
    ) x using (d)
   order by gs.d`;

/** Which duties this person actually performed, by volume. Params: user, tenant, days. */
export const DUTY_MIX_SQL = `
  select al.action, count(*)::int as events, max(al.ts) as last_seen
    from audit_logs al
   where al.actor_user_id = $1 and al.tenant_id = $2
     and al.ts >= now() - make_interval(days => $3::int)
   group by al.action
   order by count(*) desc, max(al.ts) desc
   limit 14`;

/**
 * The work log: action, subject, time — never the payload. Redacted payloads are the
 * forensic reader's job (066) and that asks for control.audit.view; a roster is not it.
 * Params: user, tenant.
 */
export const WORK_LOG_SQL = `
  select al.id, al.ts, al.action, al.actor_role, al.entity, al.entity_id, al.request_id
    from audit_logs al
   where al.actor_user_id = $1 and al.tenant_id = $2
   order by al.ts desc limit 40`;

/** Params: tenant, user. */
export const AVATAR_SQL = `
  select id, storage_path from documents
   where tenant_id = $1 and entity_type = 'user' and entity_id = $2
     and kind = 'avatar' and deleted_at is null
   order by created_at desc limit 1`;

/** Params: user, tenant. */
export const SESSIONS_SQL = `
  select count(*)::int as n from sessions
   where user_id = $1 and tenant_id = $2 and revoked_at is null and expires_at > now()`;

/** Params: wanted keys. */
export const KNOWN_PLATFORM_ROLES_SQL = `
  select key from roles r
   where r.tenant_id is null and r.deleted_at is null
     and r.key = any($1) and ${IS_PLATFORM_DUTY}`;

/** Only platform duties: a seat here has never held a tenant's own role. Params: user. */
export const ASSIGN_ROLES_DELETE_SQL = `
  delete from user_roles
   where user_id = $1
     and role_id in (select id from roles where tenant_id is null)`;

/** Params: user, granter, role key. */
export const ASSIGN_ROLE_INSERT_SQL = `
  insert into user_roles (user_id, role_id, granted_by)
  select $1, r.id, $2 from roles r
   where r.tenant_id is null and r.key = $3 and r.deleted_at is null`;

/** Params: user, jobTitle, fullName (null keeps the stored name), actor. */
export const UPDATE_SEAT_SQL = `
  update users
     set job_title = $2,
         full_name = coalesce($3, full_name),
         updated_at = now(), updated_by = $4
   where id = $1
  returning id, full_name, job_title`;

/** Params: user, status, actor. */
export const UPDATE_STATUS_SQL = `
  update users set status = $2, updated_at = now(), updated_by = $3 where id = $1`;

/**
 * get_control_session does not re-read status, so a suspended seat would keep signing
 * in on its old token until this runs. Params: user, tenant.
 */
export const REVOKE_SEAT_SESSIONS_SQL = `
  update sessions set revoked_at = now(), revoked_reason = 'control_staff_suspended'
   where user_id = $1 and tenant_id = $2 and revoked_at is null`;

/** Params: tenant, user, actor. Returns the rows this picture replaces. */
export const RETIRE_AVATAR_SQL = `
  update documents set deleted_at = now(), updated_by = $3
   where tenant_id = $1 and entity_type = 'user' and entity_id = $2
     and kind = 'avatar' and deleted_at is null
  returning id`;

/** Params: doc, tenant, user, fileName, mime, bytes, path, actor. */
export const INSERT_AVATAR_SQL = `
  insert into documents (id, tenant_id, entity_type, entity_id, kind,
    file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
  values ($1,$2,'user',$3,'avatar',$4,$5,$6,$7,$8,$8,$8)`;

// ---------- gates ----------

/** Reads accept either key; the boolean is whether this seat may also write. */
async function requireStaffRead(req: any): Promise<boolean> {
  const held = await controlHolds(req, [VIEW, MANAGE]);
  const canManage = held.includes(MANAGE);
  if (!canManage && !held.includes(VIEW)) {
    throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
  }
  return canManage;
}

async function requireStaffManage(req: any) {
  if (!(await controlHolds(req, [MANAGE])).includes(MANAGE)) {
    throw new ApiError("FORBIDDEN",
      "Reading the roster is one duty, changing it is another. Yours does not include it.", 403);
  }
}

function sanitize(name: string): string {
  const base = (name || "picture").split(/[\\/]/).pop() ?? "picture";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "picture";
}

async function seatRow(c: any, tenantId: string, id: string) {
  const r = await c.query(SEAT_SQL, [id, tenantId]);
  if (!r.rowCount) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
  return r.rows[0];
}

async function liveRoleKeys(c: any, userId: string): Promise<string[]> {
  const r = await c.query(LIVE_ROLE_KEYS_SQL, [userId]);
  return r.rows.map((x: any) => x.key as string);
}

/**
 * The panel that can demote a seat must not be able to empty itself of the one duty
 * that can put it back, so a write that would leave no active Super Admin is refused
 * before it commits. Judged against the state the write would produce: deactivating a
 * seat that is already suspended loses nothing, and refusing that would strand it.
 */
async function refuseIfLastAdmin(
  c: any, tenantId: string, targetId: string, next: { active: boolean; roles: string[] }
) {
  if (next.active && next.roles.includes("super_admin")) return;
  const r = await c.query(ADMIN_HELD_SQL, [tenantId, targetId]);
  if (r.rows[0].total === 1 && r.rows[0].this_seat === 1) {
    throw new ApiError("CONFLICT",
      "This is the only active Super Admin on the platform. Give the duty to another seat first.", 409);
  }
}

export async function controlStaffRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- the roster ----------
  app.get("/control/staff", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireStaffRead(req);
    const q = z.object({
      q: z.string().trim().max(120).optional(),
      role: z.string().trim().max(60).optional()
    }).parse(req.query ?? {});
    const rows = await withTenant(req.control.tenant_id, (c) => c.query(ROSTER_SQL, [
      req.control.tenant_id,
      q.q ? `%${q.q}%` : null,
      q.role || null
    ]));
    return {
      can_manage: canManage,
      staff: rows.rows,
      // What the desk holds in total, so the page can say "4 people, 31 duties between
      // them" without a second round trip.
      granted_permissions: rows.rows.reduce((n: number, r: any) => n + r.permission_count, 0)
    };
  });

  // ---------- the duty catalogue ----------
  app.get("/control/staff/roles", { preHandler: [requireControl] }, async (req: any) => {
    await requireStaffRead(req);
    const rows = await withTenant(req.control.tenant_id,
      (c) => c.query(ROLE_CATALOG_SQL, [req.control.tenant_id]));
    return { roles: rows.rows };
  });

  // ---------- one person's duty profile ----------
  app.get("/control/staff/:id", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireStaffRead(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    const { days } = z.object({ days: DAYS }).parse(req.query ?? {});
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const seat = await seatRow(c, tenantId, id.data);
      const duties = await c.query(DUTIES_SQL, [id.data]);
      const stats = await c.query(STATS_SQL, [id.data, days, tenantId]);
      const workload = await c.query(WORKLOAD_SQL, [id.data, days, tenantId]);
      const mix = await c.query(DUTY_MIX_SQL, [id.data, tenantId, days]);
      const log = await c.query(WORK_LOG_SQL, [id.data, tenantId]);
      const avatar = await c.query(AVATAR_SQL, [tenantId, id.data]);
      const sessions = await c.query(SESSIONS_SQL, [id.data, tenantId]);

      const st = stats.rows[0];
      const trend = st.previous > 0
        ? Math.round(((st.in_window - st.previous) / st.previous) * 1000) / 10
        : null;

      return {
        can_manage: canManage,
        is_self: seat.id === req.control.user_id,
        user_id: seat.id,
        full_name: seat.full_name,
        job_title: seat.job_title,
        email: seat.email,
        status: seat.status,
        language: seat.language,
        timezone: seat.timezone,
        totp_enabled: seat.totp_enabled,
        last_login_at: seat.last_login_at,
        created_at: seat.created_at,
        tenure_days: Math.max(0,
          Math.floor((Date.now() - new Date(seat.created_at).getTime()) / 86400000)),
        avatar_document_id: avatar.rows[0]?.id ?? null,
        duties: duties.rows,
        permission_keys: [...new Set(
          duties.rows.flatMap((d: any) => d.permissions.map((p: any) => p.key) as string[]))].sort(),
        stats: {
          window_days: days,
          events_in_window: st.in_window,
          events_previous_window: st.previous,
          events_last_7d: st.last_7,
          trend_pct: trend,
          entities_touched: st.entities,
          days_active: st.days_active,
          last_event_at: st.last_event,
          active_sessions: sessions.rows[0].n
        },
        workload: workload.rows,
        duty_mix: mix.rows,
        work_log: log.rows
      };
    });
  });

  // ---------- what the seat is called ----------
  app.patch("/control/staff/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireStaffManage(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    const body = z.object({
      jobTitle: z.string().trim().max(80).nullable(),
      fullName: z.string().trim().min(2).max(160).optional()
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const before = await seatRow(c, tenantId, id.data);
      const after = await c.query(UPDATE_SEAT_SQL,
        [id.data, body.jobTitle, body.fullName ?? null, req.control.user_id]);
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id,
        actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
        entity: "users", entityId: id.data, action: "control.staff.profile_updated",
        before: { full_name: before.full_name, job_title: before.job_title },
        after: { full_name: after.rows[0].full_name, job_title: after.rows[0].job_title }
      });
      return after.rows[0];
    });
  });

  // ---------- which duties the seat holds ----------
  app.post("/control/staff/:id/roles", { preHandler: [requireControl] }, async (req: any) => {
    await requireStaffManage(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    const body = z.object({
      roleKeys: z.array(z.string().trim().min(1).max(60)).max(20)
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    if (id.data === req.control.user_id) {
      throw new ApiError("FORBIDDEN",
        "A seat cannot re-write its own duties — that is how a platform loses its keys in one click.", 403);
    }

    return withTenant(tenantId, async (c) => {
      const seat = await seatRow(c, tenantId, id.data);
      const wanted = [...new Set(body.roleKeys)];
      if (wanted.length) {
        const known = await c.query(KNOWN_PLATFORM_ROLES_SQL, [wanted]);
        if (known.rowCount !== wanted.length) {
          throw new ApiError("VALIDATION_FAILED",
            "One of those duties is not a platform role.", 400, [{ field: "roleKeys" }]);
        }
      }
      const was = await liveRoleKeys(c, id.data);
      await refuseIfLastAdmin(c, tenantId, id.data,
        { active: seat.status === "active", roles: wanted });

      await c.query(ASSIGN_ROLES_DELETE_SQL, [id.data]);
      for (const key of wanted) {
        await c.query(ASSIGN_ROLE_INSERT_SQL, [id.data, req.control.user_id, key]);
      }
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id,
        actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
        entity: "users", entityId: id.data, action: "control.staff.roles_assigned",
        before: { roles: was }, after: { roles: wanted }
      });
      return { user_id: id.data, roles: wanted };
    });
  });

  // ---------- on the desk or off it ----------
  app.post("/control/staff/:id/status", { preHandler: [requireControl] }, async (req: any) => {
    await requireStaffManage(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    const body = z.object({
      status: z.enum(["active", "suspended", "deactivated"]),
      reason: z.string().trim().min(4).max(280)
    }).strict().parse(req.body);
    const tenantId = req.control.tenant_id;

    if (id.data === req.control.user_id) {
      throw new ApiError("FORBIDDEN",
        "You cannot put your own control session out of service from this desk.", 403);
    }

    return withTenant(tenantId, async (c) => {
      const seat = await seatRow(c, tenantId, id.data);
      const roles = await liveRoleKeys(c, id.data);
      await refuseIfLastAdmin(c, tenantId, id.data,
        { active: body.status === "active", roles });

      await c.query(UPDATE_STATUS_SQL, [id.data, body.status, req.control.user_id]);
      const revoked = body.status === "active"
        ? 0
        : (await c.query(REVOKE_SEAT_SESSIONS_SQL, [id.data, tenantId])).rowCount ?? 0;
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id,
        actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
        entity: "users", entityId: id.data, action: "control.staff.status_changed",
        before: { status: seat.status },
        after: { status: body.status, reason: body.reason, sessions_revoked: revoked }
      });
      return { user_id: id.data, status: body.status, sessions_revoked: revoked };
    });
  });

  // ---------- end their sessions (lost phone, suspicion, end of shift) ----------
  app.post("/control/staff/:id/sessions/revoke", { preHandler: [requireControl] }, async (req: any) => {
    // One click ends every session a seat holds. A scripted or bored control seat must not
    // be able to sweep the roster, so the door is capped per signer, not per IP.
    await enforceRateLimit(`control-revoke:uid:${req.control.user_id}`, 20, 300);
    await requireStaffManage(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      await seatRow(c, tenantId, id.data);
      const r = await c.query(
        `update sessions set revoked_at = now(), revoked_reason = 'control_admin_revoke'
          where user_id = $1 and tenant_id = $2 and revoked_at is null`,
        [id.data, tenantId]);
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id,
        actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
        entity: "sessions", entityId: id.data, action: "control.staff.sessions_revoked",
        after: { count: r.rowCount ?? 0 }
      });
      return { revoked: r.rowCount ?? 0 };
    });
  });

  // ---------- the picture ----------
  app.get("/control/staff/:id/avatar", { preHandler: [requireControl] }, async (req: any) => {
    await requireStaffRead(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    if (!storageConfigured()) {
      throw new ApiError("STORAGE_UNAVAILABLE",
        "Pictures are not configured yet — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);
    }
    const row = await withTenant(req.control.tenant_id,
      (c) => c.query(AVATAR_SQL, [req.control.tenant_id, id.data]));
    if (!row.rowCount) throw new ApiError("NOT_FOUND", "No picture on file.", 404);
    try {
      return { id: row.rows[0].id, url: await signObject(row.rows[0].storage_path, 900) };
    } catch (e) {
      req.log.error(e, "storage sign failed (control avatar)");
      throw new ApiError("INTERNAL", "Could not open the file.", 502);
    }
  });

  // Written into the platform tenant like any other avatar, so the vault's single
  // upload path and its entity_type 'user' check cover it — no schema widening needed.
  app.post("/control/staff/:id/avatar", { preHandler: [requireControl] }, async (req: any) => {
    await requireStaffManage(req);
    const id = SEAT.safeParse(req.params.id);
    if (!id.success) throw new ApiError("NOT_FOUND", "That platform seat does not exist.", 404);
    if (!storageConfigured()) {
      throw new ApiError("STORAGE_UNAVAILABLE",
        "Uploads are not configured yet — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);
    }
    await enforceRateLimit(`control-avatar:uid:${req.control.user_id}`, 30, 3600);

    const data = await req.file();
    if (!data) throw new ApiError("VALIDATION_FAILED", "Attach a picture to upload.", 400, [{ field: "file" }]);
    const bytes = await data.toBuffer();
    if (bytes.length === 0) throw new ApiError("VALIDATION_FAILED", "The file is empty.", 400);
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw new ApiError("VALIDATION_FAILED", "Pictures are limited to 2 MB.", 400, [{ field: "file" }]);
    }
    const mime = (data.mimetype || "").toLowerCase();
    if (!IMAGE_MIMES.includes(mime) || sniffFileType(bytes) !== mime) {
      throw new ApiError("VALIDATION_FAILED",
        "A picture must be a real JPEG, PNG or WebP file.", 400, [{ field: "file" }]);
    }

    const tenantId = req.control.tenant_id;
    const docId = uuidv7();
    const path = `${tenantId}/user/${id.data}/${docId}-${sanitize(data.filename)}`;
    try {
      await putObject(path, bytes, mime);
    } catch (e) {
      if (e instanceof StorageUnavailableError) throw e;
      req.log.error(e, "storage upload failed (control avatar)");
      throw new ApiError("INTERNAL", "The file could not be stored. Try again.", 502);
    }

    return withTenant(tenantId, async (c) => {
      await seatRow(c, tenantId, id.data);
      const prev = await c.query(RETIRE_AVATAR_SQL, [tenantId, id.data, req.control.user_id]);
      await c.query(INSERT_AVATAR_SQL, [docId, tenantId, id.data, sanitize(data.filename),
        mime, bytes.length, path, req.control.user_id]);
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id,
        actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
        entity: "documents", entityId: docId, action: "control.staff.avatar_updated",
        after: { userId: id.data, sizeBytes: bytes.length, replaced: prev.rowCount ?? 0 }
      });
      return { id: docId, replaced: prev.rowCount ?? 0, size_bytes: bytes.length };
    });
  });
}
