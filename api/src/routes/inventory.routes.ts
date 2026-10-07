import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const itemSchema = z.object({
  name: z.string().trim().min(2).max(160),
  partNumber: z.string().trim().max(60).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  quantity: z.number().nonnegative().max(1_000_000).optional(),
  minQuantity: z.number().nonnegative().max(1_000_000).optional(),
  unitCost: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

export async function inventoryRoutes(app: FastifyInstance, _opts: unknown) {

  app.get("/inventory", { preHandler: [requireAuth, requirePermission("garage.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select id, name, part_number, category, quantity, min_quantity,
                unit_cost, location, notes, created_at,
                case when quantity <= min_quantity then 'low' else 'ok' end as stock_status
         from inventory_items
         where tenant_id = $1 and deleted_at is null
         order by (quantity <= min_quantity) desc, name`, [req.user.tid]));

      const low = rows.filter((r: any) => r.stock_status === "low").length;
      return { items: rows, lowCount: low, totalItems: rows.length };
    });

  app.post("/inventory", { preHandler: [requireAuth, requirePermission("garage.create")] },
    async (req: any, reply) => {
      const body = itemSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into inventory_items (id, tenant_id, name, part_number, category,
             quantity, min_quantity, unit_cost, location, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
          [id, req.user.tid, body.name, body.partNumber ?? null, body.category ?? null,
           body.quantity ?? 0, body.minQuantity ?? 0, body.unitCost ?? null,
           body.location ?? null, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "inventory_items", entityId: id,
          action: "inventory.created",
          after: { name: body.name, partNumber: body.partNumber ?? null, quantity: body.quantity ?? 0 }
        });
      });
      return reply.status(201).send({ id });
    });

  // ---------- Adjust stock / edit (presence-based) ----------
  app.put("/inventory/:id", { preHandler: [requireAuth, requirePermission("garage.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = itemSchema.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select name from inventory_items where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Inventory item not found", 404);

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("name" in body) set("name", body.name!);
        if ("partNumber" in body) set("part_number", body.partNumber ?? null);
        if ("category" in body) set("category", body.category ?? null);
        if ("quantity" in body) set("quantity", body.quantity ?? 0);
        if ("minQuantity" in body) set("min_quantity", body.minQuantity ?? 0);
        if ("unitCost" in body) set("unit_cost", body.unitCost ?? null);
        if ("location" in body) set("location", body.location ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);

        if (sets.length) {
          await c.query(
            `update inventory_items set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`,
            params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "inventory_items", entityId: id,
          action: "inventory.updated",
          after: { quantity: body.quantity ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/inventory/:id", { preHandler: [requireAuth, requirePermission("garage.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update inventory_items set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "inventory_items", entityId: id,
            action: "inventory.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Inventory item not found", 404);
      return reply.send({ ok: true });
    });
}
