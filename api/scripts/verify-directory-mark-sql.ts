/**
 * Live proof for #343 — the mark beside a card and the hold a second seat signs
 * (migration 131, `api/src/routes/control-directory.routes.ts`, `api/src/routes/directory.routes.ts`).
 *
 * This file exists because of where 131's rules are kept.
 *
 * The API writes both registers through 131's definers, and a definer is a narrow door: it takes an
 * actor, a reason and a window, and it derives everything else. So the HTTP walk cannot hand the
 * database a lying row — and every one of the rules that actually decide whether a hold is honest
 * lives in a trigger on the row, below the door. "A hold cannot be aimed at another company after
 * the signature was asked for", "a running hold keeps the window it was signed with", "a card a
 * paper holds cannot be brought back by the moderation desk", "no new handover opens on a held
 * plate" and above all "a hold does not take effect without a second seat's signature" are only
 * reachable by writing the row itself. This gate writes the rows.
 *
 * It is also the only way an edited 131 reaches dev: 131 is already recorded in `schema_migrations`,
 * so `pnpm migrate` will never run it again. Phase 0 re-executes the file's function DDL and its
 * privilege lines, and commits them only under `--apply`. Its own `begin;`/`commit;` are never run —
 * a COMMIT inside the rehearsal would end the rehearsal and the rollback would be a warning about
 * nothing.
 *
 * The rest of what only SQL can answer:
 *   · the row's vocabularies are read out of the CHECKs and compared with the words the routes
 *     parse, so a filter the desk offers cannot be a word the register cannot hold;
 *   · a mark aimed at a card by hand is corrected by the trigger, and the six columns it derives
 *     are read back to prove the caller's words were thrown away rather than trusted;
 *   · 121's two-seat rule is a CHECK on the signature row (`decided_by <> proposed_by`), and 131's
 *     refuse door is allowed to be the proposing seat — phase 5 pins the branch that keeps those
 *     two facts from producing a 500 for a refusal a desk is entitled to make;
 *   · no client role, and no PUBLIC entry, can reach either register or any of its twenty-four
 *     functions, and `platform_approvals` stays reachable only through a definer.
 *
 * Everything from phase 1 onward runs inside one transaction that is rolled back, with a savepoint
 * around every statement: a raised trigger aborts the transaction, and every later query in an
 * aborted transaction answers "current transaction is aborted" instead of the question it was asked.
 * A sequence value is the one thing a rollback cannot take back — a `BL-` number that is burned here
 * is missing from the register for good, which is why `ref` is unique and never dense.
 *
 * Run: npx tsx scripts/verify-directory-mark-sql.ts          (from api/, rehearses and rolls back)
 *      npx tsx scripts/verify-directory-mark-sql.ts --apply   (131's DDL re-applied to dev)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "migrations/131_the_mark_and_the_exclusion.sql";
const ROUTE = "src/routes/control-directory.routes.ts";
const PORTAL = "src/routes/directory.routes.ts";
const APPLY = process.argv.includes("--apply");

const HEX = randomUUID().replace(/-/g, "");
const STAMP = `131sql${HEX.slice(0, 6)}`;
const NAME = (who: string) => `Hold Gate ${who} ${STAMP}`;
const EMAIL = (who: string) => `gate.${who}.${STAMP}@waisha.test`;
const REASON = "Cargo left at the inland depot without a consignee being told.";
const NOTE = "Two open incidences in the same week, both unattended for days.";
const SENT = "A second seat signs this hold on the papers read here.";

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`);
}
const note = (line: string) => console.log(`note   ${line}`);
const phase = (name: string) => console.log(`\n--- ${name} ---`);
const same = (a: string[], b: readonly string[]) =>
  a.length === b.length && b.every((w, i) => a[i] === w);

/** The quoted words of a CHECK, as `pg_get_constraintdef` prints them. Every definition read below
 *  is lower-cased on the way in, because the deparser writes `IS NOT NULL`, `Btrim` and `ARRAY` in
 *  its own case while the needles are the words the migration was typed in. */
function quoted(def: string): string[] {
  return [...def.matchAll(/'([a-z_0-9]+)'(?:::text)?/g)].map((m) => m[1]);
}

/** Anonymous CHECKs (`_check7`) renumber themselves the moment a rule is added, so a refusal is
 *  named by the words in the body rather than by a suffix that moves. */
const RULES: Record<string, string> = {};
function resolve(where: string, cons: { conname: string; def: string }[], ...needles: string[]) {
  const hits = cons.filter((c) => needles.every((n) => c.def.includes(n)));
  if (hits.length !== 1) {
    note(`!! "${where}" matched ${hits.length} rule(s): ${hits.map((h) => h.conname).join(", ") || "none"}`);
  }
  RULES[where] = hits[0]?.conname ?? "";
  return hits[0];
}

/** One `create or replace function … end $$;` block at a time: a whole migration file cannot be
 *  re-run, because `create index` and `create trigger` have no idempotent form. The function bodies
 *  and the privilege lines can, and those are the two things an in-place edit to 131 ever touches. */
function functionDdl(src: string): string[] {
  const out: string[] = [];
  const re = /^create or replace function platform_auth\.[a-z_]+\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const end = rest.indexOf("\nend $$;");
    if (end < 0) throw new Error(`no end-of-body for ${rest.slice(0, 60)}`);
    out.push(rest.slice(0, end + "\nend $$;".length));
  }
  return out;
}
function stmtBetween(src: string, start: string, stop: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`statement not found: ${start}`);
  const b = src.indexOf(stop, a);
  if (b < 0) throw new Error(`statement does not end with: ${stop}`);
  return src.slice(a, b + stop.length);
}

/** A word list declared in a TypeScript source, read the way the gate reads the catalog: the words
 *  are the interface, the file is the only place they are written down. */
function wordsOf(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}[^=]+=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/["']([a-z_.]+)["']/g)].map((x) => x[1]) : [];
}

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const src = readFileSync(FILE, "utf8");
  const routeSrc = readFileSync(ROUTE, "utf8");
  const portalSrc = readFileSync(PORTAL, "utf8");
  const code = src.replace(/--[^\n]*/g, "");

  // ---------------- 0 · the file, executed ----------------
  phase("0 · 131's doors and privilege lines re-execute against the live catalog");
  const ddl = functionDdl(src);
  const priv = [
    stmtBetween(src, "grant execute on function", "to app_runtime;"),
    stmtBetween(src, "revoke all on function", "from public, anon, authenticated, service_role;"),
    stmtBetween(src, "-- A trigger body is fired, never called.",
      "from public, anon, authenticated, app_runtime;")
  ];
  {
    const own = src.match(/^(begin|commit);$/gmi) ?? [];
    check("131 opens and closes its own transaction, and this gate never runs that pair",
      own.length === 2 && !/^(begin|commit);$/m.test(code.replace(/^\s*(begin|commit);$/gmi, "")), own);
    check(`the file declares ${ddl.length} functions and this gate found every one of them`,
      ddl.length === (src.match(/^create or replace function platform_auth\./gm) ?? []).length
      && ddl.length === 24, ddl.length);
    check("…none of them was written to count rows the Oracle way, which is legal to create and "
      + "fatal to run", !/%rowcount/i.test(code), (code.match(/.{0,40}%rowcount.{0,20}/i) ?? [""])[0]);

    const runner = new pg.Client({
      connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
    });
    await runner.connect();
    const recorded = (await runner.query(
      `select name from schema_migrations where name like '131%'`)).rows;
    check("131 is already recorded, which is why an edited 131 needs this file rather than "
      + "`pnpm migrate`", recorded.length === 1, recorded);
    let err: any = null;
    await runner.query("begin");
    try {
      for (const block of ddl) await runner.query(block);
      for (const p of priv) await runner.query(p);
    } catch (e) { err = e; }
    if (!err && APPLY) await runner.query("commit");
    else await runner.query("rollback");
    check(`the ${ddl.length} bodies and the ${priv.length} privilege statements run together`
      + `${APPLY ? " and are committed" : " and are rolled back"}`, !err, err?.message);
    check("…and `create or replace` left every door's grant list alone — a drop-and-create would "
      + "have reset EXECUTE to PUBLIC", !err, err?.message);
    await runner.end();
  }

  const owner = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 180000
  });
  await owner.connect();
  await owner.query("begin");
  const oi = (sql: string, p: any[] = []) => owner.query(sql, p);
  const one = async (sql: string, p: any[] = []) => (await oi(sql, p)).rows[0];
  let sp = 0;
  const guarded = async (sql: string, p: any[] = []) => {
    const name = `s${++sp}`;
    await oi(`savepoint ${name}`);
    try {
      const rows = (await oi(sql, p)).rows;
      await oi(`release savepoint ${name}`);
      return { rows, err: null as any };
    } catch (err: any) {
      await oi(`rollback to savepoint ${name}`);
      return { rows: null as any, err };
    }
  };
  const fails = async (label: string, sql: string, p: any[] = [], want = "") => {
    const { err } = await guarded(sql, p);
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) {
      const named = /^[a-z0-9_]+$/.test(want);
      const hit = named ? err.constraint === want : String(err.message).includes(want);
      check(`…by ${want}`, hit, { constraint: err.constraint, message: err.message });
    }
    return err;
  };
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) check(`${label} — it raised`, false, err.message);
    return rows as Record<string, any>[];
  };
  /** A definer answers with a jsonb value, so its refusal is read rather than caught. A door that
   *  *raises* instead of answering is a different fault and is labelled as one. */
  const call = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) {
      check(`${label} — the door raised instead of answering`, false, err.message);
      return null as Record<string, any> | null;
    }
    return (rows?.[0]?.r ?? null) as Record<string, any> | null;
  };

  // ---------------- fixtures ----------------
  const complianceRole = (await one(`select id from roles where key = 'compliance_officer'
    and tenant_id is null`))?.id;
  const superRole = (await one(`select id from roles where key = 'super_admin'
    and tenant_id is null`))?.id;
  if (!complianceRole || !superRole) throw new Error("global compliance/super roles missing");

  const TA = randomUUID(), TB = randomUUID(), TE = randomUUID(), TS = randomUUID(), TC = randomUUID();
  const uA = randomUUID(), uS = randomUUID(), uS2 = randomUUID(), uC1 = randomUUID(),
    uC2 = randomUUID();
  const LA = randomUUID(), LB = randomUUID();
  const ship = randomUUID(), job = randomUUID(), req = randomUUID(), booking = randomUUID();
  const pass = randomUUID(), search = randomUUID();
  const vessel = randomUUID(), seekerTruck = randomUUID(), driver = randomUUID();

  for (const [id, type, name] of [
    [TA, "transporter", NAME("Carrier")], [TB, "transporter", NAME("Trader")],
    [TE, "transporter", NAME("Bystander")], [TS, "seeker", NAME("Seeker")],
    [TC, "platform", NAME("Office")]
  ] as const) {
    await oi(`insert into tenants (id, type, name, status) values ($1,$2,$3,'active')`,
      [id, type, name]);
  }
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
            values ($1,$2,'director',$3,'active',$4)`, [uA, TA, "Gate Director", EMAIL("a")]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
            values ($1,$2,'seeker',$3,'active',$4)`, [uS, TS, "Gate Seeker", EMAIL("s")]);
  // A second seat at the same seeker account: the register allows one mark per person per card, so
  // a gate that wants a second mark on the same card has to ask honestly for a second person.
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
            values ($1,$2,'seeker',$3,'active',$4)`, [uS2, TS, "Gate Seeker Two", EMAIL("s2")]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email, totp_enabled)
            values ($1,$2,'platform','Gate Compliance','active',$3,true)`,
    [uC1, TC, EMAIL("c1")]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email, totp_enabled)
            values ($1,$2,'platform','Gate Super','active',$3,true)`,
    [uC2, TC, EMAIL("c2")]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6)`,
    [uA, complianceRole, uC1, complianceRole, uC2, superRole]);

  // A confirmed job between the two companies, on 048's own chain — the mark's other proof.
  await oi(`insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
             container_type, consignee_name, consignor_name)
           values ($1,$2,$3,1,2026,'import','20ft','Consignee','Consignor')`,
    [ship, TB, `GT${HEX.slice(0, 8)}`]);
  await oi(`insert into jobs (id, tenant_id, shipment_id, status) values ($1,$2,$3,'open')`,
    [job, TB, ship]);
  await oi(`insert into transport_requests (id, tenant_id, job_id, shipment_id, cargo_label,
             pickup_text, dest_text, required_date, contact_name, contact_channel, company_name,
             status, disclosed_at)
           values ($1,$2,$3,$4,'2 x 20ft','Dar es Salaam','Arusha', current_date + 3,
             'Trader Desk','+255 700 000 201',$5,'confirmed', now())`,
    [req, TB, job, ship, NAME("Trader")]);
  await oi(`insert into transport_bookings (id, request_id, tenant_id, status, contact_name,
             contact_channel, cargo_label, pickup_text, dest_text, required_date, company_name,
             confirmed_at)
           values ($1,$2,$3,'confirmed','Carrier Desk','+255 700 000 202','2 x 20ft',
             'Dar es Salaam','Arusha', current_date + 3, $4, now())`,
    [booking, req, TA, NAME("Carrier")]);

  // 061 closes `serves` to the two words the seekers look for, so the carrier is listed as a
  // transporter and the company that hires it as a cfa — both halves of the vocabulary in play.
  for (const [tid, name, listing, serve] of [
    [TA, NAME("Carrier"), LA, "transporter"], [TB, NAME("Trader"), LB, "cfa"]
  ] as const) {
    await oi(`insert into directory_listings (id, tenant_id, serves, company_name, headline,
               contact_name, contact_channel, status, published_at, is_verified)
             values ($1,$2,array[$5],$3,$4,'Desk','+255 700 000 209','live', now(), true)`,
      [listing, tid, name, `Haulage out of ${STAMP}`, serve]);
  }

  const weekly = (await one(`select id, searches_allowed from seeker_pass_products where key = 'weekly'`));
  if (!weekly) throw new Error("061's weekly pass product is missing — run pnpm seed");
  await oi(`insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
             searches_allowed, searches_used, starts_at, expires_at)
           values ($1,$2,$3,$4,'weekly','live',$5,2, now(), now() + interval '168 hours')`,
    [pass, TS, uS, weekly.id, weekly.searches_allowed]);
  await oi(`insert into seeker_searches (id, tenant_id, user_id, pass_id, listing_id, query,
             credits_left)
           values ($1,$2,$3,$4,$5,$6,$7)`,
    [search, TS, uS, pass, LA, `gate ${search}`, weekly.searches_allowed - 2]);

  await oi(`insert into vessels (id, tenant_id, name, vessel_type, plate_number)
            values ($1,$2,$3,'truck_head',$4)`,
    [vessel, TA, NAME("Truck"), `GATE${HEX.slice(0, 6).toUpperCase()}`]);
  // A truck at the seeker account: the register must be able to name the owner before it can
  // refuse the hold, and this is the only subject in the fixtures that is not a transport account.
  await oi(`insert into vessels (id, tenant_id, name, vessel_type, plate_number)
            values ($1,$2,$3,'truck_head',$4)`,
    [seekerTruck, TS, NAME("Seeker truck"), `GATQ${HEX.slice(0, 6).toUpperCase()}`]);
  await oi(`insert into drivers (id, tenant_id, full_name, licence_class, status,
             nida_search, phone_search)
           values ($1,$2,$3,'CE','available',$4,$5)`,
    [driver, TA, NAME("Driver"), `nid${HEX.slice(0, 10)}`, `phn${HEX.slice(0, 10)}`]);

  // ---------------- 1 · the words ----------------
  phase("1 · the vocabularies, read out of the CHECKs and set against the routes");
  /** `pg_get_constraintdef` re-deparses the expression, so it prints casts the migration never
   *  wrote and a shape nobody typed (`trim(both from x)` for `btrim(x)`). The needles below are the
   *  sentences 131 actually says; the deparser's type labels are stripped before matching so a rule
   *  is named by its logic, not by whichever cast this Postgres release happens to insert. */
  const flat = (s: string) => s
    .replace(/::\s*(text|integer|bigint|smallint|boolean|uuid|numeric|jsonb|date|interval|timestamp( with time zone)?)\b/g, "")
    .replace(/\s+/g, " ");
  const cons = async (rel: string, only?: string) => {
    const where = only ? ` and conname = $2` : "";
    const r = await oi(`select conname, lower(pg_get_constraintdef(oid)) as def from pg_constraint
       where conrelid = $1::regclass and contype = 'c'${where} order by conname`,
      only ? [rel, only] : [rel]);
    return r.rows.map((x: any) => ({ conname: x.conname as string, def: flat(x.def) as string }));
  };
  const ratingCons = await cons("directory_ratings");
  const holdCons = await cons("directory_exclusions");
  const holdCheckCons = await cons("directory_listings", "directory_listings_hold_check");
  for (const c of [...ratingCons, ...holdCons, ...holdCheckCons]) note(`${c.conname} — ${c.def}`);
  const defOf = (cons: { conname: string; def: string }[], suffix: string) =>
    cons.find((c) => c.conname.endsWith(suffix))?.def ?? "";

  check("the two proofs a mark may stand on are the two the door accepts",
    same(quoted(defOf(ratingCons, "_basis_check")), ["booking", "engagement"]),
    defOf(ratingCons, "_basis_check"));
  check("…and the two kinds of speaker are 'company' and 'seeker', which is what the register can "
    + "name — a seeker is never named",
    same(quoted(defOf(ratingCons, "_rater_kind_check")), ["company", "seeker"]),
    defOf(ratingCons, "_rater_kind_check"));
  check("…and stars are one to five", /stars >= 1/.test(defOf(ratingCons, "_stars_check"))
    && /stars <= 5/.test(defOf(ratingCons, "_stars_check")), defOf(ratingCons, "_stars_check"));

  const HOLD_ROW_STATES = ["raised", "pending_signature", "active", "lifted", "refused"];
  check("the hold's five row states are exactly the five the door can write",
    same(quoted(defOf(holdCons, "_status_check")), HOLD_ROW_STATES),
    defOf(holdCons, "_status_check"));
  check("the subject kinds the desk filters on are the subject kinds the row can hold",
    same(quoted(defOf(holdCons, "_subject_kind_check")), wordsOf(routeSrc, "SUBJECTS")),
    `${defOf(holdCons, "_subject_kind_check")} vs ${wordsOf(routeSrc, "SUBJECTS")}`);
  check("the reason codes the desk picks from are the reason codes the row allows, in the same list "
    + "121's company ban uses",
    same(quoted(defOf(holdCons, "_reason_code_check")), wordsOf(routeSrc, "REASONS")),
    defOf(holdCons, "_reason_code_check"));
  check("a hold is dated: one day to three years, so no paper runs without a date to re-check",
    /days >= 1/.test(defOf(holdCons, "_days_check"))
    && /days <= 1095/.test(defOf(holdCons, "_days_check")), defOf(holdCons, "_days_check"));
  check("the register's number is its own shape, so a desk can read it out over the phone",
    /btrim\(t\.?\*?ref\) ~ '\^bl-\{4\}-\{5,\}\$'/i.test(defOf(holdCons, "_ref_check").replace(/\s+/g, ""))
    || /\^bl-\[0-9\]\{4\}-\[0-9\]\{5,\}\$/.test(defOf(holdCons, "_ref_check")),
    defOf(holdCons, "_ref_check"));

  // Every sentence the register holds is floored at eight characters, and the route floors at eight.
  const sentenceCols = ["comment", "reply", "hidden_reason"];
  check("all eight sentences on the two registers carry the same floor the route parses",
    sentenceCols.every((c) => /char_length\(trim\(both from/.test(defOf(ratingCons, `_${c}_check`))
      && defOf(ratingCons, `_${c}_check`).includes(">= 8")
      && defOf(ratingCons, `_${c}_check`).includes("<= 600"))
      && ["reason", "note"].every((c) => defOf(holdCons, `_${c}_check`).includes(">= 8"))
      && ["lifted_note", "refused_note"].every((c) => defOf(holdCons, `_${c}_check`).includes(">= 8"))
      && /min\(8\)/.test(routeSrc),
    `${defOf(ratingCons, "_reply_check")} | ${defOf(holdCons, "_lifted_note_check")}`);

  const boardBody = (await one(`select pg_get_functiondef(p.oid) as def from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform_auth' and p.proname = 'directory_exclusions_board'`))?.def ?? "";
  check("every state word the desk can filter on resolves to a state the row can hold",
    wordsOf(routeSrc, "HOLD_STATES").filter((w) => w !== "all")
      .every((w) => boardBody.toLowerCase().includes(`p_state = '${w}'`)),
    wordsOf(routeSrc, "HOLD_STATES"));
  check("…and every row state is reachable from the queue, so no paper is filed where nobody looks",
    HOLD_ROW_STATES.every((st) => new RegExp(`e\\.status = '${st}'`).test(boardBody.toLowerCase())),
    HOLD_ROW_STATES.filter((st) => !new RegExp(`e\\.status = '${st}'`).test(boardBody.toLowerCase())));

  // Anonymous rules, resolved by their words so a renumbering cannot misreport which one fired.
  resolve("a mark and a card cannot be the same tenant", ratingCons, "rater_tenant_id <> listed_tenant_id");
  resolve("the basis states its own proof", ratingCons, "(basis = 'booking') = (booking_id is not null)");
  resolve("an engagement names a search", ratingCons, "(basis = 'engagement') = (search_id is not null)");
  resolve("a job is marked by a company", ratingCons, "(basis = 'booking') = (rater_kind = 'company')");
  resolve("an answer and its hour are written together", ratingCons, "(replied_by is null) = (replied_at is null)");
  resolve("a hidden mark names who hid it", ratingCons, "(hidden_by is null) = (hidden_at is null)");
  resolve("a hidden mark carries its reason", ratingCons, "(hidden_at is null) or (hidden_reason is not null)");
  resolve("a mark does not outlive its author", ratingCons, "(withdrawn_by is null) = (withdrawn_at is null)");
  resolve("only a company hold names a card", holdCons, "(subject_kind = 'company') = (listing_id is not null)");
  resolve("a paper waiting for a signature stands on one", holdCons,
    "(status <> 'pending_signature') or (approval_id is not null)");
  resolve("a running or lifted hold has started", holdCons,
    "((status = 'active') or (status = 'lifted')) = (starts_at is not null)");
  resolve("a hold ends after it starts", holdCons, "(ends_at is null) or (ends_at > starts_at)");
  resolve("a running hold was signed and spent by a named seat", holdCons,
    "(approval_id is not null) and (activated_by is not null) and (activated_at is not null)");
  resolve("a lifted hold says who lifted it and why", holdCons,
    "(lifted_by is not null) and (lifted_at is not null)");
  resolve("a refused hold says who refused it and why", holdCons,
    "(refused_by is not null) and (refused_at is not null)");
  resolve("a card only flags a hold it is suspended under", holdCheckCons,
    "held_by_exclusion = false) or (status = 'suspended')");
  // 121's two-seat rule lives on the signature register, not on 131's tables. Read it the same way
  // as the others, by its words — the name is anonymous and renumbers with the rest of them.
  resolve("the seat that decides a paper is not the seat that raised it",
    await cons("platform_approvals"), "(decided_by is null) or (decided_by <> proposed_by");
  for (const [where, name] of Object.entries(RULES)) {
    if (!name) note(`!! the rule "${where}" was not found in the catalog`);
  }

  // ---------------- 2 · the mark ----------------
  phase("2 · a mark aimed by hand is corrected, and every proof a mark claims is checked");
  const MK_COLS = `listing_id, listed_tenant_id, listed_name, basis, booking_id,
       search_id, rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment`;
  const mkGate = async (label: string, p: any[]) => (await okDo(label,
    `insert into directory_ratings (${MK_COLS})
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id, listing_id, listed_tenant_id, listed_name, rater_kind, rater_name`, p))[0] ?? null;

  // The caller lies about all six derived columns. The trigger reads the search, finds the card the
  // seeker actually opened, and throws the rest away.
  const lie = await mkGate("an engagement mark written by hand with every derived column forged",
    [LB, TB, "Somebody Else Ltd", "engagement", null, search, TS, uS, "company",
      "A Named Rival", 4, COMMENT_SENT()]);
  check("the mark lands, on the card the search opened — not the one the writer named",
    lie?.listing_id === LA && lie?.listed_tenant_id === TA, lie);
  check("…the listed company is the card's own name, copied when the mark was written",
    lie?.listed_name === NAME("Carrier"), lie?.listed_name);
  check("…the writer is a seeker, whatever they called themselves, and is never named",
    lie?.rater_kind === "seeker" && lie?.rater_name === "a seeker on WAISHA", lie);
  const moved = await fails("a mark's proof cannot be moved onto another search afterwards",
    `update directory_ratings set search_id = $2 where id = $1`,
    [lie?.id, randomUUID()], "the proof cannot be moved");
  check("…and the refusal is the register's own sentence, not a CHECK number",
    /cannot be moved/.test(String(moved?.message)), moved?.message);
  await fails("…nor onto a different card",
    `update directory_ratings set listing_id = $2 where id = $1`, [lie?.id, LB],
    "the proof cannot be moved");

  // The branch that stops a seat marking the card it trades under is reached through the search,
  // because a booking mark can only ever be aimed at the other party. 061's publish guard only
  // speaks for `status='live'`, so a seeker's own draft card exists, and a mark of it is the self-
  // mark the register must refuse even though no route would ever offer that pair.
  const ownCard = (await one(`insert into directory_listings (id, tenant_id, serves, company_name,
    headline, contact_name, contact_channel, status, is_verified)
    values ($1,$2,array['transporter'],$3,'A draft nobody published','Desk','+255 700 000 210',
    'draft',false) returning id`, [randomUUID(), TS, NAME("Own card")]))?.id;
  const ownSearch = (await one(`insert into seeker_searches (tenant_id, user_id, pass_id, listing_id,
    query, credits_left) values ($1,$2,$3,$4,'gate own card',2) returning id`,
    [TS, uS, pass, ownCard]))?.id;
  await fails("a seat cannot mark the card it trades under",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, search_id,
       rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Somebody Else','engagement',$3,$2,$4,'seeker','a seeker on WAISHA',3,$5)`,
    [ownCard, TS, ownSearch, uS, COMMENT_SENT()], "cannot mark its own card");

  const mkBooked = await mkGate("a booking mark, aimed at the counterparty the job names",
    [LB, TB, "Wrong Name", "booking", booking, null, TA, uA, "seeker",
      "Whatever The Caller Typed", 5, COMMENT_SENT()]);
  check("the target of a booking mark is the other party to the job, read out of the job",
    mkBooked?.listing_id === LB && mkBooked?.listed_tenant_id === TB, mkBooked);
  check("…and a company speaking for its tenant is named as its tenant",
    mkBooked?.rater_kind === "company" && mkBooked?.rater_name === NAME("Carrier"), mkBooked);

  await fails("a booking that does not exist cannot carry a mark",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, booking_id,
       rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Carrier Co','booking',$3,$2,$4,'company','Carrier Co',3,$5)`,
    [LA, TA, randomUUID(), uA, COMMENT_SENT()], "no booking");
  await fails("a seat that was not on the job cannot mark it",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, booking_id,
       rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Bystander Co','booking',$3,$4,$5,'company',${"$6"},3,$7)`,
    [LB, TB, booking, TE, randomUUID(), "Bystander Co", COMMENT_SENT()],
    "only the two companies on that job");
  await fails("a search that opened a list, not a card, is not a proof",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, search_id,
       rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Carrier Co','engagement',$3,$4,$5,'seeker','a seeker on WAISHA',2,$6)`,
    [LA, TA, (await one(`insert into seeker_searches (tenant_id, user_id, pass_id, query, credits_left)
      values ($1,$2,$3,'a list',2) returning id`, [TS, uS, pass]))?.id, TS, uS, COMMENT_SENT()],
    "opened a list, not a company");
  // A basis that names no proof of its own kind is refused twice over: by the trigger, which reads
  // the proof before the row is weighed, and by the CHECK below it. The trigger answers first, so
  // this records which of the two a desk actually meets — the CHECK is proved present in phase 1.
  const noProof = await fails("a basis with no proof of that kind never reaches the row",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, search_id,
       rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Carrier Co','booking',$3,$4,$5,'company','Carrier Co',2,$6)`,
    [LA, TA, search, TS, uS, COMMENT_SENT()], "no booking");
  check("…by the naming trigger, so the paired CHECK below it is a belt and not the buckle — a desk "
    + "meets the sentence first",
    noProof?.constraint !== RULES["the basis states its own proof"],
    { fired: noProof?.constraint, belt: RULES["the basis states its own proof"] });
  await fails("two proofs on one mark is not a stronger mark, it is a false one",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, booking_id,
       search_id, rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Trader Co','booking',$3,$4,$5,$6,'company','Carrier Co',2,$7)`,
    [LB, TB, booking, search, TA, uA, COMMENT_SENT()], RULES["an engagement names a search"]);
  await fails("a two-word mark never reaches the register",
    `insert into directory_ratings (listing_id, listed_tenant_id, listed_name, basis, search_id,
       rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment)
     values ($1,$2,'Carrier Co','engagement',$3,$4,$5,'seeker','a seeker on WAISHA',2,'noted')`,
    [LA, TA, search, TS, uS], "directory_ratings_comment_check");

  // The keeper on an answered, hidden and withdrawn mark.
  const answered = randomUUID();
  const search2 = (await one(`insert into seeker_searches (tenant_id, user_id, pass_id, listing_id,
    query, credits_left) values ($1,$2,$3,$4,'gate second seat',2) returning id`,
    [TS, uS2, pass, LA]))?.id;
  await oi(`insert into directory_ratings (id, listing_id, listed_tenant_id, listed_name, basis,
             search_id, rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment,
             reply, replied_by, replied_at)
           values ($1,$2,$3,$4,'engagement',$5,$6,$7,'seeker','a seeker on WAISHA',2,$8,$9,$10,now())`,
    [answered, LA, TA, NAME("Carrier"), search2, TS, uS2, REASON,
      "We train every clerk on seal checks before a box leaves the yard.", uA]);
  await fails("an answered mark cannot be retyped out from under the answer",
    `update directory_ratings set stars = 5 where id = $1`, [answered], "has been answered");
  await fails("…and it carries one answer, written once",
    `update directory_ratings set reply = $2 where id = $1`, [answered, REASON],
    "already carries its one reply");
  await fails("…and the answer cannot be written without the hour it was written at",
    `update directory_ratings set replied_at = null where id = $1`, [answered],
    RULES["an answer and its hour are written together"]);
  await oi(`update directory_ratings set withdrawn_at = now(), withdrawn_by = $2 where id = $1`,
    [answered, uS2]);
  await fails("a withdrawn mark stays withdrawn — deleting a review is not how you get a free one",
    `update directory_ratings set withdrawn_at = null where id = $1`, [answered],
    "was withdrawn by its author and stays withdrawn");
  const hiddenOne = randomUUID();
  await oi(`insert into directory_ratings (id, listing_id, listed_tenant_id, listed_name, basis,
             search_id, rater_tenant_id, rater_user_id, rater_kind, rater_name, stars, comment,
             hidden_at, hidden_by, hidden_reason)
           values ($1,$2,$3,$4,'engagement',$5,$6,$7,'seeker','a seeker on WAISHA',1,$8,now(),$9,$10)`,
    [hiddenOne, LA, TA, NAME("Carrier"), (await one(`insert into seeker_searches
        (tenant_id, user_id, pass_id, listing_id, query, credits_left)
        values ($1,$2,$3,$4,'gate hidden',2) returning id`, [TS, uS, pass, LB]))?.id,
      TS, uS, REASON, uC1, "The writer names a route this company has never run."]);
  await fails("a hidden mark cannot be retyped while it is off the board",
    `update directory_ratings set comment = $2, hidden_at = null where id = $1`,
    [hiddenOne, "Two boxes handed over with the seals intact and on time."],
    "was hidden for a reason");
  await fails("…and a mark cannot be hidden without saying why",
    `update directory_ratings set hidden_at = now(), hidden_by = $2 where id = $1`,
    [lie?.id, uC1], RULES["a hidden mark carries its reason"]);

  // ---------------- 3 · the hold ----------------
  phase("3 · a hold the desk writes by hand, and the second seat it still needs");
  const nextRef = async () => (await one(
    `select 'BL-' || to_char(now(),'YYYY') || '-' ||
            lpad(nextval('directory_exclusion_number_seq')::text, 5, '0') as ref`))?.ref;
  const draftOf = async (label: string, kind: string, subjectId: string, days = 5, status = "raised") => {
    const id = randomUUID();
    const rows = await okDo(label, `insert into directory_exclusions
        (id, tenant_id, ref, subject_kind, subject_id, subject_name, subject_label,
         subject_tenant_id, company_name, reason_code, reason, note, days, status, raised_by)
      values ($1,$2,$3,$4,$5,'A Name Typed By The Desk','a label typed by the desk',
              '00000000-0000-0000-0000-000000000000','Nobody''s Company','complaint',$6,$7,$8,$9,$10)
      returning id, ref, subject_name, subject_label, subject_tenant_id, company_name, listing_id`,
      [id, TC, await nextRef(), kind, subjectId, REASON, NOTE, days, status, uC1]);
    return rows[0] ?? null;
  };

  const draft = await draftOf("a draft paper on a company, with everything about the subject forged",
    "company", LA);
  check("the register reads the subject out of the card and throws away what the desk typed",
    draft?.subject_name === NAME("Carrier") && draft?.subject_label === "transporter"
    && draft?.subject_tenant_id === TA && draft?.company_name === NAME("Carrier")
    && draft?.listing_id === LA, draft);
  check("…the paper is numbered from its own sequence, in the shape a desk can quote",
    /^BL-\d{4}-\d{5}$/.test(String(draft?.ref)), draft?.ref);

  await fails("a subject that is not a card, a plate or a driver is no subject at all",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, raised_by)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,3,$6)`,
    [TC, await nextRef(), randomUUID(), REASON, NOTE, uC1], "no directory card");
  await fails("a vehicle whose owner is not a transport account is not the directory's to hold",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, raised_by)
     values ($1,$2,'vehicle',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,3,$6)`,
    [TC, await nextRef(), seekerTruck, REASON, NOTE, uC1], "which the directory does not carry");
  note("The subject's name, tenant and label are read out of the register before that test runs, so "
    + "the refusal quotes the plate back — which is the only part of a vehicle a desk may repeat.");
  const traderDraft = await draftOf("…so a paper on the CFA card is raised for real", "company", LB);
  check("…and its subject tenant is the CFA's own account",
    traderDraft?.subject_tenant_id === TB && traderDraft?.company_name === NAME("Trader"), traderDraft);

  await fails("a hold cannot take effect on one seat's word, however the row is written",
    `update directory_exclusions set status = 'active', starts_at = now(),
            ends_at = now() + interval '5 days', activated_by = $2, activated_at = now()
      where id = $1`, [draft?.id, uC1], "without a second seat's signature");
  await fails("…the same refusal on a fresh insert, not only on an update",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, status,
       raised_by, starts_at, ends_at, activated_by, activated_at)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       5,'active',$6, now(), now() + interval '5 days',$6, now())`,
    [TC, await nextRef(), LA, REASON, NOTE, uC1], "without a second seat's signature");

  await fails("a paper waiting for a signature has to stand on one",
    `update directory_exclusions set status = 'pending_signature' where id = $1`,
    [draft?.id], RULES["a paper waiting for a signature stands on one"]);
  const noSeat = await fails("a running hold cannot be written by hand, so the row never gets as "
    + "far as asking who spent the signature",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, status,
       raised_by, starts_at)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       5,'active',$6, now())`,
    [TC, await nextRef(), LA, REASON, NOTE, uC1], "without a second seat's signature");
  check(`…by the two-seat trigger, with ${RULES["a running hold was signed and spent by a named seat"]}`
    + " underneath it", noSeat?.constraint !== RULES["a running hold was signed and spent by a named seat"],
    { fired: noSeat?.constraint, belt: RULES["a running hold was signed and spent by a named seat"] });
  await fails("…and a lifted paper has to say who lifted it",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, status,
       raised_by, starts_at, ends_at)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       5,'lifted',$6, now(), now() + interval '5 days')`,
    [TC, await nextRef(), LA, REASON, NOTE, uC1], RULES["a lifted hold says who lifted it and why"]);
  await fails("a vehicle paper cannot also name a card",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, listing_id,
       raised_by)
     values ($1,$2,'vehicle',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       5,$6,$7)`,
    [TC, await nextRef(), vessel, REASON, NOTE, LA, uC1], RULES["only a company hold names a card"]);
  await fails("a hold with no window is a fact nobody is ever asked to re-check",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, raised_by)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       0,$6)`,
    [TC, await nextRef(), LA, REASON, NOTE, uC1], "directory_exclusions_days_check");
  await fails("a number that is not the register's shape is not a paper",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, raised_by)
     values ($1,'BAN-1','company',$2,'x','y','00000000-0000-0000-0000-000000000000','z',
             'complaint',$3,$4,30,$5)`,
    [TC, LA, REASON, NOTE, uC1], "directory_exclusions_ref_check");
  // A `raised` paper has no window at all — 131 makes starts_at belong to the active and lifted
  // states — so the ordering rule can only be met by a paper that has one. This is a closed hold
  // whose recorded window runs backwards, which no door can write but a hand can.
  await fails("an ended hold whose window closes before it opened is not a window",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, status,
       raised_by, starts_at, ends_at, lifted_by, lifted_at, lifted_note)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       5,'lifted',$6, now(), now() - interval '1 hour',$6, now(),
       'Lifted by the second desk once the papers were read back.')`,
    [TC, await nextRef(), LA, REASON, NOTE, uC1], RULES["a hold ends after it starts"]);

  // A signature written straight onto 121's register, so a running hold can be built below. The
  // owner role is the only role that can: `platform_approvals` is revoked from everything else.
  // The id is supplied, not minted inside — the two-seat trigger looks the paper up by
  // `a.id = new.approval_id`, so a signature whose id the gate does not know is a signature that
  // cannot be spent.
  const signPaper = (approvalId: string, targetId: string | undefined, proposer: string, decider: string) =>
    guarded(`insert into platform_approvals (id, action, target_kind,
       target_id, payload, payload_sha256, reason, status, proposed_by, proposed_role, proposed_at,
       decided_by, decided_role, decided_at, applied_at, result, expires_at)
     values ($1,'directory.exclusion','directory_exclusion',$2,'{}'::jsonb,
       '0000000000000000000000000000000000000000000000000000000000000000',$3,'applied',$4,
       'compliance_officer', now(),$5,'super_admin', now(), now(),'{}'::jsonb,
       now() + interval '7 days')`, [approvalId, targetId, SENT, proposer, decider]);
  const signed = randomUUID();
  const paper = await draftOf("a paper that will be signed", "company", LA);
  const firstSig = await signPaper(signed, paper?.id, uC1, uC2);
  check("121's register takes a second seat's signature on this paper", !firstSig.err,
    firstSig.err?.message);
  const running = (await okDo("a signed paper takes effect, when the signature is real",
    `update directory_exclusions
        set status = 'active', approval_id = $2, starts_at = now(),
            ends_at = now() + make_interval(days => days), activated_by = $3, activated_at = now()
      where id = $1
      returning id, ref, ends_at`, [paper?.id, signed, uC2]))[0];
  check("the two-seat trigger let the paper through on a signature it could verify",
    !!running?.id && !!running?.ends_at, running);
  const selfSigned = await signPaper(randomUUID(), paper?.id, uC1, uC1);
  check("…and it refuses the same paper signed by the seat that raised it", !!selfSigned.err,
    selfSigned.err ? "" : "121's own rule did not fire");
  check(`…by the rule ${RULES["the seat that decides a paper is not the seat that raised it"]}`,
    selfSigned.err?.constraint
    === RULES["the seat that decides a paper is not the seat that raised it"],
    { constraint: selfSigned.err?.constraint, message: selfSigned.err?.message });
  await fails("a running hold keeps the window the second seat agreed to",
    `update directory_exclusions set days = 365 where id = $1`, [paper?.id],
    "cannot move under it");
  await fails("…and the sentence it was signed on",
    `update directory_exclusions set reason = $2 where id = $1`,
    [paper?.id, "A different complaint invented after the signature was given."],
    "cannot move under it");
  await fails("…and a running hold is lifted with a note, never switched off",
    `update directory_exclusions set status = 'refused' where id = $1`, [paper?.id],
    "lifted with a note, not deleted");
  await fails("a draft cannot be walked onto another company after it was raised",
    `update directory_exclusions set subject_id = $2 where id = $1`,
    [traderDraft?.id, LA], "raise a new paper for anybody else");
  // A second paper on the same card, with a signature of its own, so the two-seat trigger is happy
  // and the index is the rule that has to answer. Re-using the first paper's signature would only
  // prove the trigger, and the desk would never meet the one-live index.
  const paper2 = await draftOf("a second paper on the same card", "company", LA);
  const signed2 = randomUUID();
  await signPaper(signed2, paper2?.id, uC1, uC2);
  const secondActive = await fails("only one hold can run on one subject at a time",
    `update directory_exclusions
        set status = 'active', approval_id = $2, starts_at = now(),
            ends_at = now() + interval '5 days', activated_by = $3, activated_at = now()
      where id = $1`, [paper2?.id, signed2, uC2], "directory_exclusions_one_live");
  check("…which is the index answering, not the signature rule — the second paper was signed twice "
    + "over just to get this far",
    secondActive?.constraint === "directory_exclusions_one_live",
    { constraint: secondActive?.constraint, message: secondActive?.message });
  await fails("and one signature buys one paper",
    `insert into directory_exclusions (tenant_id, ref, subject_kind, subject_id, subject_name,
       subject_label, subject_tenant_id, company_name, reason_code, reason, note, days, status,
       raised_by, approval_id)
     values ($1,$2,'company',$3,'x','y','00000000-0000-0000-0000-000000000000','z','complaint',$4,$5,
       5,'pending_signature',$6,$7)`,
    [TC, await nextRef(), LB, REASON, NOTE, uC1, signed], "directory_exclusions_one_approval");

  // ---------------- 4 · what a hold touches ----------------
  phase("4 · the card the hold puts down, and the handover it stops");
  await oi(`update directory_listings set status = 'suspended', held_by_exclusion = true,
                  suspension_reason = $2 where id = $1`, [LA, NOTE]);
  const stillDown = await one(`select status, held_by_exclusion from directory_listings where id = $1`,
    [LA]);
  check("a card may be put down while a paper runs on it — that is what the hold is for",
    stillDown?.status === "suspended" && stillDown?.held_by_exclusion === true, stillDown);
  await fails("…and it cannot be brought back while the paper runs",
    `update directory_listings set status = 'live', held_by_exclusion = false where id = $1`,
    [LA], "lift the exclusion first");
  await fails("…nor verified",
    `update directory_listings set is_verified = true, status = 'live' where id = $1`,
    [LA], "lift the exclusion first");
  const reinstate = await call("the moderation door answers a held card with the paper's own number",
    `select platform_auth.moderate_listing($1,$2,'reinstate',$3) as r`, [LA, uC1, NOTE]);
  check("…as a status, not as the trigger's exception, so the desk reads a sentence and not a 500",
    reinstate?.status === "held" && reinstate?.ref === running?.ref
    && /Lift the exclusion first/.test(String(reinstate?.reason)), reinstate);
  const heldVerdict = await call("the register can be asked whether a subject is held",
    `select platform_auth.directory_subject_is_held('company',$1) as r`, [LA]);
  check("…and answers the paper, its window and who it is about",
    heldVerdict?.ref === running?.ref && !!heldVerdict?.ends_at
    && heldVerdict?.subject_name === NAME("Carrier"), heldVerdict);
  const notHeld = await one(`select platform_auth.directory_subject_is_held('company',$1) as r`, [LB]);
  check("…and answers null, not an empty object, for a card nothing runs against",
    notHeld?.r === null, notHeld);

  const flagWithNoPaper = await fails("the flag cannot be raised on a card with no paper behind it",
    `update directory_listings set held_by_exclusion = true where id = $1`,
    [LB], "no live exclusion holds");
  check(`…by the naming trigger, so ${RULES["a card only flags a hold it is suspended under"]}`
    + " underneath it is a belt and not the buckle — the desk meets the sentence first",
    flagWithNoPaper?.constraint
    !== RULES["a card only flags a hold it is suspended under"],
    { fired: flagWithNoPaper?.constraint, belt: RULES["a card only flags a hold it is suspended under"] });

  const vPaper = await draftOf("a paper on a plate", "vehicle", vessel);
  check("the plate is named as itself — a plate, not the VIN",
    vPaper?.subject_label?.includes?.("GATE") && vPaper?.company_name === NAME("Carrier"), vPaper);
  const vsig = randomUUID();
  await signPaper(vsig, vPaper?.id, uC1, uC2);
  const vRun = (await okDo("and runs",
    `update directory_exclusions set status = 'active', approval_id = $2, starts_at = now(),
            ends_at = now() + interval '14 days', activated_by = $3, activated_at = now()
      where id = $1 returning id, ref`, [vPaper?.id, vsig, uC2]))[0];
  check("…which is a paper running on a plate, so the handover guard below is answering a live hold",
    !!vRun?.id && !!vRun?.ref, vRun);
  await fails("no new handover opens on a held plate",
    `insert into vessel_assignments (tenant_id, vessel_id, driver_id, status, assigned_by)
     values ($1,$2,$3,'active',$4)`, [TA, vessel, driver, uC1], "no new handover can be opened on it");
  const endedOk = await okDo("but ending or editing an old handover is not blocked by a hold "
    + "raised after it",
    `insert into vessel_assignments (tenant_id, vessel_id, driver_id, status, started_at, ended_at,
       assigned_by)
     values ($1,$2,$3,'ended', now() - interval '30 days', now() - interval '2 days',$4)
     returning id`, [TA, vessel, driver, uC1]);
  check("…the row lands, which is the whole difference between stopping a handover and "
    + "impounding a vehicle", !!endedOk[0]?.id, endedOk);
  check("…and the plate hold changed nothing on the board, because a plate is not a card",
    (await one(`select count(*)::int as n from directory_exclusions
                  where subject_kind = 'vehicle' and listing_id is not null`))?.n === 0);

  const dPaper = await draftOf("a paper on a driver", "driver", driver);
  check("the driver is named by class and status, and the register's label holds neither the NIDA "
    + "number nor the phone",
    /CE · available/.test(String(dPaper?.subject_label))
    && !String(dPaper?.subject_label).includes(`nid`) && !String(dPaper?.subject_name).includes("nid"),
    dPaper);

  // ---------------- 5 · what the doors promise ----------------
  phase("5 · the doors' own promises, read out of the live catalog");
  const DOORS = ["rate_directory_company", "reply_to_rating", "withdraw_rating", "edit_rating",
    "moderate_rating", "directory_rating_summary", "directory_ratings_for",
    "directory_ratings_board", "raise_directory_exclusion", "propose_directory_exclusion",
    "apply_directory_exclusion", "refuse_directory_exclusion", "lift_directory_exclusion",
    "directory_exclusions_board", "directory_exclusion_detail", "directory_subject_is_held",
    "moderate_listing"];
  const BODIES = ["rating_names_a_real_job", "rating_is_kept_not_rewritten",
    "exclusion_names_its_subject", "exclusion_needs_two_seats", "exclusion_window_is_kept",
    "held_listing_stays_down", "assignment_refuses_a_held_subject"];
  const fns = await oi(`select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig,','),'') as cfg,
      coalesce(p.proargnames, '{}') as args, pg_get_functiondef(p.oid) as def,
      (p.proacl is null) as unlisted,
      coalesce(string_agg(distinct lower(a.grantee::regrole::text), ','), '') as grantees
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join lateral aclexplode(p.proacl) a on true
    where n.nspname = 'platform_auth' and p.proname = any($1::text[])
    group by p.oid, p.proname, p.prosecdef, p.proconfig, p.proargnames, p.proacl
    order by p.proname`, [[...DOORS, ...BODIES]]);
  check(`all ${DOORS.length + BODIES.length} of 131's functions are in the catalog`,
    fns.rowCount === DOORS.length + BODIES.length,
    fns.rows.map((r: any) => r.proname));
  const byName = Object.fromEntries(fns.rows.map((r: any) => [r.proname, r]));
  check("every door is SECURITY DEFINER with a pinned search_path",
    DOORS.every((d) => byName[d]?.prosecdef === true && /search_path=public/.test(byName[d]?.cfg)),
    DOORS.filter((d) => !byName[d]?.prosecdef || !/search_path=public/.test(byName[d]?.cfg ?? "")));
  check("…and none of them is left open to PUBLIC — a drop-and-create would have reset exactly this",
    fns.rows.every((r: any) => !r.unlisted && !String(r.grantees).split(",").includes("public")),
    fns.rows.map((r: any) => [r.proname, r.grantees]));
  check("…while the seven trigger bodies are not definers, because a trigger must read the "
    + "subject under the rights of the write that fired it",
    BODIES.every((b) => byName[b]?.prosecdef === false && /search_path=public/.test(byName[b]?.cfg)),
    BODIES.filter((b) => byName[b]?.prosecdef !== false));

  const raterArgs: string[] = byName.rate_directory_company?.args ?? [];
  check("the door that writes a mark takes no card, no tenant and no rater kind — the target is "
    + "derived from the proof or the mark does not land",
    !raterArgs.some((a) => /listing|listed|target|kind/i.test(a)), raterArgs);
  const applyArgs: string[] = byName.apply_directory_exclusion?.args ?? [];
  check("the door that spends a signature takes no window either",
    !applyArgs.some((a) => /day/i.test(a)), applyArgs);
  check("…and it replays the days out of the payload that was signed, and refuses when the paper "
    + "has moved under the signature",
    /\(v_a\.payload->>'days'\)::int/.test(String(byName.apply_directory_exclusion?.def ?? ""))
    && /if v_days is distinct from v_e\.days then/
      .test(String(byName.apply_directory_exclusion?.def ?? "")),
    String(byName.apply_directory_exclusion?.def).match(/payload->>'days'.{0,90}/s)?.[0]);
  const proposeDef = String(byName.propose_directory_exclusion?.def ?? "");
  check("the signature is asked for on what the register read, and the bytes are hashed in SQL",
    /encode\(extensions\.digest\(/.test(code)
    && /v_sha := encode\(extensions\.digest\(v_payload::text, 'sha256'\), 'hex'\)/.test(proposeDef)
    && /'days', v_e\.days/.test(proposeDef), proposeDef.match(/v_sha :=.{0,90}/s)?.[0]);
  check("…the payload carries the subject, the sentence and the window, so the apply is a replay "
    + "and not a second decision",
    ["subject_kind", "subject_id", "company_tenant_id", "listing_id", "reason_code", "reason",
      "note", "days"].every((k) => proposeDef.includes(`'${k}'`)),
    ["subject_kind", "days"].map((k) => proposeDef.includes(`'${k}'`)));

  const refuseDef = String(byName.refuse_directory_exclusion?.def ?? "");
  check("121's two-seat rule is a CHECK on the signature row, and 131's refuse door is allowed to "
    + "be the proposing seat — so a refusal by the author closes the signature undecided",
    /then 'lapsed' else 'rejected' end/.test(refuseDef)
    && /case when a\.proposed_by = p_actor_user_id then 'lapsed'/.test(refuseDef),
    refuseDef.match(/set status = case.{0,120}/s)?.[0]);
  check("…every column that names a decider is written only when the hands differ, which is the "
    + "only way past `decided_by <> proposed_by`",
    (refuseDef.match(/p_actor_user_id/g) ?? []).length >= 6
    && /decided_by\s+= case when a\.proposed_by <> p_actor_user_id then p_actor_user_id end/
      .test(refuseDef.replace(/\s+/g, " "))
    || /decided_by   = case when a\.proposed_by <> p_actor_user_id then p_actor_user_id end/.test(refuseDef),
    refuseDef.match(/decided_by.{0,120}/s)?.[0]);
  const twoSeatName = RULES["the seat that decides a paper is not the seat that raised it"];
  const twoSeat = (await one(`select lower(pg_get_constraintdef(oid)) as def from pg_constraint
    where conname = $1`, [twoSeatName]))?.def ?? "";
  check(`…and ${twoSeatName} is live, so the branch is provably needed rather than tidy`,
    /decided_by <> proposed_by/.test(twoSeat), twoSeat);
  const liftDef = String(byName.lift_directory_exclusion?.def ?? "");
  check("pressing lift twice answers `already` before it writes, so the first lift's hand and "
    + "hour survive the second press",
    /if v_e\.status = 'lifted'/.test(liftDef)
    && liftDef.indexOf("'already', true") < liftDef.indexOf("insert into audit_logs"),
    liftDef.match(/status = 'lifted'.{0,140}/s)?.[0]);
  check("no door deletes a mark — the office takes one off the board and the row stays",
    !/delete from directory_ratings/i.test(code) && !/delete from directory_exclusions/i.test(code),
    (code.match(/delete from directory_\w+/gi) ?? []));
  check("the marks reader runs 061's claim check, and the route that calls it opens a tenant "
    + "transaction first — outside one the check answers false for everybody",
    /directory_claim_ok/.test(String(byName.directory_ratings_for?.def ?? ""))
    || /directory_claim_ok/.test(await one(`select pg_get_functiondef(p.oid) as def from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'directory_ratings_for'`)
      .then((r: any) => r?.def ?? ""))
    && /withTenant\(req\.user\.tid/.test(portalSrc)
    && /directory_ratings_for/.test(portalSrc), portalSrc.match(/.{0,60}directory_ratings_for.{0,40}/s)?.[0]);

  // ---------------- 6 · who can reach it ----------------
  phase("6 · the reach of every role but the owner's");
  const reach = await one(`select
      has_table_privilege('app_runtime','directory_ratings','select') as read,
      has_table_privilege('app_runtime','directory_ratings','insert') as ins,
      has_table_privilege('app_runtime','directory_ratings','update') as upd,
      has_table_privilege('app_runtime','directory_ratings','delete') as del,
      has_table_privilege('app_runtime','directory_exclusions','select') as hread,
      has_table_privilege('app_runtime','directory_exclusions','insert') as hins,
      has_table_privilege('app_runtime','directory_exclusions','delete') as hdel,
      has_table_privilege('anon','directory_ratings','select') as anon_read,
      has_table_privilege('authenticated','directory_exclusions','select') as auth_read,
      has_table_privilege('service_role','directory_ratings','select') as svc_read,
      has_table_privilege('app_runtime','platform_approvals','select') as appr_read,
      has_table_privilege('anon','platform_approvals','select') as anon_appr,
      has_sequence_privilege('app_runtime','directory_exclusion_number_seq','usage') as burns,
      has_sequence_privilege('anon','directory_exclusion_number_seq','usage') as anon_burns`);
  check("the API's role can read both registers and write neither — every mark and every paper is "
    + "written by a definer that names the actor",
    reach?.read && reach?.hread && !reach?.ins && !reach?.upd && !reach?.del && !reach?.hins
    && !reach?.hdel, JSON.stringify(reach));
  check("…no client role can read either register", !reach?.anon_read && !reach?.auth_read
    && !reach?.svc_read, JSON.stringify(reach));
  check("…and the signature register is reachable only through a definer, as 121 left it",
    !reach?.appr_read && !reach?.anon_appr, JSON.stringify(reach));
  check("…while the paper number is granted to the runtime role, which can burn a gap but cannot "
    + "mint a paper — no client role holds even that",
    reach?.burns && !reach?.anon_burns, JSON.stringify(reach));
  const trig = await oi(`select t.tgname, p.proname as body,
      p.proname = 'set_updated_at' as stamps,
      position('delete from' in lower(p.prosrc)) > 0 as deletes
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and c.relname = any($1::text[]) order by 1`,
    [["directory_ratings", "directory_exclusions"]]);
  const RULE_TRIGGERS = ["exclusion_names_its_subject", "exclusion_needs_two_seats",
    "exclusion_window_is_kept", "rating_is_kept_not_rewritten", "rating_names_a_real_job"];
  check("both registers carry exactly the two updated_at stamps and the five rule bodies, and "
    + "nothing that could delete a row — a mark hidden and a paper lifted are still there to be "
    + "answered",
    same(trig.rows.map((r: any) => r.body).sort(), [...RULE_TRIGGERS, "set_updated_at", "set_updated_at"])
    && trig.rows.every((r: any) => !r.deletes),
    trig.rows.map((r: any) => [r.tgname, r.body, r.deletes]));
  const doorsReach = await one(`select
      has_function_privilege('app_runtime','platform_auth.rate_directory_company(uuid,uuid,int,text,uuid,text,text)','execute') as mark,
      has_function_privilege('app_runtime','platform_auth.apply_directory_exclusion(uuid,uuid,text,text)','execute') as apply,
      has_function_privilege('app_runtime','platform_auth.moderate_listing(uuid,uuid,text,text)','execute') as mod,
      has_function_privilege('anon','platform_auth.directory_exclusions_board(text,text,text,int,int)','execute') as anon_board,
      has_function_privilege('authenticated','platform_auth.raise_directory_exclusion(text,uuid,text,text,text,int,uuid,text,text,text)','execute') as auth_raise,
      has_function_privilege('service_role','platform_auth.rate_directory_company(uuid,uuid,int,text,uuid,text,text)','execute') as svc_mark,
      has_function_privilege('public','platform_auth.refuse_directory_exclusion(uuid,text,uuid,text,text,text)','execute') as pub_refuse,
      has_function_privilege('app_runtime','platform_auth.exclusion_needs_two_seats()','execute') as call_two_seat,
      has_function_privilege('app_runtime','platform_auth.held_listing_stays_down()','execute') as call_hold`);
  check("the doors the routes call are open to the role the API runs as",
    doorsReach?.mark && doorsReach?.apply && doorsReach?.mod, JSON.stringify(doorsReach));
  check("…and no browser role, and not even PUBLIC, can raise, refuse or read a hold",
    !doorsReach?.anon_board && !doorsReach?.auth_raise && !doorsReach?.svc_mark
    && !doorsReach?.pub_refuse, JSON.stringify(doorsReach));
  check("…while a trigger body cannot be called by hand: the desk cannot fire its own two-seat "
    + "rule or clear its own hold flag",
    !doorsReach?.call_two_seat && !doorsReach?.call_hold, JSON.stringify(doorsReach));
  // The owner's own EXECUTE is real and belongs there — it is how the platform role that runs the
  // migration can still moderate a card. What must not survive 061's door being replaced is a
  // browser role, or PUBLIC, or the runtime privilege being dropped with the old ACL.
  check("061's moderate_listing survived the replace with its grant list intact — the runtime role "
    + "and the owner, and nobody else",
    same(String(byName.moderate_listing?.grantees ?? "").split(",").filter(Boolean).sort(),
      ["app_runtime", "postgres"]), byName.moderate_listing?.grantees);

  const duties = await oi(`select r.key as role, rp.permission_key as duty, r.tenant_id
    from role_permissions rp join roles r on r.id = rp.role_id
    where rp.permission_key in ('control.directory.view','control.directory.moderate',
                                'control.directory.exclusion') order by 1,2`);
  const only = (k: string) => duties.rows.filter((r: any) => r.duty === k).map((r: any) => r.role);
  check("the exclusion duty — the hand that puts a company off the board — sits with the "
    + "compliance desk alone",
    same(only("control.directory.exclusion"), ["compliance_officer"]),
    only("control.directory.exclusion"));
  check("the moderation duty adds the two seats that already moved money and passes, and no more",
    same(only("control.directory.moderate").sort(), ["billing_admin", "compliance_officer", "super_admin"]),
    only("control.directory.moderate"));
  check("the read is wide, because a register a desk cannot read is a register it cannot answer for",
    only("control.directory.view").length === 6 && only("control.directory.view").includes("customer_service_agent"),
    only("control.directory.view"));
  check("…and none of it can be granted to a company's own duty profile",
    duties.rows.every((r: any) => r.tenant_id === null), JSON.stringify(duties.rows));
  check("…and signing a hold costs the approval duty 121 already minted, not a fourth key",
    (await one(`select count(*)::int as n from permissions where key like 'control.directory.%'`))?.n === 3
    && !!await one(`select key from permissions where key = 'control.approvals.decide'`),
    await oi(`select key from permissions where key like 'control.directory.%' order by 1`));

  // Anchored on the word, not the letter run: `listing_id` carries "tin" inside it and is not a TIN.
  const pii = await one(`select string_agg(c.table_name || '.' || c.column_name, ',') as cols
    from information_schema.columns c
    where c.table_name in ('directory_ratings','directory_exclusions')
      and c.column_name ~ '(^|_)(nida|phone|password|otp|secret|tin|brla|token|cost|amount)($|_)'`);
  check("neither register holds a sealed number, a credential or a figure",
    !pii?.cols, pii?.cols);

  // ---------------- 7 · the readers run ----------------
  phase("7 · the readers, executed");
  const summary = await call("the card's summary counts what is on it",
    `select platform_auth.directory_rating_summary($1) as r`, [LA]);
  check("…with the buckets the board filters on and the two audiences kept apart",
    ["marks", "mean", "one", "two", "three", "four", "five", "answered", "from_seekers",
      "from_companies"].every((k) => k in (summary ?? {})), Object.keys(summary ?? {}));
  const rBoard = await call("the marks register reads",
    `select platform_auth.directory_ratings_board('all', null, 5, 0) as r`);
  check("…rows and counts together, in the shape the desk renders",
    Array.isArray(rBoard?.rows) && !!rBoard?.counts, Object.keys(rBoard ?? {}));
  const hBoard = await call("the holds register reads",
    `select platform_auth.directory_exclusions_board('live', 'company', null, 5, 0) as r`);
  check("…and the running company hold this gate forged is on it",
    (hBoard?.rows ?? []).some((x: any) => x.id === running?.id), hBoard?.rows?.length);
  const detail = await call("one paper reads whole",
    `select platform_auth.directory_exclusion_detail($1) as r`, [paper?.id]);
  check("…with its signature, its card and its marks beside it",
    detail?.exclusion?.status === "active" && detail?.approval?.status === "applied"
    && detail?.card?.status === "suspended", Object.keys(detail ?? {}));
  const detailStr = JSON.stringify(detail ?? {});
  check("…and the whole read carries no tenant id of the company's own — the office's register is "
    + "not a way to enumerate accounts",
    !/"tenant_id"/.test(detailStr), detailStr.slice(0, 200));

  // ---------------- 8 · nothing of this gate survives ----------------
  await owner.query("rollback");
  phase("8 · residue");
  const left = await oi(`select
      (select count(*)::int from tenants where name like 'Hold Gate %') as accounts,
      (select count(*)::int from users where email like '%.${STAMP}@waisha.test') as seats,
      (select count(*)::int from directory_listings where company_name like 'Hold Gate %') as cards,
      (select count(*)::int from directory_ratings where listed_name like 'Hold Gate %') as marks,
      (select count(*)::int from directory_exclusions where company_name like 'Hold Gate %') as papers,
      (select count(*)::int from directory_exclusions) as register,
      (select count(*)::int from platform_approvals where reason = $1) as signatures,
      (select count(*)::int from vessel_assignments where assigned_by in
        (select id from users where email like '%.${STAMP}@waisha.test')) as handovers`,
    [SENT]);
  const l = left.rows[0];
  check("no account, seat, card, mark, paper, signature or handover of this gate is left in the "
    + "database",
    Object.entries(l).every(([k, v]) => k === "register" || Number(v) === 0) && Number(l.register) === 0,
    JSON.stringify(l));
  await owner.end();

  if (failures) {
    console.log(`\n${failures} FAILED of ${failures + proved}`);
    process.exit(1);
  }
  console.log(`\n131's mark and exclusion hold: ${proved} things proved, and the rehearsal left no trace.`);
}

function COMMENT_SENT() {
  return "Two boxes handed over at the depot with the seals intact.";
}

main().catch((e) => { console.error(e); process.exit(1); });
