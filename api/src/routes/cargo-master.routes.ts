import { createHash } from "node:crypto";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { verifyAccessToken } from "../security/jwt.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { checkPermissions, requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { prepareTable, type PreparedTable } from "../export/table.js";
import { buildPdf } from "../export/pdf.js";
import { ZipWriter, safeEntryPath } from "../export/zip.js";
import { getObject, storageConfigured } from "../storage/supabase.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fileUuid = z.string().uuid();

/**
 * A box emptied on the desk means empty. Absent from the body means "keep what is stored", which
 * is the presence rule the drivers PUT has used since the beginning — and the reason the transform
 * hands `undefined` back rather than `null`. A transform that turns a missing key into null makes
 * the route see every absent box as an emptied one: the clerk's note alone would then wipe the
 * packing list number, and on a signed sheet it would look like an attempt to rewrite a declaration.
 */
const text = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : (v && v.length ? v : null)));

const BILL_KINDS = ["bill_of_lading", "sea_waybill", "air_waybill", "rail_waybill", "road_waybill"] as const;
const BILL_LABEL: Record<string, string> = {
  bill_of_lading: "Bill of lading", sea_waybill: "Sea waybill", air_waybill: "Air waybill",
  rail_waybill: "Rail waybill", road_waybill: "Road waybill"
};

/** The three slots of a cover sheet, in the order the sheet prints them. */
const SLOTS = [
  { body: "invoiceDocumentId", column: "invoice_document_id", paper: "Commercial invoice",
    slot: "the invoice", expects: /invoice|proforma/i },
  { body: "packingDocumentId", column: "packing_document_id", paper: "Packing list",
    slot: "the packing list", expects: /packing/i },
  { body: "billDocumentId", column: "bill_document_id", paper: "Bill of lading / air waybill",
    slot: "the bill or air waybill", expects: /bill|waybill/i }
] as const;

const masterBody = z.object({
  invoiceNumber: text(80),
  invoiceDate: dateOnly.nullable().optional(),
  invoiceCurrency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  invoiceValue: z.number().nonnegative().max(1_000_000_000_000).nullable().optional(),
  packingListNumber: text(80),
  packagesCount: z.number().int().min(1).max(100_000).nullable().optional(),
  packageType: text(60),
  grossWeightKg: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  netWeightKg: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  billKind: z.enum(BILL_KINDS).nullable().optional(),
  billNumber: text(60),
  billDate: dateOnly.nullable().optional(),
  invoiceDocumentId: z.string().uuid().nullable().optional(),
  packingDocumentId: z.string().uuid().nullable().optional(),
  billDocumentId: z.string().uuid().nullable().optional(),
  notes: text(1000)
});

type Body = z.infer<typeof masterBody>;

/** camelCase in the body, snake_case in the table — the one list both halves are read from. */
const FIELDS: { body: keyof Body; column: string; phrase: string }[] = [
  { body: "invoiceNumber", column: "invoice_number", phrase: "the invoice number" },
  { body: "invoiceDate", column: "invoice_date", phrase: "the invoice date" },
  { body: "invoiceCurrency", column: "invoice_currency", phrase: "the invoice currency" },
  { body: "invoiceValue", column: "invoice_value", phrase: "the invoice value" },
  { body: "packingListNumber", column: "packing_list_number", phrase: "the packing list number" },
  { body: "packagesCount", column: "packages_count", phrase: "the package count" },
  { body: "packageType", column: "package_type", phrase: "the package type" },
  { body: "grossWeightKg", column: "gross_weight_kg", phrase: "the gross weight" },
  { body: "netWeightKg", column: "net_weight_kg", phrase: "the net weight" },
  { body: "billKind", column: "bill_kind", phrase: "the kind of transport document" },
  { body: "billNumber", column: "bill_number", phrase: "the bill or air waybill number" },
  { body: "billDate", column: "bill_date", phrase: "the bill or air waybill date" },
  { body: "invoiceDocumentId", column: "invoice_document_id", phrase: "the invoice paper" },
  { body: "packingDocumentId", column: "packing_document_id", phrase: "the packing list paper" },
  { body: "billDocumentId", column: "bill_document_id", phrase: "the bill or air waybill paper" },
  { body: "notes", column: "notes", phrase: "the note" }
];

/** 111 lets a signed sheet's papers be re-pointed and its note grow. Everything else is frozen. */
const AFTER_SIGNATURE = new Set(["invoice_document_id", "packing_document_id", "bill_document_id", "notes"]);

const FILE_SQL = `
  select id, file_number, shipment_type, status, stage, cargo_description,
         consignee_name, consignor_name, shipping_line, bill_number, container_type,
         container_count, cbm, weight_tonnes, terms_delivery,
         eta::text as eta, order_date::text as order_date
    from cargo_shipments
   where id = $1 and tenant_id = $2 and deleted_at is null`;

const MASTER_SQL = `
  select m.id, m.shipment_id,
         m.invoice_number, m.invoice_date::text as invoice_date, m.invoice_currency,
         m.invoice_value, m.packing_list_number, m.packages_count, m.package_type,
         m.gross_weight_kg, m.net_weight_kg,
         m.bill_kind, m.bill_number, m.bill_date::text as bill_date,
         m.invoice_document_id, m.packing_document_id, m.bill_document_id,
         m.notes, m.declared_by, m.declared_at, m.created_at, m.updated_at,
         du.full_name as declared_by_name,
         di.file_name as invoice_file_name, di.kind as invoice_kind,
         di.size_bytes as invoice_size_bytes,
         dp.file_name as packing_file_name, dp.kind as packing_kind,
         dp.size_bytes as packing_size_bytes,
         db.file_name as bill_file_name, db.kind as bill_paper_kind,
         db.size_bytes as bill_size_bytes
    from cargo_import_masters m
    left join users du on du.id = m.declared_by and du.tenant_id = m.tenant_id
    left join documents di on di.id = m.invoice_document_id and di.tenant_id = m.tenant_id
    left join documents dp on dp.id = m.packing_document_id and dp.tenant_id = m.tenant_id
    left join documents db on db.id = m.bill_document_id and db.tenant_id = m.tenant_id
   where m.shipment_id = $1 and m.tenant_id = $2 and m.deleted_at is null`;

/**
 * The day a sheet was signed, in the calendar of the office that signed it. `declared_at` is an
 * instant: read out of a JS Date it prints "Wed Oct 21 2026 …", and read in UTC it lands on the
 * evening before for anything stamped after nine at night in Dar es Salaam. A declaration to customs
 * has to carry a day the clerk recognises; the instant itself stays in the audit and in master.json.
 */
function signDay(v: unknown): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Dar_es_Salaam", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(v instanceof Date ? v : new Date(String(v)));
}

/** The same instant, machine-readable — never `String(date)`, which is a weekday. */
function signInstant(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

/**
 * A path id is a uuid or the request is not about a cargo file at all. Bound raw into a uuid column
 * instead, Postgres answers `invalid input syntax for type uuid` and the desk gets a 500 for a
 * mistyped link — so the shape is settled here, in the one loader every four doors go through.
 */
function fileId(raw: string): string {
  const parsed = fileUuid.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED", "That is not a cargo file id.", 400, [{ field: "id" }]);
  }
  return parsed.data;
}

/**
 * What a signature still lacks, in the database's own words.
 *
 * The route asks 111's function rather than keeping a second list of requirements in TypeScript:
 * the trigger refuses a signature on that list, so two copies of "what must be filled in" is how a
 * desk ends up with a button the database then says no to.
 */
async function gapsOf(c: PoolClient, m: Record<string, any>): Promise<string | null> {
  const r = await c.query(
    `select cargo_import_master_gaps($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) as gaps`,
    [m.shipment_id ?? null, m.invoice_number ?? null, m.invoice_date ?? null,
     m.invoice_currency ?? null, m.invoice_value ?? null, m.packing_list_number ?? null,
     m.packages_count ?? null, m.gross_weight_kg ?? null, m.bill_kind ?? null,
     m.bill_number ?? null, m.bill_date ?? null, m.invoice_document_id ?? null,
     m.packing_document_id ?? null, m.bill_document_id ?? null]);
  const gaps = (r.rows[0]?.gaps ?? null) as string | null;
  return gaps && gaps.trim() ? gaps.trim() : null;
}

/**
 * The file, its sheet, the papers it may point at, and what a signature would still need.
 *
 * Null means this company has no such cargo file. A foreign id and a deleted one give the same
 * answer, which is the answer the desk should get either way.
 */
async function loadMaster(c: PoolClient, tid: string, rawId: string) {
  const shipmentId = fileId(rawId);
  const file = await c.query(FILE_SQL, [shipmentId, tid]);
  if (!file.rowCount) return null;
  const [master, papers] = await Promise.all([
    c.query(MASTER_SQL, [shipmentId, tid]),
    c.query(
      `select id, kind, file_name, mime_type, size_bytes, created_at
         from documents
        where entity_type = 'shipment' and entity_id = $1 and tenant_id = $2
          and deleted_at is null
        order by created_at desc
        limit 200`, [shipmentId, tid])
  ]);

  const m: Record<string, any> | null = master.rows[0] ?? null;
  const gaps = await gapsOf(c, m ?? { shipment_id: shipmentId });
  const onFile = new Map(papers.rows.map((p: any) => [String(p.id), p]));

  // Two ways a sheet can be internally consistent and still be wrong on the desk: the number on
  // the bill disagrees with the number on the file, and the paper pointed at is not filed under
  // the kind of paper the slot names. 111 refuses neither — a clerk may well file a scan under
  // `other` — so both are said out loud instead of left for the customs desk to discover.
  const warnings: string[] = [];
  if (m) {
    const fileBill = String(file.rows[0].bill_number ?? "").trim();
    const masterBill = String(m.bill_number ?? "").trim();
    if (fileBill && masterBill && fileBill.toLowerCase() !== masterBill.toLowerCase()) {
      warnings.push(`The master carries bill or air waybill number ${masterBill}, the cargo file `
        + `carries ${fileBill}. One of the two is mistyped.`);
    }
    for (const slot of SLOTS) {
      const docId = m[slot.column];
      if (!docId) continue;
      const paper = onFile.get(String(docId));
      if (!paper) {
        warnings.push(`${slot.slot} points at a paper that is no longer on this cargo file.`);
        continue;
      }
      if (!slot.expects.test(String(paper.kind))) {
        warnings.push(`${slot.slot} is filed under the kind "${paper.kind}", which does not read `
          + `like ${slot.paper.toLowerCase()}.`);
      }
    }
  }

  return {
    file: file.rows[0] as Record<string, any>,
    master: m,
    papers: papers.rows as Record<string, any>[],
    state: {
      has_master: !!m,
      declared: !!m?.declared_at,
      declared_on: m?.declared_at ? signDay(m.declared_at) : null,
      declared_by: m?.declared_by_name ?? null,
      complete: gaps === null,
      gaps,
      papers_named: m ? SLOTS.filter((s) => m[s.column]).length : 0,
      can_sign: !!m && !m.declared_at && gaps === null
    },
    warnings
  };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadMaster>>>;

/** The seat's own three buttons, from one lookup rather than three. */
async function capabilities(c: PoolClient, userId: string) {
  const held = await checkPermissions(c, userId,
    ["shipments.edit", "shipments.declare", "shipments.export"]);
  return {
    edit: held.has("shipments.edit"),
    declare: held.has("shipments.declare"),
    bundle: held.has("shipments.export")
  };
}

export async function cargoMasterRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The cover sheet ----------
  app.get("/cargo/:id/master", { preHandler: [requireAuth, requirePermission("shipments.view")] },
    async (req: any) => withTenant(req.user.tid, async (c) => {
      const { id } = req.params as { id: string };
      const loaded = await loadMaster(c, req.user.tid, id);
      if (!loaded) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
      return { ...loaded, can: await capabilities(c, req.user.sub) };
    }));

  // ---------- Fill it in ----------
  app.put("/cargo/:id/master", { preHandler: [requireAuth, requirePermission("shipments.edit")] },
    async (req: any) => withTenant(req.user.tid, async (c) => {
      const { id } = req.params as { id: string };
      const body: Body = masterBody.parse(req.body);
      const loaded = await loadMaster(c, req.user.tid, id);
      if (!loaded) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
      const row = loaded.master;

      // A signed sheet's figures are the statement this office already gave. 111's trigger refuses
      // the write whatever this route believes; the 409 here exists because a clerk is answered by
      // the name of the box, and a constraint is answered by a database message.
      if (row?.declared_at) {
        const moved = FIELDS.filter((f) => f.body in body && !AFTER_SIGNATURE.has(f.column)
          && !same(row[f.column], body[f.body]));
        if (moved.length) {
          throw new ApiError("CONFLICT",
            `This master was signed on ${signDay(row.declared_at)}`
            + `${row.declared_by_name ? ` by ${row.declared_by_name}` : ""}. Its `
            + `${moved.map((f) => f.phrase).join(", ")} ${moved.length === 1 ? "is" : "are"} part of `
            + "that declaration and are not rewritten. The papers it points at and the note can "
            + "still change.", 409, moved.map((f) => ({ field: f.body })));
        }
      }

      // The shape rules are about the whole row, so they are checked against the row as it will be:
      // a value typed into a sheet that already carries an invoice number is fine, and a body that
      // sends one box must not be refused for the boxes this call left alone.
      const merged: Record<string, any> = { shipment_id: id };
      for (const f of FIELDS) merged[f.column] = (f.body in body ? body[f.body] : row?.[f.column]) ?? null;

      if (merged.net_weight_kg !== null && merged.gross_weight_kg !== null
        && Number(merged.net_weight_kg) > Number(merged.gross_weight_kg)) {
        throw new ApiError("VALIDATION_FAILED",
          "The net weight cannot be above the gross weight — the packing list says both.",
          400, [{ field: "netWeightKg" }]);
      }
      if (merged.invoice_value !== null && (!merged.invoice_number || !merged.invoice_currency)) {
        throw new ApiError("VALIDATION_FAILED",
          "A value needs the invoice number and its currency beside it, or it is a guess.",
          400, [{ field: "invoiceValue" }]);
      }

      const named = SLOTS
        .map((s) => ({ s, id: (body[s.body] ?? null) as string | null }))
        .filter((x) => x.id);
      if (named.length) {
        const own = await c.query(
          `select id from documents
             where entity_type = 'shipment' and entity_id = $1 and tenant_id = $2
               and deleted_at is null and id = any($3::uuid[])`,
          [id, req.user.tid, named.map((n) => n.id)]);
        const have = new Set(own.rows.map((r: any) => String(r.id)));
        const wrong = named.filter((n) => !have.has(String(n.id)));
        if (wrong.length) {
          throw new ApiError("VALIDATION_FAILED",
            `${wrong.map((w) => w.s.slot).join(" and ")} must be a paper already on this cargo file. `
            + "Upload it onto the file first, then point the master at it.",
            400, wrong.map((w) => ({ field: w.s.body })));
        }
      }

      const written = FIELDS.filter((f) => f.body in body);
      let saved: Record<string, any> | null = null;
      if (written.length) {
        const cols = written.map((f) => f.column);
        const values: unknown[] = [uuidv7(), req.user.tid, id, req.user.sub, req.user.sub,
          ...cols.map((col) => merged[col])];
        const holders = values.map((_v, i) => `$${i + 1}`);
        // One statement for both halves of an upsert: a second clerk opening the same sheet at the
        // same moment lands on the existing row instead of on a unique violation mid-transaction.
        const up = await c.query(
          `insert into cargo_import_masters
             (id, tenant_id, shipment_id, created_by, updated_by, ${cols.join(", ")})
           values (${holders.join(", ")})
           on conflict (tenant_id, shipment_id) where deleted_at is null
           do update set ${cols.map((col) => `${col} = excluded.${col}`).join(", ")},
                         updated_by = excluded.updated_by, updated_at = now()
           returning *`,
          values);
        saved = up.rows[0] ?? null;
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "cargo_import_masters", entityId: saved?.id ?? row?.id ?? null,
          action: row ? "master.updated" : "master.opened",
          before: row ? { declared_at: row.declared_at } : null,
          after: { file_number: loaded.file.file_number, fields: cols }
        });
      }

      const fresh = await loadMaster(c, req.user.tid, id);
      return { ...fresh, saved, can: await capabilities(c, req.user.sub) };
    }));

  // ---------- Sign it ----------
  app.post("/cargo/:id/master/declare",
    { preHandler: [requireAuth, requirePermission("shipments.declare")] },
    async (req: any) => withTenant(req.user.tid, async (c) => {
      const { id } = req.params as { id: string };
      const loaded = await loadMaster(c, req.user.tid, id);
      if (!loaded) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
      const row = loaded.master;
      if (!row) {
        throw new ApiError("CONFLICT",
          "This file has no master sheet to sign. Fill in the invoice, the packing list and the "
          + "bill or air waybill first.", 409);
      }
      if (row.declared_at) {
        throw new ApiError("CONFLICT",
          `This master was already signed on ${signDay(row.declared_at)}`
          + `${row.declared_by_name ? ` by ${row.declared_by_name}` : ""}.`, 409);
      }
      if (loaded.state.gaps) {
        throw new ApiError("VALIDATION_FAILED",
          `This sheet cannot be signed without ${loaded.state.gaps}.`, 400);
      }

      const stamped = await c.query(
        `update cargo_import_masters
            set declared_by = $3, declared_at = now(), updated_by = $3, updated_at = now()
          where shipment_id = $1 and tenant_id = $2 and deleted_at is null
            and declared_at is null
          returning declared_at`,
        [id, req.user.tid, req.user.sub]);
      if (!stamped.rowCount) {
        throw new ApiError("CONFLICT", "This master was signed a moment ago by another seat.", 409);
      }

      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
        entity: "cargo_import_masters", entityId: row.id, action: "master.declared",
        after: { file_number: loaded.file.file_number, invoice_number: row.invoice_number,
          bill_number: row.bill_number, declared_on: signDay(stamped.rows[0].declared_at),
          declared_at: signInstant(stamped.rows[0].declared_at) }
      });

      const fresh = await loadMaster(c, req.user.tid, id);
      return { ...fresh, can: await capabilities(c, req.user.sub) };
    }));

  // ---------- Bundle it ----------
  app.post("/cargo/:id/master/bundle",
    { preHandler: [requireAuth, requirePermission("shipments.export")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const gate = await withTenant(req.user.tid, async (c) => {
        const loaded = await loadMaster(c, req.user.tid, id);
        if (!loaded) return { found: false as const };
        if (!loaded.master) {
          return { found: true as const, empty: true as const };
        }
        const m = loaded.master;
        const wanted = SLOTS
          .map((s) => ({ s, id: (m[s.column] ?? null) as string | null }))
          .filter((x) => x.id);
        const docs: Record<string, any>[] = [];
        if (wanted.length) {
          const found = await c.query(
            `select id, kind, file_name, mime_type, size_bytes, storage_path
               from documents
              where tenant_id = $1 and entity_type = 'shipment' and entity_id = $2
                and deleted_at is null and id = any($3::uuid[])`,
            [req.user.tid, id, wanted.map((w) => w.id)]);
          docs.push(...found.rows);
        }
        const who = await c.query(
          "select full_name from users where id = $1 and tenant_id = $2",
          [req.user.sub, req.user.tid]);
        return {
          found: true as const, empty: false as const, ...loaded, master: m,
          actor: who.rows[0]?.full_name ?? req.user.sub,
          slots: wanted.map((w) => ({ s: w.s, doc: docs.find((d) => String(d.id) === String(w.id)) ?? null }))
        };
      });
      if (!gate.found) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
      if (gate.empty) {
        throw new ApiError("CONFLICT",
          "This file has no master sheet, so there is nothing to bundle. Fill one in first.", 409);
      }

      const actor = gate.actor;
      const generatedAt = new Date();
      const folder = safeEntryPath(`master-${gate.file.file_number}-${id.slice(0, 8)}`);

      reply.hijack();
      const res: ServerResponse = reply.raw;
      // hijack() leaves the reply pipeline, so the headers helmet and the CORS plugin had already
      // decided have to be written onto the socket by hand.
      const headers: Record<string, string> = {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${folder}.zip"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (/^access-control-/i.test(key) && value !== undefined) headers[key] = String(value);
      }
      res.writeHead(200, headers);

      const zip = new ZipWriter();
      const checksums: string[] = [];
      const missing: { entry: string; reason: string }[] = [];
      const packed: { slot: string; entry: string; bytes: number }[] = [];
      let aborted = false;
      let failure: string | null = null;
      // An operator who closes the tab mid-download must not leave this request hanging on a drain
      // that will never come.
      const stop = new AbortController();
      res.on("close", () => { if (!res.writableEnded) { aborted = true; stop.abort(); } });

      const put = async (name: string, data: Buffer): Promise<string> => {
        if (aborted) return name;
        const entry = zip.add(name, data, generatedAt);
        checksums.push(`${createHash("sha256").update(data).digest("hex")}  ${entry.name}`);
        for (const chunk of entry.chunks) {
          if (aborted || res.writableEnded) return entry.name;
          if (!res.write(chunk)) await once(res, "drain", { signal: stop.signal }).catch(() => {});
        }
        // The writer's own name, which is not always the one asked for.
        return entry.name;
      };

      try {
        const sheetEntry = await put(`${folder}/master-sheet.pdf`,
          await buildPdf(masterSheet(gate, actor, generatedAt)));

        for (const { s, doc } of gate.slots) {
          if (aborted) break;
          const entry = `${folder}/papers/${safeEntryPath(
            `${s.paper.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${doc?.file_name ?? "paper"}`)}`;
          if (!doc) {
            missing.push({ entry, reason: "the paper named on the sheet is no longer on this file" });
            continue;
          }
          if (!storageConfigured()) {
            missing.push({ entry, reason: "this deployment has no storage configured" });
            continue;
          }
          let bytes: Buffer;
          try {
            bytes = (await getObject(String(doc.storage_path))).bytes;
          } catch (e: any) {
            missing.push({ entry,
              reason: String(e?.message ?? "the stored object could not be read") });
            continue;
          }
          const written = await put(entry, bytes);
          packed.push({ slot: s.paper, entry: written, bytes: bytes.length });
        }

        await put(`${folder}/README.txt`,
          Buffer.from(masterReadme(gate, actor, generatedAt, sheetEntry, packed, missing), "utf8"));
        await put(`${folder}/master.json`,
          Buffer.from(masterRecord(gate, actor, generatedAt, sheetEntry, packed, missing), "utf8"));
        await put("SHA256SUMS.txt", Buffer.from(`${checksums.join("\n")}\n`, "utf8"));
        for (const chunk of zip.finish()) {
          if (aborted || res.writableEnded) break;
          if (!res.write(chunk)) await once(res, "drain", { signal: stop.signal }).catch(() => {});
        }
      } catch (e: any) {
        // Headers are already away, so this cannot become a 500 — it becomes an audit row and a
        // download that stops short, which is what the operator sees either way.
        failure = String(e?.message ?? e).slice(0, 300);
        req.log.error({ err: e }, "cargo master bundle failed");
      }

      if (!res.writableEnded) res.end();

      await withTenant(req.user.tid, (c) => writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
        entity: "cargo_import_masters", entityId: gate.master.id, action: "master.bundled",
        after: { file_number: gate.file.file_number, declared: !!gate.master.declared_at,
          papers: packed.length, papers_skipped: missing.length, entries: zip.entryCount,
          bytes: zip.bytesWritten, aborted, failure }
      }));
    });
}

/** The numbers a seat is asking about, compared the way pg hands them back. */
function same(stored: unknown, incoming: unknown): boolean {
  const clean = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
  const a = clean(stored);
  const b = clean(incoming);
  if (a === b) return true;
  const na = a === null ? NaN : Number(a);
  const nb = b === null ? NaN : Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : false;
}

function stated(v: unknown): string {
  if (v === null || v === undefined || String(v).trim() === "") return "not stated";
  return String(v);
}

/** The cover sheet, printed: one line per fact, one column per paper. */
function masterSheet(gate: Loaded, actor: string, generatedAt: Date): PreparedTable {
  const m = gate.master as Record<string, any>;
  const f = gate.file;
  const billHead = m.bill_kind ? (BILL_LABEL[m.bill_kind] ?? "Bill of lading / air waybill")
    : "Bill of lading / air waybill";
  const value = m.invoice_value === null || m.invoice_value === undefined ? null
    : `${m.invoice_currency ?? ""} ${new Intl.NumberFormat("en-US",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(m.invoice_value))}`.trim();
  const carried = "this paper does not carry it";
  const filed = (name: unknown, slot: string) => String(name ?? `${slot} is not filed yet`);
  const packages = m.packages_count === null || m.packages_count === undefined ? "not stated"
    : `${m.packages_count}${m.package_type ? ` × ${m.package_type}` : ""}`;

  const meta = [
    { label: "Cargo file", value: String(f.file_number) },
    { label: "Type", value: String(f.shipment_type) },
    { label: "Consignee", value: String(f.consignee_name ?? "not stated") },
    { label: "Consignor", value: String(f.consignor_name ?? "not stated") },
    { label: "Shipping line", value: String(f.shipping_line ?? "not stated") },
    { label: "Goods", value: String(f.cargo_description ?? "not stated").slice(0, 160) },
    { label: "Declaration", value: m.declared_at
      ? `signed ${signDay(m.declared_at)}`
      + `${m.declared_by_name ? ` by ${m.declared_by_name}` : ""}`
      : "not signed" },
    ...(m.notes ? [{ label: "Clerk's note", value: String(m.notes).slice(0, 160) }] : []),
    ...(gate.warnings.length
      ? [{ label: "Checks", value: `${gate.warnings.length} to look at — in README.txt` }] : [])
  ].slice(0, 12);

  return prepareTable({
    report: "cargo-master",
    title: `Master document — ${f.file_number}`,
    subtitle: `Commercial invoice, packing list and ${billHead.toLowerCase()}`
      + ` · generated ${signDay(generatedAt)}`,
    meta,
    columns: [
      { key: "field", label: "Field", type: "text", width: 170 },
      { key: "invoice", label: "Commercial invoice", type: "text", width: 180 },
      { key: "packing", label: "Packing list", type: "text", width: 180 },
      { key: "bill", label: billHead.slice(0, 80), type: "text", width: 180 }
    ],
    rows: [
      { field: "Number printed on it", invoice: stated(m.invoice_number),
        packing: stated(m.packing_list_number), bill: stated(m.bill_number) },
      { field: "Date", invoice: stated(m.invoice_date), packing: carried,
        bill: stated(m.bill_date) },
      { field: "Currency", invoice: stated(m.invoice_currency), packing: carried, bill: carried },
      { field: "Value", invoice: stated(value), packing: carried, bill: carried },
      { field: "Packages", invoice: carried, packing: packages, bill: carried },
      { field: "Gross weight (kg)", invoice: carried, packing: stated(m.gross_weight_kg),
        bill: carried },
      { field: "Net weight (kg)", invoice: carried, packing: stated(m.net_weight_kg), bill: carried },
      { field: "Paper filed in the archive",
        invoice: filed(m.invoice_file_name, "The invoice"),
        packing: filed(m.packing_file_name, "The packing list"),
        bill: filed(m.bill_file_name, "The bill or air waybill") },
      { field: "Kind it was filed under", invoice: stated(m.invoice_kind),
        packing: stated(m.packing_kind), bill: stated(m.bill_paper_kind) }
    ]
  }, actor);
}

function masterReadme(
  gate: Loaded, actor: string, generatedAt: Date, sheetEntry: string,
  packed: { slot: string; entry: string; bytes: number }[],
  missing: { entry: string; reason: string }[]
): string {
  const m = gate.master as Record<string, any>;
  const here = sheetEntry.slice(0, sheetEntry.lastIndexOf("/"));
  return [
    `Master document — ${gate.file.file_number}`,
    `Generated ${generatedAt.toISOString().slice(0, 19).replace("T", " ")} UTC by ${actor}.`,
    "",
    "WHAT THIS IS",
    "One signed cover sheet for a cargo file: the commercial invoice, the packing list and the",
    "bill of lading or air waybill, each with the number printed on it and the paper filed behind",
    "it. It is the declaration this office makes about the goods — not the clearing pipeline's",
    "correspondence register, which stays on the file's job documents.",
    "",
    "DECLARATION",
    m.declared_at
      ? `Signed ${signDay(m.declared_at)} by `
      + `${m.declared_by_name ?? "a seat no longer on this company"}.`
      : "Not signed. Everything below is what a clerk has typed, not a declaration.",
    ...(!m.declared_at && gate.state.gaps ? [`Still missing: ${gate.state.gaps}.`] : []),
    "",
    "IN THIS FOLDER",
    sheetEntry,
    ...packed.map((p) => `${p.entry}  (${p.slot}, ${(p.bytes / 1024).toFixed(0)} KB)`),
    `${here}/master.json  (this folder's content in machine-readable form)`,
    `${here}/README.txt  (this note)`,
    ...(missing.length ? ["", "NOT IN THIS FOLDER"] : []),
    ...missing.map((x) => `${x.entry}: ${x.reason}`),
    "",
    "WATCH",
    ...(gate.warnings.length ? gate.warnings.map((w) => `- ${w}`)
      : ["Nothing on the sheet disagrees with the cargo file."]),
    "",
    "The weights and package count are what the packing list says. The cargo file's own weight and",
    "volume are what this office typed when it opened the file; the two are allowed to disagree and",
    "are printed apart so a clerk can see which one is being quoted to whom.",
    "master.json is this content in machine-readable form; SHA256SUMS.txt at the top of the",
    "archive checksums every entry inside it.",
    ""
  ].join("\n");
}

function masterRecord(
  gate: Loaded, actor: string, generatedAt: Date, sheetEntry: string,
  packed: { slot: string; entry: string; bytes: number }[],
  missing: { entry: string; reason: string }[]
): string {
  const m = gate.master as Record<string, any>;
  return JSON.stringify({
    generated_at: generatedAt.toISOString(),
    generated_by: actor,
    source: "Waisha cargo master document bundle",
    note: "Timestamps are UTC (…Z), a plain value is a calendar day. The figures are what this "
      + "office declared; the papers are the PDFs filed behind them.",
    file_number: gate.file.file_number,
    shipment_id: gate.file.id,
    declared: !!m.declared_at,
    declared_on: m.declared_at ? signDay(m.declared_at) : null,
    declared_at: m.declared_at ? signInstant(m.declared_at) : null,
    declared_by: m.declared_by ?? null,
    declared_by_name: m.declared_by_name ?? null,
    master: {
      invoice: { number: m.invoice_number, date: m.invoice_date, currency: m.invoice_currency,
        value: m.invoice_value, paper: m.invoice_file_name ?? null,
        paper_kind: m.invoice_kind ?? null, paper_document_id: m.invoice_document_id ?? null },
      packing_list: { number: m.packing_list_number, packages_count: m.packages_count,
        package_type: m.package_type, gross_weight_kg: m.gross_weight_kg,
        net_weight_kg: m.net_weight_kg, paper: m.packing_file_name ?? null,
        paper_kind: m.packing_kind ?? null, paper_document_id: m.packing_document_id ?? null },
      transport_document: { kind: m.bill_kind, number: m.bill_number, date: m.bill_date,
        paper: m.bill_file_name ?? null, paper_kind: m.bill_paper_kind ?? null,
        paper_document_id: m.bill_document_id ?? null },
      notes: m.notes ?? null
    },
    cargo_file: gate.file,
    state: gate.state,
    warnings: gate.warnings,
    sheet: sheetEntry,
    papers: packed,
    papers_missing: missing
  }, null, 2);
}
