import type { FastifyRequest } from "fastify";
import type { AccessClaims } from "./jwt.js";
import { verifyAccessToken } from "./jwt.js";
import { ApiError } from "../util/errors.js";

/**
 * The read-only promise of a borrowed seat (task #177).
 *
 * A platform support session is somebody else's login. It carries that person's tenant,
 * that person's roles and that person's permissions, because the whole point is to see the
 * desk as they see it — which also means every ordinary `requirePermission` check answers
 * exactly as it would for them, and nothing at the route level can tell the two apart.
 * The one thing that does distinguish them is the `act` claim 106 made room for, and a
 * promise that "the admin cannot break anything while looking" has to be kept somewhere
 * no route can forget. Forty-one route files repeat their own three-line `requireAuth`, so
 * a per-route rule would be a rule with forty-one places to miss it. This is the second
 * global preHandler, and it refuses writes.
 *
 * What it does not do is pretend to be RLS. Reads are the tenant's own, by design — the
 * session is the tenant's, its tenant is the one it is bound to, and it cannot reach
 * another company with or without the mark. The guard's whole job is the other half:
 * a support visit must not change a company's books.
 */

/**
 * How long a borrowed seat stays live. Deliberately a visit, not a shift.
 *
 * It matches the access-token TTL this API already mints (jwt.ts) on purpose. Revoking a
 * session cannot recall a bearer that is already signed: after an admin closes the view, or
 * a block sweeps the company, the token keeps answering reads until it expires — a fifteen-
 * minute tail every seat in the platform already has. Making the support window longer
 * would hand a borrowed seat a longer one than the person holding it, and the re-open is one
 * button on the desk.
 */
export const SUPPORT_WINDOW_MINUTES = 15;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The escape hatch is on the control surface: closing a support session is a POST, and the
 * desk that closes it is authenticated by its own cookie, not by the borrowed token. Every
 * `/api/v1/control/*` route re-proves that cookie through `requireControl` and then a duty
 * key, so a support bearer there authorises nothing — and refusing it would trap the admin
 * inside the view they came to leave.
 */
const CONTROL_PREFIX = "/api/v1/control/";

/**
 * The error intake stays writable in a support view for the same reason it stays open to a
 * portal account (audience.ts): the crash worth collecting is the one that happens while
 * somebody is looking at a company's page on a call.
 */
const INTAKE_PATH = "/api/v1/client-errors";

const pathOf = (url: string) => url.split("?")[0];

/** True for a token that is somebody's borrowed seat. Never throws; a bad token is not a support token. */
export function claimsAreBorrowed(claims: AccessClaims | null | undefined): boolean {
  return !!claims?.act;
}

export async function requireSupportReadonly(
  req: FastifyRequest & { authClaims?: AccessClaims }
): Promise<void> {
  if (READ_METHODS.has(req.method)) return;
  const path = pathOf(req.url);
  if (path.startsWith(CONTROL_PREFIX) || path === INTAKE_PATH) return;

  // audience.ts already verified this bearer for every non-open surface; ask it once.
  const claims = req.authClaims ?? (await verifyAccessToken(
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? ""
  ));
  if (!claimsAreBorrowed(claims)) return;

  throw new ApiError(
    "SUPPORT_READONLY",
    "This is a platform support view. It shows what the company sees and saves nothing.",
    403
  );
}
