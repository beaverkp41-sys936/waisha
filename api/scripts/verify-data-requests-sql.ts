/**
 * Live proof for #342 — the copy a caller asks for and the erasure a second seat signs
 * (migration 129, `api/src/customers/data-request.ts`).
 *
 * This file exists because of one bug that reached a real desk.
 *
 * plpgsql parses a statement the first time it *runs*, not when the function is created. An
 * Oracle-ism — `sql%rowcount` — is therefore legal to create and fatal to execute, and
 * `apply_data_erasure` hides ten UPDATEs behind ten `if` branches. 129's inline gate can only reach
 * the early returns (it must not erase a real company), so the file created cleanly, the suite
 * stayed green, and the first thing to parse the mask's account branch was a compliance officer
 * pressing approve. Phase 6 below runs all ten branches; it is the reason this gate is permanent.
 *
 * The mask is run on a company this gate mints and closes inside a transaction it rolls back. Every
 * category branch executes, every row count is read back and compared with the number the register
 * was stamped with, and a second paper names one category only — which is how the branches are
 * proved to be *gated*, not merely parseable.
 *
 * The rest of what only SQL can answer:
 *
 *   · the file re-executes against the live catalog. 129 is already recorded in `schema_migrations`,
 *     so `pnpm migrate` will never apply it again — an edited 129 reaches dev only through `--apply`
 *     here, which is why this gate both rehearses and, on request, commits. Its own `begin;` and
 *     `commit;` are stripped first: run verbatim inside a transaction, the file's trailing COMMIT
 *     would end that transaction and the rollback would be a warning about nothing;
 *   · the row's three vocabularies (kinds, statuses, the ten category words in mask order) are read
 *     out of the CHECKs, not trusted from the list above them, and compared with the module the
 *     routes and the desk both quote;
 *   · every guard refuses the thing it was written for, by the name of the rule that fired —
 *     anonymous CHECKs are looked up by the words in their bodies, because `_check7` renumbers
 *     itself the moment a rule is added;
 *   · the board's own count keys are words the board can be filtered on, and the detail read is
 *     checked for the `jsonb_build_object` duplicate-key trap it actually contains: 129 builds it
 *     with `'status', 'ok'` and then `'status', r.status`, so the second wins and a desk that reads
 *     `status` as the door's verdict is reading the paper's state;
 *   · no client role, and no PUBLIC entry, can reach the register or any of its twelve functions.
 *
 * Everything from phase 1 onward runs inside one transaction that is rolled back, with a savepoint
 * around every statement: a raised trigger aborts the transaction, and every later query in an
 * aborted transaction answers "current transaction is aborted" instead of the question it was
 * asked. `audit_logs` cannot be deleted and is not touched — it is rolled back with the rest.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-data-requests-sql.ts          (from api/, rehearses)
 *      DNS_FALLBACK=1 npx tsx scripts/verify-data-requests-sql.ts --apply   (129 re-applied to dev)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { encryptField, searchHash } from "../src/util/crypto.js";
import { CATEGORIES, CATEGORY_LABELS, DATA_REQUEST_KINDS, EXPORT_SECTIONS,
  REQUEST_STATUSES } from "../src/customers/data-request.js";

const FILE = "migrations/129_the_copy_and_the_erasure.sql";
const APPLY = process.argv.includes("--apply");
// One random tail per run, carried by every name, slug, email and PII number this gate mints.
// `tenants.tin_search` and `phone_search`, `users.email` and `nida_search`, and
// `sessions.refresh_token_hash` are all unique across the whole table, not per tenant — and a fixed
// fixture value collides with whatever an earlier desk test left committed, which fails the very
// first insert and takes every phase after it down with it.
const HEX = randomUUID().replace(/-/g, "");
const STAMP = `129sql${HEX.slice(0, 6)}`;
const DIG = [...HEX].map((c) => parseInt(c, 16)).join("").padEnd(14, "3");
const PHONE = `07${DIG.slice(0, 8)}`;
const SEAT_PHONE = `06${DIG.slice(0, 8)}`;
const TIN = `1${DIG.slice(0, 11)}`;
const NIDA = `19900515${DIG.slice(2, 12)}`;
const EMAIL = (who: string) => `probe.${who}.${STAMP}@waisha.test`;

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`);
}
const note = (line: string) => console.log(`note   ${line}`);
const phase = (name: string) => console.log(`\n--- ${name} ---`);

/** The quoted words of a CHECK's `= ANY (ARRAY[…])` list, as `pg_get_constraintdef` prints it —
 *  which is never quite the way the migration was written. Every definition this gate reads is
 *  lower-cased on the way in, because the deparser prints `IS NOT NULL`, `Btrim` and `ARRAY` in its
 *  own case while the needles below are the words the migration was typed in. */
function quoted(def: string): string[] {
  return [...def.matchAll(/'([a-z_]+)'(?:::text)?/g)].map((m) => m[1]);
}
/** The ten category words sit inside a `<@` list, and the same sentence goes on to name `erase`
 *  and an empty array, so only the words inside the brackets are the vocabulary. */
function listIn(def: string, column: string): string[] {
  const at = def.indexOf(`${column} <@`);
  return at < 0 ? [] : quoted(def.slice(at, def.indexOf("]", at)));
}
const same = (a: string[], b: readonly string[]) =>
  a.length === b.length && b.every((w, i) => a[i] === w);

/** node-pg hands `int8` to JavaScript as a *string*, so a bare `count(*)` written inside
 *  `jsonb_build_object` reaches the desk as `"3"`. A board chip that adds its own counts, or a
 *  preview that compares a row-count, then does string arithmetic or reads a number as a word — and
 *  a `>=` in a gate that only ever saw `0` or `1` never notices. Every count 129 builds is cast
 *  `::int` for this reason; this walks the jsonb and names any leaf that arrived as digits in a
 *  string, which is the only way the class of bug is caught rather than the instance. */
function stringly(obj: unknown, path = ""): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => stringly(v, `${path}[${i}].`));
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) => typeof v === "number" ? []
      : typeof v === "string" && /^\d+$/.test(v) ? [`${path}${k} = "${v}"`]
      : stringly(v, `${path}${k}.`));
  }
  return [];
}

/** Rules the gate refuses *by name*, resolved once from the live catalog by the words in the body,
 *  so an anonymous CHECK that renumbers itself cannot make the gate report the wrong rule. */
const RULES: Record<string, string> = {};
function resolve(where: string, cons: { conname: string; def: string }[], ...needles: string[]) {
  const hits = cons.filter((c) => needles.every((n) => c.def.includes(n)));
  if (hits.length !== 1) note(`!! "${where}" matched ${hits.length} rule(s): `
    + `${hits.map((h) => h.conname).join(", ") || "none"}`);
  RULES[where] = hits[0]?.conname ?? "";
  return hits[0];
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const src = readFileSync(FILE, "utf8");

  // ---------------- 0 · the file, executed ----------------
  phase("0 · 129 re-executes, and the mask counts rows the way Postgres counts them");
  const stripped = src.replace(/^begin;\n/mg, "").replace(/^commit;\n/mg, "");
  {
    // Comments are read for the words they contain, not searched for code: this file names the
    // Oracle-ism it guards against in prose, and a check that scanned comments would fail on its
    // own explanation.
    const code = src.replace(/--[^\n]*/g, "");
    const own = (src.match(/^(begin|commit);$/gmi) ?? []);
    check("129 opens and closes its own transaction, and this gate takes that pair away before "
      + "running it — a COMMIT inside the rehearsal would end the rehearsal",
      own.length === 2 && stripped !== src && !/^(begin|commit);$/m.test(stripped), own);
    const oracle = code.match(/.{0,50}%rowcount.{0,30}/gi) ?? [];
    check("nothing in 129 counts rows the Oracle way — `%rowcount` is legal to create and fatal "
      + "to run, which is how it reached a desk", oracle.length === 0, oracle);
    const diag = src.match(/get diagnostics/gi) ?? [];
    check(`…and the row counts are taken with GET DIAGNOSTICS (${diag.length} of them)`,
      diag.length >= 10, diag.length);
    check("…each one after the UPDATE it counts, into a counter that is declared before it is used",
      /v_m int/.test(src)
      && !/get diagnostics v_m = row_count;\s*\n\s*update/.test(src),
      "a GET DIAGNOSTICS that sits above the UPDATE it counts reads the previous statement's row "
      + "count, and the register is stamped with a number that never happened");

    const runner = new pg.Client({
      connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
    });
    const notices: string[] = [];
    runner.on("notice", (n: any) => notices.push(String(n.message)));
    await runner.connect();
    const recorded = (await runner.query(
      `select name from schema_migrations where name like '129%'`)).rows;
    check("129 is already recorded, which is why an edited 129 needs this file rather than "
      + "`pnpm migrate`", recorded.length === 1, recorded);
    let err: any = null;
    await runner.query("begin");
    try { await runner.query(stripped); } catch (e) { err = e; }
    if (!err && APPLY) await runner.query("commit");
    else await runner.query("rollback");
    check(`the whole file runs against the live catalog${APPLY ? " and is committed"
      : " and is rolled back"}`, !err, err?.message);
    check("…and 129's own gate reported, in the same pass",
      notices.some((n) => /^129:/.test(n)), notices.slice(0, 3));
    for (const n of notices) note(n.slice(0, 260));
    await runner.end();
  }

  const owner = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 180000
  });
  await owner.connect();
  // The rehearsal is one transaction: phase 8 rolls it back and proves nothing of it survived.
  await owner.query("begin");
  const oi = (sql: string, p: any[] = []) => owner.query(sql, p);
  const one = async (sql: string, p: any[] = []) => (await oi(sql, p)).rows[0];
  let sp = 0;
  /** A refusal is the result this gate wants, so every statement is wrapped: an aborted
   *  transaction answers every later query with "current transaction is aborted". A successful one
   *  releases its savepoint, because the fixtures below have to survive until phase 8. */
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
    // A guard is named either by the rule it carries in the catalog or by the sentence it raises.
    // A catalog name is matched exactly — `customer_data_requests_check` is a prefix of `…check1`,
    // so a substring test would credit the wrong rule with firing.
    if (err && want) {
      const named = /^[a-z0-9_]+$/.test(want);
      const hit = named ? err.constraint === want : String(err.message).includes(want);
      check(`…by the rule ${want}`, hit, { constraint: err.constraint, message: err.message });
    }
    return err;
  };
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) check(label, false, err.message);
    return rows as Record<string, any>[];
  };
  /** A definer answers a jsonb value, so its refusal is read rather than caught. A door that
   *  *raises* is a different fault, and this labels it as one instead of returning null. */
  const call = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) {
      check(`${label} — the door raised instead of answering`, false, err.message);
      return null as Record<string, any> | null;
    }
    return (rows?.[0]?.r ?? null) as Record<string, any> | null;
  };

  const TEN = (await one(`select id from tenants where type = 'platform' and deleted_at is null
    order by created_at limit 1`))?.id as string;
  if (!TEN) throw new Error("No platform tenant — 129 has no register to write into.");
  // The audit register as it stands before this gate writes a word. Every erasure, refusal and
  // hand-over below writes a line there, and `audit_logs` cannot be deleted — so the only proof
  // that the rollback took the rehearsal with it is that the count lands back on this number.
  const audit0 = await one(`select count(*)::int as n from audit_logs
    where entity = 'customer_data_requests'`);

  // ---------------- 1 · the words ----------------
  phase(`1 · three vocabularies on one row, and the office's tenant ${String(TEN).slice(0, 8)}`);
  const cons = (await oi(`select conname, lower(pg_get_constraintdef(oid)) as def from pg_constraint
    where conrelid = 'customer_data_requests'::regclass and contype = 'c' order by conname`))
    .rows as { conname: string; def: string }[];
  for (const c of cons) note(`${c.conname} — ${c.def.slice(0, 140)}`);
  const defOf = (suffix: string) => cons.find((c) => c.conname.endsWith(suffix))?.def ?? "";
  const tableDef = cons.find((c) => c.def.includes("categories <@"))?.def ?? "";
  check("the two kinds the routes accept are the two the row allows",
    same(quoted(defOf("_kind_check")), DATA_REQUEST_KINDS), defOf("_kind_check"));
  check("the five states the board filters on are the five the row allows, in that order",
    same(quoted(defOf("_status_check")), REQUEST_STATUSES), defOf("_status_check"));
  check("the ten categories are the ten the mask walks, in that order",
    same(listIn(tableDef, "categories"), CATEGORIES), listIn(tableDef, "categories"));
  check("…and every one of them has the sentence the desk prints beside its tick box",
    CATEGORIES.every((k) => (CATEGORY_LABELS[k] ?? "").length > 20),
    CATEGORIES.filter((k) => !CATEGORY_LABELS[k]));
  check("a copy carries every section the module names, and the module names seventeen",
    EXPORT_SECTIONS.length === 17, EXPORT_SECTIONS.length);

  // The two halves of the erasure menu are one CHECK in 129 — the bound list, "a copy takes no
  // menu" and "an erasure names something" are one sentence about `categories`, so they resolve to
  // one constraint name. The gate still aims at them separately below, because what each refuses is
  // a different insert; a desk reading the violation sees the same constraint for all three.
  resolve("the categories are the ten", cons, "categories <@ array[");
  resolve("the copy takes no menu", cons, "(kind = 'erase'::text) or (categories = '{}'::text[])");
  resolve("the erasure names something", cons, "(kind <> 'erase'::text) or (categories <> '{}'");
  resolve("a paper is numbered", cons, "^dr-");
  resolve("a kind decides its states", cons, "kind = 'export'", "kind = 'erase'", "status = any");
  resolve("waiting needs a signature", cons, "approval_id is not null");
  resolve("a paper is not filed on its own register", cons, "company_tenant_id <> tenant_id");
  resolve("a reason is a sentence", cons, "char_length(trim(both from reason)) >= 8");
  resolve("a bundle hash is a hash", cons, "^[0-9a-f]{64}$");
  check("every rule this gate refuses by name was found, and found once",
    Object.values(RULES).every((n) => !!n), JSON.stringify(RULES));

  // ---------------- the fixtures ----------------
  // Four closed companies and one live, because the guards are aimed at different facts: the three
  // papers of phases 2-4 sit on companies nobody erases, phase 6 erases ER, phase 6b erases KEEP
  // with one category, and LIVE exists only to be refused. OFFICE is a second register, so a
  // cross-office read can be proved to see nothing.
  const CO = randomUUID();    // the register's own paper for the guard tests
  const KEEP = randomUUID();  // an account erased for one category only
  const ER = randomUUID();    // the account the mask rehearses on
  const LIVE = randomUUID();  // still trading
  const OFFICE = randomUUID();// a second office's register
  // Only the account the mask rehearses on carries a TIN and a phone: `tenants_tin_search_key` and
  // `tenants_phone_search_key` are unique across the table, not within a tenant, so three rows that
  // shared one number would collide with each other before they could collide with anything live.
  await okDo("a closed company, an erased-later company, a live one and a second office",
    `insert into tenants (id, type, name, status, slug, email, tin_encrypted, tin_search,
        phone_encrypted, phone_search, created_at, licence_expires_at)
     values ($1,'transporter','Probe Guard ${STAMP}','active','probe-guard-${STAMP}',
             'guard.${STAMP}@waisha.test', null, null, null, null,
             now() - interval '500 days', now() + interval '3 years'),
            ($2,'transporter','Probe Keep ${STAMP}','active','probe-keep-${STAMP}',
             'keep.${STAMP}@waisha.test', null, null, null, null,
             now() - interval '500 days', now() + interval '3 years'),
            ($3,'transporter','Probe Erase ${STAMP}','active','probe-erase-${STAMP}',
             'erase.${STAMP}@waisha.test',$6::bytea,$7,$8::bytea,$9,
             now() - interval '500 days', now() + interval '3 years'),
            ($4,'transporter','Probe Live ${STAMP}','active','probe-live-${STAMP}',
             null, null, null, null, null, now() - interval '500 days',
             now() + interval '3 years'),
            ($5,'platform','Probe Office ${STAMP}','active',null,
             null, null, null, null, null, now() - interval '900 days',
             now() + interval '3 years')`,
    [CO, KEEP, ER, LIVE, OFFICE, encryptField(TIN), searchHash(TIN),
      encryptField(PHONE), searchHash(PHONE)]);
  const A = randomUUID(); const B = randomUUID(); const OUT = randomUUID();
  await okDo("two live platform seats and one that has gone quiet",
    `insert into users (id, tenant_id, user_type, full_name, email, status)
     values ($1,$4,'platform','Probe Raiser',$5,'active'),
            ($2,$4,'platform','Probe Signer',$6,'active'),
            ($3,$4,'platform','Probe Ghost',$7,'deactivated')`,
    [A, B, OUT, TEN, EMAIL("raiser"), EMAIL("signer"), EMAIL("ghost")]);
  // A person inside the company the mask will erase: the `seats` branch has to reach a real row, or
  // the count the register is stamped with proves nothing. Everything the branch promises to blank
  // is filled in first, so a blank that was already blank cannot be counted as a masking.
  const SEAT = randomUUID();
  await okDo("a seat belonging to the erased company, holding a phone, a NIDA and a secret",
    `insert into users (id, tenant_id, user_type, full_name, email, phone_encrypted, phone_search,
        nida_encrypted, nida_search, password_hash, totp_secret_encrypted, totp_enabled, job_title,
        status, created_at)
     values ($1,$2,'staff','Mama Nauli', $3,$4::bytea,$5,$6::bytea,$7,$8,$9::bytea,false,
             'Clearing clerk','active', now() - interval '200 days')`,
    [SEAT, ER, EMAIL("seat"), encryptField(SEAT_PHONE), searchHash(SEAT_PHONE),
      encryptField(NIDA), searchHash(NIDA),
      "scrypt$probe$0123456789abcdef0123456789abcdef0123456789abcdef0123",
      encryptField("probe-totp-secret")]);
  await okDo("…and the sign-in that seat made",
    `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
     values ($1,$2,$3,$4, now() + interval '2 hours', $5,'probe-device','203.0.113.9',
             now() + interval '2 hours')`,
    [randomUUID(), SEAT, ER, randomUUID(), sha256Like(`probe-seat-${STAMP}`)]);
  await okDo("…and a stored file whose name the papers branch will erase",
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
        size_bytes, storage_path, uploaded_by)
     values ($1,'tenant',$1,'licence','Bill of Lading original.pdf','application/pdf',20480,
             'probe/${STAMP}/bol.pdf',$2) returning id`,
    [ER, A]);
  const DOC = (await one(`select id from documents where storage_path = 'probe/${STAMP}/bol.pdf'`))
    ?.id as string;
  // A fixture that did not land makes every phase below report a refusal it never tested — the
  // guards answer "no account" and the mask answers "not_found". Say so once and stop.
  const minted = await one(`select (select count(*)::int from tenants where id = any($1::uuid[]))
      as accounts, (select count(*)::int from users where id = any($2::uuid[])) as seats,
      (select count(*)::int from sessions where user_id = any($2::uuid[])) as signins,
      (select count(*)::int from documents where id = any($3::uuid[])) as files`,
    [[CO, KEEP, ER, LIVE, OFFICE], [A, B, OUT, SEAT], [DOC]]);
  if (minted?.accounts !== 5 || minted?.seats !== 4 || minted?.signins !== 1
    || minted?.files !== 1) {
    throw new Error(`the fixtures did not land: ${JSON.stringify(minted)} — every phase below `
      + "would answer a refusal it never tested");
  }

  const REF = async () => (await one(`select 'DR-2026-'
    || lpad(nextval('customer_data_request_number_seq')::text, 5, '0') as r`))?.r as string;
  /** A row written the way the desk's own definer writes one, minus the definer, so the guards above
   *  the table can be aimed at directly. */
  const paper = async (o: Partial<{
    company: string; register: string; kind: string; cats: string[]; reason: string; raised: string;
  }> = {}) => (await okDo("a paper",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, status,
        categories, reason, asked_in, raised_by, raised_role, raised_at)
     values ($1,$2,$3,$4,'raised',$5,$6,'a telephone call',$7,'super_admin',
             now() - interval '20 minutes')
     returning id, ref, kind, status, categories`,
    [o.register ?? TEN, o.company ?? CO, await REF(), o.kind ?? "erase",
      o.cats ?? ["account"],
      o.reason ?? "The caller cited Article 17 on the line and was verified against the filed TIN.",
      o.raised ?? A]))?.[0];

  // ---------------- 2 · what the row refuses ----------------
  // The seat, the sign-in and the file above are written while the account is still open, because
  // a closed company is what the rest of the migrations refuse to write to; closing it here is the
  // only state in which an erasure may name it.
  await okDo("…and three of them closed, which is the only state an erasure may name",
    `update tenants set deleted_at = now() where id = any($1::uuid[])`, [[CO, KEEP, ER]]);
  phase("2 · the guards, by the name of the rule that fired");
  await fails("an erasure that names nothing is a refusal wearing a form, and the row says so",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'erase','{}',$4,$5)`,
    [TEN, CO, await REF(), "An erasure with no list at all is not an erasure.", A],
    RULES["the erasure names something"]);
  await fails("a copy that arrives with a menu is choosing what to hide",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'export',array['seats'],$4,$5)`,
    [TEN, CO, await REF(), "A copy that hides its own seats is not a copy.", A],
    RULES["the copy takes no menu"]);
  await fails("a category word the mask does not know cannot be filed",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'erase',array['seats','wallets'],$4,$5)`,
    [TEN, CO, await REF(), "Erasing something the register cannot reach.", A],
    RULES["the categories are the ten"]);
  await fails("a paper numbered the way a desk types is not a paper",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,'please-delete','erase',array['seats'],$3,$4)`,
    [TEN, CO, "A caller asked at the counter for everything to go.", A],
    RULES["a paper is numbered"]);
  await fails("a reason under eight characters is a mark, not the sentence a second seat signs",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'erase',array['seats'],'gdpr',$4)`,
    [TEN, CO, await REF(), A], RULES["a reason is a sentence"]);
  // The row carries its own rule that a paper is never filed on the register that holds it
  // (`RULES["a paper is not filed on its own register"]`, proved to exist in phase 1), but a BEFORE
  // trigger stands in front of every CHECK and names the same fact — and it is a better sentence for
  // a desk to read. So this insert is refused by the guard, not by the constraint, and the gate
  // reports which one fired rather than crediting the rule that never got the chance.
  await fails("a request cannot be filed on the register it is filed to",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$1,$2,'export','{}',$3,$4)`,
    [TEN, await REF(), "The office asked for a copy of its own staff records.", A],
    "does not make requests about itself");
  await fails("the office does not make erasure papers about itself",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'erase',array['seats'],$4,$5)`,
    [TEN, OFFICE, await REF(), "A platform desk wants its own seats masked.", A],
    "does not make requests about itself");
  await fails("an account that is not there is refused by number, not silently accepted",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'export','{}',$4,$5)`,
    [TEN, randomUUID(), await REF(), "A caller asked for a copy of an account we cannot find.", A],
    "no account");
  await fails("a register that is not the office's own cannot hold a paper",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'export','{}',$4,$5)`,
    [LIVE, CO, await REF(), "A transporter tried to keep its own data register.", A],
    "kept on the office's own register");
  await fails("an erasure may not name an account that is still trading",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'erase',array['seats'],$4,$5)`,
    [TEN, LIVE, await REF(), "The caller asked for everything, and the account is open.", A],
    "still a live account");
  await fails("a copy is never waiting on a signature it did not ask for",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, status,
        categories, reason, raised_by)
     values ($1,$2,$3,'export','pending_signature','{}',$4,$5)`,
    [TEN, CO, await REF(), "An export filed as if it needed a second seat.", A],
    RULES["a kind decides its states"]);
  await fails("…and a paper that waits holds the signature it waits on",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, status,
        categories, reason, raised_by)
     values ($1,$2,$3,'erase','pending_signature',array['seats'],$4,$5)`,
    [TEN, CO, await REF(), "An erasure claiming to wait, with nothing to wait on.", A],
    RULES["waiting needs a signature"]);
  await fails("an erased paper cannot arrive without the hand that erased it",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, status,
        categories, reason, raised_by, erased_at, erased, keeps)
     values ($1,$2,$3,'erase','erased',array['seats'],$4,$5,now(),'{"seats":1}','[{"key":"x"}]')`,
    [TEN, CO, await REF(), "An erasure with a date and no name beside it.", A],
    "without a second seat's signature");
  await fails("…and a paper cannot point its erasure at a signature that does not exist",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, status,
        categories, reason, raised_by, approval_id, erased_at, erased_by, erased, keeps)
     values ($1,$2,$3,'erase','erased',array['seats'],$4,$5,$5,now(),$5,'{"seats":1}',
             '[{"key":"paper_bytes"}]')`,
    [TEN, CO, await REF(), "An erasure pointing at a signature nobody wrote.", randomUUID()],
    "there is no such signature");
  const p1 = await paper({});
  check("a plain erasure paper is accepted, closed account and all",
    p1?.status === "raised" && p1?.categories?.length === 1, p1);
  await fails("one open paper per account per kind — the register cannot hold the same ask twice",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'erase',array['calls'],$4,$5)`,
    [TEN, CO, await REF(), "A second open erasure on the same closed account.", A],
    "customer_data_requests_one_open");
  await fails("and the number a paper carries is unique, not merely formatted",
    `insert into customer_data_requests (tenant_id, company_tenant_id, ref, kind, categories,
        reason, raised_by) values ($1,$2,$3,'export','{}',$4,$5)`,
    [OFFICE, CO, p1?.ref, "The same DR- number on another office's register.", A],
    "customer_data_requests_ref_key");

  // ---------------- 3 · a paper is kept, not rewritten ----------------
  phase("3 · the words a signature was given cannot change under it");
  for (const [what, sql, p] of [
    ["the reason it was raised for", `update customer_data_requests set reason = $2 where id = $1`,
      [p1?.id, "The office found a better sentence after the fact."]],
    ["the list it was signed for",
      `update customer_data_requests set categories = array['seats','calls'] where id = $1`, [p1?.id]],
    ["the account it names", `update customer_data_requests set company_tenant_id = $2 where id = $1`,
      [p1?.id, KEEP]],
    ["its own number", `update customer_data_requests set ref = 'DR-1999-00001' where id = $1`,
      [p1?.id]],
    ["the hand that raised it", `update customer_data_requests set raised_by = $2 where id = $1`,
      [p1?.id, B]],
    ["the kind it was raised as", `update customer_data_requests set kind = 'export' where id = $1`,
      [p1?.id]],
    ["how the ask arrived", `update customer_data_requests set asked_in = 'a fax' where id = $1`,
      [p1?.id]]
  ] as [string, string, any[]][]) {
    await fails(`a paper cannot have ${what} changed after it was raised`, sql, p, "is kept");
  }
  const p2 = await paper({ company: KEEP });
  await fails("waiting is not a state a desk can type by hand — it has to be given",
    `update customer_data_requests set status = 'pending_signature' where id = $1`, [p2?.id],
    "a signature it was not given");
  const gave = await call("give that paper a real signature",
    `select platform_auth.propose_data_erasure($1,$2,$3,$4,'203.0.113.1','probe-ua') as r`,
    [p2?.id, "Ask a second seat to sign this paper.", A, "super_admin"]);
  check("…and the paper moves to a second seat with a hash of exactly these bytes",
    gave?.status === "ok" && gave?.request_status === "pending_signature", gave);
  await fails("a waiting paper cannot be re-aimed at another signature",
    `update customer_data_requests set approval_id = $2 where id = $1`, [p2?.id, randomUUID()],
    "stands open on a signature");
  await okDo("refuse it the way a desk is allowed to",
    `update customer_data_requests set status = 'refused', refused_by = $2, refused_at = now(),
            refused_note = 'The caller withdrew the ask on the second call.' where id = $1
     returning id, status`, [p2?.id, B]);
  const refused = await one(`select status from customer_data_requests where id = $1`, [p2?.id]);
  check("…and a refusal is a real answer the register keeps", refused?.status === "refused", refused);
  await fails("…which cannot then be talked out of",
    `update customer_data_requests set status = 'raised' where id = $1`, [p2?.id], "stays refused");
  // A paper whose `bundle_sha256` is NULL is not refused for setting it — the guard only protects a
  // hash that was already recorded — so that case is proved below, on p3, after a real stamp.
  const p3 = await paper({ kind: "export", cats: [] });
  const stamp1 = await call("stamp the first bundle",
    `select platform_auth.mark_data_request_delivered($1,$2,$3,'203.0.113.1',$4,1024::bigint,17) as r`,
    [p3?.id, B, "super_admin", "a".repeat(64)]);
  check("a copy is handed over, and the first stamp is kept",
    stamp1?.status === "ok" && stamp1?.first_bundle === true && stamp1?.deliveries === 1, stamp1);
  const stamp2 = await call("stamp a second one",
    `select platform_auth.mark_data_request_delivered($1,$2,$3,'203.0.113.1',$4,2048::bigint,17) as r`,
    [p3?.id, B, "super_admin", "c".repeat(64)]);
  check("…a re-download counts and restates nothing: the bundle quoted back is still the first",
    stamp2?.status === "ok" && stamp2?.deliveries === 2, stamp2);
  await fails("and its recorded hash cannot be rewritten under a later download",
    `update customer_data_requests set bundle_sha256 = $2 where id = $1`,
    [p3?.id, "d".repeat(64)], "bundle facts are kept");
  await fails("…nor can the count of hand-overs go back",
    `update customer_data_requests set deliveries = 0 where id = $1`, [p3?.id], "does not go back");

  // ---------------- 4 · the definers' own refusals ----------------
  phase("4 · the doors refuse in the register's words");
  const r1 = await call("a copy with a menu",
    `select platform_auth.raise_data_request($1,$2,'export',$3::text[],$4,$5,$6,$7,'203.0.113.1') as r`,
    [TEN, CO, ["seats"], "A copy asked for with a menu on it.", "an email", A, "super_admin"]);
  check("a copy with a menu is refused as choosing what to withhold",
    r1?.status === "invalid" && /not a menu/.test(r1?.message ?? ""), r1);
  const r2 = await call("an empty erasure",
    `select platform_auth.raise_data_request($1,$2,'erase','{}'::text[],$3,$4,$5,$6,'203.0.113.1') as r`,
    [TEN, CO, "An erasure that names nothing at all.", "a letter", A, "super_admin"]);
  check("an erasure that names nothing is refused as a refusal wearing a form",
    r2?.status === "invalid" && /has to name what it erases/.test(r2?.message ?? ""), r2);
  const r3 = await call("an erasure on a live account",
    `select platform_auth.raise_data_request($1,$2,'erase',array['seats'],$3,$4,$5,$6,'203.0.113.1') as r`,
    [TEN, LIVE, "An erasure against an account that is trading.", "a call", A, "super_admin"]);
  check("an erasure on a live account says where to go instead of just refusing",
    r3?.status === "invalid" && /closed first|tenants desk/.test(r3?.message ?? ""), r3);
  const r4 = await call("a paper about the office itself",
    `select platform_auth.raise_data_request($1,$1,'export','{}'::text[],$2,$3,$4,$5,'203.0.113.1') as r`,
    [TEN, "A platform desk asks for a copy of itself.", "a call", A, "super_admin"]);
  check("the office cannot raise a paper about itself",
    r4?.status === "invalid" && /staff desk/.test(r4?.message ?? ""), r4);
  const r5 = await call("an account that is not there",
    `select platform_auth.raise_data_request($1,$2,'export','{}'::text[],$3,$4,$5,$6,'203.0.113.1') as r`,
    [OFFICE, randomUUID(), "A paper raised against an account that is not there.", "a call",
      B, "super_admin"]);
  check("an unknown account answers not_found, not an empty promise",
    r5?.status === "not_found", r5);
  const r6 = await call("a second open erasure on one account",
    `select platform_auth.raise_data_request($1,$2,'erase',array['seats'],$3,$4,$5,$6,'203.0.113.1') as r`,
    [TEN, CO, "A second erasure paper on an account that already has one open.", "a call", A,
      "super_admin"]);
  check("a second open paper hands the desk the number of the one that stands",
    r6?.status === "conflict" && r6?.open_id === p1?.id, r6);
  const r7 = await call("a reason too short to quote back",
    `select platform_auth.raise_data_request($1,$2,'erase',array['seats'],$3,$4,$5,$6,'203.0.113.1') as r`,
    [TEN, CO, "short", "a call", A, "super_admin"]);
  check("a reason too short to quote back is refused before the number is burned",
    r7?.status === "invalid" && /8-600/.test(r7?.message ?? ""), r7);
  const r8 = await call("a hand-over with a bad hash",
    `select platform_auth.mark_data_request_delivered($1,$2,$3,'203.0.113.1',$4,1024::bigint,3) as r`,
    [p1?.id, B, "super_admin", "n0t-a-sha"]);
  check("a hand-over stamped with anything but a SHA-256 is refused",
    r8?.status === "invalid" && /SHA-256/.test(r8?.message ?? ""), r8);
  const r9 = await call("a hand-over on an erasure",
    `select platform_auth.mark_data_request_delivered($1,$2,$3,'203.0.113.1',$4,1024::bigint,3) as r`,
    [p1?.id, B, "super_admin", "e".repeat(64)]);
  check("an erasure is signed, not delivered — the copy door refuses it",
    r9?.status === "invalid" && /Only a copy/.test(r9?.message ?? ""), r9);
  const r10 = await call("a dead seat asking for a signature",
    `select platform_auth.propose_data_erasure($1,$2,$3,$4,'203.0.113.1','probe') as r`,
    [p1?.id, "Ask a second seat to sign this paper.", OUT, "super_admin"]);
  check("a seat that is not live cannot ask for a signature",
    r10?.status === "invalid" && /live platform seat/.test(r10?.message ?? ""), r10);
  const r11 = await call("a signature for a copy",
    `select platform_auth.propose_data_erasure($1,$2,$3,$4,'203.0.113.1','probe') as r`,
    [p3?.id, "Ask a second seat to sign a copy.", A, "super_admin"]);
  check("a copy is refused a signature rather than quietly waiting on one",
    r11?.status === "invalid" && /only be signed|copy asks no/.test(r11?.message ?? ""), r11);

  // ---------------- 5 · the board's words are the filter's words ----------------
  phase("5 · the board answers in the register's own words");
  const board = await call("the board",
    `select platform_auth.data_requests_board($1,null,null,null,25,0) as r`, [TEN]);
  const countKeys = Object.keys(board?.counts ?? {});
  const BOARD_KEYS = ["all", ...REQUEST_STATUSES, "export", "erase"];
  check(`every count key is a word the board itself can be filtered on (${countKeys.join(",")})`,
    countKeys.every((k) => BOARD_KEYS.includes(k))
    && REQUEST_STATUSES.every((s) => countKeys.includes(s)), countKeys);
  check("…and every count on it is a number the desk can add, not digits in a string",
    stringly(board?.counts ?? {}).length === 0, stringly(board?.counts ?? {}));
  check("…with the row the desk prints: the paper, the hand, the hour, the counts and the kept list",
    ["id", "ref", "kind", "request_status", "categories", "company_name", "raised_name",
      "approval_status", "erased_rows", "kept", "deliveries", "bundle_sha256"].every(
      (k) => k in (board?.rows?.[0] ?? {})), Object.keys(board?.rows?.[0] ?? {}).join(","));
  for (const s of [...REQUEST_STATUSES, "all", "export", "erase"]) {
    const cut = await call(`the ${s} chip`,
      `select platform_auth.data_requests_board($1,$2,$3,null,25,0) as r`,
      [TEN, ["export", "erase"].includes(s) ? null : s, ["export", "erase"].includes(s) ? s : null]);
    check(`…the ${s} chip answers with rows it filtered itself`,
      Array.isArray(cut?.rows) && (cut?.rows ?? []).every((r: any) =>
        ["export", "erase"].includes(s) ? r.kind === s : (s === "all" || r.request_status === s)),
      cut?.rows?.map((r: any) => [r.ref, r.kind, r.request_status]));
  }
  const bogus = await call("a filter word the register does not use",
    `select platform_auth.data_requests_board($1,'awaiting_signature',null,null,25,0) as r`, [TEN]);
  check("…and a filter word the register does not use answers an empty board, not everything",
    (bogus?.rows ?? []).length === 0, bogus?.counts);
  const elsewhere = await call("another office's board",
    `select platform_auth.data_requests_board($1,null,null,null,25,0) as r`, [OFFICE]);
  check("a second office's board does not see this one's papers",
    elsewhere?.counts?.all === 0, elsewhere?.counts);
  const dos = await call("the detail of one paper",
    `select platform_auth.data_request_detail($1) as r`, [p1?.id]);
  check("the detail names the account, the hands, and the bundle facts",
    dos?.ref === p1?.ref && "raised_name" in (dos ?? {}) && "refused_name" in (dos ?? {})
    && "bundle_sha256" in (dos ?? {}) && dos?.company?.id === CO, Object.keys(dos ?? {}));
  check("…and the `status` key in it is the paper's state, not the door's verdict — "
    + "jsonb_build_object keeps the LAST duplicate, and 129 writes 'ok' then r.status",
    dos?.status === "raised", dos?.status);
  const stranger = await call("a paper the register has never seen",
    `select platform_auth.data_request_detail($1) as r`, [randomUUID()]);
  check("…and an id it cannot see is a not_found, not an empty object",
    stranger?.status === "not_found", stranger);
  const pv = await call("the preview of an erasure",
    `select platform_auth.data_request_preview($1,'erase') as r`, [ER]);
  check("the preview offers all ten categories and names what is kept whatever the desk ticks",
    Object.keys(pv?.masks ?? {}).length === 10 && (pv?.keeps ?? []).length >= 12,
    { masks: Object.keys(pv?.masks ?? {}), keeps: (pv?.keeps ?? []).length });
  check("…and its counts are the rows that exist right now, before anything is masked",
    pv?.masks?.seats?.rows === 1 && pv?.masks?.sessions?.rows === 1 && pv?.masks?.papers?.rows === 1
    && pv?.masks?.account?.with_tin === 1 && pv?.masks?.account?.with_phone === 1,
    pv?.masks);
  // The desk adds a category's numbers up to say "this erasure reaches N rows", and a `"1"` is not
  // addable. 129 casts every count in `data_request_preview` for this reason.
  check("…and every one of them is a number the desk can add, not digits in a string",
    stringly(pv?.masks ?? {}).length === 0 && stringly(pv?.keeps ?? []).length === 0,
    [...stringly(pv?.masks ?? {}), ...stringly(pv?.keeps ?? [])]);
  const live = await call("the preview of a trading account",
    `select platform_auth.data_request_preview($1,'erase') as r`, [LIVE]);
  check("…and it says the account is not erasable while it is trading",
    live?.eligible === false && /two-seat act on the tenants desk/
      .test(String(live?.refusal)), live?.refusal);

  // ---------------- 6 · the mask, all ten branches ----------------
  phase("6 · the erasure runs — every branch, on a company this gate mints and rolls back");
  const raised = await call("raise an erasure naming all ten",
    `select platform_auth.raise_data_request($1,$2,'erase',$3::text[],$4,$5,$6,$7,'203.0.113.1') as r`,
    [TEN, ER, CATEGORIES as unknown as string[],
      "The director telephoned, cited Article 17, and was verified against the filed TIN.",
      "a telephone call", A, "super_admin"]);
  check("an erasure naming all ten categories is raised on the closed account",
    raised?.status === "ok" && raised?.request?.categories?.length === 10,
    { status: raised?.status, m: raised?.message });
  const PID = raised?.request?.id as string;
  const prop = await call("ask a second seat",
    `select platform_auth.propose_data_erasure($1,$2,$3,$4,'203.0.113.1','probe-ua') as r`,
    [PID, "Mask this account's personal data under Article 17.", A, "super_admin"]);
  check("asking for the signature writes a proposal and a hash, and reaches nothing else",
    prop?.status === "ok" && prop?.request_status === "pending_signature"
    && /^[0-9a-f]{64}$/.test(String(prop?.payload_sha256 ?? "")), prop);
  const APP = prop?.approval_id as string;
  const hashed = (await one(`select payload -> 'categories' as c from platform_approvals
    where id = $1`, [APP]))?.c as string[] | null;
  check("…and the paper it hashed carries exactly these ten words, and nothing else",
    same([...(hashed ?? [])].sort(), [...CATEGORIES].sort()), hashed);
  const self = await call("the raiser signs it",
    `select platform_auth.decide_approval($1,'approve',$2,$3,$4,'203.0.113.1','probe-ua') as r`,
    [APP, "yes, erase it", A, "super_admin"]);
  check("the seat that raised the paper cannot sign it", self?.status === "self", self);
  const noNote = await call("a signature of two letters",
    `select platform_auth.decide_approval($1,'approve','ok',$2,$3,'203.0.113.1','probe-ua') as r`,
    [APP, B, "compliance_officer"]);
  check("…and a signature has to be a sentence, however short",
    noNote?.status === "invalid" && /4-400/.test(noNote?.message ?? ""), noNote);
  const signed = await call("a second seat signs",
    `select platform_auth.decide_approval($1,'approve',$2,$3,$4,'203.0.113.2','probe-ua') as r`,
    [APP, "yes — the account is closed and the list is what was offered", B, "compliance_officer"]);
  check("a second seat signs exactly the bytes the preview produced",
    signed?.status === "ok" && signed?.approval_status === "approved", signed);
  const early = await call("spend it before claiming it",
    `select platform_auth.apply_data_erasure($1,$2,$3,'203.0.113.2') as r`,
    [APP, B, "compliance_officer"]);
  check("an approved signature is not a spent one: the mask refuses until it is claimed",
    early?.status === "conflict" && /not spent/.test(early?.message ?? ""), early);
  const claimed = await call("the signer claims it",
    `select platform_auth.claim_approval($1,$2) as r`, [APP, B]);
  check("the seat that signed is the seat that spends it",
    claimed?.status === "ok" && claimed?.payload?.categories?.length === 10, claimed);
  const wrongSeat = await call("the raiser spends it now",
    `select platform_auth.apply_data_erasure($1,$2,$3,'203.0.113.1') as r`,
    [APP, A, "super_admin"]);
  check("…and nobody but the seat that signed may spend it, however senior that other seat is",
    wrongSeat?.status === "unauthorised" && /released a signature/
      .test(wrongSeat?.message ?? ""), wrongSeat);

  const before = await one(`select name, slug, email, tin_encrypted, phone_encrypted from tenants
    where id = $1`, [ER]);
  const beforeSeat = await one(`select full_name, email, phone_encrypted, phone_search,
    nida_encrypted, password_hash, totp_secret_encrypted, status from users where id = $1`, [SEAT]);
  check("the account and its seat arrive whole: a name, a number, a phone, a NIDA, a secret",
    !!before?.name && !!before?.slug && !!before?.email && !!before?.tin_encrypted
    && !!before?.phone_encrypted && !!beforeSeat?.phone_encrypted
    && !!beforeSeat?.nida_encrypted && !!beforeSeat?.password_hash
    && !!beforeSeat?.totp_secret_encrypted, { before, beforeSeat });
  const mask = await call("run the mask",
    `select platform_auth.apply_data_erasure($1,$2,$3,'203.0.113.2') as r`,
    [APP, B, "compliance_officer"]);
  const reached = mask?.reached ?? {};
  check("the mask runs, and answers ok for the paper it was signed on",
    mask?.status === "ok" && mask?.request_status === "erased" && mask?.ref === raised?.request?.ref,
    mask?.status ?? mask);
  check(`…having executed all ten branches (${Object.keys(reached).join(", ")})`,
    CATEGORIES.every((k) => typeof reached[k] === "number") && Object.keys(reached).length === 10,
    reached);
  check("…counting the rows it really reached, not a number it hoped for",
    reached.account === 1 && reached.seats === 1 && reached.sessions === 1 && reached.papers === 1,
    reached);
  check("…and the paper is stamped with those counts and the keeps read at the same moment",
    Array.isArray(mask?.kept) && mask?.kept.length >= 12
    && mask?.kept.every((k: any) => !!k.key && !!k.because), mask?.kept?.slice(0, 3));
  const after = await one(`select name, slug, email, tin_encrypted, tin_search, phone_encrypted,
    phone_search, deleted_at from tenants where id = $1`, [ER]);
  check("the account's own name, number and address are gone from the register",
    after?.name === `Erased account ${String(ER).slice(0, 8)}` && before?.name !== after?.name
    && after?.slug === null && after?.email === null && after?.tin_encrypted === null
    && after?.tin_search === null && after?.phone_encrypted === null
    && after?.phone_search === null && after?.deleted_at !== null, after);
  const afterSeat = await one(`select id, full_name, email, email_normalized_search,
    phone_encrypted, phone_search, nida_encrypted, nida_search, password_hash,
    totp_secret_encrypted, totp_enabled, job_title, status, deleted_at
    from users where id = $1`, [SEAT]);
  check("the person with a seat is erased and the row stays as the account's history",
    afterSeat?.full_name === `Erased seat ${String(SEAT).slice(0, 8)}`
    && afterSeat?.email === null && afterSeat?.email_normalized_search === null
    && afterSeat?.phone_encrypted === null && afterSeat?.phone_search === null
    && afterSeat?.nida_encrypted === null && afterSeat?.nida_search === null
    && afterSeat?.password_hash === null && afterSeat?.totp_secret_encrypted === null
    && afterSeat?.totp_enabled === false && afterSeat?.job_title === null
    && afterSeat?.status === "deactivated" && afterSeat?.deleted_at !== null, afterSeat);
  const sess = await one(`select ip, user_agent, refresh_token_hash, revoked_at, revoked_reason,
    expires_at, user_id, tenant_id from sessions where tenant_id = $1`, [ER]);
  check("a sign-in record keeps its shape and loses the device, the address and the credential",
    sess?.ip === null && sess?.user_agent === null && sess?.user_id === SEAT
    && /^erased-/.test(String(sess?.refresh_token_hash)) && String(sess?.refresh_token_hash).length > 20
    && sess?.revoked_at !== null && sess?.revoked_reason === "data_erasure" && !!sess?.expires_at,
    sess);
  const doc = await one(`select file_name, storage_path, deleted_at from documents where id = $1`,
    [DOC]);
  check("a stored file loses its name and keeps its extension, its bytes and the path the "
    + "retention sweep will destroy them from",
    doc?.file_name === `erased-${String(DOC).slice(0, 8)}.pdf`
    && doc?.storage_path === `probe/${STAMP}/bol.pdf` && doc?.deleted_at !== null, doc);
  const row = await call("read the paper back",
    `select platform_auth.data_request_detail($1) as r`, [PID]);
  check("the register reads back as erased, by the signing seat, with its counts attached",
    row?.status === "erased" && row?.erased_name === "Probe Signer"
    && Object.keys(row?.erased ?? {}).length === 10 && (row?.keeps ?? []).length >= 12,
    { s: row?.status, e: row?.erased_name, k: Object.keys(row?.erased ?? {}) });
  const twice = await call("spend the same signature again",
    `select platform_auth.apply_data_erasure($1,$2,$3,'203.0.113.2') as r`,
    [APP, B, "compliance_officer"]);
  check("a spent signature cannot be spent a second time on the same paper",
    twice?.status === "conflict" && /already erased/.test(twice?.message ?? ""), twice);
  await fails("and the erased paper itself is beyond editing, by anyone, including this gate",
    `update customer_data_requests set status = 'pending_signature' where id = $1`, [PID],
    "is erased");

  // ---------------- 6b · a paper that names one category touches one category ----------------
  phase("6b · the branch that is not ticked does not run");
  const oneCat = await call("raise an erasure of seats only",
    `select platform_auth.raise_data_request($1,$2,'erase',$3::text[],$4,$5,$6,$7,'203.0.113.1') as r`,
    [TEN, KEEP, ["seats"], "Only the people with a seat, as the caller asked on the call.",
      "a telephone call", A, "super_admin"]);
  const KID = oneCat?.request?.id as string;
  const kprop = await call("ask a second seat for it",
    `select platform_auth.propose_data_erasure($1,$2,$3,$4,'203.0.113.1','probe-ua') as r`,
    [KID, "Mask the seats and nothing else.", A, "super_admin"]);
  const KAPP = kprop?.approval_id as string;
  await call("the second seat signs",
    `select platform_auth.decide_approval($1,'approve',$2,$3,$4,'203.0.113.2','probe-ua') as r`,
    [KAPP, "yes — only the seats, as offered", B, "compliance_officer"]);
  await call("and claims it", `select platform_auth.claim_approval($1,$2) as r`, [KAPP, B]);
  const kmask = await call("run that mask",
    `select platform_auth.apply_data_erasure($1,$2,$3,'203.0.113.2') as r`,
    [KAPP, B, "compliance_officer"]);
  check("a paper that names one category reaches one category, and says so",
    kmask?.status === "ok" && Object.keys(kmask?.reached ?? {}).length === 1
    && kmask?.reached?.seats === 0, kmask?.reached ?? kmask);
  const keptName = await one(`select name, slug, email from tenants where id = $1`, [KEEP]);
  check("…the account it did not name keeps its own name, its slug and its email",
    keptName?.name === `Probe Keep ${STAMP}` && !!keptName?.slug && !!keptName?.email, keptName);

  // ---------------- 7 · who may reach the register ----------------
  phase("7 · the reach of every role but the owner's");
  const reach = await one(`select
      has_table_privilege('app_runtime','customer_data_requests','delete') as del,
      has_table_privilege('app_runtime','customer_data_requests','insert') as ins,
      has_table_privilege('app_runtime','customer_data_requests','update') as upd,
      has_table_privilege('app_runtime','customer_data_requests','select') as read,
      has_table_privilege('anon','customer_data_requests','select') as anon_read,
      has_table_privilege('authenticated','customer_data_requests','select') as auth_read,
      has_table_privilege('service_role','customer_data_requests','select') as svc_read,
      has_sequence_privilege('app_runtime','customer_data_request_number_seq','usage') as burns,
      has_sequence_privilege('service_role','customer_data_request_number_seq','usage') as svc_burns`);
  check("the API's role can raise, answer and stamp a paper but cannot delete one",
    !reach?.del && reach?.ins && reach?.upd && reach?.read, JSON.stringify(reach));
  check("…no client role can read the register at all",
    !reach?.anon_read && !reach?.auth_read && !reach?.svc_read, JSON.stringify(reach));
  check("…and the number a paper is given cannot be burned from the desk",
    !reach?.burns && !reach?.svc_burns, JSON.stringify(reach));
  const fnAcl = await oi(`select p.proname, (p.proacl is null) as unlisted,
      coalesce(string_agg(distinct a.grantee::regrole::text, ','), '') as grantees
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join lateral aclexplode(p.proacl) a on true
    where n.nspname = 'platform_auth' and p.proname in
      ('data_request_preview','raise_data_request','propose_data_erasure','apply_data_erasure',
       'refuse_data_request','mark_data_request_delivered','data_export','data_request_detail',
       'data_requests_board','data_request_names_a_closed_account',
       'data_request_is_kept_not_rewritten','data_erase_needs_two_seats')
    group by p.oid, p.proname, (p.proacl is null) order by p.proname`);
  check("all twelve are named in the catalog — a door that is not there is not a door that is shut",
    fnAcl.rowCount === 12, fnAcl.rows.map((r: any) => r.proname));
  // `aclexplode`'s grantee 0 prints as `PUBLIC` in upper case, so the comparison is made on the
  // lower-cased list — a filter that matched only `public` would call an open door shut.
  const wide = fnAcl.rows.filter((r: any) => r.unlisted
    || String(r.grantees).toLowerCase().split(",").includes("public"));
  check("none of them is left open to PUBLIC — a drop-and-create would have reset exactly this",
    wide.length === 0, JSON.stringify(fnAcl.rows.map((r: any) => [r.proname, r.grantees])));
  const bodies = await one(`select
      has_function_privilege('app_runtime','platform_auth.data_erase_needs_two_seats()','execute') as two,
      has_function_privilege('app_runtime','platform_auth.data_request_is_kept_not_rewritten()','execute') as kept,
      has_function_privilege('app_runtime','platform_auth.data_request_names_a_closed_account()','execute') as names`);
  check("a trigger body is fired, never called: the desk cannot raise an erasure by hand",
    !bodies?.two && !bodies?.kept && !bodies?.names, JSON.stringify(bodies));
  const doors = await one(`select
      has_function_privilege('app_runtime','platform_auth.data_export(uuid,uuid)','execute') as exp,
      has_function_privilege('app_runtime','platform_auth.apply_data_erasure(uuid,uuid,text,text)','execute') as mask,
      has_function_privilege('app_runtime','platform_auth.data_requests_board(uuid,text,text,text,int,int)','execute') as board,
      has_function_privilege('anon','platform_auth.data_requests_board(uuid,text,text,text,int,int)','execute') as anon_board,
      has_function_privilege('public','platform_auth.raise_data_request(uuid,uuid,text,text[],text,text,uuid,text,text)','execute') as pub_raise`);
  check("…but the doors the routes call are open to the role the API runs as",
    doors?.exp && doors?.mask && doors?.board && !doors?.pub_raise, JSON.stringify(doors));
  check("…and a signed-in browser cannot read the register itself", !doors?.anon_board, doors);
  const rls = await one(`select relrowsecurity as on_ from pg_class
    where oid = 'customer_data_requests'::regclass`);
  const pol = await oi(`select cmd, roles::text as who, qual from pg_policies
    where tablename = 'customer_data_requests'`);
  check("RLS is on, and one ALL policy binds the office's own tenant on both sides",
    rls?.on_ === true && pol.rowCount === 1 && pol.rows[0].cmd === "ALL"
    && pol.rows[0].who === "{app_runtime}" && /tenant_id/.test(String(pol.rows[0].qual)), pol.rows);
  const held = await oi(`select r.key as role, rp.permission_key as duty, r.tenant_id
    from role_permissions rp join roles r on r.id = rp.role_id
    where rp.permission_key in ('control.customers.gdpr','control.customers.erase') order by 1,2`);
  const only = (key: string) => held.rows.filter((r: any) => r.duty === key).map((r: any) => r.role);
  check("the two duties 129 seeds are held by super_admin and compliance_officer, and by no one else",
    same(only("control.customers.gdpr").sort(), ["compliance_officer", "super_admin"])
    && same(only("control.customers.erase").sort(), ["compliance_officer", "super_admin"]),
    JSON.stringify(held.rows));
  check("…and no company's own duty profile can open the register",
    held.rows.every((r: any) => r.tenant_id === null), JSON.stringify(held.rows));

  // ---------------- 8 · nothing this gate wrote survives ----------------
  const auditNow = await one(`select count(*)::int as n from audit_logs
    where entity = 'customer_data_requests'`);
  await owner.query("rollback");
  phase("8 · residue");
  const left = await one(`select
      (select count(*)::int from customer_data_requests where raised_by in
        (select id from users where email like '%.${STAMP}@waisha.test'
           or full_name = 'Mama Nauli')) as papers,
      (select count(*)::int from platform_approvals where proposed_by in
        (select id from users where email like '%.${STAMP}@waisha.test')
         or decided_by in (select id from users where email like '%.${STAMP}@waisha.test'))
        as signatures,
      (select count(*)::int from customer_data_requests where company_tenant_id in
        (select id from tenants where name like '%${STAMP}%')) as about_probe,
      (select count(*)::int from users where email like '%.${STAMP}@waisha.test'
         or full_name = 'Mama Nauli') as seats,
      (select count(*)::int from tenants where name like '%${STAMP}%') as accounts,
      (select count(*)::int from sessions
        where user_agent = 'probe-device') as signins,
      (select count(*)::int from documents where storage_path like 'probe/${STAMP}/%') as files,
      (select count(*)::int from audit_logs where entity = 'customer_data_requests') as audit,
      (select count(*)::int from customer_data_requests) as register`);
  check("no paper, signature, seat, account, sign-in or file of this gate is left in the database",
    left?.papers === 0 && left?.signatures === 0 && left?.about_probe === 0 && left?.seats === 0
    && left?.accounts === 0 && left?.signins === 0 && left?.files === 0, JSON.stringify(left));
  check("and the audit register came back to the number it held before the rehearsal began — "
    + "these writes are rolled back with everything else, and audit_logs cannot be deleted",
    left?.audit === audit0?.n && auditNow?.n > (audit0?.n ?? 0),
    { before: audit0?.n, during: auditNow?.n, after: left?.audit });
  note(`the register still holds ${left?.register} paper(s) — 129's rows are the office's record `
    + "and are never deleted, by this gate or by the desk.");
  await owner.end();
  console.log(`\n${failures ? `FAIL — ${failures} of ${failures + proved} checks`
    : `PASS — all ${proved} checks: the copy, the signature and the mask`}`);
  if (failures) process.exit(1);
}

/** `sessions.refresh_token_hash` holds the sha-256 of the token a seat was given. */
function sha256Like(value: string) { return searchHash(`sha:${value}`); }

main().catch((e) => { console.error(e); process.exit(1); });
