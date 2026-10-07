import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

const clientSchema = z.object({
  name: z.string().trim().min(2).max(160),
  tin: z.string().trim().max(20).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  phone: e164.nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

export async function clientsRoutes(app: FastifyInstance, _opts: unknown) {

  app.get("/clients", { preHandler: [requireAuth, requirePermission("customers.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select id, name, tin, email, address, notes, created_at,
                (phone_search is not null) as has_phone
         from clients
         where tenant_id = $1 and deleted_at is null
         order by name`, [req.user.tid]));
      return rows;
    });

  app.post("/clients", { preHandler: [requireAuth, requirePermission("customers.create")] },
    async (req: any, reply) => {
      const body = clientSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into clients (id, tenant_id, name, tin, email,
             phone_encrypted, phone_search, address, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          [id, req.user.tid, body.name, body.tin ?? null, body.email ?? null,
           body.phone ? encryptField(body.phone) : null,
           body.phone ? searchHash(body.phone) : null,
           body.address ?? null, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "clients", entityId: id,
          action: "client.created",
          after: { name: body.name, tin: body.tin ?? null }
        });
      });
      return reply.status(201).send({ id });
    });

  // ---------- Edit (presence-based; blank phone keeps the stored value) ----------
  app.put("/clients/:id", { preHandler: [requireAuth, requirePermission("customers.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = clientSchema.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select name, phone_search from clients where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Client not found", 404);

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("name" in body) set("name", body.name!);
        if ("tin" in body) set("tin", body.tin ?? null);
        if ("email" in body) set("email", body.email ?? null);
        if ("phone" in body) {
          set("phone_encrypted", body.phone != null ? encryptField(body.phone) : null);
          set("phone_search", body.phone != null ? searchHash(body.phone) : null);
        }
        if ("address" in body) set("address", body.address ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);

        if (sets.length) {
          await c.query(
            `update clients set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`,
            params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "clients", entityId: id,
          action: "client.updated",
          before: { phone_search: prev.rows[0].phone_search },
          after: { name: body.name ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/clients/:id", { preHandler: [requireAuth, requirePermission("customers.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update clients set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "clients", entityId: id,
            action: "client.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Client not found", 404);
      return reply.send({ ok: true });
    });
}
