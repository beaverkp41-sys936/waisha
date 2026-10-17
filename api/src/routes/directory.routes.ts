import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl, hasLicenceRole } from "./control.routes.js";
// One translation table for every reason the 061 meter emits, shared with the claim
// paths that emit the same ones.
import { meterRefusal } from "./seeker.routes.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const KINDS = ["transporter", "cfa"] as const;
const SERVES = ["transporter", "cfa"] as const;

/**
 * A region id reaches two foreign keys — seeker_searches.filter_region_id and
 * directory_listing_regions.region_id — and both raise 23503 from inside a definer or
 * a trigger, which would surface as a 500 for what is really a bad number in a
 * dropdown. Checked before anything is spent, because a search that errors after
 * consume_search_credit has already taken the credit is a search the seeker paid for
 * and did not get.
 */
async function assertRegions(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const found = await pool.query(
    "select id from geo_regions where id = any($1::int[]) and is_active", [ids]);
  if (found.rowCount !== ids.length) {
    throw new ApiError("VALIDATION_FAILED", "Unknown region.", 400,
      [{ field: "regionId", message: "Not a WAISHA region" }]);
  }
}

const searchSchema = z.object({
  kind: z.enum(KINDS).nullish(),
  regionId: z.number().int().positive().nullish(),
  query: z.string().trim().max(200).nullish(),
  // Present = "open this company's card" rather than "give me a list". 061 built the
  // log row with a nullable listing_id for exactly this, and the per-listing counts
  // the office and the company both read depend on it being set.
  listingId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(60).default(20),
  offset: z.number().int().min(0).max(5000).default(0),
  passId: z.string().uuid().optional()
}).strict();

const listingSchema = z.object({
  serves: z.array(z.enum(SERVES)).min(1).max(2),
  companyName: z.string().trim().min(2).max(200),
  headline: z.string().trim().max(140).nullish(),
  description: z.string().max(1200).nullish(),
  servicesOffered: z.string().max(600).nullish(),
  corridorsServed: z.string().max(600).nullish(),
  homeBase: z.string().trim().max(200).nullish(),
  website: z.string().trim().max(300).nullish(),
  fleetSizeDeclared: z.number().int().min(0).max(20000).nullish(),
  yearEstablished: z.number().int().min(1900).max(2100).nullish(),
  contactName: z.string().trim().min(2).max(120),
  contactChannel: z.string().trim().min(5).max(160),
  regionIds: z.array(z.number().int().positive()).max(31).default([])
}).strict();

const CARDS_SQL = `select * from directory_search($1,$2,$3,$4,$5,$6)`;

/**
 * directory_card_for returns one composite, not a set, so a listing that is not on the
 * board still answers with a single row whose every column is NULL. rowCount is
 * therefore always 1 and the id is the only honest test for "is there a card here" —
 * reading the row without it would hand a seeker an empty company for a draft, a
 * suspended listing or a search id they never paid for.
 */
const cardOrNull = (result: { rows: any[] }): any =>
  (result.rows[0]?.id ? result.rows[0] : null);

export async function directoryRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================
  // THE SEEKER SIDE — every read here is behind a spent credit
  // ============================

  // The region filter should not offer a region with nothing in it. Counts of live
  // listings per region are aggregate public facts about the directory, so this one
  // read costs no credit — it is what the search form is built from.
  app.get("/directory/regions",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async () => {
      const { rows } = await pool.query(
        "select * from directory_region_counts() where companies > 0");
      return rows;
    });

  // One call, one credit, one page. Consume and read deliberately share the
  // withTenant transaction: if the read throws, the rollback returns the credit, so a
  // seeker never pays for a search the server failed to run.
  app.post("/directory/search",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async (req: any) => {
      await enforceRateLimit(`directory-search:uid:${req.user.sub}`, 30, 3600);
      const body = searchSchema.parse(req.body);
      const query = body.query || null;
      if (body.regionId) await assertRegions([body.regionId]);

      let passId = body.passId ?? null;
      let state: any = null;
      if (!passId) {
        const st = await pool.query(
          "select platform_auth.seeker_pass_state($1) as r", [req.user.sub]);
        state = st.rows[0]?.r ?? {};
        passId = state.live_pass_id ?? null;
      }
      if (!passId) {
        // "You have nothing" and "today's one is spent, back in N minutes" are different
        // screens, and the meter already knows which: a free pass that exists but is used
        // up leaves live_pass_id empty while free_wait_minutes counts down to the next
        // claim. Without this the seeker who searched once is told to go sign up again.
        const wait = Math.max(0, Number(state?.free_wait_minutes ?? 0));
        if (wait > 0) {
          throw new ApiError("SEARCH_PASS_EXHAUSTED",
            `Today's free search is used. The next one unlocks in ${wait} minutes.`,
            409, [{ reason: "exhausted", freeWaitMinutes: wait }]);
        }
        throw new ApiError("NO_SEARCH_PASS",
          "Claim your free daily search, or record a weekly pass, before searching.",
          409, [{ reason: "no_pass" }]);
      }

      return withTenant(req.user.tid, async (c) => {
        const spent = await c.query(
          "select platform_auth.consume_search_credit($1,$2,$3,$4,$5,$6,$7) as r",
          [req.user.sub, passId, body.listingId ?? null, query, body.kind ?? null,
           body.regionId ?? null, req.ip]);
        const res = spent.rows[0]?.r ?? {};
        if (!res.ok) throw meterRefusal(res);

        if (body.listingId) {
          const card = await c.query("select * from directory_card_for($1,$2)",
            [body.listingId, res.search_id]);
          if (!cardOrNull(card)) {
            // Thrown inside the transaction, so the consume above rolls back with it:
            // a card that is not on the board does not cost a search.
            throw new ApiError("NOT_FOUND", "No live company under that reference.", 404);
          }
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "seeker_searches", entityId: res.search_id,
            action: "directory.card_opened",
            after: { listingId: body.listingId, remaining: res.remaining }
          });
          return {
            searchId: res.search_id, listingId: body.listingId,
            remaining: res.remaining, passKind: res.pass_kind, resetsAt: res.resets_at,
            company: card.rows[0]
          };
        }

        const cards = await c.query(CARDS_SQL,
          [res.search_id, body.kind ?? null, body.regionId ?? null, query,
           body.limit, body.offset]);
        // total rides on the rows the read returns, so a page with nothing on it carries
        // no count. The meter already settled seeker_searches.found for this search, and
        // that table is SELECT-visible to this tenant, so an empty board answers with a
        // real zero instead of a null the client has to guess at.
        let found = cards.rows[0]?.total ?? null;
        if (found === null) {
          const settled = await c.query(
            "select found from seeker_searches where id = $1", [res.search_id]);
          found = settled.rows[0]?.found ?? null;
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "seeker_searches", entityId: res.search_id,
          action: "directory.searched",
          after: { kind: body.kind ?? null, regionId: body.regionId ?? null,
                   query, found, remaining: res.remaining }
        });

        return {
          searchId: res.search_id,
          kind: body.kind ?? null,
          regionId: body.regionId ?? null,
          query,
          limit: body.limit,
          offset: body.offset,
          found,
          remaining: res.remaining,
          passKind: res.pass_kind,
          resetsAt: res.resets_at,
          results: cards.rows
        };
      });
    });

  // Paging through a search the seeker already paid for costs nothing: 061's claim
  // check covers the whole five minutes. The filters come back with the search id
  // because the same credit can be read with a narrower slice of it.
  app.get("/directory/search/:searchId",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async (req: any) => {
      const searchId = z.string().uuid().parse((req.params as any).searchId);
      const q = req.query as Record<string, string>;
      const body = searchSchema.pick({ kind: true, regionId: true, query: true,
        limit: true, offset: true }).parse({
        kind: q.kind || undefined,
        regionId: q.regionId ? Number(q.regionId) : undefined,
        query: q.query || undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined
      });
      const query = body.query || null;
      if (body.regionId) await assertRegions([body.regionId]);

      return withTenant(req.user.tid, async (c) => {
        const claim = await c.query("select directory_claim_ok($1) as ok", [searchId]);
        if (!claim.rows[0]?.ok) {
          throw new ApiError("SEARCH_EXPIRED",
            "This search has timed out. Run a new one — it costs a search only if you have none left today.",
            410, [{ reason: "claim_expired" }]);
        }
        const cards = await c.query(CARDS_SQL,
          [searchId, body.kind ?? null, body.regionId ?? null, query,
           body.limit ?? 20, body.offset ?? 0]);
        return { searchId, found: cards.rows[0]?.total ?? 0, results: cards.rows };
      });
    });

  // Opening a card is a read of the directory, so it presents the same claim check.
  // This is where the named contact and their channel become visible.
  app.get("/directory/companies/:id",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const listingId = z.string().uuid().parse(id);
      const searchId = z.string().uuid().parse((req.query as any).searchId ?? "");
      await enforceRateLimit(`directory-card:uid:${req.user.sub}`, 60, 3600);

      return withTenant(req.user.tid, async (c) => {
        const card = await c.query("select * from directory_card_for($1,$2)",
          [listingId, searchId]);
        const company = cardOrNull(card);
        if (!company) {
          const claim = await c.query("select directory_claim_ok($1) as ok", [searchId]);
          throw claim.rows[0]?.ok
            ? new ApiError("NOT_FOUND", "No live company under that reference.", 404)
            : new ApiError("SEARCH_EXPIRED",
                "This search has timed out. Run a new one to open companies.", 410);
        }
        // No write here, deliberately: app_runtime holds SELECT only on
        // seeker_searches, so an update from a route would answer 42501 in production
        // and pass silently under dev's owner role. A card opened off a live claim is
        // covered by the credit that claim paid for; an open that should be counted is
        // made through POST /directory/search with a listingId, which spends its own.
        return company;
      });
    });

  // ============================
  // THE COMPANY SIDE — publish a copy, never the live profile
  // ============================

  app.get("/directory/listing",
    { preHandler: [requireAuth, requirePermission("directory.view")] },
    async (req: any) => {
      const stats = await pool.query(
        "select platform_auth.directory_listing_stats($1) as s", [req.user.tid]);
      return withTenant(req.user.tid, async (c) => {
        const l = await c.query(
          `select id, serves, company_name, headline, description, services_offered,
                  corridors_served, home_base, website, fleet_size_declared,
                  year_established, licence_valid_to::text as licence_valid_to,
                  contact_name, contact_channel, status, suspension_reason, is_verified,
                  published_at, updated_at
           from directory_listings where tenant_id = $1 and deleted_at is null`,
          [req.user.tid]);
        const regions = l.rowCount
          ? (await c.query(
              `select dlr.region_id, g.name_en from directory_listing_regions dlr
               join geo_regions g on g.id = dlr.region_id
               where dlr.listing_id = $1 order by g.name_en`, [l.rows[0].id])).rows
          : [];
        // Prefill for a company that has never published: what is already on the
        // profile they filled in during onboarding.
        const profile = await c.query(
          `select company_name, description, services_offered, corridors_served,
                  website, fleet_size_declared, year_established,
                  transport_licence_expiry::text as licence_valid_to
           from company_profiles where tenant_id = $1`, [req.user.tid]);
        return {
          listing: l.rows[0] ?? null,
          regions,
          stats: stats.rows[0]?.s ?? null,
          suggestions: profile.rows[0] ?? null
        };
      });
    });

  /**
   * Save the published copy. Status is never touched here — publishing is its own
   * route, so a company cannot edit its way onto the board by accident.
   *
   * The licence date is re-copied from company_profiles on every save rather than
   * taken from the request, because 061 stores the date but not the number, and a
   * stale copy would keep telling seekers a licence is valid after it was renewed or
   * expired on the profile.
   */
  app.put("/directory/listing",
    { preHandler: [requireAuth, requirePermission("directory.manage")] },
    async (req: any) => {
      await enforceRateLimit(`directory-listing:uid:${req.user.sub}`, 30, 3600);
      const body = listingSchema.parse(req.body);
      await assertRegions(body.regionIds);
      const serves = [...new Set(body.serves)];

      return withTenant(req.user.tid, async (c) => {
        const upsert = await c.query(
          `insert into directory_listings (
             tenant_id, serves, company_name, headline, description, services_offered,
             corridors_served, home_base, website, fleet_size_declared, year_established,
             licence_valid_to, contact_name, contact_channel, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                   (select transport_licence_expiry from company_profiles where tenant_id = $1),
                   $12,$13,$14,$14)
           on conflict (tenant_id) where deleted_at is null do update set
             serves = excluded.serves,
             company_name = excluded.company_name,
             headline = excluded.headline,
             description = excluded.description,
             services_offered = excluded.services_offered,
             corridors_served = excluded.corridors_served,
             home_base = excluded.home_base,
             website = excluded.website,
             fleet_size_declared = excluded.fleet_size_declared,
             year_established = excluded.year_established,
             licence_valid_to = excluded.licence_valid_to,
             contact_name = excluded.contact_name,
             contact_channel = excluded.contact_channel,
             updated_by = excluded.updated_by
           returning id, serves, company_name, headline, description, status,
                     is_verified, published_at, updated_at,
                     (xmax = 0) as created`,
          [req.user.tid, serves, body.companyName, body.headline ?? null,
           body.description ?? null, body.servicesOffered ?? null,
           body.corridorsServed ?? null, body.homeBase ?? null, body.website ?? null,
           body.fleetSizeDeclared ?? null, body.yearEstablished ?? null,
           body.contactName, body.contactChannel, req.user.sub]);

        const listing = upsert.rows[0];
        // Rewritten whole, like quotation_items (052): the region set is a document,
        // not a log, and a stale region would keep matching searches.
        await c.query("delete from directory_listing_regions where listing_id = $1", [listing.id]);
        for (const regionId of body.regionIds) {
          await c.query(
            `insert into directory_listing_regions (listing_id, region_id, tenant_id)
             values ($1,$2,$3) on conflict do nothing`, [listing.id, regionId, req.user.tid]);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "directory_listings", entityId: listing.id,
          action: listing.created ? "directory.listing.created" : "directory.listing.saved",
          after: { serves, companyName: body.companyName, status: listing.status,
                   regions: body.regionIds.length }
        });
        return { ...listing, regionIds: body.regionIds };
      });
    });

  // Publishing is where the platform's own eligibility rules bite, and 061 wrote them
  // as a trigger precisely so no route could forget them. Two facts the trigger cannot
  // see are checked here instead.
  app.post("/directory/listing/publish",
    { preHandler: [requireAuth, requirePermission("directory.manage")] },
    async (req: any) => {
      await enforceRateLimit(`directory-publish:uid:${req.user.sub}`, 10, 3600);
      return withTenant(req.user.tid, async (c) => {
        const now = await c.query(
          `select id, status, company_name, suspension_reason
           from directory_listings where tenant_id = $1 and deleted_at is null`,
          [req.user.tid]);
        if (!now.rowCount) {
          throw new ApiError("NO_LISTING",
            "Save your directory listing before publishing it.", 409, [{ field: "listing" }]);
        }
        const row = now.rows[0];
        // A suspended listing belongs to the platform's decision, not the company's:
        // without this, publish would be a one-click bypass of moderation.
        if (row.status === "suspended") {
          throw new ApiError("LISTING_SUSPENDED",
            "WAISHA suspended this listing. Contact the office to have it reviewed.", 403,
            [{ reason: "suspended", note: row.suspension_reason ?? null }]);
        }

        // The guard trigger raises P0001 for an ineligible account (wrong tenant type,
        // pending_verification, expired or suspended subscription) and the global error
        // handler turns that into a 409 carrying the trigger's own sentence.
        const live = await c.query(
          `update directory_listings set status = 'live', updated_by = $2
           where id = $1 returning id, status, is_verified, published_at, company_name`,
          [row.id, req.user.sub]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "directory_listings", entityId: row.id,
          action: "directory.published", after: { companyName: row.company_name }
        });
        return live.rows[0];
      });
    });

  // Withdrawal is a status, never a delete: 061 grants no DELETE on the table so the
  // moderation history of a company survives it deciding to hide.
  app.post("/directory/listing/withdraw",
    { preHandler: [requireAuth, requirePermission("directory.manage")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `update directory_listings set status = 'draft', updated_by = $2
           where tenant_id = $1 and deleted_at is null and status <> 'draft'
           returning id, status, published_at`, [req.user.tid, req.user.sub]);
        if (!r.rowCount) {
          const exists = await c.query(
            "select status from directory_listings where tenant_id = $1 and deleted_at is null",
            [req.user.tid]);
          if (!exists.rowCount) {
            throw new ApiError("NO_LISTING", "You have no directory listing.", 404);
          }
          return { status: exists.rows[0].status, alreadyWithdrawn: true };
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "directory_listings", entityId: r.rows[0].id,
          action: "directory.withdrawn"
        });
        return r.rows[0];
      });
    });

  // ============================
  // CONTROL — confirm money, moderate the board
  // ============================

  app.get("/control/directory/passes", { preHandler: [requireControl] }, async (req: any) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    const { rows } = await pool.query("select * from platform_auth.list_pending_passes()");
    return rows;
  });

  // The week is re-based on the approval instant inside the definer, because the money
  // usually lands a day after the reference was typed.
  app.post("/control/directory/passes/:id/verify",
    { preHandler: [requireControl] }, async (req: any) => {
      if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
      await enforceRateLimit(`pass-verify:uid:${req.control.user_id}`, 60, 3600);
      const passId = z.string().uuid().parse((req.params as any).id);
      const body = z.object({
        approve: z.boolean(),
        note: z.string().trim().max(400).optional()
      }).strict().parse(req.body);

      const r = await pool.query(
        "select platform_auth.verify_search_pass($1,$2,$3,$4) as r",
        [passId, req.control.user_id, body.approve, body.note ?? null]);
      const res = r.rows[0]?.r ?? {};
      if (res.status === "not_found") throw new ApiError("NOT_FOUND", "Pass not found", 404);
      if (res.status === "conflict") {
        throw new ApiError("PASS_NOT_PENDING", String(res.reason), 409,
          [{ currentStatus: res.current_status }]);
      }
      return res;
    });

  app.get("/control/directory/listings", { preHandler: [requireControl] }, async (req: any) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    const q = ((req.query as any)?.q ?? "").toString().trim();
    const { rows } = await pool.query(
      "select * from platform_auth.list_directory_for_control($1)", [q || null]);
    return rows;
  });

  app.post("/control/directory/listings/:id/moderate",
    { preHandler: [requireControl] }, async (req: any) => {
      if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
      await enforceRateLimit(`listing-moderate:uid:${req.control.user_id}`, 60, 3600);
      const listingId = z.string().uuid().parse((req.params as any).id);
      const body = z.object({
        action: z.enum(["suspend", "reinstate", "verify", "unverify"]),
        note: z.string().trim().max(400).optional()
      }).strict().parse(req.body);

      const r = await pool.query(
        "select platform_auth.moderate_listing($1,$2,$3,$4) as r",
        [listingId, req.control.user_id, body.action, body.note ?? null]);
      const res = r.rows[0]?.r ?? {};
      if (res.status === "not_found") throw new ApiError("NOT_FOUND", "Listing not found", 404);
      if (res.status === "invalid") {
        throw new ApiError("VALIDATION_FAILED", String(res.reason), 400,
          [{ field: body.action === "suspend" ? "note" : "action" }]);
      }
      return res;
    });
}
