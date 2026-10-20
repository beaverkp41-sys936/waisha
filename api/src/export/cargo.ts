import type { PoolClient } from "pg";
import { safeEntryPath } from "./zip.js";
import type { Cell, ExportColumn, PreparedTable } from "./table.js";

/**
 * Everything one cargo file knows, read out of the database for the archive.
 *
 * The register endpoint answers with the rows the browser is already showing. A batch
 * export is asked for something different — "all information fully" — so it reads the
 * file itself: the shipment line, every register hung off it, the registers hung off
 * those, and the documents stored against them.
 *
 * Three rules hold it together.
 *
 * **Nothing leaves that could not be read on screen.** Every statement carries the
 * caller's own tenant in its WHERE clause, so a foreign file id is simply not there.
 * That predicate cannot be left to row-level security on this deployment: the API
 * connects as a role that holds BYPASSRLS and the tenant policies are written for
 * `app_runtime`, so RLS answers nothing here — the scope has to be in the SQL, exactly
 * as the portal's own list queries write it.
 *
 * **Encrypted columns and their search hashes are never selected.** The column list
 * comes from the live catalog and a name matching WITHHELD is dropped before it reaches
 * the SQL — so an `*_encrypted` value is not fetched and then hidden, it is not
 * fetched, and nothing here can decrypt anything. The withheld names are printed in the
 * bundle's own README, because an auditor asking why a field is absent should get the
 * answer from the file rather than from a person.
 *
 * **Identifiers are quoted and checked.** The dynamic parts of each statement are table
 * and column names taken from `information_schema` and re-validated against SAFE_IDENT
 * before quoting; every value is a bind parameter.
 */

/** One register's rows in a workbook sheet is readable; a thousand is not. */
const ROW_CAP = 500;

const WITHHELD = /(_encrypted$|_search$|_hash$|password|secret|token|nida|id_number|biometric|signature)/i;
const MONEYISH = /(^|_)(amount|total|fee|charge|cost|price|payment|balance)(_|$)/i;
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;
/** Which column of a parent table gets used to name one of its rows. */
const LABEL_PRIORITY = ["full_name", "name", "label"];

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/**
 * The tenant the caller's transaction was opened for, written the way the RLS policies
 * write it. Unset answers NULL, and `tenant_id = NULL` matches no row — a statement that
 * forgot to set the scope therefore exports nothing rather than everything.
 */
const TENANT = "(nullif(current_setting('app.tenant_id', true), '')::uuid)";

/** The file's own story, in the order an operator reads it. */
const REGISTERS: {
  sheet: string;
  table: string;
  /** The column that points at the shipment, or at a row of another register. */
  on: string;
  through?: { table: string; to: string };
  caption: string;
}[] = [
  { sheet: "Tasks", table: "cargo_tasks", on: "shipment_id", caption: "Clearing jobs on this file" },
  { sheet: "Stages", table: "job_stages", on: "shipment_id", caption: "The pipeline steps of the file's job" },
  { sheet: "Job", table: "jobs", on: "shipment_id", caption: "The internal job opened for this file" },
  { sheet: "Activity", table: "job_activity", on: "shipment_id", caption: "Who did what to the file, and when" },
  { sheet: "Handovers", table: "job_handovers", on: "shipment_id", caption: "Physical handovers of the file or its originals" },
  { sheet: "File documents", table: "job_documents", on: "shipment_id", caption: "The document register: expected, received, verified" },
  { sheet: "Messages", table: "messages", on: "shipment_id", caption: "The thread on this file" },
  { sheet: "Read states", table: "message_reads", on: "shipment_id", caption: "Who has read the thread up to where" },
  { sheet: "Office tasks", table: "office_tasks", on: "shipment_id", caption: "Office work raised against this file" },
  { sheet: "Task steps", table: "office_task_steps", on: "office_task_id", through: { table: "office_tasks", to: "id" }, caption: "The steps recorded against those office tasks" },
  { sheet: "Office costs", table: "office_costs", on: "shipment_id", caption: "Money the office spent on this file" },
  { sheet: "Quotations", table: "quotations", on: "shipment_id", caption: "Proformas raised for this file" },
  { sheet: "Quotation lines", table: "quotation_items", on: "quotation_id", through: { table: "quotations", to: "id" }, caption: "The charge lines of those proformas" },
  { sheet: "Billing docs", table: "billing_documents", on: "quotation_id", through: { table: "quotations", to: "id" }, caption: "Invoices and receipts issued from those proformas" },
  { sheet: "Manifests", table: "consolidations", on: "shipment_id", caption: "Consolidation manifests carrying this file" },
  { sheet: "Parcels", table: "consolidation_parcels", on: "manifest_id", through: { table: "consolidations", to: "id" }, caption: "The parcels on those manifests" },
  { sheet: "Requests", table: "transport_requests", on: "shipment_id", caption: "Publishes of this cargo to the notice board" },
  { sheet: "Bookings", table: "transport_bookings", on: "request_id", through: { table: "transport_requests", to: "id" }, caption: "Bookings accepted against those requests" },
  { sheet: "Shipper shares", table: "shipper_file_shares", on: "shipment_id", caption: "Visibility granted to a shipper's own account" }
];

type Projected = { name: string; expression: string; column: ExportColumn };

function project(name: string, dataType: string): Projected | null {
  if (!SAFE_IDENT.test(name)) return null;
  const id = q(name);
  const text = (expression: string, type: ExportColumn["type"]): Projected =>
    ({ name, expression: `${expression} as ${id}`, column: { key: name, label: humanize(name), type } });

  switch (dataType) {
    case "date":
      // Formatted in SQL: a driver-side Date is a UTC midnight and shifts the calendar
      // day for anyone east of Greenwich.
      return text(`to_char(${id}, 'YYYY-MM-DD')`, "date");
    case "timestamp with time zone":
      return text(`to_char(${id} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`, "text");
    case "timestamp without time zone":
      return text(`to_char(${id}, 'YYYY-MM-DD"T"HH24:MI:SS')`, "text");
    case "numeric":
    case "decimal":
    case "integer":
    case "bigint":
    case "smallint":
      return text(id, MONEYISH.test(name) ? "money" : "number");
    case "boolean":
      return text(id, "bool");
    case "jsonb":
    case "json":
      return text(`${id}::text`, "text");
    default:
      return text(id, "text");
  }
}

function humanize(name: string): string {
  return name.split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(/\bId\b/g, "ID");
}

/** pg hands numerics back as strings; a money column of strings adds up to nothing. */
function coerce(value: unknown, type: ExportColumn["type"]): Cell {
  if (value === null || value === undefined) return null;
  if (type === "money" || type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "bool") return typeof value === "boolean" ? value : null;
  if (typeof value === "object") return value === null ? null : String(value);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value : String(value);
}

/**
 * The catalog read for one batch: every column of every register the bundle touches,
 * and every parent that can name a foreign id. Once per batch rather than once per file,
 * because 25 files would otherwise ask the same three questions 500 times.
 */
export type BundleCatalog = {
  projections: Map<string, { projected: Projected[]; withheld: string[]; has: Set<string> }>;
  labels: Map<string, { parent: string; parentKey: string; label: string; scoped: boolean }>;
};

const BUNDLE_TABLES = ["cargo_shipments", ...REGISTERS.map((r) => r.table)];

export async function loadBundleCatalog(c: PoolClient): Promise<BundleCatalog> {
  const columns = await c.query(`
    select table_name, column_name, data_type
      from information_schema.columns
     where table_schema = 'public' and table_name = any($1::text[])
     order by table_name, ordinal_position`, [BUNDLE_TABLES]);

  const projections = new Map<string, { projected: Projected[]; withheld: string[]; has: Set<string> }>();
  for (const name of BUNDLE_TABLES) {
    projections.set(name, { projected: [], withheld: [], has: new Set() });
  }
  for (const r of columns.rows) {
    const entry = projections.get(r.table_name);
    if (!entry) continue;
    entry.has.add(r.column_name);
    if (WITHHELD.test(r.column_name)) { entry.withheld.push(r.column_name); continue; }
    const p = project(r.column_name, r.data_type);
    if (p) entry.projected.push(p);
  }

  return { projections, labels: await parentLabels(c) };
}

/**
 * For each foreign key of these tables: its parent, and whether the parent can be read
 * at all and which of its columns names a row. The privilege is asked of the catalog
 * rather than discovered by trying, because a failed statement aborts the transaction
 * the whole bundle is being read inside.
 */
async function parentLabels(c: PoolClient): Promise<Map<string, {
  parent: string; parentKey: string; label: string; scoped: boolean;
}>> {
  const keys = await c.query(`
    select kcu.table_name as child, kcu.column_name as child_column,
           ccu.table_name as parent, ccu.column_name as parent_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
     where tc.constraint_type = 'FOREIGN KEY' and kcu.table_schema = 'public'
       and kcu.table_name = any($1::text[])`, [BUNDLE_TABLES]);
  const parents = [...new Set(keys.rows.map((r: any) => r.parent))];
  if (!parents.length) return new Map();

  const named = await c.query(`
    select t.table_name, t.column_name as label,
           has_table_privilege(current_user, 'public.' || t.table_name, 'select') as readable,
           bool_or(t.column_name = 'tenant_id') over (partition by t.table_name) as own_tenant
      from information_schema.columns t
     where t.table_schema = 'public' and t.table_name = any($1::text[])
       and t.column_name in ('full_name', 'name', 'label', 'tenant_id')`, [parents]);
  const labelOf = new Map<string, { column: string; readable: boolean; scoped: boolean }>();
  for (const r of named.rows) {
    if (r.label === "tenant_id") continue;
    const rank = LABEL_PRIORITY.indexOf(r.label);
    const best = labelOf.get(r.table_name);
    if (!best || rank < LABEL_PRIORITY.indexOf(best.column)) {
      labelOf.set(r.table_name, { column: r.label, readable: r.readable, scoped: r.own_tenant });
    }
  }

  const out = new Map<string, { parent: string; parentKey: string; label: string; scoped: boolean }>();
  for (const r of keys.rows) {
    const info = labelOf.get(r.parent);
    if (!info?.readable) continue;
    if (!SAFE_IDENT.test(r.parent) || !SAFE_IDENT.test(info.column)
      || !SAFE_IDENT.test(r.parent_column)) continue;
    out.set(`${r.child}.${r.child_column}`, {
      parent: r.parent, parentKey: r.parent_column, label: info.column, scoped: info.scoped
    });
  }
  return out;
}

/**
 * A foreign id printed as `3f2a…` tells an auditor nothing, so each one gets its
 * parent's name beside it. A parent that belongs to a company is read inside this
 * tenant only — a name from another desk's row is not printed, the id is left alone.
 */
async function nameForeignIds(c: PoolClient, labels: BundleCatalog["labels"], registers: Register[]): Promise<void> {
  for (const reg of registers) {
    for (const source of reg.columns.map((col) => ({ key: col.key, label: col.label }))) {
      // Every row of one file carries the same tenant, so naming it would be noise.
      if (source.key === "tenant_id") continue;
      const fk = labels.get(`${reg.table}.${source.key}`);
      if (!fk) continue;
      const ids = [...new Set(reg.rows.map((row) => row[source.key])
        .filter((v): v is string => typeof v === "string" && v.length > 0))];
      if (!ids.length) continue;
      const scoped = fk.scoped ? `and ${q(fk.parent)}.tenant_id = ${TENANT} ` : "";
      const sql = `select ${q(fk.parentKey)}::text as id, ${q(fk.label)} as label
                     from ${q(fk.parent)}
                    where ${q(fk.parentKey)}::text = any($1::text[]) ${scoped}
                    limit 2000`;
      const found = await c.query(sql, [ids]);
      if (!found.rowCount) continue;
      const names = new Map(found.rows.map((r: any) => [String(r.id), r.label]));
      const key = `${source.key}_name`;
      reg.columns.splice(reg.columns.findIndex((col) => col.key === source.key) + 1, 0,
        { key, label: `${source.label} name`, type: "text" });
      for (const row of reg.rows) {
        const named = names.get(String(row[source.key] ?? ""));
        row[key] = named === null || named === undefined ? null : String(named);
      }
    }
  }
}

type Register = {
  table: string;
  sheet: string;
  caption: string;
  columns: ExportColumn[];
  rows: Record<string, Cell>[];
  truncated: boolean;
  withheld: string[];
};

async function readRegister(
  c: PoolClient, catalog: BundleCatalog, link: typeof REGISTERS[number], shipmentId: string
): Promise<Register | null> {
  const entry = catalog.projections.get(link.table);
  if (!entry?.projected.length) return null;
  const { projected, withheld, has } = entry;
  // A register with no tenant column of its own cannot be scoped here, so it is not
  // exported at all rather than exported for every company.
  if (!has.has("tenant_id")) return null;
  const first = projected[0].name;
  const orderColumn = has.has("created_at") ? "created_at" : has.has("id") ? "id" : first;
  const scoped = `tenant_id = ${TENANT}`;
  const where = link.through
    ? `${q(link.on)} in (select ${q(link.through.to)} from ${q(link.through.table)}`
      + ` where shipment_id = $1 and ${scoped})`
    : `${q(link.on)} = $1`;
  const sql = `select ${projected.map((p) => p.expression).join(", ")}
                 from ${q(link.table)}
                where ${where} and ${scoped}
                order by ${q(orderColumn)} nulls last
                limit $2`;
  const found = await c.query(sql, [shipmentId, ROW_CAP + 1]);
  const truncated = found.rowCount === ROW_CAP + 1;
  const rows: Record<string, Cell>[] = (truncated ? found.rows.slice(0, ROW_CAP) : found.rows)
    .map((row: any) => Object.fromEntries(projected.map((p) =>
      [p.name, coerce(row[p.name], p.column.type)])));
  return {
    table: link.table, sheet: link.sheet, caption: link.caption,
    columns: projected.map((p) => p.column), rows, truncated, withheld
  };
}

export type BundleDocument = {
  id: string;
  fileName: string;
  kind: string;
  entityType: string;
  /** Replaced by the route with the name the entry was really written under. */
  entryName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedAt: string | null;
  /** Filled by the route as the bytes pass through, before the workbook is written. */
  sha256: string | null;
  /** Why these bytes are not in the archive — set when storage could not be read. */
  missing: string | null;
};

export type CargoBundle = {
  shipmentId: string;
  fileNumber: string;
  folder: string;
  registers: Register[];
  documents: BundleDocument[];
  rowCount: number;
  withheld: Record<string, string[]>;
  truncated: string[];
};

function tableOf(reg: Register, generatedAt: Date, actor: string): PreparedTable {
  return {
    report: `cargo_${reg.table}`,
    title: reg.sheet,
    subtitle: reg.caption,
    meta: [{ label: "Source table", value: reg.table },
      ...(reg.truncated ? [{ label: "Note", value: `Only the first ${ROW_CAP} rows are listed.` }] : [])],
    columns: reg.columns,
    cells: reg.rows.map((row) => reg.columns.map((col) => row[col.key] ?? null)),
    generatedAt,
    actor
  };
}

function documentsRegister(bundle: CargoBundle): Register {
  return {
    table: "documents",
    sheet: "Documents",
    caption: "Every document stored against this file, in the folder of the same name",
    columns: [
      { key: "entry", label: "Path in archive", type: "text" },
      { key: "kind", label: "Kind", type: "text" },
      { key: "entity", label: "Attached to", type: "text" },
      { key: "file_name", label: "File name", type: "text" },
      { key: "mime_type", label: "MIME type", type: "text" },
      { key: "size_bytes", label: "Bytes", type: "number" },
      { key: "uploaded_at", label: "Uploaded (UTC)", type: "text" },
      { key: "in_archive", label: "In this archive", type: "bool" },
      { key: "sha256", label: "SHA-256", type: "text" }
    ],
    rows: bundle.documents.map((d) => ({
      entry: d.entryName,
      kind: d.kind,
      entity: `${d.entityType} ${d.id.slice(0, 8)}`,
      file_name: d.fileName,
      mime_type: d.mimeType,
      size_bytes: d.sizeBytes,
      uploaded_at: d.uploadedAt,
      in_archive: d.missing === null,
      sha256: d.sha256
    })),
    truncated: false,
    withheld: []
  };
}

/**
 * The workbook sheets for one file, built only once the document bytes have been
 * hashed — the archive writes this sheet last so its checksum column is a fact rather
 * than a promise.
 */
export function bundleTables(bundle: CargoBundle, generatedAt: Date, actor: string): PreparedTable[] {
  const registers = bundle.documents.length
    ? [...bundle.registers, documentsRegister(bundle)]
    : bundle.registers;
  return registers.map((reg) => tableOf(reg, generatedAt, actor));
}

/**
 * Which stored documents belong to a cargo file. The predicate is written once because
 * the pre-flight that refuses an oversized batch and the read that fills the archive
 * must count exactly the same rows — two copies of it would drift, and the batch would
 * then promise a size it does not keep. Every leg carries the tenant scope: a document
 * id is not proof of ownership, and each of these entity tables belongs to one company.
 */
const DOCUMENTS_OF_FILE = `
  d.tenant_id = ${TENANT}
  and ((d.entity_type = 'shipment' and d.entity_id = $1::uuid)
    or (d.entity_type = 'message' and d.entity_id in
        (select id from messages where shipment_id = $1 and tenant_id = ${TENANT}))
    or (d.entity_type = 'office_cost' and d.entity_id in
        (select id from office_costs where shipment_id = $1 and tenant_id = ${TENANT}))
    or (d.entity_type = 'quotation' and d.entity_id in
        (select id from quotations where shipment_id = $1 and tenant_id = ${TENANT}))
    or d.id in (select document_id from job_documents
                where shipment_id = $1 and tenant_id = ${TENANT} and document_id is not null))`;

/** What a file's documents weigh, before any of them is opened. */
export async function bundleDocumentSizes(
  c: PoolClient, shipmentId: string
): Promise<{ documents: number; bytes: number }> {
  const sql = `select count(*)::int as documents, coalesce(sum(d.size_bytes), 0)::bigint as bytes
                 from documents d
                where d.deleted_at is null and d.storage_path is not null
                  and (${DOCUMENTS_OF_FILE})`;
  const found = await c.query(sql, [shipmentId]);
  const row = found.rows[0] ?? { documents: 0, bytes: 0 };
  return { documents: Number(row.documents), bytes: Number(row.bytes) };
}

/**
 * Read one file and everything that hangs off it.
 *
 * Null means the shipment is not there for this caller: every statement is scoped to
 * `app.tenant_id`, so a foreign id cannot be told apart from a deleted one — which is
 * what the route should say either way.
 */
export async function readCargoBundle(
  c: PoolClient, catalog: BundleCatalog, shipmentId: string
): Promise<CargoBundle | null> {
  const head = await readRegister(c, catalog, {
    sheet: "Shipment", table: "cargo_shipments", on: "id",
    caption: "The clearing and forwarding file"
  }, shipmentId);
  if (!head || !head.rows.length) return null;

  const registers = [head];
  for (const link of REGISTERS) {
    const reg = await readRegister(c, catalog, link, shipmentId);
    if (reg && reg.rows.length) registers.push(reg);
  }
  await nameForeignIds(c, catalog.labels, registers);

  const docSql = `
    select d.id, d.file_name, coalesce(d.kind, 'document') as kind, d.entity_type,
           d.storage_path, d.mime_type, d.size_bytes,
           to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as uploaded_at
      from documents d
     where d.deleted_at is null and d.storage_path is not null
       and (${DOCUMENTS_OF_FILE})
     order by d.created_at, d.file_name
     limit 2000`;
  const docs = await c.query(docSql, [shipmentId]);

  const fileNumber = String(head.rows[0].file_number ?? "file");
  const folder = safeEntryPath(`${fileNumber}-${shipmentId.slice(0, 8)}`);
  const documents: BundleDocument[] = docs.rows.map((d: any) => ({
    id: String(d.id),
    fileName: String(d.file_name ?? "file"),
    kind: String(d.kind),
    entityType: String(d.entity_type),
    storagePath: String(d.storage_path),
    mimeType: d.mime_type ?? null,
    sizeBytes: Number(d.size_bytes ?? 0),
    uploadedAt: d.uploaded_at ?? null,
    entryName: `${folder}/documents/${safeEntryPath(
      d.entity_type === "shipment"
        ? `${d.kind}-${d.file_name}` : `${d.entity_type}-${d.kind}-${d.file_name}`)}`,
    sha256: null,
    missing: null
  }));

  const withheld: Record<string, string[]> = {};
  const truncated: string[] = [];
  for (const reg of registers) {
    if (reg.withheld.length) withheld[reg.table] = reg.withheld;
    if (reg.truncated) truncated.push(reg.table);
  }

  return {
    shipmentId,
    fileNumber,
    folder,
    registers,
    documents,
    rowCount: registers.reduce((n, r) => n + r.rows.length, 0),
    withheld,
    truncated
  };
}

/** The machine-readable copy of the same read — nothing filtered twice, nothing added. */
export function bundleRecord(bundle: CargoBundle, actor: string, generatedAt: Date): string {
  return JSON.stringify({
    generated_at: generatedAt.toISOString(),
    generated_by: actor,
    source: "Waisha cargo file export",
    file_number: bundle.fileNumber,
    shipment_id: bundle.shipmentId,
    note: "Timestamps are UTC (…Z), a plain date is a calendar day. Encrypted columns and "
      + "their search hashes are not selected — see withheld_columns. Each *_name column "
      + "is the row the id in the column beside it points at.",
    withheld_columns: bundle.withheld,
    truncated_registers: bundle.truncated,
    documents: bundle.documents.map((d) => ({
      kind: d.kind, attached_to: d.entityType, file_name: d.fileName, mime_type: d.mimeType,
      size_bytes: d.sizeBytes, uploaded_at: d.uploadedAt, path_in_archive: d.entryName,
      in_archive: d.missing === null, why_not: d.missing
    })),
    registers: Object.fromEntries(bundle.registers.map((r) => [r.table, r.rows]))
  }, null, 2);
}

/** What is in this folder, and why the absent fields are absent. */
export function bundleReadme(bundle: CargoBundle, actor: string, generatedAt: Date): string {
  const inside = bundle.documents.filter((d) => !d.missing);
  const outside = bundle.documents.filter((d) => d.missing);
  const lines = [
    `Cargo file ${bundle.fileNumber}`,
    `Exported ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC by ${actor}`,
    "",
    "Contents:",
    `  ${bundle.folder}/record.json          every register below, as data`,
    `  ${bundle.folder}/cargo-file.xlsx      one sheet per register, with totals`,
    `  ${bundle.folder}/documents/           ${inside.length} stored file(s), exactly as uploaded`,
    "",
    "Registers:",
    ...bundle.registers.map((r) =>
      `  ${r.sheet.padEnd(18)} ${String(r.rows.length).padStart(4)} row(s)  ${r.caption}`)
  ];
  if (outside.length) {
    lines.push("", `Registered against this file but NOT in this archive (${outside.length}):`,
      ...outside.map((d) => `  ${d.entryName}: ${d.missing}`));
  }
  if (bundle.truncated.length) {
    lines.push("", `Long registers cut at ${ROW_CAP} rows: ${bundle.truncated.join(", ")}.`);
  }
  const withheld = Object.entries(bundle.withheld);
  if (withheld.length) {
    lines.push("", "Withheld columns — encrypted values and their search hashes, never read out:",
      ...withheld.map(([t, cols]) => `  ${t}: ${cols.join(", ")}`));
  }
  lines.push("", "Timestamps are UTC (…Z); a plain date is a calendar day.",
    "The SHA-256 of every entry is in SHA256SUMS.txt at the root of the archive.",
    "A register listed with 0 rows means that part of the file was never recorded.");
  return lines.join("\n") + "\n";
}
