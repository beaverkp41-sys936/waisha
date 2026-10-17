import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";

export async function contentRoutes(app: FastifyInstance, _opts: unknown) {
  app.get("/content/footer", async (req: any) => {
    const locale = req.query?.lang === "sw" ? "sw" : "en";
    const { rows } = await pool.query(
      "select key, value from content_blocks where locale = $1", [locale]);
    const map = Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    return {
      brand: map["footer.brand"] ?? "T ENGO AEGIS",
      supportEmail: map["footer.support_email"] ?? "support@tengoaegis.com",
      phone: map["footer.phone"] ?? ""
    };
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