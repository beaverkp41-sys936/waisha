import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { decryptField } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { maskPhone } from "../security/otp.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

/**
 * The meter in 061 refuses with a jsonb reason rather than raising, so each refusal
 * has exactly one translation here instead of a different guess per route. The codes
 * are the client's branch points: PENDING_VERIFICATION and FREE_SEARCH_NOT_READY are
 * recoverable on their own, so the UI can act on them without parsing a sentence, and
 * `details[0]` carries the machine fields (resetsAt, remaining) the definer returned.
 */
export function meterRefusal(res: any): ApiError | null {
  if (!res || res.ok) return null;
  const extra = {
    ...(res.pass_id ? { passId: res.pass_id } : {}),
    ...(res.status ? { status: res.status } : {}),
    ...(res.remaining !== undefined ? { remaining: res.remaining } : {}),
    ...(res.resets_at ? { resetsAt: res.resets_at } : {}),
    ...(res.expires_at ? { expiresAt: res.expires_at } : {})
  };
  switch (res.reason) {
    case "no_seeker":
      return new ApiError("FORBIDDEN", "This account is not a seeker account.", 403, [extra]);
    case "not_verified":
      return new ApiError("PENDING_VERIFICATION",
        "Confirm the code we sent you before searching the directory.", 403, [extra]);
    case "no_pass":
      return new ApiError("NO_SEARCH_PASS",
        "Claim your free daily search, or record a weekly pass, before searching.", 409, [extra]);
    case "has_live_pass":
      return new ApiError("SEARCH_PASS_EXISTS",
        "You already have a live search pass — use it before claiming another.", 409, [extra]);
    case "wait":
      return new ApiError("FREE_SEARCH_NOT_READY",
        "Your free search is used. The next one unlocks in 24 hours.", 409, [extra]);
    case "already_recorded":
      return new ApiError("PASS_ALREADY_RECORDED",
        "That payment reference is already with the office for confirmation.", 409, [extra]);
    case "awaiting_verification":
      return new ApiError("PASS_AWAITING_VERIFICATION",
        "The office is still confirming that payment. Your free search works meanwhile.",
        409, [extra]);
    case "expired":
      return new ApiError("SEARCH_PASS_EXPIRED", "That search pass has expired.", 409, [extra]);
    case "exhausted":
      return new ApiError("SEARCH_PASS_EXHAUSTED",
        "This pass has no searches left.", 409, [extra]);
    case "not_live":
      return new ApiError("SEARCH_PASS_NOT_USABLE",
        `That pass is ${res.status ?? "not usable"} and cannot be searched with.`, 409, [extra]);
    case "not_mine":
      return new ApiError("FORBIDDEN", "That search pass belongs to another account.", 403, [extra]);
    case "reference_too_short":
      return new ApiError("VALIDATION_FAILED",
        "Enter the transaction reference exactly as your mobile money or bank receipt shows it.",
        400, [{ field: "reference", message: "At least 4 characters" }]);
    case "method_required":
      return new ApiError("VALIDATION_FAILED", "Say how you paid.", 400,
        [{ field: "method", message: "Required" }]);
    case "not_offered":
      return new ApiError("SEARCH_PASS_NOT_OFFERED",
        "WAISHA is not offering that pass right now.", 409, [extra]);
    default:
      return new ApiError("CONFLICT", "That search pass cannot be used right now.", 409,
        [{ reason: res.reason }]);
  }
}

// Each meter function is one literal query. Not a shared helper with the name passed
// in: security-scan.ts fails any `.query()` whose SQL is a template with ${} inside,
// and a function name is exactly the kind of thing that would sneak through that way.
const passState = (userId: string) =>
  pool.query("select platform_auth.seeker_pass_state($1) as r", [userId])
    .then(r => r.rows[0]?.r ?? null);

const claimFreeSearch = (userId: string) =>
  pool.query("select platform_auth.claim_free_search($1) as r", [userId])
    .then(r => r.rows[0]?.r ?? null);

const recordWeeklyPass = (userId: string, reference: string, method: string) =>
  pool.query("select platform_auth.record_weekly_pass($1,$2,$3) as r", [userId, reference, method])
    .then(r => r.rows[0]?.r ?? null);

const LOOKING_FOR = ["transporter", "cfa"] as const;

const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  lookingFor: z.array(z.enum(LOOKING_FOR)).max(2).optional(),
  industry: z.string().trim().max(80).nullable().optional()
}).strict();

const METHODS = ["mpesa", "airtel_money", "tigo_pesa", "halotel_cash", "bank_transfer", "cash", "other"] as const;

export async function seekerRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Own profile ----------
  app.get("/seeker/profile",
    { preHandler: [requireAuth, requirePermission("seeker_profile.view")] },
    async (req: any) => {
      // Read outside the transaction on purpose: seeker_pass_state is a definer that
      // finds the seeker through its user id, so it needs no tenant context — and
      // taking a second pool connection inside withTenant would hold two per request.
      const pass = await passState(req.user.sub);
      return withTenant(req.user.tid, async (c) => {
        const s = await c.query(
          `select sk.id, sk.first_name, sk.last_name, sk.looking_for, sk.industry, sk.country,
                  sk.email_verified_at, sk.phone_verified_at, sk.created_at,
                  u.email, u.phone_encrypted, t.name as tenant_name
           from seekers sk
           join users u on u.id = sk.user_id
           join tenants t on t.id = sk.tenant_id
           where sk.tenant_id = $1 and sk.user_id = $2 and sk.deleted_at is null`,
          [req.user.tid, req.user.sub]);
        if (!s.rowCount) throw new ApiError("NOT_FOUND", "Seeker profile not found", 404);
        const row = s.rows[0];
        // Masked, never plaintext: the house rule is that no endpoint echoes raw PII,
        // and a seeker's own phone is still PII on a screen that can be shared.
        const phone = row.phone_encrypted
          ? maskPhone(decryptField(Buffer.from(row.phone_encrypted))) : null;
        return {
          seekerId: row.id,
          firstName: row.first_name,
          lastName: row.last_name,
          email: row.email,
          phoneMasked: phone,
          lookingFor: row.looking_for,
          industry: row.industry,
          country: row.country,
          company: row.tenant_name,
          emailVerifiedAt: row.email_verified_at,
          phoneVerifiedAt: row.phone_verified_at,
          since: row.created_at,
          pass
        };
      });
    });

  // Names, what they are looking for and their industry. Phone and email are NOT
  // editable here: either change is a re-verification of a login identity, and 060
  // stamps verification per channel, so a silent swap would leave a verified stamp
  // pointing at an address or number nobody ever confirmed.
  app.put("/seeker/profile",
    { preHandler: [requireAuth, requirePermission("seeker_profile.edit")] },
    async (req: any) => {
      await enforceRateLimit(`seeker-profile:uid:${req.user.sub}`, 30, 3600);
      const body = profileSchema.parse(req.body);
      if (!Object.keys(body).length) {
        throw new ApiError("VALIDATION_FAILED", "Nothing to update.", 400,
          [{ field: "firstName", message: "Send at least one field" }]);
      }
      // Absent keeps, present replaces — the drivers PUT idiom, so a form that posts
      // only the field it changed cannot blank the others.
      const touch = {
        firstName: body.firstName !== undefined,
        lastName: body.lastName !== undefined,
        lookingFor: body.lookingFor !== undefined,
        industry: body.industry !== undefined
      };
      const lookingFor = [...new Set(body.lookingFor ?? [])];

      return withTenant(req.user.tid, async (c) => {
        const before = await c.query(
          `select first_name, last_name, looking_for, industry from seekers
           where tenant_id = $1 and user_id = $2 and deleted_at is null`,
          [req.user.tid, req.user.sub]);
        if (!before.rowCount) throw new ApiError("NOT_FOUND", "Seeker profile not found", 404);

        const updated = await c.query(
          `update seekers set
             first_name = case when $3 then $4 else first_name end,
             last_name = case when $5 then $6 else last_name end,
             looking_for = case when $7 then $8::text[] else looking_for end,
             industry = case when $9 then $10 else industry end,
             updated_by = $2
           where tenant_id = $1 and user_id = $2 and deleted_at is null
           returning id, first_name, last_name, looking_for, industry,
                     email_verified_at, phone_verified_at, updated_at`,
          [req.user.tid, req.user.sub,
           touch.firstName, body.firstName ?? null,
           touch.lastName, body.lastName ?? null,
           touch.lookingFor, lookingFor,
           touch.industry, body.industry ?? null]);

        // users.full_name is what the office sees in the pending-pass queue
        // (061's list_pending_passes reads it), so it is re-joined here rather than
        // allowed to keep naming somebody by a name they changed.
        if (touch.firstName || touch.lastName) {
          // concat_ws is VARIADIC "any", and a bare parameter inside it has no type for
          // the parser to pin (42P18) — the casts are what make the statement plan.
          await c.query(
            `update users set full_name = trim(concat_ws(' ', $3::text, $4::text))
             where id = $2 and tenant_id = $1`,
            [req.user.tid, req.user.sub,
             touch.firstName ? updated.rows[0].first_name : before.rows[0].first_name,
             touch.lastName ? updated.rows[0].last_name : before.rows[0].last_name]);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "seekers", entityId: updated.rows[0].id,
          action: "seeker.profile.updated",
          before: before.rows[0], after: body
        });
        return updated.rows[0];
      });
    });

  // ---------- The meter ----------
  app.get("/seeker/passes",
    { preHandler: [requireAuth, requirePermission("seeker_pass.view")] },
    async (req: any) => passState(req.user.sub));

  app.get("/seeker/searches",
    { preHandler: [requireAuth, requirePermission("seeker_pass.view")] },
    async (req: any) => {
      const limit = Math.min(Math.max(Number((req.query as any)?.limit) || 20, 1), 50);
      return withTenant(req.user.tid, (c) => c.query(
        `select ss.id, ss.query, ss.filter_kind as kind, ss.filter_region_id as region_id,
                g.name_en as region_name, ss.found, ss.credits_left, ss.created_at,
                l.company_name as opened_company
         from seeker_searches ss
         left join geo_regions g on g.id = ss.filter_region_id
         left join directory_listings l on l.id = ss.listing_id
         where ss.tenant_id = $1
         order by ss.created_at desc
         limit $2`, [req.user.tid, limit]).then(r => r.rows));
    });

  // The free credit is a claim, not a read: 061 anchors the 24 hours on the CLAIM, so
  // calling this and never searching still spends the day. 30/hour per account cannot
  // burn more than the one credit the meter allows anyway, but it keeps a script from
  // hammering the definer.
  app.post("/seeker/passes/free",
    { preHandler: [requireAuth, requirePermission("seeker_pass.create")] },
    async (req: any, reply) => {
      await enforceRateLimit(`seeker-free:uid:${req.user.sub}`, 30, 3600);
      const res = await claimFreeSearch(req.user.sub);
      const refusal = meterRefusal(res);
      if (refusal) throw refusal;

      await withTenant(req.user.tid, (c) => writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "seeker_search_passes", entityId: res.pass_id,
        action: "seeker_pass.free_claimed",
        after: { kind: res.kind, remaining: res.remaining, expiresAt: res.expires_at }
      }));
      return reply.status(201).send({
        passId: res.pass_id, kind: res.kind, remaining: res.remaining, expiresAt: res.expires_at
      });
    });

  // Money is recorded, never collected: this stores the reference the seeker was
  // handed and nothing else. No provider is called and no credentials exist here.
  app.post("/seeker/passes/weekly",
    { preHandler: [requireAuth, requirePermission("seeker_pass.create")] },
    async (req: any, reply) => {
      await enforceRateLimit(`seeker-weekly:uid:${req.user.sub}`, 10, 3600);
      const body = z.object({
        reference: z.string().trim().min(4).max(80),
        method: z.enum(METHODS)
      }).strict().parse(req.body);

      const res = await recordWeeklyPass(req.user.sub, body.reference, body.method);
      const refusal = meterRefusal(res);
      if (refusal) throw refusal;

      await withTenant(req.user.tid, (c) => writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "seeker_search_passes", entityId: res.pass_id,
        action: "seeker_pass.recorded",
        after: { method: body.method, amount: res.amount, currency: res.currency,
                 reference: res.reference }
      }));
      return reply.status(201).send({
        passId: res.pass_id, status: res.status, amount: res.amount,
        currency: res.currency, reference: res.reference, note: res.note
      });
    });
}
