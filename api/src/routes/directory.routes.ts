import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "../security/jwt.js";
import { checkPermission, requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { webAddress } from "../security/url.js";
import { writeAudit } from "../audit/audit.js";
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
 * The service chips are stems, not labels: `directory_listings.services_offered` is free
 * text the company typed itself, so "Bonding" has to match "bonded transit" as readily as
 * "bonding". The reader takes the stems straight and matches them case-insensitively
 * against the published copy, which is the only honest test available on a field with no
 * vocabulary behind it.
 */
const SERVICE_TERMS = ["haul", "clear", "bond", "transit", "storage", "wareh", "deliver"] as const;

/** The meter counts down in minutes, and 1439 of them is a sentence nobody reads. */
function hm(totalMinutes: number): string {
  const m = Math.max(0, Math.floor(totalMinutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

/**
 * A region id reaches four foreign keys — seeker_searches.filter_region_id, its two route
 * columns and directory_listing_regions.region_id — and every one of them raises 23503 from
 * inside a definer or a trigger, which would surface as a 500 for what is really a bad
 * number in a dropdown. Checked before anything is spent, because a search that errors
 * after consume_search_credit has already taken the credit is a search the seeker paid for
 * and did not get.
 */
async function assertRegions(ids: number[], field = "regionId"): Promise<void> {
  if (!ids.length) return;
  const found = await pool.query(
    "select id from geo_regions where id = any($1::int[]) and is_active", [ids]);
  if (found.rowCount !== ids.length) {
    throw new ApiError("VALIDATION_FAILED", "Unknown region.", 400,
      [{ field, message: "Not a WAISHA region" }]);
  }
}

/** A route is a pair of WAISHA regions plus the two free-text ends the seeker typed
 *  (a council or a ward below the region, which no listing is tagged at). The id pair is
 *  what the search matches on; the text is what the log keeps so the seeker's history
 *  page can show the same thing they picked. */
const routeSchema = z.object({
  originRegionId: z.number().int().positive(),
  destRegionId: z.number().int().positive(),
  originText: z.string().trim().max(120).nullish(),
  destText: z.string().trim().max(120).nullish(),
  corridorId: z.number().int().positive().nullish()
}).strict().superRefine((v, ctx) => {
  // Same region at both ends is a "who works in this region" search, and the region
  // filter answers that without ranking anyone as if they ran a road.
  if (v.originRegionId === v.destRegionId) {
    ctx.addIssue({ code: "custom", path: ["destRegionId"], message: "Pick two different regions" });
  }
});

const searchSchema = z.object({
  kind: z.enum(KINDS).nullish(),
  regionId: z.number().int().positive().nullish(),
  query: z.string().trim().max(200).nullish(),
  // Present = "open this company's card" rather than "give me a list". 061 built the
  // log row with a nullable listing_id for exactly this, and the per-listing counts
  // the office and the company both read depend on it being set.
  listingId: z.string().uuid().optional(),
  route: routeSchema.optional(),
  services: z.array(z.enum(SERVICE_TERMS)).max(SERVICE_TERMS.length).nullish(),
  verifiedOnly: z.boolean().nullish(),
  licenceValid: z.boolean().nullish(),
  minFleet: z.number().int().min(1).max(20000).nullish(),
  limit: z.number().int().min(1).max(60).default(20),
  offset: z.number().int().min(0).max(5000).default(0),
  passId: z.string().uuid().optional()
}).strict().superRefine((v, ctx) => {
  // platform_auth.record_search_route refuses to write a route onto a card-open row, so
  // accepting both here would spend a credit and then quietly drop half of what was asked.
  if (v.listingId && v.route) {
    ctx.addIssue({ code: "custom", path: ["route"], message: "A card open has no route" });
  }
});
type SearchInput = z.infer<typeof searchSchema>;

/**
 * The GET door takes the same filters as the POST one, in a query string. Paging and
 * narrowing both come through here, and the read that answers them has to be the read the
 * credit paid for — a route dropped on the way through would show the seeker page two of a
 * list they never asked for.
 */
function searchInputFromQuery(q: Record<string, string | undefined>): SearchInput {
  const origin = q.originRegionId ? Number(q.originRegionId) : null;
  const dest = q.destRegionId ? Number(q.destRegionId) : null;
  return searchSchema.parse({
    kind: q.kind || undefined,
    regionId: q.regionId ? Number(q.regionId) : undefined,
    query: q.query || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
    route: origin && dest ? {
      originRegionId: origin, destRegionId: dest,
      originText: q.originText || undefined, destText: q.destText || undefined,
      corridorId: q.corridorId ? Number(q.corridorId) : undefined
    } : undefined,
    services: q.services ? q.services.split(",").map(s => s.trim()).filter(Boolean) : undefined,
    verifiedOnly: q.verifiedOnly === undefined ? undefined : q.verifiedOnly !== "0",
    licenceValid: q.licenceValid === undefined ? undefined : q.licenceValid !== "0",
    minFleet: q.minFleet ? Number(q.minFleet) : undefined
  });
}

/** The eleven arguments the reader takes, built in one place so the count and the page
 *  cannot drift apart from each other across the two doors. */
function cardParams(searchId: string, f: SearchInput, chain: number[] | null): unknown[] {
  return [searchId, f.kind ?? null, f.regionId ?? null, f.query || null,
    f.limit, f.offset, chain, f.services ?? null, f.verifiedOnly ?? null,
    f.licenceValid ?? null, f.minFleet ?? null];
}

/**
 * geo_corridors (075) is WAISHA's own curated set — the main roads, each anchored
 * region -> towns -> region. A seeker who picks Namanga -> Dar is picking one of those
 * chains, so the search reads the whole chain rather than two dots: a company tagged at
 * Babati runs the Arusha road even if it never tagged either end. When the pair has no
 * published corridor the chain collapses to its two ends, which is the honest answer —
 * nobody has mapped that road, and inventing a chain would rank companies along a route
 * the platform never drew.
 */
async function resolveChain(route: z.infer<typeof routeSchema>):
  Promise<{ chain: number[]; corridor: string | null }> {
  const { rows } = await pool.query(
    "select corridor_id, corridor, region_ids from directory_corridor_board()");
  const hit = rows.find((r: any) =>
    (route.corridorId ? r.corridor_id === route.corridorId
      : r.region_ids[0] === route.originRegionId &&
        r.region_ids[r.region_ids.length - 1] === route.destRegionId) ||
    r.region_ids[r.region_ids.length - 1] === route.originRegionId &&
      r.region_ids[0] === route.destRegionId);
  if (!hit) return { chain: [route.originRegionId, route.destRegionId], corridor: null };
  // The board is stored one way; the seeker asked the other. The reader ranks its first
  // element as the origin, so a reversed pick has to be walked backwards.
  const back = Number(hit.region_ids[0]) !== route.originRegionId;
  return {
    chain: back ? [...hit.region_ids].reverse() : hit.region_ids,
    corridor: hit.corridor
  };
}

const listingSchema = z.object({
  serves: z.array(z.enum(SERVES)).min(1).max(2),
  companyName: z.string().trim().min(2).max(200),
  headline: z.string().trim().max(140).nullish(),
  description: z.string().max(1200).nullish(),
  servicesOffered: z.string().max(600).nullish(),
  corridorsServed: z.string().max(600).nullish(),
  homeBase: z.string().trim().max(200).nullish(),
  website: webAddress().nullish(),
  fleetSizeDeclared: z.number().int().min(0).max(20000).nullish(),
  yearEstablished: z.number().int().min(1900).max(2100).nullish(),
  contactName: z.string().trim().min(2).max(120),
  contactChannel: z.string().trim().min(5).max(160),
  regionIds: z.array(z.number().int().positive()).max(31).default([])
}).strict();

const CARDS_SQL = `select * from directory_search($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

/** The role the audit row is filed under. The definer takes it as text and never trusts it. */
const actorRole = (req: any): string | null => req.user?.roles?.[0] ?? null;

/**
 * A mark stands on one of exactly two proofs and the caller may not hold both: a job the two
 * companies actually booked (048), or a card this seeker's own credit opened (061's log row).
 * Which of the two is also which duty has to sign for it, so the shape is checked here rather
 * than left to the definer — a body carrying both ids would otherwise be answered by whichever
 * branch the server happened to reach first.
 */
const markSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(600).nullish(),
  bookingId: z.string().uuid().optional(),
  searchId: z.string().uuid().optional()
}).strict().superRefine((v, ctx) => {
  if (!!v.bookingId === !!v.searchId) {
    ctx.addIssue({
      code: "custom", path: [v.bookingId ? "bookingId" : "searchId"],
      message: "Name the job you booked or the card you opened, and only one of them"
    });
  }
});

/** The words a company puts under a mark on its own card. Written once, so 8 is the floor. */
const replySchema = z.object({
  reply: z.string().trim().min(8).max(600)
}).strict();

/** The author's own words, retyped before they are answered. */
const editSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(600).nullish()
}).strict();

/**
 * The five answers 131's mark definers give back, turned into the codes a caller can act on.
 * `conflict` carries the rating id on purpose: a seeker who has already marked this company is
 * sent to the mark they wrote, not to a sentence that leaves them guessing where it went.
 */
function markRefusal(res: any, field: string, fallback: string): ApiError | null {
  if (!res || res.status === "ok") return null;
  if (res.status === "not_found") {
    return new ApiError("NOT_FOUND", "No mark under that reference.", 404);
  }
  if (res.status === "unauthorised") {
    return new ApiError("FORBIDDEN",
      String(res.message ?? "This mark is not yours to change."), 403);
  }
  if (res.status === "conflict") {
    return new ApiError("CONFLICT", String(res.message ?? fallback), 409,
      res.rating_id ? [{ reason: "already_marked", ratingId: res.rating_id }] : []);
  }
  if (res.status === "invalid") {
    return new ApiError("VALIDATION_FAILED",
      String(res.message ?? fallback), 400, [{ field, message: String(res.message ?? fallback) }]);
  }
  return new ApiError("UPSTREAM_ERROR", fallback, 502);
}

/**
 * 131's rules are also written as `raise exception` sentences with the table named first, which
 * is what a register needs in its log and not what a star picker needs underneath it. The prefix
 * is taken off here; the sentence is kept, because it is the reason the mark was refused.
 */
function markGuard(err: any, fallback: string): ApiError | null {
  if (err?.code !== "P0001" || typeof err.message !== "string") return null;
  return new ApiError("CONFLICT",
    err.message.split("\n")[0].replace(/^directory_ratings:\s*/, "").slice(0, 300) || fallback,
    409);
}

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

  // WAISHA's own corridors, top to bottom, each with the region chain it crosses and how
  // many live companies sit on it. Aggregate public facts again, so the picker can be
  // built before the seeker spends anything — and the seeker who wants "the southern
  // road" gets WAISHA's road, not a guess at one.
  app.get("/directory/corridors",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async () => {
      const { rows } = await pool.query("select * from directory_corridor_board()");
      return rows;
    });

  // One call, one credit, one page. Claim, consume and read deliberately share the
  // withTenant transaction: if the read throws, the rollback returns both the credit and
  // the day's free claim, so a seeker never pays for a search the server failed to run.
  app.post("/directory/search",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async (req: any) => {
      await enforceRateLimit(`directory-search:uid:${req.user.sub}`, 30, 3600);
      const body = searchSchema.parse(req.body) as SearchInput;
      const query = body.query || null;
      if (body.regionId) await assertRegions([body.regionId]);
      if (body.route) {
        await assertRegions([body.route.originRegionId, body.route.destRegionId],
          "route.originRegionId");
      }
      // Resolved outside the paid transaction: a pair whose corridor lookup fails is a
      // 500 that must not have cost a credit.
      const walked = body.route ? await resolveChain(body.route) : null;
      const routeOut = body.route && walked ? { ...body.route, ...walked } : null;

      let passId = body.passId ?? null;
      let state: any = null;
      if (!passId) {
        const st = await pool.query(
          "select platform_auth.seeker_pass_state($1) as r", [req.user.sub]);
        state = st.rows[0]?.r ?? {};
        passId = state.live_pass_id ?? null;
      }
      // Pressing Search is the whole action. A seeker with nothing live whose day's free
      // credit is not yet spent claims it here rather than being sent to find a "claim"
      // button first — 061 anchors the 24 hours on the claim, so the credit the seeker
      // would have pressed for is the credit this search is about to spend.
      const claimNow = passId === null && Math.max(0, Number(state?.free_wait_minutes ?? 0)) === 0;
      if (passId === null && !claimNow) {
        // "Today's one is used, back in N minutes" is a countdown, not a dead end, and the
        // meter already knows which of the two it is: a free pass that exists but is spent
        // leaves live_pass_id empty while free_wait_minutes runs down to the next claim.
        const wait = Math.max(0, Number(state?.free_wait_minutes ?? 0));
        throw new ApiError("SEARCH_PASS_EXHAUSTED",
          `Today's free search is used. The next one unlocks in ${hm(wait)}.`,
          409, [{ reason: "exhausted", freeWaitMinutes: wait }]);
      }

      return withTenant(req.user.tid, async (c) => {
        let freeClaimed = false;
        if (claimNow) {
          const claimed = await c.query(
            "select platform_auth.claim_free_search($1) as r", [req.user.sub]);
          const res = claimed.rows[0]?.r ?? {};
          const refusal = meterRefusal(res);
          // Refused inside the same transaction that spends the credit, so a search that
          // never got one costs nothing. 'wait' is the race this can still hit — two tabs
          // pressing Search in the same second both read an empty meter — and it answers
          // as the countdown it is.
          if (refusal) throw refusal;
          passId = res.pass_id;
          freeClaimed = true;
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "seeker_search_passes", entityId: res.pass_id,
            action: "seeker_pass.free_claimed",
            after: { kind: res.kind, remaining: res.remaining,
                     expiresAt: res.expires_at, via: "search" }
          });
        }

        const spent = await c.query(
          "select platform_auth.consume_search_credit($1,$2,$3,$4,$5,$6,$7) as r",
          [req.user.sub, passId, body.listingId ?? null, query, body.kind ?? null,
           body.regionId ?? null, req.ip]);
        const res = spent.rows[0]?.r ?? {};
        if (!res.ok) throw meterRefusal(res);

        // The route lands on the log row the credit just wrote, in the same transaction, so
        // "who wants the Namanga road" is a demand fact the office can read instead of a
        // filter that only existed in a browser. False means the row was not this tenant's
        // or was a card open — neither is a search failure, so nothing throws.
        if (body.route) {
          await c.query("select platform_auth.record_search_route($1,$2,$3,$4,$5)",
            [res.search_id, body.route.originRegionId, body.route.destRegionId,
             body.route.originText ?? null, body.route.destText ?? null]);
        }

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
            freeClaimed,
            company: card.rows[0]
          };
        }

        const cards = await c.query(CARDS_SQL,
          cardParams(res.search_id, body, walked?.chain ?? null));
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
                   query, found, remaining: res.remaining,
                   route: walked ? { origin: body.route!.originRegionId,
                                     dest: body.route!.destRegionId,
                                     corridor: walked.corridor,
                                     chain: walked.chain.length } : null,
                   services: body.services ?? null, verifiedOnly: body.verifiedOnly ?? null,
                   licenceValid: body.licenceValid ?? null, minFleet: body.minFleet ?? null }
        });

        return {
          searchId: res.search_id,
          kind: body.kind ?? null,
          regionId: body.regionId ?? null,
          query,
          route: routeOut,
          services: body.services ?? null,
          verifiedOnly: body.verifiedOnly ?? null,
          licenceValid: body.licenceValid ?? null,
          minFleet: body.minFleet ?? null,
          limit: body.limit,
          offset: body.offset,
          found,
          remaining: res.remaining,
          passKind: res.pass_kind,
          resetsAt: res.resets_at,
          freeClaimed,
          results: cards.rows
        };
      });
    });

  // Paging through a search the seeker already paid for costs nothing: 061's claim
  // check covers the whole five minutes. The filters come back with the search id
  // because the same credit can be read with a narrower slice of it — ALL of them,
  // including the route, or page two answers a different question from page one.
  app.get("/directory/search/:searchId",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async (req: any) => {
      const searchId = z.string().uuid().parse((req.params as any).searchId);
      const body = searchInputFromQuery(req.query as Record<string, string | undefined>);
      if (body.regionId) await assertRegions([body.regionId]);
      // Only the two ends are the client's numbers. The regions between them come from
      // the board and only ever appear in an = any(...) test, which cannot raise a
      // foreign key.
      if (body.route) {
        await assertRegions([body.route.originRegionId, body.route.destRegionId],
          "route.originRegionId");
      }
      const walked = body.route ? await resolveChain(body.route) : null;

      return withTenant(req.user.tid, async (c) => {
        const claim = await c.query("select directory_claim_ok($1) as ok", [searchId]);
        if (!claim.rows[0]?.ok) {
          throw new ApiError("SEARCH_EXPIRED",
            "This search has timed out. Run a new one — it costs a search only if you have none left today.",
            410, [{ reason: "claim_expired" }]);
        }
        const cards = await c.query(CARDS_SQL,
          cardParams(searchId, body, walked?.chain ?? null));
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
          suggestions: profile.rows[0] ?? null,
          // The same lookup the write gate runs, asked once on the read so the page can
          // show a manager the truth instead of a form that fails when they press Save.
          canManage: await checkPermission(c, req.user.sub, "directory.manage")
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
  // THE MARK — what a job or an opened card left behind
  // ============================

  // A mark is written by the party on the proof, and the proof is never the caller's to name:
  // 131's trigger reads the counterparty's card out of the booking and the card out of the
  // seeker's own log row, so a seat cannot aim a bad mark at a bystander or rate itself. The
  // duty that signs for it follows the basis — a job belongs to the desk that manages bookings,
  // an opened card to the seeker whose credit opened it — which is why the gate is chosen from
  // the body rather than fixed in the preHandler.
  app.post("/directory/ratings",
    { preHandler: [requireAuth] },
    async (req: any) => {
      await enforceRateLimit(`directory-rate:uid:${req.user.sub}`, 20, 3600);
      const body = markSchema.parse(req.body);
      const duty = body.bookingId ? "board.book" : "directory.search";
      const held = await withTenant(req.user.tid,
        (c) => checkPermission(c, req.user.sub, duty));
      if (!held) {
        throw new ApiError("FORBIDDEN", body.bookingId
          ? "Marking a job needs the duty that manages your bookings."
          : "Marking a card needs the directory search duty.", 403);
      }
      let res: any;
      try {
        const r = await pool.query(
          `select platform_auth.rate_directory_company($1,$2,$3,$4,$5,$6,$7) as r`,
          [body.bookingId ?? null, body.searchId ?? null, body.stars, body.comment ?? null,
           req.user.sub, actorRole(req), req.ip]);
        res = r.rows[0]?.r ?? {};
      } catch (e) {
        const refusal = markGuard(e, "The mark could not be recorded.");
        if (refusal) throw refusal;
        throw e;
      }
      const refusal = markRefusal(res, body.bookingId ? "bookingId" : "searchId",
        "The mark could not be recorded.");
      if (refusal) throw refusal;
      // The card comes back with the mark because it is the fact the caller cannot derive: the
      // page that offered the stars was showing a search result, and this is the first time the
      // seeker learns which card the platform filed their words against.
      return { ratingId: res.rating_id, listingId: res.listing_id, stars: body.stars };
    });

  // The marks beside a card, on the same claim check 061 puts on the card itself. Without it the
  // register built out of paid searches would be readable by anybody who wrote a loop over
  // listing ids. Called inside the tenant transaction because `directory_claim_ok` answers off
  // `app.tenant_id`, and an empty setting is a false, not an error — a read made outside the
  // session's tenant would tell every seeker their search had expired.
  app.get("/directory/companies/:id/ratings",
    { preHandler: [requireAuth, requirePermission("directory.search")] },
    async (req: any) => {
      const listingId = z.string().uuid().parse((req.params as any).id);
      const searchId = z.string().uuid().parse((req.query as any).searchId ?? "");
      const limit = z.coerce.number().int().min(1).max(50).default(20)
        .parse((req.query as any).limit ?? 20);
      const offset = z.coerce.number().int().min(0).max(5000).default(0)
        .parse((req.query as any).offset ?? 0);

      return withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          "select platform_auth.directory_ratings_for($1,$2,$3,$4) as r",
          [listingId, searchId, limit, offset]);
        const res = r.rows[0]?.r ?? {};
        if (res.status === "claim_expired") {
          throw new ApiError("SEARCH_EXPIRED",
            "This search has timed out. Run a new one to read the marks on a card.", 410,
            [{ reason: "claim_expired" }]);
        }
        return { listingId, marks: res.rows ?? [], summary: res.summary ?? null };
      });
    });

  // What the caller has written, wherever it landed. No duty is asked for: reading your own
  // words back is not a permission, and 131's policy already keeps the row visible to the tenant
  // that wrote it. This is the seeker's history page and the seat's own list of marks at once.
  app.get("/directory/ratings/mine",
    { preHandler: [requireAuth] },
    async (req: any) => {
      const limit = z.coerce.number().int().min(1).max(100).default(30)
        .parse((req.query as any).limit ?? 30);
      const offset = z.coerce.number().int().min(0).max(5000).default(0)
        .parse((req.query as any).offset ?? 0);
      return withTenant(req.user.tid, async (c) => {
        const { rows } = await c.query(
          `select id, listing_id, listed_name, stars, comment, basis, booking_id, search_id,
                  created_at, updated_at, reply, replied_at, withdrawn_at, hidden_at
           from directory_ratings
           where rater_user_id = $1
           order by created_at desc limit $2 offset $3`,
          [req.user.sub, limit, offset]);
        return { marks: rows };
      });
    });

  // Everything anybody has said about this company's card. RLS gives the tenant the rows it
  // stands under — both as the card's owner and as a rater — so the filter that matters here is
  // the one that keeps the list to marks *received*, and the summary is the same definer the
  // seeker's paid read uses, so the mean on the company's page cannot disagree with the board.
  app.get("/directory/ratings/received",
    { preHandler: [requireAuth, requirePermission("directory.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const card = await c.query(
          `select id, company_name, status, is_verified from directory_listings
            where tenant_id = $1 and deleted_at is null`, [req.user.tid]);
        if (!card.rowCount) {
          throw new ApiError("NO_LISTING",
            "Publish a directory listing to see the marks on your card.", 404);
        }
        const listingId = card.rows[0].id;
        const limit = z.coerce.number().int().min(1).max(100).default(30)
          .parse((req.query as any).limit ?? 30);
        const offset = z.coerce.number().int().min(0).max(5000).default(0)
          .parse((req.query as any).offset ?? 0);
        const { rows } = await c.query(
          `select id, stars, comment, basis, booking_id, search_id, rater_name, rater_kind,
                  created_at, reply, replied_at, withdrawn_at, hidden_at, hidden_reason
           from directory_ratings
           where listing_id = $1 and listed_tenant_id = $2
           order by created_at desc limit $3 offset $4`,
          [listingId, req.user.tid, limit, offset]);
        const summary = await c.query(
          "select platform_auth.directory_rating_summary($1) as s", [listingId]);
        // canAnswer is the desk's own question, not a hint: the reply is written once, so a
        // page that offered a box on an answered mark would be a form that fails on Save.
        return {
          listing: card.rows[0], marks: rows,
          summary: summary.rows[0]?.s ?? null,
          canAnswer: await checkPermission(c, req.user.sub, "directory.manage")
        };
      });
    });

  // The company's side of a mark, once. The definer checks the hand against the card, so a seat
  // that holds the duty but stands under a different account is refused there rather than here.
  app.post("/directory/ratings/:id/reply",
    { preHandler: [requireAuth, requirePermission("directory.manage")] },
    async (req: any) => {
      await enforceRateLimit(`directory-reply:uid:${req.user.sub}`, 20, 3600);
      const ratingId = z.string().uuid().parse((req.params as any).id);
      const body = replySchema.parse(req.body);
      const r = await pool.query(
        "select platform_auth.reply_to_rating($1,$2,$3,$4,$5) as r",
        [ratingId, body.reply, req.user.sub, actorRole(req), req.ip]);
      const res = r.rows[0]?.r ?? {};
      const refusal = markRefusal(res, "reply", "The answer could not be recorded.");
      if (refusal) throw refusal;
      return { ratingId: res.rating_id, repliedAt: res.replied_at };
    });

  // The author takes their own mark off the board. The row and its slot both stay — 131 drew it
  // that way so that deleting a review is not how anybody earns a second one.
  app.post("/directory/ratings/:id/withdraw",
    { preHandler: [requireAuth] },
    async (req: any) => {
      await enforceRateLimit(`directory-withdraw:uid:${req.user.sub}`, 20, 3600);
      const ratingId = z.string().uuid().parse((req.params as any).id);
      const r = await pool.query(
        "select platform_auth.withdraw_rating($1,$2,$3,$4) as r",
        [ratingId, req.user.sub, actorRole(req), req.ip]);
      const res = r.rows[0]?.r ?? {};
      const refusal = markRefusal(res, "ratingId", "The mark could not be withdrawn.");
      if (refusal) throw refusal;
      return { ratingId: res.rating_id, withdrawnAt: res.withdrawn_at, already: res.already ?? false };
    });

  // Retyping one's own mark, up until the company answers it. The keeper trigger is what makes
  // that deadline real; this door only names the author and checks the shape, and says so when
  // the answer has already landed, because "your words changed under my reply" is a sentence the
  // desk needs to read out loud rather than discover in a silent 409.
  app.post("/directory/ratings/:id/edit",
    { preHandler: [requireAuth] },
    async (req: any) => {
      await enforceRateLimit(`directory-edit:uid:${req.user.sub}`, 20, 3600);
      const ratingId = z.string().uuid().parse((req.params as any).id);
      const body = editSchema.parse(req.body);
      const r = await pool.query(
        "select platform_auth.edit_rating($1,$2,$3,$4,$5,$6) as r",
        [ratingId, body.stars, body.comment ?? null, req.user.sub, actorRole(req), req.ip]);
      const res = r.rows[0]?.r ?? {};
      const refusal = markRefusal(res, "stars", "The mark could not be retyped.");
      if (refusal) throw refusal;
      return {
        ratingId: res.rating_id, stars: res.stars, comment: res.comment,
        listingId: res.listing_id
      };
    });

  // The office's own directory desk — passes, listings, marks and the register of holds — lives
  // in control-directory.routes.ts on `control.directory.*` duties. The four routes 061 minted
  // here were gated by a role test and moved there in 131's stage.
}
