/**
 * Live proof for #342 — the customer register (migration 127).
 *
 * Three registers and one read. None of it is proved in a route handler, because a route handler
 * is the thing that gets rewritten next quarter: which words a desk may type, which kinds are
 * allowed to lapse, which hand raised a line and whether an answer can be changed after it was
 * signed are facts of the table. So each is proved by the exception it raises and the row shape
 * that survives it, and the four readers are *executed* — a definer that has never been called is
 * a definer whose return shape nobody has checked.
 *
 * The vocabulary is the first thing read, not the last. `CHECK_KINDS` exists in three places — the
 * table's own CHECK, `src/customers/checks.ts` and the web desk's mirror — and the design of 127
 * depends on one kind per column of the queue. A drift is a 400 the desk cannot explain, or a kind
 * nobody can raise, and neither shows up until a clerk meets it.
 *
 * The refusals below are matched against constraint names resolved out of `pg_constraint` rather
 * than names copied from the migration: 127's table-level CHECKs are anonymous, so they are
 * `customer_verifications_check1…N`, and those numbers move the moment a rule is added. A gate
 * that hard-codes them fails for the wrong reason; a gate that looks them up by what the rule
 * *says* keeps telling the truth about which rule fired — and insists, before it uses a name, that
 * exactly one rule matched the words it searched for.
 *
 * Two things about `now()` decide the fixture plan, and both bite silently if ignored:
 *
 *   * every row written in one transaction gets the *same* `now()`, and 127's reads take "the line
 *     that stands for a kind" by `raised_at desc, id` — so a probe that leaves raised_at to the
 *     default has its winner chosen by a random uuid. Each line below is raised an explicit number
 *     of minutes in the past, which is what makes `is_current` a fact rather than a coin toss.
 *   * an answer is frozen by a trigger, so "make this line expired" cannot be an UPDATE of an
 *     answer the gate just signed. The expired read is a *new* line approved against a day that has
 *     already gone — the only way the register itself allows an expiry to appear.
 *
 * Everything runs inside one transaction that is rolled back, with a savepoint around every
 * statement: a raised trigger aborts the transaction, and every later query in an aborted
 * transaction answers "current transaction is aborted" instead of the question it was asked. The
 * accounts, seats, papers and rows this gate writes are minted inside that same transaction, so
 * they leave with it.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-customers-sql.ts   (from api/)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CHECK_KINDS, CHECK_STATES, EXPIRING_KINDS } from "../src/customers/checks";

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

const WEB_CHECKS = "../web/app/control/customers/checks.ts";

/** The quoted words of one CHECK's `= ANY (ARRAY[…])` / `<> ALL (ARRAY[…])` list.
 *  `pg_get_constraintdef` rewrites `kind in (…)` into that shape, so reading the vocabulary back
 *  out of the live table has to read the shape the server prints, not the one the migration was
 *  written in. */
function tokens(def: string, column: string): string[] {
  const m = def.match(new RegExp(`${column} (?:= ANY \\(ARRAY|<> ALL \\(ARRAY)\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}
/** Where two CHECKs could both refuse the same row, the server picks one and the name is not
 *  predictable — the gate then only insists a table rule fired. */
const ANY_RULE = "violates check constraint";

/** Rules the gate refuses *by name*, resolved once from the live catalog. `needles` are all the
 *  fragments that must appear in the printed definition, which is how one rule is told apart from
 *  its neighbours without copying a `_check7` that renumbers itself. */
const RULES: Record<string, string> = {};
function resolve(where: string, cons: { conname: string; def: string }[], ...needles: string[]) {
  const hits = cons.filter((c) => needles.every((n) => c.def.includes(n)));
  if (hits.length !== 1) {
    note(`!! "${where}" matched ${hits.length} rule(s): ${hits.map((h) => h.conname).join(", ") || "none"}`);
  }
  RULES[where] = hits[0]?.conname ?? "";
  return hits[0];
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const owner = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 120000
  });
  await owner.connect();
  const one = async (sql: string, p: any[] = []) => (await owner.query(sql, p)).rows[0];

  const STAMP = "127gate";
  const SEATS = `select id from users where email like '%${STAMP}@example.invalid'`;
  const LEDGER = `select
      (select count(*)::int from customer_verifications where raised_by in (${SEATS})) as checks,
      (select count(*)::int from customer_notes where author in (${SEATS})) as notes,
      (select count(*)::int from customer_tags where created_by in (${SEATS})) as tags,
      (select count(*)::int from customer_taggings where applied_by in (${SEATS})) as taggings,
      (select count(*)::int from users where email like '%${STAMP}@example.invalid') as seats,
      (select count(*)::int from tenants where name like '%${STAMP}%') as accounts,
      (select count(*)::int from documents where storage_path like '%/${STAMP}/%') as papers`;
  const before = await one(LEDGER);

  const TEN = (await one(
    `select id from tenants where type = 'platform' and deleted_at is null
     order by created_at limit 1`))?.id;
  if (!TEN) throw new Error("No platform tenant — 127 has no register to write into.");
  console.log(`\n--- 0 · the office's own tenant ${String(TEN).slice(0, 8)} ---`);

  await owner.query("begin");
  let sp = 0;
  const fails = async (label: string, sql: string, p: any[] = [], want = "") => {
    const name = `s${++sp}`;
    await owner.query(`savepoint ${name}`);
    let err: any = null;
    try { await owner.query(sql, p); } catch (e) { err = e; }
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) check(`…by the rule ${want}`, String(err.message).includes(want), err.message);
    await owner.query(`rollback to savepoint ${name}`);
    return err;
  };
  const guarded = async (sql: string, p: any[] = []) => {
    const name = `g${++sp}`;
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
  /** A definer answers a jsonb value, so its refusal is read rather than caught. */
  const call = async (label: string, sql: string, p: any[] = []) => {
    const { rows, err } = await guarded(sql, p);
    if (err) { check(`${label} — the door refused outright`, false, err.message); return null; }
    return rows?.[0]?.r ?? null;
  };

  // ---------- 1 · one vocabulary, three authors ----------
  console.log(`\n--- 1 · the five kinds and the five states, in the table and in both desks ---`);
  const load = async (t: string) => (await owner.query(`select conname, pg_get_constraintdef(oid) as def
    from pg_constraint where conrelid = $1::regclass and contype = 'c' order by conname`,
    [t])).rows as { conname: string; def: string }[];
  const consV = await load("customer_verifications");
  const consN = await load("customer_notes");
  const consT = await load("customer_tags");
  for (const [t, cons] of [["customer_verifications", consV], ["customer_notes", consN],
  ["customer_tags", consT]] as [string, { conname: string; def: string }[]][]) {
    for (const c of cons) note(`${t}: ${c.conname} — ${c.def.slice(0, 150)}`);
  }

  // Every needle the gate later refuses by, resolved once. A wrong fragment is a visible failure
  // here rather than a `want` that quietly matches nothing and lets any refusal pass.
  resolve("open holds no answer", consV, "reason IS NULL", "decided_by IS NULL");
  resolve("reason is a sentence", consV, "TRIM(BOTH FROM reason)");
  resolve("answer names its seat", consV, "decided_by IS NOT NULL");
  resolve("approval holds the number", consV, "reference_encrypted IS NOT NULL");
  resolve("number kept whole", consV, "reference_encrypted IS NULL", "reference_tail IS NULL");
  resolve("tail is short", consV, "char_length(reference_tail)");
  resolve("only three kinds lapse", consV, "expires_on IS NULL");
  resolve("an approval of those has a day", consV, "expires_on IS NOT NULL");
  resolve("a refusal says no in words", consV, "COALESCE(reason");
  resolve("an answer is not dated backwards", consV, "decided_at >=");
  resolve("a note is a sentence", consN, "TRIM(BOTH FROM body)");
  resolve("a withdrawal names a hand", consN, "voided_by IS NOT NULL");
  resolve("a withdrawal says why", consN, "COALESCE(void_reason");
  resolve("a reason for a withdrawal is a sentence", consN, "TRIM(BOTH FROM void_reason)");
  resolve("an edit is stamped after the note", consN, "edited_at >=");
  resolve("a label is lower-case", consT, "name ~");
  resolve("a colour is hex", consT, "colour ~");
  resolve("a label's note is one line", consT, "160");
  check("every rule this gate refuses by name was found, and found once",
    Object.values(RULES).every((n) => !!n), JSON.stringify(RULES));

  // The vocabulary is read from the rule that *only* lists words — `pg_get_constraintdef` prints
  // the column CHECK as `CHECK ((kind = ANY (ARRAY[…])))`, while two table-level rules embed the
  // same list inside a longer sentence. Taking the first constraint that mentions the column reads
  // whichever rule the planner happened to number first, and calls three kinds five.
  const columnRule = (cons: { def: string }[], column: string) =>
    cons.find((c) => new RegExp(`^CHECK \\(\\(${column} = ANY \\(ARRAY`).test(c.def));
  const tableKinds = tokens(columnRule(consV, "kind")?.def ?? "", "kind");
  const tableStates = tokens(columnRule(consV, "status")?.def ?? "", "status");

  // The web half is read out of its own file, not imported: `web/` is a Next.js package and this
  // gate runs inside `api/`, so the only honest comparison is the source the compiler would read.
  const webSrc = readFileSync(WEB_CHECKS, "utf8");
  /** The words in a `export const NAME = [...]` — following a spread, because the desk builds its
   *  state list out of two others (`[...OPEN_STATES, ...ANSWERS]`) and a comparison that read only
   *  the literals would see an empty list and call that agreement. */
  const webList = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const m = webSrc.match(new RegExp(`export const ${name}\\s*(?::[^=]*)?=\\s*\\[([^\\]]*)\\]`));
    if (!m) throw new Error(`web/app/control/customers/checks.ts has no ${name} array`);
    const spreads = [...m[1].matchAll(/\.\.\.([A-Z_]+)/g)].flatMap((x) => webList(x[1], seen));
    return [...[...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]), ...spreads];
  };
  /** `TIMELINE_SOURCES` is a list of `[word, label]` pairs, not a flat array. */
  const webPairs = (name: string) => {
    const m = webSrc.match(new RegExp(`export const ${name}[^(]*?\\[([\\s\\S]*?)\\n\\];`));
    if (!m) throw new Error(`web/app/control/customers/checks.ts has no ${name} list`);
    return [...m[1].matchAll(/\[\s*"([^"]+)"/g)].map((x) => x[1]);
  };
  const webKinds = webList("CHECK_KINDS");
  const webStates = webList("CHECK_STATES");
  const sorted = (a: readonly string[]) => [...a].sort().join(",");

  check("the table's own CHECK holds exactly five kinds", tableKinds.length === 5, tableKinds);
  check("the API's checks.ts says the same five, in the same order",
    tableKinds.join(",") === CHECK_KINDS.join(","),
    `table=${tableKinds.join(",")} api=${CHECK_KINDS.join(",")}`);
  check("the web desk says the same five, in the same order",
    tableKinds.join(",") === webKinds.join(","),
    `table=${tableKinds.join(",")} web=${webKinds.join(",")}`);
  check("the five states agree too, and neither desk invented a sixth",
    sorted(tableStates) === sorted(CHECK_STATES) && sorted(tableStates) === sorted(webStates),
    `table=${tableStates.join(",")} api=${CHECK_STATES.join(",")} web=${webStates.join(",")}`);
  const expiringRules = consV.filter((c) => c.def.includes("expires_on"));
  check("two rules mention a day: the one that limits it and the one that demands it",
    expiringRules.length === 2, JSON.stringify(expiringRules.map((c) => c.conname)));
  check("both name exactly the three kinds the API calls expiring",
    expiringRules.every((c) => sorted(tokens(c.def, "kind")) === sorted(EXPIRING_KINDS)),
    JSON.stringify(expiringRules.map((c) => tokens(c.def, "kind"))));
  const NINE = ["account", "decision", "verification", "note", "tag", "call", "service", "exit", "office"];
  check("the desk's nine story chips are the nine the definer can emit",
    sorted(webPairs("TIMELINE_SOURCES")) === sorted(NINE), webPairs("TIMELINE_SOURCES").join(","));

  // ---------- the accounts, seats and papers this gate stands on ----------
  // Four accounts, because the trust read is a sum of facts about an account and each of them
  // needs a different one to be true: a fresh company with only superseded answers, a closed one,
  // a lapsed one in grace, and an old one that is staffed and has an answer that stands.
  const COMPANY = randomUUID(), CLOSED = randomUUID(), OTHER = randomUUID(), AGED = randomUUID();
  await okDo("a transporter, a closed transporter and two shippers",
    `insert into tenants (id, type, name, status, slug, created_at)
     values ($1,'transporter','Probe KYC Co ${STAMP}','active','probe-kyc-${STAMP}',
             now() - interval '90 days'),
            ($2,'transporter','Probe Shut Co ${STAMP}','active','probe-shut-${STAMP}',
             now() - interval '90 days'),
            ($3,'shipper','Probe Other Co ${STAMP}','active','probe-other-${STAMP}',
             now() - interval '400 days'),
            ($4,'shipper','Probe Aged Co ${STAMP}','active','probe-aged-${STAMP}',
             now() - interval '200 days')`,
    [COMPANY, CLOSED, OTHER, AGED]);
  await okDo("and one of them closed by the office",
    `update tenants set deleted_at = now() where id = $1`, [CLOSED]);
  const mkSeat = async (who: string, type = "platform", tenant = TEN) => (await okDo(`probe seat ${who}`,
    `insert into users (tenant_id, user_type, email, full_name, status)
     values ($1,$2,$3,$4,'active') returning id`,
    [tenant, type, `probe-${who.toLowerCase()}-${STAMP}@example.invalid`, who]))?.[0]?.id as string;
  const RAISE = await mkSeat("raiser");
  const ANSWER = await mkSeat("answerer");
  const CLERK = await mkSeat("clerk", "staff");
  await mkSeat("driver-one", "staff", AGED);
  await mkSeat("driver-two", "staff", AGED);
  console.log(`\n--- 1b · four accounts, two office seats, a clerk and a staffed shipper inside `
    + `${String(COMPANY).slice(0, 8)} ---`);

  const mkPaper = async (tenant: string, label: string) => (await okDo(label,
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
        size_bytes, storage_path, uploaded_by)
     values ($1,'tenant',$2,'licence',$3,'application/pdf',1024,$4,$5) returning id`,
    [tenant, tenant, `${label}.pdf`, `probe/${STAMP}/${label}.pdf`, RAISE]))?.[0]?.id as string;
  const PAPER = await mkPaper(COMPANY, "own-licence");
  const FOREIGN = await mkPaper(OTHER, "foreign-licence");
  const GONE = await mkPaper(COMPANY, "filed-away");
  await okDo("and the third one filed away", `update documents set deleted_at = now() where id = $1`, [GONE]);

  // ---------- 2 · a check line: five states, one answer ----------
  console.log(`\n--- 2 · the check line: what may be written down ---`);
  const BYTES = "\\x0102030405060708090a0b0c0d0e1f";
  /** `ago` is minutes before now, and it is not decoration: two lines of one kind raised in the
   *  same transaction have the same `raised_at` unless the gate says otherwise, and 127 picks the
   *  line that stands for a kind by that column. */
  const mkCheck = async (o: Partial<{
    kind: string; status: string; company: string; enc: string | null; tail: string | null;
    expires: string | null; reason: string | null; doc: string | null; by: string;
    decided: string | null; ago: number;
  }> = {}, label = "an open line") => (await okDo(label,
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
        reference_encrypted, reference_tail, expires_on, reason, document_id, raised_by, raised_at,
        decided_by, decided_at)
     values ($1,$2,$3,$4,$5::bytea,$6,$7::date,$8,$9,$10, now() - ($12::int * interval '1 minute'),
             $11, case when $11::uuid is null then null else now() end)
     returning id, kind, status, reference_tail, to_char(expires_on,'YYYY-MM-DD') as expires_on,
               to_char(raised_at,'YYYY-MM-DD"T"HH24:MI') as raised_at`,
    [TEN, o.company ?? COMPANY, o.kind ?? "national_id", o.status ?? "awaiting",
      o.enc ?? null, o.tail ?? null, o.expires ?? null, o.reason ?? null, o.doc ?? null,
      o.by ?? RAISE, o.decided ?? null, o.ago ?? 0]))?.[0] as Record<string, any> | undefined;

  const fresh = await mkCheck({ ago: 60 }, "raise a line with nothing read off it yet");
  check("…it starts awaiting, with no number, no day and no answer",
    fresh?.status === "awaiting" && !fresh?.reference_tail && !fresh?.expires_on, fresh);

  await fails("an open line may not hold an answer's words",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, reason, raised_by)
     values ($1,$2,'tin','awaiting',$3,$4)`,
    [TEN, COMPANY, "Sent back because the number was unreadable.", RAISE],
    RULES["open holds no answer"]);
  await fails("a refusal says what it refused, in at least eight characters",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, reason,
        raised_by, decided_by, decided_at)
     values ($1,$2,'tin','rejected','nope',$3,$4,now())`, [TEN, COMPANY, RAISE, ANSWER],
    ANY_RULE);
  await fails("an answer names the seat and the moment it was given",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$2,'tin','approved',$3)`, [TEN, COMPANY, RAISE], ANY_RULE);
  await fails("an approval cannot be an opinion — it holds the number it read",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, reason,
        raised_by, decided_by, decided_at)
     values ($1,$2,'tin','approved','Confirmed on the call.',$3,$4,now())`,
    [TEN, COMPANY, RAISE, ANSWER], RULES["approval holds the number"]);
  await fails("a number is stored in whole or not at all — a tail with no bytes is half a pair",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
        reference_tail, raised_by) values ($1,$2,'tin','submitted','4471',$3)`,
    [TEN, COMPANY, RAISE], RULES["number kept whole"]);
  await fails("and the tail the desk shows is four characters at the outside",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
        reference_encrypted, reference_tail, raised_by)
     values ($1,$2,'tin','submitted',$3,'12345',$4)`, [TEN, COMPANY, BYTES, RAISE],
    RULES["tail is short"]);
  await fails("a national ID does not lapse on this register — the office does not decide when a "
    + "card stops being a card",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, expires_on, raised_by)
     values ($1,$2,'national_id','awaiting','2027-01-01',$3)`, [TEN, COMPANY, RAISE],
    RULES["only three kinds lapse"]);
  await fails("nor does a TIN",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, expires_on, raised_by)
     values ($1,$2,'tin','awaiting','2027-01-01',$3)`, [TEN, COMPANY, RAISE],
    RULES["only three kinds lapse"]);
  await fails("nothing on this register is a free-text kind",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$2,'passport','awaiting',$3)`, [TEN, COMPANY, RAISE],
    "customer_verifications_kind_check");
  await fails("and no free-text state either",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$2,'tin','pending',$3)`, [TEN, COMPANY, RAISE],
    "customer_verifications_status_check");
  await fails("an answer cannot be dated before the line it answers",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
        reference_encrypted, reference_tail, raised_by, decided_by, decided_at)
     values ($1,$2,'tin','approved',$3,'4471',$4,$5,now() - interval '9 days')`,
    [TEN, COMPANY, BYTES, RAISE, ANSWER], RULES["an answer is not dated backwards"]);
  // Two more refusals the register owes on its own words, each aimed at a rule nothing else can
  // answer for: an approval that reads its number but never says when it was signed, and a reason
  // too long for the column that holds it. Both are single-rule rows on purpose — where two CHECKs
  // could answer for the same line the server picks one and the name is not the gate's to know.
  await fails("an answer also names the moment, not only the seat",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
        reference_encrypted, reference_tail, raised_by, decided_by)
     values ($1,$2,'tin','approved',$3,'4471',$4,$5)`,
    [TEN, COMPANY, BYTES, RAISE, ANSWER], RULES["answer names its seat"]);
  await fails("a reason is a sentence the register can hold — six hundred characters at the most",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, reason,
        raised_by, decided_by, decided_at)
     values ($1,$2,'tin','needs_more',$3,$4,$5,now())`,
    [TEN, COMPANY, "n".repeat(601), RAISE, ANSWER], RULES["reason is a sentence"]);
  await fails("an approval of a licence that carries a day cannot leave the day blank",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status,
        reference_encrypted, reference_tail, raised_by, decided_by, decided_at)
     values ($1,$2,'insurance','approved',$3,'1f6e',$4,$5,now())`,
    [TEN, COMPANY, BYTES, RAISE, ANSWER], RULES["an approval of those has a day"]);

  // The day round-trip: a `date` column that goes through a JavaScript Date on the way in arrives
  // a day early or late, and the register's whole "expired" chip is one comparison on this column.
  const dated = await mkCheck({ kind: "transport_licence", status: "submitted",
    expires: "2027-06-15", ago: 58 }, "give a licence its day");
  check(`…(${RULES["only three kinds lapse"]}) — the day read back is the day handed in`,
    dated?.expires_on === "2027-06-15", dated);

  console.log(`\n--- 2b · whose account, whose paper ---`);
  await fails("the office does not verify itself",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$1,'tin','awaiting',$2)`, [TEN, RAISE], "does not verify itself");
  await fails("a closed account is 078's, not this register's",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$2,'tin','awaiting',$3)`, [TEN, CLOSED, RAISE], "is closed and cannot be checked");
  await fails("an account that is not there is a 23503 with a number in it",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$2,'tin','awaiting',$3)`, [TEN, randomUUID(), RAISE], "no account");
  await fails("a paper from another account cannot evidence a check",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, document_id, raised_by)
     values ($1,$2,'trade_licence','submitted',$3,$4)`,
    [TEN, COMPANY, FOREIGN, RAISE], "belongs to another account");
  await fails("a paper that has been filed away cannot carry one",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, document_id, raised_by)
     values ($1,$2,'trade_licence','submitted',$3,$4)`,
    [TEN, COMPANY, GONE, RAISE], "filed away");
  await fails("a paper named out of thin air is refused, not silently dropped",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, document_id, raised_by)
     values ($1,$2,'trade_licence','submitted',$3,$4)`,
    [TEN, COMPANY, randomUUID(), RAISE], "no paper");
  const tripPaper = (await okDo("paper filed against a trip is legal paper",
    `insert into documents (tenant_id, entity_type, entity_id, kind, file_name, mime_type,
        size_bytes, storage_path, uploaded_by)
     values ($1,'trip',$2,'licence','a-trip-paper.pdf','application/pdf',1024,$3,$4) returning id`,
    [TEN, randomUUID(), `probe/${STAMP}/a-trip-paper.pdf`, RAISE]))?.[0]?.id as string;
  await fails("…but a check cannot be evidenced with paper filed against a trip",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, document_id, raised_by)
     values ($1,$2,'trade_licence','submitted',$3,$4)`,
    [TEN, COMPANY, tripPaper, RAISE], "filed against a");
  const filed = await mkCheck({ kind: "trade_licence", status: "submitted", doc: PAPER, ago: 56 },
    "the account's own paper is accepted");
  check("…and the line carries it", !!filed?.id, filed);
  await fails("one open line per account per kind: the queue cannot grow twice",
    `insert into customer_verifications (tenant_id, company_tenant_id, kind, status, raised_by)
     values ($1,$2,'trade_licence','awaiting',$3)`, [TEN, COMPANY, RAISE],
    "customer_verifications_open_line_per_kind");
  const tin = await mkCheck({ kind: "tin", status: "submitted", enc: BYTES, tail: "4471", ago: 54 },
    "a second kind on the same account is its own line");
  check("…so the account now stands on more than one line", !!tin && tin.id !== filed?.id, tin);
  const otherTin = await mkCheck({ kind: "tin", company: OTHER, status: "approved",
    enc: BYTES, tail: "4471", ago: 30, decided: ANSWER }, "the same tail on another account is allowed");
  check("…because the register is not a duplicate detector", !!otherTin, otherTin);
  const movedToOpen = await mkCheck({ kind: "insurance", ago: 52 },
    "an insurance line waiting on paper");

  // ---------- 3 · an answer is kept ----------
  console.log(`\n--- 3 · an answer is kept, not edited ---`);
  const answered = (await okDo("approve the licence with its number, its day and its paper",
    `update customer_verifications
        set status = 'approved', reference_encrypted = $2::bytea, reference_tail = '9f2c',
            expires_on = '2027-03-31', decided_by = $3, decided_at = now(), document_id = $4
      where id = $1
      returning id, status, reference_tail, to_char(expires_on,'YYYY-MM-DD') as expires_on,
                decided_by, document_id`,
    [filed?.id, BYTES, ANSWER, PAPER]))?.[0] as Record<string, any>;
  check("the answer stands: approved, tail kept, day kept, seat named",
    answered?.status === "approved" && answered?.reference_tail === "9f2c"
    && answered?.expires_on === "2027-03-31" && answered?.decided_by === ANSWER, answered);

  for (const [what, sql, p] of [
    ["moved back to open", `update customer_verifications set status = 'submitted' where id = $1`, [answered?.id]],
    ["turned into a refusal", `update customer_verifications set status = 'rejected' where id = $1`, [answered?.id]],
    ["answered again by another seat", `update customer_verifications set decided_by = $2 where id = $1`,
      [answered?.id, CLERK]]
  ] as [string, string, any[]][]) {
    await fails(`a kept answer cannot be ${what}`, sql, p, "is kept");
  }
  for (const [what, sql, p] of [
    ["its number corrected", `update customer_verifications set reference_tail = '0000' where id = $1`, [answered?.id]],
    ["its day pushed back", `update customer_verifications set expires_on = '2029-12-31' where id = $1`, [answered?.id]],
    ["its paper swapped", `update customer_verifications set document_id = null where id = $1`, [answered?.id]],
    ["its reason re-worded", `update customer_verifications set reason = 'The office changed its mind.' where id = $1`, [answered?.id]],
    ["the moment it was signed moved", `update customer_verifications set decided_at = now() + interval '1 hour' where id = $1`, [answered?.id]]
  ] as [string, string, any[]][]) {
    await fails(`a kept answer cannot have ${what}`, sql, p, "its evidence is kept");
  }
  // The raised day is held by a different rule — the one that stops a clerk re-stamping who raised
  // a line — so naming the evidence rule here would report the wrong guard.
  await fails("a kept answer cannot have its raised day moved",
    `update customer_verifications set raised_at = now() - interval '3 years' where id = $1`,
    [answered?.id], "the raising is not editable");
  await fails("a line stays the kind it was raised as",
    `update customer_verifications set kind = 'insurance' where id = $1`, [answered?.id],
    "stays a trade_licence check");
  await fails("a line cannot be moved onto another account",
    `update customer_verifications set company_tenant_id = $2 where id = $1`, [answered?.id, OTHER],
    "cannot be moved onto another account");
  await fails("the raising is not editable",
    `update customer_verifications set raised_by = $2 where id = $1`, [answered?.id, ANSWER],
    "raising is not editable");
  const recheck = await mkCheck({ kind: "trade_licence", ago: 20 },
    "a re-check after a wrong answer is a new line");
  check("…and the register can hold both, so the second answer does not hide the first",
    !!recheck && recheck.id !== answered?.id && recheck.status === "awaiting",
    { recheck, answered: answered?.raised_at ?? null });
  await okDo("paper comes in for it",
    `update customer_verifications set status = 'submitted' where id = $1`, [movedToOpen?.id]);
  const back = await one(`select status, decided_by, reason from customer_verifications where id = $1`,
    [movedToOpen?.id]);
  check("…the two open states may move between each other — paper arrives, paper goes back",
    back?.status === "submitted" && back?.decided_by === null, back);
  await fails("…but an open line may not pick up an answer's evidence on the way",
    `update customer_verifications set decided_by = $2 where id = $1`, [movedToOpen?.id, ANSWER],
    "an open line cannot hold a decision");

  // ---------- 4 · the note ----------
  console.log(`\n--- 4 · the office's own words ---`);
  const mkNote = async (body: string, label = "a note", author = RAISE) => (await okDo(label,
    `insert into customer_notes (tenant_id, company_tenant_id, body, author)
     values ($1,$2,$3,$4) returning id, body, edited_at, voided_at`,
    [TEN, COMPANY, body, author]))?.[0] as Record<string, any> | undefined;
  const note1 = await mkNote("The caller read the licence number back over the phone.");
  await fails("a note is at least four characters — below that it is a mark, not a sentence",
    `insert into customer_notes (tenant_id, company_tenant_id, body, author)
     values ($1,$2,'ok',$3)`, [TEN, COMPANY, RAISE], RULES["a note is a sentence"]);
  await fails("and at most two thousand",
    `insert into customer_notes (tenant_id, company_tenant_id, body, author)
     values ($1,$2,$3,$4)`, [TEN, COMPANY, "n".repeat(2001), RAISE], RULES["a note is a sentence"]);
  const stub = await mkNote("Rewrite me.", "a note to rewrite");
  const rewrote = (await okDo("rewrite it",
    `update customer_notes set body = $2 where id = $1 returning body, edited_at`,
    [stub?.id, "Rewritten after the second caller rang."]))?.[0];
  check("…the edit is stamped by the table, not typed by the desk",
    rewrote?.body === "Rewritten after the second caller rang." && !!rewrote?.edited_at, rewrote);
  await fails("…and the stamp is a rule, not a courtesy: an edit dated before the note is refused",
    `update customer_notes set edited_at = created_at - interval '2 days' where id = $1`,
    [stub?.id], RULES["an edit is stamped after the note"]);
  await fails("a note keeps the hand that wrote it",
    `update customer_notes set author = $2 where id = $1`, [note1?.id, ANSWER],
    "keeps the hand that wrote it");
  await fails("a note cannot be moved onto another account",
    `update customer_notes set company_tenant_id = $2 where id = $1`, [note1?.id, OTHER],
    "another account");
  const pulled = (await okDo("withdraw a note with a reason",
    `update customer_notes set voided_at = now(), voided_by = $2,
            void_reason = 'It named the wrong licence number.'
      where id = $1 returning id, voided_at, void_reason`, [note1?.id, ANSWER]))?.[0];
  check("…a withdrawal keeps the text it withdrew", !!pulled?.voided_at, pulled);
  await fails("a withdrawal has to name the hand that withdrew it",
    `update customer_notes set voided_at = now(), voided_by = null,
            void_reason = 'Withdrawn by nobody in particular.' where id = $1`, [stub?.id],
    RULES["a withdrawal names a hand"]);
  await fails("and has to say why, in a sentence rather than in nothing",
    `update customer_notes set voided_at = now(), voided_by = $2, void_reason = null
      where id = $1`, [stub?.id, ANSWER], RULES["a withdrawal says why"]);
  await fails("…and the sentence it says has to be long enough to mean something",
    `update customer_notes set voided_at = now(), voided_by = $2, void_reason = 'wrong'
      where id = $1`, [stub?.id, ANSWER], ANY_RULE);
  await fails("…and short enough for the column that holds it",
    `update customer_notes set voided_at = now(), voided_by = $2, void_reason = $3
      where id = $1`, [stub?.id, ANSWER, "n".repeat(601)],
    RULES["a reason for a withdrawal is a sentence"]);
  await fails("a withdrawn note cannot be rewritten — its text is what the withdrawal was about",
    `update customer_notes set body = 'A different story after the withdrawal.' where id = $1`,
    [note1?.id], "withdrawn and cannot be rewritten");
  await fails("a withdrawal cannot be edited into a different withdrawal",
    `update customer_notes set void_reason = 'Something else entirely about the note.' where id = $1`,
    [note1?.id], "a withdrawal is not edited");
  await fails("a withdrawal cannot be undone",
    `update customer_notes set voided_at = null, voided_by = null, void_reason = null where id = $1`,
    [note1?.id], "a withdrawal is not edited");
  await fails("a note cannot be withdrawn before it was written",
    `update customer_notes set voided_at = now() - interval '400 days', voided_by = $2,
            void_reason = 'Withdrawn in the past, which is a thing that did not happen.' where id = $1`,
    [stub?.id, ANSWER], "cannot be withdrawn before it was written");

  // ---------- 5 · the labels ----------
  console.log(`\n--- 5 · a queue a clerk can act on, not a free-text field ---`);
  const mkTag = async (name: string, colour: string | null = null, label = "a label",
    tenant = TEN) => (await okDo(label,
    `insert into customer_tags (tenant_id, name, colour, created_by)
     values ($1,$2,$3,$4) returning id, name, colour`,
    [tenant, name, colour, RAISE]))?.[0] as Record<string, any> | undefined;
  const tag = await mkTag("kyc-hold", "#7c3aed");
  check("a label is created with a colour the picker can paint", !!tag?.colour, tag);
  const dashy = await mkTag("paid_in_full", null, "a name with an underscore is a name");
  check("…and the desk's own character class allows the punctuation a clerk types", !!dashy?.id, dashy);
  for (const bad of ["KYC-Hold", "kyc hold!", "x", "a".repeat(30), "-leading-dash"]) {
    await fails(`a name shaped like “${bad.slice(0, 14)}” is refused`,
      `insert into customer_tags (tenant_id, name, created_by) values ($1,$2,$3)`,
      [TEN, bad, RAISE], RULES["a label is lower-case"]);
  }
  await fails("a colour is six hex digits or nothing",
    `insert into customer_tags (tenant_id, name, colour, created_by)
     values ($1,'purple-trial','violet',$2)`, [TEN, RAISE], RULES["a colour is hex"]);
  await fails("a note about a label is one line, not an essay",
    `insert into customer_tags (tenant_id, name, note, created_by)
     values ($1,'long-note',$2,$3)`, [TEN, "n".repeat(161), RAISE], RULES["a label's note is one line"]);
  const foreignTag = await mkTag("kyc-hold", null, "a second register may hold the same word", OTHER);
  check("…because a label belongs to the office that wrote it", !!foreignTag?.id, foreignTag);
  await fails("this register cannot hold one word twice",
    `insert into customer_tags (tenant_id, name, created_by) values ($1,'kyc-hold',$2)`,
    [TEN, RAISE], "customer_tags_name_live");
  const wear = async (company: string, tagId: string, label = "put a label on") =>
    (await okDo(label,
      `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
       values ($1,$2,$3,$4) returning id, applied_at`,
      [TEN, company, tagId, RAISE]))?.[0] as Record<string, any> | undefined;
  const worn = await wear(COMPANY, String(tag?.id));
  check("…an account wears it", !!worn, worn);
  await fails("the same label cannot go on the same account twice",
    `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, COMPANY, tag?.id, RAISE], "customer_taggings_live");
  await fails("a label from another register cannot be worn",
    `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, COMPANY, foreignTag?.id, RAISE], "another register");
  await fails("the office cannot label itself",
    `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
     values ($1,$1,$2,$3)`, [TEN, tag?.id, RAISE], "not a live account");
  await fails("a closed account cannot carry a label",
    `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, CLOSED, tag?.id, RAISE], "not a live account");
  await fails("a label named out of thin air is refused, not dropped",
    `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, COMPANY, randomUUID(), RAISE], "no label");
  const retiredTag = await mkTag("old-word", null, "a label nobody wears");
  await okDo("…retired", `update customer_tags set deleted_at = now(), deleted_by = $2 where id = $1`,
    [retiredTag?.id, ANSWER]);
  await okDo("a retired word may be written again, as a new label",
    `insert into customer_tags (tenant_id, name, created_by) values ($1,'old-word',$2)`,
    [TEN, RAISE]);
  await fails("but the withdrawn one cannot be put back on an account",
    `insert into customer_taggings (tenant_id, company_tenant_id, tag_id, applied_by)
     values ($1,$2,$3,$4)`, [TEN, COMPANY, retiredTag?.id, RAISE], "withdrawn label");
  const off = (await okDo("take a label off — retired, not deleted",
    `update customer_taggings set deleted_at = now(), deleted_by = $2 where id = $1
     returning id, deleted_at`, [worn?.id, ANSWER]))?.[0];
  check("…the pairing stays as history", !!off?.deleted_at, off);
  const rewear = await wear(COMPANY, String(tag?.id), "and the account may wear it again");
  check("…as a new pairing, so both marks are on the record", !!rewear && rewear.id !== worn?.id, rewear);
  const twice = (await okDo("taking it off a second time finds nothing live to take off",
    `update customer_taggings set deleted_at = now(), deleted_by = $2
       where id = $1 and deleted_at is null returning id`, [worn?.id, ANSWER])) ?? [];
  const pairHist = await one(`select count(*)::int as rows,
      count(*) filter (where deleted_at is null)::int as live,
      count(*) filter (where id = $1 and deleted_at is not null)::int as the_old_one_still_off
    from customer_taggings where company_tenant_id = $2 and tag_id = $3`,
    [worn?.id, COMPANY, tag?.id]);
  check("…so the retired pairing and the live one both stay on the register",
    twice.length === 0 && pairHist?.rows === 2 && pairHist?.live === 1
    && pairHist?.the_old_one_still_off === 1, JSON.stringify({ twice, pairHist }));
  note("which is what the desk's 404 is for: the route writes with `deleted_at is null`, so a "
    + "second press cannot re-mark history it has already let go of.");

  // ---------- 6 · the four readers, executed ----------
  console.log(`\n--- 6 · the definers: executed, and their shapes read ---`);
  const board = await call("customer_board answers for the register",
    `select platform_auth.customer_board($1::uuid, null, null, null, null, 25, 0) as r`, [TEN]);
  check("…with the facets the desk prints beside the list",
    board?.status === "ok" && ["accounts", "never_checked", "checks"].every((k) => k in (board?.facets ?? {}))
    && ["approved", "open", "refused", "expired"].every((k) => k in (board?.facets?.checks ?? {})),
    JSON.stringify(board?.facets));
  check("…facets ignore the clerk's filter, so a count taken after it would lie",
    typeof board?.facets?.accounts === "number" && board.facets.accounts >= 2, board?.facets?.accounts);
  const row = (board?.rows ?? []).find((r: any) => r.company_tenant_id === COMPANY);
  const ROW_KEYS = ["company_tenant_id", "name", "type", "account_status", "slug", "created_at",
    "trial_ends_at", "licence_expires_at", "plan_name", "seats", "checks", "tags",
    "blocked_note", "last_note", "trust"];
  check("…the row the desk reads is the row the board returns",
    ROW_KEYS.every((k) => k in (row ?? {})), Object.keys(row ?? {}).join(","));
  check("…four check numbers per account, not one stored score",
    ["lines", "approved", "open", "refused", "expired"].every(
      (k) => typeof row?.checks?.[k] === "number"), JSON.stringify(row?.checks));
  // Seven raw rows, six of them on one account — but the board counts the line that *stands* for
  // each kind, and the trade_licence that stands is the re-check, not the answer it followed.
  check("…the board counts kinds, not rows: five kinds, all open, the kept answer superseded",
    row?.checks?.lines === 5 && row?.checks?.open === 5 && row?.checks?.approved === 0
    && row?.checks?.refused === 0 && row?.checks?.expired === 0, JSON.stringify(row?.checks));
  check("…a worn label reaches the board as a chip with a colour",
    (row?.tags ?? []).some((t: any) => t.name === "kyc-hold" && !!t.colour), JSON.stringify(row?.tags));
  check("…and the trust read travels with the row", !!row?.trust?.band, row?.trust?.band);
  check("…no board row carries a reference at all",
    (board?.rows ?? []).every((r: any) => !("reference" in r) && !("reference_encrypted" in r)),
    Object.keys(row ?? {}).join(","));
  check("…the office's own tenant is not on a customer board",
    !(board?.rows ?? []).some((r: any) => r.company_tenant_id === TEN));
  check("…the closed one is not either, because the board is the queue",
    !(board?.rows ?? []).some((r: any) => r.company_tenant_id === CLOSED),
    board?.rows?.length);
  for (const st of ["waiting", "refused", "expired", "clear", "none"]) {
    const picked = await call(`the board answers the chip “${st}”`,
      `select platform_auth.customer_board($1::uuid, null, null, $2, null, 25, 0) as r`, [TEN, st]);
    check(`…without an error, with ${picked?.rows?.length ?? "?"} row(s)`, Array.isArray(picked?.rows));
  }
  const waiting = await call("…and “waiting” really is the accounts the office owes",
    `select platform_auth.customer_board($1::uuid, null, null, 'waiting', null, 25, 0) as r`, [TEN]);
  check("…the probed account is one of them",
    (waiting?.rows ?? []).some((r: any) => r.company_tenant_id === COMPANY));
  const clear = await call("“clear” is an account with answers and nothing owed",
    `select platform_auth.customer_board($1::uuid, null, null, 'clear', null, 25, 0) as r`, [TEN]);
  check("…and the probed account is not on it while a re-check is open",
    !(clear?.rows ?? []).some((r: any) => r.company_tenant_id === COMPANY));
  const noneYet = await call("“none” is the accounts never looked at",
    `select platform_auth.customer_board($1::uuid, null, null, 'none', null, 25, 0) as r`, [TEN]);
  check("…and the probed account is not in it — it has five kinds on file",
    !(noneYet?.rows ?? []).some((r: any) => r.company_tenant_id === COMPANY));
  check("…but the shipper with one line is not there either",
    !(noneYet?.rows ?? []).some((r: any) => r.company_tenant_id === OTHER));
  for (const kind of tableKinds) {
    const byKind = await call(`the board answers the kind chip “${kind}”`,
      `select platform_auth.customer_board($1::uuid, null, null, null, $2, 25, 0) as r`, [TEN, kind]);
    // By this point the probed account holds an open line of every one of the five kinds: the ID
    // and the TIN were raised open, the licence's answer was superseded by the re-check, the day
    // was given to a submitted transport licence, and the insurance paper went in — still open.
    check(`…an account with an open ${kind} is in the ${kind} chip`,
      (byKind?.rows ?? []).some((r: any) => r.company_tenant_id === COMPANY), byKind?.rows?.length);
  }
  const searched = await call("the board searches by the name it trades under",
    `select platform_auth.customer_board($1::uuid, 'Probe KYC', null, null, null, 25, 0) as r`, [TEN]);
  check("…and finds one row", searched?.rows?.length === 1
    && searched.rows[0].company_tenant_id === COMPANY, JSON.stringify(searched?.rows?.map(
      (r: any) => r.name)));
  const byTinHash = await call("a TIN search is answered on the hash, never on a value",
    `select platform_auth.customer_board($1::uuid, null, 'deadbeef', null, null, 25, 0) as r`, [TEN]);
  check("…and finds nothing rather than everything", byTinHash?.rows?.length === 0,
    byTinHash?.rows?.length);
  const paged = await call("a page smaller than the register pages",
    `select platform_auth.customer_board($1::uuid, null, null, null, null, 1, 0) as r`, [TEN]);
  check("…and says how many there are, not how many it sent",
    paged?.rows?.length === 1 && paged?.total > 1 && paged?.limit === 1,
    JSON.stringify({ rows: paged?.rows?.length, total: paged?.total, limit: paged?.limit }));
  const clamped = await call("a limit of five hundred is pulled back, not obeyed",
    `select platform_auth.customer_board($1::uuid, null, null, null, null, 500, 0) as r`, [TEN]);
  check("…to the desk's own ceiling of a hundred", clamped?.limit === 100, clamped?.limit);

  const dos = await call("customer_dossier answers for one account",
    `select platform_auth.customer_dossier($1::uuid, $2::uuid) as r`, [TEN, COMPANY]);
  check("…thirteen blocks, the desk's own thirteen",
    ["company", "profile", "licences", "seats", "actions", "exit", "calls", "checks", "notes",
      "tags", "paper", "trust", "clock"].every((k) => k in (dos ?? {})),
    Object.keys(dos ?? {}).join(","));
  check("…every check line of the account, not one per kind — the file keeps the history",
    (dos?.checks ?? []).length === 6, JSON.stringify(dos?.checks?.map((c: any) =>
      [c.kind, c.status])));
  const dline = (dos?.checks ?? []).find((c: any) => c.id === answered?.id);
  check("…a decided line names both seats in the register's own words",
    "raised_name" in (dline ?? {}) && "decided_name" in (dline ?? {})
    && !("raised_by_name" in dline) && !("decided_by_name" in dline),
    Object.keys(dline ?? {}).join(","));
  check("…and says which line is the current one of its kind — the older answer is marked",
    dline?.is_current === false, dline?.is_current);
  const dcur = (dos?.checks ?? []).find((c: any) => c.id === recheck?.id);
  check("…the newest line of that kind is the current one", dcur?.is_current === true,
    JSON.stringify(dcur));
  const current = (dos?.checks ?? []).filter((c: any) => c.is_current);
  check("…and exactly one line of each kind stands as the current one",
    current.length === 5 && new Set(current.map((c: any) => c.kind)).size === 5,
    JSON.stringify((dos?.checks ?? []).map((c: any) => [c.kind, c.is_current])));
  check("…a check leaves the dossier as a tail, never as a number",
    (dos?.checks ?? []).every((c: any) => !("reference_encrypted" in c) && !("reference" in c)),
    Object.keys(dline ?? {}).join(","));
  const dtag = (dos?.tags ?? []).find((t: any) => t.tagging_id === rewear?.id);
  check("…a worn label carries the label's own id, which is what the desk retires by",
    dtag?.id === tag?.id, JSON.stringify(dtag));
  check("…and the pairing id, which is what the list is keyed on",
    dtag?.tagging_id === rewear?.id && dtag?.name === "kyc-hold", JSON.stringify(dtag));
  check("…the pairing retired first is not on the account any more",
    !(dos?.tags ?? []).some((t: any) => t.tagging_id === worn?.id), JSON.stringify(dos?.tags));
  check("…a withdrawn note stays on the file, below the live ones",
    (dos?.notes ?? []).length === 2
    && dos.notes[0].id === stub?.id && !dos.notes[0].voided_at
    && dos.notes[1].id === note1?.id && !!dos.notes[1].voided_at
    && !!dos.notes[1].voided_by_name, JSON.stringify(dos?.notes?.map((n: any) => [n.body.slice(0, 12), !!n.voided_at])));
  check("…the filed paper is listed and the filed-away one is not",
    (dos?.paper ?? []).length === 1 && dos.paper[0].file_name === "own-licence.pdf",
    JSON.stringify(dos?.paper?.map((p: any) => p.file_name)));
  check("…the seat count, the calls and the exit are the platform's own, read live",
    typeof dos?.seats?.live === "number" && ["open", "all", "disputes", "papers"].every(
      (k) => k in (dos?.calls ?? {})), JSON.stringify(dos?.calls));
  const closedDos = await call("a closed account still has a dossier — it was a customer",
    `select platform_auth.customer_dossier($1::uuid, $2::uuid) as r`, [TEN, CLOSED]);
  check("…and it says when it stopped being one", !!closedDos?.company?.deleted_at,
    JSON.stringify(closedDos?.company));
  const stranger = await call("another office's register reads the same account",
    `select platform_auth.customer_dossier($1::uuid, $2::uuid) as r`, [OTHER, COMPANY]);
  check("…and sees none of this register's notes or labels",
    stranger?.notes?.length === 0 && stranger?.tags?.length === 0,
    JSON.stringify({ notes: stranger?.notes?.length, tags: stranger?.tags?.length }));
  check("…but still sees who the account is", stranger?.company?.id === COMPANY, stranger?.status);
  const ghost = await call("a dossier for an account that is not there",
    `select platform_auth.customer_dossier($1::uuid, $2::uuid) as r`, [TEN, randomUUID()]);
  check("…says not_found rather than an empty company", ghost?.status === "not_found",
    JSON.stringify(ghost));

  const tl = await call("customer_timeline assembles the story",
    `select platform_auth.customer_timeline($1::uuid, null, 80) as r`, [COMPANY]);
  const sources = [...new Set((tl?.rows ?? []).map((r: any) => r.source))] as string[];
  check("…out of the sources the desk offers chips for, and no others",
    sources.length > 0 && sources.every((s) => NINE.includes(s)), sources.join(","));
  check("…a raise and an answer are both in it, as two lines of one story",
    sources.includes("verification")
    && (tl?.rows ?? []).filter((r: any) => r.source === "verification").length === 7,
    JSON.stringify((tl?.rows ?? []).filter((r: any) => r.source === "verification")
      .slice(0, 4).map((r: any) => r.title)));
  check("…so is a note — written, edited and withdrawn are three different lines",
    sources.includes("note")
    && (tl?.rows ?? []).filter((r: any) => r.source === "note").length === 4,
    JSON.stringify((tl?.rows ?? []).filter((r: any) => r.source === "note").map((r: any) => r.title)));
  check("…and a label on and a label off are two different lines of it",
    sources.includes("tag")
    && (tl?.rows ?? []).filter((r: any) => r.source === "tag").length === 2,
    JSON.stringify((tl?.rows ?? []).filter((r: any) => r.source === "tag").map((r: any) => r.title)));
  const stamps = (tl?.rows ?? []).map((r: any) => r.ts);
  check("…told newest first", stamps.every((t, i) => i === 0 || stamps[i - 1] >= t),
    JSON.stringify(stamps.slice(0, 3)));
  check("…and nothing in it has no moment", stamps.every((t) => !!t));
  for (const s of sources) {
    const cut = await call(`the desk can cut the story to “${s}”`,
      `select platform_auth.customer_timeline($1::uuid, $2, 40) as r`, [COMPANY, s]);
    check(`…and every row that comes back is one of those`,
      (cut?.rows ?? []).every((r: any) => r.source === s) && cut.rows.length > 0,
      JSON.stringify(cut?.rows?.slice(0, 2)?.map((r: any) => r.source)));
  }
  const nonsense = await call("a chip the definer never emits answers an empty story",
    `select platform_auth.customer_timeline($1::uuid, 'nonsense', 10) as r`, [COMPANY]);
  check("…not an error", Array.isArray(nonsense?.rows) && nonsense.rows.length === 0,
    nonsense?.rows?.length);
  const tlVer = (tl?.rows ?? []).filter((r: any) => r.source === "verification");
  check("…and every line of it names the seat the register says was responsible",
    tlVer.every((r: any) => !!r.actor) && tlVer.length > 0,
    JSON.stringify(tlVer.slice(0, 2)));
  const tlSmall = await call("a story asked for nought lines still answers one",
    `select platform_auth.customer_timeline($1::uuid, null, 0) as r`, [COMPANY]);
  check("…rather than raising or lying with an empty page", tlSmall?.rows?.length === 1,
    tlSmall?.rows?.length);
  check("…and no line of the story carries a whole identity number",
    (tl?.rows ?? []).every((r: any) => !/reference_encrypted/i.test(JSON.stringify(r))));

  const trust = await call("customer_trust is worked out now, out of these registers",
    `select platform_auth.customer_trust($1::uuid) as r`, [COMPANY]);
  check("…a score, a band, the factors and the basis",
    typeof trust?.score === "number" && !!trust?.band && Array.isArray(trust?.factors)
    && !!trust?.basis, JSON.stringify(trust).slice(0, 240));
  check("…the band is one of the seven the desk can print",
    ["closed", "held", "unverified", "strong", "good", "steady", "watched"].includes(trust?.band),
    trust?.band);
  check("…every factor is a point with the words it is worth",
    (trust?.factors ?? []).every((f: any) => typeof f.points === "number" && !!f.label && !!f.detail),
    JSON.stringify(trust?.factors));
  const sum = (trust?.factors ?? []).reduce((n: number, f: any) => n + (f.points ?? 0), 0);
  check("…and the score is the base plus those factors, not a number somebody liked",
    Math.max(0, Math.min(100, (trust?.base ?? 50) + sum)) === trust?.score,
    JSON.stringify({ base: trust?.base, sum, score: trust?.score }));
  check("…the basis is the same four numbers the board shows, read from the same registers",
    ["approved", "open", "refused", "expired", "lines", "blocks_365d", "seats"].every(
      (k) => k in (trust?.basis ?? {})), JSON.stringify(trust?.basis));
  // The probed account has an approved answer, but a re-check of that licence is open and the
  // register stands on the newest line of each kind — so nothing stands approved and no factor
  // fires. The base is the honest answer for an account the office has not finished with.
  check("…an account with every kind still owed an answer sits at the base",
    (trust?.factors ?? []).length === 0 && trust?.score === 50 && trust?.band === "unverified",
    JSON.stringify({ factors: trust?.factors, score: trust?.score, band: trust?.band }));

  // The four factors the arithmetic has to add up for: an answer that stands, the office's own
  // licence date, the subscription state, and how long the account has been here. Each is set on
  // the shipper rather than the transporter so the register's own reads above stay put.
  await okDo("put the shipper in grace, with a platform licence that has gone by",
    `update tenants set status = 'grace', licence_expires_at = now() - interval '30 days'
      where id = $1`, [OTHER]);
  const onGrace = await call("and read what the account is worth now",
    `select platform_auth.customer_trust($1::uuid) as r`, [OTHER]);
  const words = (onGrace?.factors ?? []).map((f: any) => `${f.label}:${f.points}`).sort().join(" | ");
  check(`…an approved TIN, a lapsed licence, grace and four years on the platform (${words})`,
    (onGrace?.factors ?? []).length === 4
    && words.includes("checked and approved:10") && words.includes("platform licence lapsed:-12")
    && words.includes("subscription grace:-8") && words.includes("a year on the platform:10"),
    JSON.stringify(onGrace?.factors));
  const sumLapsed = (onGrace?.factors ?? []).reduce((n: number, f: any) => n + (f.points ?? 0), 0);
  check("…which is the base, added up, and lands on the band that number means",
    onGrace?.score === 50 + sumLapsed && onGrace?.band === "watched",
    JSON.stringify({ score: onGrace?.score, band: onGrace?.band }));

  // Two more factors the account itself carries: how long it has been here (between six months
  // and a year, which is a different line from the four-year shipper above) and whether anyone is
  // sitting at it. Together with its approved ID they land the score on the `good` boundary.
  await mkCheck({ kind: "national_id", company: AGED, status: "approved", enc: BYTES,
    tail: "9911", decided: ANSWER }, "an old, staffed account with an answer that stands");
  const aged = await call("and read the account that is two-thirds of a year old",
    `select platform_auth.customer_trust($1::uuid) as r`, [AGED]);
  const agedWords = (aged?.factors ?? []).map((f: any) => `${f.label}:${f.points}`).sort().join(" | ");
  check(`…six months, two seats and one approved check (${agedWords})`,
    agedWords.includes("six months on the platform:6") && agedWords.includes("staffed:4")
    && agedWords.includes("checked and approved:10"), JSON.stringify(aged?.factors));
  check("…and the arithmetic reaches the band the desk prints as Good",
    aged?.score === 70 && aged?.band === "good", JSON.stringify({ score: aged?.score, band: aged?.band }));

  const never = await call("an account that is not on the platform at all",
    `select platform_auth.customer_trust($1::uuid) as r`, [randomUUID()]);
  check("…is answered with not_found rather than a score of nought",
    never?.status === "not_found" && never?.score === undefined, JSON.stringify(never));
  const shut = await call("a closed account", `select platform_auth.customer_trust($1::uuid) as r`, [CLOSED]);
  check("…is told it is closed, whatever else the registers say", shut?.band === "closed",
    JSON.stringify(shut));
  const held = (await okDo("suspend the shipper for a moment",
    `update tenants set status = 'suspended' where id = $1 returning id`, [OTHER]))?.length;
  const heldTrust = await call("and read it again",
    `select platform_auth.customer_trust($1::uuid) as r`, [OTHER]);
  check("…a held account is named held before its number is, whatever the number is",
    !!held && heldTrust?.band === "held" && heldTrust?.account_status === "suspended",
    JSON.stringify({ band: heldTrust?.band, score: heldTrust?.score }));

  // ---------- 7 · who may touch the table ----------
  console.log(`\n--- 7 · the desk's own reach ---`);
  const reach = await one(`select
      has_table_privilege('app_runtime', 'customer_verifications', 'delete') as v_del,
      has_table_privilege('app_runtime', 'customer_notes', 'delete') as n_del,
      has_table_privilege('app_runtime', 'customer_verifications', 'insert') as v_ins,
      has_table_privilege('anon', 'customer_verifications', 'select') as anon_read,
      has_table_privilege('authenticated', 'customer_notes', 'select') as auth_read,
      has_table_privilege('service_role', 'customer_taggings', 'update') as svc_write`);
  check("the two registers cannot be deleted from by the role the API runs as",
    !reach?.v_del && !reach?.n_del, JSON.stringify(reach));
  check("…but they can be written to, which is how a check gets raised", !!reach?.v_ins, reach);
  check("…and no client role of Supabase can read any of the four",
    !reach?.anon_read && !reach?.auth_read && !reach?.svc_write,
    JSON.stringify(reach));
  const leaks = await owner.query(`select c.relname, a.grantee::regrole::text as who,
      a.privilege_type as what
    from pg_class c join lateral aclexplode(c.relacl) a on true
   where c.oid in ('customer_verifications'::regclass,'customer_notes'::regclass,
                   'customer_tags'::regclass,'customer_taggings'::regclass)
     and (a.grantee = 0 or a.grantee::regrole::text in
          ('anon','authenticated','service_role'))`);
  check("…and the raw ACL says the same: no PUBLIC entry, no client-role entry",
    leaks.rowCount === 0, JSON.stringify(leaks.rows));
  const trig = await one(`select has_function_privilege('app_runtime',
      'platform_auth.verification_answer_is_kept()', 'execute') as kept,
      has_function_privilege('app_runtime',
      'platform_auth.verification_names_its_account()', 'execute') as names,
      has_function_privilege('app_runtime',
      'platform_auth.note_is_kept_not_rewritten()', 'execute') as note,
      has_function_privilege('app_runtime',
      'platform_auth.customer_tagging_names_a_live_pair()', 'execute') as pair`);
  check("app_runtime cannot execute 127's trigger bodies by hand",
    !trig?.kept && !trig?.names && !trig?.note && !trig?.pair, JSON.stringify(trig));
  const rd = await one(`select has_function_privilege('app_runtime',
      'platform_auth.customer_board(uuid,text,text,text,text,int,int)', 'execute') as board,
      has_function_privilege('app_runtime', 'platform_auth.customer_dossier(uuid,uuid)', 'execute') as dos,
      has_function_privilege('app_runtime', 'platform_auth.customer_timeline(uuid,text,int)', 'execute') as tl,
      has_function_privilege('app_runtime', 'platform_auth.customer_trust(uuid)', 'execute') as trust,
      has_function_privilege('anon', 'platform_auth.customer_board(uuid,text,text,text,text,int,int)',
      'execute') as anon_board`);
  check("…but it can execute the four readers the routes call",
    rd?.board && rd?.dos && rd?.tl && rd?.trust, JSON.stringify(rd));
  check("…and a signed-in browser cannot call the board itself", !rd?.anon_board, rd);
  // Grouped on the function's own oid: `proacl` is an aclitem[], which has a hash operator but no
  // btree one, so a GROUP BY that names the column outright cannot be planned at all. An overload
  // that outlived a signature change is exactly the row this check exists to find, so each oid is
  // read on its own rather than folded into one line per name.
  const acl = await owner.query(`select p.proname, p.proacl is null as unlisted,
      coalesce(string_agg(distinct a.grantee::text, ','), '') as grantees
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join lateral aclexplode(p.proacl) a on true
   where n.nspname = 'platform_auth' and p.proname in
     ('customer_board','customer_dossier','customer_timeline','customer_trust')
   group by p.oid, p.proname, (p.proacl is null)`);
  const wide = acl.rows.filter((r: any) => r.unlisted || String(r.grantees).split(",").includes("0"));
  check("the readers are not left open to PUBLIC — a drop-and-create would have reset this",
    wide.length === 0, JSON.stringify(acl.rows));
  const rlsOn = await owner.query(`select relrowsecurity as on_ from pg_class
    where oid in ('customer_verifications'::regclass,'customer_notes'::regclass,
                  'customer_tags'::regclass,'customer_taggings'::regclass)`);
  check("RLS is on for all four", rlsOn.rows.every((r: any) => r.on_), JSON.stringify(rlsOn.rows));
  const duties = await owner.query(`select key from permissions where key like 'control.customers.%'
    order by key`);
  check("the three duties the routes read are seeded as keys",
    duties.rows.map((r: any) => r.key).join(",") === "control.customers.manage,control.customers.verify,control.customers.view",
    JSON.stringify(duties.rows.map((r: any) => r.key)));
  const given = await owner.query(`select r.key as role, p.key from role_permissions rp
    join roles r on r.id = rp.role_id join permissions p on p.key = rp.permission_key
    where p.key like 'control.customers.%' and r.tenant_id is null order by r.key, p.key`);
  const seatsOf = (key: string) => given.rows.filter((r: any) => r.key === key).map((r: any) => r.role);
  check("…and answering a check is held by two roles, not by the whole office",
    sorted(seatsOf("control.customers.verify")) === "compliance_officer,super_admin",
    JSON.stringify(given.rows));
  check("…a support agent may label and note an account but cannot certify it",
    seatsOf("control.customers.manage").includes("customer_service_agent")
    && !seatsOf("control.customers.verify").includes("customer_service_agent"),
    JSON.stringify(seatsOf("control.customers.manage")));
  check("…the desk the nav shows is gated on a duty enough roles can hold",
    seatsOf("control.customers.view").length >= 3, seatsOf("control.customers.view"));

  // ---------- 8 · the numbers the desk prints ----------
  console.log(`\n--- 8 · what the desk is shown ---`);
  const notYet = await call("an approved licence for 2027 is not expired",
    `select platform_auth.customer_board($1::uuid, null, null, 'expired', null, 25, 0) as r`, [TEN]);
  check("…the chip reads nought over the probe's account, as it should, while the day is ahead",
    notYet?.facets?.checks?.expired === 0
    && !(notYet?.rows ?? []).some((r: any) => r.company_tenant_id === COMPANY),
    JSON.stringify(notYet?.facets?.checks));
  // An answer is frozen, so an expiry cannot be *made* by editing one. It arrives as a new line
  // approved against a day that has already gone — which is how the register itself does it.
  const lapsed = await mkCheck({ kind: "transport_licence", status: "approved", enc: BYTES,
    tail: "b7d1", expires: "2020-01-01", ago: 5, decided: ANSWER }, "a licence past its day");
  check("…the register will hold such a line", !!lapsed?.id, lapsed);
  const expired = await call("…and now the register sees it",
    `select platform_auth.customer_board($1::uuid, null, null, 'expired', null, 25, 0) as r`, [TEN]);
  check("…without the answer before it changing, which is kept",
    (expired?.rows ?? []).some((r: any) => r.company_tenant_id === COMPANY
      && r.checks?.expired === 1), JSON.stringify(expired?.rows?.[0]?.checks));
  check("…and the facet grew by exactly that one",
    expired?.facets?.checks?.expired === (notYet?.facets?.checks?.expired ?? 0) + 1,
    JSON.stringify({ was: notYet?.facets?.checks?.expired, now: expired?.facets?.checks?.expired }));
  const stillKept = await one(`select status, reference_tail,
      to_char(expires_on,'YYYY-MM-DD') as d
    from customer_verifications where id = $1`, [answered?.id]);
  check("…the answer that was signed is untouched: same status, tail and day",
    stillKept?.status === "approved" && stillKept?.reference_tail === "9f2c"
    && stillKept?.d === "2027-03-31", JSON.stringify(stillKept));
  const counts = await one(`select count(*)::int as lines,
      count(*) filter (where status = 'approved')::int as approved,
      count(*) filter (where status in ('awaiting','submitted'))::int as open,
      count(distinct kind)::int as kinds
    from customer_verifications where company_tenant_id = $1`, [COMPANY]);
  const dosChecks = (await call("the dossier and the table agree about the same account",
    `select platform_auth.customer_dossier($1::uuid, $2::uuid) as r`, [TEN, COMPANY]))?.checks;
  check(`…${counts?.lines} rows on the file, ${counts?.approved} approved, ${counts?.open} open, in both reads`,
    dosChecks?.length === counts?.lines
    && dosChecks.filter((c: any) => c.status === "approved").length === counts?.approved
    && dosChecks.filter((c: any) => ["awaiting", "submitted"].includes(c.status)).length === counts?.open,
    JSON.stringify({ table: counts, dossier: dosChecks?.length }));
  const boardCounts = (await call("the board agrees about the lines that stand",
    `select platform_auth.customer_board($1::uuid, 'Probe KYC', null, null, null, 25, 0) as r`,
    [TEN]))?.rows?.[0];
  check(`…its ${counts?.lines} rows are ${counts?.kinds} kinds, and the board counts kinds`,
    boardCounts?.checks?.lines === counts?.kinds && boardCounts?.checks?.expired === 1
    && counts?.kinds === 5, JSON.stringify({ board: boardCounts?.checks, table: counts }));
  const dosCounts = (dosChecks ?? []).filter((c: any) => c.is_current);
  check("…and the dossier's own current lines say the same thing the board does",
    dosCounts.length === counts?.kinds
    && dosCounts.filter((c: any) => c.status === "approved").length === 1,
    JSON.stringify(dosCounts.map((c: any) => [c.kind, c.status])));
  const trustAfter = await call("the trust read moved with the expiry and did not invent a number",
    `select platform_auth.customer_trust($1::uuid) as r`, [COMPANY]);
  check(`…from ${trust?.score} to ${trustAfter?.score}, band ${trustAfter?.band}`,
    trustAfter?.basis?.expired === 1 && trustAfter?.score !== trust?.score
    && (trustAfter?.factors ?? []).some((f: any) => f.points < 0 && /past its day/.test(f.label)),
    JSON.stringify(trustAfter?.factors));
  const sumAfter = (trustAfter?.factors ?? []).reduce((n: number, f: any) => n + (f.points ?? 0), 0);
  check("…re-added from its own factors, still",
    Math.max(0, Math.min(100, 50 + sumAfter)) === trustAfter?.score,
    JSON.stringify({ sum: sumAfter, score: trustAfter?.score }));
  const tlLapsed = await call("the story now holds the lapse as well as the answer",
    `select platform_auth.customer_timeline($1::uuid, 'verification', 40) as r`, [COMPANY]);
  check(`…${tlLapsed?.rows?.length} verification line(s), the approved ones among them`,
    (tlLapsed?.rows ?? []).some((r: any) => /approved/i.test(r.title)),
    JSON.stringify(tlLapsed?.rows?.slice(0, 4)?.map((r: any) => r.title)));

  await owner.query("rollback");
  const after = await one(LEDGER);
  console.log(`\n--- 9 · residue ---`);
  check("nothing is left behind", JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify({ before, after }));
  await owner.end();
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failed check(s)`);
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
