import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { CONTENT_FIELDS, decode } from "../content/fields.js";

/**
 * The platform's own copy, served to whoever is reading it.
 *
 * Both endpoints are public and unauthenticated: they answer before anybody has signed in,
 * on pages (the marketing shell, the sign-in card) that exist precisely for people who have
 * not. Nothing here is a company's data — it is the words the platform chose for itself, and
 * the control desk that edits them is `/control/content` (100, #243).
 *
 * The key → wire name mapping comes from `src/content/fields.ts` rather than being written
 * out again below, so a block added to the desk cannot be forgotten by the page that reads
 * it. An absent block falls back to the words the pages shipped with; an empty one is a
 * deliberate "do not show this", which is how a line is removed without deleting the row.
 */

/** The two contact lines every footer on the system has always carried. The brand mark is
 *  not one of them: 105 moved it to the sign-in card, because a bar whose job is to be read
 *  out loud to a caller is the wrong place for advertising. */
const FOOTER_FALLBACK: Record<string, string> = {
  supportEmail: "support@tengoaegis.com",
  phone: ""
};

/** The sign-in microcopy, worded as it is on the page today. These are the fallback
 *  for a block nobody has written yet, so they are the page's own sentences — a desk that
 *  saves nothing must not be able to change what the sign-in card says.
 *  `signup.success.*` is the company door only: the seeker tab answers a verified search
 *  account, which is a different sentence about a different thing. */
const COPY_FALLBACK: Record<string, string> = {
  loginSubtitle: "Sign in to WAISHA",
  signupSuccessTitle: "Account successfully created",
  signupSuccessBody: "Sign in with your TIN and email to reach your workspace.",
  loginBrand: "powered by T ENGO AEGIS"
};

async function blocks(locale: "en" | "sw"): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    "select key, value from content_blocks where locale = $1", [locale]);
  return new Map(rows.map((r: any) => [r.key, r.value] as [string, string]));
}

function wireOf(group: "footer" | "signin", map: Map<string, string>,
  fallback: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const f of CONTENT_FIELDS.filter((x) => x.group === group)) {
    out[f.wire] = map.has(f.key) ? decode(f, map.get(f.key) as string)
      : (fallback[f.wire] ?? (f.kind === "links" || f.kind === "social" ? [] : ""));
  }
  return out;
}

export async function contentRoutes(app: FastifyInstance, _opts: unknown) {
  app.get("/content/footer", async (req: any) => {
    const locale = req.query?.lang === "sw" ? "sw" : "en";
    return wireOf("footer", await blocks(locale), FOOTER_FALLBACK);
  });

  app.get("/content/copy", async (req: any) => {
    const locale = req.query?.lang === "sw" ? "sw" : "en";
    return wireOf("signin", await blocks(locale), COPY_FALLBACK);
  });

  /**
   * The three bundles, priced by the platform (060) and edited in the control panel.
   * Public and unauthenticated on purpose: it is the price list a company reads before
   * it decides to sign up, so a visitor must see it without a token — and the signup
   * form must offer the real rows rather than a copy pasted into the client, which is
   * how a repriced bundle starts being sold at its old price.
   *
   * Only the columns a buyer needs. Currency, seat limit and the three cycle prices
   * are the whole row; `is_active` and `sort` are consumed by the WHERE and the
   * ORDER BY instead of being sent, and the internal id is not sent at all, because
   * signup takes the stable `key`.
   */
  app.get("/content/service-groups", async () => {
    const { rows } = await pool.query(
      `select key, name, description, services, seat_limit,
              price_monthly, price_quarterly, price_annual, currency
       from service_groups where is_active order by sort`);
    return rows;
  });
}