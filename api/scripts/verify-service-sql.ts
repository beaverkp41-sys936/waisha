/**
 * Live proof for #341 — the service registers (migration 126).
 *
 * Four registers and one money path. Every promise the Service desk makes is a fact of the
 * schema, so every one of them is proved here rather than in a route: a dispute that cannot be
 * upheld on an empty file, a claim that cannot be re-typed mid-flight, a settled figure that has
 * to be one sentence with its own refund paper, a CSAT that cannot be asked about a call nobody
 * has finished, a mark that is read out of exactly six answers and cannot contradict them, and a
 * refund that cannot be released by the hand that wrote it — the last one proved by spending a
 * real signature through 121's register with two seats and then trying to spend it with a third.
 * A CHECK cannot be demonstrated by reading it and EXPLAIN cannot see inside a trigger body: the
 * proof is the exception the trigger raises, and the row shape that survives it.
 *
 * The two board definers are read for their key names as well as their numbers. `service_board`
 * calls a waiting paper `awaiting_signature` and `service_refunds_board` calls it `awaiting`; the
 * desk has to read each one correctly, and a panel that guesses prints nought forever.
 *
 * Everything runs inside one transaction that is rolled back, with a SAVEPOINT around each
 * refusal probe — a raised trigger aborts the transaction, and every later query in an aborted
 * transaction answers "current transaction is aborted" instead of the question it was asked. The
 * three seats this run signs with are minted inside that same transaction, so they leave with it.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-service-sql.ts
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
const note = (line: string) => console.log("     ", line);

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}
const mkClient = () => new pg.Client({
  connectionString: ownerUrl(), ssl: { rejectUnauthorized: false }, statement_timeout: 120000
});

/** The six things the office says a good call does, in the order the desk prints them. */
const SIX = ["answered_the_caller", "identity_confirmed", "right_desk",
  "action_offered", "words_suitable", "settled_with_answer"];
/** Six answers of which the first `n` are ticked — as booleans, not as the string "true". */
const ticks = (n: number) =>
  JSON.stringify(Object.fromEntries(SIX.map((k, i) => [k, i < n])));

/** The sentence a second seat is asked to sign. Kept in one place: 126 gives it a floor of
 *  eight characters because "refund" is not a reason. */
const REASON = "Probe: the office has agreed the figure and a second seat must sign the pay out.";
const IP = "203.0.113.7";
const UA = "Probe gate";

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = mkClient();
  await owner.connect();
  const one = async (sql: string, p: any[] = []) => (await owner.query(sql, p)).rows[0];

  // A gate that died halfway leaves probe rows behind, and every count below would then measure
  // the wreckage of the last run. Children first: papers point at disputes and disputes point at
  // calls, and `service_disputes_refund_paper` is ON DELETE SET NULL rather than CASCADE.
  await owner.query(`delete from documents
                      where entity_type = 'service_dispute' and entity_id in
                        (select id from service_disputes where company_name = 'Probe Service Co')`);
  await owner.query(`delete from service_dispute_events
                      where dispute_id in (select id from service_disputes
                                            where company_name = 'Probe Service Co')`);
  await owner.query(`delete from service_refund_requests where company_name = 'Probe Service Co'`);
  await owner.query(`delete from service_disputes where company_name = 'Probe Service Co'`);
  await owner.query(`delete from service_quality_reviews where ticket_id in
                      (select id from support_tickets where ref like 'CS-2098-%')`);
  await owner.query(`delete from service_satisfaction where ticket_id in
                      (select id from support_tickets where ref like 'CS-2098-%')`);
  await owner.query(`delete from support_tickets where ref like 'CS-2098-%'`);
  await owner.query(`delete from users where email like 'probe-service-%@example.invalid'`);

  // Read after the cleanup above and before the transaction opens, so the closing check can tell
  // its own rows from somebody else's. The registers must be empty outright — 126 is new and a
  // live platform has never written to them. The audit log is the exception: it is append-only by
  // rule, every desk's runs leave lines in it on purpose, and there the only honest question is
  // whether this gate grew it.
  const LEDGER = `select
      (select count(*)::int from service_disputes) as disputes,
      (select count(*)::int from service_dispute_events) as events,
      (select count(*)::int from service_refund_requests) as papers,
      (select count(*)::int from service_satisfaction) as surveys,
      (select count(*)::int from service_quality_reviews) as marks,
      (select count(*)::int from documents where entity_type = 'service_dispute') as files,
      (select count(*)::int from support_tickets where ref like 'CS-2098-%') as calls,
      (select count(*)::int from platform_approvals where action = 'service.refund') as sigs,
      (select count(*)::int from users where email like 'probe-service%@example.invalid') as seats,
      (select count(*)::int from audit_logs where entity = 'service_refund_requests') as audits`;
  const found = await one(LEDGER);

  const anchor = await one(
    `select d.tenant_id, d.id as dept,
            (select id from users u where u.user_type = 'platform' and u.deleted_at is null
               and u.status = 'active' order by u.created_at limit 1) as seat,
            (select id from tenants where id <> d.tenant_id and deleted_at is null
               order by id limit 1) as other
       from platform_departments d where d.deleted_at is null order by d.sort limit 1`);
  if (!anchor?.tenant_id) throw new Error("No platform tenant owns a department — 084 is missing.");
  if (!anchor?.seat) throw new Error("No live platform seat to raise a probe dispute against.");
  const TEN = anchor.tenant_id as string;
  const DEPT = anchor.dept as string;
  const ACT = anchor.seat as string;
  const OTHER = anchor.other as string | null;
  console.log(`\n--- 0 · the register: tenant ${TEN.slice(0, 8)}, seat ${ACT.slice(0, 8)}, `
    + `${OTHER ? "a second tenant to write across" : "one tenant only"} ---`);

  await owner.query("begin");
  let spNo = 0;
  const fails = async (label: string, sql: string, p: any[] = [], want = "") => {
    const name = `s${++spNo}`;
    await owner.query(`savepoint ${name}`);
    let err: any = null;
    try { await owner.query(sql, p); } catch (e) { err = e; }
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) check(`…because ${want}`, String(err.message).includes(want), err.message);
    await owner.query(`rollback to savepoint ${name}`);
    return err;
  };
  /** Everything the gate *expects* to succeed runs inside its own savepoint. A positive
   *  statement that fails partway would otherwise abort the transaction, and every query after
   *  it would answer "current transaction is aborted" instead of its own question — one broken
   *  insert would then read as forty failures and hide the forty rules it came to prove. */
  const guarded = async (sql: string, p: any[] = []) => {
    const name = `g${++spNo}`;
    await owner.query(`savepoint ${name}`);
    try {
      const rows = (await owner.query(sql, p)).rows;
      await owner.query(`release savepoint ${name}`);
      return { rows, err: null as any };
    } catch (err: any) {
      await owner.query(`rollback to savepoint ${name}`);
      return { rows: null as any, err };
    }
  };
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    const { rows, err } = await guarded(sql, p);
    if (err) check(label, false, err.message);
    return rows;
  };
  /** A definer's refusal is a value it returns, not an exception — so the answer is read rather
   *  than caught, and a `conflict` there is a pass, not a failure of the run. */
  const door = async (sql: string, p: any[] = []) => {
    const { rows, err } = await guarded(sql, p);
    if (err) check(`the door refused outright: ${String(err.message).slice(0, 160)}`, false);
    return err ? null : ((rows[0]?.r ?? rows[0]?.b ?? null) as Record<string, any> | null);
  };

  // Three seats, minted inside the rolled-back transaction. `approval_seat` (121) wants a live
  // platform seat, and the two-person rule wants two of them that are not the same person.
  const mkSeat = async (who: string, type = "platform") => (await okDo(`probe seat ${who}`,
    `insert into users (tenant_id, user_type, email, full_name, status)
     values ($1,$2,$3,$4,'active') returning id`,
    [TEN, type, `probe-service-${who.toLowerCase().replace(/ /g, '-')}@example.invalid`, who]
  ))?.[0]?.id as string;
  const SECOND = await mkSeat("Second Seat");
  const THIRD = await mkSeat("Third Seat");
  const OUTSIDER = await mkSeat("Company Clerk", "staff");
  console.log(`\n--- 0b · seats to sign with: the live ${String(ACT).slice(0, 8)}, plus `
    + `${String(SECOND).slice(0, 8)}, ${String(THIRD).slice(0, 8)} and a company clerk`);

  let n = 98000;
  const mkTicket = async (o: Partial<{ status: string }> = {}, label = "probe call") => {
    n += 1;
    const status = o.status ?? "open";
    const settled = status === "resolved" || status === "closed";
    const rows = await okDo(`${label} (${status})`,
      `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category, subject,
         body, created_by, status, channel, department_id, resolved_at, resolved_by, resolution)
       values ($1,$2,'Probe Caller','Probe Service Co','complaint',
         'A probe call about a probe promise',
         'The body of a probe call written only to test the rules of 126.',$3,
         $4,'phone_call',$5,$6,$3,$7)
       returning id, ref`,
      [TEN, `CS-2098-${n}`, ACT, status, DEPT,
        settled ? new Date().toISOString() : null,
        settled ? "The probe answer written down." : null]);
    return rows?.[0] as { id: string; ref: string } | undefined;
  };

  const mkDispute = async (o: Partial<{
    ticket: string; ground: string; claim: string; amount: number | null; currency: string | null;
  }> = {}, label = "probe dispute") => (await okDo(label,
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_tenant_id,
        company_name, ground, claim, amount, currency, status, opened_by)
     values ($1,'DP-2098-' || lpad(nextval('service_dispute_number_seq')::text, 5, '0'),
        $2,'',$3,'Probe Service Co',$4,$5,$6::numeric,$7,'open',$8)
     returning id, ref, ticket_ref, amount, currency, status`,
    [TEN, o.ticket, OTHER, o.ground ?? "missed_promise",
      o.claim ?? "The desk promised a callback on Monday and never rang the caller once.",
      o.amount ?? null, o.currency ?? null, ACT]))?.[0] as Record<string, any> | undefined;

  const mkPaper = async (o: Partial<{
    ticket: string; dispute: string | null; amount: number; currency: string; reason: string;
  }> = {}, label = "probe refund paper") => (await okDo(label,
    `insert into service_refund_requests (tenant_id, ref, ticket_id, ticket_ref, dispute_id,
        company_tenant_id, company_name, amount, currency, pay_back, reason, status, raised_by)
     values ($1,'RF-2098-' || lpad(nextval('service_refund_number_seq')::text, 5, '0'),
        $2,'',$3,$4,'Probe Service Co',$5::numeric,$6,'mpesa',$7,'raised',$8)
     returning id, ref, ticket_ref, amount, currency, status, approval_id`,
    [TEN, o.ticket, o.dispute ?? null, OTHER, o.amount ?? 400000, o.currency ?? "TZS",
      o.reason ?? "The office agrees the charge was raised twice for one clearance.", ACT]
  ))?.[0] as Record<string, any> | undefined;

  const mkReview = async (o: Partial<{
    ticket: string; seat: string; by: string; checks: string; result: string; note: string | null;
  }> = {}, label = "probe mark") => (await okDo(label,
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result, note)
     values ($1,$2,'',$3,$4,$5::jsonb,$6,$7)
     returning id, ticket_ref, score, result, checks`,
    [TEN, o.ticket, o.seat ?? ACT, o.by ?? SECOND, o.checks ?? ticks(6), o.result ?? "met",
      o.note === undefined
        ? ((o.result && o.result !== "met")
          ? "The caller was left waiting for a second desk before anyone asked for the number."
          : null)
        : o.note]))?.[0] as Record<string, any> | undefined;

  // The storage path is built in JavaScript: the same bind parameter cannot be both the uuid the
  // tenant column wants and a piece of text in a concatenation, and Postgres refuses to deduce it.
  const filePaper = async (dispute: string, name = "probe-quotation.png") =>
    (await okDo("evidence filed on the dispute",
      `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
         size_bytes, storage_path, uploaded_by, created_by)
       values ($1,'service_dispute',$2,'attachment',$3,'image/png',120,$4,$5,$5)
       returning id`, [TEN, dispute, name, `${TEN}/service_dispute/${dispute}/${name}`, ACT]
    ))?.[0]?.id as string;

  // ================================================================
  console.log("\n--- 1 · the four registers are live, and the six answers are named once ---");
  const tables = await owner.query(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind = 'r'
        and c.relname in ('service_disputes','service_dispute_events','service_refund_requests',
                          'service_satisfaction','service_quality_reviews')`);
  check("all four registers and the dispute's event line are on the live database",
    tables.rowCount === 5, tables.rows.map((r) => r.relname));
  check("…each one has row-level security on and a policy that binds its own tenant",
    tables.rows.length === 5 && tables.rows.every((r) => r.relrowsecurity && Number(r.policies) >= 1),
    tables.rows);
  const sixConstraint = await one(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'service_quality_reviews_checks_are_the_six'`);
  // Read the key list out of the `?&` array only: the same constraint also names the jsonb
  // type it expects, and `object` is not one of the six answers.
  const sixArray = String(sixConstraint?.def || "").split("?&")[1] ?? "";
  const sixWords = (sixArray.match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ""));
  const sixLive = [...new Set(sixWords)].sort();
  check("the live key list is exactly the six checks the desk prints, and nothing has drifted",
    sixLive.join("|") === [...SIX].sort().join("|"), { live: sixLive, expected: [...SIX].sort() });
  const entityTypes = await one(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'documents_entity_type_check'`);
  check("126 opened the vault to a dispute's evidence without closing 125's incidence files",
    /'service_dispute'/.test(String(entityTypes?.def))
    && /'support_ticket'/.test(String(entityTypes?.def)), entityTypes?.def);
  await fails("a file still cannot be attached to an entity kind the vault has never heard of",
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
       size_bytes, storage_path, uploaded_by, created_by)
     values ($1,'starship',$2,'attachment','probe.png','image/png',120,$3,$4,$4)`,
    [TEN, ACT, `${TEN}/starship/$2/probe.png`, ACT], "documents_entity_type_check");

  // ================================================================
  console.log("\n--- 2 · a dispute names the call it stands on, and never types that number ---");
  const call1 = await mkTicket({}, "a call still on the boards");
  const d1 = await mkDispute({ ticket: call1!.id });
  check("a dispute opens against a live call", !!d1?.id, d1);
  check("…the incidence number was copied out of the call, not typed on the screen",
    d1?.ticket_ref === call1?.ref, { typed: "", stored: d1?.ticket_ref, call: call1?.ref });
  check("…and the dispute minted its own number from its own sequence, the way the phone quotes it",
    /^DP-\d{4}-\d{5,}$/.test(String(d1?.ref)), d1?.ref);
  await fails("a dispute cannot be opened about a call that is not on the register",
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name, ground,
        claim, opened_by)
     values ($1,'DP-2098-99999',$2,'CS-0000-00000','Probe Service Co','other',
       'A claim long enough to be read.',$3)`, [TEN, randomUUID(), ACT],
    "is not a call on the register");
  await fails("the ground is one of the eight words the office keeps",
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name, ground,
        claim, opened_by)
     values ($1,'DP-2098-99998',$2,'CS-0000-00000','Probe Service Co','teleported',
       'A claim long enough to be read.',$3)`, [TEN, call1!.id, ACT],
    "service_disputes_ground_check");
  await fails("a claim of six characters belongs in the ground, not in the register",
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name, ground,
        claim, opened_by)
     values ($1,'DP-2098-99997',$2,'CS-0000-00000','Probe Service Co','other',
       'shorty',$3)`, [TEN, call1!.id, ACT], "service_disputes_claim_check");
  await fails("a figure with no currency cannot be totalled beside one that has",
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name, ground,
        claim, amount, currency, opened_by)
     values ($1,'DP-2098-99996',$2,'CS-0000-00000','Probe Service Co','overcharge',
       'A claim long enough to be read.',400000,null,$3)`, [TEN, call1!.id, ACT],
    "violates check constraint");
  await fails("…and a currency with no figure is the same half-sentence",
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name, ground,
        claim, amount, currency, opened_by)
     values ($1,'DP-2098-99995',$2,'CS-0000-00000','Probe Service Co','overcharge',
       'A claim long enough to be read.',null,'TZS',$3)`, [TEN, call1!.id, ACT],
    "violates check constraint");
  await fails("a dispute number written by a hand is refused by the shape of it",
    `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name, ground,
        claim, opened_by)
     values ($1,'DISPUTE-1',$2,'CS-0000-00000','Probe Service Co','other',
       'A claim long enough to be read.',$3)`, [TEN, call1!.id, ACT],
    "service_disputes_ref_check");
  await fails("a dispute cannot claim to be rejected with no finding beside it",
    `update service_disputes set status = 'rejected' where id = $1`, [d1!.id],
    "violates check constraint");
  await okDo("…the finding, the seat and the minute together are a decision",
    `update service_disputes set status = 'rejected', outcome =
        'The desk did ring back; the caller had moved to a different number.',
        decided_by = $2, decided_at = now() where id = $1`, [d1!.id, ACT]);
  const wroteBack = await one(
    `select status, (outcome is not null) as wrote, (decided_by = $2) as signed
       from service_disputes where id = $1`, [d1!.id, ACT]);
  check("…and the finding reads back off the register, signed",
    wroteBack.status === "rejected" && wroteBack.wrote && wroteBack.signed, wroteBack);
  await fails("a finding already signed is not rewritten underneath the caller",
    `update service_disputes set outcome =
       'A second thought about the same call, typed a week later.' where id = $1`,
    [d1!.id], "a finding is not rewritten");
  await fails("…nor is the seat that signed it",
    `update service_disputes set decided_by = $2 where id = $1`, [d1!.id, SECOND],
    "was decided on");
  const d2 = await mkDispute({ ticket: call1!.id, amount: 400000, currency: "TZS" },
    "a dispute with a figure on it");
  await fails("a claim is the caller's words: re-typing it mid-flight is a different argument",
    `update service_disputes set amount = 40000 where id = $1`, [d2!.id],
    "a claim is not re-typed");

  console.log("\n--- 3 · the office concedes nothing on an empty file ---");
  await fails("a dispute cannot be upheld with nothing on it",
    `update service_disputes set status = 'upheld', outcome =
        'The office agrees the charge was raised twice.', decided_by = $2, decided_at = now()
       where id = $1`, [d2!.id, ACT], "with nothing on it - file the paper");
  const evidence = await filePaper(d2!.id);
  check("a photograph on the dispute is the paper a finding stands on", !!evidence, evidence);
  await fails("…but an upheld figure still cannot stand without a refund paper",
    `update service_disputes set status = 'upheld', outcome =
        'The office agrees the charge was raised twice.', decided_by = $2, decided_at = now()
       where id = $1`, [d2!.id, ACT], "violates check constraint");
  await okDo("paper may be taken off a dispute",
    `update documents set deleted_at = now() where id = $1`, [evidence]);
  // Upheld, not settled: `service_disputes_settled_figure` sorts before `…_upheld_on_paper` and
  // owns a `settled` row with a figure on it, so a settle here would be answered by the wrong
  // rule. The finding this probe is about stands on paper, and that is the rule being tested.
  await fails("…and retired paper no longer upholds a finding",
    `update service_disputes set status = 'upheld', outcome =
        'Upheld on a note that was then taken off the file.', decided_by = $2, decided_at = now()
       where id = $1`, [d2!.id, ACT], "with nothing on it - file the paper");
  await filePaper(d2!.id, "probe-weighing-note.png");
  const paper2 = await mkPaper({ ticket: call1!.id, dispute: d2!.id, amount: 4000 },
    "a paper for a different figure than the claim");
  const mismatch = await fails("a settled figure has to be one sentence with its own paper",
    `update service_disputes set status = 'settled', refund_request_id = $2, outcome =
        'The office agrees and will pay.', decided_by = $3, decided_at = now() where id = $1`,
    [d2!.id, paper2!.id, ACT], "the two figures have to be one sentence");
  check("…the refusal names both numbers, so the desk knows which one of them to fix",
    /claims 400000\.00 TZS and its refund paper says 4000\.00 TZS/
      .test(String(mismatch?.message || "")), String(mismatch?.message || "").slice(0, 200));
  const d3 = await mkDispute({ ticket: call1!.id, amount: 400000, currency: "TZS" },
    "a dispute at the figure its paper will carry");
  await filePaper(d3!.id, "probe-claim-note.png");
  await fails("a settled dispute cannot be settled on no paper at all",
    `update service_disputes set status = 'settled', outcome =
        'The office agrees and will pay.', decided_by = $2, decided_at = now() where id = $1`,
    [d3!.id, ACT], "there is no refund paper to settle it on");
  const paper3 = await mkPaper({ ticket: call1!.id, dispute: d3!.id, amount: 400000 },
    "the paper that matches the claim");
  await okDo("the claim, the paper and the finding agree — so the desk may close the argument",
    `update service_disputes set status = 'settled', refund_request_id = $2, outcome =
        'The office agrees: one charge of 400,000 TZS goes back to the caller on mpesa.',
        decided_by = $3, decided_at = now() where id = $1`, [d3!.id, paper3!.id, ACT]);
  check("…and the settled line reads back with its paper attached",
    (await one(`select (refund_request_id = $2) as linked from service_disputes where id = $1`,
      [d3!.id, paper3!.id])).linked);
  await fails("a settled line stays settled: the way back in is a new dispute",
    `update service_disputes set status = 'open' where id = $1`, [d3!.id],
    "stays that way - the way back in is a new line");

  console.log("\n--- 4 · everything done to a dispute is on the record, and the record is shut ---");
  await okDo("the act of filing paper is an event the register keeps",
    `insert into service_dispute_events (tenant_id, dispute_id, ref, actor_user_id, actor_role,
        ip, action, reason)
     values ($1,$2,$3,$4,'super_admin',$5,'paper_filed',
       'The quotation the caller sent on WhatsApp.')`, [TEN, d3!.id, d3!.ref, ACT, IP]);
  await okDo("…and so is the decision, with the status it moved from and to",
    `insert into service_dispute_events (tenant_id, dispute_id, ref, actor_user_id, action,
        reason, from_label, to_label, detail)
     values ($1,$2,$3,$4,'decided','Two figures, one sentence, on a file.',
       'investigating','settled','{"amount": 400000}'::jsonb)`, [TEN, d3!.id, d3!.ref, ACT]);
  const story = await one(
    `select count(*)::int as n from service_dispute_events where dispute_id = $1`, [d3!.id]);
  check("the line carries both acts, in order", Number(story.n) === 2, story);
  await fails("an action the register has no word for is refused",
    `insert into service_dispute_events (tenant_id, dispute_id, ref, actor_user_id, action, reason)
     values ($1,$2,$3,$4,'teleported','Probe: an action nobody invented.')`,
    [TEN, d3!.id, d3!.ref, ACT], "service_dispute_events_action_check");
  await fails("…and a reason of three characters is not a reason",
    `insert into service_dispute_events (tenant_id, dispute_id, ref, actor_user_id, action, reason)
     values ($1,$2,$3,$4,'note','abc')`, [TEN, d3!.id, d3!.ref, ACT],
    "service_dispute_events_reason_check");
  await fails("…nor an event that names no dispute",
    `insert into service_dispute_events (tenant_id, dispute_id, ref, actor_user_id, action, reason)
     values ($1,$2,$3,$4,'note','A sentence long enough to stand on its own.')`,
    [TEN, randomUUID(), "DP-2098-00000", ACT], "foreign key");
  // The append-only guard is 043's `prevent_job_mutation()`, which answers `coalesce(new, old)` —
  // silently, no refusal — whenever `current_user` holds rolsuper or rolbypassrls. This gate's
  // login owns the tables and holds BYPASSRLS, so a bare UPDATE here goes through from this
  // connection and cannot be made to raise. The rule is not being waived, it lives one level
  // down: `app_runtime`, the role every RLS policy on this platform was written for, is refused
  // the edit and the strike-off by its grants. Both halves are measured, neither is pretended.
  const appendOnly = await one(
    `select t.tgname, t.tgenabled = 'O' as armed, p.proname as guard,
            (t.tgtype::int & 1) = 1 as per_row, (t.tgtype::int & 2) = 2 as before_it,
            (t.tgtype::int & 16) = 16 as on_update, (t.tgtype::int & 8) = 8 as on_delete
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
       join pg_proc p on p.oid = t.tgfoid
      where c.relname = 'service_dispute_events' and not t.tgisinternal
        and t.tgname = 'service_dispute_events_no_mutation'`);
  check("the event register carries 043's append-only guard, armed before each row on "
    + "update and on delete",
    !!appendOnly?.armed && appendOnly?.guard === "prevent_job_mutation"
    && appendOnly?.per_row && appendOnly?.before_it
    && appendOnly?.on_update && appendOnly?.on_delete, appendOnly);
  const runtimeMay = await one(
    `select has_table_privilege('app_runtime', 'service_dispute_events', 'UPDATE') as edit,
            has_table_privilege('app_runtime', 'service_dispute_events', 'DELETE') as strike`);
  check("…and the role a route runs as holds neither the edit nor the strike-off",
    !runtimeMay?.edit && !runtimeMay?.strike, runtimeMay);
  note("…this connection is the tables' owner, where 043's guard answers without raising, so the "
    + "refusal is proved against the runtime grants rather than by catching an exception here.");

  // ================================================================
  console.log("\n--- 5 · satisfaction is asked after the desk has finished the call ---");
  const live2 = await mkTicket({}, "a call still in progress");
  await fails("a survey cannot be asked about a call that is still open",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by)
     values ($1,$2,'',$3)`, [TEN, live2!.id, ACT],
    "satisfaction is asked after the desk has settled the call");
  const done1 = await mkTicket({ status: "resolved" }, "a settled call");
  const sat = (await okDo("…and once the desk has settled it, the question may be asked",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by, asked_channel)
     values ($1,$2,'',$3,'whatsapp') returning id, ticket_ref, tenant_id, asked_channel`,
    [OTHER ?? TEN, done1!.id, ACT]))?.[0] as Record<string, any>;
  check("…the survey copied the incidence number and the register off the call itself, so a desk "
    + "pointed at the wrong tenant cannot write one",
    sat?.ticket_ref === done1?.ref && sat?.tenant_id === TEN,
    { typed_tenant: OTHER ?? TEN, stored_tenant: sat?.tenant_id, ref: sat?.ticket_ref });
  await fails("one call is asked once — a second survey would average the same call twice",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by)
     values ($1,$2,'',$3)`, [TEN, done1!.id, ACT], "service_satisfaction_ticket_id_key");
  await fails("a survey cannot be about a call that is not on the book",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by)
     values ($1,$2,'',$3)`, [TEN, randomUUID(), ACT], "is not a call on the register");
  await fails("a mark with no minute is a row somebody edited",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by, score)
     values ($1,$2,'',$3,5)`,
    [TEN, (await mkTicket({ status: "closed" }, "a closed call"))!.id, ACT],
    "violates check constraint");
  await fails("…and a minute with no mark says a caller was asked and gave nothing",
    `update service_satisfaction set answered_at = now() where id = $1`, [sat.id],
    "violates check constraint");
  await fails("a word from a caller who never answered is not a word",
    `update service_satisfaction set word = 'They finally picked up.' where id = $1`, [sat.id],
    "violates check constraint");
  await fails("…nor is a promise to recommend one",
    `update service_satisfaction set recommends = true where id = $1`, [sat.id],
    "violates check constraint");
  await fails("a score of six is not on the five the office asks with",
    `update service_satisfaction set score = 6, answered_at = now() where id = $1`, [sat.id],
    "service_satisfaction_score_check");
  await okDo("an answer written now is a whole answer",
    `update service_satisfaction set answered_at = now(), score = 4, recommends = true
      where id = $1`, [sat.id]);
  await fails("…but an answer cannot arrive before the question was asked",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by, asked_at,
        answered_at, score)
     values ($1,$2,'',$3, now(), now() - interval '1 hour', 4)`, [TEN, done1!.id, ACT],
    "violates check constraint");
  const done2 = await mkTicket({ status: "closed" }, "a second closed call");
  await okDo("the whole right-hand half, taken together, is an unhappy caller's answer",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by, asked_at,
        answered_at, score, word, recommends)
     values ($1,$2,'',$3, now() - interval '20 minutes', now(), 2,
       'Nobody told me the gate was closed on Saturday.', false)`, [TEN, done2!.id, ACT]);
  await fails("a channel the office does not use is not a channel it asked over",
    `insert into service_satisfaction (tenant_id, ticket_id, ticket_ref, asked_by, asked_channel)
     values ($1,$2,'',$3,'telegram')`,
    [TEN, (await mkTicket({ status: "resolved" }, "a third closed call"))!.id, ACT],
    "service_satisfaction_asked_channel_check");

  // ================================================================
  console.log("\n--- 6 · a mark is read out of six answers and cannot contradict them ---");
  const calls = [] as string[];
  for (let i = 0; i < 7; i++) {
    const c = await mkTicket({ status: i % 2 ? "closed" : "resolved" }, `a call to grade ${i}`);
    if (c?.id) calls.push(c.id);
  }
  const six = await mkReview({ ticket: calls[0], checks: ticks(6) });
  check("six ticks are a hundred", Number(six?.score) === 100, six);
  const five = await mkReview({ ticket: calls[1], checks: ticks(5), result: "met" });
  check("five ticks are 83 — the mark is computed, never typed beside it",
    Number(five?.score) === 83, five);
  const typed = await okDo("a reviewer who types 100 under five ticks is over-ruled by the ticks",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result, score)
     values ($1,$2,'',$3,$4,$5::jsonb,'met',100) returning score, result`,
    [TEN, calls[2], ACT, SECOND, ticks(5)]);
  check("…silently: the register keeps the mark the answers add up to, not the number typed",
    Number(typed?.[0]?.score) === 83, typed?.[0]);
  const four = await mkReview({ ticket: calls[6], checks: ticks(4), result: "partly_met",
    note: "The caller had to explain the cargo twice before the desk asked for the number." });
  check("four ticks are partly_met, at 67", Number(four?.score) === 67, four);
  await fails("met needs five of the six, and says what it saw",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result, note)
     values ($1,$2,'',$3,$4,$5::jsonb,'met','Four of six but called it met anyway.')`,
    [TEN, calls[3], ACT, SECOND, ticks(4)], "met needs five of the six");
  await fails("partly_met is three or four",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result, note)
     values ($1,$2,'',$3,$4,$5::jsonb,'partly_met','Two ticks, generously worded.')`,
    [TEN, calls[3], ACT, SECOND, ticks(2)], "partly_met is three or four of the six");
  await fails("below is two or fewer",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result, note)
     values ($1,$2,'',$3,$4,$5::jsonb,'below','Four ticks called below.')`,
    [TEN, calls[3], ACT, SECOND, ticks(4)], "below is two or fewer");
  const two = await mkReview({ ticket: calls[3], checks: ticks(2), result: "below",
    note: "The line was dropped and the caller rang back twice to be told again." });
  check("two ticks are below, at 33", Number(two?.score) === 33, two);
  await fails("a review that omits one of the six is refused by the word it omitted",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result)
     values ($1,$2,'',$3,$4,'{"answered_the_caller":true,"identity_confirmed":true,
       "right_desk":true,"action_offered":true,"words_suitable":true}'::jsonb,'met')`,
    [TEN, calls[4], ACT, SECOND], "a review answers all six checks - missing settled_with_answer");
  await fails("…and a seventh answer the office never agreed is refused by its own name",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result)
     values ($1,$2,'',$3,$4,'{"answered_the_caller":true,"identity_confirmed":true,
       "right_desk":true,"action_offered":true,"words_suitable":true,
       "settled_with_answer":true,"everything_else_fine":true}'::jsonb,'met')`,
    [TEN, calls[4], ACT, SECOND], "is not one of them");
  await fails("the six answers are an object of booleans, not a list",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result, note)
     values ($1,$2,'',$3,$4,'["answered_the_caller"]'::jsonb,'below','A list, not the six.')`,
    [TEN, calls[4], ACT, SECOND], "must be an object of booleans");
  await fails("a mark made by the seat it grades is not a mark",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result)
     values ($1,$2,'',$3,$3,$4::jsonb,'met')`, [TEN, calls[5], ACT, ticks(6)],
    "violates check constraint");
  await fails("one reviewer grades one call once — a second attempt is not a new number",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result)
     values ($1,$2,'',$3,$4,$5::jsonb,'met')`, [TEN, calls[0], ACT, SECOND, ticks(6)],
    "service_quality_reviews_one_per_pair");
  await okDo("…a second reviewer may grade the same call, because the pair is the point",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result)
     values ($1,$2,'',$3,$4,$5::jsonb,'met')`, [TEN, calls[0], ACT, THIRD, ticks(6)]);
  await fails("a word below `met` has to be a sentence the seat can argue with",
    `insert into service_quality_reviews (tenant_id, ticket_id, ticket_ref, reviewed_seat,
        reviewed_by, checks, result)
     values ($1,$2,'',$3,$4,$5::jsonb,'below')`, [TEN, calls[4], ACT, SECOND, ticks(1)],
    "violates check constraint");
  const strings = await mkReview({ ticket: calls[4],
    checks: JSON.stringify(Object.fromEntries(SIX.map((k) => [k, "true"]))), result: "below",
    note: "Every answer was the word true, not a tick." });
  check("…and answers typed as text score nought rather than being quietly read as ticks",
    Number(strings?.score) === 0, strings);
  const grade = await mkReview({ ticket: calls[5], checks: ticks(3), result: "partly_met",
    note: "The desk handed the caller to a second line twice before anyone wrote it down." });
  await fails("ticks cannot be inflated under a word that has already been published",
    `update service_quality_reviews set checks = $2::jsonb where id = $1`, [grade!.id, ticks(6)],
    "partly_met is three or four of the six");
  await okDo("the graded seat answers once, in its own words, on the row that carries the mark",
    `update service_quality_reviews set agent_response =
        'The gate closed at four and I did not tell the caller.', responded_at = now()
       where id = $1`, [grade!.id]);
  await fails("…and a second attempt at the same answer is refused",
    `update service_quality_reviews set agent_response =
       'Reworded later, after the office saw it.' where id = $1`, [grade!.id],
    "a seat answers a mark once");
  await fails("…so the ticks and the word are frozen from the minute the seat spoke",
    `update service_quality_reviews set checks = $2::jsonb, result = 'met' where id = $1`,
    [grade!.id, ticks(6)], "a grade is not rewritten under an appeal");
  await fails("withdrawing needs both the seat and the minute, as every signature does",
    `update service_quality_reviews set withdrawn_at = now() where id = $1`, [two!.id],
    "violates check constraint");
  await okDo("…and together they take the mark off the board",
    `update service_quality_reviews set withdrawn_at = now(), withdrawn_by = $2 where id = $1`,
    [two!.id, SECOND]);
  await fails("…a withdrawn mark stays withdrawn: a second look is a second review",
    `update service_quality_reviews set withdrawn_at = null, withdrawn_by = null where id = $1`,
    [two!.id], "a withdrawn review stays withdrawn");

  // ================================================================
  console.log("\n--- 7 · a refund paper cannot be released by the hand that wrote it ---");
  const call4 = await mkTicket({ status: "resolved" }, "the call the money came from");
  const p1 = await mkPaper({ ticket: call4!.id, amount: 400000 }, "the first paper");
  check("a paper opens `raised` with its own number and the call copied beside it",
    p1?.status === "raised" && /^RF-\d{4}-\d{5,}$/.test(String(p1?.ref))
    && p1?.ticket_ref === call4?.ref, p1);
  await fails("a paper cannot wait on a signature nobody asked for",
    `update service_refund_requests set status = 'pending_signature' where id = $1`, [p1!.id],
    "violates check constraint");
  const noSeat = await fails("…or claim to be released with no seat and no minute",
    `update service_refund_requests set status = 'released' where id = $1`, [p1!.id],
    "cannot be released without a second seat's signature");
  const born = await fails("…nor be born already released, whoever writes the next handler",
    `insert into service_refund_requests (tenant_id, ref, ticket_id, ticket_ref, company_name,
        amount, currency, pay_back, reason, status, raised_by, released_by, released_at,
        approval_id)
     values ($1,'RF-2098-99999',$2,'CS-0000-00000','Probe Service Co',400000,'TZS','mpesa',
       'A paper born already paid.','released',$3,$3,now(),$4)`,
    [TEN, call4!.id, ACT, randomUUID()], "without a second seat's signature");
  // Both refusals come from 126's own guard, and they arrive before the released_by/released_at
  // pairing CHECK or the approval_id foreign key can be reached — a BEFORE trigger on the same
  // table answers first. That is the order the rule wants: a handler that forgets to write the
  // name is refused for the graver reason, the missing signature, not for the missing column.
  check("…the refusal is the two-seat rule, not a pairing CHECK or a foreign key",
    /cannot be released without a second seat/.test(String(born?.message ?? noSeat?.message ?? "")),
    String(born?.message ?? noSeat?.message ?? ""));
  await fails("a figure of nought is how a register ends up with a paid line nobody was owed",
    `insert into service_refund_requests (tenant_id, ref, ticket_id, ticket_ref, company_name,
        amount, currency, pay_back, reason, raised_by)
     values ($1,'RF-2098-99998',$2,'CS-0000-00000','Probe Service Co',0,'TZS','mpesa',
       'A free refund.',$3)`, [TEN, call4!.id, ACT],
    "service_refund_requests_amount_check");
  await fails("a declined paper needs the seat, the minute and the sentence the caller is given",
    `insert into service_refund_requests (tenant_id, ref, ticket_id, ticket_ref, company_name,
        amount, currency, pay_back, reason, status, raised_by, declined_by, declined_at)
     values ($1,'RF-2098-99997',$2,'CS-0000-00000','Probe Service Co',400000,'TZS','mpesa',
       'A declined paper with no note.','declined',$3,$3,now())`, [TEN, call4!.id, ACT],
    "violates check constraint");
  await fails("…and a void paper needs its reason written on the row",
    `update service_refund_requests set status = 'void' where id = $1`, [p1!.id],
    "violates check constraint");

  const ask = (paper: string, actor: string, reason = REASON) =>
    door(`select platform_auth.propose_refund_release($1,$2,$3,'super_admin',$4,$5) as r`,
      [paper, reason, actor, IP, UA]);

  const prop1 = await ask(p1!.id, ACT);
  check("asking for a signature is the door that writes it, and the paper moves itself",
    prop1?.status === "ok" && prop1?.action === "service.refund"
    && String(prop1?.target_id) === p1!.id, prop1);
  const ap1 = prop1?.approval_id as string;
  const waiting = await one(`select status, approval_id, released_by, released_at
      from service_refund_requests where id = $1`, [p1!.id]);
  check("…the paper now waits on that signature, with nobody's release written on it",
    waiting.status === "pending_signature" && waiting.approval_id === ap1
    && waiting.released_by === null && waiting.released_at === null, waiting);
  check("…the bytes the second seat is asked to sign are the paper's own figure, read out of the row",
    Number(prop1?.amount) === 400000 && prop1?.currency === "TZS"
    && String(prop1?.ref) === p1?.ref, { amount: prop1?.amount, currency: prop1?.currency });
  check("…and hashed, so a signature is over fixed bytes",
    /^[0-9a-f]{64}$/.test(String(prop1?.payload_sha256)), prop1?.payload_sha256);
  await fails("while it waits, the figure the second seat is reading cannot move",
    `update service_refund_requests set amount = 4000 where id = $1`, [p1!.id],
    "the figure the second seat signed cannot move under it");
  const tooEarly = await door(
    `select platform_auth.apply_refund_release($1,$2,'super_admin',$3) as r`, [ap1, SECOND, IP]);
  check("a signature that has not been released cannot be spent yet",
    tooEarly?.status === "conflict", tooEarly);
  const self = await door(`select platform_auth.decide_approval($1,'approve',
      'I asked for it and I will sign it.',$2,'super_admin',$3,$4) as r`, [ap1, ACT, IP, UA]);
  check("the seat that asked for a signature cannot give it", self?.status === "self", self);
  const decided = await door(`select platform_auth.decide_approval($1,'approve',
      'Checked against the quotation and the tariff.',$2,'compliance_officer',$3,$4) as r`,
    [ap1, SECOND, "203.0.113.8", UA]);
  check("…a different seat's yes is taken", decided?.status === "ok", decided);
  const claim = await door(`select platform_auth.claim_approval($1,$2) as r`, [ap1, SECOND]);
  check("claiming is what turns a released signature into one that can be spent",
    claim?.status === "ok" && String(claim?.target_id) === p1!.id, claim);
  const applied = await door(
    `select platform_auth.apply_refund_release($1,$2,'compliance_officer',$3) as r`,
    [ap1, SECOND, "203.0.113.8"]);
  check("the release goes through — because, and only because, two seats signed it",
    applied?.status === "ok" && applied?.request_status === "released", applied);
  await door(`select platform_auth.settle_approval($1,$2::jsonb) as r`,
    [ap1, JSON.stringify({ ref: p1?.ref, request_status: "released" })]);
  const released = await one(`select status, released_by, (released_at is not null) as stamped,
        (amount = 400000::numeric) as figure
      from service_refund_requests where id = $1`, [p1!.id]);
  check("…the paper reads back released, by the second seat, never by the one who asked",
    released.status === "released" && String(released.released_by) === SECOND
    && released.stamped && released.figure, released);
  check("…and the audit line the definer wrote names both seats, the figure and the hash",
    Number((await one(`select count(*)::int as n from audit_logs
                       where entity = 'service_refund_requests' and entity_id = $1
                         and action = 'refund.released'
                         and after->>'released_by' = $2
                         and after->>'raised_by' = $3
                         and (after->>'payload_sha256') ~ '^[0-9a-f]{64}$'`,
      [p1!.id, SECOND, ACT])).n) === 1);
  await fails("a released paper is not edited afterwards",
    `update service_refund_requests set pay_back = 'bank' where id = $1`, [p1!.id],
    "is already released - the paper is not edited");
  await fails("…it cannot be un-released",
    `update service_refund_requests set status = 'raised', released_by = null,
            released_at = null where id = $1`, [p1!.id], "can only be voided with a reason");
  const reSpend = await door(
    `select platform_auth.apply_refund_release($1,$2,'compliance_officer',$3) as r`,
    [ap1, SECOND, "203.0.113.8"]);
  check("…and the spent signature buys nothing a second time",
    reSpend?.status === "conflict", reSpend);

  const p2 = await mkPaper({ ticket: call4!.id, amount: 90000 }, "a second paper");
  await fails("a spent signature cannot be walked around the office to a second paper",
    `update service_refund_requests set status = 'pending_signature', approval_id = $2
      where id = $1`, [p2!.id, ap1], "service_refunds_one_open");
  const prop2 = await ask(p2!.id, ACT);
  const ap2 = prop2?.approval_id as string;
  await door(`select platform_auth.decide_approval($1,'approve','Read it and agreed.',$2,
      'compliance_officer',$3,$4) as r`, [ap2, SECOND, "203.0.113.8", UA]);
  await door(`select platform_auth.claim_approval($1,$2) as r`, [ap2, SECOND]);
  const notYours = await door(
    `select platform_auth.apply_refund_release($1,$2,'super_admin',$3) as r`, [ap2, THIRD, IP]);
  check("a signature is not a token to be handed around the office",
    notYours?.status === "unauthorised", notYours);

  const banLike = (await okDo("a signature of another act, standing approved",
    `insert into platform_approvals (action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, decided_by, decided_role,
        decided_at, decided_note, decided_ip, expires_at)
     values ('tenant.block','tenant',$1,'{}'::jsonb,$2,
        'A ban a second seat signed, kept here only to be refused as money.',
        'approved',$3,'super_admin','203.0.113.7',$4,'compliance_officer',
        now(),'Signed and spent.','203.0.113.8', now() + interval '7 days')
     returning id`, [OTHER ?? TEN, "0".repeat(64), ACT, SECOND]))?.[0].id as string;
  const p5 = await mkPaper({ ticket: call4!.id, amount: 25000 }, "a paper somebody tried to pay with a ban");
  await fails("a signature on a company's ban cannot release a refund paper",
    `update service_refund_requests set status = 'released', approval_id = $2, released_by = $3,
            released_at = now() where id = $1`, [p5!.id, banLike, SECOND],
    "without a second seat's signature");
  const wrongKind = await door(
    `select platform_auth.apply_refund_release($1,$2,'compliance_officer',$3) as r`,
    [banLike, SECOND, "203.0.113.8"]);
  check("…and the door itself says the signature is not a refund paper, before it spends it",
    wrongKind?.status === "invalid", wrongKind);

  const p3 = await mkPaper({ ticket: call4!.id, amount: 12000 }, "a paper the office means to refuse");
  const prop3 = await ask(p3!.id, ACT);
  const twice = await ask(p3!.id, ACT);
  check("one paper holds one open signature: asking twice answers conflict, and names the first",
    twice?.status === "conflict" && String(twice?.open_id) === String(prop3?.approval_id), twice);
  await door(`select platform_auth.decline_refund($1,
      'The quotation shows one charge, not two. Send the bill again if that is wrong.',$2,
      'compliance_officer',$3,$4) as r`, [p3!.id, SECOND, "203.0.113.8", UA]);
  const refused = await one(`select r.status, r.declined_by, a.status as approval
      from service_refund_requests r left join platform_approvals a on a.id = r.approval_id
     where r.id = $1`, [p3!.id]);
  check("refusing a paper answers its open signature too — one call, both registers",
    refused.status === "declined" && String(refused.declined_by) === SECOND
    && refused.approval === "rejected", refused);
  const again = await door(`select platform_auth.decline_refund($1,
      'Trying the same no a second time.',$2,'compliance_officer',$3,$4) as r`,
    [p3!.id, THIRD, "203.0.113.8", UA]);
  check("…and a finished paper cannot be refused again", again?.status === "conflict", again);
  await fails("…the register keeps a declined paper where it is",
    `update service_refund_requests set status = 'raised' where id = $1`, [p3!.id],
    "is declined and stays declined");
  // Saying no to money is not the act the two-person rule names, so a paper that never asked can
  // still be refused — but only with a sentence the caller can be given.
  const p6 = await mkPaper({ ticket: call4!.id, amount: 7000 }, "a paper refused before it asked");
  const shortNo = await door(`select platform_auth.decline_refund($1,'no',$2,'compliance_officer',
      $3,$4) as r`, [p6!.id, THIRD, IP, UA]);
  check("a refusal needs the sentence the caller is given", shortNo?.status === "invalid", shortNo);
  const saidNo = await door(`select platform_auth.decline_refund($1,
      'The tariff already covers the waiting time; nothing is owed.',$2,'compliance_officer',$3,$4) as r`,
    [p6!.id, THIRD, IP, UA]);
  check("…and a paper with no signature on it at all is answered by the desk that read it",
    saidNo?.status === "ok"
    && (await one(`select status from service_refund_requests where id = $1`, [p6!.id])).status
      === "declined", saidNo);

  const p4 = await mkPaper({ ticket: call4!.id, amount: 15000 }, "a paper signed 'no' and re-asked");
  const prop4 = await ask(p4!.id, ACT);
  await door(`select platform_auth.decide_approval($1,'reject','Not on these figures.',$2,
      'compliance_officer',$3,$4) as r`, [prop4?.approval_id as string, SECOND, "203.0.113.8", UA]);
  const reasked = await ask(p4!.id, ACT);
  check("a paper whose signature was refused can be asked again — otherwise it waits forever on a "
    + "dead signature", reasked?.status === "ok"
    && String(reasked?.approval_id) !== String(prop4?.approval_id), reasked);
  check("…and the paper now points at the new signature, not the dead one",
    (await one(`select (approval_id = $2) as fresh from service_refund_requests where id = $1`,
      [p4!.id, reasked?.approval_id])).fresh);
  // Seven characters, so this proves the floor itself rather than the one-open-signature rule
  // further down the same door — the reason is checked before the paper is even read.
  const short = await ask(p4!.id, ACT, "paid it");
  check("the reason is the sentence the second seat signs, so it has a floor of its own",
    short?.status === "invalid", short);
  const outsider = await door(
    `select platform_auth.propose_refund_release($1,$2,$3,'staff',$4,$5) as r`,
    [p4!.id, REASON, OUTSIDER, IP, UA]);
  check("only a live platform seat may ask — a company cannot put its own refund to the board",
    outsider?.status === "invalid", outsider);
  await okDo("a released paper that was never actually paid is voided, with the reason on the row",
    `update service_refund_requests set status = 'void', void_note =
       'Released on a signature, but the mobile-money reference never came back.' where id = $1`,
    [p1!.id]);
  await fails("…and a void paper is finished",
    `update service_refund_requests set status = 'released' where id = $1`, [p1!.id],
    "is void and stays void");

  // ================================================================
  console.log("\n--- 8 · the two boards, and the names the desk has to read ---");
  const board = (await one(`select platform_auth.service_board($1) as b`, [TEN])).b;
  const WANT: Record<string, string[]> = {
    disputes: ["open", "investigating", "upheld", "rejected", "settled", "withdrawn",
      "awaiting_paper", "claimed_tzs", "claimed_usd"],
    satisfaction: ["asked", "answered", "mean", "happy", "unhappy", "would_recommend",
      "open_words"],
    quality: ["reviews", "met", "partly_met", "below", "answered", "mean"],
    refunds: ["raised", "awaiting_signature", "released", "declined", "void", "waiting_tzs",
      "waiting_usd"]
  };
  for (const key of ["disputes", "satisfaction", "quality", "refunds"]) {
    const got = Object.keys(board?.[key] ?? {}).sort();
    check(`service_board().${key} carries exactly the keys the panel reads`,
      got.join("|") === [...WANT[key]].sort().join("|"), { got, want: WANT[key] });
  }
  check("…and every figure on the page is measured against one clock", !!board?.clock, board?.clock);
  const liveCounts = await one(
    `select (select count(*)::int from service_disputes where tenant_id = $1
              and deleted_at is null and status = 'settled') as settled,
            (select count(*)::int from service_refund_requests where tenant_id = $1
              and status = 'pending_signature') as waiting,
            (select count(*)::int from service_quality_reviews where tenant_id = $1
              and withdrawn_at is null) as marks,
            (select count(*)::int from service_satisfaction where tenant_id = $1
              and score is not null) as answers`, [TEN]);
  check("…and the numbers on it are the rows in the tables, not a page of them",
    Number(board?.disputes?.settled) === liveCounts.settled
    && Number(board?.satisfaction?.answered) === liveCounts.answers
    && Number(board?.quality?.reviews) === liveCounts.marks, { board, liveCounts });
  const refundBoard = (await one(
    `select platform_auth.service_refunds_board($1,null,null,100,0) as b`, [TEN])).b;
  const countKeys = Object.keys(refundBoard?.counts ?? {}).sort();
  check("service_refunds_board().counts names a waiting paper `awaiting` — a different word to "
    + "service_board's `awaiting_signature`, so one object cannot be read by both panels",
    countKeys.join("|") === ["awaiting", "declined", "raised", "released", "released_tzs",
      "released_usd", "total", "void"].join("|"), countKeys);
  check("…and both boards agree about how many papers are waiting",
    Number(refundBoard?.counts?.awaiting) === Number(board?.refunds?.awaiting_signature)
    && Number(refundBoard?.counts?.awaiting) === liveCounts.waiting,
    { service_board: board?.refunds?.awaiting_signature,
      refunds_board: refundBoard?.counts?.awaiting, live: liveCounts.waiting });
  const firstRow = refundBoard?.rows?.[0];
  check("…the rows carry the signature's own state and names, so the desk never holds "
    + "platform_approvals itself",
    !!firstRow && "approval_status" in firstRow && "payload_sha256" in firstRow
    && "signed_name" in firstRow && "approval_expires_at" in firstRow
    && "request_status" in firstRow && !("targets" in firstRow), firstRow);
  check("…the page is capped at a hundred, and the totals are kept apart by currency",
    (refundBoard?.rows?.length ?? 0) <= 100 && "released_tzs" in (refundBoard?.counts ?? {})
    && "released_usd" in (refundBoard?.counts ?? {}), { rows: refundBoard?.rows?.length });
  const searched = (await one(
    `select platform_auth.service_refunds_board($1,'all',$2,30,0) as b`, [TEN, p4!.ref])).b;
  check("…a paper is found by its number, which is the only thing a caller quotes",
    searched.rows.length === 1 && searched.rows[0].ref === p4!.ref, searched.rows);
  const oneRow = (await one(
    `select platform_auth.service_refunds_board($1,null,null,1,0) as b`, [TEN])).b;
  check("…and a page handed one row still says how many rows the filter matched, because the desk "
    + "counts pages from that number, not from the rows it was given",
    oneRow.rows.length === 1 && Number(oneRow.rows[0].total) === Number(oneRow.counts.total)
    && Number(oneRow.counts.total) > 1,
    { total: oneRow.rows?.[0]?.total, counts: oneRow.counts?.total });
  if (OTHER) {
    const elsewhere = (await one(
      `select platform_auth.service_refunds_board($1,null,null,100,0) as b`, [OTHER])).b;
    check("…and a second tenant's board reads nothing from the platform's register",
      Number(elsewhere?.counts?.total) === 0, elsewhere?.counts);
  } else note("no second tenant on this database: the cross-tenant board read is skipped.");

  // ================================================================
  console.log("\n--- 9 · the duties, the grants and the doors ---");
  const duties = await owner.query(
    `select rp.permission_key, r.key as role
       from role_permissions rp join roles r on r.id = rp.role_id
      where rp.permission_key like 'control.service.%' and r.tenant_id is null`);
  const holds = (key: string) =>
    duties.rows.filter((r) => r.permission_key === key).map((r) => r.role).sort().join("|");
  const sorted = (a: string[]) => [...a].sort().join("|");
  const WANT_ROLES = {
    view: sorted(["compliance_officer", "customer_service_agent", "platform_analyst",
      "support_engineer", "super_admin"]),
    manage: sorted(["customer_service_agent", "super_admin", "support_engineer"]),
    review: sorted(["compliance_officer", "customer_service_agent", "super_admin"])
  };
  const GOT_ROLES = {
    view: holds("control.service.view"), manage: holds("control.service.manage"),
    review: holds("control.service.review")
  };
  check("the three duties exist and are seeded on exactly the roles 126 named",
    GOT_ROLES.view === WANT_ROLES.view && GOT_ROLES.manage === WANT_ROLES.manage
    && GOT_ROLES.review === WANT_ROLES.review, GOT_ROLES);
  check("…so an analyst can ask “how are we doing” without being able to change anything",
    duties.rows.some((r) => r.permission_key === "control.service.view" && r.role === "platform_analyst")
    && !duties.rows.some((r) => r.permission_key === "control.service.manage"
      && r.role === "platform_analyst"));
  check("…and a seat that can open a dispute is not thereby allowed to publish a mark on "
    + "somebody else's work",
    !duties.rows.some((r) => r.permission_key === "control.service.review"
      && r.role === "support_engineer"));
  const decideAdded = await one(
    `select count(*)::int as n from role_permissions rp join roles r on r.id = rp.role_id
      where rp.permission_key = 'control.approvals.decide'
        and r.key in ('customer_service_agent','support_engineer','platform_analyst')`);
  check("126 did not widen who may sign a company out of trading in order to pay one back",
    Number(decideAdded.n) === 0, decideAdded);

  const privs = await owner.query(
    `select c.relname, a.grantee::regrole::text as who,
            array_agg(a.privilege_type order by a.privilege_type) as what
       from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       cross join aclexplode(c.relacl) a
      where ns.nspname = 'public'
        and c.relname in ('service_disputes','service_dispute_events','service_refund_requests',
                          'service_satisfaction','service_quality_reviews')
        and a.grantee::regrole::text in ('app_runtime','PUBLIC','anon','authenticated','service_role')
      group by 1, 2`);
  const grantOf = (t: string, who = "app_runtime") =>
    privs.rows.find((r) => r.relname === t && r.who === who)?.what ?? [];
  const REGISTERS = ["service_disputes", "service_refund_requests", "service_satisfaction",
    "service_quality_reviews"];
  check("the four registers give the API role read, write and update — and never DELETE",
    REGISTERS.every((t) => grantOf(t).join("|") === "INSERT|SELECT|UPDATE"),
    REGISTERS.map((t) => ({ t, what: grantOf(t) })));
  check("…and the event register takes only what a desk writes: insert and select",
    grantOf("service_dispute_events").join("|") === "INSERT|SELECT",
    grantOf("service_dispute_events"));
  check("…nothing on any of them is granted to PUBLIC, anon or a browser role",
    !privs.rows.some((r) => ["PUBLIC", "anon", "authenticated", "service_role"].includes(r.who)),
    privs.rows);
  const guards = await owner.query(
    `select p.proname, a.grantee::regrole::text as who
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join aclexplode(p.proacl) as a
      where n.nspname = 'platform_auth'
        and p.proname in ('csat_is_asked_after_the_call','quality_mark_is_read_from_its_checks',
          'review_answer_is_kept','service_paper_names_its_call','dispute_is_upheld_on_paper',
          'dispute_settles_on_its_figure','dispute_decision_is_kept',
          'refund_release_needs_two_seats','released_paper_is_kept')`);
  check("no trigger body of 126 is callable by a seat at all — they are fired, not called",
    guards.rows.length > 0 && guards.rows.every((r) => !["PUBLIC", "app_runtime", "anon",
      "authenticated", "service_role"].includes(r.who)), guards.rows.slice(0, 8));
  const DOORS = ["propose_refund_release", "apply_refund_release", "decline_refund",
    "service_refunds_board", "service_board"];
  const doorsAcl = await owner.query(
    `select p.proname, a.grantee::regrole::text as who, a.privilege_type as what
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join aclexplode(p.proacl) as a
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [DOORS]);
  check("the five doors the desk calls are app_runtime's, and not PUBLIC's",
    DOORS.every((f) => doorsAcl.rows.some((r) => r.proname === f && r.who === "app_runtime"
      && r.what === "EXECUTE")
      && !doorsAcl.rows.some((r) => r.proname === f && r.who === "PUBLIC")),
    doorsAcl.rows.slice(0, 10));
  const definer = await owner.query(
    `select p.proname, p.prosecdef as definer from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [DOORS]);
  check("…and every one of them runs as its owner, which is why no route holds "
    + "platform_approvals", definer.rowCount === 5 && definer.rows.every((r) => r.definer),
    definer.rows);
  const seqGrant = await one(
    `select has_sequence_privilege('app_runtime', 'service_dispute_number_seq'::regclass, 'USAGE')
            as disputes,
            has_sequence_privilege('app_runtime', 'service_refund_number_seq'::regclass, 'USAGE')
            as papers`);
  check("the desk's own number sequences are usable by the role the API runs as",
    seqGrant.disputes && seqGrant.papers, seqGrant);
  const masked = await one(
    `select count(*)::int as n from information_schema.columns
      where table_name in ('service_disputes','service_refund_requests','service_satisfaction',
                           'service_quality_reviews')
        and (column_name ~ 'phone|nida|email|password|otp' or data_type = 'bytea')`);
  check("nothing in the four registers can hold a caller's phone, NIDA or a password",
    Number(masked.n) === 0, masked);

  if (OTHER) {
    const sp = `t${++spNo}`;
    await owner.query(`savepoint ${sp}`);
    // Attempted, not assumed: a pooled login is often refused SET ROLE, and a gate that died on
    // the attempt would report an isolation failure where there is only a connection limitation.
    const asRuntime = await guarded("set local role app_runtime");
    if (asRuntime.err) {
      note(`this login cannot become app_runtime (${String(asRuntime.err.message)
        .replace(/\s+/g, " ").slice(0, 70)}) — the isolation of these registers is proved here by `
        + "the policies in section 1 and the second tenant's board read in section 8.");
    } else {
      await guarded(`select set_config('app.tenant_id', $1, true)`, [OTHER]);
      const seen = await guarded(`select count(*)::int as n from service_disputes`);
      check("as app_runtime, RLS really does hide the platform's register from another tenant",
        !seen.err && Number(seen.rows?.[0]?.n) === 0,
        seen.err ? String(seen.err.message).slice(0, 140) : seen.rows?.[0]);
      const wrote = await guarded(
        `insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref, company_name,
            ground, claim, opened_by)
         values ($1,'DP-2098-99990',$2,'CS-0000-00000','Probe Service Co','other',
           'A claim long enough to be read.',$3)`, [TEN, call1!.id, ACT]);
      check("…and cannot write a line into the platform's register from that session either",
        !!wrote.err && /row-level security/.test(String(wrote.err.message)),
        String(wrote.err?.message ?? "the insert went through").slice(0, 140));
    }
    await owner.query(`rollback to savepoint ${sp}`);
  } else {
    note("no second tenant on this database: the cross-tenant write read is skipped.");
  }

  await owner.query("rollback");
  await owner.end();

  // A second connection, because the point of the read-back is that the first one is gone.
  const back = mkClient();
  await back.connect();
  const left = (await back.query(LEDGER)).rows[0];
  const stillStanding = Object.fromEntries(Object.entries<number>(left)
    .filter(([k, v]) => k !== "audits" && Number(v) !== 0));
  const auditsGrew = Number(left.audits) - Number(found.audits);
  check("the rollback left every register exactly as it found it — the four new ones hold not a "
    + "row and the audit log grew by none of mine",
    Object.keys(stillStanding).length === 0 && auditsGrew === 0,
    { stillStanding, auditsGrew, found, left });
  await back.end();

  console.log(`\n${failures ? `${failures} FAILURE(S)` : "all 126 proofs hold"} — `
    + "the service registers");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
