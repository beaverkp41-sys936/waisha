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
}