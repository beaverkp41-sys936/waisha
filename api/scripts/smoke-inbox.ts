/**
 * One inbox for every source, over HTTP — smoke for #340d.
 *
 * verify-inbox-sql.ts proves 125's own rules hold in the table: the fold is one-way, a tagging
 * names a live pair, a reopen window is measured from the settle, the six tokens are the only
 * braces a reply may use, and the delivery purpose says `sla_breach` in both places that list
 * it. None of that is what this run is for. What only a live desk can answer is whether a clerk
 * gets those facts: that a WhatsApp, a portal chat and a web form are the same object as a phone
 * call and can be filtered apart; that a desk which wrote three days gets a refusal naming its
 * own window while a desk that wrote nothing keeps taking calls back; that a fold leaves the
 * duplicate readable and points at the line that is being answered; that a label put on a call
 * survives the retirement of its tag; that a photograph lands beside the incidence it is about
 * and is opened through the duty that read the call; and that a notice which the provider
 * refused leaves nothing stamped, because a breach marked "somebody was told" on a send that
 * failed is how a breach gets quietly forgotten.
 *
 * Two halves of the alert rule cannot be shown the same way, and this file says so rather than
 * pretending. The refused send is proved over HTTP, end to end: the receipt, the line in the
 * delivery register, and the deadline still unstamped. The delivered half cannot be produced on
 * this machine at all — Resend has no verified sending domain for us yet, so no message leaves.
 * It is therefore proved on the register's own side: both alert columns written together exactly
 * as STAMP_BREACH_ALERT_SQL writes them, the twelve-hour rule read back off the board, and the
 * line returning to `waiting` thirteen hours later. That is a proof about the board and the
 * stamp, not a claim that anybody received an email.
 *
 * Fixtures are this run's own platform tenants, its own desks, its own labels, answers, calls
 * and paper — never the desk the real office sits on — and every one of them is torn down by
 * those ids, the uploaded objects included. The live platform's row counts are read before and
 * after to prove it. Writes are split between three seats so a limiter window cannot be mistaken
 * for a broken guard.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-inbox.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";
import { storageConfigured, deleteObject } from "../src/storage/supabase.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Inx Smoke %";
const EMAIL_SWEEP = `smoke.inx.%@waisha.test`;
const MARK = `inxsmoke${STAMP}`;
/** A label is capped at 28 characters by 125, so the long mark will not fit inside one. The
 *  short form keeps every label name this run writes both legal and unique. */
const TAG_MARK = STAMP;
const PHONE = `+255714${STAMP.slice(0, 6)}`;
const PHONE2 = `+255713${STAMP.slice(0, 6)}`;
const MIN = 60_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0);
const clip = (v: unknown, n = 240) => String(v ?? "").slice(0, n);

/** The words a refusal actually said. The message is the shape of it ("Request validation
 *  failed") and the details are the sentence a person can act on, so both are read together. */
const why = (r: any): string => [r.json?.error?.message ?? "",
  ...(r.json?.error?.details ?? []).map((d: any) => d.message ?? "")].join(" | ");

async function call(path: string, opts: { ck?: string; token?: string; method?: string; body?: any } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: `waisha_control=${opts.ck}` } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** A file part on a call: metadata first, then the bytes — a part appended after the file has
 *  been streamed is a part the parser never saw (the same order the tenant vault depends on). */
async function upload(path: string, ckWho: string, opts: {
  reason?: string; bytes?: Buffer; mime?: string; name?: string; withFile?: boolean;
}) {
  const fd = new FormData();
  if (opts.reason !== undefined) fd.append("reason", opts.reason);
  if (opts.withFile !== false) {
    fd.append("file", new Blob([new Uint8Array(opts.bytes ?? Buffer.alloc(0))],
      { type: opts.mime ?? "image/png" }), opts.name ?? "paper.png");
  }
  const res = await fetch(`${API}${path}`, {
    method: "POST", headers: { Cookie: `waisha_control=${tok(ckWho)}` }, body: fd
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

/** The week an office would actually keep. */
const WEEK = {
  mon: { open: "08:00", close: "17:30" }, tue: { open: "08:00", close: "17:30" },
  wed: { open: "08:00", close: "17:30" }, thu: { open: "08:00", close: "17:30" },
  fri: { open: "08:00", close: "17:00" }, sat: { open: "09:00", close: "13:00" },
  sun: null
};

const tok = (who: string) => `inx-smoke-${who}-${STAMP}`;
const ck = (who: string) => tok(who);

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const stored: string[] = [];
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "platform_analyst", "customer_service_agent"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("platform_analyst") || !rid("customer_service_agent")) {
    throw new Error("the global roles 123 and 125's duties are seeded on are missing");
  }

  const live = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      order by created_at limit 1`)).rows[0]?.id;
  if (!live) throw new Error("no live platform tenant to compare against");
  const before = async (table: string) => (await oi(
    `select count(*)::int as n from ${table} where tenant_id = $1`, [live])).rows[0].n;
  const start = {
    tickets: await before("support_tickets"),
    desks: await before("platform_departments"),
    tags: await before("support_ticket_tags"),
    replies: await before("support_canned_replies")
  };

  // ---------------- fixtures ----------------
  const TC = randomUUID();          // the platform whose inbox this run works
  const TB = randomUUID();          // a second platform desk: its register is not ours

  const uSA = randomUUID();         // super_admin: sets terms, labels and answers
  const uAN = randomUUID();         // platform_analyst: reads, writes nothing
  const uCS = randomUUID();         // customer_service_agent: works calls, is a desk head
  const uFor = randomUUID();        // super_admin of the other platform tenant

  const D1 = randomUUID();          // Support Desk     — terms, a three-day window, head on file
  const D2 = randomUUID();          // The Window       — a one-day window, deliberately short
  const D3 = randomUUID();          // Open-ended Desk  — no window written at all
  const D4 = randomUUID();          // Bare Desk        — no terms, so no clock
  const D5 = randomUUID();          // The Squeeze      — a ceiling of one, for bulk

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))] as string[];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    const tks = (await oi(`select id from support_tickets where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (tks.length) {
      await oi(`delete from documents where tenant_id = any($1::uuid[])
                 and entity_type = 'support_ticket'`, [all]);
      await oi(`delete from support_ticket_taggings where ticket_id = any($1::uuid[])`, [tks]);
      await oi(`delete from support_ticket_events where ticket_id = any($1::uuid[])`, [tks]);
      await oi(`delete from support_tickets where id = any($1::uuid[])`, [tks]);
    }
    if (all.length) {
      await oi(`delete from support_ticket_taggings where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from support_ticket_tags where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from support_canned_replies where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from message_deliveries where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from support_ticket_routes where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from platform_duty_transitions where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from platform_seat_departments where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from platform_departments where tenant_id = any($1::uuid[])`, [all]);
      await oi(`delete from branches where tenant_id = any($1::uuid[])`, [all]);
    }
    // audit_logs is append-only (082's trigger refuses a delete), and that is the point: the
    // lines this run wrote stay as the register's own evidence, with their tenant gone.
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("tickets:", "tickets-one:", "tickets-write:", "tickets-bulk:",
    "tickets-breach:", "tickets-breach-notify:", "ticket-tags:", "ticket-tags-write:",
    "ticket-files:", "canned:", "canned-write:", "dept:", "dept-one:", "dept-write:",
    "dept-rules:", "dept-rules-write:", "audit:");

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active')`,
    [TC, `Inx Smoke Platform ${STAMP}`, TB, `Inx Smoke Foreign ${STAMP}`]);

  const seat = (id: string, tenant: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
                now() - interval '200 days')`,
      [id, tenant, name, `smoke.inx.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
  await seat(uSA, TC, "Ina Setter");
  await seat(uAN, TC, "Ron Reader");
  await seat(uCS, TC, "Cally Service");
  await seat(uFor, TB, "Juma Otherdesk");

  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6),($7,$2)`,
    [uSA, rid("super_admin"), uAN, rid("platform_analyst"),
      uCS, rid("customer_service_agent"), uFor]);

  const desk = (id: string, deskKey: string, name: string, sort: number) =>
    oi(`insert into platform_departments (id, tenant_id, key, name, purpose, sort)
        values ($1,$2,$3,$4,'Smoke desk, worked only by this script.',$5)`,
      [id, TC, deskKey, name, sort]);
  await desk(D1, `inx_support_${STAMP}`, "Support Desk", 10);
  await desk(D2, `inx_window_${STAMP}`, "The Window", 20);
  await desk(D3, `inx_open_${STAMP}`, "Open-ended Desk", 30);
  await desk(D4, `inx_bare_${STAMP}`, "Bare Desk", 40);
  await desk(D5, `inx_squeeze_${STAMP}`, "The Squeeze", 50);
  await desk(randomUUID(), `inx_other_${STAMP}`, "Foreign Desk", 10);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '3 hours', $5,'smoke-inbox','127.0.0.1',
                now() + interval '3 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who))]);
  for (const [uid, tenant, who] of [
    [uSA, TC, "sa"], [uAN, TC, "an"], [uCS, TC, "cs"], [uFor, TB, "for"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  /** The row as the table holds it, including the two columns 125 added for the fold and the
   *  alert — read from the register because that is where the truth about them lives. */
  const row = async (id: string) => (await oi(
    `select t.status, t.channel, t.language, t.department_id, t.dept_ref, t.reopen_count,
            t.last_reopened_at, t.first_response_at, t.resolved_at, t.response_due_at,
            t.resolution_due_at, t.merged_into_id, t.merged_at, t.merged_by,
            t.breach_alerted_at, t.breach_alerted_by, t.deleted_at
       from support_tickets t where t.id = $1`, [id])).rows[0];
  const events = async (id: string) => (await oi(
    `select seq, action, reason, detail from support_ticket_events
      where ticket_id = $1 order by seq`, [id])).rows;

  let n = 0;
  const logBody = (over: Record<string, any> = {}) => ({
    reporterName: "Amina Juma", reporterPhone: PHONE, channel: "phone_call",
    companyName: "Inx Smoke Freight", category: "cargo_clearing",
    subject: `Clearing stuck at the port ${MARK} ${++n}`,
    body: "The caller says a container has been held since Tuesday and nobody has answered "
      + "the reference she was given.",
    priority: "normal", language: "en", ...over
  });

  try {
    // ============================================================
    phase("the door, and the two duty keys the inbox runs on");
    check("an anonymous request does not reach the queue",
      (await call("/control/tickets")).status === 401);
    check("…nor the label library, nor the answers, nor the breach board",
      (await call("/control/ticket-tags")).status === 401
      && (await call("/control/canned-replies")).status === 401
      && (await call("/control/tickets/breaches")).status === 401);
    const bearer = await call("/control/tickets", { token: await mint(uSA, TC, ["super_admin"]) });
    check("an access token does not open it either — the desk signs in with its session cookie",
      bearer.status === 401, { s: bearer.status });

    const anTags = await call("/control/ticket-tags", { ck: ck("an") });
    check("the seat that only reads gets in and is told it only reads",
      anTags.status === 200 && anTags.json?.can_manage === false,
      { s: anTags.status, cm: anTags.json?.can_manage });
    for (const [label, path, body] of [
      ["a label", "/control/ticket-tags", { name: `quiet ${MARK}`, colour: null, note: null }],
      ["a bulk move", "/control/tickets/bulk",
        { ids: [randomUUID()], action: "priority", priority: "high", reason: "Reader tries a move." }],
      ["a breach notice", "/control/tickets/breaches/notify", { reason: "Reader tries to tell." }]
    ] as [string, string, Record<string, any>][]) {
      const r = await call(path, { ck: ck("an"), body });
      check(`the reading seat may not write ${label}, and is refused in words`,
        r.status === 403 && /duty|allow/i.test(r.json?.error?.message ?? ""),
        { s: r.status, m: clip(r.json?.error?.message) });
    }

    const foreign = await call("/control/tickets", { ck: ck("for") });
    check("a second platform desk reads its own empty register, not this one's",
      foreign.status === 200 && foreign.json?.items?.length === 0
      && foreign.json?.summary?.n === 0,
      { s: foreign.status, n: foreign.json?.summary?.n });
    const foreignLibraries = await Promise.all([
      call("/control/ticket-tags", { ck: ck("for") }),
      call("/control/canned-replies", { ck: ck("for") }),
      call("/control/tickets/breaches", { ck: ck("for") })
    ]);
    check("…and its label library, its answer library and its breach board are empty too, so no "
      + "desk sees another office's words",
      foreignLibraries.every((r) => r.status === 200)
      && foreignLibraries[0].json?.items?.length === 0
      && foreignLibraries[1].json?.items?.length === 0
      && foreignLibraries[2].json?.board?.length === 0,
      foreignLibraries.map((r) => [r.status, r.json?.items?.length ?? r.json?.board?.length]));

    // ============================================================
    phase("every source a call can arrive on, and the queue that tells them apart");
    const onChat = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ channel: "chat", category: "account_access",
        subject: `A code never arrived ${MARK}`, reporterName: "Baraka Mushi" })
    });
    check("a portal chat is written down as an incidence like any other, and keeps the channel "
      + "it came in on",
      onChat.status === 201 && onChat.json?.channel === "chat",
      { s: onChat.status, c: onChat.json?.channel });
    const onForm = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ channel: "web_form", category: "complaint",
        subject: `Someone filled the contact form ${MARK}`, reporterName: "Esther Nyange" })
    });
    check("…so does a web form, which has no gateway yet and is recorded all the same rather "
      + "than being refused",
      onForm.status === 201 && onForm.json?.channel === "web_form",
      { s: onForm.status, c: onForm.json?.channel });
    const onWalkIn = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ channel: "walk_in", category: "licence_billing",
        channel_note: undefined, language: "sw", reporterPhone: PHONE2,
        subject: `Mteja amefika ofisini ${MARK}`, reporterName: "Fatuma Hassan",
        companyName: "Inx Smoke Freight" } as any)
    });
    check("…and a walk-in caller who asked in Kiswahili keeps that language on the row, because "
      + "it is what decides which answer goes out",
      onWalkIn.status === 201 && onWalkIn.json?.language === "sw",
      { s: onWalkIn.status, l: onWalkIn.json?.language });
    const ninth = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ channel: "phonecall", subject: `A typo in the channel ${MARK}` })
    });
    check("a ninth word for a source is refused on the field, because the register would have "
      + "stored a channel its own filter can never match",
      ninth.status === 400 && /channel/i.test(
        (ninth.json?.error?.details ?? []).map((d: any) => d.field ?? d.message).join(" ")),
      { s: ninth.status, m: clip(ninth.json?.error?.message) });

    const chatRows = await call("/control/tickets?channel=chat", { ck: ck("sa") });
    check("the queue can be read one source at a time, and says which source it filtered to",
      chatRows.status === 200 && chatRows.json?.filters?.channel === "chat"
      && chatRows.json?.items?.length === 1
      && chatRows.json.items[0].id === onChat.json?.id,
      { s: chatRows.status, n: chatRows.json?.items?.length });
    const formRows = await call("/control/tickets?channel=web_form", { ck: ck("sa") });
    check("…and the same filter on the form gives the form's call back, no others",
      formRows.json?.items?.length === 1 && formRows.json.items[0].id === onForm.json?.id,
      formRows.json?.items?.map((t: any) => t.channel));
    const bogusChannel = await call("/control/tickets?channel=telegram", { ck: ck("sa") });
    check("a filter on a source the register does not hold is refused rather than quietly "
      + "returning an empty queue",
      bogusChannel.status === 400, { s: bogusChannel.status });

    // auto-routing on the two sources 125 added
    const ruleChat = await call("/control/departments/routes", {
      ck: ck("sa"), body: {
        name: `Chats are Support's ${MARK}`, departmentId: D1, channels: ["chat"],
        categories: ["account_access"], precedence: 40,
        reason: "A live chat about a code is answered by Support, whoever is free."
      }
    });
    check("a routing rule may name portal chat as its source — 125's channel list is the rule's "
      + "channel list, or the only rule that could route a chat could not be written",
      ruleChat.status === 200 && !!ruleChat.json?.id,
      { s: ruleChat.status, m: clip(ruleChat.json?.error?.message) });
    const routedChat = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({
        channel: "chat", category: "account_access", departmentId: undefined as any,
        subject: `Second chat ${MARK}`, reporterName: "Hamisi Salum" })
    });
    check("…and a chat nobody pointed anywhere is answered by that rule, not by a guess",
      routedChat.status === 201
      && routedChat.json?.routed_by_rule === `Chats are Support's ${MARK}`
      && routedChat.json?.allocated_to === "Support Desk",
      { s: routedChat.status, rule: routedChat.json?.routed_by_rule });
    const dryForm = await call("/control/departments/routes/match", {
      ck: ck("sa"), body: { channel: "web_form", category: "complaint", priority: "normal",
        language: "en" }
    });
    check("the rule dry-run speaks all eight sources too, so a desk can test a web-form call "
      + "before it ever arrives",
      dryForm.status === 200 && dryForm.json?.call?.channel === "web_form"
      && Array.isArray(dryForm.json?.rules_that_fit),
      { s: dryForm.status, m: clip(dryForm.json?.error?.message) });

    // ============================================================
    phase("labels the office invents for itself");
    const tagPort = await call("/control/ticket-tags", {
      ck: ck("sa"), body: { name: `Port Delay ${TAG_MARK}`.toLowerCase(), colour: "#7dd3fc",
        note: "Anything the port is holding, whatever the caller called it." }
    });
    check("a label is stored in the one spelling the filter reads, with the colour it was given",
      tagPort.status === 201 && tagPort.json?.name === `port delay ${TAG_MARK}`
      && tagPort.json?.colour === "#7dd3fc" && tagPort.json?.live === 0
      && tagPort.json?.tagged === 0,
      { s: tagPort.status, j: tagPort.json });
    const clash = await call("/control/ticket-tags", {
      ck: ck("sa"), body: { name: `PORT DELAY ${TAG_MARK}`, colour: null, note: null }
    });
    check("a second label whose only difference is capitals is refused — two names for one "
      + "problem is what the filter cannot show",
      clash.status === 409 && /already on the register/i.test(why(clash)),
      { s: clash.status, m: clip(why(clash)) });
    const badName = await call("/control/ticket-tags", {
      ck: ck("sa"), body: { name: "x", colour: null, note: null }
    });
    check("a one-letter label is refused with the shape of a label in the sentence",
      badName.status === 400 && /2 to 28 characters/i.test(why(badName)),
      { s: badName.status, m: clip(why(badName)) });
    const badColour = await call("/control/ticket-tags", {
      ck: ck("sa"), body: { name: `silly colour ${TAG_MARK}`, colour: "notacolour", note: null }
    });
    check("…and so is a colour that is not a colour, rather than a chip that renders as nothing",
      badColour.status === 400 && /hex colour/i.test(why(badColour)),
      { s: badColour.status, m: clip(why(badColour)) });
    const tagLate = await call("/control/ticket-tags", {
      ck: ck("sa"), body: { name: `answer late ${TAG_MARK}`, colour: null, note: null }
    });
    check("a label with no colour and no note is a legal label, because the office should not be "
      + "made up a colour to use one",
      tagLate.status === 201 && tagLate.json?.colour === null,
      { s: tagLate.status, c: tagLate.json?.colour });
    const PORT = tagPort.json?.id, LATE = tagLate.json?.id;

    const tagged = await call(`/control/tickets/${onChat.json.id}/tags`, {
      ck: ck("cs"), body: { tagId: PORT, reason: "The port is what this is about, whatever the "
        + "subject says." }
    });
    check("a label goes on a call and comes back on the same answer, so the row redraws without "
      + "a second query",
      tagged.status === 200 && tagged.json?.tags?.length === 1
      && tagged.json.tags[0].name === `port delay ${TAG_MARK}`,
      { s: tagged.status, t: tagged.json?.tags });
    const twice = await call(`/control/tickets/${onChat.json.id}/tags`, {
      ck: ck("cs"), body: { tagId: PORT, reason: "Labelled it twice by accident." }
    });
    check("putting the same label on the same call twice is refused in words, not by a unique "
      + "index number",
      twice.status === 409 && /already wears/i.test(twice.json?.error?.message ?? ""),
      { s: twice.status, m: clip(twice.json?.error?.message) });
    const inventedTag = await call(`/control/tickets/${onChat.json.id}/tags`, {
      ck: ck("cs"), body: { tagId: randomUUID(), reason: "A label nobody wrote." }
    });
    check("a label that is not on the register is refused with the way to fix it, and no "
      + "tagging row is left behind",
      inventedTag.status === 400 && /Make it first/i.test(inventedTag.json?.error?.message ?? "")
      && (await oi(`select count(*)::int as n from support_ticket_taggings where ticket_id = $1`,
        [onChat.json.id])).rows[0].n === 1,
      { s: inventedTag.status, m: clip(inventedTag.json?.error?.message) });
    await call(`/control/tickets/${onWalkIn.json.id}/tags`, {
      ck: ck("cs"), body: { tagId: LATE, reason: "Nobody has answered her since Tuesday." }
    });
    const byTag = await call(`/control/tickets?tag=${LATE}`, { ck: ck("sa") });
    check("the queue can be read label by label, which is the only way a word the office invented "
      + "on Tuesday is usable on Wednesday",
      byTag.status === 200 && byTag.json?.filters?.tag === LATE
      && byTag.json?.items?.length === 1 && byTag.json.items[0].id === onWalkIn.json.id,
      { s: byTag.status, n: byTag.json?.items?.length });
    const tagRename = await call(`/control/ticket-tags/${LATE}`, {
      ck: ck("sa"), method: "PUT", body: { name: `answer overdue ${TAG_MARK}`, colour: "#f87171",
        note: "Kept from the old name; the calls still wear it." }
    });
    check("a label is renamed whole, colour and note included, so a desk cannot tell an omitted "
      + "field from a cleared one",
      tagRename.status === 200 && tagRename.json?.name === `answer overdue ${TAG_MARK}`,
      { s: tagRename.status, j: clip(tagRename.json?.note) });
    const clearColour = await call(`/control/ticket-tags/${LATE}`, {
      ck: ck("sa"), method: "PUT", body: { name: `answer overdue ${TAG_MARK}`, colour: null,
        note: "" }
    });
    check("…and a colour deliberately cleared comes back cleared rather than refilled from the "
      + "row's own history",
      clearColour.status === 200 && clearColour.json?.colour === null
      && clearColour.json?.note === null,
      { s: clearColour.status, c: clearColour.json?.colour, nt: clearColour.json?.note });
    const foreignTag = await call(`/control/ticket-tags/${LATE}`, {
      ck: ck("for"), method: "PUT", body: { name: `somebody else ${TAG_MARK}`, colour: null, note: null }
    });
    check("another office's seat cannot rename this register's label — it is not in their "
      + "library at all",
      foreignTag.status === 404, { s: foreignTag.status });

    // ============================================================
    phase("a desk's own reopen window");
    const bareTerms = await call(`/control/departments/${D3}/terms`, {
      ck: ck("sa"), method: "PUT", body: {
        firstResponseMinutes: 60, resolveMinutes: 480, businessHours: WEEK, maxOpenTickets: 8,
        reason: "An hour to answer, eight calls at a time, no word about reopening."
      }
    });
    check("terms written without a reopen window leave the desk silent about it, which is a "
      + "different fact from a window of zero",
      bareTerms.status === 200 && bareTerms.json?.reopen_days === null,
      { s: bareTerms.status, r: bareTerms.json?.reopen_days });
    const setTen = await call(`/control/departments/${D3}/terms`, {
      ck: ck("sa"), method: "PUT", body: { reopenDays: 10, reason: "Ten days, now written down." }
    });
    check("a window can be set on its own, with the rest of the terms left exactly where they "
      + "were — the same presence rule the two promises run on",
      setTen.status === 200 && setTen.json?.reopen_days === 10
      && setTen.json?.first_response_minutes === 60,
      { s: setTen.status, r: setTen.json?.reopen_days, f: setTen.json?.first_response_minutes });
    const badWindow = await call(`/control/departments/${D3}/terms`, {
      ck: ck("sa"), method: "PUT", body: { reopenDays: 0, reason: "Zero days, please." }
    });
    check("a window of zero days is refused before it reaches the table, because a desk that "
      + "never reopens has said so by leaving the box empty",
      badWindow.status === 400, { s: badWindow.status });
    const hugeWindow = await call(`/control/departments/${D3}/terms`, {
      ck: ck("sa"), method: "PUT", body: { reopenDays: 91, reason: "A year, please." }
    });
    check("…and so is one past ninety days, which is 125's own bound and not this route's "
      + "invention", hugeWindow.status === 400, { s: hugeWindow.status });
    const clearedWindow = await call(`/control/departments/${D3}/terms`, {
      ck: ck("sa"), method: "PUT", body: { reopenDays: null, reason: "Take the window back off." }
    });
    const clearedWords = (await oi(
      `select detail from platform_duty_transitions where tenant_id = $1
         and action = 'department_updated' order by ts desc limit 1`,
      [TC])).rows[0]?.detail;
    const clearedAudit = (await oi(
      `select after from audit_logs where tenant_id = $1 and entity = 'platform_departments'
         and action = 'control.departments.department_updated'
         and after ? 'reopen_days' order by ts desc limit 1`,
      [TC])).rows[0]?.after;
    check("an explicit null clears the window, names the key that was written, keeps the "
      + "plain-words sentence about what that means in the transition register, and puts the "
      + "empty window in the audit line rather than the old number",
      clearedWindow.status === 200 && clearedWindow.json?.reopen_days === null
      && (clearedWindow.json?.changed ?? []).includes("reopenDays")
      && /reopened at any time/i.test(JSON.stringify(clearedWords ?? ""))
      && clearedAudit !== undefined && (clearedAudit as any).reopen_days === null,
      { s: clearedWindow.status, c: clearedWindow.json?.changed,
        w: clip(JSON.stringify(clearedWords ?? ""), 200), a: clip(JSON.stringify(clearedAudit ?? "")) });

    for (const [id, body] of [
      [D1, { firstResponseMinutes: 90, resolveMinutes: 960, businessHours: WEEK,
        maxOpenTickets: 6, reopenDays: 3,
        reason: "Ninety minutes to answer, three days to reopen." }],
      [D2, { firstResponseMinutes: 120, resolveMinutes: 480, businessHours: WEEK,
        maxOpenTickets: 6, reopenDays: 1, reason: "Two hours to answer, one day to come back." }],
      [D4, { reopenDays: null, reason: "Bare Desk keeps no promises at all." }]
    ] as [string, Record<string, any>][]) {
      const r = await call(`/control/departments/${id}/terms`, {
        ck: ck("sa"), method: "PUT", body
      });
      if (r.status !== 200) throw new Error(`fixture terms failed: ${r.text.slice(0, 300)}`);
    }
    await oi(`update platform_departments set head_user_id = $1 where id = any($2::uuid[])`,
      [uCS, [D1, D2, D5]]);
    check("three of this run's desks have a head on the chart and two do not — the notice needs "
      + "both shapes before it can say anything honest",
      (await oi(`select count(*)::int as n from platform_departments where tenant_id = $1
                   and head_user_id is not null`, [TC])).rows[0].n === 3);

    // inside the window
    const w1 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D1,
        subject: `A job finished too early ${MARK}`, reporterName: "Rashida Ali" })
    });
    await call(`/control/tickets/${w1.json.id}/resolve`, {
      ck: ck("cs"), body: { outcome: "resolved",
        resolution: "The port released the container and the caller confirmed it.",
        reason: "Confirmed on the phone." }
    });
    const quietWork = await call(`/control/tickets/${w1.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reason: "Quietly editing a finished job." }
    });
    check("a finished job does not move back into work on a plain status change — the desk is "
      + "told to say the caller rang back",
      quietWork.status === 409 && /rang back/i.test(quietWork.json?.error?.message ?? ""),
      { s: quietWork.status, m: clip(quietWork.json?.error?.message) });
    const reopened1 = await call(`/control/tickets/${w1.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reopen: true,
        reason: "The caller rang back: the release was for the wrong container." }
    });
    const r1 = await row(w1.json.id);
    check("inside its own window, a settled call comes back into work — the answer stamp is "
      + "cleared because the first answer belongs to the attempt that failed",
      reopened1.status === 200 && reopened1.json?.status === "in_progress"
      && r1?.first_response_at === null && r1?.resolved_at === null,
      { s: reopened1.status, fr: r1?.first_response_at, res: r1?.resolved_at });
    check("…the count and the minute are on the row, so a desk that reopens a call every week is "
      + "visible as one that is not finishing them",
      Number(r1?.reopen_count) === 1 && !!r1?.last_reopened_at,
      r1 && [r1.reopen_count, r1.last_reopened_at]);
    check("…and both promises are re-made from now rather than carried over, because a reopened "
      + "line owes the caller a new answer",
      ms(r1?.response_due_at) - Date.now() > 60 * MIN
      && ms(r1?.resolution_due_at) > ms(r1?.response_due_at),
      r1 && [new Date(r1.response_due_at).toISOString(), new Date(r1.resolution_due_at).toISOString()]);
    const reopenEvents = await events(w1.json.id);
    check("…the register has its own word for it, and keeps the resolution the failed attempt "
      + "recorded in the line",
      reopenEvents.some((e: any) => e.action === "reopened"
        && e.detail?.reopen_count === 1 && !!e.detail?.previous_resolution),
      reopenEvents.map((e: any) => e.action));

    // outside the window
    const w2 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D2,
        subject: `A job finished, and then not ${MARK}`, reporterName: "Joseph Athumani" })
    });
    await call(`/control/tickets/${w2.json.id}/resolve`, {
      ck: ck("cs"), body: { outcome: "resolved",
        resolution: "The licence was filed and the caller has the receipt.",
        reason: "Confirmed with the caller." }
    });
    await oi(`update support_tickets set resolved_at = now() - interval '5 days' where id = $1`,
      [w2.json.id]);
    const reopenLate = await call(`/control/tickets/${w2.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reopen: true,
        reason: "The caller says the licence still shows unpaid." }
    });
    const r2 = await row(w2.json.id);
    check("past the window the desk itself wrote, the reopen is refused by the register, and the "
      + "sentence names the wait, the desk's days and the way out",
      reopenLate.status === 409
      && /settled 5\.0 day\(s\) ago/.test(reopenLate.json?.error?.message ?? "")
      && /The Window gives 1 day\(s\) to reopen it/.test(reopenLate.json?.error?.message ?? "")
      && /log the new call as its own incidence and fold it onto this one instead/.test(
        reopenLate.json?.error?.message ?? ""),
      { s: reopenLate.status, m: clip(reopenLate.json?.error?.message) });
    check("…the refusal left the row exactly as it was — settled, stamped, and unchanged",
      r2?.status === "resolved" && Number(r2?.reopen_count) === 0 && !!r2?.resolved_at,
      r2 && [r2.status, r2.reopen_count]);
    check("…and the reason is not re-derived in this route: no event line was written for a "
      + "reopen that never happened",
      !(await events(w2.json.id)).some((e: any) => e.action === "reopened"),
      (await events(w2.json.id)).map((e: any) => e.action));

    // no window written at all
    const w3 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D3,
        subject: `An old job that comes back ${MARK}`, reporterName: "Mushi Bakari" })
    });
    await call(`/control/tickets/${w3.json.id}/resolve`, {
      ck: ck("cs"), body: { outcome: "closed",
        resolution: "The caller withdrew it; nothing more was owed.", reason: "Said so on the call." }
    });
    await oi(`update support_tickets set resolved_at = now() - interval '200 days' where id = $1`,
      [w3.json.id]);
    const reopenOld = await call(`/control/tickets/${w3.json.id}/work`, {
      ck: ck("cs"), body: { status: "allocated", reopen: true,
        reason: "The same caller is back: the withdrawal was a mistake." }
    });
    check("a desk that never wrote a window keeps taking its own finished calls back, however "
      + "old — silence is not a deadline, and the register does not invent one",
      reopenOld.status === 200 && reopenOld.json?.status === "allocated"
      && Number((await row(w3.json.id)).reopen_count) === 1,
      { s: reopenOld.status, m: clip(reopenOld.json?.error?.message) });
    const backToWork = await call(`/control/tickets/${w3.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reason: "Back to work on the second attempt." }
    });
    check("…and once the call is inside the work again the desk moves it the ordinary way — no "
      + "reopen flag, and the attempt count stays on the one reopen the caller actually caused",
      backToWork.status === 200 && backToWork.json?.status === "in_progress"
      && Number((await row(w3.json.id)).reopen_count) === 1,
      { s: backToWork.status, m: clip(backToWork.json?.error?.message) });

    const reopenedTile = await call("/control/tickets?status=allocated,in_progress,open",
      { ck: ck("sa") });
    const reopenedRows = (reopenedTile.json?.items ?? []).filter((t: any) => t.reopen_count > 0);
    check("the queue shows which calls are here for the second time, and its own count of them "
      + "is the rows it returned",
      Number(reopenedTile.json?.summary?.reopened) === reopenedRows.length
      && reopenedRows.length >= 2,
      { tile: reopenedTile.json?.summary?.reopened, rows: reopenedRows.length });

    // ============================================================
    phase("duplicates folded into the one line that stays");
    const keeper = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D1,
        subject: `The container that is really stuck ${MARK}`, reporterName: "Amina Juma" })
    });
    const dupA = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D2,
        subject: `Same container, second office ${MARK}`, reporterName: "Amina Juma" })
    });
    const dupB = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D3,
        subject: `Same container, rang again ${MARK}`, reporterName: "Amina Juma" })
    });
    await call(`/control/tickets/${dupA.json.id}/tags`, {
      ck: ck("sa"), body: { tagId: PORT, reason: "It is the port, whichever office took it." }
    });
    const foldA = await call(`/control/tickets/${dupA.json.id}/merge`, {
      ck: ck("sa"), body: { intoId: keeper.json.id,
        reason: "One container, three telephone calls — Support answers it." }
    });
    check("a duplicate folds into the line that stays and is told where the call actually is, "
      + "not merely that it worked",
      foldA.status === 200 && foldA.json?.status === "merged"
      // The pointer a fold leaves behind is the keeper's own register number — the string the
      // caller was read out — not the keeper's desk queue number.
      && foldA.json?.merged_into_ref === keeper.json?.ref
      && /Support Desk/.test(String(foldA.json?.answer)) && foldA.json?.folded_under?.length === 1,
      { s: foldA.status, m: clip(foldA.json) });
    const foldB = await call(`/control/tickets/${dupB.json.id}/merge`, {
      ck: ck("sa"), body: { intoId: keeper.json.id, reason: "Third call about the same box." }
    });
    check("…a second duplicate joins the same keeper and the desk is shown the whole shape of "
      + "the call afterwards",
      foldB.status === 200 && foldB.json?.folded_under?.length === 2,
      { s: foldB.status, n: foldB.json?.folded_under?.length });
    const selfFold = await call(`/control/tickets/${keeper.json.id}/merge`, {
      ck: ck("sa"), body: { intoId: keeper.json.id, reason: "Fold it into itself." }
    });
    check("a call cannot be folded into itself, and the refusal is said before the register is "
      + "touched", selfFold.status === 400, { s: selfFold.status });
    const moveFold = await call(`/control/tickets/${dupA.json.id}/merge`, {
      ck: ck("sa"), body: { intoId: keeper.json.id, reason: "Try the fold again." }
    });
    check("an already-folded line is refused with the keeper's own number: a fold is followed "
      + "onward, never moved",
      moveFold.status === 409 && /already folded into/i.test(moveFold.json?.error?.message ?? "")
      && String(moveFold.json?.error?.message ?? "").includes(String(keeper.json?.ref ?? "")),
      { s: moveFold.status, m: clip(moveFold.json?.error?.message) });
    const intoFolded = await call(`/control/tickets/${onChat.json.id}/merge`, {
      ck: ck("sa"), body: { intoId: dupA.json.id, reason: "Fold a live call into a folded one." }
    });
    check("…and nothing may be folded into a line that has itself been folded away, because the "
      + "number the caller was given would then point at a closed door",
      intoFolded.status === 409 && /itself folded/i.test(intoFolded.json?.error?.message ?? ""),
      { s: intoFolded.status, m: clip(intoFolded.json?.error?.message) });
    const retired = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D1,
        subject: `A call that should not be here ${MARK}`, reporterName: "Nobody" })
    });
    // The withdrawal has to be a fact before the fold can be refused for it. The register will
    // not hide a call that is still open, so this finishes the line the way a desk would and
    // then checks the row really left the boards.
    const retiredSettled = await call(`/control/tickets/${retired.json.id}/resolve`, {
      ck: ck("cs"), body: { outcome: "closed",
        resolution: "Logged twice by mistake; the other line is the one being worked.",
        reason: "Ending the duplicate so it can be withdrawn." }
    });
    if (retiredSettled.status !== 200) {
      throw new Error(`retired fixture could not be closed: ${retiredSettled.text.slice(0, 240)}`);
    }
    const retiredGone = await call(`/control/tickets/${retired.json.id}/tombstone`, {
      ck: ck("sa"), body: { reason: "Logged twice by mistake; keeping the other." }
    });
    if (retiredGone.status !== 200) {
      throw new Error(`retired fixture could not be withdrawn: ${retiredGone.text.slice(0, 240)}`);
    }
    const intoRetired = await call(`/control/tickets/${onForm.json.id}/merge`, {
      ck: ck("sa"), body: { intoId: retired.json.id, reason: "Fold into the withdrawn line." }
    });
    check("nor into a retired incidence — the register refuses it, and the words say which line "
      + "is retired",
      intoRetired.status === 409 && /retired incidence/i.test(intoRetired.json?.error?.message ?? ""),
      { s: intoRetired.status, m: clip(intoRetired.json?.error?.message) });

    for (const [label, path, body] of [
      ["work", "work", { status: "in_progress", reason: "Try to work a folded line." }],
      ["settle", "resolve", { outcome: "resolved", resolution: "Try to finish a folded line.",
        reason: "Try to finish a folded line." }],
      ["hand over", "allocate", { departmentId: D5, reason: "Try to move a folded line." }]
    ] as [string, string, Record<string, any>][]) {
      const r = await call(`/control/tickets/${dupA.json.id}/${path}`, { ck: ck("cs"), body });
      check(`a folded line cannot be used for ${label}, and the answer names the keeper's number `
        + "so the desk knows where to go",
        r.status === 409 && /folded into/.test(r.json?.error?.message ?? "")
        // The register names a line by its incidence number, the one the caller was given — not
        // by the queue number the desk that holds it happens to use.
        && new RegExp(String(keeper.json?.ref ?? "^^")).test(r.json?.error?.message ?? ""),
        { s: r.status, m: clip(r.json?.error?.message) });
    }
    const tagFolded = await call(`/control/tickets/${dupA.json.id}/tags`, {
      ck: ck("sa"), body: { tagId: LATE, reason: "Label a folded line." }
    });
    check("…nor labelled, because a chip on a line nobody works is a chip the queue filter "
      + "cannot open", tagFolded.status === 409 && /is labelled/i.test(
        tagFolded.json?.error?.message ?? ""),
      { s: tagFolded.status, m: clip(tagFolded.json?.error?.message) });
    const detailFolded = await call(`/control/tickets/${dupA.json.id}`, { ck: ck("sa") });
    check("the folded line still reads in full — its own number, its own history, and where it "
      + "went — and the panel is told there is no work door here",
      detailFolded.status === 200 && detailFolded.json?.ticket?.status === "merged"
      && detailFolded.json?.ticket?.merged_into_ref === keeper.json?.ref
      && detailFolded.json?.can_work === false
      && detailFolded.json?.events?.length >= 3,
      { s: detailFolded.status, cw: detailFolded.json?.can_work,
        mr: detailFolded.json?.ticket?.merged_into_ref });
    const keeperDetail = await call(`/control/tickets/${keeper.json.id}`, { ck: ck("sa") });
    check("…while the keeper keeps its own queue number and its own deadlines through every fold, "
      + "because a fold is a decision about who answers, not an edit of the history",
      keeperDetail.json?.ticket?.dept_ref === keeper.json?.dept_ref
      && !!keeperDetail.json?.ticket?.response_due_at,
      keeperDetail.json?.ticket && [keeperDetail.json.ticket.dept_ref]);
    const mergedQueue = await call("/control/tickets?status=merged", { ck: ck("sa") });
    const mergedIds = (mergedQueue.json?.items ?? []).map((t: any) => t.id);
    check("`merged` is filterable as a state of its own, and the header's count of folded calls "
      + "is the rows on the board",
      mergedQueue.status === 200 && mergedIds.includes(dupA.json.id)
      && mergedIds.includes(dupB.json.id)
      && Number(mergedQueue.json?.summary?.folded) === mergedIds.length,
      { s: mergedQueue.status, n: mergedIds.length, f: mergedQueue.json?.summary?.folded });
    const badState = await call("/control/tickets?status=archived", { ck: ck("sa") });
    check("a state the register does not have is refused by name, with the words the states are "
      + "called in", badState.status === 400 && /archived/.test(badState.json?.error?.message ?? ""),
      { s: badState.status, m: clip(badState.json?.error?.message) });
    const tagsAfter = await call("/control/ticket-tags", { ck: ck("sa") });
    const portRow = (tagsAfter.json?.items ?? []).find((t: any) => t.id === PORT);
    check("a label's two counts are different facts: how many live calls wear it, and how many "
      + "have ever worn it — a folded line stops being work but not evidence",
      portRow?.live === 1 && portRow?.tagged === 2, portRow);
    const retireLate = await call(`/control/ticket-tags/${LATE}/tombstone`, {
      ck: ck("sa"), body: { reason: "The board says the same thing now; keeping the label off "
        + "the picker." }
    });
    check("retiring a label does not unlabel the calls that wore it, and says so with the number "
      + "still carrying it",
      retireLate.status === 200 && retireLate.json?.retired === true
      && /1 live call\(s\) still carry/.test(String(retireLate.json?.note)),
      { s: retireLate.status, n: clip(retireLate.json?.note) });
    const libraryAfter = await call("/control/ticket-tags", { ck: ck("sa") });
    check("…the retired label leaves the picker so nobody can choose it, while its taggings stay "
      + "on the calls",
      !(libraryAfter.json?.items ?? []).some((t: any) => t.id === LATE)
      && (await row2tags(onWalkIn.json.id)).includes(LATE));
    const applyRetired = await call(`/control/tickets/${onChat.json.id}/tags`, {
      ck: ck("sa"), body: { tagId: LATE, reason: "Try to put a retired label on." }
    });
    check("and it cannot be put on anything new — the register refuses it before the insert "
      + "crosses a guard",
      applyRetired.status === 400 && /retired/i.test(applyRetired.json?.error?.message ?? ""),
      { s: applyRetired.status, m: clip(applyRetired.json?.error?.message) });
    const dropRetired = await call(`/control/tickets/${onWalkIn.json.id}/tags/drop`, {
      ck: ck("sa"), body: { tagId: LATE, reason: "Take the retired label off the call that still "
        + "wears it." }
    });
    check("…yet it can still be taken off a call that is wearing it, which is the one thing a "
      + "retired label must still allow",
      dropRetired.status === 200 && dropRetired.json?.tags?.length === 0,
      { s: dropRetired.status, t: dropRetired.json?.tags });
    const dropAgain = await call(`/control/tickets/${onWalkIn.json.id}/tags/drop`, {
      ck: ck("sa"), body: { tagId: LATE, reason: "Take it off a second time." }
    });
    check("…and taking it off twice is refused with the honesty of \"nothing was taken off\", "
      + "rather than a silent ok",
      dropAgain.status === 409 && /does not wear/i.test(dropAgain.json?.error?.message ?? ""),
      { s: dropAgain.status, m: clip(dropAgain.json?.error?.message) });

    // ============================================================
    phase("the same act, several times: bulk");
    const b1 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ subject: `Bulk one ${MARK}`, reporterName: "Caller One" })
    });
    const b2 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ subject: `Bulk two ${MARK}`, reporterName: "Caller Two" })
    });
    const b3 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ subject: `Bulk three ${MARK}`, reporterName: "Caller Three" })
    });
    const squeeze = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D5, subject: `The squeeze ${MARK}`,
        reporterName: "Caller Four" })
    });
    await call(`/control/departments/${D5}/terms`, {
      ck: ck("sa"), method: "PUT", body: { firstResponseMinutes: 30, resolveMinutes: 120,
        businessHours: WEEK, maxOpenTickets: 1, reason: "One call at a time, honestly." }
    });
    const needDesk = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: [b1.json.id], action: "allocate", reason: "Which desk, please?" }
    });
    check("a bulk move that names no desk is refused on the field before a single line moves",
      needDesk.status === 400 && /departmentId/i.test(
        (needDesk.json?.error?.details ?? []).map((d: any) => d.field).join(",")),
      { s: needDesk.status });
    const ceiling = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: [b1.json.id, b2.json.id], action: "allocate", departmentId: D5,
        reason: "The squeeze is full but try anyway." }
    });
    check("a bulk allocation onto a desk at its own ceiling is refused whole, and the answer says "
      + "nothing was moved",
      ceiling.status === 409 && /Nothing was moved/.test(ceiling.json?.error?.message ?? "")
      && (await row(b1.json.id)).department_id === null,
      { s: ceiling.status, m: clip(ceiling.json?.error?.message) });
    const fiftyOne = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: Array.from({ length: 51 }, () => randomUUID()),
        action: "priority", priority: "high", reason: "Fifty-one at once." }
    });
    check("and a request over fifty is refused rather than run — nobody can watch fifty rows "
      + "move and be sure they meant all of them",
      fiftyOne.status === 400, { s: fiftyOne.status });
    const ghostId = randomUUID();
    const bulk = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: {
        ids: [b1.json.id, b2.json.id, keeper.json.id, dupA.json.id, w2.json.id, ghostId],
        action: "allocate", departmentId: D1,
        reason: "Support takes the week's queue back off the pool."
      }
    });
    const lines = new Map<string, any>((bulk.json?.lines ?? []).map((l: any) => [l.id, l]));
    check("a mixed list is applied line by line: the two that can move did, and every one that "
      + "could not says why in its own words",
      bulk.status === 200 && bulk.json?.applied === 2 && bulk.json?.refused === 4
      && bulk.json?.asked === 6,
      { s: bulk.status, a: bulk.json?.applied, r: bulk.json?.refused, asked: bulk.json?.asked });
    check("…a call already on that desk is refused as already there, not silently re-numbered",
      /already on "Support Desk"/.test(String(lines.get(keeper.json.id)?.note)),
      lines.get(keeper.json.id)?.note);
    check("…a folded line is refused with the keeper sentence rather than a bare failure",
      /folded into/.test(String(lines.get(dupA.json.id)?.note)), lines.get(dupA.json.id)?.note);
    check("…a settled line is refused with the reopen in the same words the single door uses",
      /Reopen it before moving the work/.test(String(lines.get(w2.json.id)?.note)),
      lines.get(w2.json.id)?.note);
    check("…and a line that is not in the register at all is refused without stopping the others",
      /not in the register/i.test(String(lines.get(ghostId)?.note))
      && lines.get(ghostId)?.ref === null && lines.size === 6,
      { ghost: lines.get(ghostId), size: lines.size });
    check("…the refusals cost nothing: the folded line is still merged and the settled line "
      + "still resolved",
      (await row(dupA.json.id)).status === "merged"
      && (await row(w2.json.id)).status === "resolved",
      await row(w2.json.id));
    check("…while the two that moved took the desk's number and the desk's clock, not nothing",
      (await row(b1.json.id)).dept_ref !== null
      && (await row(b2.json.id)).response_due_at !== null,
      [await row(b1.json.id), await row(b2.json.id)].map((r) => [r.dept_ref, r.response_due_at]));
    // One of the three already wears the label before the bulk runs, put on it through the single
    // door. A bulk label that reports "already done" needs a line that genuinely already was, or
    // the count of refusals is a number the run made up.
    const singleTag = await call(`/control/tickets/${b1.json.id}/tags`, {
      ck: ck("sa"), body: { tagId: PORT, reason: "Support's own port label, put on one at a time." }
    });
    if (singleTag.status !== 200) {
      throw new Error(`bulk tag fixture failed: ${singleTag.text.slice(0, 240)}`);
    }
    const bulkTags = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: [b1.json.id, b2.json.id, squeeze.json.id], action: "tags_add",
        tagIds: [PORT], reason: "Everything on this desk is about the port." }
    });
    check("a bulk label reports the lines that already wore it as refusals of their own, so the "
      + "desk can tell eight labelled from four already-done",
      bulkTags.status === 200 && Number(bulkTags.json?.applied) === 2
      && Number(bulkTags.json?.refused) === 1
      && /already wears/.test(String((bulkTags.json?.lines ?? [])
        .find((l: any) => l.id === b1.json.id)?.note)),
      { a: bulkTags.json?.applied, r: bulkTags.json?.refused,
        n: clip(String((bulkTags.json?.lines ?? []).find((l: any) => l.id === b1.json.id)?.note)) });
    const elevenTags = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: [b1.json.id], action: "tags_add",
        tagIds: Array.from({ length: 11 }, () => randomUUID()), reason: "Eleven labels at once." }
    });
    check("more than ten labels in one request is refused on the field, before any of them is "
      + "checked against the register", elevenTags.status === 400, { s: elevenTags.status });
    const liveLate = async () => Number((await oi(
      `select count(*)::int as n from support_ticket_taggings
        where tag_id = $1 and deleted_at is null`, [LATE])).rows[0].n);
    const beforeLate = await liveLate();
    const withRetired = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: [b1.json.id, b2.json.id], action: "tags_add",
        tagIds: [PORT, LATE], reason: "One live label and one retired." }
    });
    check("a bulk label that names a retired label moves nothing at all rather than half of it, "
      + "and says so before a single line is touched",
      withRetired.status === 400 && /not on this register/i.test(why(withRetired))
      && (await liveLate()) === beforeLate,
      { s: withRetired.status, m: clip(why(withRetired)), late: beforeLate });
    const bulkEsc = await call("/control/tickets/bulk", {
      ck: ck("sa"), body: { ids: [b1.json.id], action: "escalate", departmentId: D2,
        reason: "Up to the window desk." }
    });
    check("bulk escalation runs through the same doors as a single one — a call nobody has "
      + "answered may go up, and the receipt says which desk it went to",
      bulkEsc.status === 200 && Number(bulkEsc.json?.applied) === 1
      && bulkEsc.json?.department?.name === "The Window"
      && (await row(b1.json.id)).department_id === D2,
      { s: bulkEsc.status, j: clip(bulkEsc.json?.note) });

    // ============================================================
    phase("the answers the office gives every week");
    const reply = await call("/control/canned-replies", {
      ck: ck("sa"), body: {
        slug: `port_held_${STAMP}`, title: "Container held at the port",
        bodyEn: "Hello {name}, we are chasing {ref} for {company} with the clearing desk in "
          + "{department}. — {agent}",
        bodySw: "Habari {name}, tunafuatilia {ref} ya {company} na desk ya clearance. — {agent}",
        category: "cargo_clearing", note: "The one the port gives everybody."
      }
    });
    check("an answer is written once, in both languages, on one row",
      reply.status === 201 && reply.json?.is_active === true && !!reply.json?.body_sw,
      { s: reply.status, j: clip(reply.json) });
    const invented = await call("/control/canned-replies", {
      ck: ck("sa"), body: { slug: `bad_tokens_${STAMP}`, title: "Invented placeholder",
        bodyEn: "Your {invoice} is ready, {name}.", category: null, note: null }
    });
    check("a placeholder the register cannot fill is refused at the door, naming it, so a desk "
      + "never writes a brace that reaches a caller still spelled with braces",
      invented.status === 400 && /\{invoice\}/.test(invented.json?.error?.message ?? ""),
      { s: invented.status, m: clip(invented.json?.error?.message) });
    const slugClash = await call("/control/canned-replies", {
      ck: ck("sa"), body: { slug: `PORT_HELD_${STAMP}`.toLowerCase(), title: "Same answer twice",
        bodyEn: "Duplicate answer body.", category: null, note: null }
    });
    check("a second answer with a name the register already uses is refused with the title of "
      + "the first one",
      slugClash.status === 409 && /Container held at the port/.test(
        slugClash.json?.error?.message ?? ""),
      { s: slugClash.status, m: clip(slugClash.json?.error?.message) });
    const badSlug = await call("/control/canned-replies", {
      ck: ck("sa"), body: { slug: "Port-Held", title: "A slug with capitals and a dash",
        bodyEn: "Whatever the body says.", category: null, note: null }
    });
    check("a slug a clerk could not type mid-call is refused with the shape of a slug",
      badSlug.status === 400 && /3 to 30 characters/i.test(why(badSlug)),
      { s: badSlug.status, m: clip(why(badSlug)) });
    const withSlug = await call(`/control/canned-replies/${reply.json.id}`, {
      ck: ck("sa"), method: "PUT", body: { slug: `renamed_${STAMP}`, title: "Try to rename",
        bodyEn: "Body again.", isActive: true }
    });
    check("the edit form has no slug in it, because renaming an answer out from under the people "
      + "who memorised it is worse than the typo it fixes",
      withSlug.status === 400 && /slug/i.test(
        (withSlug.json?.error?.message ?? "") + (withSlug.json?.error?.details ?? [])
          .map((d: any) => d.message ?? d.field).join(" ")),
      { s: withSlug.status, m: clip(withSlug.json?.error?.message) });
    const edited = await call(`/control/canned-replies/${reply.json.id}`, {
      ck: ck("sa"), method: "PUT", body: { title: "Container held at the port (revised)",
        bodyEn: "Hello {name}, {ref} is with the clearing desk now. — {agent}",
        bodySw: "Habari {name}, {ref} iko na desk ya clearance. — {agent}",
        category: "cargo_clearing", note: "Revised after the port changed its desk.",
        isActive: false }
    });
    check("an answer can be put out of use without being deleted, and the audit line says which "
      + "office member did it",
      edited.status === 200 && edited.json?.is_active === false
      && edited.json?.title === "Container held at the port (revised)"
      && (await oi(`select count(*)::int as n from audit_logs where tenant_id = $1
                     and entity = 'support_canned_replies' and action = 'control.canned_replies.updated'
                     and after ? 'is_active'`, [TC])).rows[0].n === 1,
      { s: edited.status, a: edited.json?.is_active });
    const backOn = await call(`/control/canned-replies/${reply.json.id}`, {
      ck: ck("sa"), method: "PUT", body: { title: "Container held at the port",
        bodyEn: reply.json.body_en, bodySw: reply.json.body_sw, category: "cargo_clearing",
        note: "Back in use for this run.", isActive: true }
    });
    if (backOn.status !== 200) throw new Error(`reply re-activation failed: ${backOn.text.slice(0, 200)}`);

    const en = await call("/control/canned-replies/preview", {
      ck: ck("sa"), body: { replyId: reply.json.id, ticketId: keeper.json.id, language: "en" }
    });
    check("a preview fills the placeholders from the call it was picked for, in the language it "
      + "was asked for",
      en.status === 200 && en.json?.language === "en"
      && en.json?.text?.includes("Amina Juma") && en.json?.text?.includes(keeper.json?.ref)
      && en.json?.unfilled?.length === 0 && en.json?.note === null,
      { s: en.status, t: clip(en.json?.text), u: en.json?.unfilled });
    const sw = await call("/control/canned-replies/preview", {
      ck: ck("sa"), body: { replyId: reply.json.id, ticketId: onWalkIn.json.id }
    });
    check("…and the same answer against a caller whose own language is Kiswahili comes out in "
      + "Kiswahili without anybody choosing it",
      sw.status === 200 && sw.json?.asked_for === "sw"
      && /^Habari Fatuma/.test(String(sw.json?.text)),
      { s: sw.status, asked: sw.json?.asked_for, t: clip(sw.json?.text) });
    const hole = await call("/control/canned-replies/preview", {
      ck: ck("sa"), body: { replyId: reply.json.id, ticketId: b3.json.id, language: "en" }
    });
    check("…a preview against a call with no desk says which hole it cannot fill instead of "
      + "printing a brace or pretending",
      hole.status === 200 && !/\{/.test(String(hole.json?.text))
      && hole.json?.unfilled?.includes("department")
      && /cannot fill/.test(String(hole.json?.note)),
      { t: clip(hole.json?.text), u: hole.json?.unfilled, n: clip(hole.json?.note) });
    const englishOnly = await call("/control/canned-replies", {
      ck: ck("sa"), body: { slug: `no_swahili_${STAMP}`, title: "Customs form only in English",
        bodyEn: "The customs form for {ref} is attached.", category: "cargo_clearing",
        note: "No Swahili half, on purpose." }
    });
    const fellBack = await call("/control/canned-replies/preview", {
      ck: ck("sa"), body: { replyId: englishOnly.json?.id, ticketId: onWalkIn.json.id,
        language: "sw" }
    });
    check("an answer the office never translated says that it fell back to English rather than "
      + "silently answering a Kiswahili caller in English",
      fellBack.status === 200 && fellBack.json?.fell_back === true
      && /customs form/.test(String(fellBack.json?.text)),
      { s: fellBack.status, f: fellBack.json?.fell_back, t: clip(fellBack.json?.text) });
    const noArgs = await call("/control/canned-replies/preview", { ck: ck("sa"), body: {} });
    check("a preview with neither an answer nor words is refused on both fields",
      noArgs.status === 400 && /replyId/.test(
        (noArgs.json?.error?.details ?? []).map((d: any) => d.field).join(",")),
      { s: noArgs.status });

    const answered = await call(`/control/tickets/${keeper.json.id}/answer`, {
      ck: ck("cs"), body: { replyId: reply.json.id, language: "en",
        reason: "Read the port answer to the caller on the phone." }
    });
    check("using an answer writes the words into the incidence's own register, and stops the "
      + "answer clock because a human has now said something",
      answered.status === 200 && !!answered.json?.first_response_at
      && answered.json?.text?.includes(keeper.json?.ref)
      && (await row(keeper.json.id)).first_response_at !== null,
      { s: answered.status, fr: answered.json?.first_response_at });
    const answerEvents = await events(keeper.json.id);
    const answerLine = answerEvents.find((e: any) => e.action === "note_added"
      && e.detail?.answered === true);
    check("…the register line carries the language, the channel it was said on and which answer "
      + "it was, so \"what did we tell her\" is one read away",
      !!answerLine && answerLine.detail?.reply_slug === `port_held_${STAMP}`
      && answerLine.detail?.channel === "phone_call" && answerLine.detail?.language === "en"
      && String(answerLine.reason).includes("port answer"),
      answerLine && clip(answerLine.detail));
    const wordsOnly = await call(`/control/tickets/${b3.json.id}/answer`, {
      ck: ck("cs"), body: { text: "Called the quay and got the container's new position; the "
        + "caller will be rung back within the hour.", channel: "whatsapp",
        reason: "No answer fits this one, so it was written." }
    });
    check("an answer written by hand is kept just as well, and the channel it went out on is "
      + "recorded rather than assumed from the one the call arrived on",
      wordsOnly.status === 200 && wordsOnly.json?.unfilled?.length === 0
      && (await events(b3.json.id)).some((e: any) => e.action === "note_added"
        && e.detail?.channel === "whatsapp"),
      { s: wordsOnly.status, c: clip(wordsOnly.json) });
    const emptyAnswer = await call(`/control/tickets/${b3.json.id}/answer`, {
      ck: ck("cs"), body: { reason: "Say nothing at all." }
    });
    check("an answer with no words in it is refused: the desk either picks one or writes one",
      emptyAnswer.status === 400 && /Say what was answered/i.test(
        emptyAnswer.json?.error?.message ?? ""), { s: emptyAnswer.status });
    const b3Events = (await events(b3.json.id)).length;
    const ghostReply = await call(`/control/tickets/${b3.json.id}/answer`, {
      ck: ck("cs"), body: { replyId: randomUUID(), reason: "An answer nobody wrote." }
    });
    check("an answer id that is not on the register is refused without writing a line",
      ghostReply.status === 400 && /not on this register/i.test(
        ghostReply.json?.error?.message ?? "")
      && (await events(b3.json.id)).length === b3Events,
      { s: ghostReply.status, n: (await events(b3.json.id)).length, before: b3Events });
    const retiredReply = await call(`/control/canned-replies/${englishOnly.json.id}/tombstone`, {
      ck: ck("sa"), body: { reason: "The office does not say this any more." }
    });
    check("retiring an answer leaves the row readable and frees its name, which is how a wrong "
      + "slug is fixed without destroying a line",
      retiredReply.status === 200 && retiredReply.json?.retired === true,
      { s: retiredReply.status });
    const reuse = await call("/control/canned-replies", {
      ck: ck("sa"), body: { slug: `customs_form_${STAMP}`, title: "A fresh answer",
        bodyEn: "The customs form for {ref} will be sent today.", category: null, note: null }
    });
    const sameSlugAgain = await call("/control/canned-replies", {
      ck: ck("sa"), body: { slug: `no_swahili_${STAMP}`, title: "Same slug as the retired one",
        bodyEn: "Reusing a retired name.", category: null, note: null }
    });
    check("…and the name a retired answer used is free again for a live row, because the clash "
      + "test only counts answers the desk can still pick",
      reuse.status === 201 && sameSlugAgain.status === 201,
      { s: sameSlugAgain.status, m: clip(sameSlugAgain.json?.error?.message), fresh: reuse.status });
    const useGone = await call(`/control/tickets/${b3.json.id}/answer`, {
      ck: ck("cs"), body: { replyId: englishOnly.json.id, reason: "Use the answer that was taken "
        + "off the register." }
    });
    check("an answer that was retired cannot be used on a call — the door says it is not on this "
      + "register, which is the truth of it",
      useGone.status === 400 && /not on this register/i.test(
        useGone.json?.error?.message ?? ""),
      { s: useGone.status, m: clip(useGone.json?.error?.message) });
    const putOut = await call(`/control/canned-replies/${reuse.json.id}`, {
      ck: ck("sa"), method: "PUT", body: { title: "A fresh answer",
        bodyEn: "The customs form for {ref} will be sent today.", isActive: false }
    });
    const useIdle = await call(`/control/tickets/${b3.json.id}/answer`, {
      ck: ck("cs"), body: { replyId: reuse.json.id, reason: "Use the answer put out of use." }
    });
    check("…and an answer the office only put out of use is refused in different words: it is not "
      + "what we tell callers any more, so write the answer yourself",
      putOut.status === 200 && useIdle.status === 409 && /retired by the office/i.test(
        useIdle.json?.error?.message ?? ""),
      { s: useIdle.status, m: clip(useIdle.json?.error?.message) });
    const foldAnswer = await call(`/control/tickets/${dupA.json.id}/answer`, {
      ck: ck("cs"), body: { text: "Answer a line nobody holds.", reason: "Try to answer a fold." }
    });
    check("…nor on a folded line, whose caller is being answered on the keeper",
      foldAnswer.status === 409 && /is answered/i.test(foldAnswer.json?.error?.message ?? ""),
      { s: foldAnswer.status, m: clip(foldAnswer.json?.error?.message) });
    const picker = await call("/control/canned-replies", { ck: ck("cs") });
    check("the library read carries both texts, the last editor's own name and the token list, "
      + "so the desk writes an answer without guessing at either",
      picker.status === 200 && picker.json?.tokens?.length === 6
      && picker.json?.items?.some((r: any) => r.slug === `port_held_${STAMP}`
        && r.updated_by_name === "Ina Setter"),
      { s: picker.status, t: picker.json?.tokens?.length });
    const swFilter = await call("/control/canned-replies?language=sw", { ck: ck("cs") });
    check("…and it can be filtered to the answers that actually have a Kiswahili half, which is "
      + "the difference between two languages and one",
      swFilter.status === 200 && swFilter.json?.items?.every((r: any) => !!r.body_sw),
      { s: swFilter.status, n: swFilter.json?.items?.length });

    // ============================================================
    phase("the paper on an incidence");
    const filesOn = async (id: string) => (await call(`/control/tickets/${id}/files`,
      { ck: ck("sa") })).json;
    if (!storageConfigured()) {
      const list = await filesOn(keeper.json.id);
      const off = await upload(`/control/tickets/${keeper.json.id}/files`, "sa",
        { reason: "Storage is off here.", bytes: PNG });
      check("with no bucket configured the desk is told so, on the list and on the upload, "
        + "instead of failing at the first click",
        list?.storage_configured === false && off.status === 503,
        { sc: list?.storage_configured, s: off.status });
    } else {
      const shot = await upload(`/control/tickets/${keeper.json.id}/files`, "sa", {
        reason: "The caller texted the port's photograph of the container.",
        bytes: PNG, mime: "image/png", name: "port-photo.png"
      });
      check("a photograph lands beside the incidence it is about, with its real size and the "
        + "mime the bytes proved",
        shot.status === 201 && shot.json?.file_name === "port-photo.png"
        && shot.json?.mime_type === "image/png" && shot.json?.size_bytes === PNG.length,
        { s: shot.status, j: clip(shot.json) });
      const docRow = (await oi(`select d.kind, d.entity_type, d.storage_path, d.file_name
        from documents d where d.id = $1`, [shot.json?.id])).rows[0];
      check("…it is filed on the platform's own table under the new kind, not in a tenant's "
        + "vault", docRow?.entity_type === "support_ticket" && docRow?.kind === "attachment",
        docRow);
      if (docRow?.storage_path) stored.push(docRow.storage_path);
      const list = await filesOn(keeper.json.id);
      check("…and it is on the call's own list, named with who filed it",
        list?.items?.length === 1 && list.items[0].uploaded_by_name === "Ina Setter",
        list?.items);
      const detailFiles = await call(`/control/tickets/${keeper.json.id}`, { ck: ck("sa") });
      check("…the incidence read counts the same paper it shows, so a panel cannot say \"no "
        + "files\" beside a row that lists one",
        Number(detailFiles.json?.ticket?.files) === 1, detailFiles.json?.ticket?.files);
      const signed = await call(`/control/tickets/${keeper.json.id}/files/${shot.json.id}`,
        { ck: ck("sa") });
      const opened = await fetch(`${API}/control/tickets/${keeper.json.id}/files/${shot.json.id}/content`,
        { headers: { Cookie: `waisha_control=${ck("sa")}` } });
      const body = Buffer.from(await opened.arrayBuffer());
      check("the bytes come back through the desk that has the duty to read the call, with the "
        + "type it was stored as and nothing rendered as markup",
        signed.status === 200 && /^https?:\/\//.test(String(signed.json?.url))
        && opened.status === 200 && String(opened.headers.get("content-type")).includes("image/png")
        && opened.headers.get("x-content-type-options") === "nosniff"
        && String(opened.headers.get("content-disposition")).startsWith("inline")
        && body.length === PNG.length,
        { s: opened.status, ct: opened.headers.get("content-type"),
          cd: opened.headers.get("content-disposition"), n: body.length });
      const spoof = await upload(`/control/tickets/${keeper.json.id}/files`, "sa", {
        reason: "A renamed executable, or a PDF wearing a picture's name.",
        bytes: PDF, mime: "image/jpeg", name: "licence.jpg"
      });
      check("a file whose bytes are not the type it claims is refused — a control seat renaming "
        + "a document is not a reason to let it through",
        spoof.status === 400 && /real JPEG, PNG, WebP or PDF/i.test(
          spoof.json?.error?.message ?? ""), { s: spoof.status, m: clip(spoof.json?.error?.message) });
      const noReason = await upload(`/control/tickets/${keeper.json.id}/files`, "sa", {
        bytes: PNG, mime: "image/png", name: "why.png"
      });
      check("paper with no sentence about why it belongs on the call is not accepted, because "
        + "the file is evidence and evidence needs a reason",
        noReason.status === 400 && /why this paper belongs/i.test(
          noReason.json?.error?.message ?? ""), { s: noReason.status, m: clip(noReason.json) });
      const emptyFile = await upload(`/control/tickets/${keeper.json.id}/files`, "sa", {
        reason: "An empty upload.", bytes: Buffer.alloc(0), mime: "image/png", name: "empty.png"
      });
      check("…and an empty file is refused rather than stored as nothing",
        emptyFile.status === 400 && /empty/i.test(emptyFile.json?.error?.message ?? ""),
        { s: emptyFile.status, m: clip(emptyFile.json?.error?.message) });
      const realPdf = await upload(`/control/tickets/${keeper.json.id}/files`, "sa", {
        reason: "The port's own release note.", bytes: PDF, mime: "application/pdf",
        name: "release note.pdf"
      });
      check("a real PDF is accepted on its own merits, and its name reaches the desk with the "
        + "spaces it was given",
        realPdf.status === 201 && realPdf.json?.mime_type === "application/pdf",
        { s: realPdf.status, j: clip(realPdf.json) });
      const pdfPath = (await oi(`select storage_path as p from documents where id = $1`,
        [realPdf.json?.id])).rows[0]?.p;
      if (pdfPath) stored.push(pdfPath);
      const foldFile = await upload(`/control/tickets/${dupA.json.id}/files`, "sa", {
        reason: "Evidence onto a folded line.", bytes: PNG, mime: "image/png", name: "proof.png"
      });
      check("paper cannot be filed on a folded duplicate — evidence follows the call it answers, "
        + "and a file nobody will open is a file that is lost",
        foldFile.status === 409 && /is filed/i.test(foldFile.json?.error?.message ?? ""),
        { s: foldFile.status, m: clip(foldFile.json?.error?.message) });
      const taken = await call(`/control/tickets/${keeper.json.id}/files/${shot.json.id}/tombstone`, {
        ck: ck("sa"), body: { reason: "The port sent a better photograph; this one is off the "
          + "panel." }
      });
      check("taking the paper off retires the row and keeps the bytes, because a call answered "
        + "on the strength of a photograph keeps its record",
        taken.status === 200 && taken.json?.retired === true
        && (await oi(`select deleted_at is not null as g, storage_path as p from documents
                       where id = $1`, [shot.json.id])).rows[0]?.g === true,
        { s: taken.status, j: clip(taken.json) });
      const goneRow = (await oi(`select storage_path as p from documents where id = $1`,
        [shot.json.id])).rows[0];
      if (goneRow?.p && !stored.includes(goneRow.p)) stored.push(goneRow.p);
      check("…the list drops it and the incidence's own count drops with it, so the two numbers "
        + "the desk is shown cannot disagree",
        (await filesOn(keeper.json.id))?.items?.length === 1
        && Number((await call(`/control/tickets/${keeper.json.id}`,
          { ck: ck("sa") })).json?.ticket?.files) === 1);
      const openRetired = await call(`/control/tickets/${keeper.json.id}/files/${shot.json.id}`,
        { ck: ck("sa") });
      check("…and a retired file cannot be opened again by its old id",
        openRetired.status === 404, { s: openRetired.status });
      const crossTicket = await call(`/control/tickets/${b1.json.id}/files/${realPdf.json?.id}`,
        { ck: ck("sa") });
      check("a file is only ever opened on the incidence it was filed on — the same bytes under "
        + "another call are a 404, not a preview",
        crossTicket.status === 404, { s: crossTicket.status });
      const readerFile = await upload(`/control/tickets/${keeper.json.id}/files`, "an", {
        reason: "The reading seat tries to file paper.", bytes: PNG, mime: "image/png",
        name: "reader.png"
      });
      check("the seat that only reads may open the paper on a call but not put paper on it",
        readerFile.status === 403, { s: readerFile.status });
    }

    // ============================================================
    phase("the clock that ran out, and the head who was told");
    // The board is read from two desks this phase plants for itself. Every other line in the
    // register has been answered, folded, reopened or moved by the phases above, so a breach
    // counted on those would be a number about the run rather than about the clock — and a check
    // that cannot say which desk it expects cannot fail in a way anybody could act on.
    const D6 = randomUUID();          // Breach Desk — a head on the chart and two broken promises
    const D7 = randomUUID();          // Quiet Desk  — just as late, and nobody named to tell
    await desk(D6, `inx_breach_${STAMP}`, "Breach Desk", 60);
    await desk(D7, `inx_quiet_${STAMP}`, "Quiet Desk", 70);
    for (const id of [D6, D7]) {
      const t = await call(`/control/departments/${id}/terms`, {
        ck: ck("sa"), method: "PUT", body: { firstResponseMinutes: 30, resolveMinutes: 120,
          businessHours: WEEK, maxOpenTickets: 8,
          reason: "Half an hour to answer, two hours to finish — the promises a notice is about." }
      });
      if (t.status !== 200) throw new Error(`breach desk terms failed: ${t.text.slice(0, 240)}`);
    }
    await oi(`update platform_departments set head_user_id = $1 where id = $2`, [uCS, D6]);

    const lateAnswer = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D6,
        subject: `Nobody has rung this caller back ${MARK}`, reporterName: "Halima Juma" })
    });
    const lateFinish = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D6,
        subject: `Answered, and still not finished ${MARK}`, reporterName: "Peter Mbwana" })
    });
    const quietLine = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D7,
        subject: `A late call at a desk with no head ${MARK}`, reporterName: "Asha Nyerere" })
    });
    // The second line has had a human say something to its caller, so only its finish is past.
    // That is the difference the board has to show: a desk owes an answer on one call and a
    // completion on the other, and the desk head acts on them differently.
    const saidSomething = await call(`/control/tickets/${lateFinish.json.id}/answer`, {
      ck: ck("cs"), body: { text: "Rang the quay: the box is released on Tuesday.",
        reason: "So that only the finish is late on this one." }
    });
    if (saidSomething.status !== 200) {
      throw new Error(`breach fixture answer failed: ${saidSomething.text.slice(0, 240)}`);
    }
    const owedIds = [lateAnswer.json.id, lateFinish.json.id, quietLine.json.id];
    await oi(`update support_tickets set response_due_at = now() - interval '2 hours',
                     resolution_due_at = now() - interval '30 hours'
               where tenant_id = $1 and id = any($2::uuid[])`, [TC, owedIds]);

    const board = await call("/control/tickets/breaches", { ck: ck("sa") });
    const breachRow = (board.json?.board ?? []).find((r: any) => r.department_id === D6);
    const quietRow = (board.json?.board ?? []).find((r: any) => r.department_id === D7);
    check("the breach board is grouped by the desk that made the promise, because the desk is "
      + "who can act on a missed one — and it counts the two kinds of late apart",
      board.status === 200 && breachRow?.breached === 2
      && breachRow?.unanswered_over === 1 && breachRow?.unresolved_over === 2
      && breachRow?.department_name === "Breach Desk"
      && breachRow?.head_name === "Cally Service" && breachRow?.head_user_id === uCS,
      { s: board.status, r: breachRow });
    check("…a desk with calls to answer and nobody named to answer them is on the same board, "
      + "with its head left blank rather than the desk dropped from it",
      quietRow?.breached === 1 && quietRow?.head_user_id === null
      && quietRow?.head_name === null && quietRow?.department_name === "Quiet Desk",
      { r: quietRow });
    check("…the totals over the whole register are the same overdue test summed, so an "
      + "unallocated queue cannot read as nobody being late",
      Number(board.json?.overdue?.breached) === 3
      && Number(board.json?.overdue?.unanswered_over) === 2
      && Number(board.json?.overdue?.unresolved_over) === 3
      // The total is the board plus whatever no desk is holding: nothing may be late in the
      // aggregate and absent from every row of the board.
      && Number(board.json?.overdue?.breached)
        === (board.json?.board ?? []).reduce((s: number, r: any) => s + Number(r.breached), 0)
          + Number(board.json?.overdue?.unheld)
      && Number(board.json?.overdue?.unalerted) === Number(board.json?.overdue?.breached),
      { o: board.json?.overdue, sum: (board.json?.board ?? []).map((r: any) => r.breached) });
    check("…and the calls with no desk at all are counted and said as a wait, since nobody "
      + "promised anything about them",
      Number(board.json?.unheld?.n) >= 0
      && "oldest_since" in (board.json?.unheld ?? {})
      && "waiting_over_a_day" in (board.json?.unheld ?? {}), board.json?.unheld);
    const waitingIds = (board.json?.waiting ?? []).map((l: any) => l.id);
    check("the lines a notice would go out about are on the same read as the board, so the "
      + "button is never a surprise",
      waitingIds.length === 3 && owedIds.every((id: string) => waitingIds.includes(id))
      && Number(board.json?.waiting_total) === waitingIds.length
      && (board.json?.waiting ?? []).every((l: any) => l.breach_alerted_at === null),
      { w: waitingIds.length, t: board.json?.waiting_total });
    const scoped = await call(`/control/tickets/breaches?department=${D6}`, { ck: ck("sa") });
    check("the board can be narrowed to one desk, which is the shape a desk head is given: the "
      + "lines the notice would go out about are that desk's and nobody else's, while the totals "
      + "stay the platform's own so a desk cannot be read as the whole register",
      scoped.status === 200 && (scoped.json?.waiting ?? []).length === 2
      && (scoped.json?.waiting ?? []).every((l: any) => l.department_id === D6)
      && Number(scoped.json?.overdue?.breached) === 3
      && (scoped.json?.board ?? []).some((r: any) => r.department_id === D7),
      { s: scoped.status, n: scoped.json?.waiting?.length, o: scoped.json?.overdue });
    const boardAnalyst = await call("/control/tickets/breaches", { ck: ck("an") });
    check("a reading seat sees the board and is told it cannot tell anybody",
      boardAnalyst.status === 200 && boardAnalyst.json?.can_manage === false,
      { s: boardAnalyst.status, cm: boardAnalyst.json?.can_manage });

    // Two desks are late and they fail in different ways. One has a head on the chart and can be
    // told; the other has nobody named, which is the case a silent success would hide: a clerk
    // presses "tell the desks", sees a 200, and goes home while the caller waits for nobody.
    const owedD6 = [lateAnswer.json.id, lateFinish.json.id];
    const headless = await call("/control/tickets/breaches/notify", {
      ck: ck("sa"), body: { department: D7,
        reason: "Tell the desk with no head that its answer time has gone." }
    });
    const quietReceipt = (headless.json?.receipts ?? [])[0];
    check("a desk that is late and has no head on the chart gets a receipt that says so instead "
      + "of a silent success, and its line is not stamped",
      headless.status === 200 && headless.json?.desks === 1 && headless.json?.told === 0
      && !!quietReceipt && quietReceipt.delivered === false
      && quietReceipt.lines === 1 && quietReceipt.department_name === "Quiet Desk"
      && /no head on the chart/i.test(String(quietReceipt.error))
      && (await row(quietLine.json.id)).breach_alerted_at === null,
      { s: headless.status, r: clip(quietReceipt),
        a: (await row(quietLine.json.id)).breach_alerted_at });

    const told = await call("/control/tickets/breaches/notify", {
      ck: ck("sa"), body: { department: D6,
        reason: "Two answers are past the thirty minutes Breach Desk promised." }
    });
    const d6Receipt = (told.json?.receipts ?? []).find((r: any) => r.department_id === D6);
    check("the notice for a desk that has a head goes out through the platform's mail transport "
      + "and comes back with a receipt naming the head and the two lines it was shown",
      told.status === 200 && !!d6Receipt && d6Receipt.head === "Cally Service"
      && d6Receipt.department_name === "Breach Desk" && d6Receipt.lines === 2,
      { s: told.status, r: clip(d6Receipt) });
    const toldLines = await Promise.all(owedD6.map((id: string) => row(id)));
    const stampedBySend = toldLines.filter((r: any) => r?.breach_alerted_at !== null).length;
    check("…and the rule that keeps a breach from being quietly forgotten holds whichever way "
      + "this machine's transport answers: a send the provider took stamps exactly the lines it "
      + "named, a send it refused stamps none of them",
      (d6Receipt?.delivered === true && Number(d6Receipt?.stamped) === 2 && stampedBySend === 2
        && toldLines.every((r: any) => r?.breach_alerted_by === uSA))
      || (d6Receipt?.delivered === false && !!d6Receipt?.error && stampedBySend === 0
        && toldLines.every((r: any) => r?.breach_alerted_by === null)),
      { d: d6Receipt?.delivered, s: stampedBySend, e: clip(d6Receipt?.error, 160) });
    const deliveryLine = (await oi(
      `select channel, purpose, status, attempts, to_masked, error from message_deliveries
        where tenant_id = $1 and purpose = 'sla_breach' order by created_at desc limit 1`,
      [TC])).rows[0];
    check("…the send still leaves its line in the delivery register, filed under the breach "
      + "purpose rather than somebody else's, with its status agreeing with the receipt and the "
      + "address masked — the office must be able to prove what was told without holding it",
      deliveryLine?.purpose === "sla_breach" && deliveryLine?.channel === "email"
      && ["sent", "failed", "skipped"].includes(deliveryLine?.status)
      && (deliveryLine?.status === "sent") === (d6Receipt?.delivered === true)
      && /^[^@*]{1}\*{3}@/.test(String(deliveryLine?.to_masked))
      && !/cally/i.test(String(deliveryLine?.to_masked)),
      deliveryLine);
    const reRead = await call("/control/tickets/breaches", { ck: ck("sa") });
    const d6AfterSend = (reRead.json?.board ?? []).find((r: any) => r.department_id === D6);
    check("…the board's count of lines owed an alert is the register's own answer to the same "
      + "question, whether the transport took the message or refused it",
      reRead.status === 200 && Number(d6AfterSend?.breached) === 2
      && Number(d6AfterSend?.unalerted) === 2 - stampedBySend
      && (reRead.json?.waiting ?? []).filter((l: any) => owedD6.includes(l.id)).length
        === 2 - stampedBySend,
      { b: d6AfterSend, s: stampedBySend });

    // A send this machine's provider actually took cannot be produced here — no verified sending
    // domain — so the delivered half of the rule is proved on the register's side instead: both
    // alert columns written exactly as the route writes them once a receipt says delivered, then
    // the board read back.
    const stamped = await oi(`update support_tickets
       set breach_alerted_at = now(), breach_alerted_by = $2, updated_at = now()
      where tenant_id = $1 and deleted_at is null and id = any($3::uuid[])
        and status in ('open','allocated','in_progress')
      returning id`, [TC, uSA, owedD6]);
    check("the register holds an alert as one fact, not two columns that can disagree — both "
      + "written together, as the route does when a provider takes the message",
      stamped.rowCount === 2
      && (await oi(`select count(*)::int as n from support_tickets where tenant_id = $1
                      and ((breach_alerted_at is null) <> (breach_alerted_by is null))`,
        [TC])).rows[0].n === 0, { n: stamped.rowCount });
    const afterStamp = await call("/control/tickets/breaches", { ck: ck("sa") });
    const breachAfter = (afterStamp.json?.board ?? []).find((r: any) => r.department_id === D6);
    check("…a desk that has been told is still on the board as breached — the board is the "
      + "truth about the clock, not about the notice",
      breachAfter?.breached === 2 && Number(breachAfter?.unalerted) === 0
      && !!breachAfter?.last_alerted_at, breachAfter);
    check("…and its lines leave the list a notice would go out about, which is the twelve-hour "
      + "rule doing its job rather than a desk clicking twice",
      !(afterStamp.json?.waiting ?? []).some((l: any) => owedD6.includes(l.id))
      && (afterStamp.json?.waiting ?? []).some((l: any) => l.id === quietLine.json.id),
      (afterStamp.json?.waiting ?? []).map((l: any) => l.dept_ref ?? l.ref));
    await oi(`update support_tickets set breach_alerted_at = now() - interval '13 hours'
               where tenant_id = $1 and breach_alerted_by is not null`, [TC]);
    const later = await call("/control/tickets/breaches", { ck: ck("sa") });
    check("thirteen hours on, the same line is owed a notice again: a desk told yesterday is "
      + "told today, in the register's own arithmetic",
      (later.json?.waiting ?? []).filter((l: any) => owedD6.includes(l.id)).length === 2
      && Number((later.json?.board ?? []).find((r: any) => r.department_id === D6)?.unalerted) === 2,
      { w: (later.json?.waiting ?? []).length,
        u: (later.json?.board ?? []).find((r: any) => r.department_id === D6)?.unalerted });
    await oi(`update support_tickets set breach_alerted_at = null, breach_alerted_by = null
               where tenant_id = $1`, [TC]);
    const lateQueue = await call(`/control/tickets?clock=late&department=${D6}`, { ck: ck("sa") });
    check("the queue's own `late` filter is the same overdue test as the board, so a desk that "
      + "asks \"what is late\" gets the calls a notice would name — and only that desk's",
      lateQueue.status === 200 && lateQueue.json?.items?.length === 2
      && owedD6.every((id: string) => (lateQueue.json?.items ?? []).some((t: any) => t.id === id))
      && Number(lateQueue.json?.summary?.overdue) === lateQueue.json?.items?.length
      && (lateQueue.json?.items ?? []).every((t: any) => t.department_id === D6),
      { s: lateQueue.status, o: lateQueue.json?.summary?.overdue,
        n: lateQueue.json?.items?.length });

    // ============================================================
    phase("the register's own numbers, and the caller's number");
    const page1 = await call("/control/tickets?limit=5&days=365", { ck: ck("sa") });
    const page2 = await call("/control/tickets?limit=5&offset=5&days=365", { ck: ck("sa") });
    const ids1 = (page1.json?.items ?? []).map((t: any) => t.id);
    const ids2 = (page2.json?.items ?? []).map((t: any) => t.id);
    check("the queue pages: a second page is other rows, and the header's count is the whole "
      + "filter rather than the five it happens to be showing",
      ids1.length === 5 && ids2.length >= 1 && !ids2.some((id: string) => ids1.includes(id))
      && Number(page1.json?.summary?.n) === Number(page2.json?.summary?.n),
      { a: ids1.length, b: ids2.length, n1: page1.json?.summary?.n, n2: page2.json?.summary?.n });
    const tiles = (await call("/control/tickets?days=365", { ck: ck("sa") })).json?.summary;
    const ownerTiles = (await oi(
      `select count(*) filter (where status = 'merged')::int as folded,
              count(*) filter (where status in ('allocated','in_progress')
                               and reopen_count > 0)::int as reopened,
              count(*) filter (where dept_ref is null
                               and status in ('open','allocated','in_progress'))::int as unnumbered,
              count(*)::int as n
         from support_tickets where tenant_id = $1 and deleted_at is null
           and ts >= now() - interval '365 days'`, [TC])).rows[0];
    check("every tile the header shows is the register's own count of the same filter, so the "
      + "desk is never shown a number this page made up",
      tiles?.folded === ownerTiles.folded && tiles?.reopened === ownerTiles.reopened
      && tiles?.unnumbered === ownerTiles.unnumbered && tiles?.n === ownerTiles.n,
      { desk: tiles, register: ownerTiles });
    const deskLoad = (await call("/control/tickets?days=365", { ck: ck("sa") })).json?.departments;
    const squeezeLoad = (deskLoad ?? []).find((d: any) => d.id === D5);
    check("the desk board carries each desk's own ceiling and how far past it it is living, "
      + "which is the number a desk needs before it accepts a hand-over",
      squeezeLoad?.max_open_tickets === 1 && Number(squeezeLoad?.live_tickets) >= 1,
      squeezeLoad);
    const byPhone = await call(`/control/tickets?phone=${PHONE}&days=365`, { ck: ck("sa") });
    check("one caller's calls come back whichever source they arrived on, because the number is "
      + "hashed for search and not read for display",
      byPhone.status === 200 && byPhone.json?.items?.length >= 10
      && byPhone.json.items.every((t: any) => t.reporter_name !== undefined)
      && byPhone.json?.filters?.phone_searched === true,
      { s: byPhone.status, n: byPhone.json?.items?.length });
    const oneText = (await call(`/control/tickets?q=${encodeURIComponent(MARK)}&days=365`,
      { ck: ck("sa") })).text;
    const oneDetail = await call(`/control/tickets/${onChat.json.id}`, { ck: ck("sa") });
    check("the callback number is on no list row — only the flag that one is on file — while "
      + "the detail read decrypts it for the seat that has to ring back",
      !oneText.includes("reporter_phone_encrypted") && !oneText.includes(PHONE)
      && oneText.includes('"has_phone":true') && oneDetail.json?.ticket?.phone === PHONE,
      { phone: clip(oneDetail.json?.ticket?.phone) });
    const byPhone2 = await call(`/control/tickets?phone=${PHONE2}&days=365`, { ck: ck("sa") });
    check("…and a second number finds only its own calls, which is what makes the hash worth "
      + "storing",
      byPhone2.json?.items?.length >= 1
      && byPhone2.json.items.every((t: any) => t.reporter_name !== "Amina Juma"),
      { n: byPhone2.json?.items?.length });
    const shortSearch = await call("/control/tickets?phone=1234", { ck: ck("sa") });
    check("a number search too short to identify anybody is refused with the shape it wants",
      shortSearch.status === 400 && /eight digits/i.test(why(shortSearch)),
      { s: shortSearch.status, m: clip(why(shortSearch)) });

    // ============================================================
    phase("every act left its two lines");
    const tally = (await oi(
      `select (select count(*)::int from support_ticket_events where tenant_id = $1) as events,
              (select count(*)::int from audit_logs where tenant_id = $1
                 and entity = 'support_tickets' and after ? 'event_id') as twins,
              (select count(*)::int from audit_logs where tenant_id = $1
                 and entity = 'support_tickets' and after ? 'event_id'
                 and ip is not null and user_agent is not null) as complete,
              (select count(*)::int from support_ticket_events where tenant_id = $1
                 and action = any($2::text[])) as new_words,
              (select count(distinct action)::int as n from support_ticket_events
                 where tenant_id = $1) as distinct_actions
         from (select 1) s`,
      [TC, ["merged", "tagged", "untagged", "file_attached", "file_dropped", "reopened"]])).rows[0];
    check("one audit row per register line, each naming the incidence, the seat, the address and "
      + "the device, and the line it is the twin of",
      tally.events === tally.twins && tally.complete === tally.twins, tally);
    check("…the six words 125 had to add are all on this run's lines, so the register can say a "
      + "fold, a label and a file happened rather than only a status",
      tally.new_words >= 8 && Number(tally.distinct_actions) >= 10, tally);
    // Read the request's own roll-up row rather than counting audit lines: a bulk act writes one
    // row for the whole request and a twin for each line it moved, and the number that has to be
    // true is what that row says about how many moved and how many were refused.
    const bulkRoll = (await oi(
      `select before, after from audit_logs where tenant_id = $1
         and entity = 'support_tickets' and action = 'control.tickets.bulk_allocate'`,
      [TC])).rows;
    check("…and the bulk act that moved two lines wrote one roll-up audit row for the whole "
      + "request — six asked, two applied, four refused by their own numbers",
      bulkRoll.length === 1 && Number(bulkRoll[0]?.before?.asked) === 6
      && Number(bulkRoll[0]?.after?.applied) === 2
      && (bulkRoll[0]?.after?.refused ?? []).length === 4
      // Three of the four have a register number in the roll-up; the line that is not in the
      // register at all can only be named by its id.
      && (bulkRoll[0]?.after?.refused ?? []).filter((r: any) => !!r.ref).length === 3,
      bulkRoll.map((r) => ({ q: r.before?.asked, a: r.after?.applied,
        r: (r.after?.refused ?? []).length })) as any);
    const doubles = (await oi(
      `select dept_ref, count(*)::int as n from support_tickets where tenant_id = $1
         and dept_ref is not null group by 1 having count(*) > 1`, [TC])).rows;
    check("no two of this run's calls share a desk's queue number, however many folds and "
      + "reopens passed through", doubles.length === 0, doubles);
    check("the platform desk the real office sits on was not touched",
      (await before("support_tickets")) === start.tickets
      && (await before("platform_departments")) === start.desks
      && (await before("support_ticket_tags")) === start.tags
      && (await before("support_canned_replies")) === start.replies,
      { now: [await before("support_tickets"), await before("platform_departments"),
        await before("support_ticket_tags"), await before("support_canned_replies")], start });
  } catch (err: any) {
    // A phase that threw has to be as loud as a check that failed. Swallowed, a crash reads as
    // a short run that passed everything it managed to reach.
    failures++;
    console.log(`CRASHED — ${err?.message ?? err}`);
    console.log(String(err?.stack ?? "").split("\n").slice(1, 4).join("\n"));
  } finally {
    await sweep();
    await clearBuckets("tickets:", "tickets-one:", "tickets-write:", "tickets-bulk:",
      "tickets-breach:", "tickets-breach-notify:", "ticket-tags:", "ticket-tags-write:",
      "ticket-files:", "canned:", "canned-write:", "dept:", "dept-one:", "dept-write:",
      "dept-rules:", "dept-rules-write:");
    for (const p of stored) { try { await deleteObject(p); } catch { /* best effort */ } }
    const residue = await oi(
      `select (select count(*)::int from tenants where name like $1) as t,
              (select count(*)::int from users where email like $2) as u,
              (select count(*)::int from platform_departments where tenant_id in
                 (select id from tenants where name like $1)) as d,
              (select count(*)::int from support_ticket_routes where tenant_id in
                 (select id from tenants where name like $1)) as r,
              (select count(*)::int from support_tickets where tenant_id in
                 (select id from tenants where name like $1)) as k,
              (select count(*)::int from support_ticket_events where tenant_id in
                 (select id from tenants where name like $1)) as e,
              (select count(*)::int from support_ticket_tags where tenant_id in
                 (select id from tenants where name like $1)) as g,
              (select count(*)::int from support_ticket_taggings where tenant_id in
                 (select id from tenants where name like $1)) as gg,
              (select count(*)::int from support_canned_replies where tenant_id in
                 (select id from tenants where name like $1)) as c,
              (select count(*)::int from documents where tenant_id in
                 (select id from tenants where name like $1)) as f,
              (select count(*)::int from message_deliveries where tenant_id in
                 (select id from tenants where name like $1)) as m,
              (select coalesce(sum(ticket_seq), 0)::int as q from platform_departments where tenant_id in
                 (select id from tenants where name like $1))`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    check("this run's tenants, seats, desks, rules, calls, register lines, labels, taggings, "
      + "answers, paper and delivery lines are gone",
      residue.rows[0].t === 0 && residue.rows[0].u === 0 && residue.rows[0].d === 0
      && residue.rows[0].r === 0 && residue.rows[0].k === 0 && residue.rows[0].e === 0
      && residue.rows[0].g === 0 && residue.rows[0].gg === 0 && residue.rows[0].c === 0
      && residue.rows[0].f === 0 && residue.rows[0].m === 0, residue.rows[0]);
    check("…and no desk counter was left holding a number this run handed out",
      residue.rows[0].q === 0, residue.rows[0]);
    const kept = (await oi(
      `select count(*)::int as n from audit_logs where actor_user_id = any($1::uuid[])`,
      [[uSA, uAN, uCS, uFor]])).rows[0].n;
    check("…while every audit line it wrote is still there, because the trail is append-only and "
      + "a smoke that could erase its own evidence would prove nothing", kept > 0, { kept });
    console.log(`\n${failures ? `${failures} FAILURE(S)` : "all checks passed"} — ${MARK}`);
    await owner.end();
    process.exit(failures ? 1 : 0);
  }
}

/** Which labels a call is wearing, straight from the pairings table. */
async function row2tags(id: string): Promise<string[]> {
  const o = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await o.connect();
  const rows = (await o.query(
    `select tag_id from support_ticket_taggings where ticket_id = $1 and deleted_at is null`,
    [id])).rows;
  await o.end();
  return rows.map((r: any) => r.tag_id as string);
}

main().catch((e) => { console.error("CRASHED:", e?.response?.data ?? e); process.exit(1); });
