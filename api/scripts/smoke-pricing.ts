/**
 * The price that carries its own dates, over HTTP — smoke for #417 (migration 140 and
 * `control-pricing.routes.ts`).
 *
 * `tmp-140-run.ts` drove the register's whole lifecycle inside one transaction: it opened a list, put
 * figures on it, asked for a signature, spent it and read the price back. That proves the doors. It
 * cannot prove the five things this stage added on top of them:
 *
 *  - that 140's three duties are really three at the desk — the analyst who reads every price cannot
 *    open a draft, the billing admin who types figures is not thereby allowed to ask anyone to sign
 *    them, and a seat with no pricing duty at all is refused before a door is reached;
 *  - that a route guard's sentence and a door's sentence stay distinguishable: five decimals is the
 *    route's `field` annotation, `bad_basis` naming the seven bases is the register's own words with
 *    nothing rewritten and no `140:` on the front;
 *  - that a door's refusal reaches the desk as the status the route chose for it — `no_price` as 404
 *    because nothing is set, `no_distance`-family refusals as 400 because the caller left a half out,
 *    `paper_is_out` and `corridor_taken` as 409 because the row the desk is staring at is the obstacle;
 *  - that every accepted write is audited exactly once, by the door that made it, and that a read
 *    writes nothing — a route that audited on top of 140's `money_audit` would double the register;
 *  - that two office books are two worlds: another platform tenant's corridors, lists and lines are
 *    not in this book's board, detail, rate or quote, and are not deletable from it either.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO.
 *
 *  1. It never spends a signature. `apply_pricing_publish` is not a route — it is 121's effect, run by
 *     the Approvals register and proved in the lifecycle probe. And it could not be spent here even
 *     through Approvals' own doors: a published card is kept (`pricing_cards_are_kept`), the memory
 *     rows publish writes are kept (`pricing_history_is_kept` raises on DELETE for every role), and
 *     `pricing_price_history.card_id` has no cascade — so one accepted publication would make this
 *     run's fixture book permanently undeletable and break the teardown of every smoke that sweeps by
 *     name after it. Same rule the recon smoke runs under.
 *  2. So the resolver and the simulator are met as refusals only. Every published card this book could
 *     answer with is one this run is not allowed to make, so `GET /rate` and `GET /quote` are graded on
 *     their plumbing: the day, the list code, the corridor and the basis all arrive in the right slot
 *     and come back named in the door's own sentence. The arithmetic of a live price is the probe's.
 *
 * SAFETY: both books are this run's own synthetic platform tenants, found by name prefix; the corridors
 * are found by their `PR Smoke` name. Cards whose paper was refused are un-pointed and removed by hand
 * at the end — the register keeps them on purpose, and a fixture book must not. Audit lines and the
 * sequences they spent stay behind: `prevent_audit_mutation()` refuses the owner too. No real company
 * and no real price list is touched.
 *
 * Run: npx tsx scripts/smoke-pricing.ts   (API on :4000, or SMOKE_API_BASE=http://localhost:4100/api/v1)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

// The api holds :4000 in the house arrangement, but another project on this box has taken it before, and
// a run that cannot reach the desk reads as forty 401s rather than as a port that is not there.
const API = process.env.SMOKE_API_BASE ?? "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `pr${STAMP}`;
const BOOK_SWEEP = "PR Smoke %";
const EMAIL_SWEEP = `smoke.pr.%@waisha.test`;
const CORRIDOR_SWEEP = "PR Smoke %";

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
/** A door lands its sentence in `error.message` and its figures beside it in `error.details`; a zod
 *  refusal lands its sentence one level down, field-annotated. Joined, so a check on "the door's own
 *  words" cannot pass on a guard's paraphrase, and a check on a guard's field cannot pass on a door. */
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

  // The schema's own totals, before anything is written: the run ends on the same numbers.
  const START = await one(`select
      (select count(*) from pricing_rate_cards) as cards,
      (select count(*) from pricing_rate_lines) as lines,
      (select count(*) from pricing_price_history) as memory,
      (select count(*) from routes where name like 'PR Smoke %') as corridors`);
  note(`register found: ${START.cards} cards, ${START.lines} lines, ${START.memory} memory rows, `
    + `${START.corridors} smoke corridors already filed`);

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = ["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor",
    "director"].filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);

  // 140's grants are the claim being graded. If a grant never landed, every 403 below would pass for
  // the wrong reason, so the run checks its own ground first.
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
    throw new Error(`140's pricing duties are not on the roles this run grades — ${JSON.stringify(grants)}`);
  }

  // ---------------- fixtures ----------------
  const TP = randomUUID();   // the book this run signs in at
  const TX = randomUUID();   // a second book, to be kept out of
  const uOwn = randomUUID(); // super_admin: all three duties
  const uBill = randomUUID(); // billing_admin: all three too
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
      // The register's own order, backwards: a card that ever carried a paper is kept and its lines are
      // frozen while it is not a draft, so the paper comes off and the card goes back to being a draft
      // before either row can be touched. A card that was actually published is not swept — the trigger
      // raises, and it should: this run never publishes, so one would mean the lifecycle leaked into HTTP.
      await oi(`update pricing_rate_cards set approval_id = null, status = 'draft'
                  where tenant_id = any($1::uuid[]) and published_at is null
                    and (approval_id is not null or status <> 'draft')`, [all]);
      await oi(`delete from pricing_rate_lines where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from pricing_rate_cards where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from platform_approvals where action = 'pricing.publish'
                 and proposed_by = any($1::uuid[])`, [uids.length ? uids : [randomUUID()]]);
      await oi(`delete from routes where tenant_id = any($1::uuid[])`, [all]);
      if (uids.length) {
        await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
        await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
      }
      await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    }
    await oi(`delete from rate_limits where bucket like 'pricing%'`);
  };

  const T0 = Date.now();
  await sweep();

  await oi(`insert into tenants (id, type, name, status, trial_ends_at) values
      ($1,'platform',$2,'active', now() + interval '30 days'),
      ($3,'platform',$4,'active', now() + interval '30 days')`,
    [TP, `PR Smoke Book ${STAMP}`, TX, `PR Smoke Other ${STAMP}`]);

  const seat = (id: string, tenant: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
          now() - interval '200 days')`,
      [id, tenant, name, `smoke.pr.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
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
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-pricing',$6,
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
  const asDir = { ck: ck("dir") };
  const asEst = { ck: ck("est") };

  // ---------------- 1. the door is shut ----------------
  phase("the three duties are three at the desk");
  let r = await call("/control/pricing/board");
  check("a board read with no session is 401, not an empty board",
    r.status === 401, { s: r.status, w: words(r) });

  r = await call("/control/pricing/board", asDir);
  check("a seat that holds no pricing duty is refused the read",
    r.status === 403 && code(r) === "FORBIDDEN", { s: r.status, w: words(r) });

  for (const [who, path, method] of [
    ["read", "/control/pricing/cards", "POST"],
    ["read", "/control/pricing/corridors", "POST"],
    ["read", "/control/pricing/lines/" + randomUUID(), "DELETE"],
    ["an", "/control/pricing/cards", "POST"]
  ] as [string, string, string][]) {
    r = await call(path, { ck: ck(who), method, body: {} });
    check(`a reader (${who}) is refused the write ${method} ${path.split("/pricing/")[1]}`,
      r.status === 403, { s: r.status, w: words(r) });
  }

  for (const who of ["read", "aud", "an"]) {
    r = await call(`/control/pricing/cards/${randomUUID()}/publish`, { ck: ck(who),
      method: "POST", body: { reason: "A reader asking for a signature." } });
    check(`${who} holds the read and not the pen: publishing is a third duty`,
      r.status === 403, { s: r.status, w: words(r) });
  }

  // The navigation probe has to name the duties or a held duty is an invisible tab (067's lesson):
  // `permissions` is the list of keys the seat holds, and a key nobody probes is a tab nobody sees.
  r = await call("/control/auth/permissions", asRead);
  const held: string[] = r.json?.permissions ?? [];
  check("the navigation is told a reader may open the pricing desk and not write it",
    r.status === 200 && held.includes("control.pricing.view")
    && !held.includes("control.pricing.manage") && !held.includes("control.pricing.publish"),
    { s: r.status, p: held.filter((k) => k.startsWith("control.pricing")) });
  r = await call("/control/auth/permissions", asBill);
  const heldBill: string[] = r.json?.permissions ?? [];
  check("…and the billing admin is offered all three, because the desk shows the pen too",
    heldBill.includes("control.pricing.view") && heldBill.includes("control.pricing.manage")
    && heldBill.includes("control.pricing.publish"),
    { s: r.status, p: heldBill.filter((k) => k.startsWith("control.pricing")) });

  // ---------------- 2. the vocabulary and an empty book ----------------
  phase("the words a price may be keyed on");
  r = await call("/control/pricing/dimensions", asAn);
  const dims = r.json?.rows ?? [];
  const byKind = (k: string) => dims.filter((d: any) => d.kind === k);
  check("the desk is given the register's vocabulary rather than a copy of it",
    r.status === 200 && byKind("vehicle_class").length === 10
    && byKind("container").length === 4 && byKind("basis").length === 7,
    { s: r.status, n: dims.length });
  check("a container whose key starts with a digit is a key the desk can use",
    byKind("container").some((d: any) => d.key === "20ft")
    && byKind("container").some((d: any) => d.key === "40ft"),
    byKind("container").map((d: any) => d.key));
  check("each basis carries the noun it multiplies by, so the form knows what to ask for",
    byKind("basis").find((d: any) => d.key === "per_km")?.needs === "distance_km"
    && byKind("basis").find((d: any) => d.key === "per_teu")?.needs === "teu"
    && byKind("basis").find((d: any) => d.key === "flat")?.needs === "none",
    byKind("basis").map((d: any) => `${d.key}:${d.needs}`));

  r = await call("/control/pricing/board", asRead);
  check("an office book with no price lists answers a board, not an error",
    r.status === 200 && r.json?.total === 0 && Array.isArray(r.json?.rows),
    { s: r.status, t: r.json?.total });

  r = await call("/control/pricing/corridors", asRead);
  check("and no corridors either, until this desk files one",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });

  // ---------------- 3. filing a corridor ----------------
  phase("the corridors this book can price");
  const CORRIDOR = `PR Smoke Dar–Kigoma ${STAMP}`;
  r = await call("/control/pricing/corridors", { ck: ck("own"), method: "POST", body: {
    name: CORRIDOR, origin: "Dar es Salaam", dest: "Kigoma", distance_km: "9000" } });
  check("a road longer than the country is the door's refusal, in the door's words",
    r.status === 400 && /keystroke, not a road/.test(words(r)) && /asked:9000/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call("/control/pricing/corridors", { ck: ck("own"), method: "POST", body: {
    name: "Wv", origin: "Dar es Salaam", dest: "Kigoma" } });
  check("a two-character corridor name never reaches the register",
    r.status === 400 && /name/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/corridors", { ck: ck("bill"), method: "POST", body: {
    name: CORRIDOR, origin: "Dar es Salaam", dest: "Kigoma", distance_km: "812.6" } });
  const corridor = r.json?.corridor ?? {};
  const corridorId = String(corridor.id ?? "");
  check("filing a corridor rounds its distance to whole kilometres and says the number",
    r.status === 200 && corridor.distance_km === 813 && /at 813 km\./.test(String(r.json?.message)),
    { s: r.status, d: corridor.distance_km, m: r.json?.message });

  const filed = await row("routes", corridorId);
  check("the corridor is a live route of this book, filed by the seat that typed it",
    filed.tenant_id === TP && filed.is_active === true && Number(filed.distance_km) === 813
    && filed.created_by && String(filed.created_by) !== "" && filed.deleted_at === null,
    { t: filed.tenant_id, a: filed.is_active, d: filed.distance_km });

  let n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.corridor_filed' and entity = 'routes' and entity_id = $1`, [corridorId]);
  check("one filing is one audit line — the door writes it, the route does not",
    n.n === 1, n);

  r = await call("/control/pricing/corridors", { ck: ck("bill"), method: "POST", body: {
    name: ` ${CORRIDOR.toLowerCase()} `, origin: "Dar es Salaam", dest: "Kigoma" } });
  check("a corridor filed twice under one name is a conflict, not a second road",
    r.status === 409 && /one name/.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/corridors", { ck: ck("own"), method: "POST", body: {
    name: `PR Smoke blind leg ${STAMP}`, origin: "Mwanza", dest: "Tunduma" } });
  check("a corridor nobody has measured is still worth filing, and is marked as one",
    r.status === 200 && r.json?.corridor?.has_distance === false
    && /with no distance/.test(String(r.json?.message)),
    { s: r.status, m: r.json?.message, err: r.json?.error?.message });

  r = await call("/control/pricing/corridors?limit=10", asRead);
  check("the picker shows both facts the pricing form needs about each corridor",
    r.status === 200 && r.json?.total === 2
    && r.json.rows.every((c: any) => "has_distance" in c && "priced_on" in c),
    { s: r.status, t: r.json?.total });

  // ---------------- 4. opening a list ----------------
  phase("a price list that carries its own dates");
  const CODE1 = `pr smoke ${STAMP}`;   // typed the way a clerk says it
  r = await call("/control/pricing/cards", { ck: ck("read"), method: "POST", body: {
    code: CODE1, label: "Standard corridor price", note: "The office's own price for the season." } });
  check("a reader cannot open a draft", r.status === 403, { s: r.status, w: words(r) });

  r = await call("/control/pricing/cards", { ck: ck("own"), method: "POST", body: {
    code: CODE1, label: "Standard corridor price", note: "short" } });
  check("a note under eight characters is refused with the field named",
    r.status === 400 && /note/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call("/control/pricing/cards", { ck: ck("bill"), method: "POST", body: {
    code: CODE1, label: "Standard corridor price", currency: "TZS",
    effective_from: "2026-02-30", note: "The office's own price for the season." } });
  check("there is no such day on a calendar, and the desk is told so before the register is asked",
    r.status === 400 && /calendar/.test(words(r)), { s: r.status, w: words(r) });

  const TODAY = new Date().toISOString().slice(0, 10);
  r = await call("/control/pricing/cards", { ck: ck("bill"), method: "POST", body: {
    code: CODE1, label: "Standard corridor price", currency: "TZS",
    effective_from: TODAY, note: "The office's own price for the season." } });
  const cardA = r.json?.card ?? {};
  const cardAId = String(cardA.id ?? "");
  check("the code is filed the way the register spells it, and the version is minted off it",
    r.status === 200 && cardA.code === `PR_SMOKE_${STAMP}` && cardA.version === 1
    && /^PRC-\d{4}-\d{5,}$/.test(String(cardA.ref)) && cardA.status === "draft",
    { s: r.status, c: cardA.code, v: cardA.version, ref: cardA.ref, st: cardA.status });

  const dbA = await row("pricing_rate_cards", cardAId);
  // `pg` hands a bare `date` back as a Date at local midnight, and this box runs at UTC+3, so
  // `.toISOString()` would print the day before the one the card carries. Read it the way the papers do.
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    + `-${String(d.getDate()).padStart(2, "0")}`;
  check("the draft is in the book with its own effective date and no paper on it",
    dbA.tenant_id === TP && dbA.status === "draft" && ymd(dbA.effective_from) === TODAY
    && dbA.approval_id === null && dbA.published_at === null && Number(dbA.refusals) === 0,
    { st: dbA.status, ef: dbA.effective_from, ap: dbA.approval_id });

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.card_opened' and entity_id = $1`, [cardAId]);
  check("opening a list is audited once, by the door that opened it", n.n === 1, n);

  r = await call("/control/pricing/cards", { ck: ck("own"), method: "POST", body: {
    code: CODE1, label: "Second draft of the same list", currency: "TZS",
    effective_from: TODAY, note: "The next version of the office's corridor price." } });
  check("a second draft under one code is the next version, not a clash",
    r.status === 200 && r.json?.card?.version === 2 && r.json?.card?.id !== cardAId,
    { s: r.status, v: r.json?.card?.version, m: r.json?.message });
  const cardBId = String(r.json?.card?.id ?? "");

  r = await call(`/control/pricing/cards/${cardAId}`, { ck: ck("own"), method: "PATCH", body: {} });
  check("an empty patch is refused: a no-op that audits itself is a register full of edits nobody made",
    r.status === 400 && /which part changes/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}`, { ck: ck("bill"), method: "PATCH", body: {
    note: "Reworded on the desk before any figure was typed." } });
  check("a patch that names one field keeps the rest, exactly as the door promises",
    r.status === 200 && r.json?.card?.label === "Standard corridor price"
    && /Reworded/.test(String(r.json?.card?.note)),
    { s: r.status, l: r.json?.card?.label, note: r.json?.card?.note });

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.card_edited' and entity_id = $1`, [cardAId]);
  check("and that edit is its own audit line", n.n === 1, n);

  // ---------------- 5. figures on a scope ----------------
  phase("putting a figure on one scope");
  const lineBody = { route: corridorId, vehicle_class: "trailer", container: "20ft",
    basis: "per_teu", rate: "125000", min_charge: "90000" };
  r = await call(`/control/pricing/cards/${cardAId}/lines`, { ck: ck("own"), method: "PUT",
    body: { ...lineBody, rate: "1.23456" } });
  check("five decimals never reach the register: a rate is numeric(14,4) and the route says so",
    r.status === 400 && /four decimals/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/lines`, { ck: ck("own"), method: "PUT",
    body: { ...lineBody, basis: "per_litre" } });
  check("a basis the register does not price on is refused with the list it does know",
    r.status === 400 && /per_km/.test(words(r)) && /per_cbm/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/lines`, { ck: ck("own"), method: "PUT",
    body: { ...lineBody, route: randomUUID() } });
  check("a corridor from another book is refused before a figure is stored against it",
    r.status === 400 && /not a corridor of this book/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardBId}/lines`, { ck: ck("est"), method: "PUT", body: lineBody });
  check("the other book's seat cannot put a price on this book's draft",
    r.status === 404, { s: r.status, w: words(r) });

  // Every draft door answers with the whole card (`pricing_card_detail`), not with the row it touched —
  // so a desk that wrote one figure is handed the list it is editing, lines and all. The line a call
  // produced is read back out of that page, not out of a `line` key that does not exist.
  r = await call(`/control/pricing/cards/${cardAId}/lines`, { ck: ck("bill"), method: "PUT", body: lineBody });
  const lineId = String(r.json?.lines?.[0]?.id ?? "");
  check("a container key that starts with a digit is a price the desk can type",
    r.status === 200 && r.json?.lines?.length === 1
    && r.json?.lines?.[0]?.container_type === "20ft"
    && r.json?.lines?.[0]?.rate === "125000.0000", { s: r.status, l: r.json?.lines });

  const dbL = await row("pricing_rate_lines", lineId);
  check("the line is keyed on its scope, in this book, beside this card",
    dbL.card_id === cardAId && dbL.tenant_id === TP && dbL.basis === "per_teu"
    && dbL.container_type === "20ft" && String(dbL.route_id) === corridorId,
    { c: dbL.card_id, b: dbL.basis, k: dbL.scope_key });

  r = await call(`/control/pricing/cards/${cardAId}/lines`, { ck: ck("own"), method: "PUT",
    body: { ...lineBody, rate: "131500.75" } });
  check("the same scope typed twice is one line replaced, not a second price beside it",
    r.status === 200 && r.json?.lines?.length === 1 && String(r.json?.lines?.[0]?.id) === lineId
    && r.json?.lines?.[0]?.rate === "131500.7500", { s: r.status, l: r.json?.lines });

  let live = await one(`select count(*)::int as n from pricing_rate_lines where card_id = $1`, [cardAId]);
  check("and the card still holds exactly one figure", live.n === 1, live);

  r = await call(`/control/pricing/cards/${cardAId}`, asRead);
  check("the detail prints the corridor's own name and distance beside the figure",
    r.status === 200 && r.json?.lines?.[0]?.distance_km === 813
    && /Dar es Salaam/.test(String(r.json?.lines?.[0]?.route_label))
    && /^[0-9a-f]{64}$/.test(String(r.json?.paper_sha256)),
    { s: r.status, l: r.json?.lines?.[0] });
  check("and the day it carries over HTTP is the day that was typed, not the day before it",
    r.status === 200 && r.json?.card?.effective_from === TODAY
    && r.json?.card?.ref === dbA.ref && r.json?.versions?.length === 2,
    { s: r.status, ef: r.json?.card?.effective_from, v: r.json?.versions?.length });

  r = await call(`/control/pricing/cards/${cardAId}/history`, asRead);
  check("a draft has no memory: the price history is written when a signature is spent, not when a "
    + "figure is typed",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });

  // ---------------- 6. a price that answers a question ----------------
  phase("the resolver refuses rather than invents");
  r = await call(`/control/pricing/rate?day=${TODAY}&code=${encodeURIComponent(CODE1)}&basis=per_teu`, asRead);
  check("a draft is not a price: `no_price` is a 404 that names the day and the list it looked for",
    r.status === 404 && /has not been set/.test(words(r)) && words(r).includes(TODAY)
    && words(r).includes(`PR_SMOKE_${STAMP}`), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/rate?basis=per_litre`, asRead);
  check("the answer to `what does a litre cost` is the register's own list of bases",
    r.status === 400 && /does not price on a per_litre basis/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/rate?route=${randomUUID()}`, asRead);
  check("a corridor that is not in this book is refused by name, not answered with a null",
    r.status === 400 && /not a corridor of this book/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/quote?day=${TODAY}&code=${encodeURIComponent(CODE1)}&teu=2`, asRead);
  check("the simulator answers the price question first and only then the arithmetic one",
    r.status === 404 && /has not been set/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/quote?teu=0`, asRead);
  check("a container count of zero is the route's, not a division by nothing in the register",
    r.status === 400, { s: r.status, w: words(r) });

  r = await call("/control/pricing/board?status=live", asRead);
  check("a status the register has never heard of is answered with the five it keeps",
    r.status === 400 && /draft/.test(words(r)) && /withdrawn/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/board?search=kigoma&limit=1`, asRead);
  check("a search reaches the corridors a card prices, so `is there a price for Kigoma` is answerable",
    r.status === 200 && r.json?.total === 1 && r.json?.rows?.length === 1
    && r.json?.rows?.[0]?.id === cardAId && r.json?.counts?.draft === 2,
    { s: r.status, t: r.json?.total, n: r.json?.rows?.length, c: r.json?.counts });

  r = await call(`/control/pricing/corridors?search=kigoma`, asRead);
  check("and the corridor board counts how many of this book's lists already price along it",
    r.status === 200 && r.json?.rows?.some((c: any) => c.priced_on === 1),
    { s: r.status, rows: r.json?.rows?.map((c: any) => `${c.name}:${c.priced_on}`) });

  // ---------------- 7. the signature ----------------
  phase("a price is put up for a second seat, and never signed here");
  r = await call(`/control/pricing/cards/${cardBId}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "An empty list is not something to sign." } });
  check("a list with no figures cannot be put up: a signature on an empty card signs whatever comes next",
    r.status === 409 && /no figures on it/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "The corridor price for the season, per container." } });
  const approvalId = String(r.json?.approval_id ?? "");
  check("raising the paper returns the signature's id and the bytes it was cut on",
    r.status === 200 && /^[0-9a-f]{64}$/.test(String(r.json?.payload_sha256 ?? ""))
    && r.json?.lines === 1
    && r.json?.card?.card?.status === "pending_signature",
    { s: r.status, sha: r.json?.payload_sha256, n: r.json?.lines, st: r.json?.card?.card?.status });

  const dbA2 = await row("pricing_rate_cards", cardAId);
  check("the card now carries the paper, and the paper is the office's price_publish effect",
    dbA2.status === "pending_signature" && String(dbA2.approval_id) === approvalId,
    { st: dbA2.status, ap: dbA2.approval_id });

  const paper = await row("platform_approvals", approvalId);
  check("the register's paper names the card, the effect and the seat that asked",
    paper.action === "pricing.publish" && paper.status === "pending"
    && paper.target_kind === "rate_card" && String(paper.target_id) === cardAId
    && String(paper.proposed_by) === uBill,
    { a: paper.action, s: paper.status, t: paper.target_id, p: paper.proposed_by });

  r = await call(`/control/pricing/cards/${cardAId}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Asking twice for the same signature." } });
  check("a paper already waiting is a conflict that says which one to refuse first",
    r.status === 409 && /already waiting for a second seat/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}`, { ck: ck("bill"), method: "PATCH", body: {
    label: "Renamed underneath a signature" } });
  check("a card the office was asked to sign cannot change underneath them",
    r.status === 409 && /second seat/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/lines`, { ck: ck("bill"), method: "PUT",
    body: { ...lineBody, rate: "999999" } });
  check("nor can a figure be typed beside a paper that is out — the door says clone it forward instead",
    r.status === 409 && /cloning the list to a new version/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}`, asRead);
  check("the detail prints the paper's own hash, so a desk can see what was signed for",
    r.status === 200 && r.json?.approval?.payload_sha256 === paper.payload_sha256
    && r.json?.approval?.status === "pending",
    { s: r.status, ap: r.json?.approval });

  r = await call(`/control/pricing/cards/${cardAId}/withdraw`, { ck: ck("own"), method: "POST",
    body: { effective_to: TODAY, reason: "Stopping a price that was never a price." } });
  check("stopping a price that was never live is refused, in the register's words",
    r.status === 409 && /There is nothing to stop/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/refuse`, { ck: ck("read"), method: "POST",
    body: { note: "A reader has no standing to answer a paper." } });
  check("refusing a paper is the publish duty, not the read duty",
    r.status === 403, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "The per-container figure is a week off the market." } });
  check("a refusal answers the signature and frees the draft to be edited again",
    r.status === 200 && r.json?.card?.card?.status === "draft"
    && Number(r.json?.refusals) === 1 && r.json?.approval_id === approvalId,
    { s: r.status, st: r.json?.card?.card?.status, ref: r.json?.refusals });

  const dbA3 = await row("pricing_rate_cards", cardAId);
  const paper2 = await row("platform_approvals", approvalId);
  check("and the paper is answered as rejected on the register, in the same call",
    dbA3.status === "draft" && Number(dbA3.refusals) === 1 && paper2.status === "rejected"
    && String(paper2.decided_by) === uOwn,
    { st: dbA3.status, ps: paper2.status, by: paper2.decided_by });

  n = await one(`select count(*)::int as n from audit_logs
    where action = 'pricing.publish_refused' and entity_id = $1`, [cardAId]);
  check("one refusal is one audit line naming the seat that asked and the seat that answered",
    n.n === 1, n);

  r = await call(`/control/pricing/cards/${cardAId}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "Refusing a paper that was already answered." } });
  check("refusing twice is not a thing a register can record",
    r.status === 409 && /No signature is standing/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "Throwing away the draft the office was asked to sign." } });
  check("a card a signature ever stood on is kept, even back in draft and even by its own author",
    r.status === 409 && /signature/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardAId}/clone`, { ck: ck("own"), method: "POST",
    body: { note: "Cloning a version that was never a price." } });
  check("a draft is cloned forward only from a version that was signed",
    r.status === 409 && /is still a draft\. Clone a version that has been published/.test(words(r)),
    { s: r.status, w: words(r) });

  // ---------------- 8. two books are two worlds ----------------
  phase("another office book cannot see this one's prices");
  r = await call("/control/pricing/board", asEst);
  check("the other book's board is its own and empty",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });
  r = await call(`/control/pricing/cards/${cardAId}`, asEst);
  check("its seat reading this book's card id is answered 404, not with the card",
    r.status === 404, { s: r.status, w: words(r) });
  r = await call(`/control/pricing/lines/${lineId}`, { ck: ck("est"), method: "DELETE" });
  check("and its seat deleting this book's line is refused the same way",
    r.status === 404, { s: r.status, w: words(r) });
  r = await call("/control/pricing/corridors", asEst);
  check("the corridor filed here is not a corridor of that book either",
    r.status === 200 && r.json?.total === 0, { s: r.status, t: r.json?.total });

  // ---------------- 9. throwing a draft away, and what a read writes ----------------
  phase("a draft nobody was asked to sign is discardable");
  r = await call(`/control/pricing/lines/${lineId}`, { ck: ck("own"), method: "DELETE" });
  check("a figure is removable while the card is a draft, and the answer is the card it came off",
    r.status === 200 && r.json?.card?.id === cardAId && r.json?.lines?.length === 0,
    { s: r.status, c: r.json?.card?.id, l: r.json?.lines?.length });
  r = await call(`/control/pricing/lines/${lineId}`, { ck: ck("own"), method: "DELETE" });
  check("and removing it twice is a 404 that reads as a missing line, not a broken desk",
    r.status === 404, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cards/${cardBId}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "A draft opened by mistake and never signed." } });
  check("the draft is thrown away, and the answer says it priced nothing",
    r.status === 200 && r.json?.discarded && /Nothing was priced/.test(String(r.json?.message)),
    { s: r.status, j: r.json });
  const gone = await one(`select count(*)::int as n from pricing_rate_cards where id = $1`, [cardBId]);
  check("the row is really gone — a discard is a delete, not a status", gone.n === 0, gone);

  // `audit_logs` is partitioned on `ts` and has no created_at; a census filtered on a column that does
  // not exist would end this run with a database error rather than with an assertion about the register.
  const AUDITS = `select count(*)::int as n from audit_logs
    where action like 'pricing.%' and ts > to_timestamp($1/1000.0)`;
  const before = await one(AUDITS, [T0]);
  for (const p of ["/control/pricing/board", "/control/pricing/dimensions",
    "/control/pricing/corridors", `/control/pricing/cards/${cardAId}`,
    `/control/pricing/cards/${cardAId}/history`, "/control/pricing/rate", "/control/pricing/quote"]) {
    await call(p, asRead);
  }
  const after = await one(AUDITS, [T0]);
  check("seven reads write no audit line: the register records decisions, not glances",
    before.n === after.n, { before: before.n, after: after.n });

  const census = await one(`select
      (select count(*) from audit_logs where action = 'pricing.card_opened'
        and ts > to_timestamp($1/1000.0)) as opened,
      (select count(*) from audit_logs where action = 'pricing.card_edited'
        and ts > to_timestamp($1/1000.0)) as edited,
      (select count(*) from audit_logs where action = 'pricing.line_set'
        and ts > to_timestamp($1/1000.0)) as set_line,
      (select count(*) from audit_logs where action = 'pricing.publish_proposed'
        and ts > to_timestamp($1/1000.0)) as proposed,
      (select count(*) from audit_logs where action = 'pricing.card_discarded'
        and ts > to_timestamp($1/1000.0)) as discarded`, [T0]);
  check("every accepted write this run made left exactly one line — none of them doubled",
    Number(census.opened) === 2 && Number(census.edited) === 1 && Number(census.set_line) === 2
    && Number(census.proposed) === 1 && Number(census.discarded) === 1, census);

  // ---------------- teardown ----------------
  phase("teardown");
  await sweep();
  const END = await one(`select
      (select count(*) from pricing_rate_cards) as cards,
      (select count(*) from pricing_rate_lines) as lines,
      (select count(*) from pricing_price_history) as memory,
      (select count(*) from routes where name like 'PR Smoke %') as corridors`);
  check("the register is left exactly as this run found it",
    END.cards === START.cards && END.lines === START.lines && END.memory === START.memory
    && END.corridors === START.corridors, { start: START, end: END });
  // Not a census of `reason`: the paper this run raised is answered by 121's door, which rewrites the
  // row it owns. What the sweep must provably leave behind is nothing that points at a gone card.
  const seats = await one(`select (select count(*) from tenants where name like $1) as books,
      (select count(*) from users where email like $2) as seats,
      (select count(*) from pricing_rate_cards) as cards,
      (select count(*) from platform_approvals a where a.action = 'pricing.publish'
         and not exists (select 1 from pricing_rate_cards c where c.id::text = a.target_id)) as orphans`,
    [BOOK_SWEEP, EMAIL_SWEEP]);
  check("both fixture books, every fixture seat and every card are gone, and no paper is left pointing "
    + "at a card this run deleted",
    Number(seats.books) === 0 && Number(seats.seats) === 0 && Number(seats.cards) === 0
    && Number(seats.orphans) === 0, seats);

  await owner.end();
  console.log(`\n${failures ? `SMOKE FAILED (${failures})` : "SMOKE CLEAN"} in `
    + `${((Date.now() - T0) / 1000).toFixed(1)}s`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("probe died:", e);
  process.exitCode = 1;
});
