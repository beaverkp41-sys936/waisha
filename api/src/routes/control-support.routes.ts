import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { sha256, randomToken } from "../util/crypto.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { issueAccessToken, verifyAccessToken } from "../security/jwt.js";
import type { AccessClaims } from "../security/jwt.js";
import { rolesArePortalOnly } from "../security/audience.js";
import { SUPPORT_WINDOW_MINUTES } from "../security/support.js";
import { requireControl } from "./control.routes.js";
import { controlCan } from "./control-analytics.routes.js";

/**
 * Seeing the platform through a company's eyes (task #177).
 *
 * The ask was a hidden mode: an admin logs in as a tenant, everything looks like what the
 * tenant sees, and inside that view there is a way back to the admin view. "Hidden" is the
 * part this file refuses. A session that crosses the tenant wall quietly is the bug 099
 * just spent a migration closing — one more claim nobody checks, one more surface that
 * ships open. So the mode is loud instead: it is entered from one desk button, it is named
 * by a banner on every page it touches, it says how long it lasts, and leaving is a button
 * rather than a tab close. The admin gives up nothing by that trade; a company that is
 * being looked at, and the audit trail that says so, gain everything.
 *
 * What a support session IS: a real `sessions` row for a real seat inside the company, with
 * `actor_user_id` pointing at the platform person holding it (106). The token carries that
 * person's roles, so permission checks answer as they would for them — that is the view
 * being borrowed, not a hole in it. Two things keep it from becoming their account:
 *
 *  - the global read-only guard (security/support.ts) refuses every write it attempts;
 *  - it has no refresh token. The row stores the hash of a value handed to nobody, and
 *    `rotate_refresh` refuses a borrowed row anyway, so the visit ends when the window
 *    does and cannot be silently extended by a client that keeps asking.
 *
 * The second half of the reason a refresh is impossible is a browser detail: the portal
 * client renews through a `waisha_refresh` cookie that belongs to the whole origin, not to
 * this tab. If an admin's own portal seat is live in another tab, the support view's
 * refresh call would present that cookie and get back a token for the admin — quietly
 * un-borrowing the seat, banner and guard included. Opening a support view therefore clears
 * that cookie on the way out. The control cookie is a different path and stays: it is what
 * the switch-back button runs on.
 */

const IMPERSONATE = "control.impersonate";

/** A tenant type is not a desk. The platform's own book and the seeker marketplace are
 *  somebody else's product, and a "see it as them" aimed at them would borrow a seat that
 *  does not sit at the staff surface at all. */
const BORROWABLE = new Set(["transporter", "shipper"]);

/** Params: tenant, optional explicit seat. Directors first: the fullest view a company has,
 *  which is the one that answers "this is what I see" on a support call. */
export const SUBJECT_SQL = `
  select u.id, u.full_name, u.email, u.user_type,
         coalesce((select array_agg(r.key)
                     from user_roles ur join roles r on r.id = ur.role_id
                    where ur.user_id = u.id
                      and (ur.expires_at is null or ur.expires_at > now())), '{}') as roles
    from users u
   where u.tenant_id = $1 and u.deleted_at is null and u.status = 'active'
     and ($2::uuid is null or u.id = $2)
   order by (u.user_type = 'director') desc, u.created_at asc
   limit 40`;

export const TENANT_SQL = "select id, name, type, status, deleted_at from tenants where id = $1";

/** Params: session, actor. A borrowed seat is only ever closed by the person who borrowed
 *  it — that predicate is the whole of the authorisation, which is why it is in the WHERE
 *  clause and not in a check that happens to run first. */
export const CLOSE_SQL = `
  update sessions set revoked_at = now(), revoked_reason = 'support_closed'
   where id = $1 and actor_user_id = $2 and revoked_at is null
  returning user_id, tenant_id, expires_at`;
export const FIND_SQL = `
  select s.id, s.user_id, s.tenant_id, s.created_at, s.expires_at, s.revoked_at,
         u.full_name as subject_name, t.name as tenant_name
    from sessions s
    join users u on u.id = s.user_id
    join tenants t on t.id = s.tenant_id
   where s.id = $1 and s.actor_user_id = $2`;
export const MINE_SQL = `
  select s.id, s.created_at, s.expires_at, s.user_id, u.full_name as subject_name,
         s.tenant_id, t.name as tenant_name
    from sessions s
    join users u on u.id = s.user_id
    join tenants t on t.id = s.tenant_id
   where s.actor_user_id = $1 and s.revoked_at is null and s.expires_at > now()
   order by s.created_at desc
   limit 20`;

const openBody = z.object({
  tenantId: z.string().uuid(),
  // Which seat to wear. Optional: the default is the company's director, and an operator
  // who needs a narrower view (a clerk who cannot see payroll) names the seat on the call.
  asUserId: z.string().uuid().optional()
}).strict();

/** The same three lines every route file in this API carries. */
const requireStaffSeat = async (req: any) => {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
};

async function auditBothBooks(
  req: any, viewedTenantId: string, adminId: string,
  adminRole: string | null, action: string, sessionId: string, detail: Record<string, unknown>
) {
  const ip = req.ip ?? null;
  const userAgent = req.headers["user-agent"] ?? null;
  // The company's own book, so the visit is in the record of the company that was visited.
  await withTenant(viewedTenantId, (c) => writeAudit(c, {
    tenantId: viewedTenantId, actorUserId: adminId, actorRole: adminRole,
    ip, userAgent, requestId: req.requestId,
    entity: "sessions", entityId: sessionId, action, after: detail
  }));
  // And the platform's, because a roster counts one person's work by their own tenant
  // (control-staff.routes.ts) and a support visit that never reached that line is a
  // day's work an admin performed invisibly.
  await withTenant((req.control as any).tenant_id, (c) => writeAudit(c, {
    tenantId: (req.control as any).tenant_id, actorUserId: adminId, actorRole: adminRole,
    ip, userAgent, requestId: req.requestId,
    entity: "sessions", entityId: sessionId, action,
    after: { ...detail, tenant_id: viewedTenantId }
  }));
}

export async function controlSupportRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- borrow a company's seat ----------
  app.post("/control/support/sessions", { preHandler: [requireControl] }, async (req: any, reply: FastifyReply) => {
    if (!(await controlCan(req, IMPERSONATE))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    await enforceRateLimit(`support-open:uid:${req.control.user_id}`, 10, 900);
    const body = openBody.parse(req.body);

    const t = await pool.query(TENANT_SQL, [body.tenantId]);
    const tenant = t.rows[0];
    if (!tenant) throw new ApiError("NOT_FOUND", "No company account here.", 404);
    if (!BORROWABLE.has(tenant.type)) {
      throw new ApiError("VALIDATION_FAILED", "Only company desks can be viewed this way.", 400);
    }
    if (tenant.deleted_at || tenant.status === "suspended") {
      throw new ApiError("CONFLICT", "A blocked or closed company has no view to borrow.", 409);
    }

    const s = await pool.query(SUBJECT_SQL, [tenant.id, body.asUserId ?? null]);
    // A shipper or a seeker seat cannot reach the staff surface at all (audience.ts), so
    // borrowing one would mint a session whose own view is empty, and the operator would
    // read that as the company having nothing to show.
    const candidates = s.rows.filter((r: any) => !rolesArePortalOnly(r.roles));
    if (body.asUserId && !candidates.length) {
      throw new ApiError("NOT_FOUND", "That seat is not an active staff account in this company.", 404);
    }
    if (!candidates.length) {
      throw new ApiError("CONFLICT", "This company has no staff seat to view.", 409);
    }
    const subject = candidates[0];
    const roles: string[] = subject.roles ?? [];

    const sid = uuidv7();
    const expiresAt = new Date(Date.now() + SUPPORT_WINDOW_MINUTES * 60_000);
    const adminId: string = req.control.user_id;
    const adminRole: string | null = (req.control.roles ?? [])[0] ?? null;

    await withTenant(tenant.id, async (c) => {
      await c.query(
        `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
           refresh_token_hash, user_agent, ip, expires_at, actor_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sid, subject.id, tenant.id, sid, expiresAt, sha256(randomToken(32)),
         req.headers["user-agent"] ?? null, req.ip ?? null, expiresAt, adminId]
      );
    });

    await auditBothBooks(req, tenant.id, adminId, adminRole,
      "support.session.opened", sid, {
        subject_user_id: subject.id,
        subject_name: subject.full_name,
        window_minutes: SUPPORT_WINDOW_MINUTES,
        read_only: true
      });

    const accessToken = await issueAccessToken(
      { sub: subject.id, tid: tenant.id, sid, typ: roles[0] ?? "staff", roles, act: adminId },
      `${SUPPORT_WINDOW_MINUTES}m`
    );

    // One identity per tab while the view is borrowed. See the header note: leaving this
    // cookie in place would let the portal client refresh out of the borrowed seat.
    reply.clearCookie("waisha_refresh", { path: "/api/v1/auth" });
    return reply.send({
      accessToken,
      sessionId: sid,
      expiresAt,
      tenant: { id: tenant.id, name: tenant.name },
      seat: { id: subject.id, name: subject.full_name ?? subject.email, duties: roles }
    });
  });

  // ---------- what is borrowed right now ----------
  app.get("/control/support/sessions", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, IMPERSONATE))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    const r = await pool.query(MINE_SQL, [req.control.user_id]);
    return { sessions: r.rows };
  });

  // ---------- give it back ----------
  app.post("/control/support/sessions/:id/close", { preHandler: [requireControl] }, async (req: any, reply: FastifyReply) => {
    if (!(await controlCan(req, IMPERSONATE))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      throw new ApiError("VALIDATION_FAILED", "That is not a session.", 400, [{ field: "id" }]);
    }
    const adminId: string = req.control.user_id;
    const adminRole: string | null = (req.control.roles ?? [])[0] ?? null;

    const found = await pool.query(FIND_SQL, [id, adminId]);
    const row = found.rows[0];
    if (!row) throw new ApiError("NOT_FOUND", "No support view of yours is open there.", 404);
    if (row.revoked_at) return reply.send({ ok: true, alreadyClosed: true });

    const r = await pool.query(CLOSE_SQL, [id, adminId]);
    const closed = r.rows[0];
    if (!closed) throw new ApiError("CONFLICT", "That support view has already ended.", 409);

    await auditBothBooks(req, row.tenant_id, adminId, adminRole,
      "support.session.closed", id, {
        subject_user_id: row.user_id,
        subject_name: row.subject_name,
        reason: "switched_back"
      });
    return reply.send({ ok: true, tenantId: row.tenant_id });
  });

  // ---------- the banner's own read ----------
  // The view asks "am I borrowed, and by whom" on every mount. It cannot answer that from
  // the token it already has: the banner has to name the company and the seat, and a page
  // that guesses those from its own local state is a banner that lies about a tenant.
  app.get("/support/session", { preHandler: [requireStaffSeat] }, async (req: any) => {
    const claims: AccessClaims = req.user;
    if (!claims.act) return { borrowed: false };
    const r = await withTenant(claims.tid, (c) => c.query(
      `select s.id, s.created_at, s.expires_at, s.revoked_at,
              a.full_name as actor_name, a.email as actor_email,
              u.full_name as seat_name, u.user_type as seat_type,
              t.name as tenant_name
         from sessions s
         join users a on a.id = s.actor_user_id
         join users u on u.id = s.user_id
         join tenants t on t.id = s.tenant_id
        where s.id = $1 and s.tenant_id = $2 and s.user_id = $3 and s.actor_user_id = $4`,
      [claims.sid, claims.tid, claims.sub, claims.act]));
    const row = r.rows[0];
    // A borrowed token whose row is gone — closed, revoked, or swept by a block — says so
    // rather than showing a banner with no subject. The row is kept by an id nobody else can
    // guess, so a read that finds it revoked is this same visit after it was handed back: the
    // view is over either way, and the next thing the page does is hit the read-only wall or
    // expire.
    if (!row || row.revoked_at) return { borrowed: true, ended: true };
    return {
      borrowed: true,
      sessionId: row.id,
      openedAt: row.created_at,
      expiresAt: row.expires_at,
      actorName: row.actor_name ?? "Platform support",
      actorEmail: row.actor_email,
      tenantName: row.tenant_name,
      seatName: row.seat_name ?? row.seat_type,
      seatType: row.seat_type,
      windowMinutes: SUPPORT_WINDOW_MINUTES
    };
  });
}
