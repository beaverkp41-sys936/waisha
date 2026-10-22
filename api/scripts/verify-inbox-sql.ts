/**
 * Live proof for #340 — one inbox for every source (migration 125).
 *
 * Every promise this stage makes is a fact of the schema, so every one of them is proved here
 * rather than in a route: a channel list that accepts the two new sources and refuses a word
 * nobody speaks, a reopen that dies outside the window its desk set, a fold that cannot be
 * un-done, cannot point at a folded line, and drags its duplicates after it when its own keeper
 * moves, a tag that cannot name a retired or folded incidence, a canned reply that cannot carry
 * a placeholder the renderer does not know, and the two copies of the delivery purpose list
 * agreeing with each other. A CHECK cannot be demonstrated by reading it and EXPLAIN cannot see
 * inside a trigger body: the proof is the exception the trigger raises, and the row shape that
 * survives it.
 *
 * Everything runs inside one transaction that is rolled back, with a SAVEPOINT around each
 * refusal probe — a raised trigger aborts the transaction, and every later query in an aborted
 * transaction answers "current transaction is aborted" instead of the question it was asked.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-inbox-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label,
      (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400));
  }
}

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

const WEEK = {
  mon: { open: "08:00", close: "17:30" }, tue: { open: "08:00", close: "17:30" },
  wed: { open: "08:00", close: "17:30" }, thu: { open: "08:00", close: "17:30" },
  fri: { open: "08:00", close: "17:30" }, sat: { open: "09:00", close: "13:00" },
  sun: null
};
/** A real instant, sent as the ISO string the column can read. `now() - interval …` belongs in
 *  the SQL, never in a bind parameter: as text it is not a timestamp and the insert dies on
 *  input syntax instead of testing the rule it came to test. */
const ago = (days: number, hours = 0) =>
  new Date(Date.now() - (days * 86400 + hours * 3600) * 1000).toISOString();

const mkClient = () => new pg.Client({
  connectionString: ownerUrl(), ssl: { rejectUnauthorized: false }, statement_timeout: 60000
});

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = mkClient();
  await owner.connect();
  const one = async (sql: string, p: any[] = []) => (await owner.query(sql, p)).rows[0];

  // A gate that died halfway leaves probe rows behind, and every count below would then measure
  // the wreckage of the last run. Taggings, events and files first — they reference the
  // incidence — then folded children before their keepers, because merged_into_id is RESTRICT.
  await owner.query(`delete from support_ticket_taggings
                      where ticket_id in (select id from support_tickets
                                           where company_name = 'Probe Freight Ltd')`);
  await owner.query(`delete from support_ticket_events
                      where ticket_id in (select id from support_tickets
                                           where company_name = 'Probe Freight Ltd')`);
  await owner.query(`delete from documents
                      where entity_type = 'support_ticket' and entity_id in
                        (select id from support_tickets where company_name = 'Probe Freight Ltd')`);
  await owner.query(`delete from support_tickets where merged_into_id is not null
                      and (company_name = 'Probe Freight Ltd' or ref like 'CS-2099-%')`);
  await owner.query(`delete from support_tickets
                      where company_name = 'Probe Freight Ltd' or ref like 'CS-2099-%'`);
  await owner.query(`delete from support_ticket_tags where name like 'probe%'`);
  await owner.query(`delete from support_canned_replies where slug like 'probe%'`);
  await owner.query(`delete from support_ticket_routes where name like 'Probe%'`);
  await owner.query(`delete from platform_departments where key like 'zzprobe%'`);

  const anchor = await one(
    `select d.tenant_id,
            (select id from users u where u.user_type = 'platform' and u.deleted_at is null
               and u.status = 'active' order by u.created_at limit 1) as seat,
            (select id from tenants where id <> d.tenant_id and deleted_at is null
               order by id limit 1) as other
       from platform_departments d where d.deleted_at is null order by d.sort limit 1`);
  if (!anchor?.tenant_id) throw new Error("No platform tenant owns a department — 084 is missing.");
  if (!anchor?.seat) throw new Error("No live platform seat to write a probe incidence against.");
  const TEN = anchor.tenant_id as string;
  const ACT = anchor.seat as string;
  const OTHER = anchor.other as string | null;
  console.log(`\n--- 0 · the register: tenant ${TEN.slice(0, 8)}, seat ${ACT.slice(0, 8)}, `
    + `${OTHER ? "a second tenant to fold across" : "no second tenant"} ---`);

  await owner.query("begin");
  let spNo = 0;
  const fails = async (label: string, sql: string, p: any[] = [], want = "") => {
    const name = `s${++spNo}`;
    await owner.query(`savepoint ${name}`);
    let err: any = null;
    try { await owner.query(sql, p); } catch (e) { err = e; }
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) {
      check(`…because ${want}`, String(err.message).includes(want), err.message);
    }
    await owner.query(`rollback to savepoint ${name}`);
    return err;
  };
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    try { return (await owner.query(sql, p)).rows; }
    catch (e: any) { check(label, false, e.message); return null; }
  };

  const mkDesk = async (key: string, o: Partial<{
    reopen_days: number | null; first: number | null; resolve: number | null; hours: any;
  }> = {}) => (await okDo(`probe desk ${key}`,
    `insert into platform_departments (tenant_id, key, name, purpose, reopen_days,
        first_response_minutes, resolve_minutes, business_hours)
     values ($1,$2,$2,'Probe desk, read only by this script.',$3,$4,$5,$6) returning id`,
    [TEN, key, o.reopen_days ?? null, o.first ?? null, o.resolve ?? null,
      JSON.stringify(o.hours ?? WEEK)]))?.[0]?.id as string;

  let n = 90000;
  const mkTicket = async (o: Partial<{
    channel: string; status: string; dept: string | null; resolved_at: string | null;
    tenant: string; deleted: boolean; resolution: string;
  }> = {}, label = "probe incidence") => {
    n += 1;
    const rows = await okDo(`${label} (${o.channel ?? "phone_call"}/${o.status ?? "open"})`,
      `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
         subject, body, created_by, status, channel, department_id, resolved_at, resolved_by,
         resolution, deleted_at, deleted_by)
       values ($1,$2,'Probe Caller','Probe Freight Ltd','other','A probe subject about probing',
         'The body of a probe incidence written only to test the rules of 125.',$3,
         $4,$5,$6,$7,$3,$8,$9,$3)
       returning id`,
      [o.tenant ?? TEN, `CS-2099-${n}`, ACT, o.status ?? "open", o.channel ?? "phone_call",
        o.dept ?? null, o.resolved_at ?? null, o.resolution ?? null,
        o.deleted ? new Date().toISOString() : null]);
    return rows?.[0]?.id as string;
  };

  /** Fold a probe line into another and answer with the refusal, if there was one. The savepoint
   *  is not decoration: a raised trigger aborts the transaction, and a helper that only caught
   *  the error would report one real failure and then make every later query in the run answer
   *  "current transaction is aborted". */
  const fold = async (from: string, into: string): Promise<string | null> => {
    const name = `f${++spNo}`;
    await owner.query(`savepoint ${name}`);
    try {
      await owner.query(
        `update support_tickets set status = 'merged', merged_into_id = $2,
                merged_at = now(), merged_by = $3 where id = $1`, [from, into, ACT]);
      await owner.query(`release savepoint ${name}`);
      return null;
    } catch (e: any) {
      await owner.query(`rollback to savepoint ${name}`);
      return String(e.message ?? e).replace(/\s+/g, " ");
    }
  };

  // ================================================================
  console.log("\n--- 1 · every source is a channel the register and the rules both know ---");
  const d8 = await mkDesk("zzprobe_channels");
  check("a call that arrived through the web form is a channel the incidence accepts",
    !!(await mkTicket({ channel: "web_form", dept: d8 }, "web form")));
  check("…and so is a chat thread inside the portal",
    !!(await mkTicket({ channel: "chat", dept: d8 }, "chat")));
  check("…and both are readable back off the queue",
    Number((await one(`select count(*)::int as n from support_tickets
                       where company_name = 'Probe Freight Ltd'
                         and channel in ('chat','web_form')`)).n) === 2);
  await fails("a channel nobody speaks is refused by the table",
    `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category, subject,
       body, created_by, channel)
     values ($1,'CS-2099-99999','Probe Caller','Probe Freight Ltd','other','A probe subject',
       'The body of a probe incidence.',$2,'fax')`, [TEN, ACT],
    "support_tickets_channel_check");
  await okDo("a routing rule may list both new sources",
    `insert into support_ticket_routes (tenant_id, name, department_id, channels, languages)
     values ($1,'Probe web form desk',$2,array['chat','web_form'],array['sw'])`, [TEN, d8]);
  check("…and the matcher reads a web-form call and lands it there",
    (await one(`select (platform_auth.route_ticket($1,'web_form','other','low','sw',null)
                        ->>'rule_name') as rule`, [TEN])).rule === "Probe web form desk");
  await fails("…but a rule cannot list a source the register does not record",
    `insert into support_ticket_routes (tenant_id, name, department_id, channels)
     values ($1,'Probe impossible desk',$2,array['telegram'])`, [TEN, d8],
    "support_ticket_routes_channels_check");
  await owner.query(`delete from support_tickets where company_name = 'Probe Freight Ltd'`);

  // ================================================================
  console.log("\n--- 2 · the reopen window a desk set is the window the register keeps ---");
  const dWin = await mkDesk("zzprobe_window", { reopen_days: 3, first: 60, resolve: 240 });
  const dFree = await mkDesk("zzprobe_free");
  const old = await mkTicket({ status: "resolved", dept: dWin, resolved_at: ago(10),
    resolution: "The probe answer written down." }, "ten-day-old settled line");
  await fails("a line settled ten days ago cannot reopen where the desk allows three",
    `update support_tickets set status = 'in_progress', resolved_at = null, resolved_by = null
      where id = $1`, [old], "day(s) to reopen it");
  const fresh = await mkTicket({ status: "resolved", dept: dWin, resolved_at: ago(0, 2),
    resolution: "The probe answer written down." }, "two-hour-old settled line");
  await okDo("…two hours ago can, on the same desk with the same window",
    `update support_tickets set status = 'in_progress', resolved_at = null, resolved_by = null
      where id = $1`, [fresh]);
  const after = await one(
    `select reopen_count, last_reopened_at is not null as stamped,
            response_due_at is not null as answered, resolution_due_at is not null as fixed,
            response_due_at > now() as future,
            platform_auth.inside_hours(response_due_at,
              (select business_hours from platform_departments where id = $2)) as inside
       from support_tickets where id = $1`, [fresh, dWin]);
  check("…and the trigger wrote the count and the minute it happened",
    Number(after.reopen_count) === 1 && after.stamped, after);
  check("…and re-made the promise ahead of now, inside the desk's own open hours",
    after.answered && after.fixed && after.future && after.inside, after);
  const noClock = await mkTicket({ status: "resolved", dept: dFree, resolved_at: ago(10),
    resolution: "The probe answer written down." }, "line on a desk with no window");
  await okDo("a desk that never set a window reopens a ten-day-old line without refusing",
    `update support_tickets set status = 'allocated' where id = $1`, [noClock]);
  check("…and a desk with no SLA keeps “no clock” rather than being handed one here",
    (await one(`select response_due_at, resolution_due_at from support_tickets where id = $1`,
      [noClock])).response_due_at === null);
  const settled = await mkTicket({ status: "closed", dept: dWin, resolved_at: ago(2),
    resolution: "The probe answer written down." }, "closed line");
  await okDo("settling a closed line again is not a reopen and is not counted",
    `update support_tickets set status = 'resolved' where id = $1`, [settled]);
  check("…so it still shows zero reopens",
    Number((await one(`select reopen_count from support_tickets where id = $1`, [settled]))
      .reopen_count) === 0);
  await fails("and a desk cannot promise a window of zero days",
    `update platform_departments set reopen_days = 0 where id = $1`, [dWin],
    "platform_departments_reopen_days_check");

  // ================================================================
  console.log("\n--- 3 · a duplicate is folded, and the fold is the last word ---");
  const keeper = await mkTicket({ dept: dWin }, "keeper");
  const dup1 = await mkTicket({ dept: dWin }, "duplicate on the same desk");
  const dup2 = await mkTicket({}, "duplicate that never had a desk");
  const loadBefore = Number((await one(
    `select platform_auth.department_open_tickets($1) as n`, [dWin])).n);
  const foldDup1 = await fold(dup1, keeper);
  check("a duplicate folds into a live line", !foldDup1, foldDup1 ?? "");
  const loadAfter = Number((await one(
    `select platform_auth.department_open_tickets($1) as n`, [dWin])).n);
  check("…and the desk's load stopped counting it", loadAfter === loadBefore - 1,
    { loadBefore, loadAfter });
  const foldDup2 = await fold(dup2, keeper);
  check("…and an incidence that never had a desk folds just as well",
    !foldDup2, foldDup2 ?? "");
  const kept = await one(`select status, merged_into_id from support_tickets where id = $1`,
    [keeper]);
  check("…while the keeper stays exactly where it was",
    kept.status === "open" && kept.merged_into_id === null, kept);
  await fails("a folded line cannot be unfolded",
    `update support_tickets set merged_into_id = null where id = $1`, [dup1],
    "unfolding is not an act");
  await fails("a line cannot be folded into itself",
    `update support_tickets set status = 'merged', merged_into_id = $2, merged_at = now(),
            merged_by = $3 where id = $1`, [keeper, keeper, ACT], "into itself");
  await fails("…or into a line that is itself folded",
    `update support_tickets set status = 'merged', merged_into_id = $2, merged_at = now(),
            merged_by = $3 where id = $1`, [keeper, dup1, ACT], "itself folded");
  await fails("…or without saying who folded it",
    `update support_tickets set status = 'merged', merged_into_id = $2, merged_at = now()
      where id = $1`, [await mkTicket({ dept: dWin }, "unattributed fold"), keeper],
    "the seat that made it");
  await fails("…or by moving the pointer without the status",
    `update support_tickets set merged_into_id = $2 where id = $1`,
    [await mkTicket({ dept: dWin }, "pointer only"), keeper], "by becoming merged");
  const retired = await mkTicket({ dept: dWin, deleted: true }, "retired line");
  await fails("…or into a retired incidence",
    `update support_tickets set status = 'merged', merged_into_id = $2, merged_at = now(),
            merged_by = $3 where id = $1`,
    [await mkTicket({ dept: dWin }, "fold target retired"), retired, ACT], "retired incidence");
  await fails("…and a retired line cannot be folded either",
    `update support_tickets set status = 'merged', merged_into_id = $2, merged_at = now(),
            merged_by = $3 where id = $1`, [retired, keeper, ACT], "already retired");
  if (OTHER) {
    const foreign = await mkTicket({ tenant: OTHER }, "another tenant's line");
    await fails("…or across a tenant boundary",
      `update support_tickets set status = 'merged', merged_into_id = $2, merged_at = now(),
              merged_by = $3 where id = $1`, [keeper, foreign, ACT], "another organisation");
    await owner.query(`delete from support_tickets where id = $1`, [foreign]);
  }
  await fails("a folded line cannot be put back to work",
    `update support_tickets set status = 'in_progress' where id = $1`, [dup1],
    "support_tickets_fold_is_whole");

  // The keeper itself moves: the duplicates follow, because a caller quoting the keeper's number
  // has to land on the line that is still on the boards.
  const onward = await mkTicket({ dept: dWin }, "new keeper");
  const foldKeeper = await fold(keeper, onward);
  check("a keeper that has duplicates under it can itself be folded onward",
    !foldKeeper, foldKeeper ?? "");
  const followed = await owner.query(
    `select id, merged_into_id, status from support_tickets where id = any($1::uuid[])`,
    [[dup1, dup2]]);
  check("…and its duplicates follow it to the new keeper",
    followed.rows.length === 2
    && followed.rows.every((r) => r.merged_into_id === onward && r.status === "merged"),
    followed.rows);
  // The target has to be a line the duplicate is not already on: setting merged_into_id to the
  // value the cascade just wrote is not a move, and the guard's first test — is this a change at
  // all? — returns before it ever reaches the rule being proved.
  const rival = await mkTicket({ dept: dWin }, "a different live line");
  await fails("…but a duplicate cannot be moved to a keeper of its own choosing",
    `update support_tickets set merged_into_id = $2 where id = $1`, [dup1, rival],
    "only followed onward");

  // ================================================================
  console.log("\n--- 4 · a tag names a live incidence and a live tag ---");
  const tagId = (await okDo("a lowercase tag",
    `insert into support_ticket_tags (tenant_id, name, colour, note)
     values ($1,'probe port delay','#b45309','Probe tag.') returning id`, [TEN]))?.[0].id;
  await okDo("a tag is applied to an incidence that is on the boards",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, onward, tagId, ACT]);
  check("…and the queue can be read by it",
    Number((await one(`select count(*)::int as n from support_tickets t
                       join support_ticket_taggings g on g.ticket_id = t.id and g.deleted_at is null
                      where g.tag_id = $1 and t.deleted_at is null`, [tagId])).n) === 1);
  await fails("the same tag cannot sit twice on one incidence",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, onward, tagId, ACT], "support_ticket_taggings_live");
  await fails("two live tags cannot share one name",
    `insert into support_ticket_tags (tenant_id, name) values ($1,'probe port delay')`,
    [TEN], "support_ticket_tags_name_live");
  await fails("a tag written in capitals is not a tag this register holds",
    `insert into support_ticket_tags (tenant_id, name) values ($1,'Probe Port Delay')`,
    [TEN], "support_ticket_tags_name_check");
  await fails("…nor one in a colour nobody can render",
    `insert into support_ticket_tags (tenant_id, name, colour) values ($1,'probe colour','sienna')`,
    [TEN], "support_ticket_tags_colour_check");
  await fails("a folded line cannot be tagged",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, dup1, tagId, ACT], "tag the keeper");
  await fails("…nor can a retired one",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, retired, tagId, ACT], "retired and cannot be tagged");
  await fails("…nor can an incidence that is not on the register",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, randomUUID(), tagId, ACT], "no incidence");
  if (OTHER) {
    await fails("…nor with a tag from another tenant's shelf",
      `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
       values ($1,$2,$3,$4)`, [OTHER, onward, tagId, ACT], "cannot cross a tenant");
  }
  await okDo("taking a tag off is a tombstone, and the pair can then be applied again",
    `update support_ticket_taggings set deleted_at = now(), deleted_by = $2
      where ticket_id = $1 and tag_id = $3 and deleted_at is null`, [onward, ACT, tagId]);
  await okDo("…",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, onward, tagId, ACT]);
  const dead = (await okDo("a tag to retire",
    `insert into support_ticket_tags (tenant_id, name) values ($1,'probe retired') returning id`,
    [TEN]))?.[0].id;
  await owner.query(`update support_ticket_tags set deleted_at = now(), deleted_by = $2
                      where id = $1`, [dead, ACT]);
  await fails("a retired tag cannot be applied to anything",
    `insert into support_ticket_taggings (tenant_id, ticket_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, onward, dead, ACT], "tag is retired");
  check("…and the retired tag still holds the history of the one that was taken off",
    Number((await one(`select count(*)::int as n from support_ticket_taggings
                       where tag_id = $1`, [tagId])).n) === 2, tagId);

  // ================================================================
  console.log("\n--- 5 · a canned reply can only use the words the renderer fills ---");
  const seed = await owner.query(
    `select slug, body_en, body_sw from support_canned_replies
      where tenant_id = $1 and deleted_at is null order by slug`, [TEN]);
  check("the office starts with four answers, each written in both languages",
    seed.rowCount === 4 && seed.rows.every((r) => r.body_en && r.body_sw),
    seed.rows.map((r) => r.slug));
  await okDo("…and every seeded body passes the placeholder guard when it is touched",
    `update support_canned_replies set body_en = body_en where tenant_id = $1`, [TEN]);
  await okDo("a body using only the six known placeholders is a reply",
    `insert into support_canned_replies (tenant_id, slug, title, body_en, body_sw, category)
     values ($1,'probe_known','Probe known',
       'Hello {name}, {ref} for {company} is with {department}; {agent} asked about {subject}.',
       'Habari {name}, {ref} ya {company} iko kwa {department}.', 'other')`, [TEN]);
  await fails("a body inventing a placeholder the renderer does not know is refused",
    `insert into support_canned_replies (tenant_id, slug, title, body_en)
     values ($1,'probe_plate','Probe plate',
       'Hello {name}, the vehicle {plate} has arrived at the port.')`, [TEN],
    "placeholder this register does not know");
  await fails("…and so is a half-typed one",
    `insert into support_canned_replies (tenant_id, slug, title, body_en)
     values ($1,'probe_half','Probe half','Hello {name, the truck is late.')`, [TEN],
    "placeholder this register does not know");
  await fails("…and a Swahili-only token is the same refusal",
    `insert into support_canned_replies (tenant_id, slug, title, body_en, body_sw)
     values ($1,'probe_sw','Probe sw','Hello {name}, the truck is late.',
       'Habari {jina}, gari limechelewa.')`, [TEN], "placeholder this register does not know");
  await fails("a slug with capitals or spaces is not a slug",
    `insert into support_canned_replies (tenant_id, slug, title, body_en)
     values ($1,'Probe Known','Probe known','Hello {name}, the truck is late.')`, [TEN],
    "support_canned_replies_slug_check");
  await fails("a reply with nothing in it is not a reply",
    `insert into support_canned_replies (tenant_id, slug, title, body_en)
     values ($1,'probe_short','Probe short','abc')`, [TEN],
    "support_canned_replies_body_en_check");
  await fails("…and neither is one that answers about a category the register does not keep",
    `insert into support_canned_replies (tenant_id, slug, title, body_en, category)
     values ($1,'probe_cat','Probe cat','Hello {name}, the truck is late.','helicoptering')`,
    [TEN], "support_canned_replies_category_check");

  // ================================================================
  console.log("\n--- 6 · paper, and the notice that a clock ran out ---");
  const docPath = `${TEN}/support_ticket/${onward}/probe-note.png`;
  await okDo("a photograph may be filed on an incidence",
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
       size_bytes, storage_path, uploaded_by, created_by)
     values ($1,'support_ticket',$2,'attachment','probe-note.png','image/png',120,$3,$4,$4)`,
    [TEN, onward, docPath, ACT]);
  check("…and it reads back off the file table by that incidence",
    Number((await one(`select count(*)::int as n from documents
                       where entity_type = 'support_ticket' and entity_id = $1`,
      [onward])).n) === 1);
  await fails("…but not on an entity kind the vault has never heard of",
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
       size_bytes, storage_path, uploaded_by, created_by)
     values ($1,'starship',$2,'attachment','probe.png','image/png',120,$3,$4,$4)`,
    [TEN, onward, docPath, ACT], "documents_entity_type_check");
  await fails("an alert that names no seat is not an alert",
    `update support_tickets set breach_alerted_at = now() where id = $1`, [onward],
    "support_tickets_breach_alert_is_whole");
  await okDo("the seat and the minute together are",
    `update support_tickets set breach_alerted_at = now(), breach_alerted_by = $2
      where id = $1`, [onward, ACT]);
  await okDo("and telling the desk head is a word the event register holds",
    `insert into support_ticket_events (tenant_id, ticket_id, ref, actor_user_id, action, reason)
     values ($1,$2,'CS-2099-90001',$3,'alerted',
       'Probe: the desk head was told the clock ran out.')`, [TEN, onward, ACT]);
  await fails("…but an action the register has no word for is still refused",
    `insert into support_ticket_events (tenant_id, ticket_id, ref, actor_user_id, action, reason)
     values ($1,$2,'CS-2099-90001',$3,'teleported','Probe: an action nobody invented.')`,
    [TEN, onward, ACT], "support_ticket_events_action_check");
  // 123's twelve words are already proved by 123's own gate. What has to be proved here is that
  // one line can carry the fold, the tag and the alert in its history at the same time — a
  // register that refuses 'merged' makes the merge invisible in the story of the call, and a
  // count that is always >= 0 would never notice.
  await okDo("a fold and a tag are words the event register takes",
    `insert into support_ticket_events (tenant_id, ticket_id, ref, actor_user_id, action, reason)
     values ($1,$2,'CS-2099-90001',$3,'merged','Probe: the line was folded into its keeper.'),
            ($1,$2,'CS-2099-90001',$3,'tagged','Probe: the line was given its tag.')`,
    [TEN, onward, ACT]);
  const words = await one(
    `select count(distinct e.action) as n from support_ticket_events e
      where e.ticket_id = $1 and e.action in ('merged','tagged','alerted')`, [onward]);
  check("the event register keeps a live line's fold, tag and alert words side by side",
    Number(words.n) === 3, words);

  console.log("\n--- 7 · the two copies of the delivery purpose list ---");
  const purposes = await one(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'message_deliveries_purpose_check'`);
  const writer = await one(
    `select pg_get_functiondef(p.oid) as def from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'record_message_delivery'`);
  const inCheck = new Set((String(purposes?.def).match(/'([a-z_]+)'::text/g) || [])
    .map((s) => s.replace(/::text|'/g, "")));
  const body = String(writer?.def || "");
  const guardStart = body.indexOf("p_purpose not in (");
  const guardList = guardStart < 0 ? ""
    : body.slice(guardStart, body.indexOf("then return", guardStart));
  const inWriter = new Set((guardList.match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, "")));
  check("112's CHECK and 125's writer both know a breach notice is a purpose",
    inCheck.has("sla_breach") && inWriter.has("sla_breach"),
    { check: [...inCheck], writer: [...inWriter] });
  check("…and neither list has drifted from the other",
    inCheck.size > 0 && [...inCheck].sort().join() === [...inWriter].sort().join(),
    { check: [...inCheck].sort(), writer: [...inWriter].sort() });
  await okDo("…so a breach send can actually be recorded",
    `select platform_auth.record_message_delivery('email','sla_breach','clerk@example.co.tz',
       'Probe: a clock ran out','sent','resend','probe-id',null,1,$1,$2)`, [TEN, ACT]);
  check("…and it lands in the register under that purpose",
    Number((await one(`select count(*)::int as n from message_deliveries
                       where purpose = 'sla_breach' and to_masked = 'c***@example.co.tz'`)).n) === 1);
  // The writer is a collector: it swallows everything it does not recognise, so this cannot be
  // proved with `fails()`. It is proved by the call coming back and the register staying shut.
  const junk = await okDo("an unknown purpose is dropped by the writer, not raised at the caller",
    `select platform_auth.record_message_delivery('email','not_a_purpose','x@example.co.tz',
       null,'sent','resend',null,null,1,$1,$2)`, [TEN, ACT]);
  check("…silently: the call returned and no row appeared for it",
    !!junk && Number((await one(`select count(*)::int as n from message_deliveries
                                 where purpose = 'not_a_purpose'`)).n) === 0);

  console.log("\n--- 8 · the guards hold the doors they are fired through ---");
  const acl = await owner.query(
    `select p.proname, a.grantee::regrole::text as who, a.privilege_type
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join aclexplode(p.proacl) as a
      where n.nspname = 'platform_auth'
        and p.proname in ('reopen_stays_inside_its_window','merge_keeps_one_line_per_call',
                          'merge_follows_its_keeper','tagging_names_a_live_pair',
                          'canned_reply_tokens_are_known')`);
  check("no trigger body of 125 is callable by a seat at all",
    acl.rows.every((r) => r.who !== "PUBLIC" && r.who !== "app_runtime" && r.who !== "anon"),
    acl.rows);
  const writerAcl = await owner.query(
    `select a.grantee::regrole::text as who, a.privilege_type as what
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join aclexplode(p.proacl) as a
      where n.nspname = 'platform_auth' and p.proname = 'record_message_delivery'`);
  check("the writer the breach notice goes through is app_runtime's door, not PUBLIC's",
    writerAcl.rows.some((r) => r.who === "app_runtime" && r.what === "EXECUTE")
    && !writerAcl.rows.some((r) => r.who === "PUBLIC"), writerAcl.rows);
  const noDelete = await owner.query(
    `select relname, relacl::text as acl from pg_class
      where relname in ('support_ticket_tags','support_ticket_taggings','support_canned_replies',
                        'support_tickets','support_ticket_events')`);
  check("none of the inbox's registers can be DELETEd by the API role",
    noDelete.rows.every((r) => !/app_runtime=[^\]]*d/.test(r.acl)), noDelete.rows);

  await owner.query("rollback");
  await owner.end();

  // A second connection, because the point of the read-back is that the first one is gone: on a
  // recycled session the residue would be the other transaction's uncommitted work, not the
  // state the database was left in.
  const back = mkClient();
  await back.connect();
  const left = await (await back.query(`select
      (select count(*)::int from support_tickets where company_name = 'Probe Freight Ltd') as calls,
      (select count(*)::int from support_ticket_tags where name like 'probe%') as tags,
      (select count(*)::int from support_ticket_taggings) as taggings,
      (select count(*)::int from support_canned_replies where slug like 'probe%') as replies,
      (select count(*)::int from platform_departments where key like 'zzprobe%') as desks,
      (select count(*)::int from support_ticket_routes where name like 'Probe%') as rules,
      (select count(*)::int from documents where entity_type = 'support_ticket') as files,
      (select count(*)::int from message_deliveries where subject = 'Probe: a clock ran out') as notices`
  )).rows[0];
  check("the rollback left the register exactly as it found it",
    [left.calls, left.tags, left.taggings, left.replies, left.desks, left.rules, left.files,
      left.notices].every((v) => Number(v) === 0), left);
  await back.end();

  console.log(`\n${failures ? `${failures} FAILURE(S)` : "all 125 proofs hold"} — `
    + "one inbox for every source");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
