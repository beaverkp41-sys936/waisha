/**
 * The data-request register over HTTP — smoke for #342 (migration 129,
 * api/src/routes/control-customers.routes.ts).
 *
 * `scripts/verify-data-requests-sql.ts` proves the register inside the database: which ten words a
 * category may be, that a paper cannot be rewritten, that an erasure refuses to arrive without a
 * spent second signature, and that all ten mask branches execute and count. This proves the parts
 * only the wire can show —
 *
 *   · that the two duties split the way 129 drew them, and that a seat holding one is turned away
 *     from the door that belongs to the other with a 403 rather than a quiet empty answer;
 *   · that each of the definer's refusals arrives as the status the desk can act on, in the
 *     register's own sentence — a copy with a menu, an erasure with no list, an erasure on a live
 *     account, a second paper on an account that already has one open;
 *   · that a copy really is the archive: seventeen folders, the encrypted columns opened into plain
 *     values for the subject alone, a README that states every cap, and a checksum list whose every
 *     line verifies against the bytes in the file beside it;
 *   · that the register's stamp is the SHA-256 of the whole archive as it left the socket, that the
 *     first hand-over is the one that sets it, and that a second download counts rather than
 *     restamping;
 *   · that an erasure cannot be signed by the hand that raised it, and that after the second seat
 *     signs, the columns the categories named are empty in the database while the ones `keeps`
 *     names are not;
 *   · that no board, preview, detail, refusal receipt or CSV of any of it carries a whole identity
 *     number, and that the plain TIN and phone exist only inside the archive the subject was handed.
 *
 * The fixtures are this run's own: one platform office, a foreign office to show the reads are bound
 * to the register that asked, one live company, one the office has closed, and three seats with three
 * different sets of duties. `audit_logs` is never deleted — the guard refuses it for the owner too.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-data-requests.ts   (API on :4000)
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sha256, encryptField } from "../src/util/crypto.js";
import { CATEGORIES, CATEGORY_LABELS, DATA_REQUEST_KINDS, EXPORT_SECTIONS, KIND_SENTENCES,
  REQUEST_STATUSES } from "../src/customers/data-request.js";

const API = "http://127.0.0.1:4000/api/v1";
const STAMP = Date.now().toString().slice(-8);
const MARK = `dr${STAMP}`;
const EMAIL_SWEEP = `smoke.datareq.%@waisha.test`;

const TIN = "3344556677";
const PHONE = "0713445566";
const NIDA = "19940515002233";
/** A second identity number: `nida_search` is unique across the platform, so two fixture seats
 *  cannot share one card. */
const NIDA_X = "19950712003344";
const SEAT_PHONE = "0788112233";

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++; else proved++;
}
const note = (line: string) => console.log(`note   ${line}`);
const phase = (name: string) => console.log(`\n--- ${name} ---`);

/** Every JSON body the desk read, kept so the PII sweep can say which of them carried a number. The
 *  archive is excluded on purpose: its whole purpose is to carry them. */
const seen: { where: string; text: string }[] = [];

async function call(path: string, opts: string | { ck?: string; method?: string; body?: any } = {}) {
  // A bare string is the cookie: most of the reads below are `call(path, ck("seat"))`, and an
  // options object that silently ignored a string argument would send them with no Cookie header
  // at all — every one of them then answers 401 and the smoke proves nothing about the door.
  if (typeof opts === "string") opts = { ck: opts };
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const res = await fetch(`${API}${path}`, {
    method,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: opts.ck } : {}),
      "User-Agent": "smoke-data-requests"
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* a CSV or a zip */ }
  seen.push({ where: `${method} ${path}`, text });
  return { status: res.status, json, text, headers: res.headers };
}
/** A raw fetch for the archive, because `call()` decodes bytes into a string and the checksum has to
 *  be taken on what actually arrived. */
async function download(path: string, ck: string) {
  const res = await fetch(`${API}${path}`, {
    method: "POST", headers: { Cookie: ck, "User-Agent": "smoke-data-requests" }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}
const msg = (j: any) => String(j?.error?.message ?? j?.message ?? "");

/**
 * A store-only ZIP reader, so the archive is checked the way a subject would open it.
 *
 * `safeEntryPath` and the writer's own naming rules mean the file names inside are not always the
 * ones the route asked for, so the entries are read back out of the central directory rather than
 * assumed — which is also the only way to prove the checksums line matches a name that exists.
 */
function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-archive record — the body is not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central record at ${p}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const size = buf.readUInt32LE(p + 24);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const headLen = buf.readUInt16LE(local + 26);
    const headExtra = buf.readUInt16LE(local + 28);
    out.push({ name, data: buf.subarray(local + 30 + headLen + headExtra,
      local + 30 + headLen + headExtra + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];

  // ---------------- the vocabularies ----------------
  phase("the words the row, the routes and the desk share");
  {
    const cons = (await oi(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'customer_data_requests'::regclass and contype = 'c'`)).rows as
      { conname: string; def: string }[];
    const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'(?:::text)?/g)].map((m) => m[1]);
    const defOf = (suffix: string) => cons.find((c) => c.conname.endsWith(suffix))?.def ?? "";
    // The categories sit in a `<@` list, and the same CHECK sentence goes on to name `erase` and an
    // empty array, so only the words inside the list itself are the vocabulary.
    const listIn = (def: string, column: string) => {
      const at = def.indexOf(`${column} <@`);
      return at < 0 ? [] : quoted(def.slice(at, def.indexOf("]", at)));
    };
    const same = (a: string[], b: readonly string[]) =>
      a.length === b.length && b.every((w, i) => a[i] === w);
    check("the two kinds the routes accept are the two the row allows",
      same(quoted(defOf("_kind_check")), DATA_REQUEST_KINDS), [defOf("_kind_check")]);
    check("the five states the board filters on are the five the row allows",
      same(quoted(defOf("_status_check")), REQUEST_STATUSES), [defOf("_status_check")]);
    check("the ten categories an erasure may name are the ten the row allows, in the order the mask walks them",
      same(listIn(defOf("customer_data_requests_check"), "categories"), CATEGORIES),
      [listIn(defOf("customer_data_requests_check"), "categories")]);
    check("and every category has the sentence the desk prints beside its tick box",
      CATEGORIES.every((k) => typeof CATEGORY_LABELS[k] === "string" && CATEGORY_LABELS[k].length > 20)
        && DATA_REQUEST_KINDS.every((k) => typeof KIND_SENTENCES[k] === "string"),
      CATEGORIES.filter((k) => !CATEGORY_LABELS[k]));
    check("no label or sentence in the desk's own file repeats a whole identity number",
      !Object.values(CATEGORY_LABELS).join(" ").match(/\d{8,}/)
        && !Object.values(KIND_SENTENCES).join(" ").match(/\d{8,}/), []);
  }

  // ---------------- a crashed run's own residue ----------------
  // The sweep at the end counts rows by this run's names, so a run that died between the fixtures
  // and the teardown would be reported as a leak. Anything wearing this smoke's names is cleared
  // before a single row is made, in the order the foreign keys need.
  {
    const stale = await one(`select count(*)::int as n from tenants where name like 'Datareq Smoke %'`);
    if (Number(stale?.n ?? 0) > 0) {
      note(`clearing ${stale.n} office${stale.n === 1 ? "" : "s"} left by an earlier run of this smoke`);
      // 126's lesson twice over: `approval_id` is a plain foreign key *from* the paper, so the
      // signature has to leave second. A sweep that deletes them the other way round throws
      // `customer_data_requests_approval_id_fkey` and clears nothing at all — the run then starts
      // on top of the residue it was trying to remove.
      const signed = await oi(`select approval_id as id from customer_data_requests
        where tenant_id in (select id from tenants where name like 'Datareq Smoke %')
          and approval_id is not null`);
      await oi(`delete from customer_data_requests
        where tenant_id in (select id from tenants where name like 'Datareq Smoke %')`);
      if (signed.rows.length) {
        await oi(`delete from platform_approvals where id = any($1::uuid[])`,
          [signed.rows.map((r: any) => r.id)]);
      }
      // A run that died after the signature but before the paper leaves a proposal pointing at a
      // register row that no longer exists. It can never be spent, so it is dead weight — and an
      // orphan here would make the teardown's signature count read low and hide a real leak.
      await oi(`delete from platform_approvals where target_kind = 'data_request'
        and target_id not in (select id::text from customer_data_requests)`);
      await oi(`delete from support_ticket_events where ticket_id in
        (select id from support_tickets where tenant_id in
          (select id from tenants where name like 'Datareq Smoke %'))`);
      for (const t of ["support_tickets", "customer_taggings", "customer_notes",
        "customer_verifications"]) {
        await oi(`delete from ${t} where tenant_id in
          (select id from tenants where name like 'Datareq Smoke %')`);
      }
      await oi(`delete from sessions where tenant_id in
        (select id from tenants where name like 'Datareq Smoke %')`);
      await oi(`delete from user_roles where user_id in
        (select id from users where tenant_id in
          (select id from tenants where name like 'Datareq Smoke %'))`);
      await oi(`delete from users where tenant_id in
        (select id from tenants where name like 'Datareq Smoke %')`);
      await oi(`delete from tenants where name like 'Datareq Smoke %'`);
      await oi(`delete from role_permissions where role_id in
        (select id from roles where key ~ '^smoke_(gdpr|erase)_only_dr[0-9]{8}$')`);
      await oi(`delete from roles where key ~ '^smoke_(gdpr|erase)_only_dr[0-9]{8}$'`);
    }
  }

  // ---------------- fixtures ----------------
  const TC = randomUUID();   // the office under test
  const TB = randomUUID();   // a foreign platform desk
  const CO = randomUUID();   // the live company a copy is taken of
  const CX = randomUUID();   // a company the office has closed: the only one an erasure may name
  const CF = randomUUID();   // nobody in this run's company, holding a foreign paper

  const uSA = randomUUID();  // super_admin: holds both 129 duties and the approval desk
  // compliance_officer holds both 129 duties *and* `control.approvals.decide`, which is what makes
  // it the right seat to try to sign its own erasure: the rule that turns it away is the two-seat
  // rule itself, not a missing duty.
  const uCO = randomUUID();
  const uGD = randomUUID();  // a seat with `gdpr` only
  const uER = randomUUID();  // a seat with `erase` only
  const uND = randomUUID();  // a platform seat with neither
  const uFor = randomUUID(); // super_admin of the other desk

  // Two scratch roles, one duty each. 129 seeds the pair onto the same two global roles, so the
  // split the migration draws can only be proven on the wire by a role that holds half of it —
  // and both are deleted again at the end rather than left as duties a real seat could be given.
  const rGD = randomUUID();
  const rER = randomUUID();
  const roleIds = (await oi(`select id, key from roles where tenant_id is null
    and key = any($1)`, [["super_admin", "compliance_officer", "platform_analyst"]]))
    .rows as { id: string; key: string }[];
  const rid = (k: string) => roleIds.find((r) => r.key === k)?.id;
  for (const k of ["super_admin", "compliance_officer", "platform_analyst"]) {
    if (!rid(k)) throw new Error(`the global role ${k} this desk depends on is missing`);
  }
  const noDuty = await one(`select r.id, r.key from roles r
    where r.tenant_id is null and r.key not in ('super_admin','compliance_officer','platform_analyst')
      and not exists (select 1 from role_permissions rp
                       where rp.role_id = r.id
                         and rp.permission_key like 'control.customers.%')
    order by r.key limit 1`);
  if (!noDuty?.id) throw new Error("every global role holds a customer duty — the 403 probe needs one that does not");

  await oi(`insert into roles (id, tenant_id, key, name, is_system)
      values ($1,null,$2,'Smoke GDPR reader',false), ($3,null,$4,'Smoke GDPR eraser',false)`,
    [rGD, `smoke_gdpr_only_${MARK}`, rER, `smoke_erase_only_${MARK}`]);
  await oi(`insert into role_permissions (role_id, permission_key) values ($1,'control.customers.gdpr')`,
    [rGD]);
  await oi(`insert into role_permissions (role_id, permission_key) values ($1,'control.customers.erase')`,
    [rER]);

  const TENANT_SWEEP = "Datareq Smoke %";
  await oi(`insert into tenants (id, type, name, status, slug, email, tin_encrypted,
        tin_search, phone_encrypted, phone_search, created_at, licence_expires_at) values
      ($1,'platform',$2,'active','dr-smoke-office', null, null, null, null, null,
       now() - interval '900 days', now() + interval '3 years'),
      ($3,'platform',$4,'active','dr-smoke-foreign', null, null, null, null, null,
       now() - interval '900 days', now() + interval '3 years'),
      ($5,'transporter',$6,'active','dr-smoke-live', $7, $8::bytea, $9, $10::bytea, $11,
       now() - interval '500 days', now() + interval '3 years'),
      ($12,'transporter',$13,'active','dr-smoke-shut', $14, $15::bytea, $16, $17::bytea, $18,
       now() - interval '500 days', now() + interval '3 years'),
      ($19,'shipper',$20,'active','dr-smoke-other', null, null, null, null, null,
       now() - interval '50 days', now() + interval '3 years')`,
    [TC, `Datareq Smoke Office ${STAMP}`, TB, `Datareq Smoke Foreign ${STAMP}`,
      CO, "Datareq Smoke Live Ltd", `live.dr.${STAMP}@waisha.test`,
      encryptField(TIN), sha256(TIN), encryptField(PHONE), sha256(PHONE),
      CX, "Datareq Smoke Shut Ltd", `shut.dr.${STAMP}@waisha.test`,
      encryptField("9998887776"), sha256("9998887776"), encryptField("0719998887"),
      sha256("0719998887"),
      CF, "Datareq Smoke Other Ltd"]);
  // The closed one is closed the way the tenants desk closes it: the column the register reads.
  await oi(`update tenants set deleted_at = now(), status = 'suspended' where id = $1`, [CX]);

  const seat = async (id: string, tenant: string, name: string, roleId: string,
    type = "platform", nida = "") => {
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, phone_encrypted,
            phone_search, nida_encrypted, nida_search, status, totp_enabled, last_login_at, created_at)
          values ($1,$2,$3,$4,$5,$6::bytea,$7,$8::bytea,$9,'active',false,
            now() - interval '3 hours', now() - interval '300 days')`,
      [id, tenant, type, name, `smoke.datareq.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
        encryptField(SEAT_PHONE), sha256(SEAT_PHONE),
        nida ? encryptField(nida) : null, nida ? sha256(nida) : null]);
    // A person inside a company is copied and erased by this register, and they hold no office duty.
    if (roleId) await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, roleId]);
  };
  await seat(uSA, TC, "Amani Super", rid("super_admin")!);
  await seat(uCO, TC, "Biweta Compliance", rid("compliance_officer")!);
  await seat(uGD, TC, "Gopa Reader", rGD);
  await seat(uER, TC, "Ersa Eraser", rER);
  await seat(uND, TC, "Nkono Nothing", noDuty.id);
  await seat(uFor, TB, "Faraji Otherdesk", rid("super_admin")!);
  // The people inside the two companies. One seat on the live account, with a NIDA number: the copy
  // names it and opens the number. Two seats on the closed account, because that is the count the
  // erasure's own `seats` figure has to reach — one of them holding a card of its own to empty.
  const uD1 = randomUUID(); const uD2 = randomUUID(); const uD3 = randomUUID();
  await seat(uD1, CO, "Daudi Director", "", "director", NIDA);
  await seat(uD2, CX, "Asha Director", "", "director", NIDA_X);
  await seat(uD3, CX, "Mama Staff", "", "staff");

  const ck = (who: string) => `waisha_control=dr-smoke-${who}-${MARK}`;
  const tok = (who: string) => sha256(`dr-smoke-${who}-${MARK}`);
  for (const [who, user, tenant] of [
    ["sa", uSA, TC], ["co", uCO, TC], ["gd", uGD, TC], ["er", uER, TC], ["nd", uND, TC],
    ["for", uFor, TB]
  ] as [string, string, string][]) {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
            refresh_token_hash, user_agent, ip, expires_at)
          values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-data-requests','127.0.0.1',
            now() + interval '2 hours')`,
      [randomUUID(), user, tenant, randomUUID(), tok(who)]);
  }

  // A sign-in on each company's own record: one line for the copy's `logins` folder, two on the
  // closed account for the erasure to blank.
  for (const [user, tenant] of [[uD1, CO], [uD2, CX], [uD3, CX]] as [string, string][]) {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
            refresh_token_hash, user_agent, ip, expires_at)
          values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-data-requests','127.0.0.2',
            now() + interval '2 hours')`,
      [randomUUID(), user, tenant, randomUUID(), sha256(`seat-${user}-${MARK}`)]);
  }

  // A note, a check line and a call, so the copy's folders are not all empty and the keeps record has
  // something true to say about each of them.
  await oi(`insert into customer_notes (tenant_id, company_tenant_id, body, author)
      values ($1,$2,$3,$4)`, [TC, CO,
      `Datareq Smoke note: the caller asked for a copy on the phone. ${STAMP}`, uCO]);
  await oi(`insert into customer_verifications (tenant_id, company_tenant_id, kind,
      status, reference_encrypted, reference_tail, raised_by, decided_by, decided_at, reason)
      values ($1,$2,'national_id','approved',$3,$4,$5,$5, now(),'verified against the card shown')`,
    [TC, CO, encryptField(NIDA), NIDA.slice(-4), uCO]);
  // One call against each company: the copy takes the live one's words, the erasure erases the shut
  // one's. Written with the columns the incidence register actually has, open so no desk or resolve
  // sentence is needed to lawfully hold the row.
  const newTicket = async (company: string, companyName: string, seq: number) => (await one(
    `insert into support_tickets (tenant_id, company_tenant_id, company_name, ref, channel, category,
        subject, body, reporter_name, reporter_phone_encrypted, reporter_phone_search, created_by)
      values ($1,$2,$3,$4,'phone_call','other',$5,$6,'Daudi Director',$7::bytea,$8,$9)
      returning id`,
    [TC, company, companyName, `CS-2099-${STAMP}${seq}`,
      `Datareq Smoke subject ${seq}`,
      `Datareq Smoke body ${seq}: the caller said the goods were still at the ward and asked what `
      + "the office would do next.",
      encryptField(SEAT_PHONE), sha256(SEAT_PHONE), uCO])).id as string;
  await newTicket(CO, "Datareq Smoke Live Ltd", 1);
  const CALL_X = await newTicket(CX, "Datareq Smoke Shut Ltd", 2);

  await oi(`delete from rate_limits where bucket like 'customers-data-%'`);

  phase("the doors, and who may open them");
  {
    const r = await call("/control/customers/data-requests", ck("nd"));
    check("a seat with neither duty is refused the register with a 403",
      r.status === 403 && /role does not allow/i.test(msg(r.json)), [r.status, msg(r.json)]);
    const p = await call(`/control/customers/${CO}/data-preview?kind=export`, ck("nd"));
    check("the same seat is refused a preview rather than shown an empty one", p.status === 403,
      [p.status, msg(p.json)]);
    const g = await call("/control/customers/data-requests", ck("gd"));
    check("`gdpr` alone opens the board", g.status === 200 && Array.isArray(g.json?.rows),
      [g.status, msg(g.json)]);
    const e = await call(`/control/customers/${CO}/data-requests`, {
      ck: ck("gd"), body: { kind: "erase", categories: ["account"],
        reason: "The caller asked the office to erase what it holds." }
    });
    check("`gdpr` alone cannot raise an erasure", e.status === 403, [e.status, msg(e.json)]);
    const er = await call("/control/customers/data-requests", ck("er"));
    check("`erase` alone cannot read the register it is about to write into", er.status === 403,
      [er.status, msg(er.json)]);
    const erRaise = await call(`/control/customers/${CO}/data-requests`, {
      ck: ck("er"), body: { kind: "export", reason: "A copy of everything, as the caller asked." }
    });
    check("`erase` alone cannot raise a copy either", erRaise.status === 403,
      [erRaise.status, msg(erRaise.json)]);
    const b = await call(`/control/customers/data-requests/${randomUUID()}/bundle`,
      { ck: ck("nd"), method: "POST" });
    check("no archive is written for a seat without the read duty", b.status === 403,
      [b.status, b.text.slice(0, 120)]);
  }

  phase("what the register refuses, in its own words");
  {
    const menu = await call(`/control/customers/${CO}/data-requests`, {
      ck: ck("sa"), body: { kind: "export", categories: ["account"],
        reason: "The caller asked for a copy of what the platform holds." }
    });
    check("a copy that arrives with a menu is refused as choosing what to hide",
      menu.status === 409 && /not a menu/i.test(msg(menu.json)), [menu.status, msg(menu.json)]);
    const blank = await call(`/control/customers/${CX}/data-requests`, {
      ck: ck("sa"), body: { kind: "erase", reason: "The caller asked for erasure of everything." }
    });
    check("an erasure that names nothing is refused as a refusal wearing a form",
      blank.status === 409 && /has to name what it erases/i.test(msg(blank.json)),
      [blank.status, msg(blank.json)]);
    const live = await call(`/control/customers/${CO}/data-requests`, {
      ck: ck("sa"), body: { kind: "erase", categories: ["account", "seats"],
        reason: "The caller asked for erasure of the account and its seats." }
    });
    check("an erasure on a live account is refused until the tenants desk closes it",
      live.status === 409 && /still a live account/i.test(msg(live.json)),
      [live.status, msg(live.json)]);
    const self = await call(`/control/customers/${TC}/data-requests`, {
      ck: ck("sa"), body: { kind: "export",
        reason: "The office asked for a copy of its own register." }
    });
    check("the office cannot raise a paper against itself", self.status === 409,
      [self.status, msg(self.json)]);
    const none = await call(`/control/customers/${randomUUID()}/data-requests`, {
      ck: ck("sa"), body: { kind: "export",
        reason: "A copy for an account the platform has never seen." }
    });
    check("an unknown account answers 404, not an empty promise", none.status === 404,
      [none.status, msg(none.json)]);
    // The register is the platform's, not one desk's: any office may file about any account, and
    // what makes that safe is that the paper is filed *to the desk that raised it*. So the proof is
    // not a 404 here — a 404 would be a lie about the model — it is whose register the row lands on
    // and whose board it then appears on, both read back below and on the board phase.
    const foreign = await call(`/control/customers/${CF}/data-requests`, {
      ck: ck("for"), body: { kind: "export",
        reason: "Another office asking about an account it does not hold." }
    });
    const foreignRow = await one(`select tenant_id, company_tenant_id from customer_data_requests
      where id = $1`, [foreign.json?.request?.id ?? randomUUID()]);
    check("a paper raised by another office is filed on that office's own register",
      foreign.status === 201 && foreignRow?.tenant_id === TB
        && foreignRow?.company_tenant_id === CF,
      [foreign.status, foreignRow, msg(foreign.json)]);
  }

  phase("the copy");
  let EXP = "";
  let EXP2 = "";
  let EXP_REF = "";
  let archiveSha = "";
  let firstBytes = 0;
  {
    const pv = await call(`/control/customers/${CO}/data-preview?kind=export`, ck("sa"));
    check("the preview of a copy names the whole answer and offers no categories",
      pv.status === 200 && pv.json?.kind === "export" && pv.json?.eligible === true
        && pv.json?.refusal === null
        && Object.keys(pv.json?.masks ?? {}).length === CATEGORIES.length
        && (pv.json?.keeps ?? []).length === 12,
      [pv.status, Object.keys(pv.json?.masks ?? {}), (pv.json?.keeps ?? []).length]);
    check("and the counts it prints are the fixture's own rows, read out of the live registers",
      pv.json?.masks?.account?.rows === 1 && pv.json?.masks?.seats?.rows === 1
        && pv.json?.masks?.sessions?.rows === 1 && pv.json?.masks?.calls?.rows === 1,
      pv.json?.masks);
    const raised = await call(`/control/customers/${CO}/data-requests`, {
      ck: ck("sa"), body: { kind: "export",
        reason: "The caller asked on the phone for a copy of everything held about them.",
        askedIn: "telephone call" }
    });
    EXP = String(raised.json?.request?.id ?? "");
    EXP_REF = String(raised.json?.request?.ref ?? "");
    check("a copy is raised with a DR- number and the preview of the same account beside it",
      raised.status === 201 && /^DR-\d{4}-\d{5,}$/.test(EXP_REF)
        && raised.json?.request?.status === "raised" && raised.json?.request?.kind === "export"
        && Object.keys(raised.json?.preview?.masks ?? {}).length === CATEGORIES.length,
      [raised.status, EXP_REF, msg(raised.json)]);
    const twice = await call(`/control/customers/${CO}/data-requests`, {
      ck: ck("sa"), body: { kind: "export",
        reason: "The same caller asked again the following week, before this one was answered." }
    });
    check("one open paper per account per kind, and the desk is handed the number of the one that stands",
      twice.status === 409 && String(twice.json?.error?.message ?? "").length > 20,
      [twice.status, msg(twice.json)]);

    const z = await download(`/control/customers/data-requests/${EXP}/bundle`, ck("sa"));
    const files = z.status === 200 ? unzip(z.buf) : [];
    const byName = new Map(files.map((f) => [f.name, f.data]));
    archiveSha = createHash("sha256").update(z.buf).digest("hex");
    firstBytes = z.buf.length;
    const readme = (byName.get("README.txt") ?? Buffer.from("")).toString("utf8");
    const manifest = byName.has("manifest.json")
      ? JSON.parse(byName.get("manifest.json")!.toString("utf8")) : null;
    const sections = files.filter((f) => f.name.startsWith("sections/"));

    check("the copy arrives as a zip whose content-type says so",
      z.status === 200 && z.headers.get("content-type") === "application/zip"
        && /attachment; filename="data-copy-DR-/.test(String(z.headers.get("content-disposition"))),
      [z.status, z.headers.get("content-type"), z.headers.get("content-disposition")]);
    const stems = [...new Set(sections.map((s) => s.name.replace(/^sections\//, "")
      .replace(/\.(csv|json)$/, "")))];
    const expected = EXPORT_SECTIONS.map((k, i) =>
      `${String(i + 1).padStart(2, "0")}-${k.replace(/_/g, "-")}`).join(",");
    check(`the archive holds all seventeen folders (${stems.length}), named and numbered the way the definer builds them`,
      sections.length === 34 && stems.join(",") === expected, [stems, expected]);
    check("a README a person can read without software names the request and the caps",
      readme.includes(EXP_REF) && readme.includes("Waisha") && readme.includes("CHECKING THIS COPY")
        && /cut at 400/.test(readme), [readme.slice(0, 200)]);
    check("the account's encrypted TIN and phone are opened for the subject, under the names a person reads",
      (() => {
        const acc = (byName.get("sections/01-account.csv") ?? Buffer.from("")).toString("utf8");
        return acc.includes(TIN) && acc.includes(PHONE) && !acc.includes("tin_hex")
          && !acc.includes("phone_hex");
      })(), [(byName.get("sections/01-account.csv") ?? Buffer.from("")).toString("utf8").slice(0, 300)]);
    check("a seat's NIDA is decrypted too, and its password hash is nowhere in the archive",
      (() => {
        const seats = files.filter((f) => f.name.includes("-seats."))
          .map((f) => f.data.toString("utf8")).join("\n");
        const all = files.map((f) => f.data.toString("utf8")).join("\n");
        return seats.includes(NIDA) && !all.includes("$argon2") && !seats.includes("nida_hex");
      })(), []);
    check("the office's note and the call it took are carried as their own folders",
      files.filter((f) => f.data.toString("utf8").includes(`Datareq Smoke note`)).length === 2
        && files.filter((f) => f.data.toString("utf8").includes("Datareq Smoke subject")).length === 2,
      files.map((f) => f.name));
    check("the check line travels with its number opened and its tail kept",
      files.filter((f) => /-checks\.(csv|json)$/.test(f.name))
        .every((f) => f.data.toString("utf8").includes(NIDA)
          && f.data.toString("utf8").includes(NIDA.slice(-4))),
      (byName.get("sections/05-checks.csv") ?? Buffer.from("")).toString("utf8").slice(0, 200));
    check("nothing in the archive is a search hash — the copy is values, not the platform's index",
      !files.map((f) => f.name).some((n) => n.includes("search"))
        && files.every((f) => !f.data.toString("utf8").includes(sha256(TIN))), []);
    check("every section is present in the manifest with the count the sheet actually carries",
      manifest?.sections?.length === 17 && manifest?.cap === 400
        && manifest.sections.every((s: any) => byName.has(s.csv) && byName.has(s.json)),
      [manifest?.sections?.length, manifest?.cap]);
    const sums = (byName.get("SHA256SUMS.txt") ?? Buffer.from("")).toString("utf8").trim().split("\n");
    const wrong = sums.filter((line) => {
      const [sha, name] = line.split("  ");
      const f = byName.get(name);
      return !f || createHash("sha256").update(f).digest("hex") !== sha;
    });
    check("the checksum list verifies against the bytes of every file it names, and names them all",
      sums.length === files.length - 1 && wrong.length === 0, [sums.length, files.length, wrong]);
    check("the sums file is the last entry, so it cannot carry its own checksum",
      files[files.length - 1]?.name === "SHA256SUMS.txt", files.map((f) => f.name).slice(-2));

    const row = await one(`select status, deliveries, bundle_sha256, bundle_bytes, bundle_entries,
        delivered_by is not null as stamped from customer_data_requests where id = $1`, [EXP]);
    check("the register says the copy was handed over, by this hand, with the archive's own SHA",
      row?.status === "delivered" && row?.deliveries === 1 && row?.bundle_sha256 === archiveSha
        && Number(row?.bundle_bytes) === firstBytes && row?.stamped === true, row);

    const again = await download(`/control/customers/data-requests/${EXP}/bundle`, ck("sa"));
    const row2 = await one(`select status, deliveries, bundle_sha256, bundle_bytes
      from customer_data_requests where id = $1`, [EXP]);
    check("a second download counts rather than restamping: the first archive stays the evidence",
      again.status === 200 && row2?.deliveries === 2
        && row2?.bundle_sha256 === archiveSha && Number(row2?.bundle_bytes) === firstBytes,
      row2);

    const aud = await one(`select count(*)::int as n from audit_logs
      where entity = 'customer_data_requests' and entity_id = $1
        and action = 'data_request.delivered'`, [EXP]);
    check("the register wrote the hand-over into the audit trail rather than the route doing it",
      aud?.n === 2, aud);
  }

  phase("refusing an ask");
  {
    const refused = await call(`/control/customers/${CX}/data-requests`, {
      ck: ck("co"), body: { kind: "export",
        reason: "A copy asked for by a person who is not the account's data subject." }
    });
    const rid = String(refused.json?.request?.id ?? "");
    const short = await call(`/control/customers/data-requests/${rid}/refuse`, {
      ck: ck("co"), body: { note: "no" }
    });
    check("a refusal needs the same length of sentence as a grant", short.status === 400,
      [short.status, msg(short.json)]);
    const no = await call(`/control/customers/data-requests/${rid}/refuse`, {
      ck: ck("co"), body: { note: "The writer is not the data subject and gave no authority." }
    });
    check("a refusal keeps the row and frees the open slot", no.status === 200
      && no.json?.request_status === "refused", [no.status, msg(no.json)]);
    const bundle = await download(`/control/customers/data-requests/${rid}/bundle`, ck("sa"));
    check("a refused paper hands over nothing, and says why in the register's own words",
      bundle.status === 409 && /was refused/i.test(bundle.buf.toString("utf8")),
      [bundle.status, bundle.buf.toString("utf8").slice(0, 160)]);
    const rewrite = await call(`/control/customers/data-requests/${rid}/refuse`, {
      ck: ck("co"), body: { note: "The office thought again and changed its mind about the answer." }
    });
    check("a refusal is not edited into a different answer", rewrite.status === 409,
      [rewrite.status, msg(rewrite.json)]);
    const reopen = await call(`/control/customers/${CX}/data-requests`, {
      ck: ck("co"), body: { kind: "export",
        reason: "The same ask, raised again now that the office knows who is writing." }
    });
    check("a refused paper frees the slot, so the office can answer the same person properly",
      reopen.status === 201, [reopen.status, msg(reopen.json)]);
    EXP2 = String(reopen.json?.request?.id ?? "");
  }

  phase("the two-seat erasure");
  let ER = "";
  {
    const raised = await call(`/control/customers/${CX}/data-requests`, {
      ck: ck("co"), body: { kind: "erase",
        categories: ["account", "seats", "sessions", "calls"],
        reason: "The former director asked in writing for the account and its seats to be erased.",
        askedIn: "letter" }
    });
    ER = String(raised.json?.request?.id ?? "");
    check("an erasure on a closed account is raised with the categories it names",
      raised.status === 201 && raised.json?.request?.status === "raised"
        && (raised.json?.request?.categories ?? []).join(",") === "account,calls,seats,sessions",
      [raised.status, raised.json?.request?.categories, msg(raised.json)]);

    const before = await one(`select count(*)::int as n from platform_approvals where target_id = $1`,
      [ER]);
    check("raising the paper writes no signature: asking is not signing", before?.n === 0, before);

    const bad = await call(`/control/customers/data-requests/${EXP}/erase-signature`, {
      ck: ck("co"), body: { reason: "A copy has nothing to sign — this is the desk aiming wrong." }
    });
    check("a copy is refused a signature rather than quietly waiting on one", bad.status === 400,
      [bad.status, msg(bad.json)]);

    const prop = await call(`/control/customers/data-requests/${ER}/erase-signature`, {
      ck: ck("co"), body: { reason: "Erase the account's own name and numbers, the two seats that "
        + "could sign in to it, their sign-in records and the words of the one call it rang in." }
    });
    const APPR = String(prop.json?.approval_id ?? "");
    check("the paper moves to a second seat with a hash of exactly these bytes",
      prop.status === 201 && prop.json?.action === "customer.erase"
        && /^[0-9a-f]{64}$/.test(String(prop.json?.payload_sha256 ?? "")),
      [prop.status, msg(prop.json)]);
    const detail = await call(`/control/customers/data-requests/${ER}`, ck("sa"));
    check("the paper reads back as waiting, with the signature's own expiry beside it",
      detail.json?.status === "pending_signature"
        && detail.json?.approval_id === APPR && !!detail.json?.approval_expires_at,
      [detail.json?.status, detail.json?.approval_id]);

    const self = await call(`/control/approvals/${APPR}/approve`, {
      ck: ck("co"), body: { note: "I raised it and I am signing it myself." }
    });
    check("the seat that raised the erasure cannot sign it",
      self.status === 403 && /SELF_APPROVAL|cannot sign its own|second person/i
        .test(msg(self.json) + JSON.stringify(self.json?.error?.code ?? "")),
      [self.status, self.json?.error?.code, msg(self.json)]);

    const still = await one(`select status from customer_data_requests where id = $1`, [ER]);
    check("a refused signature leaves the paper waiting, not erased", still?.status === "pending_signature", still);

    const signed = await call(`/control/approvals/${APPR}/approve`, {
      ck: ck("sa"), body: { note: "Read the categories. The account is closed. Sign it." }
    });
    check("the second seat's signature is released and spent on the mask in one act",
      signed.status === 200, [signed.status, msg(signed.json)]);

    const row = await one(`select status, erased, keeps, erased_by, approval_id,
        (select count(*)::int from jsonb_array_elements(keeps) k
          where k ->> 'key' in ('kyc_checks','office_notes','labels')) as kept_named
      from customer_data_requests where id = $1`, [ER]);
    check("the paper arrives as erased with the counts it reached and the keeps it named",
      row?.status === "erased" && (row?.erased ?? {}).account >= 1 && (row?.erased ?? {}).seats === 2
        && row?.kept_named === 3 && row?.erased_by === uSA, row);

    const acct = await one(`select name, slug, email, tin_encrypted, phone_encrypted, deleted_at
      from tenants where id = $1`, [CX]);
    check("the account's own name, number and address are gone from the register",
      /^Erased account /.test(String(acct?.name)) && acct?.slug === null && acct?.email === null
        && acct?.tin_encrypted === null && acct?.phone_encrypted === null
        && acct?.deleted_at !== null, acct);
    const seats = await one(`select count(*)::int as n, max(status)::text as status,
        count(*) filter (where email is null and phone_encrypted is null
                                and nida_encrypted is null and password_hash is null
                                and totp_secret_encrypted is null)::int as emptied,
        count(*) filter (where full_name like 'Erased seat %')::int as renamed
      from users where tenant_id = $1 and user_type <> 'platform'`, [CX]);
    check("the people with a seat are erased and the rows stay as the account's history",
      seats?.n === 2 && seats?.emptied === 2 && seats?.renamed === 2
        && seats?.status === "deactivated", seats);
    const sess = await one(`select count(*)::int as n,
        count(*) filter (where ip is null and user_agent is null)::int as blanked,
        count(*) filter (where refresh_token_hash like 'erased-%')::int as dead
      from sessions where tenant_id = $1`, [CX]);
    check("a sign-in record keeps its shape and loses the device, the address and the credential",
      sess?.n >= 0 && sess?.blanked === sess?.n && (sess?.dead ?? 0) === (sess?.n ?? 0), sess);
    const callRow = await one(`select subject, reporter_name, body, reporter_phone_encrypted,
        reporter_phone_search from support_tickets where id = $1`, [CALL_X]);
    check("the caller's words go, and the reason they went stays on the call",
      callRow?.reporter_phone_encrypted === null && callRow?.reporter_phone_search === null
        && callRow?.reporter_name === "Erased caller"
        && /erased under data request/.test(callRow?.body ?? ""),
      callRow);
    const kept = await one(`select count(*)::int as n from customer_notes
      where company_tenant_id = $1 and voided_at is null`, [CO]);
    const kept2 = await one(`select count(*)::int as n from customer_verifications
      where company_tenant_id = $1 and status = 'approved'`, [CO]);
    check("the categories this paper did not name are untouched, and the register says so",
      kept?.n === 1 && kept2?.n === 1, [kept, kept2]);

    const rerun = await call(`/control/approvals/${APPR}/approve`, {
      ck: ck("sa"), body: { note: "Pressing the same signature again." }
    });
    check("a spent signature cannot be spent twice", rerun.status !== 200,
      [rerun.status, msg(rerun.json)]);
    const second = await call(`/control/customers/${CX}/data-requests`, {
      ck: ck("co"), body: { kind: "erase", categories: ["papers"],
        reason: "The office wants a second pass over the same closed account." }
    });
    check("a closed account may be asked about again once the first paper is answered",
      second.status === 201, [second.status, msg(second.json)]);
    const refusalOfSigned = await call(`/control/customers/data-requests/${second.json?.request?.id}/refuse`, {
      ck: ck("co"), body: { note: "The office decided the second pass was not needed." }
    });
    check("an unsigned paper is still a paper the office can say no to",
      refusalOfSigned.status === 200, [refusalOfSigned.status, msg(refusalOfSigned.json)]);
  }

  phase("the board, the CSV and the register's own words");
  {
    const board = await call("/control/customers/data-requests?status=all&kind=all&limit=50", ck("sa"));
    const mine = (board.json?.rows ?? []).filter((r: any) => r.company_id === CX || r.company_id === CO);
    check("the board counts the register's own states and names the paper, the hand and the hour",
      board.status === 200 && mine.length >= 5
        && board.json?.counts?.erase >= 2 && board.json?.counts?.export >= 3
        && mine.every((r: any) => r.ref && r.raised_name && r.request_status),
      [board.json?.counts, mine.length]);
    const filt = await call(`/control/customers/data-requests?status=erased&kind=erase`, ck("sa"));
    check("a filter is a filter: only erased erasure papers answer it",
      filt.status === 200 && (filt.json?.rows ?? []).length >= 1
        && (filt.json?.rows ?? []).every((r: any) => r.request_status === "erased" && r.kind === "erase"),
      (filt.json?.rows ?? []).map((r: any) => [r.kind, r.request_status]));
    const foreign = await call("/control/customers/data-requests?status=all&limit=50", ck("for"));
    check("another office's board does not see this one's papers",
      foreign.status === 200 && (foreign.json?.rows ?? [])
        .every((r: any) => r.company_id !== CO && r.company_id !== CX), []);
    const csv = await call("/control/customers/export?register=requests&status=all", ck("sa"));
    const lines = csv.text.split("\r\n");
    check("the register exports as a sheet whose own columns the desk can read",
      csv.status === 200 && lines[0].includes('"ref"') === false
        && lines[0].startsWith(`ref,kind,request_status`) && lines.length > 5,
      [csv.status, lines[0]]);
    check("the sheet carries the kept record as keys, not as a wall of JSON",
      lines.some((l) => l.includes(EXP_REF)) && !lines.some((l) => l.includes('"key"')),
      lines[1]);
    const bogus = await call("/control/customers/export?register=requests&status=opened", ck("sa"));
    check("a filter word the register does not use answers before the file is written",
      bogus.status === 400 && /no state "opened"/.test(msg(bogus.json)),
      [bogus.status, msg(bogus.json)]);
    const bogusKind = await call("/control/customers/export?register=checks&kind=export", ck("sa"));
    check("and a copy is not a kind of check", bogusKind.status === 400,
      [bogusKind.status, msg(bogusKind.json)]);
    const badRef = await call("/control/customers/data-requests/not-a-uuid", ck("sa"));
    check("a typed number that is not an id is a 400, not a 500", badRef.status === 400,
      [badRef.status, msg(badRef.json)]);
    const ghost = await call(`/control/customers/data-requests/${randomUUID()}`, ck("sa"));
    check("a paper the register has never seen is a 404 in the desk's words",
      ghost.status === 404 && /never raised|another office/i.test(msg(ghost.json)),
      [ghost.status, msg(ghost.json)]);
  }

  phase("no identity number leaves the desk except inside the copy");
  {
    // The archive is not in `seen` — it is fetched with its own helper — so every body here is a
    // response a screen, a board or a sheet could print.
    const leaks = seen.filter((s) => {
      const t = s.text;
      return [TIN, NIDA, NIDA_X, PHONE, SEAT_PHONE].some((v) => t.includes(v));
    });
    check(`no JSON body, board, preview, detail, refusal or CSV carries a whole number (${seen.length} bodies read)`,
      leaks.length === 0, leaks.map((l) => l.where));
    const tails = seen.filter((s) => /"reference":"?\d{8,}/.test(s.text)
      || /"nida":"?\d{8,}/.test(s.text) || /"tin_hex"|"phone_hex"|"nida_hex"/.test(s.text));
    check("no desk read carries a ciphertext field either — the hex is only ever the route's input",
      tails.length === 0, tails.map((t) => t.where));
  }

  phase("teardown");
  {
    // The counters are built from whatever papers the register actually holds for this run's
    // offices, not from three id variables a failing check may have left as empty strings. A leak
    // counted by a variable that never got set is a leak counted as zero.
    const papers = await oi(`select id::text as id, approval_id as signed
      from customer_data_requests
      where tenant_id = any($1::uuid[]) or company_tenant_id = any($1::uuid[])`,
      [[TC, TB, CO, CX, CF]]);
    const targets = papers.rows.map((r: any) => String(r.id));
    const signed = papers.rows.filter((r: any) => r.signed).map((r: any) => r.signed);
    const residue = await one(`select
        (select count(*)::int from customer_data_requests where tenant_id = any($1::uuid[])) as papers,
        (select count(*)::int from platform_approvals where target_kind='data_request'
           and target_id = any($2::text[])) as signatures,
        (select count(*)::int from customer_notes where tenant_id = any($1::uuid[])) as notes,
        (select count(*)::int from customer_verifications where tenant_id = any($1::uuid[])) as checks,
        (select count(*)::int from support_tickets where tenant_id = any($1::uuid[])) as calls`,
      [[TC, TB, CO, CX, CF], targets]);
    // 129's own guard is what a `before delete` would be, so the register's rows and the
    // signatures on them are removed as the owner — and in the order the foreign key needs, which
    // is 126's lesson again: `approval_id` is a plain FK, so a paper must leave before the
    // signature it points at. Deleting the signatures first is refused by
    // `customer_data_requests_approval_id_fkey` and the run ends with its fixtures still in place.
    await oi(`delete from customer_data_requests
      where tenant_id = any($1::uuid[]) or company_tenant_id = any($1::uuid[])`,
      [[TC, TB, CO, CX, CF]]);
    if (signed.length) {
      await oi(`delete from platform_approvals where id = any($1::uuid[])`, [signed]);
    }
    await oi(`delete from customer_taggings where tenant_id = any($1::uuid[])`, [[TC, TB, CO, CX, CF]]);
    await oi(`delete from customer_notes where tenant_id = any($1::uuid[])`, [[TC, TB, CO, CX, CF]]);
    await oi(`delete from customer_verifications where tenant_id = any($1::uuid[])`,
      [[TC, TB, CO, CX, CF]]);
    await oi(`delete from support_tickets where tenant_id = any($1::uuid[])`, [[TC, TB, CO, CX, CF]]);
    await oi(`delete from user_roles where user_id = any($1::uuid[])`,
      [[uSA, uCO, uGD, uER, uND, uFor, uD1, uD2]]);
    await oi(`delete from sessions where user_agent = 'smoke-data-requests'`);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [[TC, TB, CO, CX, CF]]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [[TC, TB, CO, CX, CF]]);
    await oi(`delete from roles where id = any($1::uuid[])`, [[rGD, rER]]);
    await oi(`delete from rate_limits where bucket like 'customers-data-%'`);
    const left = await one(`select
        (select count(*)::int from tenants where name like $1) as tenants,
        (select count(*)::int from users where email like $2) as seats,
        (select count(*)::int from sessions where user_agent = 'smoke-data-requests') as sessions,
        (select count(*)::int from customer_data_requests where tenant_id = any($3::uuid[])) as papers,
        (select count(*)::int from platform_approvals where target_kind='data_request'
           and target_id = any($4::text[])) as signatures,
        (select count(*)::int from roles where key like 'smoke_%_dr' || $5) as roles,
        (select count(*)::int from rate_limits where bucket like 'customers-data-%') as limiters`,
      [TENANT_SWEEP, EMAIL_SWEEP, [TC, TB, CO, CX, CF], targets, STAMP]);
    check("the papers this run raised are gone from the register",
      residue?.papers >= 5 && residue?.signatures >= 1, residue);
    check("nothing of this run is left in the database",
      left?.tenants === 0 && left?.seats === 0 && left?.sessions === 0 && left?.papers === 0
        && left?.signatures === 0 && left?.limiters === 0, left);
    note("audit_logs is never deleted — this run's hand-overs, refusals and erasures stay in the "
      + "fixture tenants, exactly as every earlier smoke leaves its own.");
    note("the erased account's rows are deleted by id, not by name: after a mask there is no name "
      + "left for a sweep to match on, and a sweep that finds nothing has just hidden a leak.");
    await owner.end();
  }

  console.log(`\n${failures ? `${failures} FAILURES of ${failures + proved}`
    : `all ${proved} checks passed — the data-request register`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
