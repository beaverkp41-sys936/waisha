import type { FastifyRequest } from "fastify";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "./jwt.js";
import type { AccessClaims } from "./jwt.js";

/**
 * Audience boundary. A shipper portal account lives inside the transporter's
 * tenant (migration 040), so tenant scoping alone cannot keep it out of the
 * staff API: with only `portal.view`/`portal.upload` it still passed every
 * `requireAuth`-only route and could create drivers (NIDA numbers), delete
 * trips or start a licence trial in somebody else's company. Permission keys
 * gate individual modules; this gate decides WHICH SURFACE a token may knock
 * on at all.
 *
 * A seeker (060) is the same hole with the tenant problem removed. It owns its
 * own tenant shell, so it cannot reach into a stranger's company — but it carries
 * no company keys at all, and until `seeker` was listed below its token took the
 * staff fast path and passed every `requireAuth`-only route in the API.
 */

/** Roles that exist only to serve an external account — never a staff surface. */
export const PORTAL_ONLY_ROLES = ["shipper", "shipper_portal", "customer_temp", "seeker"];

/** Pure so the matrix can be unit-tested without a database. */
export function rolesArePortalOnly(roles: string[] | undefined | null): boolean {
  const list = roles ?? [];
  return !list.some((r) => !PORTAL_ONLY_ROLES.includes(r));
}

/**
 * Surfaces an external account legitimately reaches: its own portal, the auth
 * lifecycle it signs in through, and the pre-auth/public plumbing. `/auth/me`
 * and `/auth/sessions` stay open — they read only the caller's own row.
 *
 * `directory` and `seeker` are listed before their routes exist because opening
 * a prefix here is the only way a portal-only token can ever reach them, and a
 * prefix is trailing-slash-anchored so nothing else is swept in. Shipper tokens
 * pass this gate for those two too, which is safe: the keys 061 issued —
 * `directory.search`, `seeker_pass.view|create` — belong to the seeker role only,
 * so the route-level permission check still answers 403 for a shipper.
 */
const OPEN_PREFIXES = [
  "/api/v1/auth/", "/api/v1/portal/", "/api/v1/health", "/api/v1/content/",
  "/api/v1/announcements", "/api/v1/control/", "/api/v1/internal/",
  "/api/v1/payments/mock", "/api/v1/payments/webhook",
  "/api/v1/directory/", "/api/v1/seeker/",
  // The two cascades a route is named with. Parameterised, so they are anchored on the
  // slash rather than listed exactly, and nothing else can be swept in behind them.
  "/api/v1/geo/districts/", "/api/v1/geo/wards/",
  // The error intake. A portal account is a person on a page too, and the page that
  // crashes is often the one that signs them in — if this door were shut to a shipper
  // token, the portal's failures would be the only ones nobody collects. It is open
  // because it writes nothing that can be read back and attributes nothing (082).
  "/api/v1/client-errors"
];

/**
 * Global reference geography, opened one path at a time rather than by the `/api/v1/geo/`
 * prefix (task #334). A seeker who searches a road has to name it the way a transporter
 * plans one — region, then the two ends, then the towns along it — and none of these four
 * reads a tenant's row: `geo_regions`, `geo_corridors` and the OSRM proxy hold the shape of
 * Tanzania, not anybody's cargo.
 *
 * Exact paths, because a prefix here would also open `/geo/places` (a gazetteer no seeker
 * search needs) and `/geo/border-posts` (a schedule for staff clearing crossings), and any
 * `/geo/…` route added later would inherit a door nobody chose.
 */
const OPEN_PATHS = [
  "/api/v1/geo/regions", "/api/v1/geo/region-coords",
  "/api/v1/geo/corridors", "/api/v1/geo/road-route"
];

/**
 * The health surface, listed here because this file owns what is open to every caller: the
 * root the deploy platform probes (a bare 404 there reads the same as a dead service), the
 * readiness twin that is allowed to answer 503, and the prefixed alias the portal client and
 * the smoke suites learned first. The route registration and the IP-limiter exemption both
 * read these constants, so a path cannot be added to one list and forgotten in another.
 */
export const HEALTH_LIVENESS = "/health";
export const HEALTH_READINESS = "/health/ready";
export const HEALTH_ALIAS = "/api/v1/health";
const HEALTH_PATHS: string[] = [HEALTH_LIVENESS, HEALTH_READINESS, HEALTH_ALIAS];

export function isHealthPath(url: string): boolean {
  return HEALTH_PATHS.includes(url.split("?")[0]);
}

export function isOpenSurface(url: string): boolean {
  // The root health probes are exact paths, not a prefix: "/health" sits at the root of
  // the service, where anything added beside it later should not inherit an open door.
  const path = url.split("?")[0];
  return isHealthPath(url) || OPEN_PATHS.includes(path) ||
    OPEN_PREFIXES.some((p) => path.startsWith(p));
}

export async function requireStaffAudience(
  req: FastifyRequest & { user?: any; authClaims?: AccessClaims }
) {
  if (isOpenSurface(req.url)) return;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  // No/invalid token: leave it to the route's own requireAuth so the response
  // shape stays what clients already expect (401 TOKEN_EXPIRED).
  if (!bearer) return;
  const claims = await verifyAccessToken(bearer);
  if (!claims) return;
  // Hand the verified claims to the next global hook rather than making it pay for a second
  // jose verify of the same bytes. Surfaces this function returns on before reaching here
  // (the open prefixes) leave it unset, and the reader falls back to verifying.
  req.authClaims = claims;
  if (!rolesArePortalOnly(claims.roles)) return; // staff fast path, no extra query

  // The claim set looks portal-only. Confirm against the database before
  // denying, so a freshly promoted account whose token still carries the old
  // role set is not locked out of the staff surface.
  const result = await withTenant(claims.tid, (c) => c.query(
    `select coalesce(array_agg(r.key), '{}') as roles
     from user_roles ur join roles r on r.id = ur.role_id
     where ur.user_id = $1 and (ur.expires_at is null or ur.expires_at > now())`,
    [claims.sub]));
  const live: string[] = result.rows[0]?.roles ?? [];
  if (!rolesArePortalOnly(live)) return;
  throw new ApiError("FORBIDDEN", "This surface is not available to portal accounts.", 403);
}
