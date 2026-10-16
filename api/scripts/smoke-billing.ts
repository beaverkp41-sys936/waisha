/**
 * End-to-end smoke for the CFA billing module (052/053): charge catalogue,
 * proforma/quotation lifecycle, reference-file ingestion with server-side PDF
 * text extraction, cross-verification, inline editing, conversion to a draft
 * invoice, and the tenant/permission gates around all of it.
 *
 * Runs against a booted API on port 4000 and needs Supabase storage for the
 * two synthetic reference PDFs it builds here (no real TRA document is used).
 * Cleans up every row it creates through the owner connection.
 *
 * Run: npx tsx scripts/smoke-billing.ts
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const CUSTOMER = "Smoke Billing Consignee Limited";
const VESSEL = "SMOKE VESSEL";
const PHONE = "+255710000111";

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
const num = (v: unknown) => Number(v);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = iso(new Date());

/** One-page PDF with a real text layer so the server-side reader has something to pull. */
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => "\\" + m);
  const content = ["BT", "/F1 9 Tf", "1 0 0 1 40 800 Tm", "12 TL",
    ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");

  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const PRIMARY_PDF = makePdf([
  "TANZANIA PORTS AUTHORITY",
  "PORT CHARGES INVOICE",
  "INVOICE NO: TPA/2026/00442",
  "INVOICE DATE: " + today,
  "VESSEL NAME: " + VESSEL,
  "VOYAGE: SM101",
  "TRADE TYPE: IMPORT",
  "CONSIGNEE: " + CUSTOMER,
  "Service name  Basis  Quantity  Unit  Amount  VAT  Total",
  "WHARFAGE SERVICES CIF 1 CONTAINER 120,000.00 21,600.00 141,600.00",
  "PORT CLEARANCE AND HANDLING FLAT 85,000.00 15,300.00 100,300.00",
  "VERIFICATION AND SCANNING 2 PCS 40,000.00 7,200.00 47,200.00",
  "GREEN PORT INITIATIVES 3 TEU 15,000.00 2,700.00 17,700.00",
  "TOTAL CHARGES 260,000.00",
  "VAT AMOUNT 46,800.00",
  "TOTAL BILLED AMOUNT 306,800.00"
]);

const SECONDARY_PDF = makePdf([
  "SMOKE FORWARDERS LIMITED",
  "AGENCY PROFORMA INVOICE",
  "INVOICE NO: AG-2026-00991",
  "DOCUMENT DATE: " + today,
  "VESSEL NAME: " + VESSEL,
  "AGENT NAME: SMOKE FORWARDERS LIMITED",
  "AGENT TIN: 123-456-789",
  "AGENCY C AND F FEE 1 LOT 250,000.00 45,000.00 295,000.00",
  "WHARFAGE SERVICES 3 TEU 120,000.00 21,600.00 141,600.00",
  "LOCAL TRANSPORT CARTAGE 2 TRIP 90,000.00 16,200.00 106,200.00",
  "REEFER PLUG ELECTRICITY 1 DAYS 45,000.00 8,100.00 53,100.00",
  "OXYGEN FUEL LEVY 1 LOT 5,000.00 900.00 5,900.00",
  "TOTAL AMOUNT 510,000.00",
  "VAT AMOUNT 91,800.00"
]);

/**
 * Remove every row this smoke can create, in the order the foreign keys allow:
 * the invoice a proforma was converted into points back at the quotation, and
 * the quotation points forward at the invoice.
 */
async function sweep(owner: pg.Client, tid: string, uid: string) {
  const like = CUSTOMER + "%";
  // Fixed-window buckets are clock-aligned, so repeat runs in the same hour
  // would otherwise trip the reference-ingest limit.
  await owner.query(`delete from rate_limits
    where bucket in ($1, $2)`, [`reference:uid:${uid}`, `upload:uid:${uid}`]);
  const mine = `select id from quotations where tenant_id = $1 and customer_name like $2`;
  const made = `select id from freight_invoices
    where tenant_id = $1 and source_quotation_id in (${mine})`;
  await owner.query(`update quotations set converted_invoice_id = null
    where tenant_id = $1 and customer_name like $2`, [tid, like]);
  await owner.query(`delete from freight_invoice_payments where invoice_id in (${made})`, [tid, like]);
  await owner.query(`delete from freight_invoice_items where invoice_id in (${made})`, [tid, like]);
  await owner.query(`delete from documents where tenant_id = $1 and entity_type = 'invoice'
    and entity_id in (${made})`, [tid, like]);
  await owner.query(`delete from freight_invoices where tenant_id = $1
    and source_quotation_id in (${mine})`, [tid, like]);
  await owner.query(`delete from quotation_items where quotation_id in (${mine})`, [tid, like]);
  await owner.query(`delete from billing_documents where tenant_id = $1
    and quotation_id in (${mine})`, [tid, like]);
  await owner.query(`delete from documents where tenant_id = $1 and entity_type = 'quotation'
    and entity_id in (${mine})`, [tid, like]);
  await owner.query(`delete from quotations where tenant_id = $1 and customer_name like $2`, [tid, like]);
  await owner.query(`delete from charge_catalog where tenant_id = $1 and code = 'REEFER_PLUG'`, [tid]);
}

async function upload(token: string, bytes: Buffer, fileName: string,
  entityType: string, entityId: string, kind: string) {
  const form = new FormData();
  form.append("entityType", entityType);
  form.append("entityId", entityId);
  form.append("kind", kind);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), fileName);
  return call("/documents", token, { method: "POST", body: form });
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Reference-file ingest needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
       and exists (select 1 from company_profiles cp where cp.tenant_id = u.tenant_id)
     order by u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director with a company profile found");
  const { user_id, tenant_id } = who.rows[0];
  console.log(`billing tenant ${tenant_id} as director ${user_id}`);

  // Sweep anything a previous interrupted run left behind.
  await sweep(owner, tenant_id, user_id);

  const token = await mint(user_id, tenant_id);
  const noPermToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const otherTenantToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  try {
    // ---------- Charge catalogue ----------
    const cat = await call("/charge-catalog", token);
    check("catalogue lists the statutory, port and transport blocks",
      cat.status === 200 && cat.json.length >= 17, [cat.status, cat.json?.length]);
    const codes = new Set(cat.json.map((c: any) => c.code));
    check("catalogue carries the charges a CFA bill prints",
      ["IMPORT_DUTY", "VAT_IMPORT", "RDL", "CPF_IDF", "WHARFAGE", "AGENCY_CF",
       "FREIGHT", "DEMURRAGE"].every((c) => codes.has(c)), [...codes].slice(0, 8));
    const statutory = cat.json.filter((c: any) => c.section === "statutory");
    check("only the citable statutory rates ship with a default",
      statutory.filter((c: any) => c.defaultRate !== null).length === 3, statutory.length);

    const foreignEdit = await call(`/charge-catalog/${statutory[0].id}`, token,
      { method: "PUT", body: JSON.stringify({ label: "hijacked" }) });
    check("a platform charge code cannot be edited by a tenant",
      foreignEdit.status === 404 || foreignEdit.status === 403, foreignEdit.status);

    const ownCode = await call("/charge-catalog", token, json({
      code: "REEFER_PLUG", label: "Reefer plug electricity", section: "port",
      basis: "per_day", defaultRate: 45000, rateType: "amount", sort: 170
    }));
    check("tenant can add its own flat TZS charge code", ownCode.status === 201, ownCode.json);
    const ownId: string | undefined = ownCode.json?.id;

    // ---------- Draft proforma ----------
    const draft = await call("/quotations", token, json({
      kind: "proforma", customerName: CUSTOMER, customerPhone: PHONE,
      customerEmail: "smoke@consignee.example", customerTin: "987-654-321",
      vesselName: VESSEL, voyage: "SM101", blNumber: "BL-SMOKE-1", tradeType: "IMPORT",
      issueDate: today, validUntil: iso(new Date(Date.now() + 14 * 86400000)),
      currency: "TZS", vatRate: 18,
      items: [
        { section: "statutory", catalogCode: "IMPORT_DUTY", description: "Import duty at 25% on CIF value",
          basis: "cif", quantity: 1, unitPrice: 480000, taxKind: "none", taxRate: 0 },
        { section: "statutory", catalogCode: "VAT_IMPORT", description: "VAT on import duty paid value",
          basis: "duty_paid_value", quantity: 1, unitPrice: 350000, taxKind: "none", taxRate: 0 },
        { section: "port", catalogCode: "WHARFAGE", description: "Wharfage services",
          basis: "flat", quantity: 1, unit: "CONTAINER", unitPrice: 120000,
          taxKind: "vat", taxRate: 18 },
        { section: "transport", catalogCode: "AGENCY_CF", description: "Agency and C&F fee",
          basis: "flat", quantity: 1, unit: "LOT", unitPrice: 250000, taxKind: "vat", taxRate: 18 }
      ]
    }));
    check("draft proforma created", draft.status === 201 && !!draft.json?.id, draft.json);
    const qid: string = draft.json.id;

    const detail0 = await call(`/quotations/${qid}`, token);
    check("number is a PF- proforma", /^PF-/.test(detail0.json?.quotation_number ?? ""),
      detail0.json?.quotation_number);
    check("the three printed blocks foot to the document total",
      num(detail0.json.statutory_total) + num(detail0.json.port_total) +
        num(detail0.json.transport_total) === num(detail0.json.total),
      [detail0.json.statutory_total, detail0.json.port_total,
       detail0.json.transport_total, detail0.json.total]);
    check("VAT lines bill at the printed 18%",
      num(detail0.json.vat_amount) === 66600, detail0.json.vat_amount);

    const list = await call(`/quotations?status=draft`, token);
    const row = list.json?.quotations?.find((r: any) => r.id === qid);
    check("list finds the draft and its KPIs", !!row && !!list.json.kpis, list.status);
    check("list never returns the stored phone number",
      row && !("customer_phone" in row) && !("customer_phone_encrypted" in row), Object.keys(row ?? {}));

    // ---------- Reference file ingest ----------
    const upPrimary = await upload(token, PRIMARY_PDF, "tpa-port-charges.pdf", "quotation", qid, "proforma");
    check("primary reference PDF uploaded", upPrimary.status === 201, upPrimary.json);
    const upSecondary = await upload(token, SECONDARY_PDF, "agency-proforma.pdf", "quotation", qid, "proforma");
    check("secondary reference PDF uploaded", upSecondary.status === 201, upSecondary.json);

    const attachPrimary = await call(`/quotations/${qid}/reference-files`, token,
      json({ role: "primary", documentId: upPrimary.json.id }));
    check("primary reference read and its header parsed",
      attachPrimary.status === 201 && attachPrimary.json.extractStatus === "extracted",
      [attachPrimary.status, attachPrimary.json?.extractStatus, attachPrimary.json?.extraction?.notes]);
    const head = attachPrimary.json?.extraction?.header ?? {};
    check("port invoice number and consignee pulled from the file",
      head.document_no === "TPA/2026/00442" && head.consignee === CUSTOMER, head);
    check("printed total pulled, not invented",
      num(head.printed_total) === 306800, head.printed_total);

    const attachSecondary = await call(`/quotations/${qid}/reference-files`, token,
      json({ role: "secondary", documentId: upSecondary.json.id }));
    check("secondary reference read", attachSecondary.status === 201, attachSecondary.status);

    const dupRole = await call(`/quotations/${qid}/reference-files`, token,
      json({ role: "primary", documentId: upSecondary.json.id }));
    check("one primary per quotation", dupRole.status === 409, dupRole.status);

    const stray = await upload(token, PRIMARY_PDF, "somewhere-else.pdf", "tenant", tenant_id, "other");
    const wrongOwner = await call(`/quotations/${qid}/reference-files`, token,
      json({ role: "secondary", documentId: stray.json.id }));
    check("a file that does not belong to this quotation is refused",
      wrongOwner.status === 404 || wrongOwner.status === 400, wrongOwner.status);

    // ---------- Cross-verification ----------
    const suggested = await call(`/quotations/${qid}/suggest-lines`, token, { method: "POST" });
    check("both files read into the suggestion pass",
      suggested.status === 200 && suggested.json.read?.primary && suggested.json.read?.secondary,
      [suggested.status, suggested.json]);
    const lines: any[] = suggested.json?.lines ?? [];
    check("charges from both files reconcile into proposed lines", lines.length >= 5, lines.length);
    check("a charge billed by both files is marked in_both",
      lines.some((l) => l.source === "in_both" && l.catalog_code === "WHARFAGE"),
      lines.map((l) => [l.catalog_code, l.source]));
    check("a charge the office named in its own catalogue is recognised",
      lines.some((l) => l.catalog_code === "REEFER_PLUG" && l.source === "secondary_only"),
      lines.map((l) => [l.catalog_code, l.source]));
    check("proposed lines keep the top-to-bottom block order",
      lines.every((l, i) => i === 0 ||
        ["statutory", "port", "transport"].indexOf(l.section) >=
        ["statutory", "port", "transport"].indexOf(lines[i - 1].section)),
      lines.map((l) => l.section));
    check("every proposed line multiplies out",
      lines.every((l) => Math.abs(num(l.quantity) * num(l.unit_price) - num(l.amount)) < 0.011),
      lines.filter((l) => Math.abs(num(l.quantity) * num(l.unit_price) - num(l.amount)) >= 0.011));
    const checks: any[] = suggested.json?.checks ?? [];
    check("verification strip reports per-file totals and conflicts",
      checks.some((k) => k.kind === "primary_rows_vs_total") &&
        checks.some((k) => k.kind === "files_agree") &&
        checks.some((k) => k.kind === "line_conflicts"),
      checks.map((k) => [k.kind, k.ok]));
    check("a charge neither file explains is reported, not guessed",
      (suggested.json?.unknown ?? []).some((u: any) => /oxygen fuel/i.test(u.description ?? "")),
      suggested.json?.unknown);
    check("the agency fee is recognised from the agent invoice",
      lines.some((l) => l.catalog_code === "AGENCY_CF"),
      lines.map((l) => l.catalog_code));

    // ---------- Inline editing ----------
    const items = detail0.json.items.map((l: any) => ({
      section: l.section, catalogCode: l.catalog_code, description: l.description,
      basis: l.basis, quantity: num(l.quantity), unit: l.unit, unitPrice: num(l.unit_price),
      taxKind: l.tax_kind, taxRate: num(l.tax_rate)
    }));
    items[2].quantity = 3;
    items[2].unitPrice = 130000;
    items[2].verified = true;
    items[2].sourceDocumentId = attachPrimary.json.id;
    items.push({ section: "transport", catalogCode: "DEMURRAGE", description: "Container detention 4 days",
      basis: "per_day", quantity: 4, unit: "DAY", unitPrice: 35000, taxKind: "vat", taxRate: 18 });
    const edited = await call(`/quotations/${qid}`, token, { method: "PUT", body: JSON.stringify({ items }) });
    check("draft edited in place", edited.status === 200, edited.json);

    const detail1 = await call(`/quotations/${qid}`, token);
    const wharf = detail1.json.items.find((l: any) => l.catalog_code === "WHARFAGE");
    check("edited line recomputed (3 x 130,000 + 18%)",
      num(wharf.amount) === 390000 && num(wharf.tax_amount) === 70200 && num(wharf.total) === 460200,
      [wharf.amount, wharf.tax_amount, wharf.total]);
    check("verified line carries its provenance back to the primary file",
      wharf.source_role === "primary" && wharf.verified === true,
      [wharf.source_role, wharf.verified]);
    check("sections still foot after the edit",
      num(detail1.json.statutory_total) + num(detail1.json.port_total) +
        num(detail1.json.transport_total) === num(detail1.json.total),
      detail1.json.total);
    check("a generated proforma document link and QR come back for print",
      typeof detail1.json.qr_data_url === "string" && detail1.json.qr_data_url.startsWith("data:image/png") &&
        !!detail1.json.letterhead,
      [typeof detail1.json.qr_data_url, !!detail1.json.letterhead]);

    // ---------- Gates ----------
    const noPerm = await call(`/quotations/${qid}`, noPermToken);
    check("a role without quotations.view is refused", noPerm.status === 403, noPerm.status);
    const crossTenant = await call(`/quotations/${qid}`, otherTenantToken);
    check("another tenant cannot read the proforma", crossTenant.status === 404, crossTenant.status);
    const badSource = await call(`/quotations/${qid}`, token, {
      method: "PUT",
      body: JSON.stringify({ items: [{ section: "port", description: "Invented provenance",
        basis: "flat", quantity: 1, unitPrice: 1000, sourceDocumentId: stray.json.id }] })
    });
    check("a line cannot claim a reference file that is not attached",
      badSource.status === 400, [badSource.status, badSource.json?.error?.code]);
    const convertEarly = await call(`/quotations/${qid}/convert`, token, { method: "POST" });
    check("a draft cannot be converted", convertEarly.status === 409, convertEarly.status);

    // ---------- Issue, lock, convert ----------
    const issued = await call(`/quotations/${qid}/status`, token,
      { method: "PUT", body: JSON.stringify({ status: "issued" }) });
    check("proforma issued", issued.status === 200, issued.json);
    const editAfterIssue = await call(`/quotations/${qid}`, token,
      { method: "PUT", body: JSON.stringify({ notes: "too late" }) });
    check("an issued proforma cannot be edited", editAfterIssue.status === 409, editAfterIssue.status);
    const attachAfterIssue = await call(`/quotations/${qid}/reference-files`, token,
      json({ role: "secondary", documentId: upSecondary.json.id }));
    check("reference files cannot be swapped after issue",
      attachAfterIssue.status === 409, attachAfterIssue.status);

    const converted = await call(`/quotations/${qid}/convert`, token, { method: "POST" });
    check("issued proforma converted to a draft invoice",
      converted.status === 201 && !!converted.json?.id, converted.json);
    const invId: string = converted.json.id;

    const inv = await call(`/invoices/${invId}`, token);
    check("invoice total matches the proforma it came from",
      inv.status === 200 && num(inv.json.total) === num(detail1.json.total),
      [inv.json?.total, detail1.json.total]);
    check("invoice keeps the statutory / port / transport blocks",
      num(inv.json.statutory_total) === num(detail1.json.statutory_total) &&
        num(inv.json.port_total) === num(detail1.json.port_total) &&
        num(inv.json.transport_total) === num(detail1.json.transport_total),
      [inv.json?.statutory_total, inv.json?.port_total, inv.json?.transport_total]);
    check("invoice lines keep their charge codes and VAT",
      inv.json.items.every((l: any) => l.section && l.tax_kind) &&
        inv.json.items.length === detail1.json.items.length,
      inv.json?.items?.map((l: any) => [l.section, l.catalog_code, l.tax_rate]));
    const detail2 = await call(`/quotations/${qid}`, token);
    check("proforma marked converted and linked forward",
      detail2.json.status === "converted" && detail2.json.converted_invoice_id === invId,
      [detail2.json.status, detail2.json.converted_invoice_id]);

    const deleteConverted = await call(`/quotations/${qid}`, token, { method: "DELETE" });
    check("a converted proforma is kept for the audit trail",
      deleteConverted.status === 409, deleteConverted.status);

    // ---------- A quotation (not a proforma) on the same surface ----------
    const quote = await call("/quotations", token, json({
      kind: "quotation", customerName: CUSTOMER + " Quote",
      currency: "TZS", issueDate: today,
      items: [{ section: "transport", description: "Door to door freight quote",
        basis: "flat", quantity: 1, unitPrice: 900000, taxKind: "vat", taxRate: 18 }]
    }));
    check("plain quotation created", quote.status === 201, quote.json);
    const qDetail = await call(`/quotations/${quote.json.id}`, token);
    check("quotation numbers use the QT- series", /^QT-/.test(qDetail.json?.quotation_number ?? ""),
      qDetail.json?.quotation_number);
    const accepted = await call(`/quotations/${quote.json.id}/status`, token,
      { method: "PUT", body: JSON.stringify({ status: "accepted" }) });
    check("quotation accepted", accepted.status === 200, accepted.json);

    // ---------- Teardown ----------
    await call(`/invoices/${invId}`, token, { method: "DELETE" });
    const gone = await owner.query(`select count(*)::int as n from freight_invoices
      where id = $1 and tenant_id = $2 and deleted_at is null`, [invId, tenant_id]);
    check("draft invoice removed on teardown", gone.rows[0].n === 0, gone.rows[0]);
    if (ownId) await call(`/charge-catalog/${ownId}`, token, { method: "DELETE" });

    const audit = await owner.query(
      `select action from audit_logs where tenant_id = $1
         and action in ('quotation.created','quotation.status_changed','invoice.converted_from_quotation')`,
      [tenant_id]);
    check("every money move is audited",
      ["quotation.created", "quotation.status_changed", "invoice.converted_from_quotation"]
        .every((a) => audit.rows.some((r) => r.action === a)), [...new Set(audit.rows.map((r) => r.action))]);
  } finally {
    await sweep(owner, tenant_id, user_id);
    await owner.end();
  }

  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log("billing smoke passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
