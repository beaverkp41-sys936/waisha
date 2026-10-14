import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { namesMatch } from "../util/name-match.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const entrySchema = z.object({
  partyName: z.string().trim().min(2).max(160),
  tin: z.string().trim().max(20).nullable().optional(),
  reason: z.string().trim().min(3).max(500),
  source: z.enum(["tra", "customs", "court", "police", "internal", "other"]).default("internal"),
  severity: z.enum(["high", "medium", "low"]).default("high"),
  notes: z.string().trim().max(500).nullable().optional()
});

const licenceSchema = z.object({
  authority: z.enum(["tra", "brela", "tpa", "other"]).default("tra"),
  title: z.string().trim().min(2).max(160),
  licenceNumber: z.string().trim().max(60).nullable().optional(),
  issuedDate: dateOnly.nullable().optional(),
  expiryDate: dateOnly,
  notes: z.string().trim().max(500).nullable().optional()
});

interface WatchEntry { id: string; party_name: string; severity: string; reason: string }
interface Match {
  entryId: string; entryName: string; severity: string;
  field: string; name: string;
}

/** Every watchlist entry whose name matches any of the queried parties. */
function matchesFor(entries: WatchEntry[], pairs: [field: string, name: string][]): Match[] {
  const out: Match[] = [];
  for (const [field, name] of pairs) {
    for (const e of entries) {
      if (namesMatch(name, e.party_name)) {
        out.push({ entryId: e.id, entryName: e.party_name, severity: e.severity, field, name });
      }
    }
  }
  return out;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export async function complianceRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Watchlist register ----------

  app.get("/screening/entries", { preHandler: [requireAuth, requirePermission("screening.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select id, party_name, tin, reason, source, severity, status, notes, created_at
         from screening_entries
         where tenant_id = $1 and deleted_at is null
         order by status, case severity when 'high' then 0 when 'medium' then 1 else 2 end, party_name`,
        [req.user.tid]));
      return rows;
    });

  app.post("/screening/entries", { preHandler: [requireAuth, requirePermission("screening.create")] },
    async (req: any, reply) => {
      const body = entrySchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into screening_entries (id, tenant_id, party_name, tin, reason, source, severity, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [id, req.user.tid, body.partyName, body.tin ?? null, body.reason,
           body.source, body.severity, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "screening", entityId: id,
          action: "screening.entry_created",
          after: { partyName: body.partyName, severity: body.severity, source: body.source }
        });
      });
      return reply.status(201).send({ id });
    });

  app.put("/screening/entries/:id", { preHandler: [requireAuth, requirePermission("screening.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = entrySchema.partial()
        .extend({ status: z.enum(["active", "lifted"]).optional() })
        .parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select party_name, status from screening_entries where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Watchlist entry not found", 404);

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("partyName" in body) set("party_name", body.partyName);
        if ("tin" in body) set("tin", body.tin ?? null);
        if ("reason" in body) set("reason", body.reason);
        if ("source" in body) set("source", body.source);
        if ("severity" in body) set("severity", body.severity);
        if ("status" in body) set("status", body.status);
        if ("notes" in body) set("notes", body.notes ?? null);

        if (sets.length) {
          await c.query(
            `update screening_entries set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`, params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "screening", entityId: id,
          action: "screening.entry_updated",
          before: { partyName: prev.rows[0].party_name, status: prev.rows[0].status },
          after: { partyName: body.partyName ?? null, status: body.status ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/screening/entries/:id", { preHandler: [requireAuth, requirePermission("screening.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update screening_entries set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "screening", entityId: id,
            action: "screening.entry_deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Watchlist entry not found", 404);
      return reply.send({ ok: true });
    });

  // ---------- Live match sweep: which open files and clients are flagged ----------

  app.get("/screening/matches", { preHandler: [requireAuth, requirePermission("screening.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const entries = (await c.query(
          `select id, party_name, severity, reason from screening_entries
           where tenant_id = $1 and deleted_at is null and status = 'active'`,
          [req.user.tid])).rows as WatchEntry[];

        const files: any[] = [];
        const clients: any[] = [];
        if (entries.length) {
          const openFiles = await c.query(
            `select id, file_number, consignee_name, consignor_name from cargo_shipments
             where tenant_id = $1 and deleted_at is null and status = 'open'`,
            [req.user.tid]);
          for (const f of openFiles.rows) {
            const matches = matchesFor(entries, [
              ["consignee", f.consignee_name], ["consignor", f.consignor_name]
            ]);
            if (matches.length) {
              files.push({ subjectType: "file", subjectId: f.id, label: f.file_number, matches });
            }
          }
          const clientRows = await c.query(
            "select id, name from clients where tenant_id = $1 and deleted_at is null", [req.user.tid]);
          for (const cl of clientRows.rows) {
            const matches = matchesFor(entries, [["name", cl.name]]);
            if (matches.length) {
              clients.push({ subjectType: "client", subjectId: cl.id, label: cl.name, matches });
            }
          }
        }
        const worst = (m: Match[]) => Math.min(...m.map((x) => SEVERITY_RANK[x.severity] ?? 9));
        files.sort((a, b) => worst(a.matches) - worst(b.matches) || String(a.label).localeCompare(String(b.label)));
        clients.sort((a, b) => worst(a.matches) - worst(b.matches) || String(a.label).localeCompare(String(b.label)));
        return { files, clients };
      });
    });

  // ---------- Run a screening check and log it ----------

  app.post("/screening/run", { preHandler: [requireAuth, requirePermission("screening.create")] },
    async (req: any, reply) => {
      const body = z.object({
        shipmentId: z.string().uuid().optional(),
        clientId: z.string().uuid().optional()
      }).refine((b) => !!b.shipmentId !== !!b.clientId, {
        message: "Provide exactly one of shipmentId or clientId."
      }).parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        let subjectType: "shipment" | "client";
        let subjectId: string;
        let label: string;
        let pairs: [string, string][];

        if (body.shipmentId) {
          const f = await c.query(
            `select file_number, consignee_name, consignor_name from cargo_shipments
             where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.shipmentId, req.user.tid]);
          if (!f.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
          subjectType = "shipment";
          subjectId = body.shipmentId;
          label = f.rows[0].file_number;
          pairs = [["consignee", f.rows[0].consignee_name], ["consignor", f.rows[0].consignor_name]];
        } else {
          const cl = await c.query(
            "select name from clients where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.clientId, req.user.tid]);
          if (!cl.rowCount) throw new ApiError("NOT_FOUND", "Client not found", 404);
          subjectType = "client";
          subjectId = body.clientId!;
          label = cl.rows[0].name;
          pairs = [["name", cl.rows[0].name]];
        }

        const entries = (await c.query(
          `select id, party_name, severity, reason from screening_entries
           where tenant_id = $1 and deleted_at is null and status = 'active'`,
          [req.user.tid])).rows as WatchEntry[];
        const matches = matchesFor(entries, pairs);
        const result = matches.length ? "hit" : "clear";
        const id = uuidv7();

        await c.query(
          `insert into screening_checks (id, tenant_id, subject_type, subject_id, subject_label, result, matches, checked_by)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [id, req.user.tid, subjectType, subjectId, label, result, JSON.stringify(matches), req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "screening", entityId: id,
          action: "screening.checked",
          after: { subjectType, subjectId, result, matchCount: matches.length }
        });
        return { id, subjectType, subjectId, subjectLabel: label, result, matches };
      });
      return reply.status(201).send(out);
    });

  app.get("/screening/checks", { preHandler: [requireAuth, requirePermission("screening.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select k.id, k.subject_type, k.subject_id, k.subject_label, k.result, k.matches,
                k.checked_at, u.full_name as checked_by_name
         from screening_checks k
         left join users u on u.id = k.checked_by
         where k.tenant_id = $1
         order by k.checked_at desc
         limit 25`,
        [req.user.tid]));
      return rows;
    });

  // ---------- Regulatory licence register ----------

  app.get("/licences", { preHandler: [requireAuth, requirePermission("licences.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select l.id, l.authority, l.title, l.licence_number,
                l.issued_date::text as issued_date, l.expiry_date::text as expiry_date, l.notes,
                (l.expiry_date - current_date)::int as days,
                case when l.expiry_date < current_date then 'expired'
                     when l.expiry_date <= current_date + 30 then 'expiring'
                     else 'valid' end as status,
                (select count(*)::int from documents d
                  where d.tenant_id = l.tenant_id and d.entity_type = 'licence'
                    and d.entity_id = l.id and d.deleted_at is null) as document_count,
                (select d.id from documents d
                  where d.tenant_id = l.tenant_id and d.entity_type = 'licence'
                    and d.entity_id = l.id and d.deleted_at is null
                  order by d.created_at desc limit 1) as latest_document_id
         from regulatory_licences l
         where l.tenant_id = $1 and l.deleted_at is null
         order by l.expiry_date asc`,
        [req.user.tid]));
      return rows;
    });

  app.post("/licences", { preHandler: [requireAuth, requirePermission("licences.create")] },
    async (req: any, reply) => {
      const body = licenceSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into regulatory_licences (id, tenant_id, authority, title, licence_number,
             issued_date, expiry_date, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [id, req.user.tid, body.authority, body.title, body.licenceNumber ?? null,
           body.issuedDate ?? null, body.expiryDate, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "licences", entityId: id,
          action: "licence.created",
          after: { title: body.title, authority: body.authority, expiryDate: body.expiryDate }
        });
      });
      return reply.status(201).send({ id });
    });

  app.put("/licences/:id", { preHandler: [requireAuth, requirePermission("licences.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = licenceSchema.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select title, expiry_date from regulatory_licences where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Licence not found", 404);

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("authority" in body) set("authority", body.authority);
        if ("title" in body) set("title", body.title);
        if ("licenceNumber" in body) set("licence_number", body.licenceNumber ?? null);
        if ("issuedDate" in body) set("issued_date", body.issuedDate ?? null);
        if ("expiryDate" in body) set("expiry_date", body.expiryDate);
        if ("notes" in body) set("notes", body.notes ?? null);

        if (sets.length) {
          await c.query(
            `update regulatory_licences set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`, params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "licences", entityId: id,
          action: "licence.updated",
          before: { title: prev.rows[0].title, expiryDate: prev.rows[0].expiry_date },
          after: { title: body.title ?? null, expiryDate: body.expiryDate ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/licences/:id", { preHandler: [requireAuth, requirePermission("licences.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update regulatory_licences set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          // Scans leave with the licence.
          await c.query(
            `update documents set deleted_at = now()
             where tenant_id = $1 and entity_type = 'licence' and entity_id = $2 and deleted_at is null`,
            [req.user.tid, id]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "licences", entityId: id,
            action: "licence.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Licence not found", 404);
      return reply.send({ ok: true });
    });
}
