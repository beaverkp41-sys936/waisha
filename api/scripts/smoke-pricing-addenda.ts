/**
 * The charges that sit on top of a price, over HTTP — smoke for #420 (migration 141 and
 * `control-pricing-addenda.routes.ts`).
 *
 * `verify-pricing-addenda-sql.ts` ran the register's whole life inside one transaction: it opened both
 * kinds, signed one, took places, spent a signature, composed a job and read the sum back. 199 checks.
 * This file is not a shorter version of that probe. It grades the six things that only exist once a door
 * is reachable from a desk:
 *
 *  - that all fourteen doors are really mounted, and that the three duties 140 minted are the three that
 *    cover them: a reader of charges cannot open one, the seat that types figures is not thereby allowed
 *    to ask anyone to sign them, and a seat holding no pricing duty is refused before a door is reached;
 *  - that the two halves of a refusal stay distinguishable. Five decimals on a figure is 141's own route
 *    rule with a `field` annotation; `bad_basis` naming the seven words a surcharge is worked out on is
 *    the register's sentence with nothing rewritten; `route … is not a corridor of the book that owns …`
 *    is a trigger's, and the `141: ` the tables put on the front must never reach the desk;
 *  - that the status the route chose is the status the desk gets: `not_found` as 404 because the row is
 *    not in this book, `paper_is_out`, `kind_moved`, `kind_is_not_counted` and a trigger's `cannot` as
 *    409 because the row the clerk is staring at is the obstacle, `bad_status` and the vocabulary
 *    refusals as 400;
 *  - that the two-person rule survives the trip: the seat that raised a charge's paper is refused when it
 *    tries to answer its own paper — 121's check arriving through 141's door as
 *    `refused_the_signature_first` — and the words the second seat typed come back out of
 *    `pricing_addendum_detail` as `approval.decided_note`, which is the whole reason the desk can render
 *    a refusal to a clerk rather than a bare "rejected";
 *  - that every accepted write is audited exactly once by the door that made it and that no read writes
 *    anything: 141's doors call `platform_auth.money_audit` inside their own statement, so a route that
 *    audited on top would double the register;
 *  - that two office books are two worlds. The API role is BYPASSRLS, so the tenant bound into the first
 *    parameter is the only guard there is: another book's seat reading, editing, proposing, refusing,
 *    claiming or discarding this book's charge is answered 404 on every one of those doors.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO.
 *
 *  1. It never spends a signature. `apply_pricing_addendum` is not a route — it is 121's effect, run by
 *     the Approvals register in the order 141 documents (decide → claim → apply → settle) and proved in
 *     the SQL gate. And it could not be spent here even through Approvals' own doors: a published charge
 *     is kept (`pricing_addenda_are_kept` raises on DELETE for anything that ever carried a paper or was
 *     live), every place taken is kept (`pricing_addendum_claims_are_kept`), the memory rows publish,
 *     withdraw and claim write are kept (`pricing_addendum_history_is_kept` raises on UPDATE and DELETE
 *     for every role) and none of them cascade from `pricing_addenda`. So one accepted publication would
 *     make this run's fixture book permanently undeletable and break the teardown of every smoke that
 *     sweeps by name after it. Same rule 140's run lives under.
 *  2. Therefore the places and the composer are met as refusals and plumbing only. `claim` requires a
 *     published row, so what this run can prove about it is that a draft refuses a place in the register's
 *     words and that a void of a place that was never taken is a 404; `price_a_job` calls 140's freight
 *     resolver before it looks at a single charge, so with no published card in either book it answers
 *     `no_price` — which is exactly the ordering proof: an unknown code typed against an unpriced scope
 *     is answered "the price has not been set", not "I don't know that code". The arithmetic of a live
 *     levy on a live price is the gate's, and it is proved there.
 *  3. It also cannot reach half the doors' internal refusals, because the route measures the same column
 *     as the register does and measures first: a one-character code, a negative floor, an 11-digit
 *     figure, a `EUR` money, a `value` in `clear` and a seven-character reason are all answered by 141's
 *     zod shape and never by the door that would have said the same thing. Those refusals are the gate's.
 *
 * SAFETY: both books are this run's own synthetic platform tenants, found by name prefix, and the
 * corridors are found by their `PR Addendum` name. A charge whose paper was refused is un-pointed and
 * put back to draft by hand at the end — the register keeps it on purpose and a fixture book must not.
 * Audit lines and the sequence numbers they spent stay behind: `prevent_audit_mutation()` refuses the
 * owner too, and a sequence is not a row. No real company, no real price list and no real discount code
 * is touched.
 *
 * Run: npx tsx scripts/smoke-pricing-addenda.ts
 *      (API on :4000, or SMOKE_API_BASE=http://localhost:4100/api/v1)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

const API = process.env.SMOKE_API_BASE ?? "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `pra${STAMP}`;
const BOOK_SWEEP = "PR Addendum %";
const EMAIL_SWEEP = `smoke.pra.%@waisha.test`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function note(label: string) { console.log(`note ${label}`); }
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, opts: {
  ck?: string; method?: string; body?: any;
} = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: opts.ck } : {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const code = (r: { json: any }) => r.json?.error?.code ?? null;
/** Three writers can answer one call: the route's zod shape (a sentence plus a `field`), a 141 door
 *  (a sentence plus its own figures in `details[0]`) and a table guard (the sentence a `raise` wrote, with
 *  `141: ` cut off by the route). Joined, so "the register's own words" cannot pass on a guard's
 *  paraphrase, and a check that the prefix never arrives is not satisfied by a door that never had one. */
const words = (r: { json: any }) => [String(r.json?.error?.message ?? ""),
  ...(Array.isArray(r.json?.error?.details)
    ? r.json.error.details.map((d: any) => typeof d === "object" && d !== null
      ? [String(d.field ?? ""), String(d.message ?? ""),
        ...Object.entries(d).filter(([k, v]) => !["field", "message"].includes(k)
          && ["string", "number", "boolean"].includes(typeof v))
        .map(([k, v]) => `${k}:${v}`)].filter(Boolean).join(" ")
      : String(d)) : [])].join(" | ");

async function main() {
  const up = await fetch(`${API}/control/auth/permissions`).catch(() => null);
  if (!up) throw new Error(`the api is not answering on ${API} — start it before this run`);
  if (up.status !== 401 && up.status !== 403) {
    throw new Error(`${API}/control/auth/permissions answered ${up.status}, not the 401 an anonymous `
      + "probe takes — that is not the api this run signs into");
  }
  note(`api answers on ${API}`);

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];
  const row = async (t: string, id: string): Promise<any> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
      throw new Error(`no ${t} row to read back: the door never returned an id (${JSON.stringify(id)}). `
        + "An earlier check in this phase FAILed — read the line above it.");
    }
    return (await one(`select * from ${t} where id = $1::uuid`, [id]));
  };
  /** `pg` hands a bare `date` column back as a Date at local midnight and this box runs at UTC+3, so
   *  `.toISOString()` prints the day before the one the row carries. Ask the database for the string the
   *  papers use instead of converting it in the probe. */
  const chargeRow = (id: string) => one(`select tenant_id, ref, code, kind, label, currency, status,
      version, basis, value::text as value, cap::text as cap, min_amount::text as min_amount,
      max_uses, route_id, vehicle_class, container_type, refusals, approval_id, published_at,
      to_char(effective_from,'YYYY-MM-DD') as effective_from,
      to_char(effective_to,'YYYY-MM-DD') as effective_to, created_by, updated_by
      from pricing_addenda where id = $1::uuid`, [id]);

  // The schema's own totals before anything is written: the run ends on the same numbers.
  const START = await one(`select
      (select count(*) from pricing_addenda) as charges,
      (select count(*) from pricing_addendum_claims) as places,
      (select count(*) from pricing_addendum_history) as memory,
      (select count(*) from platform_approvals where action = 'pricing.addendum') as papers,
      (select count(*) from routes where name like 'PR Addendum %') as corridors`);
  note(`charge register found: ${START.charges} charges, ${START.places} places, ${START.memory} memory `
    + `rows, ${START.papers} papers and ${START.corridors} smoke corridors already filed`);

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = ["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor",
    "director"].filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);

  // 141 deliberately minted no fourth duty — the charge doors run on 140's three keys. If a grant moved,
  // every 403 below would pass for the wrong reason, so the run checks its own ground first.
  const grants = await one(`select
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'super_admin' and rp.permission_key like 'control.pricing.%') as own,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key like 'control.pricing.%') as bill,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key like 'control.pricing.%') as pen,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'platform_analyst' and rp.permission_key like 'control.pricing.%') as read,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'auditor' and rp.permission_key like 'control.pricing.%') as audit,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'director' and rp.permission_key like 'control.pricing.%') as dir`);
  if (Number(grants.own) !== 3 || Number(grants.bill) !== 3 || Number(grants.pen) !== 1
      || Number(grants.read) !== 1 || Number(grants.audit) !== 1 || Number(grants.dir) !== 0) {
    throw new Error(`140's three pricing duties are not the ones 141's doors take — ${JSON.stringify(grants)}`);
  }

  // ---------------- fixtures ----------------
  const TP = randomUUID();   // the book this run signs in at
  const TX = randomUUID();   // a second book, to be kept out of
  const uOwn = randomUUID(); // super_admin: all three duties
  const uBill = randomUUID(); // billing_admin: all three too, and the seat that raises papers
  const uRead = randomUUID(); // finance_officer: reads only
  const uAn = randomUUID();  // platform_analyst: reads only
  const uAud = randomUUID(); // auditor: reads only
  const uDir = randomUUID(); // director: no pricing duty at all
  const uEst = randomUUID(); // a super_admin in the other book

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [BOOK_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (all.length) {
      const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
        .rows.map((r: any) => r.id);
      // The register's own order, backwards. A charge that ever carried a paper is kept and a charge that
      // is not a draft is not editable, so the paper comes off and the row goes back to being a draft
      // before either can be touched — and the columns the hand moves are the two 141's header guard
      // freezes nothing of: `status` and `approval_id` are neither identity nor figure. A charge that was
      // actually published is not swept; the trigger raises, and it should: this run never spends a
      // signature, so one would mean the lifecycle leaked into HTTP.
      await oi(`update pricing_addenda set approval_id = null, status = 'draft'
                  where tenant_id = any($1::uuid[]) and published_at is null
                    and (approval_id is not null or status <> 'draft')`, [all]);
      await oi(`delete from pricing_addenda where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from platform_approvals where action = 'pricing.addendum'
                 and proposed_by = any($1::uuid[])`, [uids.length ? uids : [randomUUID()]]);
      await oi(`delete from routes where tenant_id = any($1::uuid[])`, [all]);
      if (uids.length) {
        await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
        await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
      }
      await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    }
    // 141's buckets are `charges-*` and `charge-*` plus the composer's `pricing-job:`; 140's are `pricing-*`.
    await oi(`delete from rate_limits where bucket ~ '^(charge|pricing)'`);
  };

  const T0 = Date.now();
  await sweep();

  await oi(`insert into tenants (id, type, name, status, trial_ends_at) values
      ($1,'platform',$2,'active', now() + interval '30 days'),
      ($3,'platform',$4,'active', now() + interval '30 days')`,
    [TP, `PR Addendum Book ${STAMP}`, TX, `PR Addendum Other ${STAMP}`]);

  const seat = (id: string, tenant: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
          now() - interval '200 days')`,
      [id, tenant, name, `smoke.pra.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
  await seat(uOwn, TP, "Rashid Owner");
  await seat(uBill, TP, "Baraka Bill");
  await seat(uRead, TP, "Neema Ledger");
  await seat(uAn, TP, "Asha Analyst");
  await seat(uAud, TP, "Daudi Audit");
  await seat(uDir, TP, "Fatma Director");
  await seat(uEst, TX, "Esther Other");

  await oi(`insert into user_roles (user_id, role_id) values
        ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12),($13,$14)`,
    [uOwn, rid("super_admin"), uBill, rid("billing_admin"), uRead, rid("finance_officer"),
      uAn, rid("platform_analyst"), uAud, rid("auditor"), uDir, rid("director"),
      uEst, rid("super_admin")]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-pricing-addenda',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uOwn, TP, "own"], [uBill, TP, "bill"], [uRead, TP, "read"], [uAn, TP, "an"],
    [uAud, TP, "aud"], [uDir, TP, "dir"], [uEst, TX, "est"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const asOwn = { ck: ck("own") };
  const asBill = { ck: ck("bill") };
  const asRead = { ck: ck("read") };
  const asAn = { ck: ck("an") };
  const asAud = { ck: ck("aud") };
  const asDir = { ck: ck("dir") };
  const asEst = { ck: ck("est") };

  const TODAY = new Date().toISOString().slice(0, 10);

  /** Open a charge with the shape every one of 141's drafts needs: a kind, a name said out loud, a basis
   *  that kind permits and a figure. Overridable per call so a refusal probe changes one field only. */
  const openCharge = (who: string, body: any) => call("/control/pricing/charges", {
    ck: ck(who), method: "POST",
    body: { currency: "TZS", note: "The office's own levy for this season.", ...body }
  });

  // ---------------- 1. the doors are shut ----------------
  phase("141's charge doors take the pricing desk's three duties");
  let r = await call("/control/pricing/charges");
  check("a charge board with no session is 401, not an empty board",
    r.status === 401, { s: r.status, w: words(r) });

  for (const [path, method] of [
    ["/control/pricing/charges", "GET"],
    ["/control/pricing/charges/in-force", "GET"],
    ["/control/pricing/job", "GET"]
  ] as [string, string][]) {
    r = await call(path, { ck: ck("dir"), method });
    check(`a seat holding no pricing duty is refused ${method} ${path.split("/pricing/")[1]}`,
      r.status === 403 && code(r) === "FORBIDDEN", { s: r.status, w: words(r) });
  }

  // The read duty is one key and the pen another: 141 has five reads, seven pen doors and two signature
  // doors, and the split is the claim, not an accident of which function each seat happens to call. One
  // check per door, all three reader seats inside it — a run that only graded the last seat tried would
  // pass on a door that lets one reader through.
  const DRAFT_DOORS: [string, string, any][] = [
    ["/control/pricing/charges", "POST", { kind: "surcharge", code: `READ ${STAMP}`,
      label: "Reader's levy", basis: "flat", value: "5000", note: "A reader trying to open a draft." }],
    [`/control/pricing/charges/${randomUUID()}`, "PATCH", { note: "A reader trying to change a draft." }],
    [`/control/pricing/charges/${randomUUID()}/discard`, "POST",
      { reason: "A reader throwing a draft away." }],
    [`/control/pricing/charges/${randomUUID()}/clone`, "POST", { note: "A reader cloning forward." }],
    [`/control/pricing/charges/${randomUUID()}/withdraw`, "POST",
      { effective_to: TODAY, reason: "A reader stopping a live levy." }],
    [`/control/pricing/charges/${randomUUID()}/claims`, "POST",
      { subject_kind: "customer", subject_id: randomUUID(), note: "A reader taking a place." }]
  ];
  for (const [path, method, body] of DRAFT_DOORS) {
    const statuses: Record<string, number> = {};
    for (const who of ["read", "an", "aud"]) {
      r = await call(path, { ck: ck(who), method, body });
      statuses[who] = r.status;
    }
    check(`a seat with the read and not the pen is refused the ${method} on `
      + `${path.split("/pricing/")[1]} — all three readers, 403 each`,
      Object.values(statuses).every((s) => s === 403), { s: statuses, w: words(r) });
  }

  for (const who of ["read", "aud", "an"]) {
    r = await call(`/control/pricing/charges/${randomUUID()}/publish`, { ck: ck(who),
      method: "POST", body: { reason: "A reader asking a second seat to sign." } });
    check(`${who} holds the read and not the pen: putting a charge up for a signature is a third duty`,
      r.status === 403, { s: r.status, w: words(r) });
    r = await call(`/control/pricing/charges/${randomUUID()}/refuse`, { ck: ck(who),
      method: "POST", body: { note: "A reader answering a paper." } });
    check(`…and answering a paper is that same third duty, not the read`,
      r.status === 403, { s: r.status, w: words(r) });
  }

  r = await call("/control/pricing/charges/in-force", asDir);
  check("a seat with no duty is refused the availability read too, before the register is named",
    r.status === 403 && !/not_found/.test(words(r)), { s: r.status, w: words(r) });

  // The navigation probe has to name the duties or a held duty is an invisible tab (067's lesson). 141
  // added doors, not keys, so the desk's charges tab is already reachable for the same six seats.
  r = await call("/control/auth/permissions", asRead);
  const held: string[] = r.json?.permissions ?? [];
  check("the navigation is told a reader may open the charge register and not write it",
    r.status === 200 && held.includes("control.pricing.view")
    && !held.includes("control.pricing.manage") && !held.includes("control.pricing.publish"),
    { s: r.status, p: held.filter((k) => k.startsWith("control.pricing")) });
  r = await call("/control/auth/permissions", asBill);
  const heldBill: string[] = r.json?.permissions ?? [];
  check("…and the billing admin is offered all three, because the charge desk shows the pen and the paper",
    heldBill.includes("control.pricing.view") && heldBill.includes("control.pricing.manage")
    && heldBill.includes("control.pricing.publish"),
    { s: r.status, p: heldBill.filter((k) => k.startsWith("control.pricing")) });

  // ---------------- 2. the words, an empty book, and what is not there ----------------
  phase("the register's two words, from the register");
  r = await call("/control/pricing/charges", asAn);
  const kinds = r.json?.kinds ?? [];
  const kind = (k: string) => kinds.find((x: any) => x.key === k);
  check("an unused book answers a board, not an error, and the board carries its own kind chips",
    r.status === 200 && r.json?.total === 0 && Array.isArray(r.json?.rows)
    && kinds.length === 2, { s: r.status, t: r.json?.total, k: kinds.map((x: any) => x.key) });
  check("a surcharge is the standing word: prefix SUR, sign +1, places not counted, seven bases",
    kind("surcharge")?.prefix === "SUR" && kind("surcharge")?.sign === 1
    && kind("surcharge")?.counted === false
    && kind("surcharge")?.basis_set?.length === 7, kind("surcharge"));
  check("a promo is the counted word: prefix PRM, sign -1, and only the two bases that take money off",
    kind("promo")?.prefix === "PRM" && kind("promo")?.sign === -1
    && kind("promo")?.counted === true
    && JSON.stringify(kind("promo")?.basis_set) === JSON.stringify(["percent_off", "amount_off"]),
    kind("promo"));

  r = await call("/control/pricing/charges?status=live", asRead);
  check("a status the register has never heard of is answered with the five it keeps, and the word it "
    + "was asked for is printed back",
    r.status === 400 && /draft/.test(words(r)) && /withdrawn/.test(words(r))
    && /asked:live/.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges?kind=vat", asRead);
  check("a third kind is the board's refusal, in the board's own words, naming the two words it has",
    r.status === 400 && /knows two charges: surcharge, promo/.test(words(r))
    && /asked:vat/.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges?kind=PROMO", asRead);
  check("a kind typed in capitals is the same chip: the register lower-cases and the desk is spared",
    r.status === 200 && r.json?.total === 0, { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges/in-force", asAn);
  check("nothing is in force in a book that has never signed a charge, and the day asked is named back",
    r.status === 200 && r.json?.count === 0 && r.json?.asked_on === TODAY,
    { s: r.status, c: r.json?.count, d: r.json?.asked_on });

  r = await call("/control/pricing/charges/in-force?day=2026-02-30", asAn);
  check("there is no such day on a calendar, and the desk is told so before the register is asked",
    r.status === 400 && /calendar/.test(words(r)), { s: r.status, w: words(r) });

  // No corridor is named, so 140's resolver is asked the price question and answers it before the
  // composer ever looks at a code. A scope this book does not have would be refused by 140 as a bad
  // corridor instead, and the check would prove nothing about the order.
  r = await call(`/control/pricing/job?day=${TODAY}&teu=2&promo_codes=NEWYEAR`, asRead);
  check("the composer answers the freight question first: an unknown code against an unpriced scope is "
    + "`no_price`, a 404 that names the day and not the code",
    r.status === 404 && /has not been set/.test(words(r)) && words(r).includes(TODAY)
    && !/NEWYEAR/.test(words(r)), { s: r.status, w: words(r) });

  for (const q of ["teu=0", "days=0", "tonnes=-1", "bogus=1", "promo_codes=" + "A".repeat(201)]) {
    r = await call(`/control/pricing/job?${q}`, asRead);
    check(`a composer question the route can already tell is malformed (${q}) is a 400 before the register`,
      r.status === 400, { s: r.status, w: words(r) });
  }

  r = await call(`/control/pricing/charges/${randomUUID()}`, asRead);
  check("one charge that is not in this book is a 404 in the door's words, not an empty detail",
    r.status === 404 && /no charge with that number in this book/i.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges/not-a-uuid", asRead);
  check("a charge number typed into the address bar never reaches the register",
    r.status === 400 && /VALIDATION_FAILED/.test(String(code(r))), { s: r.status, w: words(r) });

  // ---------------- 3. the corridor both books need ----------------
  phase("a corridor to lay a charge on");
  const CORRIDOR = `PR Addendum Dar–Kigoma ${STAMP}`;
  r = await call("/control/pricing/corridors", { ck: ck("own"), method: "POST", body: {
    name: CORRIDOR, origin: "Dar es Salaam", dest: "Kigoma", distance_km: "812.6" } });
  const corridorId = String(r.json?.corridor?.id ?? "");
  check("140's corridor door still files the road this register lays a charge on",
    r.status === 200 && corridorId.length > 30, { s: r.status, c: corridorId });

  r = await call("/control/pricing/corridors", { ck: ck("est"), method: "POST", body: {
    name: `PR Addendum Other leg ${STAMP}`, origin: "Mwanza", dest: "Tunduma",
    distance_km: "1100" } });
  const otherCorridorId = String(r.json?.corridor?.id ?? "");
  check("the other book files its own corridor, and this run now holds one road in each world",
    r.status === 200 && otherCorridorId.length > 30 && otherCorridorId !== corridorId,
    { s: r.status, c: otherCorridorId });

  // ---------------- 4. what the route measures before the register ----------------
  phase("the guards that stand in front of the door");
  const SUR_CODE = `fuel sur ${STAMP}`;      // typed the way a clerk says it
  const goodSur = { kind: "surcharge", code: SUR_CODE, label: "Fuel surcharge",
    basis: "percent_of_freight", value: "12.5", cap: "150000",
    route: corridorId, vehicle_class: "trailer", note: "The office's fuel levy on a trailer leg." };

  r = await openCharge("own", { ...goodSur, value: "1.23456" });
  check("five decimals never reach the register: a figure is numeric(14,4) and the route says so, "
    + "with the field named",
    r.status === 400 && /four decimals/.test(words(r)) && /value/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCharge("own", { ...goodSur, value: "99999999999" });
  check("eleven digits is the route's refusal too — and it is the same sentence the register would have said",
    r.status === 400 && /value/.test(words(r)) && !/keystroke/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("own", { ...goodSur, currency: "EUR" });
  check("a third money is refused by the shape, naming the field and never the register",
    r.status === 400 && /currency/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("own", { ...goodSur, code: "F" });
  check("a one-character code is too short for the route and for the register in the same breath",
    r.status === 400 && /code/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("own", { ...goodSur, note: "7 chars" });
  check("a note under eight characters is refused with the field named: it is what a second seat reads",
    r.status === 400 && /note/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("own", { ...goodSur, effective_from: "2026-02-30" });
  check("a shape-only date is caught by the route, not by a 22007 nobody at the desk can read",
    r.status === 400 && /calendar/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("own", { ...goodSur, unexpected: "typed into the wrong key" });
  check("a body key 141's doors do not take is refused rather than dropped",
    r.status === 400 && /unexpected/.test(words(r).toLowerCase()), { s: r.status, w: words(r) });

  // ---------------- 5. what the register answers in its own words ----------------
  phase("the door's refusals, in the door's words");
  r = await openCharge("bill", { ...goodSur, kind: "levy" });
  check("a kind that is not one of the two is answered by the door that keeps them, and it names them",
    r.status === 400 && /Say which charge this is/.test(words(r))
    && /surcharge, promo/.test(words(r)) && /asked:levy/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, code: ".fuel surcharge" });
  check("a code the register cannot print is refused with the shape it wants, after its own normalising",
    r.status === 400 && /capitals with underscores/.test(words(r))
    && /\.FUEL_SURCHARGE/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, value: "0" });
  check("a charge of nothing is refused by the door, and the door says why it is not stored",
    r.status === 400 && /A charge of nothing is a row with no purpose/.test(words(r))
    && /asked:0/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, value: "140" });
  check("140% of a freight is not a percentage: the refusal carries the figure and the basis it was asked on",
    r.status === 400 && /is not a percentage/.test(words(r)) && /asked:140/.test(words(r))
    && /basis:percent_of_freight/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, cap: "0" });
  check("a ceiling of nothing is a door refusal that says a ceiling is a positive figure or no ceiling",
    r.status === 400 && /A ceiling is a positive figure/.test(words(r)) && /asked:0/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, basis: "percent_off" });
  check("a surcharge worked out as a discount is refused with the seven words that kind actually knows",
    r.status === 400 && /A surcharge is never worked out on a percent_off basis/.test(words(r))
    && /per_cbm/.test(words(r)) && /kind:surcharge/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, max_uses: 10 });
  check("a standing levy with a ceiling on places is a conflict, because the row in front of the desk "
    + "cannot run out",
    r.status === 409 && /no places to run out of/.test(words(r)) && /kind:surcharge/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, route: otherCorridorId });
  check("a road the book does not have is refused by the table that guards it — and the door's own words "
    + "arrive with no `141:` on the front",
    r.status === 409 && /is not a corridor of the book that owns/.test(words(r))
    && !/141:/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCharge("bill", { ...goodSur, vehicle_class: "tanker9" });
  check("a vehicle class outside the register's vocabulary is refused by the guard, and it is a 400 "
    + "because nothing the desk is staring at is the obstacle",
    r.status === 400 && /is not a vehicle class this register knows/.test(words(r))
    && !/141:/.test(words(r)), { s: r.status, w: words(r) });

  let n = await one(`select count(*)::int as n from pricing_addenda where tenant_id = $1`, [TP]);
  check("and none of the eleven refusals above left a row: a refused write writes nothing",
    n.n === 0, n);

  // ---------------- 6. two charges, one of each word ----------------
  phase("a levy and a code, opened");
  r = await openCharge("bill", goodSur);
  const surEnv = r.json ?? {};
  const sur = surEnv.addendum ?? {};
  const surId = String(sur.id ?? "");
  check("a surcharge is opened from the desk, in the words the register spells, and the ref is minted "
    + "off the kind's own prefix",
    r.status === 200 && sur.code === `FUEL_SUR_${STAMP}` && sur.kind === "surcharge"
    && sur.sign === 1 && sur.version === 1 && sur.status === "draft"
    && /^SUR-\d{4}-\d{5,}$/.test(String(sur.ref)),
    { s: r.status, c: sur.code, k: sur.kind, v: sur.version, ref: sur.ref });

  const dbSur = await chargeRow(surId);
  check("the row is in this book, on this corridor, with the figure the door was given and no paper",
    dbSur.tenant_id === TP && String(dbSur.route_id) === corridorId && dbSur.kind === "surcharge"
    && dbSur.basis === "percent_of_freight" && dbSur.value === "12.5000"
    && dbSur.cap === "150000.00" && dbSur.min_amount === null && dbSur.max_uses === null
    && dbSur.vehicle_class === "trailer" && dbSur.refusals === 0 && dbSur.approval_id === null
    && dbSur.effective_from === TODAY && String(dbSur.created_by) === uBill,
    { v: dbSur.value, c: dbSur.cap, m: dbSur.max_uses, ef: dbSur.effective_from });

  const PROMO_CODE = `newyear ${STAMP}`;
  r = await openCharge("own", { kind: "promo", code: PROMO_CODE, label: "New year discount",
    basis: "percent_off", value: "10", cap: "500000", min_amount: "5000", max_uses: 25,
    currency: "TZS", note: "Twenty-five customers only, off the payable." });
  const promoEnv = r.json ?? {};
  const promo = promoEnv.addendum ?? {};
  const promoId = String(promo.id ?? "");
  check("a discount code opens as the counted word, with its places on the same row",
    r.status === 200 && promo.code === `NEWYEAR_${STAMP}` && promo.kind === "promo"
    && promo.sign === -1 && promo.counted === true && /^PRM-\d{4}-\d{5,}$/.test(String(promo.ref)),
    { s: r.status, c: promo.code, ref: promo.ref, k: promo.kind });

  const dbPromo = await chargeRow(promoId);
  check("the promo's ceiling is stored as a ceiling and not as a count: the register counts the places",
    dbPromo.max_uses === 25 && dbPromo.cap === "500000.00"
    && dbPromo.min_amount === "5000.00" && dbPromo.value === "10.0000"
    && dbPromo.container_type === null && dbPromo.route_id === null,
    { mu: dbPromo.max_uses, c: dbPromo.cap, m: dbPromo.min_amount, v: dbPromo.value });

  // `uses` is a sibling of `addendum` on the detail envelope, not a column of the row — the desk reads
  // the places off the same answer that carries the charge, so a check that looked inside the row would
  // be asking a shape that never existed.
  check("the detail answers the places left rather than leaving the desk to subtract them",
    promoEnv.uses?.max_uses === 25 && promoEnv.uses?.taken === 0 && promoEnv.uses?.left === 25
    && promoEnv.uses?.unlimited === false, promoEnv.uses);
  check("…and a standing levy is answered as unlimited in its own word, not as a dash",
    surEnv.uses?.unlimited === true && surEnv.uses?.left === null && surEnv.uses?.taken === 0,
    surEnv.uses);

  r = await openCharge("own", { ...goodSur, label: "Fuel levy, second draft",
    note: "The next version of the office's fuel levy." });
  const surV2 = String(r.json?.addendum?.version ?? 0);
  const surV2Id = String(r.json?.addendum?.id ?? "");
  check("a second draft under one code is the next version, not a clash — the ladder the desk will read",
    r.status === 200 && surV2 === "2" && surV2Id !== surId
    && r.json?.addendum?.kind === "surcharge", { s: r.status, v: surV2 });

  r = await openCharge("own", { kind: "promo", code: SUR_CODE, label: "Fuel as a discount",
    basis: "percent_off", value: "5", max_uses: 10,
    note: "Trying to turn the office's levy into a code." });
  check("a code cannot change what it is: the version ladder keeps the kind with the name, and says which "
    + "row it is talking about",
    r.status === 409 && /This book already files/.test(words(r))
    && words(r).includes(`FUEL_SUR_${STAMP}`)
    && /cannot change what it is/.test(words(r))
    && /existing_kind:surcharge/.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges", asRead);
  check("the board's own chips count the whole book, not the page: three drafts, one levy, one code",
    r.status === 200 && r.json?.total === 3 && r.json?.counts?.draft === 3
    && r.json?.counts?.kind_surcharge === 2 && r.json?.counts?.kind_promo === 1
    && !("published" in (r.json?.counts ?? {})),
    { s: r.status, t: r.json?.total, c: r.json?.counts });
  check("…and a promo is shown with its places while a levy is shown as unlimited, from the same row set",
    r.json?.rows?.find((x: any) => x.kind === "promo")?.unlimited === false
    && r.json?.rows?.find((x: any) => x.kind === "promo")?.uses_left === 25
    && r.json?.rows?.find((x: any) => x.kind === "surcharge")?.unlimited === true,
    r.json?.rows?.map((x: any) => `${x.kind}:${x.uses_left}`));

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.addendum_opened' and ts > to_timestamp($1/1000.0)`, [T0]);
  check("three openings are three audit lines and no more — the door writes its own, the route writes none",
    n.n === 3, n);

  // ---------------- 7. editing a draft ----------------
  phase("changing a draft, and clearing a column");
  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("own"), method: "PATCH", body: {} });
  check("an empty patch is refused: a no-op that audits itself is a register full of edits nobody made",
    r.status === 400 && /which part changes/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("bill"), method: "PATCH", body: {
    cap: "200000", clear: ["cap"] } });
  check("a ceiling is either given a figure or emptied, and the door says so before the register is asked",
    r.status === 400 && /either given a figure or cleared/.test(words(r))
    && /clear/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("bill"), method: "PATCH", body: {
    label: "Fuel surcharge, trailers only" } });
  check("a patch that names one field keeps the rest: the figure, the basis, the corridor and the money "
    + "are what the row already held",
    r.status === 200 && r.json?.addendum?.label === "Fuel surcharge, trailers only"
    && r.json?.addendum?.value === "12.5000" && r.json?.addendum?.basis === "percent_of_freight"
    && r.json?.addendum?.route_id === corridorId && r.json?.addendum?.currency === "TZS",
    { s: r.status, a: r.json?.addendum });

  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("own"), method: "PATCH", body: {
    clear: ["cap"] } });
  check("clearing a column is a write the desk can make without throwing the draft away",
    r.status === 200 && r.json?.addendum?.cap === null, { s: r.status, c: r.json?.addendum?.cap });

  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("own"), method: "PATCH", body: {
    clear: ["max_uses"] } });
  check("clearing a ceiling a surcharge never had is a conflict that reads as the register's own sentence",
    r.status === 409 && /never had a ceiling on places to clear/.test(words(r))
    && /kind:surcharge/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("own"), method: "PATCH", body: {
    value: "140" } });
  check("an edit is measured like an open: 140% of a freight is refused on the way in, either door",
    r.status === 400 && /is not a percentage/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${surId}`, { ck: ck("own"), method: "PATCH", body: {
    kind: "promo" } });
  check("the kind is not a field a desk edits: the shape refuses the key, so no patch can move a levy "
    + "into a discount",
    r.status === 400 && /kind/.test(words(r)), { s: r.status, w: words(r) });

  const dbEdited = await chargeRow(surId);
  check("the edit is on the row and the money column the door refused to edit is untouched",
    dbEdited.label === "Fuel surcharge, trailers only" && dbEdited.cap === null
    && dbEdited.currency === "TZS" && String(dbEdited.updated_by) === uOwn,
    { l: dbEdited.label, c: dbEdited.cap, cur: dbEdited.currency });

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.addendum_edited' and entity_id = $1`, [surId]);
  check("and the two edits that landed are two audit lines, one per accepted write", n.n === 2, n);

  r = await call(`/control/pricing/charges/${surId}/history`, asRead);
  check("a draft has no memory: the charge's own history is written when a signature is spent, not when "
    + "a figure is typed",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });

  r = await call(`/control/pricing/charges/${surId}`, asAn);
  check("the detail prints the corridor's own name and distance beside the figure, as 140's does",
    r.status === 200 && r.json?.addendum?.route === CORRIDOR
    && Number(r.json?.addendum?.distance_km) === 813
    && /^[0-9a-f]{64}$/.test(String(r.json?.paper_sha256)),
    { s: r.status, r: r.json?.addendum?.route, d: r.json?.addendum?.distance_km });
  check("…and the version ladder is the code's whole life: two drafts of FUEL_SUR, newest first",
    r.json?.versions?.length === 2 && r.json?.versions?.[0]?.version === 2,
    r.json?.versions?.map((v: any) => `${v.version}:${v.status}`));

  // ---------------- 8. the paper, and the second seat's no ----------------
  phase("a charge put up for a signature, and answered with a no");
  r = await call(`/control/pricing/charges/${promoId}/publish`, { ck: ck("read"), method: "POST",
    body: { reason: "A reader trying to raise a paper." } });
  check("raising a paper is the publish duty, not the pen", r.status === 403,
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Twenty-five places, ten per cent off, held to 500 000. Put it in force." } });
  const approvalId = String(r.json?.approval_id ?? "");
  check("the draft is put up as its own effect name, and the paper is the charge's, not a price list's",
    r.status === 200 && r.json?.action === "pricing.addendum"
    && r.json?.target_kind === "pricing_addendum" && String(r.json?.target_id) === promoId
    && /^[0-9a-f]{64}$/.test(String(r.json?.payload_sha256)),
    { s: r.status, a: r.json?.action, t: r.json?.target_kind, sha: r.json?.payload_sha256 });

  const paper = await row("platform_approvals", approvalId);
  check("the register holds the paper: pending, in 121's book, raised by the seat that typed the reason",
    paper.action === "pricing.addendum" && paper.status === "pending"
    && String(paper.target_id) === promoId && String(paper.proposed_by) === uBill
    && String(paper.payload_sha256) === String(r.json?.payload_sha256),
    { a: paper.action, s: paper.status, p: paper.proposed_by });

  // `propose` answers with the detail door's whole envelope hung on `addendum`, so the charge is the
  // envelope's own `addendum` — one level deeper than the read doors put it. The desk normalises this
  // (`detailOf`); a check that reads it flat would fail against a door that answered perfectly.
  check("the door hands back the charge it just put on hold, so the desk does not have to read twice",
    r.json?.addendum?.addendum?.status === "pending_signature" && r.json?.addendum?.addendum?.refusals === 0
    && String(r.json?.addendum?.addendum?.approval_id) === approvalId, r.json?.addendum?.addendum);

  const dbOut = await chargeRow(promoId);
  check("and the row is held: pending_signature with the paper pointed at it and no figure moved",
    dbOut.status === "pending_signature" && String(dbOut.approval_id) === approvalId
    && dbOut.value === "10.0000" && dbOut.max_uses === 25 && dbOut.published_at === null,
    { s: dbOut.status, a: dbOut.approval_id });

  r = await call(`/control/pricing/charges/${promoId}`, asRead);
  check("the detail prints the paper — who raised it, what they asked for, and when it lapses",
    r.status === 200 && r.json?.approval?.status === "pending"
    && /Twenty-five places/.test(String(r.json?.approval?.reason))
    && r.json?.approval?.proposed_by === "Baraka Bill"
    && /^[0-9a-f]{64}$/.test(String(r.json?.approval?.payload_sha256)),
    { s: r.status, ap: r.json?.approval });
  check("…and the hash the desk can prove the figure against is the hash the paper was raised on",
    r.json?.paper_sha256 === r.json?.approval?.payload_sha256,
    { paper: r.json?.paper_sha256, row: r.json?.approval?.payload_sha256 });

  r = await call(`/control/pricing/charges/${promoId}`, { ck: ck("own"), method: "PATCH", body: {
    value: "20" } });
  check("a figure the office is being asked to sign cannot change underneath them: the edit is a conflict "
    + "that says which paper to refuse",
    r.status === 409 && /waiting for a second seat/.test(words(r))
    && /Refuse the paper first/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "Throwing away a charge that is on hold for a signature." } });
  check("a charge on hold is not a discardable draft either — the paper is the reason it is kept",
    r.status === 409 && /is pending_signature and a signature stood on it/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Asking a second seat to sign a paper that is already out." } });
  check("a paper already waiting is a conflict naming the charge, not a second paper beside it",
    r.status === 409 && /is already waiting for a second seat/.test(words(r))
    && /approval_id/.test(JSON.stringify(r.json?.error?.details ?? "")), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/refuse`, { ck: ck("bill"), method: "POST",
    body: { note: "The per-centre figure is a week off the market." } });
  check("the seat that raised a paper cannot be the seat that answers it: 121's own check, arriving "
    + "through 141's door",
    r.status === 409 && /The signature was not answered/.test(words(r))
    && /cannot be the one that signs it/.test(words(r)), { s: r.status, w: words(r) });

  const stillOut = await chargeRow(promoId);
  check("and a refusal that was refused leaves the charge exactly where it was — held, and unsigned",
    stillOut.status === "pending_signature" && String(stillOut.approval_id) === approvalId
    && stillOut.refusals === 0, { s: stillOut.status, r: stillOut.refusals });

  r = await call(`/control/pricing/charges/${promoId}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "The ceiling is a week off the market. Take it back and re-cut it." } });
  check("a second seat answers the paper with a no, and the freed draft is handed back in the same call",
    r.status === 200 && r.json?.addendum?.addendum?.status === "draft"
    && Number(r.json?.refusals) === 1 && String(r.json?.approval_id) === approvalId,
    { s: r.status, st: r.json?.addendum?.addendum?.status, ref: r.json?.refusals });

  const dbRefused = await chargeRow(promoId);
  const paper2 = await row("platform_approvals", approvalId);
  check("the row is a draft again and the paper is rejected on the register, decided by the seat that said no",
    dbRefused.status === "draft" && dbRefused.refusals === 1 && String(dbRefused.approval_id) === approvalId
    && paper2.status === "rejected" && String(paper2.decided_by) === uOwn,
    { s: dbRefused.status, ap: dbRefused.approval_id, ps: paper2.status, by: paper2.decided_by });

  r = await call(`/control/pricing/charges/${promoId}`, asRead);
  check("the words the second seat typed come back out of the read — a clerk is told why, not just that",
    r.status === 200 && r.json?.approval?.status === "rejected"
    && /a week off the market/.test(String(r.json?.approval?.decided_note))
    && r.json?.approval?.decided_by === "Rashid Owner"
    && !!r.json?.approval?.decided_at, { s: r.status, ap: r.json?.approval });
  check("…and the freed draft is editable again in the same read: the status is a draft with one refusal "
    + "on it",
    r.json?.addendum?.status === "draft" && r.json?.addendum?.refusals === 1
    && r.json?.addendum?.published_at === null, r.json?.addendum);

  r = await call(`/control/pricing/charges/${promoId}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "Refusing a paper that was already answered." } });
  check("refusing twice is not a thing a register can record",
    r.status === 409 && /No signature is standing/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "Throwing away the draft the office was asked to sign." } });
  check("a charge a signature ever stood on is kept, even back in draft and even by its own book's owner",
    r.status === 409 && /A paper that anyone was asked to sign is kept/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/clone`, { ck: ck("own"), method: "POST",
    body: { note: "Cloning a version that was never a price." } });
  check("a draft is cloned forward only from a version that was signed",
    r.status === 409 && /is still a draft\. Clone a version that has been published/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${surId}/withdraw`, { ck: ck("own"), method: "POST",
    body: { effective_to: TODAY, reason: "Stopping a levy that was never put in force." } });
  check("a charge that never lived cannot be stopped: the refusal names the status the door read, so "
    + "`not_live` is a sentence about `draft` and not a bare code word",
    r.status === 409 && /is draft\. There is nothing to stop\./.test(words(r))
    && words(r).includes(`${sur.ref} is draft`) && !/141:/.test(words(r)),
    { s: r.status, w: words(r) });

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.addendum_publish_proposed' and entity_id = $1`, [promoId]);
  const nRefused = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.addendum_publish_refused' and entity_id = $1`, [promoId]);
  check("one paper raised and one paper answered are one audit line each, and the refusal names the seat "
    + "that asked and the seat that answered",
    n.n === 1 && nRefused.n === 1, { proposed: n.n, refused: nRefused.n });

  const refusedAudit = await one(`select after ->> 'note' as note, after ->> 'refusals' as refusals,
      after ->> 'seat' as seat, after ->> 'proposed_by' as proposed_by,
      before ->> 'paper_sha256' is not null as on_the_paper
    from audit_logs where action = 'pricing.addendum_publish_refused'
      and entity = 'pricing_addenda' and entity_id = $1 limit 1`, [promoId]);
  check("…and the refusal's own audit line keeps the sentence the second seat typed, the count it left "
    + "and both seats by name, beside the bytes the paper was cut on",
    /a week off the market/.test(String(refusedAudit.note)) && refusedAudit.refusals === "1"
    && refusedAudit.seat === "Rashid Owner" && refusedAudit.proposed_by === "Baraka Bill"
    && refusedAudit.on_the_paper === true, refusedAudit);

  // ---------------- 9. the places, as a draft can only be refused ----------------
  phase("a place on a code that was never put in force");
  r = await call(`/control/pricing/charges/${promoId}/claims`, { ck: ck("own"), method: "POST",
    body: { subject_kind: "customer", subject_id: randomUUID(), job_ref: `JOB-${STAMP}`,
      freight: "1200000", taken: "120000", note: "The first place on the new-year code." } });
  check("a clerk cannot hand out a place on a code the office has not signed: the door refuses on the "
    + "status it read",
    r.status === 409 && /A place is only taken on a promo that is in force/.test(words(r))
    && /is draft/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${surId}/claims`, { ck: ck("bill"), method: "POST",
    body: { subject_kind: "vehicle", subject_id: randomUUID() } });
  check("…and the same refusal on a levy, in the register's words, with the levy's own status named",
    r.status === 409 && /is only taken on a surcharge that is in force/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/claims`, { ck: ck("bill"), method: "POST",
    body: { subject_kind: "customer", subject_id: "12345" } });
  check("a subject that is not a row any register can name is the route's refusal, not a null in a table",
    r.status === 400 && /subject_id/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/charges/${promoId}/claims`, { ck: ck("bill"), method: "POST",
    body: { subject_kind: "passenger", subject_id: randomUUID() } });
  check("a subject kind the register has never taken a place for is refused with the five it knows",
    r.status === 400 && /subject_kind/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/claims/${randomUUID()}/void`, { ck: ck("bill"), method: "POST",
    body: { reason: "Giving back a place this book never recorded." } });
  check("voiding a place that was not taken in this book is a 404 that says so, not a silent no-op",
    r.status === 404 && /No place was taken in this book under that number/.test(words(r)),
    { s: r.status, w: words(r) });

  n = await one(`select count(*)::int as n from pricing_addendum_claims`);
  check("and no place was taken anywhere in the register: every claim this run attempted was refused",
    n.n === Number(START.places), n);

  r = await call(`/control/pricing/charges/${promoId}/history?limit=5&offset=0`, asAud);
  check("the places read is empty on a draft code, and the door answers a page rather than an error",
    r.status === 200 && r.json?.total === 0 && Array.isArray(r.json?.rows),
    { s: r.status, t: r.json?.total });

  // ---------------- 10. two books are two worlds ----------------
  phase("another office book cannot see this one's charges");
  r = await call("/control/pricing/charges", asEst);
  check("the other book's board is its own and empty",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });
  r = await call(`/control/pricing/charges/${promoId}`, asEst);
  check("its seat reading this book's charge number is answered 404, not with the charge",
    r.status === 404, { s: r.status, w: words(r) });
  r = await call(`/control/pricing/charges/${promoId}/history`, asEst);
  // The memory door is a page reader: it binds `h.tenant_id` to the asking book and answers an empty
  // page for a charge that book does not hold, so it cannot say "no such charge" the way the detail door
  // does. What has to be true is that nothing of the other book's memory is on the page.
  check("…and its seat asking what that charge did gets an empty page: no line, no count, and nothing "
    + "said about the charge it cannot see",
    r.status === 200 && Array.isArray(r.json?.rows) && r.json.rows.length === 0
    && r.json?.total === 0 && !new RegExp(`NEWYEAR_${STAMP}`).test(JSON.stringify(r.json ?? {})),
    { s: r.status, total: r.json?.total, rows: Array.isArray(r.json?.rows) ? r.json.rows.length : null });

  for (const [what, method, body] of [
    ["PATCH", "PATCH", { value: "90" }],
    ["publish", "POST", { reason: "A seat in another book asking for a signature." }],
    ["refuse", "POST", { note: "A seat in another book answering a paper." }],
    ["discard", "POST", { reason: "A seat in another book throwing a draft away." }],
    ["clone", "POST", { note: "A seat in another book cloning forward." }],
    ["withdraw", "POST", { effective_to: TODAY, reason: "A seat in another book stopping a levy." }],
    ["claims", "POST", { subject_kind: "customer", subject_id: randomUUID() }]
  ] as [string, string, any][]) {
    r = await call(`/control/pricing/charges/${promoId}${what === "PATCH" ? "" : `/${what}`}`,
      { ck: ck("est"), method, body });
    check(`its seat cannot ${what === "PATCH" ? "edit" : `reach ${what} on`} this book's charge — 404, `
      + "not a permission error that leaks that the row exists",
      r.status === 404, { s: r.status, w: words(r) });
  }

  r = await openCharge("est", { kind: "surcharge", code: `their levy ${STAMP}`, label: "Their own levy",
    basis: "flat", value: "40000", route: corridorId,
    note: "A charge in the other book laid on this book's road." });
  check("a charge cannot be laid on a road the book does not have, whichever seat types it",
    r.status === 409 && /is not a corridor of the book that owns/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges?search=kigoma", asEst);
  check("and a search cannot reach across either: this book's charge is not in that book's answer",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });

  // ---------------- 11. what the reads write, and what a write leaves ----------------
  phase("the register records decisions, not glances");
  const AUDITS = `select count(*)::int as n from audit_logs
    where action like 'pricing.addendum%' and ts > to_timestamp($1/1000.0)`;
  const before = await one(AUDITS, [T0]);
  for (const p of ["/control/pricing/charges", "/control/pricing/charges?kind=promo",
    "/control/pricing/charges/in-force?kind=surcharge", `/control/pricing/charges/${surId}`,
    `/control/pricing/charges/${promoId}/history`, "/control/pricing/job?teu=2"]) {
    await call(p, asRead);
  }
  const after = await one(AUDITS, [T0]);
  check("six reads write no audit line: the register records decisions, not glances",
    before.n === after.n, { before: before.n, after: after.n });

  const census = await one(`select
      (select count(*) from audit_logs where action = 'pricing.addendum_opened'
        and ts > to_timestamp($1/1000.0)) as opened,
      (select count(*) from audit_logs where action = 'pricing.addendum_edited'
        and ts > to_timestamp($1/1000.0)) as edited,
      (select count(*) from audit_logs where action = 'pricing.addendum_publish_proposed'
        and ts > to_timestamp($1/1000.0)) as proposed,
      (select count(*) from audit_logs where action = 'pricing.addendum_publish_refused'
        and ts > to_timestamp($1/1000.0)) as refused,
      (select count(*) from audit_logs where action in ('pricing.addendum_published',
        'pricing.addendum_withdrawn', 'pricing.addendum_discarded', 'pricing.addendum_cloned',
        'pricing.addendum_claimed', 'pricing.addendum_claim_voided') and ts > to_timestamp($1/1000.0))
        as unreachable`, [T0]);
  check("every accepted write this run made left exactly one line, and none of them doubled",
    Number(census.opened) === 3 && Number(census.edited) === 2 && Number(census.proposed) === 1
    && Number(census.refused) === 1, census);
  check("…and no line of the six this run is not allowed to cause was written: nothing was published, "
    + "stopped, thrown away, cloned, claimed or voided",
    Number(census.unreachable) === 0, census);

  const mem = await one(`select count(*)::int as n from pricing_addendum_history`);
  check("the memory table is exactly as this run found it: a draft's edits are audited, not remembered, "
    + "because the memory is what a signed figure used to be",
    mem.n === Number(START.memory), mem);

  // ---------------- 12. throwing a draft that was never signed away ----------------
  phase("a draft nobody was asked to sign is discardable");
  r = await call(`/control/pricing/charges/${surV2Id}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "A draft opened twice by mistake and never signed." } });
  check("the second draft is thrown away, and the answer says what it cost nobody",
    r.status === 200 && String(r.json?.discarded ?? "").startsWith("SUR-")
    && /Nothing was charged and nothing was signed/.test(String(r.json?.message)),
    { s: r.status, j: r.json });

  const gone = await one(`select count(*)::int as n from pricing_addenda where id = $1`, [surV2Id]);
  check("the row is really gone — a discard of an unsigned draft is a delete, not a status",
    gone.n === 0, gone);

  r = await call(`/control/pricing/charges/${surV2Id}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "Throwing the same draft away a second time." } });
  check("and discarding it twice is a 404 that reads as a missing charge, not a broken desk",
    r.status === 404 && /no charge with that number/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/charges", asRead);
  check("the board is back to two drafts, and the counts moved with the row rather than being recounted",
    r.status === 200 && r.json?.total === 2 && r.json?.counts?.draft === 2
    && r.json?.counts?.kind_surcharge === 1 && r.json?.counts?.kind_promo === 1,
    { t: r.json?.total, c: r.json?.counts });

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.addendum_discarded' and entity_id = $1`, [surV2Id]);
  check("one discard is one audit line, and it is the only thing that will remember the charge existed",
    n.n === 1, n);

  // ---------------- teardown ----------------
  phase("teardown");
  await sweep();
  const END = await one(`select
      (select count(*) from pricing_addenda) as charges,
      (select count(*) from pricing_addendum_claims) as places,
      (select count(*) from pricing_addendum_history) as memory,
      (select count(*) from routes where name like 'PR Addendum %') as corridors`);
  check("the charge register is left exactly as this run found it",
    END.charges === START.charges && END.places === START.places && END.memory === START.memory
    && END.corridors === START.corridors, { start: START, end: END });

  const left = await one(`select (select count(*) from tenants where name like $1) as books,
      (select count(*) from users where email like $2) as seats,
      (select count(*) from platform_approvals a where a.action = 'pricing.addendum') as papers,
      (select count(*) from pricing_addendum_claims) as places,
      (select count(*) from pricing_addenda a where a.approval_id is not null
         or a.status <> 'draft') as held,
      (select count(*) from rate_limits where bucket ~ '^(charge|pricing)') as buckets`,
    [BOOK_SWEEP, EMAIL_SWEEP]);
  check("both fixture books, every fixture seat, both corridors and every charge are gone, and no paper, "
    + "place or half-draft of this run's is left anywhere in the register",
    Number(left.books) === 0 && Number(left.seats) === 0 && Number(left.papers) === 0
    && Number(left.places) === 0 && Number(left.held) === 0 && Number(left.buckets) === 0, left);

  // Not a census of `reason`: the paper this run raised was answered by 141's own refuse door, which
  // rewrites the row it owns. What the sweep must provably leave behind is nothing pointing at a gone
  // charge, in either register.
  const orphans = await one(`select
      (select count(*) from platform_approvals a where a.action = 'pricing.addendum'
         and not exists (select 1 from pricing_addenda c where c.id::text = a.target_id)) as papers,
      (select count(*) from pricing_addenda a where a.approval_id is not null
         and not exists (select 1 from platform_approvals p where p.id = a.approval_id)) as pointing`);
  check("no paper points at a charge this run deleted and no charge points at a paper that is gone",
    Number(orphans.papers) === 0 && Number(orphans.pointing) === 0, orphans);

  await owner.end();
  console.log(`\n${failures ? `SMOKE FAILED (${failures})` : "SMOKE CLEAN"} in `
    + `${((Date.now() - T0) / 1000).toFixed(1)}s`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("probe died:", e);
  process.exitCode = 1;
});
