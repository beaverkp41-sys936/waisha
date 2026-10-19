/**
 * End-to-end smoke for the finance desk (#171) against a running API on port 4000.
 *
 * It runs in a tenant of its own — the desk reads the whole company's paper, so the
 * only way to assert a number is to know every bill that contributes to it. Eight
 * invoices are planted to cover every shape the SQL claims to tell apart: one
 * converted from a proforma with a statutory section, one hand-built, one zero-rated,
 * one draft, one cancelled, one in USD, one issued this month and one badly aged.
 * Every expected figure below is therefore arithmetic on that planting, not a
 * comparison against whatever a real company happens to hold.
 *
 * Tokens are forged like the other module smokes: a real finance officer, auditor,
 * trainee and director seat inside the fixture tenant, plus the same finance officer
 * aimed at a stranger tenant to prove the RLS answer is "empty", not "forbidden".
 *
 * The register is swept at the end. audit_logs rows stay behind by design — that
 * register is append-only and cannot be swept by anybody.
 *
 * Run: npx tsx scripts/smoke-finance.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Finance Smoke ${STAMP}`;
const FIN_NAME = "Kilian Smoke Finance Officer";
const AUD_NAME = "Kilian Smoke Auditor";
const DIR_NAME = "Kilian Smoke Director";
const TRN_NAME = "Kilian Smoke Trainee";
const PROVENANCE = "Six supplier tax invoices held in the office file, not in WAISHA";

async function mint(sub: string, tid: string, roles: string[] = ["finance_officer"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("30m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* CSV and other non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
/** Assert a number the desk reports against the arithmetic of the planted paper. */
function checkMoney(label: string, got: unknown, want: number) {
  check(label, Number(got) === want, { got, want });
}

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (s: string, n: number) => iso(new Date(new Date(`${s}T12:00:00`).getTime() + n * DAY));
const now = new Date();
const monthStart = (back: number) => iso(new Date(now.getFullYear(), now.getMonth() - back, 1));
const monthEnd = (back: number) =>
  iso(new Date(now.getFullYear(), now.getMonth() - back + 1, 0));
// The desk can only return a period that has finished, so the whole test runs on
// last month and one month four months back.
const P_FROM = monthStart(1), P_TO = monthEnd(1);
const Q_FROM = monthStart(4), Q_TO = monthEnd(4);
const TODAY = iso(now);
const FUTURE = shift(TODAY, 20);

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  const T = crypto.randomUUID();      // the company whose paper is planted
  const T2 = crypto.randomUUID();     // a stranger company, for the isolation pass
  const roleOf = async (k: string) => {
    const r = await oi(`select id from roles where key = $1 and tenant_id is null`, [k]);
    if (!r.rowCount) throw new Error(`No global ${k} role`);
    return r.rows[0].id as string;
  };
  const [finRole, audRole, dirRole, trnRole] =
    await Promise.all([roleOf("finance_officer"), roleOf("auditor"), roleOf("director"), roleOf("trainee")]);

  for (const [tid, name] of [[T, COMPANY], [T2, `Finance Stranger ${STAMP}`]] as [string, string][]) {
    await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`, [tid, name]);
  }
  const seat = async (tid: string, name: string, email: string, roleId: string) => {
    const u = await oi(`insert into users (tenant_id, user_type, email, status, full_name)
                        values ($1,'staff',$2,'active',$3) returning id`, [tid, email, name]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [u.rows[0].id, roleId]);
    return u.rows[0].id as string;
  };
  const FIN = await seat(T, FIN_NAME, `finance.smoke.${STAMP}@example.org`, finRole);
  const AUD = await seat(T, AUD_NAME, `audit.smoke.${STAMP}@example.org`, audRole);
  const DIR = await seat(T, DIR_NAME, `dir.smoke.${STAMP}@example.org`, dirRole);
  const TRN = await seat(T, TRN_NAME, `trainee.smoke.${STAMP}@example.org`, trnRole);

  // --- the paper -------------------------------------------------------------
  type Bill = {
    n: string; cust: string; tin?: string; status: string; currency?: string;
    issue: string; due?: string | null; sub: number; vatRate: number; vat: number;
    total: number; paid: number; quotation?: boolean;
    lines?: [string, string, number, number][];   // section, tax_kind, amount, tax_amount
  };
  const bills: Bill[] = [
    {
      n: "1001", cust: "Smoke Consignor Ltd", tin: "800-111-222", status: "sent",
      issue: shift(P_FROM, 4), due: shift(TODAY, -20), sub: 1500000, vatRate: 18, vat: 180000,
      total: 1680000, paid: 0, quotation: true,
      lines: [["port", "vat", 600000, 108000], ["transport", "vat", 400000, 72000],
        ["statutory", "none", 500000, 0]]
    },
    {
      n: "1002", cust: "Smoke Consignor Ltd", tin: "800-111-222", status: "sent",
      issue: shift(P_FROM, 9), due: shift(TODAY, -35), sub: 2000000, vatRate: 18, vat: 360000,
      total: 2360000, paid: 1000000
    },
    {
      n: "1003", cust: "Smoke Trader Co", status: "sent",
      issue: shift(P_FROM, 11), due: shift(TODAY, 12), sub: 300000, vatRate: 0, vat: 0,
      total: 300000, paid: 0, quotation: true,
      lines: [["transport", "none", 300000, 0]]
    },
    // Never owed, never returned: a draft has not been issued to anybody.
    {
      n: "1004", cust: "Smoke Draft Co", status: "draft",
      issue: shift(P_FROM, 5), due: shift(TODAY, 30), sub: 9999999, vatRate: 18, vat: 1800000,
      total: 9999999, paid: 0
    },
    {
      n: "1005", cust: "Smoke Cancelled Co", status: "cancelled",
      issue: shift(P_FROM, 6), due: shift(TODAY, -10), sub: 8888888, vatRate: 18, vat: 1600000,
      total: 8888888, paid: 0
    },
    // Foreign paper: counted and named, never added into a TZS figure.
    {
      n: "1006", cust: "Smoke Foreign Co", status: "sent", currency: "USD",
      issue: shift(P_FROM, 8), due: shift(TODAY, 22), sub: 900, vatRate: 18, vat: 162,
      total: 1062, paid: 0
    },
    {
      n: "1007", cust: "Smoke Later Co", status: "sent",
      issue: TODAY, due: shift(TODAY, 27), sub: 100000, vatRate: 0, vat: 0, total: 100000, paid: 0
    },
    // The badly aged one, and the formula payload the CSV export has to neutralise.
    {
      n: "1008", cust: "=cmd|'/C calc'!A0", status: "sent",
      issue: shift(Q_FROM, 3), due: shift(Q_FROM, 10), sub: 500000, vatRate: 0, vat: 0,
      total: 500000, paid: 0
    }
  ];
  const invId: Record<string, string> = {};
  for (const b of bills) {
    let sourceQuotation: string | null = null;
    if (b.quotation) {
      const q = await oi(
        `insert into quotations (tenant_id, quotation_number, kind, status, customer_name, currency,
                                 issue_date, total)
         values ($1,$2,'proforma','converted',$3,'TZS',$4::date,$5) returning id`,
        [T, `PSM-${b.n}`, b.cust, b.issue, b.total]);
      sourceQuotation = q.rows[0].id;
    }
    const ins = await oi(
      `insert into freight_invoices (tenant_id, invoice_number, customer_name, customer_tin,
        issue_date, due_date, currency, vat_rate, subtotal, vat_amount, total, amount_paid,
        status, source_quotation_id, created_by, updated_by)
       values ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) returning id`,
      [T, `SMK-${b.n}`, b.cust, b.tin ?? null, b.issue, b.due ?? null, b.currency ?? "TZS",
       b.vatRate, b.sub, b.vat, b.total, b.paid, b.status, sourceQuotation, FIN]);
    invId[b.n] = ins.rows[0].id;
    let seq = 0;
    for (const [section, taxKind, amount, taxAmount] of b.lines ??
      [["transport", b.vatRate > 0 ? "vat" : "none", b.sub, b.vat]]) {
      seq++;
      await oi(
        `insert into freight_invoice_items (tenant_id, invoice_id, seq, description, quantity,
           unit_price, amount, section, tax_kind, tax_rate, tax_amount)
         values ($1,$2,$3,$4,1,$5,$5,$6,$7,$8,$9)`,
        [T, invId[b.n], seq, `Smoke line ${section}`, amount, section, taxKind,
         taxKind === "vat" ? b.vatRate : 0, taxAmount]);
    }
  }
  await oi(
    `insert into freight_invoice_payments (tenant_id, invoice_id, amount, method, reference,
       paid_at, recorded_by)
     values ($1,$2,1000000,'bank','SMOKE-PAY-1',$3::date,$4)`,
    [T, invId["1002"], shift(P_FROM, 24), FIN]);

  const costs: [string, string, number, number, string, string | null, string, string][] = [
    ["Smoke Fuel Co", "fuel", 400000, 150000, shift(P_FROM, 7), shift(P_FROM, 25), "TZS", "recorded"],
    ["Smoke Yard Ltd", "other", 100000, 100000, shift(P_FROM, 19), null, "TZS", "recorded"],
    // A cost in another currency: the desk must neither owe it in shillings nor pay it.
    ["Smoke Foreign Vendor", "other", 500, 0, shift(P_FROM, 12), null, "USD", "recorded"],
    ["Smoke Dead Co", "other", 777000, 0, shift(P_FROM, 13), null, "TZS", "cancelled"]
  ];
  for (const [supplier, category, amount, paid, date, due, currency, status] of costs) {
    await oi(
      `insert into freight_expenses (tenant_id, supplier_name, category, amount, amount_paid,
         currency, expense_date, due_date, status, description, created_by, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,'Smoke cost',$10,$10)`,
      [T, supplier, category, amount, paid, currency, date, due, status, FIN]);
  }

  const fin = await mint(FIN, T);
  const aud = await mint(AUD, T);
  const dir = await mint(DIR, T);
  const trn = await mint(TRN, T);
  const stranger = await mint(FIN, T2);

  console.log(`\nfixture ${COMPANY} — period ${P_FROM}..${P_TO}, older ${Q_FROM}..${Q_TO}`);

  // -------------------------------------------------------------------------
  // The dashboard.
  // -------------------------------------------------------------------------
  const ov = await call(`/finance/overview?from=${P_FROM}&to=${P_TO}`, fin);
  check("overview answers the finance officer", ov.status === 200, ov.json);
  const o = ov.json ?? {};
  checkMoney("receivable sums the issued TZS paper only", o.receivable?.billed, 4940000);
  checkMoney("receivable collects only what was paid", o.receivable?.collected, 1000000);
  checkMoney("receivable owes the rest", o.receivable?.outstanding, 3940000);
  check("receivable bills are the five issued in TZS", o.receivable?.bills === 5, o.receivable?.bills);
  checkMoney("overdue is what is late", o.receivable?.overdue, 3540000);
  check("three bills are late", o.receivable?.overdueCount === 3, o.receivable?.overdueCount);
  checkMoney("ageing current", o.receivable?.ageing?.current, 400000);
  checkMoney("ageing 1-30", o.receivable?.ageing?.oneToThirty, 1680000);
  checkMoney("ageing 31-60", o.receivable?.ageing?.thirtyOneToSixty, 1360000);
  checkMoney("ageing 61-90 is empty", o.receivable?.ageing?.sixtyOneToNinety, 0);
  checkMoney("ageing 90+", o.receivable?.ageing?.overNinety, 500000);
  const ag = o.receivable?.ageing ?? {};
  checkMoney("the ageing buckets foot to the outstanding",
    (ag.current ?? 0) + (ag.oneToThirty ?? 0) + (ag.thirtyOneToSixty ?? 0) +
    (ag.sixtyOneToNinety ?? 0) + (ag.overNinety ?? 0), 3940000);
  checkMoney("payable excludes the cancelled and the foreign cost", o.payable?.billed, 500000);
  check("two costs are owed", o.payable?.bills === 2, o.payable?.bills);
  checkMoney("payable outstanding", o.payable?.outstanding, 250000);
  checkMoney("cash in is the payment the register holds", o.cash?.in, 1000000);
  checkMoney("cash out is attributed to the expense date", o.cash?.out, 250000);
  checkMoney("cash net", o.cash?.net, 750000);
  check("money out says how it was attributed", typeof o.cash?.outBasis === "string" && o.cash.outBasis.length > 30, o.cash?.outBasis);
  checkMoney("days to collect is the amount-weighted gap", o.collection?.daysToCollect, 15);
  check("one payment behind it", o.collection?.payments === 1, o.collection?.payments);
  checkMoney("tax block charges what the bills charged", o.tax?.outputCharged, 540000);
  checkMoney("tax block base counts rated lines only", o.tax?.baseAmount, 3000000);
  checkMoney("tax block zero-rated", o.tax?.zeroRatedBase, 300000);
  checkMoney("tax block statutory memo", o.tax?.statutoryCollected, 500000);
  // A supply is in one column of a return or another, never both: rated base +
  // zero-rated + statutory has to be the three bills' own subtotals, no more.
  checkMoney("a zero-rated supply is not also inside the taxable base",
    Number(o.tax?.baseAmount ?? 0) + Number(o.tax?.zeroRatedBase ?? 0) +
    Number(o.tax?.statutoryCollected ?? 0), 3800000);
  check("tax block counts three bills", o.tax?.invoicesCount === 3, o.tax?.invoicesCount);
  check("tax block names the hand-built one", o.tax?.handBuiltCount === 1, o.tax?.handBuiltCount);
  check("the window is one month of trend", o.months?.length === 1, o.months?.map((m: any) => m.month));
  checkMoney("that month billed", o.months?.[0]?.billed, 4340000);
  checkMoney("that month spent", o.months?.[0]?.spend, 500000);
  checkMoney("that month netted", o.months?.[0]?.net, 3840000);
  check("the biggest customer leads", o.topCustomers?.[0]?.name === "Smoke Consignor Ltd", o.topCustomers?.[0]);
  check("the two consignor bills are one row", o.topCustomers?.[0]?.invoices === 2, o.topCustomers?.[0]?.invoices);
  checkMoney("consignor outstanding", o.topCustomers?.[0]?.outstanding, 3040000);
  checkMoney("consignor VAT", o.topCustomers?.[0]?.vat, 540000);
  check("the draft and cancelled bills are nowhere", o.topCustomers?.some((r: any) =>
    /Draft|Cancelled/.test(r.name)) === false, o.topCustomers?.map((r: any) => r.name));
  check("the fuel supplier leads the costs", o.topSuppliers?.[0]?.name === "Smoke Fuel Co", o.topSuppliers?.[0]);
  check("every figure is one currency", o.currency === "TZS", o.currency);
  check("the USD bill is disclosed instead of summed", o.mixedCurrency === true &&
    o.otherCurrencies?.length === 1 && o.otherCurrencies[0].currency === "USD" &&
    Number(o.otherCurrencies[0].billed) === 1062, o.otherCurrencies);

  // The default window is twelve months, and the older paper only appears there.
  const ovWide = await call("/finance/overview", fin);
  check("the twelve-month window covers twelve months", ovWide.json?.months?.length === 12,
    ovWide.json?.months?.length);
  check("the aged bill shows in the wider window",
    ovWide.json?.topCustomers?.some((r: any) => r.outstanding === 500000),
    ovWide.json?.topCustomers?.map((r: any) => [r.name, r.outstanding]));

  // -------------------------------------------------------------------------
  // Doors.
  // -------------------------------------------------------------------------
  check("a tokenless call is refused", (await call("/finance/overview", null)).status === 401);
  const noSeat = await call("/finance/overview", trn);
  check("a trainee cannot read the dashboard", noSeat.status === 403, noSeat.status);
  check("a trainee cannot read the tax position",
    (await call(`/finance/tax/position?kind=vat&periodStart=${P_FROM}&periodEnd=${P_TO}`, trn)).status === 403);
  check("a trainee cannot create a return",
    (await call("/finance/tax/returns", trn, {
      method: "POST", body: JSON.stringify({ kind: "vat", periodStart: P_FROM, periodEnd: P_TO })
    })).status === 403);
  const audPos = await call(`/finance/tax/position?kind=vat&periodStart=${P_FROM}&periodEnd=${P_TO}`, aud);
  check("an auditor reads the position", audPos.status === 200, audPos.json);
  const audCreate = await call("/finance/tax/returns", aud, {
    method: "POST", body: JSON.stringify({ kind: "vat", periodStart: P_FROM, periodEnd: P_TO })
  });
  check("an auditor cannot raise a return", audCreate.status === 403, audCreate.status);
  check("the director reads the dashboard", (await call("/finance/overview", dir)).status === 200);
  const badKind = await call(`/finance/tax/position?kind=income_tax&periodStart=${P_FROM}&periodEnd=${P_TO}`, fin);
  check("an unmodelled return kind is refused", badKind.status === 400, badKind.json);
  const badDate = await call("/finance/overview?from=whenever", fin);
  check("a date that is not a date is refused", badDate.status === 400, badDate.json);

  // -------------------------------------------------------------------------
  // The position for the closed period.
  // -------------------------------------------------------------------------
  const pos = await call(`/finance/tax/position?kind=vat&periodStart=${P_FROM}&periodEnd=${P_TO}`, fin);
  check("the position answers", pos.status === 200, pos.json);
  checkMoney("position base", pos.json?.figures?.baseAmount, 3000000);
  checkMoney("position charge", pos.json?.figures?.taxCharged, 540000);
  checkMoney("position statutory", pos.json?.figures?.statutoryCollected, 500000);
  checkMoney("position billed", pos.json?.figures?.billedTotal, 4340000);
  check("position is a computed one", pos.json?.computed === true, pos.json?.computed);
  check("the rate came from the register, not from memory",
    typeof pos.json?.standardVatRate === "number" && pos.json.standardVatRate > 0, pos.json?.standardVatRate);
  const notes: string[] = pos.json?.notes ?? [];
  check("it says only issued bills are footed", notes.some((n) => /issued bills only/.test(n)), notes);
  check("it says a hand-built bill has no section split",
    notes.some((n) => /typed at the desk/.test(n)), notes);
  check("it says zero-rated is not exempt", notes.some((n) => /counted as zero-rated/.test(n)), notes);
  check("it names the foreign paper it left out",
    notes.some((n) => /outside this return/.test(n)), notes);
  const expired = String(pos.json?.rates?.effectiveTo ?? "") < P_TO ||
    String(pos.json?.rates?.effectiveTo ?? "") < TODAY;
  check("the expired-rate warning matches the register it read",
    notes.some((n) => /register on file/.test(n)) === expired,
    { expired, rates: pos.json?.rates, notes: notes.filter((n) => /register/.test(n)) });

  const statPos = await call(`/finance/tax/position?kind=statutory_charges&periodStart=${P_FROM}&periodEnd=${P_TO}`, fin);
  checkMoney("a statutory return charges the pass-through", statPos.json?.figures?.taxCharged, 500000);
  checkMoney("a statutory return has no taxable base of its own", statPos.json?.figures?.baseAmount, 0);
  const whPos = await call(`/finance/tax/position?kind=withholding_vat&periodStart=${P_FROM}&periodEnd=${P_TO}`, fin);
  check("a withheld return says there is nothing to foot",
    whPos.json?.computed === false && whPos.json?.figures?.taxCharged === 0, whPos.json?.figures);
  check("and says why", (whPos.json?.notes ?? []).some((n: string) => /certificate of withholding/.test(n)),
    whPos.json?.notes);

  // -------------------------------------------------------------------------
  // The register: draft, prepared, filed, superseded.
  // -------------------------------------------------------------------------
  const created = await call("/finance/tax/returns", fin, {
    method: "POST",
    body: JSON.stringify({
      kind: "vat", periodStart: P_FROM, periodEnd: P_TO,
      taxCharged: 99999999, baseAmount: 1, inputTax: 0, creditsDeclared: 0, note: "smoke draft"
    })
  });
  check("a return is raised", created.status === 201, created.json);
  const R1 = created.json?.id as string;
  const got1 = await call(`/finance/tax/returns/${R1}`, fin);
  check("it is born a draft", got1.json?.status === "draft", got1.json?.status);
  check("its basis is computed", got1.json?.basis === "computed", got1.json?.basis);
  checkMoney("a typed charge is ignored: the base is the paper's", got1.json?.baseAmount, 3000000);
  checkMoney("a typed charge is ignored: the charge is the paper's", got1.json?.taxCharged, 540000);
  checkMoney("a typed charge is ignored: the net is the paper's", got1.json?.netPayable, 540000);
  check("the schedule was copied in", got1.json?.scheduleLines === 3, got1.json?.scheduleLines);
  check("three bills behind it", got1.json?.invoicesCount === 3, got1.json?.invoicesCount);
  check("the rates version is on the paper", got1.json?.ratesVersion === pos.json?.rates?.version,
    got1.json?.ratesVersion);

  const twice = await call("/finance/tax/returns", fin, {
    method: "POST",
    body: JSON.stringify({ kind: "vat", periodStart: P_FROM, periodEnd: P_TO })
  });
  check("a second open return for the same period is a conflict, not a crash",
    twice.status === 409 && /already has an open return/.test(twice.json?.error?.message ?? ""),
    twice.json);

  const nakedCredit = await call(`/finance/tax/returns/${R1}`, fin, {
    method: "PUT", body: JSON.stringify({ inputTax: 100000 })
  });
  check("an input credit with no source is refused",
    nakedCredit.status === 400 && nakedCredit.json?.error?.details?.[0]?.field === "inputBasis",
    nakedCredit.json);
  const typedCharge = await call(`/finance/tax/returns/${R1}`, fin, {
    method: "PUT", body: JSON.stringify({ taxCharged: 1, baseAmount: 2 })
  });
  check("an edit cannot lower the charge either",
    typedCharge.status === 200 && Number(typedCharge.json?.taxCharged) === 540000, typedCharge.json);
  const backwards = await call(`/finance/tax/returns/${R1}`, fin, {
    method: "PUT", body: JSON.stringify({ periodStart: P_TO, periodEnd: P_FROM })
  });
  check("a period the wrong way round is refused", backwards.status === 400, backwards.json);
  const credited = await call(`/finance/tax/returns/${R1}`, fin, {
    method: "PUT",
    body: JSON.stringify({ inputTax: 100000, inputBasis: PROVENANCE, note: "credit claimed" })
  });
  check("a sourced credit is taken", credited.status === 200 && Number(credited.json?.netPayable) === 440000,
    credited.json);
  const futurePeriod = await call(`/finance/tax/returns/${R1}`, fin, {
    method: "PUT", body: JSON.stringify({ periodEnd: FUTURE })
  });
  check("a period that has not finished is refused by the gate",
    futurePeriod.status === 409 && /has not finished/.test(futurePeriod.json?.error?.message ?? ""),
    futurePeriod.json);

  const dbNet = await oi(
    `select net_payable::text as net, tax_charged::text as charged, input_basis
     from tax_returns where id = $1`, [R1]);
  check("the row on disk foots to 440,000",
    dbNet.rows[0]?.net === "440000.00" && dbNet.rows[0]?.charged === "540000.00", dbNet.rows[0]);
  check("the row on disk kept the provenance", dbNet.rows[0]?.input_basis === PROVENANCE, dbNet.rows[0]);

  const posOpen = await call(`/finance/tax/position?kind=vat&periodStart=${P_FROM}&periodEnd=${P_TO}`, fin);
  check("the position points at the open return",
    posOpen.json?.openReturn?.id === R1 && posOpen.json?.openReturn?.status === "draft",
    posOpen.json?.openReturn);

  const audPrepare = await call(`/finance/tax/returns/${R1}/prepare`, aud, { method: "POST", body: "{}" });
  check("an auditor cannot freeze a return", audPrepare.status === 403, audPrepare.status);
  const prepared = await call(`/finance/tax/returns/${R1}/prepare`, fin, { method: "POST", body: "{}" });
  check("the return prepares", prepared.status === 200 && prepared.json?.status === "prepared", prepared.json);
  checkMoney("prepared net is the credited net", prepared.json?.netPayable, 440000);
  const prepTwice = await call(`/finance/tax/returns/${R1}/prepare`, fin, { method: "POST", body: "{}" });
  check("preparing twice is a conflict", prepTwice.status === 409, prepTwice.json);
  const gotPrepared = await call(`/finance/tax/returns/${R1}`, fin);
  check("the preparer is named on the paper", gotPrepared.json?.preparedByName === FIN_NAME,
    gotPrepared.json?.preparedByName);
  check("the schedule is on the paper", gotPrepared.json?.schedule?.length === 3,
    gotPrepared.json?.schedule?.length);
  check("the schedule carries the proforma split",
    gotPrepared.json?.schedule?.some((r: any) => r.from_proforma === true &&
      Number(r.statutory_base) === 500000), gotPrepared.json?.schedule);
  check("the zero-rated bill is on the schedule as zero-rated, not as a base",
    gotPrepared.json?.schedule?.some((r: any) => Number(r.untaxed_base) === 300000 &&
      Number(r.base_amount) === 0), gotPrepared.json?.schedule);

  const noRef = await call(`/finance/tax/returns/${R1}/file`, fin, {
    method: "PUT", body: JSON.stringify({ filedAt: TODAY })
  });
  check("filing without a reference is refused", noRef.status === 400, noRef.json);
  const shortRef = await call(`/finance/tax/returns/${R1}/file`, fin, {
    method: "PUT", body: JSON.stringify({ filingReference: "AB", filedAt: TODAY })
  });
  check("a stub reference is refused", shortRef.status === 400, shortRef.json);
  const audFile = await call(`/finance/tax/returns/${R1}/file`, aud, {
    method: "PUT", body: JSON.stringify({ filingReference: "TTMS-AUDITOR", filedAt: TODAY })
  });
  check("an auditor cannot file", audFile.status === 403, audFile.status);
  const filed = await call(`/finance/tax/returns/${R1}/file`, fin, {
    method: "PUT", body: JSON.stringify({ filingReference: "TTMS-2026-SMOKE-0001", filedAt: TODAY })
  });
  check("the return files", filed.status === 200 && filed.json?.status === "filed", filed.json);

  const editFiled = await call(`/finance/tax/returns/${R1}`, fin, {
    method: "PUT", body: JSON.stringify({ note: "trying to rewrite paper" })
  });
  check("a filed return cannot be edited",
    editFiled.status === 409 && /kept as filed/.test(editFiled.json?.error?.message ?? ""), editFiled.json);
  const delFiled = await call(`/finance/tax/returns/${R1}`, fin, { method: "DELETE" });
  check("a filed return cannot be withdrawn",
    delFiled.status === 409 && /kept as filed/.test(delFiled.json?.error?.message ?? ""), delFiled.json);

  const superseded = await call(`/finance/tax/returns/${R1}/supersede`, fin, { method: "POST", body: "{}" });
  check("a filed return is corrected by replacing it", superseded.status === 201, superseded.json);
  const R2 = superseded.json?.id as string;
  const got2 = await call(`/finance/tax/returns/${R2}`, fin);
  check("the replacement starts as a draft again", got2.json?.status === "draft", got2.json?.status);
  check("and names what it replaces", got2.json?.supersedesId === R1, got2.json?.supersedesId);
  checkMoney("it carries the figures it replaces", got2.json?.netPayable, 440000);
  check("and the schedule too", got2.json?.scheduleLines === 3, got2.json?.scheduleLines);
  const reCredited = await call(`/finance/tax/returns/${R2}`, fin, {
    method: "PUT", body: JSON.stringify({ inputTax: 140000, inputBasis: PROVENANCE })
  });
  check("the replacement can claim a different credit",
    reCredited.status === 200 && Number(reCredited.json?.netPayable) === 400000, reCredited.json);
  await call(`/finance/tax/returns/${R2}/prepare`, fin, { method: "POST", body: "{}" });
  const filed2 = await call(`/finance/tax/returns/${R2}/file`, fin, {
    method: "PUT", body: JSON.stringify({ filingReference: "TTMS-2026-SMOKE-0002", filedAt: TODAY })
  });
  check("the replacement files", filed2.status === 200, filed2.json);

  const chain = await oi(
    `select kind, status, net_payable::text as net, filing_reference, supersedes_id is not null as repl,
            period_start::text as ps
     from tax_returns where tenant_id = $1 and kind = 'vat' and period_start = $2::date
     order by created_at`, [T, P_FROM]);
  check("both versions of the period are on the register", chain.rowCount === 2, chain.rows);
  check("the filed one kept the figure it was filed on",
    chain.rows[0]?.net === "440000.00" && chain.rows[0]?.filing_reference === "TTMS-2026-SMOKE-0001",
    chain.rows[0]);
  check("the replacement foots to 400,000 and names its target",
    chain.rows[1]?.net === "400000.00" && chain.rows[1]?.repl === true &&
    chain.rows[1]?.filing_reference === "TTMS-2026-SMOKE-0002", chain.rows[1]);
  const posFiled = await call(`/finance/tax/position?kind=vat&periodStart=${P_FROM}&periodEnd=${P_TO}`, fin);
  check("a filed period has no open return", posFiled.json?.openReturn === null, posFiled.json?.openReturn);

  const listAll = await call("/finance/tax/returns", fin);
  check("the register lists both", listAll.json?.returns?.length === 2, listAll.json?.returns?.length);
  const listDraft = await call("/finance/tax/returns?status=draft", fin);
  check("a status filter answers nothing now", listDraft.json?.returns?.length === 0, listDraft.json?.returns);

  // A third return for a period already filed twice is legal — it is how a
  // re-assessment is recorded — so the desk must be able to back it out again.
  const third = await call("/finance/tax/returns", fin, {
    method: "POST", body: JSON.stringify({ kind: "vat", periodStart: P_FROM, periodEnd: P_TO })
  });
  check("another return for a filed period can still be raised", third.status === 201, third.json);
  const withdrawn = await call(`/finance/tax/returns/${third.json?.id}`, fin, { method: "DELETE" });
  check("an unfiled return is withdrawn", withdrawn.status === 200, withdrawn.json);
  check("and then is not there",
    (await call(`/finance/tax/returns/${third.json?.id}`, fin)).status === 404);
  const stillThere = await oi(
    `select status, deleted_at is not null as gone from tax_returns where id = $1`, [third.json?.id]);
  check("withdrawn means the row stays with a stamp on it",
    stillThere.rows[0]?.gone === true && stillThere.rows[0]?.status === "draft", stillThere.rows[0]);

  // The declared return — the only kind whose figures are typed.
  const nakedWh = await call("/finance/tax/returns", fin, {
    method: "POST",
    body: JSON.stringify({ kind: "withholding_vat", periodStart: P_FROM, periodEnd: P_TO, taxCharged: 60000 })
  });
  check("a declared return without its source is refused",
    nakedWh.status === 400 && /name the paper/.test(nakedWh.json?.error?.message ?? ""), nakedWh.json);
  const wh = await call("/finance/tax/returns", fin, {
    method: "POST",
    body: JSON.stringify({
      kind: "withholding_vat", periodStart: P_FROM, periodEnd: P_TO,
      taxCharged: 60000, baseAmount: 400000, inputBasis: "Three withholding certificates from Smoke Consignor Ltd"
    })
  });
  check("a declared return is raised", wh.status === 201, wh.json);
  const gotWh = await call(`/finance/tax/returns/${wh.json?.id}`, fin);
  check("its basis says declared", gotWh.json?.basis === "declared", gotWh.json?.basis);
  checkMoney("it holds the typed charge", gotWh.json?.taxCharged, 60000);
  checkMoney("and the typed base", gotWh.json?.baseAmount, 400000);
  check("it has no schedule to show", gotWh.json?.scheduleLines === 0, gotWh.json?.scheduleLines);
  await call(`/finance/tax/returns/${wh.json?.id}/prepare`, fin, { method: "POST", body: "{}" });
  const whFile = await call(`/finance/tax/returns/${wh.json?.id}/file`, fin, {
    method: "PUT", body: JSON.stringify({ filingReference: "TTMS-2026-SMOKE-0003", filedAt: TODAY })
  });
  check("a declared return files too", whFile.status === 200, whFile.json);
  const kindFilter = await call("/finance/tax/returns?kind=withholding_vat", fin);
  check("the register filters by kind", kindFilter.json?.returns?.length === 1, kindFilter.json?.returns);

  // The older period, whose only bill is the formula-named customer.
  const june = await call("/finance/tax/returns", fin, {
    method: "POST",
    body: JSON.stringify({ kind: "vat", periodStart: Q_FROM, periodEnd: Q_TO, taxCharged: 777000 })
  });
  const RJ = june.json?.id as string;
  const gotJ = await call(`/finance/tax/returns/${RJ}`, fin);
  // This period holds one bill and it carries no VAT, so the paper it foots is a
  // zero-rated supply: the 500,000 appears in the zero-rated column and not also
  // inside the base a rate is applied to.
  checkMoney("an older period foots its own paper", gotJ.json?.zeroRatedBase, 500000);
  checkMoney("and a zero-rated bill is never also a taxable base", gotJ.json?.baseAmount, 0);
  checkMoney("a zero-VAT bill charges nothing", gotJ.json?.taxCharged, 0);
  check("a nil return is still a return", gotJ.json?.netPayable === 0 && gotJ.json?.invoicesCount === 1,
    gotJ.json);
  await call(`/finance/tax/returns/${RJ}/prepare`, fin, { method: "POST", body: "{}" });

  // -------------------------------------------------------------------------
  // The CSV the accountant takes to the portal.
  // -------------------------------------------------------------------------
  const csvJ = await call(`/finance/tax/returns/${RJ}/schedule.csv`, aud);
  check("the schedule exports", csvJ.status === 200, csvJ.status);
  check("as a CSV download",
    /text\/csv/.test(csvJ.headers.get("content-type") ?? "") &&
    /attachment; filename="tax-return-vat-/.test(csvJ.headers.get("content-disposition") ?? ""),
    csvJ.headers.get("content-disposition"));
  const rows = csvJ.text.split("\r\n");
  check("header plus the one bill of that period", rows.length === 2, rows.length);
  // Every cell is quoted and none of the planted values contains a comma, so
  // splitting on "," is enough to read the file back the way a sheet would.
  const cells = (row: string) => row.split(",").map((c) => c.replace(/^"(.*)"$/s, "$1"));
  check("the customer is the fourth column", cells(rows[1])[3] === "'=cmd|'/C calc'!A0",
    cells(rows[1]));
  // The bill of this period carries no VAT, so its 500,000 must leave the file in
  // the zero-rated column. A sheet that only had "Taxable base" would show this
  // supply as a bill of nothing, and the accountant would drop it off the return.
  check("the zero-rated supply is exported in its own column",
    /"Zero-rated base"/.test(rows[0]) && Number(cells(rows[1])[6]) === 0 &&
    Number(cells(rows[1])[7]) === 500000, cells(rows[1]).slice(6, 9));
  const live = rows.flatMap(cells).filter((v) => /^[=+\-@\t\r]/.test(v));
  check("no cell is left as a live formula", live.length === 0, live);
  const csvWh = await call(`/finance/tax/returns/${wh.json?.id}/schedule.csv`, fin);
  check("a declared export says it has no schedule",
    /Declared return/.test(csvWh.text), csvWh.text.slice(0, 300));
  const csvMissing = await call("/finance/tax/returns/99999999-9999-7999-8999-999999999999/schedule.csv", fin);
  check("an unknown return is not exported", csvMissing.status === 404, csvMissing.status);

  // -------------------------------------------------------------------------
  // Isolation: the same seat aimed at a company with no paper.
  // -------------------------------------------------------------------------
  const strangerOv = await call("/finance/overview", stranger);
  check("a foreign tenant gets an empty dashboard, not a refusal",
    strangerOv.status === 200 && Number(strangerOv.json?.receivable?.billed) === 0 &&
    Number(strangerOv.json?.tax?.invoicesCount) === 0, strangerOv.json?.receivable);
  const strangerList = await call("/finance/tax/returns", stranger);
  check("a foreign tenant sees no returns", strangerList.status === 200 &&
    strangerList.json?.returns?.length === 0, strangerList.json);
  check("a foreign tenant cannot read this company's return",
    (await call(`/finance/tax/returns/${R1}`, stranger)).status === 404);
  check("a foreign tenant cannot file it either",
    (await call(`/finance/tax/returns/${R1}/file`, stranger, {
      method: "PUT", body: JSON.stringify({ filingReference: "NOT-MINE", filedAt: TODAY })
    })).status === 404);
  // A token is not a membership: the duty lookup resolves by user id alone, so this
  // seat is told it is a finance officer of a company it does not belong to. The
  // boundary that has to hold is the data one — it may only ever foot that company's
  // own (empty) paper, and nothing it does can reach into this register.
  const strangerWrite = await call("/finance/tax/returns", stranger, {
    method: "POST", body: JSON.stringify({ kind: "vat", periodStart: P_FROM, periodEnd: P_TO })
  });
  check("the stranger seat raises its own return", strangerWrite.status === 201, strangerWrite.json);
  const strangerRow = await oi(
    `select tenant_id::text as tid, invoices_count, tax_charged::text as charged,
            net_payable::text as net
     from tax_returns where id = $1`, [strangerWrite.json?.id]);
  check("and it footed none of this company's paper",
    strangerRow.rows[0]?.tid === T2 && Number(strangerRow.rows[0]?.invoices_count) === 0 &&
    strangerRow.rows[0]?.charged === "0.00" && strangerRow.rows[0]?.net === "0.00",
    strangerRow.rows[0]);
  const oursAfter = await oi(
    `select count(*)::int as n from tax_returns
     where tenant_id = $1 and kind = 'vat' and period_start = $2::date
       and deleted_at is null and status <> 'filed'`, [T, P_FROM]);
  check("and this company's period keeps only what was filed", oursAfter.rows[0]?.n === 0, oursAfter.rows[0]);

  // -------------------------------------------------------------------------
  // The audit trail the desk is obliged to leave.
  // -------------------------------------------------------------------------
  const trail = await oi(
    `select action, count(*)::int as n from audit_logs
     where tenant_id = $1 and entity = 'tax_returns' group by action order by action`, [T]);
  const seenActions = new Set(trail.rows.map((r: any) => r.action as string));
  for (const a of ["tax.return.drafted", "tax.return.updated", "tax.return.prepared",
    "tax.return.filed", "tax.return.superseded", "tax.return.withdrawn"]) {
    check(`audited ${a}`, seenActions.has(a), [...seenActions]);
  }

  // -------------------------------------------------------------------------
  // Teardown.
  // -------------------------------------------------------------------------
  // A filed return is refused to everybody, including the seat that filed it — that
  // is what the 090 gate is for. Removing a fixture that filed paper therefore
  // needs the gate lifted, and it is lifted inside the same transaction as the
  // sweep: DDL is transactional, so a crash mid-sweep rolls the whole thing back and
  // the trigger is left enabled rather than silently removed from production.
  for (const tid of [T, T2]) {
    await oi("begin");
    await oi(`alter table tax_returns disable trigger trg_tax_return_gate`);
    for (const sql of [
      `delete from tax_returns where tenant_id = $1`,
      `delete from freight_invoice_payments where tenant_id = $1`,
      `delete from freight_invoice_items where tenant_id = $1`,
      `delete from freight_invoices where tenant_id = $1`,
      `delete from quotations where tenant_id = $1`,
      `delete from freight_expenses where tenant_id = $1`,
      `delete from user_roles where user_id in (select id from users where tenant_id = $1)`,
      `delete from sessions where user_id in (select id from users where tenant_id = $1)`,
      `delete from users where tenant_id = $1`,
      `delete from company_profiles where tenant_id = $1`,
      `delete from tenants where id = $1`
    ]) {
      await oi(sql, [tid]).catch((e: any) => console.log(`sweep note: ${String(e.message).slice(0, 90)}`));
    }
    await oi(`alter table tax_returns enable trigger trg_tax_return_gate`);
    await oi("commit");
  }
  const gateBack = await oi(
    `select tgenabled = 'O' as enabled from pg_trigger
     where tgname = 'trg_tax_return_gate' and not tgisinternal`);
  check("the gate is enabled again", gateBack.rows.every((r: any) => r.enabled === true), gateBack.rows);
  const left = await oi(
    `select (select count(*) from tax_returns where tenant_id = any($1::uuid[]))::int as returns,
            (select count(*) from freight_invoices where tenant_id = any($1::uuid[]))::int as bills,
            (select count(*) from tenants where id = any($1::uuid[]))::int as tenants`, [[T, T2]]);
  check("the fixture is gone", left.rows[0].returns === 0 && left.rows[0].bills === 0 &&
    left.rows[0].tenants === 0, left.rows[0]);
  const paperLeft = await oi(
    `select count(*)::int as n from audit_logs where tenant_id = any($1::uuid[])`, [[T, T2]]);
  console.log(`(audit_logs keeps ${paperLeft.rows[0].n} rows for the swept tenants — the register is append-only)`);

  await owner.end();
}

main().then(() => {
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nfinance smoke passed");
}).catch((e) => { console.error(e); process.exit(1); });
