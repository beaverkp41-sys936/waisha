/**
 * The Customers desk over HTTP — smoke for #342 (migration 127, api/src/routes/control-customers.routes.ts).
 *
 * verify-customers-sql.ts proves the register: which five words a kind may be, that an answer cannot
 * be edited into a different answer, that a number is stored in whole or not at all. This proves the
 * parts only the wire can show — that a duty the seat does not hold answers 403 rather than a quiet
 * empty list, that a guard sentence reaches the clerk in the register's own words as a 409, that the
 * one route allowed to decrypt a number is the only read that ever does and that it is written into
 * the audit register before the value leaves, and that no board, queue, dossier, timeline or CSV of
 * any of them carries more than four characters of a person's identity.
 *
 * The vocabulary is checked against the live table again here, one column at a time, because the
 * route's `z.enum` and the table's CHECK are written by different hands on different days. A kind the
 * desk can pick and the table refuses is a 400 nobody can explain; one the table allows and the route
 * refuses is a check no clerk can raise.
 *
 * The last phase is 128's, and it tests a different kind of answer. A claim is written by a definer
 * that refuses in three shapes — `ok`, `invalid` with a sentence, `not_found` naming which half of
 * the pair the office has never seen — so the wire has to show the sentence arriving as a 409 and
 * the missing account arriving as a 404, that the only thing a claim moves is work nobody has
 * answered yet, that it arrives as a NEW line with no number copied off the other account's paper,
 * and that a cut-off ends the sessions of one account and no others. `verify-customers-sql.ts`
 * cannot show any of that, because all of it is about which words reach a clerk.
 *
 * The fixtures are this run's own: two platform desks (the office under test and a foreign one, to
 * show the reads are bound to the register that asked), one live company, one the office has closed,
 * the seats inside them, and the papers filed against them. Everything is swept by tenant id at the
 * end. `audit_logs` is never deleted — the guard refuses it for the owner too — so this run's lines
 * stay in the fixture tenants, exactly as every earlier smoke leaves its own.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-customers.ts   (API on :4000)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";
import { CHECK_KINDS } from "../src/customers/checks.js";

const API = "http://127.0.0.1:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `cu${STAMP}`;
const TENANT_SWEEP = "Customers Smoke %";
const EMAIL_SWEEP = `smoke.customers.%@waisha.test`;

/** The identity number this run types. It appears exactly once in the whole exchange — in the
 *  reveal — and the sweep below proves it never reached any other response. */
const NID = "19930415001234";
const NID_SPACED = "1993 0415 0012 34";
const TIN = "1245678901";
const LICENCE = "TL/2027/0441";
const TRANSPORT = "TP-88120077";
const INSURANCE = "INS-2027/0415";
/** Two numbers that belong to the closed account rather than to the live one (128). They exist only
 *  to be refused a place in a carry: an answered check stays where it was answered, and an
 *  unanswered one arrives on the survivor as a new line with no number copied off the other
 *  account's paper. The sweep at the end of the claim phase proves neither left the register. */
const CX_INSURANCE = "INS-2026/1188";
const CX_TIN = "9988776655";

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++; else proved++;
}
const note = (line: string) => console.log(`note   ${line}`);
const phase = (name: string) => console.log(`\n--- ${name} ---`);

const seen: { where: string; text: string }[] = [];

async function call(path: string, opts: { ck?: string; method?: string; body?: any } = {}) {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const res = await fetch(`${API}${path}`, {
    method,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: opts.ck } : {}),
      // The audit register keeps the device string it was given, so the run names itself the way a
      // desk's browser would rather than leaving the column null and testing nothing.
      "User-Agent": "smoke-customers"
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a CSV */ }
  // Every body the desk read, kept so the PII sweep can say which of them carried a number.
  seen.push({ where: `${method} ${path}`, text });
  return { status: res.status, json, text, headers: res.headers };
}
const code = (j: any) => j?.error?.code ?? j?.code;
const msg = (j: any) => String(j?.error?.message ?? j?.message ?? "");
/** A refusal detail list flattened, so a `400 that names the field` is a fact rather than a guess. */
const fields = (j: any) => JSON.stringify(j?.error?.details ?? j?.details ?? "");

/** The words in the live table's own `kind = ANY (ARRAY[…])` list, read the way the gate reads them. */
function tokens(def: string, column: string): string[] {
  const m = def.match(new RegExp(`^CHECK \\(\\(${column} = ANY \\(ARRAY\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];

  const roleIds = (await oi(`select id, key from roles where tenant_id is null
    and key = any($1)`,
    [["super_admin", "compliance_officer", "customer_service_agent", "platform_analyst",
      "support_engineer", "billing_admin", "director"]])).rows as { id: string; key: string }[];
  const extra: { id: string; key: string }[] = [];
  const rid = (k: string) =>
    roleIds.find((r) => r.key === k)?.id ?? extra.find((r) => r.key === k)?.id;
  for (const k of ["super_admin", "compliance_officer", "customer_service_agent",
    "platform_analyst", "billing_admin", "director"]) {
    if (!rid(k)) throw new Error(`the global role ${k} this desk depends on is missing`);
  }
  // The seat that holds none of this desk's duties is found, not assumed: 127's seed says which
  // roles may read the register, and a role list copied into this file would go stale.
  const noDuty = (await one(`select r.id, r.key from roles r
    where r.tenant_id is null and r.key <> all($1)
      and not exists (select 1 from role_permissions rp join permissions p on p.key = rp.permission_key
                       where rp.role_id = r.id and p.key like 'control.customers.%')
    order by r.key limit 1`,
    [["super_admin", "compliance_officer", "customer_service_agent", "platform_analyst",
      "support_engineer", "billing_admin", "director"]])) as { id: string; key: string };
  if (!noDuty?.id) throw new Error("every global role holds a customer duty — the 403 probe needs one that does not");
  extra.push(noDuty);

  // ---------------- fixtures ----------------
  const TC = randomUUID();   // the office under test
  const TB = randomUUID();   // a foreign platform desk, to show the register is bound to the one asking
  const CO = randomUUID();   // the live company everything is about
  const CX = randomUUID();   // a company the office has closed: 078's door, not this register's
  const CF = randomUUID();   // a company belonging to nobody in this run, holding a foreign paper

  const uSA = randomUUID();  // super_admin: raises, answers, reveals
  const uCO = randomUUID();  // compliance_officer: the seat that answers checks
  const uCS = randomUUID();  // customer_service_agent: writes, cannot certify
  const uPA = randomUUID();  // platform_analyst: reads only
  const uND = randomUUID();  // a platform seat with no duty on this desk
  const uFor = randomUUID(); // super_admin of the other desk
  const uDir = randomUUID(); // a company seat: 099 turns it away

  const ck = (who: string) => `waisha_control=cu-smoke-${who}-${MARK}`;
  const tok = (who: string) => sha256(`cu-smoke-${who}-${MARK}`);

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      // A pairing names a label and an account, a label names the hand that wrote it, and a note
      // cannot go before the account it was written about: children first, always. A claim names
      // two accounts (128), so it goes before either of them.
      await oi(`delete from customer_duplicate_claims where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from customer_taggings where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from customer_tags where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from customer_notes where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from customer_verifications where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from documents where storage_path like $1`, [`%/${MARK}/%`]);
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where actor_user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    }
    await oi(`delete from tenant_actions where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like 'customers-%'`);

  // The licence is dated into the future on purpose: the office's idle clock
  // (`tenant-policy.ts`, every 15 minutes) blocks a company 45 days past its last paid licence
  // and closes it at 90, and it reads `created_at` when nothing else is on file. A fixture raised
  // 500 days ago with no licence would be suspended in the middle of this run — which is what
  // happened once, and every label probe after it answered "not a live account".
  await oi(`insert into tenants (id, type, name, status, slug, created_at, licence_expires_at) values
      ($1,'platform',$2,'active','cs-smoke-office', now() - interval '900 days',
       now() + interval '3 years'),
      ($3,'platform',$4,'active','cs-smoke-foreign', now() - interval '900 days',
       now() + interval '3 years'),
      ($5,'transporter',$6,'active','cs-smoke-cargo', now() - interval '500 days',
       now() + interval '3 years'),
      ($7,'transporter',$8,'active','cs-smoke-shut', now() - interval '500 days',
       now() + interval '3 years'),
      ($9,'shipper',$10,'active','cs-smoke-other', now() - interval '50 days',
       now() + interval '3 years')`,
    [TC, `Customers Smoke Office ${STAMP}`, TB, `Customers Smoke Foreign ${STAMP}`,
      CO, "Customers Smoke Cargo Ltd", CX, "Customers Smoke Shut Ltd",
      CF, "Customers Smoke Other Ltd"]);
  await oi(`update tenants set deleted_at = now(), status = 'suspended' where id = $1`, [CX]);

  const seat = async (id: string, tenant: string, name: string, roleKey: string,
    type = "platform") => {
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
            last_login_at, created_at)
          values ($1,$2,$3,$4,$5,'active',false, now() - interval '3 hours',
            now() - interval '300 days')`,
      [id, tenant, type, name,
        `smoke.customers.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, rid(roleKey)]);
  };
  await seat(uSA, TC, "Amani Super", "super_admin");
  await seat(uCO, TC, "Biweta Compliance", "compliance_officer");
  await seat(uCS, TC, "Callum Agent", "customer_service_agent");
  await seat(uPA, TC, "Nia Analyst", "platform_analyst");
  await seat(uND, TC, "Nkono Nothing", noDuty.key);
  await seat(uFor, TB, "Faraji Otherdesk", "super_admin");
  await seat(uDir, CO, "Daudi Director", "director", "director");

  for (const [who, user, tenant] of [
    ["sa", uSA, TC], ["co", uCO, TC], ["cs", uCS, TC], ["pa", uPA, TC],
    ["nd", uND, TC], ["for", uFor, TB], ["dir", uDir, CO]
  ] as [string, string, string][]) {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
            refresh_token_hash, user_agent, ip, expires_at)
          values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-customers','127.0.0.1',
            now() + interval '2 hours')`, [randomUUID(), user, tenant, randomUUID(), tok(who)]);
  }

  // Two live papers and one filed away: the desk's own upload path is proven elsewhere, so these
  // are inserted to give the register something to point at — and something to refuse.
  const mkPaper = async (tenant: string, label: string, gone = false) => (await one(
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
        size_bytes, storage_path, uploaded_by, deleted_at)
     values ($1,'tenant',$2,'licence',$3,'application/pdf',1024,$4,$5,
             case when $6 then now() else null end) returning id`,
    [tenant, tenant, `${label}.pdf`, `probe/${MARK}/${label}.pdf`, uSA, gone]))?.id as string;
  const PAPER = await mkPaper(CO, "cargo-licence");
  const FOREIGN = await mkPaper(CF, "other-licence");
  const GONE = await mkPaper(CO, "filed-away", true);

  const mint = async (sub: string, tid: string, role: string) =>
    new SignJWT({ tid, sid: randomUUID(), typ: role, roles: [role] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  let nidLine = "", tinLine = "", licLine = "", traLine = "", insLine = "", noteId = "", tagId = "";
  let recheckLine = "", agentNote = "";

  try {
    // ============================================================
    phase("the door: a platform cookie, a duty, and nothing in between");
    check("an anonymous request never reaches the register",
      (await call("/control/customers/board")).status === 401);
    const company = await call("/control/customers/board", { ck: ck("dir") });
    check("a company seat is refused a control desk outright (099)",
      company.status === 401, company.text);
    const noKeys = await call("/control/customers/board", { ck: ck("nd") });
    check(`a platform seat holding none of this desk's duties (${noDuty.key}) is a 403, not an empty list`,
      noKeys.status === 403 && code(noKeys.json) === "FORBIDDEN", noKeys.text);
    check("a platform seat's own bearer token does not open a control desk: only the cookie does",
      (await fetch(`${API}/control/customers/board`, {
        headers: { Authorization: `Bearer ${await mint(uSA, TC, "super_admin")}` }
      })).status === 401);
    check("a check line of another register is not readable from this one",
      (await call("/control/customers/board", { ck: ck("for") })).status === 200);

    const probe = (await call("/control/auth/permissions", { ck: ck("sa") })).json;
    check("the permissions probe lists the five customer duties for a super_admin",
      ["control.customers.view", "control.customers.verify", "control.customers.manage",
        "control.customers.merge", "control.customers.disconnect"]
        .every((k) => (probe?.permissions ?? []).includes(k)), probe?.permissions);
    const paProbe = (await call("/control/auth/permissions", { ck: ck("pa") })).json;
    check("an analyst reads the register and cannot write to it",
      (paProbe?.permissions ?? []).includes("control.customers.view")
      && !(paProbe?.permissions ?? []).includes("control.customers.manage")
      && !(paProbe?.permissions ?? []).includes("control.customers.verify"), paProbe?.permissions);
    check("…and reads the claims register without holding either pen: it may look, not merge, "
      + "and may never see who is signed in",
      (paProbe?.permissions ?? []).includes("control.customers.view")
      && !(paProbe?.permissions ?? []).includes("control.customers.merge")
      && !(paProbe?.permissions ?? []).includes("control.customers.disconnect"),
      paProbe?.permissions);
    const csProbe = (await call("/control/auth/permissions", { ck: ck("cs") })).json;
    check("an agent may raise a line and write a note, and cannot certify a paper",
      (csProbe?.permissions ?? []).includes("control.customers.manage")
      && !(csProbe?.permissions ?? []).includes("control.customers.verify"), csProbe?.permissions);
    check("…and the seat that takes “somebody else is in my account” may end those sessions on the "
      + "call, while the same seat cannot record that two accounts were one",
      (csProbe?.permissions ?? []).includes("control.customers.disconnect")
      && !(csProbe?.permissions ?? []).includes("control.customers.merge"), csProbe?.permissions);
    const coProbe = (await call("/control/auth/permissions", { ck: ck("co") })).json;
    check("the compliance seat holds the answer and the reveal",
      (coProbe?.permissions ?? []).includes("control.customers.verify"), coProbe?.permissions);
    check("…and the claim, because a duplicate is a compliance question before it is a typing "
      + "question", (coProbe?.permissions ?? []).includes("control.customers.merge"),
      coProbe?.permissions);

    // ============================================================
    phase("one vocabulary, three authors, tested by raising every kind");
    const cons = (await oi(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'customer_verifications'::regclass and contype = 'c'`)).rows;
    const tableKinds = tokens(cons.find((c: any) => c.def.startsWith(`CHECK ((kind = ANY`))?.def ?? "", "kind");
    const webSrc = readFileSync("../web/app/control/customers/checks.ts", "utf8");
    const webKinds = [...(webSrc.match(/export const CHECK_KINDS\s*=\s*\[([^\]]*)\]/)?.[1] ?? "")
      .matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    check("the table's CHECK, the route's enum and the desk's list are the same five words",
      tableKinds.length === 5 && tableKinds.join(",") === CHECK_KINDS.join(",")
      && tableKinds.join(",") === webKinds.join(","),
      { table: tableKinds, api: CHECK_KINDS, web: webKinds });

    const raised: Record<string, string> = {};
    for (const kind of tableKinds) {
      const r = await call(`/control/customers/${CO}/checks`, {
        ck: ck("cs"), body: { kind }
      });
      raised[kind] = String(r.json?.check?.id ?? "");
      check(`a ${kind} line can be raised through the route`, r.status === 201 && !!raised[kind],
        r.text.slice(0, 160));
    }
    const sixth = await call(`/control/customers/${CO}/checks`, {
      ck: ck("cs"), body: { kind: "passport" }
    });
    check("a sixth kind the desk invented is a 400 before the register sees it",
      sixth.status === 400 && code(sixth.json) === "VALIDATION_FAILED", sixth.text);
    nidLine = raised["national_id"]; tinLine = raised["tin"]; licLine = raised["trade_licence"];
    traLine = raised["transport_licence"]; insLine = raised["insurance"];

    const dup = await call(`/control/customers/${CO}/checks`, { ck: ck("cs"), body: { kind: "tin" } });
    check("the queue cannot grow twice: a second open line of a kind is refused with the first one's name",
      dup.status === 409 && msg(dup.json).includes("Taxpayer number") && msg(dup.json).includes("Answer that line"),
      msg(dup.json));

    // The shape, the day and the paper are all probed on a line that is already open: the raise
    // route refuses a second open line of a kind before anything else, so a battery aimed at the
    // raise would only ever read that one refusal back.
    const badTin = await call(`/control/customers/checks/${tinLine}/submit`, {
      ck: ck("cs"), body: { reference: "ABCDEFGH12" }
    });
    check("a number of the wrong shape for its kind is refused, and told what the box expects",
      badTin.status === 400 && fields(badTin.json).includes("reference")
      && msg(badTin.json).includes("9 to 12 digits"), msg(badTin.json));
    const shortRef = await call(`/control/customers/checks/${licLine}/submit`, {
      ck: ck("cs"), body: { reference: "TL" }
    });
    check("…and a number too short to quote is refused by the box's own shape first",
      shortRef.status === 400 && fields(shortRef.json).includes("reference"), shortRef.text);
    const dayOnId = await call(`/control/customers/checks/${nidLine}/submit`, {
      ck: ck("cs"), body: { expiresOn: "2027-01-01" }
    });
    check("a day cannot be given to a kind that does not lapse",
      dayOnId.status === 400 && fields(dayOnId.json).includes("expiresOn")
      && msg(dayOnId.json).includes("does not lapse")
      && msg(dayOnId.json).includes("cannot carry a day"), msg(dayOnId.json));
    const raisedDay = await call(`/control/customers/${CO}/checks`, {
      ck: ck("cs"), body: { kind: "tin", expiresOn: "2027-01-01" }
    });
    check("…the same rule holds when the desk tries to raise it that way",
      raisedDay.status === 400 && fields(raisedDay.json).includes("expiresOn"), raisedDay.text);
    const self = await call(`/control/customers/${TC}/checks`, { ck: ck("cs"), body: { kind: "tin" } });
    check("the office does not verify itself — there is no account to raise it on",
      self.status === 404, self.text);
    const shut = await call(`/control/customers/${CX}/checks`, { ck: ck("cs"), body: { kind: "tin" } });
    check("a closed company is refused in the register's own words, not a handler's",
      shut.status === 409 && msg(shut.json).includes("closed"), msg(shut.json));
    const foreignPaper = await call(`/control/customers/checks/${licLine}/submit`, {
      ck: ck("cs"), body: { documentId: FOREIGN }
    });
    check("another account's paper cannot evidence this one's check",
      foreignPaper.status === 409 && msg(foreignPaper.json).includes("another account"),
      msg(foreignPaper.json));
    const gonePaper = await call(`/control/customers/checks/${licLine}/submit`, {
      ck: ck("cs"), body: { documentId: GONE }
    });
    check("a paper that has been filed away cannot carry a check",
      gonePaper.status === 409 && msg(gonePaper.json).includes("filed away"), msg(gonePaper.json));
    const ghostPaper = await call(`/control/customers/checks/${licLine}/submit`, {
      ck: ck("cs"), body: { documentId: randomUUID() }
    });
    check("a paper named out of thin air is a refusal, not a silently dropped pointer",
      ghostPaper.status === 409 && msg(ghostPaper.json).includes("paper"), msg(ghostPaper.json));
    const notAnId = await call("/control/customers/not-a-uuid/checks", {
      ck: ck("cs"), body: { kind: "tin" }
    });
    check("a path parameter that is not an account is a 400 naming nothing else",
      notAnId.status === 400, notAnId.text);

    // ============================================================
    phase("the queue, the board and the picker");
    const queue = await call("/control/customers/checks?status=open&limit=50", { ck: ck("pa") });
    const lines = (queue.json?.rows ?? []).filter((r: any) => r.company_tenant_id === CO);
    check("the open queue holds the five lines this desk raised",
      queue.status === 200 && lines.length === 5, lines.length);
    check("…each named by the account it stands for and the hand that raised it",
      lines.every((r: any) => r.company_name === "Customers Smoke Cargo Ltd"
        && r.raised_name === "Callum Agent"), lines[0]);
    check("…with counts beside it, so the chips are the register's, not the page's",
      ["total", "awaiting", "submitted", "approved", "refused", "expired", "accounts"].every(
        (k) => k in (queue.json?.counts ?? {})), queue.json?.counts);
    check("…and no line of it carries a number, only a boolean and nothing to show",
      lines.every((r: any) => r.has_reference === false && !r.reference_tail
        && !("reference_encrypted" in r)), Object.keys(lines[0] ?? {}));

    const picker = await call("/control/customers/accounts?search=Smoke%20Cargo", { ck: ck("pa") });
    const picked = (picker.json?.rows ?? [])[0] ?? {};
    check("the picker finds the company by the name it trades under",
      picked.id === CO && picked.open_checks === 5 && picked.labels === 0, picked);
    const shutListed = await call("/control/customers/accounts?search=Shut", { ck: ck("pa") });
    check("a closed company is not in the picker — the queue cannot raise anything on it",
      (shutListed.json?.rows ?? []).length === 0, shutListed.json?.rows);

    const board = await call("/control/customers/board?limit=100", { ck: ck("pa") });
    const bRow = (board.json?.rows ?? []).find((r: any) => r.company_tenant_id === CO);
    check("the board lists the account with five kinds owed an answer",
      board.status === 200 && bRow?.checks?.lines === 5 && bRow?.checks?.open === 5
      && bRow?.checks?.approved === 0, bRow?.checks);
    check("…and a trust band travels with the row without being stored anywhere",
      ["score", "band", "factors"].every((k) => k in (bRow?.trust ?? {}))
      && bRow?.trust?.band === "unverified", bRow?.trust);
    check("…the closed company is not on the queue at all",
      !(board.json?.rows ?? []).some((r: any) => r.company_tenant_id === CX));
    const waiting = await call("/control/customers/board?status=waiting", { ck: ck("pa") });
    check("the waiting chip really is the accounts the office owes a decision on",
      (waiting.json?.rows ?? []).some((r: any) => r.company_tenant_id === CO));
    const nonsense = await call("/control/customers/board?status=teleported", { ck: ck("pa") });
    check("a filter word the board does not have is a 400, not an empty page",
      nonsense.status === 400, nonsense.text);

    const dos = await call(`/control/customers/${CO}/dossier`, { ck: ck("pa") });
    check("the dossier answers with the thirteen blocks the desk prints",
      dos.status === 200 && ["company", "profile", "licences", "seats", "actions", "exit", "calls",
        "checks", "notes", "tags", "paper", "trust", "clock"].every((k) => k in dos.json),
      Object.keys(dos.json ?? {}));
    check("…five lines of one account, all of them open",
      (dos.json?.checks ?? []).length === 5
      && (dos.json?.checks ?? []).every((c: any) => c.is_current && !c.reference_tail),
      (dos.json?.checks ?? []).map((c: any) => [c.kind, c.status]));
    const ghost = await call(`/control/customers/${randomUUID()}/dossier`, { ck: ck("pa") });
    check("an account that is not there is a 404, not an empty dossier",
      ghost.status === 404, ghost.text);

    const story = await call(`/control/customers/${CO}/timeline?source=verification`, { ck: ck("pa") });
    check("the story of the checks is the five raises, in the register's own words",
      story.status === 200 && (story.json?.rows ?? []).length === 5
      && (story.json?.rows ?? []).every((r: any) => r.source === "verification"
        && /check raised/.test(r.title)),
      { status: story.status, n: (story.json?.rows ?? []).length, text: story.text.slice(0, 220) });
    const allStory = await call(`/control/customers/${CO}/timeline`, { ck: ck("pa") });
    check("…and the whole story is stamped newest first",
      (allStory.json?.rows ?? []).every((r: any) => !!r.ts)
      && (allStory.json?.rows ?? []).length > 5, allStory.json?.rows?.length);
    const badChip = await call(`/control/customers/${CO}/timeline?source=whatever`, { ck: ck("pa") });
    check("a chip the definer never emits is refused rather than showing an empty story",
      badChip.status === 400, badChip.text);

    // ============================================================
    phase("paper arrives, and an answer is signed");
    const submit = await call(`/control/customers/checks/${nidLine}/submit`, {
      ck: ck("cs"), body: { reference: NID_SPACED }
    });
    check("the number read off the card is stored, and only its tail comes back",
      submit.status === 200 && submit.json?.status === "submitted"
      && submit.json?.reference_tail === NID.slice(-4), submit.json);
    const lic = await call(`/control/customers/checks/${licLine}/submit`, {
      ck: ck("cs"), body: { reference: LICENCE, expiresOn: "2027-06-15", documentId: PAPER }
    });
    check("…a licence carries its day and its paper into the register",
      lic.status === 200 && lic.json?.expires_on === "2027-06-15"
      && lic.json?.reference_tail === LICENCE.slice(-4), lic.json);

    const agentAnswers = await call(`/control/customers/checks/${tinLine}/decide`, {
      ck: ck("cs"), body: { status: "approved", reference: TIN, reason: "" }
    });
    check("the seat that raised the paper is not the seat that certifies it (403)",
      agentAnswers.status === 403, agentAnswers.text);
    const noReason = await call(`/control/customers/checks/${tinLine}/decide`, {
      ck: ck("co"), body: { status: "rejected" }
    });
    check("a refusal has to say what it refused, in the field the desk has to fill",
      noReason.status === 400 && fields(noReason.json).includes("reason"), noReason.text);
    const shortReason = await call(`/control/customers/checks/${tinLine}/decide`, {
      ck: ck("co"), body: { status: "rejected", reason: "unread" }
    });
    check("…and seven characters is not a sentence", shortReason.status === 400, shortReason.text);
    const earlyApprove = await call(`/control/customers/checks/${traLine}/decide`, {
      ck: ck("co"), body: { status: "approved", reason: "Looked fine on the call." }
    });
    check("an approval that has never read a number is refused before the write",
      earlyApprove.status === 400 && fields(earlyApprove.json).includes("reference")
      && msg(earlyApprove.json).includes("read"), msg(earlyApprove.json));
    const daylessApprove = await call(`/control/customers/checks/${insLine}/decide`, {
      ck: ck("co"), body: { status: "approved", reference: INSURANCE }
    });
    check("…as is one that cannot say when the paper runs out",
      daylessApprove.status === 400 && fields(daylessApprove.json).includes("expiresOn"),
      daylessApprove.text);

    const tinAnswer = await call(`/control/customers/checks/${tinLine}/decide`, {
      ck: ck("co"), body: { status: "approved", reference: TIN }
    });
    check("the compliance seat approves the TIN with the number it read",
      tinAnswer.status === 200 && tinAnswer.json?.status === "approved"
      && tinAnswer.json?.reference_tail === TIN.slice(-4) && !!tinAnswer.json?.decided_at,
      tinAnswer.json);
    const insAnswer = await call(`/control/customers/checks/${insLine}/decide`, {
      ck: ck("co"), body: { status: "approved", reference: INSURANCE, expiresOn: "2028-02-29" }
    });
    check("…and the insurance certificate with its number and its day",
      insAnswer.status === 200 && insAnswer.json?.expires_on === "2028-02-29", insAnswer.json);
    const licAnswer = await call(`/control/customers/checks/${licLine}/decide`, {
      ck: ck("co"), body: { status: "rejected",
        reason: "The trade licence shown is expired and names a different proprietor." }
    });
    check("…and a refusal keeps the sentence the account is told",
      licAnswer.status === 200 && licAnswer.json?.status === "rejected"
      && licAnswer.json?.reason?.startsWith("The trade licence shown"), licAnswer.json);

    const again = await call(`/control/customers/checks/${tinLine}/decide`, {
      ck: ck("co"), body: { status: "rejected", reason: "Changed its mind about the same paper." }
    });
    check("an answer is kept: the same seat cannot answer a signed line twice",
      again.status === 409 && msg(again.json).includes("An answer is kept")
      && msg(again.json).includes("Biweta Compliance"), msg(again.json));
    const backToOpen = await call(`/control/customers/checks/${tinLine}/submit`, {
      ck: ck("cs"), body: {}
    });
    check("…nor can the desk that raised it take it back to waiting",
      backToOpen.status === 409 && msg(backToOpen.json).includes("Raise a new line"),
      msg(backToOpen.json));
    const second = await call(`/control/customers/${CO}/checks`, {
      ck: ck("cs"), body: { kind: "trade_licence" }
    });
    recheckLine = String(second.json?.check?.id ?? "");
    check("a re-check is allowed: the refused line stays as history beside a new open one",
      second.status === 201 && !!recheckLine && second.json?.check?.status === "awaiting",
      second.text.slice(0, 200));

    const keptRow = await one(`select status, reference_tail, decided_by,
        md5(reference_encrypted::text) as keep
      from customer_verifications where id = $1`, [tinLine]);
    check("the register itself says the signed answer is what the desk was told",
      keptRow?.status === "approved" && keptRow?.reference_tail === TIN.slice(-4)
      && keptRow?.decided_by === uCO, keptRow);

    // ============================================================
    phase("the one door that decrypts");
    const revealByAgent = await call(`/control/customers/checks/${nidLine}/reference`, { ck: ck("cs") });
    check("the seat that cannot certify a paper cannot read a number either",
      revealByAgent.status === 403, revealByAgent.text);
    const revealEmpty = await call(`/control/customers/checks/${traLine}/reference`, { ck: ck("co") });
    check("a line nothing was ever written on says so, and decrypts nothing",
      revealEmpty.status === 404 && msg(revealEmpty.json).includes("Nothing was ever written"),
      msg(revealEmpty.json));
    const reveal = await call(`/control/customers/checks/${nidLine}/reference`, { ck: ck("co") });
    check("the compliance seat reads back exactly the number the desk typed, spaces stripped",
      reveal.status === 200 && reveal.json?.reference === NID
      && reveal.json?.reference_tail === NID.slice(-4) && reveal.json?.kind === "national_id",
      { status: reveal.status });
    const revealAgain = await call(`/control/customers/checks/${licLine}/reference`, { ck: ck("sa") });
    check("…and a super_admin holds the same door",
      revealAgain.status === 200 && revealAgain.json?.reference === LICENCE, revealAgain.status);
    // Nothing is dropped from `seen`: the sweep at the end of the run reads every body the desk
    // ever received, and excuses only the `/reference` door by name. A leak that happened in an
    // earlier phase is exactly the kind of leak a cleared list would hide.
    for (let i = 0; i < 12; i++) {
      await call(`/control/customers/checks/${nidLine}/reference`, { ck: ck("co") });
    }
    const limited = await call(`/control/customers/checks/${nidLine}/reference`, { ck: ck("co") });
    check("a thirteenth read in the same hour is refused: a reveal is a countable act",
      limited.status === 429 && code(limited.json) === "RATE_LIMITED", limited.text);
    const auditReveal = await one(`select action, ip, user_agent, after
      from audit_logs where entity = 'customer_verifications' and entity_id = $1
        and action = 'control.customers.reference_revealed' order by ts desc limit 1`,
      [nidLine]);
    check("every reveal is written into the audit register with the tail, never the number",
      !!auditReveal && JSON.stringify(auditReveal.after).includes(NID.slice(-4))
      && !JSON.stringify(auditReveal.after).includes(NID) && auditReveal.ip === "127.0.0.1"
      && auditReveal.user_agent === "smoke-customers",
      { found: !!auditReveal, ip: auditReveal?.ip, ua: auditReveal?.user_agent,
        after: JSON.stringify(auditReveal?.after ?? {}).slice(0, 160) });

    // ============================================================
    phase("the office's own words");
    const short = await call(`/control/customers/${CO}/notes`, { ck: ck("cs"), body: { text: "ok" } });
    check("a note of two characters is a mark, not a sentence, and the route says so",
      short.status === 400 && fields(short.json).includes("text"), short.text);
    const written = await call(`/control/customers/${CO}/notes`, {
      ck: ck("cs"), body: { text: `The caller read the licence number back over the phone. ${MARK}` }
    });
    noteId = String(written.json?.id ?? "");
    check("a note is written with the hand that wrote it",
      written.status === 201 && written.json?.author === uCS && !!noteId, written.json);
    const edited = await call(`/control/customers/notes/${noteId}/edit`, {
      ck: ck("co"), body: { text: `Rewritten after the second caller rang. ${MARK}` }
    });
    check("another seat may correct a note, and cannot take it over",
      edited.status === 200 && edited.json?.author === uCS && !!edited.json?.edited_at, edited.json);
    const searched = await call(`/control/customers/notes?search=${encodeURIComponent("second caller")}`,
      { ck: ck("pa") });
    check("a clerk can search for a sentence rather than for the company it was written about",
      (searched.json?.rows ?? []).some((r: any) => r.id === noteId
        && r.company_name === "Customers Smoke Cargo Ltd" && r.author_name === "Callum Agent"),
      searched.json?.rows?.length);
    const withdrawn = await call(`/control/customers/notes/${noteId}/void`, {
      ck: ck("cs"), body: { reason: "It named the wrong licence number for the second caller." }
    });
    check("a withdrawal has to say why, and keeps the text it withdrew",
      withdrawn.status === 200 && withdrawn.json?.void_reason?.startsWith("It named the wrong"),
      withdrawn.json);
    const editGone = await call(`/control/customers/notes/${noteId}/edit`, {
      ck: ck("cs"), body: { text: "Trying to rewrite what was withdrawn." }
    });
    check("a withdrawn note cannot be rewritten — its text is what the withdrawal was about",
      editGone.status === 409 && msg(editGone.json).includes("withdrawn"), msg(editGone.json));
    const voidAgain = await call(`/control/customers/notes/${noteId}/void`, {
      ck: ck("cs"), body: { reason: "Withdrawing it a second time means nothing." }
    });
    check("…nor withdrawn twice", voidAgain.status === 409, voidAgain.text);
    const agentNoteWrite = await call(`/control/customers/${CF}/notes`, {
      ck: ck("cs"), body: { text: `A note about a company nobody in this run owns. ${MARK}` }
    });
    agentNote = String(agentNoteWrite.json?.id ?? "");
    check("a note can be written about any live account on the platform",
      agentNoteWrite.status === 201 && !!agentNote, agentNoteWrite.text.slice(0, 160));

    // ============================================================
    phase("the labels");
    const badName = await call("/control/customers/tags", {
      ck: ck("cs"), body: { name: "x", colour: "#7c3aed" }
    });
    check("a label of one character is refused by the route's own shape", badName.status === 400,
      badName.text);
    const badColour = await call("/control/customers/tags", {
      ck: ck("cs"), body: { name: "violet-trial", colour: "violet" }
    });
    check("a colour a picker cannot paint is refused", badColour.status === 400, badColour.text);
    const tag = await call("/control/customers/tags", {
      ck: ck("cs"), body: { name: "KYC-Hold", colour: "#b45309",
        note: "Held pending the second trade licence." }
    });
    tagId = String(tag.json?.id ?? "");
    check("a label is created, and the case the clerk typed is folded into the library's word",
      tag.status === 201 && tag.json?.name === "kyc-hold" && !!tagId, tag.json);
    const twiceTag = await call("/control/customers/tags", {
      ck: ck("cs"), body: { name: "KYC-Hold" }
    });
    check("…because the library holds one live word, and says so",
      twiceTag.status === 409 && msg(twiceTag.json).includes("Retire it first"), msg(twiceTag.json));
    const wear = await call(`/control/customers/${CO}/tags`, { ck: ck("cs"), body: { tagId } });
    check("the account wears the label", wear.status === 201 && wear.json?.tag_name === "kyc-hold",
      wear.json);
    const wearAgain = await call(`/control/customers/${CO}/tags`, { ck: ck("cs"), body: { tagId } });
    check("and cannot wear it twice", wearAgain.status === 409 && msg(wearAgain.json).includes("already"),
      msg(wearAgain.json));
    const wearers = await call(`/control/customers/tags/${tagId}/wearers`, { ck: ck("pa") });
    check("the desk can name every account a live label is on",
      (wearers.json?.rows ?? []).some((r: any) => r.company_tenant_id === CO), wearers.json?.rows);
    const boardTagged = await call("/control/customers/board?search=Smoke%20Cargo", { ck: ck("pa") });
    check("…and a worn label reaches the board as a chip with its colour",
      (boardTagged.json?.rows ?? [])[0]?.tags?.some((t: any) => t.name === "kyc-hold"
        && t.colour === "#b45309"), (boardTagged.json?.rows ?? [])[0]?.tags);
    const foreignBoard = await call("/control/customers/board?search=Smoke%20Cargo", { ck: ck("for") });
    check("…while another office's register sees the account and none of this desk's labels",
      (foreignBoard.json?.rows ?? [])[0]?.tags?.length === 0
      && (foreignBoard.json?.rows ?? [])[0]?.company_tenant_id === CO,
      (foreignBoard.json?.rows ?? [])[0]?.tags);
    const retireWorn = await call(`/control/customers/tags/${tagId}/retire`, { ck: ck("cs"), method: "POST" });
    check("a label still being worn cannot be retired out from under the accounts",
      retireWorn.status === 409 && msg(retireWorn.json).includes("1 account still wears"),
      msg(retireWorn.json));
    const takenOff = await call(`/control/customers/${CO}/tags/retire`, { ck: ck("cs"), body: { tagId } });
    check("the pairing is retired, not deleted", takenOff.status === 200
      && !!takenOff.json?.id && !!takenOff.json?.deleted_at, takenOff.json);
    const takeAgain = await call(`/control/customers/${CO}/tags/retire`, { ck: ck("cs"), body: { tagId } });
    check("taking it off a second time finds nothing live and says so", takeAgain.status === 404,
      takeAgain.text);
    const retired = await call(`/control/customers/tags/${tagId}/retire`, {
      ck: ck("cs"), method: "POST"
    });
    check("once no account wears it the word can leave the library", retired.status === 200,
      retired.text);
    const reWear = await call(`/control/customers/${CO}/tags`, { ck: ck("cs"), body: { tagId } });
    check("…and a withdrawn word cannot be put back on an account",
      reWear.status === 409 && msg(reWear.json).includes("withdrawn"), msg(reWear.json));

    // ============================================================
    phase("the five CSVs");
    for (const [register, head] of [
      ["accounts", "name,type,account_status,slug,plan_name,created_at,trial_ends_at,"
        + "licence_expires_at,open_checks,approved,refused,expired,seats,tags,trust,blocked_note,"
        + "last_note"],
      ["checks", "company_name,company_type,kind,status,reference_tail,expires_on,reason,"
        + "raised_name,raised_at,decided_name,decided_at,has_reference"],
      ["notes", "company_name,body,author_name,created_at,edited_at,voided_by_name,voided_at,"
        + "void_reason"],
      ["tags", "company_name,name,colour,applied_by_name,applied_at,removed_by_name,removed_at"],
      ["claims", "survivor_name,loser_name,loser_closed_at,status,reason,carried_kinds,"
        + "raised_name,raised_at,voided_name,voided_at,void_reason"]
    ] as [string, string][]) {
      const file = await call(`/control/customers/export?register=${register}`, { ck: ck("pa") });
      // The writer quotes every cell, so the assertion is about the column names it chose, not the
      // quoting around them.
      const first = file.text.split("\n")[0].replace(/\r/g, "").replace(/"/g, "");
      check(`the ${register} export is a CSV with the columns the desk reads`,
        file.status === 200 && first === head, { status: file.status, first });
    }
    const checkCsv = await call("/control/customers/export?register=checks", { ck: ck("pa") });
    check("…the checks file names the tail a clerk can quote, and no identity number",
      checkCsv.text.includes(NID.slice(-4)) && !checkCsv.text.includes(NID)
      && !checkCsv.text.includes(TIN), checkCsv.text.slice(0, 200));
    const accountCsv = await call("/control/customers/export?register=accounts&search=Smoke%20Cargo",
      { ck: ck("pa") });
    const trustRow = (await one(`select platform_auth.customer_trust($1) as t`, [CO]))?.t as any;
    check("…the accounts file carries the trust read as the number, the band and the factors the "
      + "definer answers with, none of which is stored anywhere",
      accountCsv.text.includes(`${trustRow?.score} (${trustRow?.band}`)
      && accountCsv.text.includes("Cargo Ltd"), {
      trust: trustRow?.score, band: trustRow?.band, text: accountCsv.text.slice(0, 240) });
    const badState = await call("/control/customers/export?register=checks&status=teleported",
      { ck: ck("pa") });
    check("a typo in an export filter is a refusal naming the words that exist, not an empty file",
      badState.status === 400 && msg(badState.json).includes("awaiting") && fields(badState.json)
        .includes("status"), msg(badState.json));
    const badKind = await call("/control/customers/export?register=checks&kind=passport", { ck: ck("pa") });
    check("…and the same for a kind", badKind.status === 400 && msg(badKind.json).includes("national_id"),
      msg(badKind.json));

    // ============================================================
    phase("what nothing on this desk may show");
    // The reveal is the one door allowed to answer with the whole number, so its own bodies are
    // beside the sweep; everything else the desk read has to be free of it.
    const sweepReads = seen.filter((s) => !s.where.includes("/reference")
      && (s.text.includes(NID) || s.text.includes(TIN)
        || s.text.includes(INSURANCE.replace(/[^A-Z0-9]/g, ""))));
    check("no board, queue, dossier, timeline, CSV or answer response carried an identity number",
      sweepReads.length === 0, sweepReads.map((s) => s.where));
    const rawLine = await call(`/control/customers/checks/${nidLine}`, { ck: ck("pa") });
    check("and the one line read is the tail plus a boolean, never the bytes",
      rawLine.status === 200 && !("encrypted" in rawLine.json)
      && rawLine.json?.has_reference === true && rawLine.json?.reference_tail === NID.slice(-4),
      Object.keys(rawLine.json ?? {}));

    const storyAfter = await call(`/control/customers/${CO}/timeline?source=verification`,
      { ck: ck("pa") });
    const storyRows = (storyAfter.json?.rows ?? []) as any[];
    const raisedN = storyRows.filter((r) => /check raised/.test(r.title)).length;
    const answeredN = storyRows.filter((r) =>
      / approved$| refused$| — more information asked$/.test(r.title)).length;
    const asTable = await one(`select count(*)::int as lines,
        count(*) filter (where decided_at is not null)::int as answered
      from customer_verifications where company_tenant_id = $1`, [CO]);
    check("the story now holds every line ever raised on the account and every answer the register "
      + "signed — a submission is the same line with paper on it, not a second event",
      raisedN === asTable?.lines && answeredN === asTable?.answered && answeredN === 3, {
      raised: raisedN, answered: answeredN, table: asTable });
    check("…and an answer names the seat that signed it",
      storyRows.some((r) => / approved$/.test(r.title) && r.actor === "Biweta Compliance"),
      storyRows.filter((r) => / refused| approved/.test(r.title)).map((r) => [r.title, r.actor]));

    // ============================================================
    phase("every write is in the register of writes");
    const audits = (await oi(`select action, count(*)::int as n from audit_logs
      where tenant_id = $1 and action like 'control.customers.%' group by action`, [TC])).rows;
    const wantActions = ["control.customers.check_raised", "control.customers.check_submitted",
      "control.customers.check_decided", "control.customers.reference_revealed",
      "control.customers.note_written", "control.customers.note_edited",
      "control.customers.note_withdrawn", "control.customers.tag_created",
      "control.customers.tag_applied", "control.customers.tag_removed", "control.customers.tag_retired"];
    check("the eleven acts of the register left an audit row each",
      wantActions.every((a) => audits.some((r: any) => r.action === a)),
      audits.map((r: any) => r.action));
    const before = await one(`select before, after from audit_logs
      where tenant_id = $1 and action = 'control.customers.check_decided'
      order by ts desc limit 1`, [TC]);
    check("…carrying what the line was before and what it is after",
      JSON.stringify(before?.before).includes("submitted")
      || JSON.stringify(before?.before).includes("awaiting"), JSON.stringify(before?.before));
    const revealCount = await one(`select count(*)::int as n from audit_logs
      where action = 'control.customers.reference_revealed' and tenant_id = $1`, [TC]);
    check("…one row per reveal, so a number read fourteen times is fourteen questions answered",
      revealCount?.n >= 3, revealCount);

    // ============================================================
    phase("the numbers the desk prints are the numbers the register holds");
    const tally = await one(`select count(*)::int as lines,
        count(*) filter (where status = 'approved')::int as approved,
        count(*) filter (where status = 'rejected')::int as refused,
        count(*) filter (where status in ('awaiting','submitted'))::int as open,
        count(distinct kind)::int as kinds
      from customer_verifications where company_tenant_id = $1`, [CO]);
    const queue2 = await call("/control/customers/checks?limit=50", { ck: ck("pa") });
    const mine = (queue2.json?.rows ?? []).filter((r: any) => r.company_tenant_id === CO);
    const board2 = await call("/control/customers/board?search=Smoke%20Cargo", { ck: ck("pa") });
    const b2 = (board2.json?.rows ?? [])[0];
    check("the queue is every row this account has ever carried, including the refused line the "
      + "board no longer counts", mine.length === tally?.lines, { queue: mine.length, table: tally });
    check("the board counts the line that stands for each kind, not every row on the file",
      b2?.checks?.lines === tally?.kinds
      && b2?.checks?.approved + b2?.checks?.refused + b2?.checks?.open === b2?.checks?.lines
      && b2?.checks?.approved === tally?.approved && b2?.checks?.refused === 0
      && b2?.checks?.open === tally?.kinds - tally?.approved, { board: b2?.checks, table: tally });
    const dos2 = await call(`/control/customers/${CO}/dossier`, { ck: ck("pa") });
    check("…while the dossier keeps all of the rows, so the history is still readable",
      (dos2.json?.checks ?? []).length === tally?.lines, {
        dossier: (dos2.json?.checks ?? []).length, table: tally?.lines });
    const trustNow = await one(`select platform_auth.customer_trust($1) as t`, [CO]);
    check("and the trust read the board prints is the one the definer answers",
      trustNow?.t?.score === b2?.trust?.score && trustNow?.t?.band === b2?.trust?.band,
      { definer: trustNow?.t?.score, board: b2?.trust?.score });
    check("…with the approved papers in its factors, which is what an answer is for",
      (trustNow?.t?.factors ?? []).some((f: any) => f.label === "checked and approved"),
      trustNow?.t?.factors);

    // ============================================================
    phase("the claim and the cut-off (128)");
    const seenAt = seen.length;
    /** A refusal this desk shows a clerk is either the route's `error.message` or the preview's own
     *  `refusal` field — the second one is not an error, it is the answer to a question the desk
     *  asked before deciding. Both are read the same way here. */
    const refuse = (j: any) => String(j?.refusal ?? j?.error?.message ?? j?.message ?? "");
    // A claim is only ever about an account the office has already shut, and 127's own guard refuses
    // a check line written against a closed account — which is exactly why a carry arrives as a NEW
    // line rather than by moving one. So the closed fixture is opened, given three real register
    // lines through the routes, and shut again. Everything below depends on which of those three
    // the survivor still owes an answer on.
    await oi(`update tenants set deleted_at = null, status = 'active' where id = $1`, [CX]);
    const cxInsRaise = await call(`/control/customers/${CX}/checks`, {
      ck: ck("cs"), body: { kind: "insurance" } });
    const cxIns = String(cxInsRaise.json?.check?.id ?? "");
    const cxInsSubmit = await call(`/control/customers/checks/${cxIns}/submit`, {
      ck: ck("cs"), body: { reference: CX_INSURANCE } });
    const cxTinRaise = await call(`/control/customers/${CX}/checks`, {
      ck: ck("cs"), body: { kind: "tin" } });
    const cxTin = String(cxTinRaise.json?.check?.id ?? "");
    const cxTinAnswer = await call(`/control/customers/checks/${cxTin}/decide`, {
      ck: ck("co"), body: { status: "approved", reference: CX_TIN } });
    const cxTraRaise = await call(`/control/customers/${CX}/checks`, {
      ck: ck("cs"), body: { kind: "transport_licence" } });
    check("the account that will be named as the extra one holds one answered, one submitted and "
      + "one awaiting check", [cxInsRaise, cxTinRaise, cxTraRaise].every((r) => r.status === 201)
      && cxInsSubmit.status === 200 && cxTinAnswer.status === 200,
      { ins: cxInsRaise.status, submitted: cxInsSubmit.status, tin: cxTinRaise.status,
        answered: cxTinAnswer.status, transport: cxTraRaise.status });
    await oi(`update tenants set deleted_at = now(), status = 'suspended' where id = $1`, [CX]);
    // 106's read-only visit is a session on the company wearing one of its seats, with the office's
    // seat named in `actor_user_id`. It is the row a cut-off has to reach that the fixture's own
    // seven do not, so it is opened here and the answer has to count it.
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, actor_user_id, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,$6,'smoke-customers','127.0.0.1',
        now() + interval '2 hours')`,
      [randomUUID(), uDir, CO, randomUUID(), sha256(`cu-smoke-visit-${MARK}`), uCS]);

    const liveLoser = await call(`/control/customers/duplicates/${CO}/${CF}`, { ck: ck("pa") });
    check("a live account cannot be the extra one, and the desk is told that before it writes, "
      + "pointing at the two-seat door", liveLoser.status === 200
      && liveLoser.json?.eligible === false && refuse(liveLoser.json).includes("still live")
      && refuse(liveLoser.json).includes("two-seat"), liveLoser.json?.refusal);
    const officeHalf = await call(`/control/customers/duplicates/${TC}/${CX}`, { ck: ck("pa") });
    check("the office is not an account on the platform, so the preview says it cannot be either "
      + "half — in words, on the same 200 that carries a live pair, because a refusal to claim is "
      + "what the clerk is choosing between, not a fault",
      officeHalf.status === 200 && officeHalf.json?.eligible === false
      && officeHalf.json?.survivor?.type === "platform"
      && refuse(officeHalf.json).includes("not an account on the platform"), officeHalf.json?.refusal);
    const noSurvivor = await call(`/control/customers/duplicates/${randomUUID()}/${CX}`,
      { ck: ck("pa") });
    check("an account the office has never seen is a 404 that says which half of the pair is missing",
      noSurvivor.status === 404 && refuse(noSurvivor.json).includes("carry on"),
      refuse(noSurvivor.json));
    const noLoser = await call(`/control/customers/duplicates/${CO}/${randomUUID()}`, { ck: ck("pa") });
    check("…and the same when it is the extra one that is missing",
      noLoser.status === 404 && refuse(noLoser.json).includes("named as the extra one"),
      refuse(noLoser.json));

    // The clerk chooses the extra account out of a list, and the list every other write on this
    // desk uses is the live one — a tombstone is not on it. `?closed=1` is the other half of the
    // picker, and the claim is unraisable without it.
    const closedPicker = await call(`/control/customers/accounts?closed=1&search=Shut`, { ck: ck("pa") });
    const shutRow = (closedPicker.json?.rows ?? []).find((r: any) => r.id === CX);
    check("a claim's extra account is chosen from the closed list, which is the only list it can "
      + "be on", closedPicker.status === 200 && !!shutRow
      && shutRow.name === "Customers Smoke Shut Ltd"
      && !!shutRow.deleted_at && !!shutRow.created_at, shutRow);
    check("…and the closed list holds no live account, so the desk cannot name a survivor there",
      (closedPicker.json?.rows ?? []).every((r: any) => !!r.deleted_at)
      && !(closedPicker.json?.rows ?? []).some((r: any) => r.id === CO),
      (closedPicker.json?.rows ?? []).length);
    const livePicker = await call(`/control/customers/accounts?search=Customers%20Smoke`, { ck: ck("pa") });
    check("the picker a check is raised from still excludes every closed account, including the "
      + "one just named", (livePicker.json?.rows ?? []).some((r: any) => r.id === CO)
      && !(livePicker.json?.rows ?? []).some((r: any) => r.id === CX),
      (livePicker.json?.rows ?? []).map((r: any) => r.name));
    const closedBadFlag = await call(`/control/customers/accounts?closed=yes`, { ck: ck("pa") });
    check("a flag the picker does not have is a 400 rather than a silent change of list",
      closedBadFlag.status === 400, closedBadFlag.text.slice(0, 160));

    const prev = await call(`/control/customers/duplicates/${CO}/${CX}`, { ck: ck("pa") });
    check("the eligible pair is eligible: one open check would move, and the preview names the "
      + "number it was read from", prev.status === 200 && prev.json?.eligible === true
      && prev.json?.refusal === null && (prev.json?.carries ?? []).length === 1
      && prev.json?.carries[0]?.kind === "insurance"
      && prev.json?.carries[0]?.loser_tail === CX_INSURANCE.slice(-4)
      && prev.json?.carries[0]?.loser_status === "submitted",
      { eligible: prev.json?.eligible, carries: prev.json?.carries });
    check("…and the kind the survivor already owes an answer on is skipped, not doubled",
      (prev.json?.skips ?? []).length === 1
      && prev.json?.skips[0]?.kind === "transport_licence"
      && refuse(prev.json?.skips[0]).length === 0
      && String(prev.json?.skips[0]?.because).includes("already has an open"),
      prev.json?.skips);
    check("…the preview counts what stays behind instead of letting “merged” mean everything moved — "
      + "and the line that moves is not also counted as staying",
      prev.json?.stays_behind?.checks_answered === 1
      && prev.json?.stays_behind?.checks_open === 1
      && prev.json?.stays_behind?.notes === 0
      && prev.json?.stays_behind?.papers === 0
      && prev.json?.stays_behind?.sessions_live === 0, prev.json?.stays_behind);
    check("…and nothing stands between this pair yet", (prev.json?.already ?? []).length === 0,
      prev.json?.already);

    const sameTwice = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("sa"), body: { loser: CO, reason: "The same account named twice is not a pair." } });
    check("a claim needs two accounts, and the route says so before the register is asked",
      sameTwice.status === 400 && fields(sameTwice.json).includes("loser"), sameTwice.text);
    const briefReason = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("sa"), body: { loser: CX, reason: "same" } });
    check("seven characters is not a reason: a claim has to say what makes them one account",
      briefReason.status === 400 && fields(briefReason.json).includes("reason"), briefReason.text);
    const claimLive = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("sa"), body: { loser: CF, reason: "Both accounts were signed up by one director." } });
    check("claiming a live account is refused in the register's own words, with the second "
      + "signature it is waiting for", claimLive.status === 409
      && refuse(claimLive.json).includes("still a live account")
      && refuse(claimLive.json).includes("second signature"), refuse(claimLive.json));
    const claimClosed = await call(`/control/customers/${CX}/duplicates`, {
      ck: ck("sa"), body: { loser: CF, reason: "A closed account cannot carry on as anything." } });
    check("…and so is a claim written on a closed account: the survivor has to be the live one",
      claimClosed.status === 409
      && refuse(claimClosed.json).includes("cannot be the one that survives"),
      refuse(claimClosed.json));
    const claimOffice = await call(`/control/customers/${TC}/duplicates`, {
      ck: ck("sa"), body: { loser: CX, reason: "The office is not a customer of itself." } });
    check("…and the office cannot be the account that survives, because the picker never "
      + "offers it", claimOffice.status === 404, claimOffice.text.slice(0, 160));
    const analystClaim = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("pa"), body: { loser: CX, reason: "An analyst reads the register and signs nothing." } });
    check("the seat that may read the claims register may not write one (403)",
      analystClaim.status === 403 && code(analystClaim.json) === "FORBIDDEN", analystClaim.text);
    const agentClaim = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("cs"), body: { loser: CX, reason: "The agent labels accounts; it does not merge them." } });
    check("…nor can the seat that holds `manage`: a claim leans on a closure two seats signed",
      agentClaim.status === 403, agentClaim.text);

    const claim = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("sa"), body: { loser: CX,
        reason: "Both accounts were signed up by the same director with the same taxpayer number." } });
    const claimId = String(claim.json?.claim?.id ?? "");
    check("the office declares the closed account the extra one of the live account",
      claim.status === 201 && claim.json?.status === "ok" && !!claimId
      && claim.json?.claim?.status === "declared"
      && claim.json?.claim?.survivor?.name === "Customers Smoke Cargo Ltd"
      && claim.json?.claim?.loser?.name === "Customers Smoke Shut Ltd"
      && !!claim.json?.claim?.loser?.closed_at
      && claim.json?.claim?.raised_name === "Amani Super", claim.text.slice(0, 260));
    check("…and the claim names the one kind it carried, not the two a clerk might have expected",
      JSON.stringify(claim.json?.claim?.carried_kinds) === '["insurance"]'
      && JSON.stringify(claim.json?.carried) === '[{"kind":"insurance"}]',
      { carried_kinds: claim.json?.claim?.carried_kinds, carried: claim.json?.carried });
    check("…the survivor owes an insurance answer it did not owe an hour ago",
      (claim.json?.survivor_open_kinds ?? []).includes("insurance")
      && (claim.json?.survivor_open_kinds ?? []).length === 4, claim.json?.survivor_open_kinds);
    const carriedLine = await one(`select id, status, (reference_encrypted is not null) as has_number,
        reference_tail, reason, raised_by, (document_id is not null) as has_paper
      from customer_verifications where company_tenant_id = $1 and kind = 'insurance'
        and status = 'awaiting'`, [CO]);
    check("the line that arrived is a new one: no number copied off the other account's paper, no "
      + "reason, no document — only the question", !!carriedLine
      && carriedLine.has_number === false && carriedLine.reference_tail === null
      && carriedLine.reason === null && carriedLine.has_paper === false
      && carriedLine.raised_by === uSA, carriedLine);
    const loserLine = await one(`select status, reference_tail from customer_verifications
      where id = $1`, [cxIns]);
    check("…while the closed account's own submitted line stays where it was, number and all",
      loserLine?.status === "submitted"
      && loserLine?.reference_tail === CX_INSURANCE.slice(-4), loserLine);
    const stayedPut = await one(`select count(*)::int as answered from customer_verifications
      where company_tenant_id = $1 and status = 'approved'`, [CX]);
    check("…and an answer the office already signed is not moved by a claim",
      stayedPut?.answered === 1, stayedPut);
    const mergeNote = await one(`select body from customer_notes where id = $1`,
      [claim.json?.note_id]);
    check("the survivor's file says what happened, in the register's own sentence",
      !!mergeNote && mergeNote.body.startsWith("Duplicate of Customers Smoke Shut Ltd, closed")
      && mergeNote.body.includes("new lines to be checked: insurance")
      && mergeNote.body.includes("stay on its own file"), mergeNote?.body?.slice(0, 240));
    const claimStory = await call(`/control/customers/${CO}/timeline?source=note`, { ck: ck("pa") });
    check("…which is why the claim is legible on the account's own story, not only in a register "
      + "nobody opens", (claimStory.json?.rows ?? []).some((r: any) =>
        /Duplicate of Customers Smoke Shut Ltd/.test(String(r.detail))),
      (claimStory.json?.rows ?? []).slice(0, 2).map((r: any) => String(r.detail).slice(0, 60)));
    const claimTwice = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("sa"), body: { loser: CX, reason: "Trying to write the same claim a second time." } });
    check("a pair already on the register cannot be claimed twice, and the answer names the "
      + "survivor that holds it", claimTwice.status === 409
      && refuse(claimTwice.json).includes("already declared the extra one of Customers Smoke Cargo Ltd")
      && refuse(claimTwice.json).includes("Withdraw that claim"), refuse(claimTwice.json));
    const otherSurvivor = await call(`/control/customers/${CF}/duplicates`, {
      ck: ck("sa"), body: { loser: CX, reason: "A different account claims the same closed one." } });
    check("…nor can a second account claim the same closed one: one closed account is the extra "
      + "one of one account only", otherSurvivor.status === 409
      && refuse(otherSurvivor.json).includes("Cargo Ltd"), refuse(otherSurvivor.json));
    const afterPrev = await call(`/control/customers/duplicates/${CO}/${CX}`, { ck: ck("pa") });
    check("…and the preview says so before the desk tries again",
      (afterPrev.json?.already ?? []).length === 1
      && afterPrev.json?.already[0]?.status === "declared"
      && afterPrev.json?.already[0]?.direction === "same", afterPrev.json?.already);
    const reversed = await call(`/control/customers/duplicates/${CX}/${CO}`, { ck: ck("pa") });
    check("…in whichever order the two accounts are named",
      (reversed.json?.already ?? []).length === 1
      && reversed.json?.already[0]?.direction === "reversed"
      && reversed.json?.eligible === false,
      { already: reversed.json?.already, refusal: reversed.json?.refusal });

    const ghostVoid = await call(`/control/customers/duplicates/${randomUUID()}/void`, {
      ck: ck("sa"), body: { reason: "There is no claim on this office's register with that number." } });
    check("a claim the office has never seen is a 404 rather than a rollback",
      ghostVoid.status === 404 && refuse(ghostVoid.json).includes("not on this office"),
      refuse(ghostVoid.json));
    const briefVoid = await call(`/control/customers/duplicates/${claimId}/void`, {
      ck: ck("sa"), body: { reason: "oops" } });
    check("taking a claim back needs a sentence as good as the one that made it",
      briefVoid.status === 400 && fields(briefVoid.json).includes("reason"), briefVoid.text);
    const agentVoid = await call(`/control/customers/duplicates/${claimId}/void`, {
      ck: ck("cs"), body: { reason: "An agent cannot take back what it cannot declare." } });
    check("and the withdrawal is the merge duty's, not the note-writer's", agentVoid.status === 403,
      agentVoid.text);
    const voided = await call(`/control/customers/duplicates/${claimId}/void`, {
      ck: ck("co"), body: { reason: "The taxpayer number on the second account is the first one's, "
        + "mistyped by the bank — they were never the same proprietor." } });
    check("a second seat takes the claim back, and the claim keeps both hands",
      voided.status === 200 && voided.json?.claim?.status === "voided"
      && voided.json?.claim?.voided_name === "Biweta Compliance"
      && String(voided.json?.claim?.void_reason).startsWith("The taxpayer number")
      && voided.json?.claim?.carried_kinds?.join(",") === "insurance", voided.json);
    const carriedStill = await one(`select count(*)::int as open from customer_verifications
      where company_tenant_id = $1 and kind = 'insurance' and status = 'awaiting'`, [CO]);
    check("the carried line stays: it is the survivor's own check now, and an answer once owed is "
      + "not un-owed", carriedStill?.open === 1, carriedStill);
    const voidNote = await one(`select body from customer_notes where id = $1`,
      [voided.json?.note_id]);
    check("…and the file says the withdrawal happened and why the checks did not go back",
      !!voidNote && voidNote.body.includes("That duplicate claim was withdrawn")
      && voidNote.body.includes("stay on this file")
      && voidNote.body.includes("mistyped by the bank"), voidNote?.body?.slice(0, 240));
    const voidTwice = await call(`/control/customers/duplicates/${claimId}/void`, {
      ck: ck("co"), body: { reason: "Withdrawing the same claim a second time says nothing." } });
    check("a withdrawal is not edited, and cannot be withdrawn twice", voidTwice.status === 409
      && refuse(voidTwice.json).includes("already withdrawn on"), refuse(voidTwice.json));
    const reClaim = await call(`/control/customers/${CO}/duplicates`, {
      ck: ck("sa"), body: { loser: CX, reason: "Raised again on the strength of the identity number "
        + "both accounts share, and this time the office holds the second note." } });
    check("after a withdrawal the pair can be claimed again, and the register says what it carries "
      + "this time — nothing, because the survivor already owes that insurance answer",
      reClaim.status === 201 && JSON.stringify(reClaim.json?.claim?.carried_kinds) === "[]"
      && JSON.stringify(reClaim.json?.carried) === "[]",
      { status: reClaim.status, carried: reClaim.json?.claim?.carried_kinds,
        text: reClaim.text.slice(0, 200) });

    const register = await call("/control/customers/duplicates?limit=50", { ck: ck("pa") });
    const claims = (register.json?.claims ?? []) as any[];
    check("the claims register lists both halves by name, newest first, with the hands that wrote "
      + "and unwrote them", claims.length === 2
      && claims[0]?.survivor_name === "Customers Smoke Cargo Ltd"
      && claims[0]?.loser_name === "Customers Smoke Shut Ltd"
      && !!claims[0]?.loser_closed_at && claims[0]?.status === "declared"
      && claims[1]?.status === "voided" && claims[1]?.voided_name === "Biweta Compliance",
      { n: claims.length, first: claims[0], second: claims[1] });
    check("…with the register's own counts beside it, so a chip says what it filtered out of, and "
      + "the carried count is standing claims that moved something — the claim that moved one is "
      + "withdrawn, and the one standing now moved nothing",
      register.json?.counts?.all === 2 && register.json?.counts?.standing === 1
      && register.json?.counts?.withdrawn === 1 && register.json?.counts?.carried === 0,
      register.json?.counts);
    const onlyVoided = await call("/control/customers/duplicates?status=voided", { ck: ck("pa") });
    const onlyDeclared = await call("/control/customers/duplicates?status=declared", { ck: ck("pa") });
    check("a state chip filters the list and not the counts",
      (onlyVoided.json?.claims ?? []).length === 1
      && (onlyDeclared.json?.claims ?? []).length === 1
      && onlyVoided.json?.counts?.all === 2,
      { voided: (onlyVoided.json?.claims ?? []).length, counts: onlyVoided.json?.counts });
    check("…and every claim line carries how many the filter matched, because the desk's pager "
      + "reads it off the rows and would otherwise say “0 rows” above a row it is showing",
      claims[0]?.total === 2 && onlyVoided.json?.claims[0]?.total === 1
      && onlyDeclared.json?.claims[0]?.total === 1,
      { all: claims[0]?.total, voided: onlyVoided.json?.claims[0]?.total,
        declared: onlyDeclared.json?.claims[0]?.total });
    const hunted = await call("/control/customers/duplicates?search=Shut", { ck: ck("pa") });
    check("…and a clerk can search the register by the closed account's name",
      (hunted.json?.claims ?? []).length === 2, (hunted.json?.claims ?? []).length);
    const badClaimFilter = await call("/control/customers/duplicates?status=teleported",
      { ck: ck("pa") });
    check("a word the register does not have is a 400 naming the two it does, not an empty page",
      badClaimFilter.status === 400, badClaimFilter.text.slice(0, 200));
    const foreignRegister = await call("/control/customers/duplicates?limit=50", { ck: ck("for") });
    check("another office's register holds none of these claims",
      (foreignRegister.json?.claims ?? []).length === 0
      && foreignRegister.json?.counts?.all === 0, foreignRegister.json?.counts);

    const access = await call(`/control/customers/${CO}/access`, { ck: ck("cs") });
    check("the seat that takes the stolen-password call can see who is in the account",
      access.status === 200 && access.json?.company?.name === "Customers Smoke Cargo Ltd"
      && access.json?.seats === 1 && access.json?.live === 2
      && access.json?.borrowed_views === 1
      && access.json?.cut_offs?.sessions_cut === 0, access.json);
    check("…one row per person rather than per session, with a device and an address and never an "
      + "email", (access.json?.sessions ?? []).length === 1
      && access.json?.sessions[0]?.name === "Daudi Director"
      && access.json?.sessions[0]?.device === "smoke-customers"
      && !JSON.stringify(access.json).includes("@"), access.json?.sessions);
    const analystAccess = await call(`/control/customers/${CO}/access`, { ck: ck("pa") });
    check("who is signed in right now is not a register read: the analyst is refused (403)",
      analystAccess.status === 403, analystAccess.text);
    const officeAccess = await call(`/control/customers/${TC}/access`, { ck: ck("cs") });
    check("the office cannot read its own seats through a customer door",
      officeAccess.status === 409 && refuse(officeAccess.json).includes("staff desk"),
      refuse(officeAccess.json));
    const ghostAccess = await call(`/control/customers/${randomUUID()}/access`, { ck: ck("cs") });
    check("…and an account that is not there is a 404, not an empty list",
      ghostAccess.status === 404, ghostAccess.text);
    // `platform_auth.hit_rate_limit` aligns its window to the epoch, so a burst that crosses a
    // minute edge is metered against two windows and never trips. Thirty-one reads take seventy
    // seconds end to end on this database, so the burst is fired at once instead of one after
    // another: waiting for the edge only works if the whole burst fits inside the window.
    await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 300));
    const burstStartedAt = new Date();
    const reads = await Promise.all(Array.from({ length: 31 }, () =>
      call(`/control/customers/${CO}/access`, { ck: ck("cs") })));
    const served = reads.filter((r) => r.status === 200).length;
    const refused = reads.filter((r) => r.status === 429);
    check("a live seat list is enumerable, but the ceiling is thirty reads a minute: of "
      + "thirty-one asked at once, thirty are served and the rest are refused together",
      served === 30 && refused.length === 1
      && code(refused[0]?.json) === "RATE_LIMITED",
      { served, refused: refused.length, other: reads.filter((r) => r.status !== 200 && r.status !== 429).map((r) => r.status) });
    const accessAudits = await one(`select count(*)::int as n from audit_logs
      where tenant_id = $1 and action = 'control.customers.access_read' and ts >= $2`,
      [TC, burstStartedAt.toISOString()]);
    check("…and every read that answered left a row saying who looked and what they saw — "
      + "a refusal writes nothing, because nothing was seen",
      accessAudits?.n === served, { rows: accessAudits?.n, served });

    const briefCut = await call(`/control/customers/${CO}/cut-off`, {
      ck: ck("cs"), body: { reason: "no" } });
    check("a cut-off has to say why in as many characters as a note",
      briefCut.status === 400 && fields(briefCut.json).includes("reason"), briefCut.text);
    const analystCut = await call(`/control/customers/${CO}/cut-off`, {
      ck: ck("pa"), body: { reason: "An analyst does not end other people's work." } });
    check("and the read-only seat cannot end a session either", analystCut.status === 403,
      analystCut.text);
    const cut = await call(`/control/customers/${CO}/cut-off`, {
      ck: ck("cs"), body: { reason: "The director says somebody has been signing in from Kigoma; "
        + "every session on this account ends now." } });
    check("the cut ends every live session on the account it was aimed at, and counts a support "
      + "visit among them", cut.status === 200 && cut.json?.sessions_revoked === 2
      && cut.json?.of_which_borrowed_views === 1 && cut.json?.seats === 1
      && cut.json?.company?.name === "Customers Smoke Cargo Ltd", cut.json);
    const honestWindow = cut.json?.window ?? {};
    check("the answer tells the desk the limit of the act in the same breath as the count",
      honestWindow.minutes === 15 && honestWindow.gated === false
      && String(honestWindow.words).includes("15 minutes")
      && String(honestWindow.words).includes("blocked"), honestWindow);
    const revocations = await one(`select count(*)::int as every_row,
        count(*) filter (where revoked_reason = 'control_force_logout')::int as by_this_act,
        count(*) filter (where revoked_at is null)::int as still_open
      from sessions where tenant_id = $1`, [CO]);
    check("the register of the act is the session row itself: revoked, with the reason written down",
      revocations?.every_row === 2 && revocations?.by_this_act === 2
      && revocations?.still_open === 0, revocations);
    const officeSeats = await one(`select count(*)::int as cut from sessions
      where tenant_id = $1 and revoked_at is not null`, [TC]);
    check("…and the cut is bound to one account: not one of the office's own sessions ended",
      officeSeats?.cut === 0, officeSeats);
    const stillOpen = await one(`select count(*)::int as n from sessions
      where tenant_id = $1 and revoked_at is null and user_id = any($2::uuid[])`,
      [CO, [uSA, uCO, uCS, uPA, uFor]]);
    check("…the same for every seat that does not belong to the account",
      stillOpen?.n === 0, stillOpen);
    const afterCut = await call(`/control/customers/${CO}/access`, { ck: ck("sa") });
    check("a second read answers with nobody in the building and both cut-offs counted",
      afterCut.status === 200 && afterCut.json?.live === 0
      && (afterCut.json?.sessions ?? []).length === 0
      && afterCut.json?.cut_offs?.sessions_cut === 2 && !!afterCut.json?.cut_offs?.last_at,
      afterCut.json);
    const cutAgain = await call(`/control/customers/${CO}/cut-off`, {
      ck: ck("cs"), body: { reason: "Cutting it a second time proves the first one held; there was "
        + "nothing left to cut." } });
    check("a second cut finds nothing to cut and says so rather than failing",
      cutAgain.status === 200 && cutAgain.json?.sessions_revoked === 0
      && cutAgain.json?.previous_cut_offs?.sessions_cut === 2, cutAgain.json);
    const shutCut = await call(`/control/customers/${CX}/cut-off`, {
      ck: ck("cs"), body: { reason: "There is nothing left open on an account the office has shut." } });
    check("a closed account is not cut again: its sessions went with the tombstone, and the answer "
      + "names where", shutCut.status === 409 && refuse(shutCut.json).includes("tombstone"),
      refuse(shutCut.json));
    const officeCut = await call(`/control/customers/${TC}/cut-off`, {
      ck: ck("cs"), body: { reason: "A control seat is cut off on the staff desk, not this one." } });
    check("…and the office's own seats are not reachable through a customer door",
      officeCut.status === 404, officeCut.text.slice(0, 160));

    const claimsCsv = await call("/control/customers/export?register=claims", { ck: ck("co") });
    check("the claims register exports the file every tab was asked to carry",
      claimsCsv.status === 200 && claimsCsv.text.split("\r\n").filter((l) => l.trim()).length === 3
      && claimsCsv.text.includes("Customers Smoke Shut Ltd")
      && claimsCsv.text.includes("Customers Smoke Cargo Ltd") && claimsCsv.text.includes("insurance"),
      claimsCsv.text.slice(0, 200));
    const voidedCsv = await call("/control/customers/export?register=claims&status=voided",
      { ck: ck("co") });
    check("…with the same filter words the tab has, so the file is what the screen showed",
      voidedCsv.text.split("\r\n").filter((l) => l.trim()).length === 2
      && voidedCsv.text.includes("mistyped by the bank"), voidedCsv.text.slice(0, 160));
    const claimLeaks = seen.slice(seenAt).filter((s) => !s.where.includes("/reference")
      && (s.text.includes(NID) || s.text.includes(TIN) || s.text.includes(CX_TIN)
        || s.text.includes(CX_INSURANCE) || s.text.includes(INSURANCE.replace(/[^A-Z0-9]/g, ""))));
    check("the preview, the claim, the register, the seat list and the cut-off carried no identity "
      + "number — only the four characters a clerk can quote", claimLeaks.length === 0,
      claimLeaks.map((s) => s.where));
    const claimActs = (await oi(`select action, count(*)::int as n from audit_logs
      where tenant_id = $1 and action in ('control.customers.duplicate_claimed',
        'control.customers.duplicate_claim_voided','control.customers.seat_cut_off')
      group by action`, [TC])).rows;
    check("no act on this desk leaves no trace: the claim, the withdrawal and the cut are all in "
      + "the register of writes", claimActs.length === 3, claimActs);
    const firstClaimAudit = await one(`select entity, before, after, ip, user_agent from audit_logs
      where tenant_id = $1 and action = 'control.customers.duplicate_claimed'
      order by ts asc limit 1`, [TC]);
    check("…written against the claim row, naming both accounts, what moved and who moved it",
      firstClaimAudit?.entity === "customer_duplicate_claims"
      && firstClaimAudit?.before === null
      && JSON.stringify(firstClaimAudit?.after).includes("Customers Smoke Shut Ltd")
      && JSON.stringify(firstClaimAudit?.after).includes("insurance")
      && !JSON.stringify(firstClaimAudit?.after).includes(CX_INSURANCE)
      && firstClaimAudit?.ip === "127.0.0.1", firstClaimAudit?.after);
    const firstCutAudit = await one(`select entity, before, after from audit_logs
      where tenant_id = $1 and action = 'control.customers.seat_cut_off'
      order by ts asc limit 1`, [TC]);
    check("…and the cut keeps what it saw before it acted and what it ended after",
      firstCutAudit?.entity === "sessions"
      && JSON.stringify(firstCutAudit?.before).includes('"live":2')
      && JSON.stringify(firstCutAudit?.before).includes("Kigoma")
      && JSON.stringify(firstCutAudit?.after).includes('"sessions_revoked":2'),
      { before: firstCutAudit?.before, after: firstCutAudit?.after });

  } catch (e) {
    // A throw in the teardown below would otherwise replace the run's own error, and the smoke
    // would end with a stack about a DELETE and no word about what actually broke.
    failures++;
    console.log(`FAIL  the run stopped — ${(e as any)?.message ?? e}`);
  } finally {
    // ---------------- teardown ----------------
    phase("teardown");
    const residue = await one(
      `select (select count(*)::int from customer_verifications where tenant_id = any($1::uuid[])) as checks,
              (select count(*)::int from customer_notes where tenant_id = any($1::uuid[])) as notes,
              (select count(*)::int from customer_tags where tenant_id = any($1::uuid[])) as tags,
              (select count(*)::int from customer_taggings where tenant_id = any($1::uuid[])) as taggings,
              (select count(*)::int from customer_duplicate_claims
                 where tenant_id = any($1::uuid[])) as claims,
              (select count(*)::int from documents where storage_path like $2) as papers`,
      [[TC, TB, CO, CX, CF], `%/${MARK}/%`]);
    await sweep();
    await oi(`delete from rate_limits where bucket like 'customers-%'`);
    const left = await one(
      `select (select count(*)::int from tenants where name like $1) as tenants,
              (select count(*)::int from users where email like $2) as seats,
              (select count(*)::int from sessions where user_agent = 'smoke-customers') as sessions,
              (select count(*)::int from customer_verifications
                 where tenant_id = any($3::uuid[])) as checks,
              (select count(*)::int from customer_duplicate_claims
                 where tenant_id = any($3::uuid[])) as claims,
              (select count(*)::int from documents where storage_path like $4) as papers,
              (select count(*)::int from rate_limits where bucket like 'customers-%') as limiters`,
      [TENANT_SWEEP, EMAIL_SWEEP, [TC, TB, CO, CX, CF], `%/${MARK}/%`]);
    // Ten checks: the six this run raised on the live account, the three it raised on the closed
    // one before claiming it, and the one a carry left behind as a new line. Five notes: the agent's
    // two, and the three the claim register wrote about itself.
    check(`the registers hold exactly what this run wrote (${JSON.stringify(residue)})`,
      residue?.checks === 10 && residue?.tags === 1 && residue?.taggings === 1
      && residue?.notes === 5 && residue?.claims === 2 && residue?.papers === 3, residue);
    check("nothing of this run is left in the database",
      left?.tenants === 0 && left?.seats === 0 && left?.sessions === 0 && left?.checks === 0
      && left?.claims === 0 && left?.papers === 0 && left?.limiters === 0, left);
    note("audit_logs is never deleted — this run's reveals, answers and withdrawals stay in the "
      + "fixture tenants, as every earlier smoke leaves its own.");
    await owner.end();
  }

  console.log(`\n${failures ? `${failures} FAILURES of ${failures + proved}`
    : `all ${proved} checks passed — the customers desk`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
