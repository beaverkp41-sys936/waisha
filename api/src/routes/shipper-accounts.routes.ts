import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { hashPassword } from "../security/argon2.js";
import { passwordSchema } from "../security/password.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +255712345678");

const createSchema = z.object({
  clientId: z.string().uuid(),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: e164.nullable().optional(),
  password: passwordSchema,
  notes: z.string().trim().max(500).nullable().optional()
});

const updateSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: e164.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  password: passwordSchema.optional()
});

export async function shipperAccountsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Register ----------
  app.get("/shipper-accounts", { preHandler: [requireAuth, requirePermission("shipper_accounts.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select sa.id, sa.client_id, c.name as client_name, sa.user_id,
                u.full_name, u.email, u.status as user_status, sa.status, sa.notes,
                sa.invited_at, ib.full_name as invited_by_name,
                (u.phone_search is not null) as has_phone,
                (select count(*)::int from cargo_shipments cs
                  where cs.tenant_id = sa.tenant_id and cs.deleted_at is null
                    and (lower(trim(cs.consignee_name)) = lower(trim(c.name))
                      or lower(trim(cs.consignor_name)) = lower(trim(c.name)))) as matched_files,
                (select count(*)::int from shipper_file_shares sfs
                  where sfs.shipper_account_id = sa.id and sfs.deleted_at is null) as shared_files,
                (select count(*)::int from freight_invoices i
                  where i.tenant_id = sa.tenant_id and i.deleted_at is null
                    and lower(trim(i.customer_name)) = lower(trim(c.name))) as invoice_count
         from shipper_accounts sa
         join clients c on c.id = sa.client_id
         join users u on u.id = sa.user_id
         left join users ib on ib.id = sa.invited_by
         where sa.tenant_id = $1 and sa.deleted_at is null
         order by c.name, u.full_name`, [req.user.tid]));
      return rows;
    });

  // ---------- Create account (user + role grant + account row) ----------
  app.post("/shipper-accounts", { preHandler: [requireAuth, requirePermission("shipper_accounts.create")] },
    async (req: any, reply) => {
      const body = createSchema.parse(req.body);
      const accountId = uuidv7();
      const userId = uuidv7();
      const passwordHash = await hashPassword(body.password);

      try {
        await withTenant(req.user.tid, async (c) => {
          const client = await c.query(
            `select id, name from clients where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.clientId, req.user.tid]);
          if (!client.rowCount) throw new ApiError("NOT_FOUND", "Client not found", 404);

          const dupe = await c.query(
            `select id from users where email_normalized_search = $1`,
            [searchHash(body.email)]);
          if (dupe.rowCount) {
            throw new ApiError("CONFLICT", "This email is already registered on the platform", 409);
          }

          await c.query(
            `insert into users (id, tenant_id, user_type, email, email_normalized_search,
               phone_encrypted, phone_search, password_hash, status, full_name, created_by, updated_by)
             values ($1,$2,'shipper',$3,$4,$5,$6,$7,'active',$8,$9,$9)`,
            [userId, req.user.tid, body.email, searchHash(body.email),
             body.phone ? encryptField(body.phone) : null,
             body.phone ? searchHash(body.phone) : null,
             passwordHash, body.fullName, req.user.sub]);

          await c.query(
            `insert into user_roles (user_id, role_id, granted_by)
             select $1, id, $2 from roles where tenant_id is null and key = 'shipper_portal'
             on conflict do nothing`,
            [userId, req.user.sub]);

          await c.query(
            `insert into shipper_accounts (id, tenant_id, client_id, user_id, status,
               invited_by, notes, created_by, updated_by)
             values ($1,$2,$3,$4,'active',$5,$6,$7,$7)`,
            [accountId, req.user.tid, body.clientId, userId,
             req.user.sub, body.notes ?? null, req.user.sub]);

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "shipper_accounts", entityId: accountId,
            action: "shipper_account.created",
            after: { client: client.rows[0].name, email: body.email, fullName: body.fullName }
          });
        });
      } catch (e: any) {
        if (e?.code === "23505") {
          throw new ApiError("CONFLICT", "This email is already registered on the platform", 409);
        }
        throw e;
      }
      return reply.status(201).send({ id: accountId, userId });
    });

  // ---------- Account detail: auto-matched files + explicit shares ----------
  app.get("/shipper-accounts/:id", { preHandler: [requireAuth, requirePermission("shipper_accounts.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const acc = await c.query(
          `select sa.id, sa.client_id, c.name as client_name, sa.user_id, u.full_name, u.email,
                  u.status as user_status, sa.status, sa.notes, sa.invited_at,
                  (u.phone_search is not null) as has_phone
           from shipper_accounts sa
           join clients c on c.id = sa.client_id
           join users u on u.id = sa.user_id
           where sa.id = $1 and sa.tenant_id = $2 and sa.deleted_at is null`,
          [id, req.user.tid]);
        if (!acc.rowCount) throw new ApiError("NOT_FOUND", "Shipper account not found", 404);

        const matched = await c.query(
          `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                  cs.eta::text as eta, cs.consignee_name, cs.consignor_name, cs.payment_status
           from cargo_shipments cs
           where cs.tenant_id = $1 and cs.deleted_at is null
             and exists (
               select 1 from shipper_accounts sa
               join clients c on c.id = sa.client_id and c.deleted_at is null
               where sa.id = $2 and sa.tenant_id = $1 and sa.deleted_at is null
                 and (lower(trim(cs.consignee_name)) = lower(trim(c.name))
                   or lower(trim(cs.consignor_name)) = lower(trim(c.name))))
           order by cs.file_number`, [req.user.tid, id]);

        const shared = await c.query(
          `select cs.id, cs.file_number, cs.stage, cs.status, sfs.created_at as shared_at
           from shipper_file_shares sfs
           join cargo_shipments cs on cs.id = sfs.shipment_id
           where sfs.tenant_id = $1 and sfs.shipper_account_id = $2 and sfs.deleted_at is null
           order by sfs.created_at desc`, [req.user.tid, id]);

        return { account: acc.rows[0], matchedFiles: matched.rows, sharedFiles: shared.rows };
      });
    });

  // ---------- Edit (presence-based; password change revokes sessions) ----------
  app.put("/shipper-accounts/:id", { preHandler: [requireAuth, requirePermission("shipper_accounts.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = updateSchema.parse(req.body);
      const passwordHash = body.password ? await hashPassword(body.password) : null;

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select sa.user_id, sa.status, sa.notes, u.full_name, u.status as user_status
           from shipper_accounts sa join users u on u.id = sa.user_id
           where sa.id = $1 and sa.tenant_id = $2 and sa.deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Shipper account not found", 404);
        const userId = prev.rows[0].user_id;

        const uSets: string[] = [];
        const uParams: unknown[] = [userId, req.user.sub];
        const uSet = (col: string, val: unknown) => {
          uParams.push(val);
          uSets.push(`${col} = $${uParams.length}`);
        };
        if ("fullName" in body) uSet("full_name", body.fullName!);
        if ("phone" in body) {
          uSet("phone_encrypted", body.phone != null ? encryptField(body.phone) : null);
          uSet("phone_search", body.phone != null ? searchHash(body.phone) : null);
        }
        if ("password" in body) uSet("password_hash", passwordHash);
        if ("status" in body) uSet("status", body.status!);
        if (uSets.length) {
          await c.query(
            `update users set ${["updated_by = $2", ...uSets].join(", ")} where id = $1`, uParams);
        }

        const aParams: unknown[] = [id, req.user.sub, req.user.tid];
        const aSets: string[] = [];
        const aSet = (col: string, val: unknown) => {
          aParams.push(val);
          aSets.push(`${col} = $${aParams.length}`);
        };
        if ("notes" in body) aSet("notes", body.notes ?? null);
        if ("status" in body) aSet("status", body.status!);
        if (aSets.length) {
          await c.query(
            `update shipper_accounts set ${["updated_by = $2", "updated_at = now()", ...aSets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`, aParams);
        }

        if ("password" in body) {
          await c.query(
            `update sessions set revoked_at = now(), revoked_reason = 'password_reset'
             where user_id = $1 and revoked_at is null`, [userId]);
        }
        if (body.status === "suspended") {
          await c.query(
            `update sessions set revoked_at = now(), revoked_reason = 'account_suspended'
             where user_id = $1 and revoked_at is null`, [userId]);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "shipper_accounts", entityId: id,
          action: "shipper_account.updated",
          before: { status: prev.rows[0].status },
          after: { status: body.status ?? null, passwordChanged: "password" in body }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Delete: account, login and sessions all go together ----------
  app.delete("/shipper-accounts/:id", { preHandler: [requireAuth, requirePermission("shipper_accounts.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select user_id from shipper_accounts
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Shipper account not found", 404);
        const userId = prev.rows[0].user_id;

        await c.query(
          `update shipper_accounts set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        await c.query(
          `update users set deleted_at = now(), updated_by = $2 where id = $1`,
          [userId, req.user.sub]);
        await c.query(
          `update sessions set revoked_at = now(), revoked_reason = 'account_removed'
           where user_id = $1 and revoked_at is null`, [userId]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "shipper_accounts", entityId: id,
          action: "shipper_account.deleted"
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Share a cargo file explicitly ----------
  app.post("/shipper-accounts/:id/shares", { preHandler: [requireAuth, requirePermission("shipper_accounts.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const { shipmentId } = z.object({ shipmentId: z.string().uuid() }).parse(req.body);
      const shareId = uuidv7();

      await withTenant(req.user.tid, async (c) => {
        const acc = await c.query(
          `select id from shipper_accounts
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!acc.rowCount) throw new ApiError("NOT_FOUND", "Shipper account not found", 404);

        const file = await c.query(
          `select id, file_number from cargo_shipments
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [shipmentId, req.user.tid]);
        if (!file.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);

        await c.query(
          `insert into shipper_file_shares (id, tenant_id, shipper_account_id, shipment_id, shared_by)
           values ($1,$2,$3,$4,$5)`,
          [shareId, req.user.tid, id, shipmentId, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "shipper_file_shares", entityId: shareId,
          action: "shipper_share.added",
          after: { shipperAccountId: id, fileNumber: file.rows[0].file_number }
        });
      });
      return reply.status(201).send({ id: shareId });
    });

  app.delete("/shipper-accounts/:id/shares/:shipmentId",
    { preHandler: [requireAuth, requirePermission("shipper_accounts.edit")] },
    async (req: any, reply) => {
      const { id, shipmentId } = req.params as { id: string; shipmentId: string };
      await withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `update shipper_file_shares set deleted_at = now()
           where shipper_account_id = $1 and shipment_id = $2 and tenant_id = $3 and deleted_at is null`,
          [id, shipmentId, req.user.tid]);
        if (!r.rowCount) throw new ApiError("NOT_FOUND", "Share not found", 404);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "shipper_file_shares", entityId: shipmentId,
          action: "shipper_share.removed", after: { shipperAccountId: id }
        });
      });
      return reply.send({ ok: true });
    });
}
