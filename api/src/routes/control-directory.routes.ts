import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import {
  EXPIRY_CANDIDATES_SQL, EXPIRY_LEDGER_SQL, runExpiryReminders, raiseExpiryReminder, SWEEP_LIMIT
} from "../util/expiry-reminders.js";

/**
 * The marketplace desk (131; task #343) — the marks a company earns, the hold that takes a card off
 * the board, and the two queues 061 left on a role test: seeker passes waiting for a money
 * reference, and listings waiting for a moderator's hand.
 *
 * Three things this file does not do, and each is a decision rather than an omission:
 *
 * **It never decides a hold on one seat's word.** A hold is a ban, so 121's rule applies to it in
 * full. `raise` writes the paper, `propose` puts it in front of a second seat with the subject, the
 * reason and the window hashed into the payload, and the signature is spent on `/control/approvals`
 * by a different person — `apply_directory_exclusion` runs there, inside that transaction, and
 * re-checks the precondition the claim already enforced. What this desk can do on its own is the
 * two directions that do not take a company out of trading: refusing its own paper, and lifting a
 * hold that has run its window. 121's rule guards the hand that stops a company, not the one that
 * lets it back.
 *
 * **It does not hide a mark by deleting it.** `moderate_rating` sets `hidden_at` and keeps the
 * stars, the author and the reason, because "we removed that review" is only answerable two years
 * later if the row is still there. A reason of at least eight characters is asked for on the way
 * *back* as well as the way out: a return with no reason is how a hidden mark comes back because
 * somebody remembered who wrote it.
 *
 * **It does not name a seeker.** The board carries `rater_name`, and 131 fills that column with
 * `a seeker on WAISHA` for every card-opened mark and the company's own name for a mark left by a
 * counterparty on a booked job. `rater_email` is on the board because 127 and 129 already settled
 * that a control reader may name the seat behind a row it is about — an identity number is the
 * column that stays sealed, and there is none here.
 *
 * The four routes 061 minted for passes and listings move here from `directory.routes.ts` and lose
 * `hasLicenceRole` on the way: 061 said out loud that it invented no key because its routes read
 * none. They read `control.directory.view` / `.moderate` now, which is what lets billing_admin keep
 * the pass confirmation it always did while holding no power to ban a company — the one thing on
 * this page a seat paid to move money should not have.
 */

const VIEW = "control.directory.view";
const MODERATE = "control.directory.moderate";
const EXCLUSION = "control.directory.exclusion";
const REMIND = "control.directory.remind";

const SENTENCE = z.string().trim().min(8).max(600);
const LIMIT = z.coerce.number().int().min(1).max(100).default(30);
const OFFSET = z.coerce.number().int().min(0).max(5000).default(0);
const SEARCH = z.string().trim().max(140).optional();
const UUID = z.string().uuid();

/** 131's own states, spelled the way the reader tests them. A word outside this list is refused
 *  here rather than reaching the definer, where it would answer as an empty board and look like a
 *  register with nothing on it. */
const MARK_STATES = ["all", "live", "answered", "replied", "hidden", "withdrawn"] as const;
const HOLD_STATES = ["all", "live", "running", "waiting", "raised", "lifted", "refused"] as const;
const SUBJECTS = ["company", "vehicle", "driver"] as const;
/** 144's own words, spelled as the board tests them. A state outside this list would reach the
 *  ledger as an empty page and read like an empty register, which is 131's argument restated. */
const EXPIRY_STATES = ["all", "told", "waiting", "past"] as const;
const EXPIRY_SUBJECTS = ["vehicle", "driver", "licence", "company"] as const;
/** The nine papers the register keeps a date for — the same list the table's CHECK holds, so a
 *  word the ledger cannot file is refused at the door rather than by a constraint. */
const EXPIRY_DOCUMENTS = ["insurance", "inspection", "road_licence", "licence", "regulatory_tra",
  "regulatory_brela", "regulatory_tpa", "regulatory_other", "transport_licence"] as const;
const EXPIRY_RUNGS = [30, 14, 7] as const;
/** 121's vocabulary, unchanged, so the word a desk picks for a hold is the word the ban register
 *  already uses for the same conduct. */
const REASONS = ["terms_violation", "long_idle", "payment_default", "abuse", "complaint",
  "security", "other"] as const;

function uuidOf(value: unknown, what: string): string {
  const r = UUID.safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
const uaOf = (req: any) => String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null;

/**
 * The five shapes 131's doors answer in, mapped once. A definer's sentence is the only thing a
 * clerk acting on a hold will ever read, so the words go out unchanged and only the HTTP code is
 * chosen here. `conflict` is a 409 rather than a 400 because every one of them is "the register
 * moved under you" — a paper already signed, a mark already answered, a hold already running.
 */
function definerRefusal(j: any, fallback: string): ApiError | null {
  if (!j || typeof j !== "object") return null;
  if (j.status === "ok") return null;
  if (j.status === "not_found") {
    return new ApiError("NOT_FOUND",
      String(j.message ?? "That row is not on the register."), 404);
  }
  if (j.status === "unauthorised") {
    return new ApiError("FORBIDDEN",
      String(j.message ?? "This seat is not the one that row is about."), 403);
  }
  if (j.status === "invalid") {
    return new ApiError("VALIDATION_FAILED", String(j.message ?? fallback), 400,
      [{ field: j.field ?? "reason", message: String(j.message ?? fallback) }]);
  }
  if (j.status === "conflict") {
    // 144's five refusals are the same HTTP act with five different reasons, and the desk needs the
    // reason as a word rather than as a sentence it has to re-read: "warned at every rung", "the
    // renewal is already recorded", "not due yet" each close a panel differently.
    const expiry = j.already_warned ? "already_warned"
      : j.paper_moved ? "paper_moved"
      : j.expired ? "expired"
      : j.not_due ? "not_due"
      : j.due_rung !== undefined && j.due_rung !== null ? "due_rung"
      : j.tenant_status ? "tenant_status" : null;
    return new ApiError("CONFLICT", String(j.message ?? fallback), 409, [
      ...(j.open_id ? [{ reason: "signature_open", approvalId: j.open_id }] : []),
      ...(j.exclusion_status ? [{ reason: "paper_finished", state: j.exclusion_status }] : []),
      ...(expiry ? [{ reason: expiry, dueRung: j.due_rung ?? null, daysLeft: j.days_left ?? null,
        tenantStatus: j.tenant_status ?? null, expiryDate: j.expiry_date ?? null }] : [])
    ]);
  }
  return new ApiError("UPSTREAM_ERROR",
    String(j.message ?? "The register gave an answer this desk cannot read."), 502);
}

/**
 * 131's guards refuse with P0001 (a subject the register cannot name) and 23514 (a paper without a
 * second signature, a window moved under a hold, a held card pressed back to live). None of them is
 * a server fault and each sentence was written for the person at the desk, so the words go through
 * with only the table's name taken off the front. A 23505 is the one live hold per subject, and the
 * desk needs to hear it as "this company is already held", not as an index name.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (code === "23505") {
    return new ApiError("CONFLICT",
      "That subject is already held, or a signature for this paper is already open.", 409);
  }
  if (!["23514", "23503", "P0001", "42501"].includes(code)) return null;
  const raw = String((err as any)?.message ?? "");
  if (/violates (?:check|not-null|foreign key) constraint/.test(raw)) {
    return new ApiError("CONFLICT", fallback, 409);
  }
  const line = raw.split("\n")[0]
    .replace(/^(directory_exclusions|directory_ratings|directory_listings):\s*/i, "");
  return new ApiError("CONFLICT", line || fallback, 409);
}

// ---------- the two registers ----------

const MARKS_SQL = "select platform_auth.directory_ratings_board($1,$2,$3,$4) as b";
const HOLDS_SQL = "select platform_auth.directory_exclusions_board($1,$2,$3,$4,$5) as b";
const HOLD_SQL = "select platform_auth.directory_exclusion_detail($1) as d";
const HELD_SQL = "select platform_auth.directory_subject_is_held($1,$2) as h";

/** The board answers one page and the counts that page sits inside; a desk that cannot see the
 *  counts cannot tell "nothing matched" from "this is the first of four hundred". */
async function board(sql: string, params: unknown[]): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(sql, params);
  return (rows[0]?.b ?? { rows: [], counts: {} }) as Record<string, unknown>;
}

/** A register walked a page at a time, so an export carries the whole filtered queue and not the
 *  thirty rows a screen asked for. Both boards cap their own page at 100. */
async function walk(sql: string, params: (offset: number) => unknown[]):
  Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 3000; offset += 100) {
    const page = ((await board(sql, params(offset))).rows ?? []) as Record<string, unknown>[];
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // A reason and a note are typed by whoever sat at the desk, and a cell that starts with an
  // operator is a formula the moment the CSV reaches a spreadsheet.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** A column name is this file's own word, not a value somebody typed, so it is written bare. */
const csvHead = (h: string) => (/[",\r\n]/.test(h) ? csvCell(h) : h);

const csv = (head: string[], rows: Record<string, unknown>[]): string => [
  head.map(csvHead).join(","),
  ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))
].join("\r\n");

/** A timestamp as the desk reads it off the register, and a day where a day is all there is. */
const stamp = (v: unknown) => (v ? new Date(String(v)).toISOString() : "");

export async function controlDirectoryRoutes(app: FastifyInstance, _opts: unknown) {

  // ============================
  // THE MARKS — who was answered, who was not
  // ============================

  app.get("/control/directory/ratings", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const q = z.object({
      state: z.enum(MARK_STATES).default("all"),
      q: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return board(MARKS_SQL, [q.state, q.q ?? null, q.limit, q.offset]);
  });

  // The office's hand on a mark: off the board, or back on it. Both need the sentence, and the
  // second one needs it too — 131 wrote that rule into the definer, so this route only has to
  // carry the words and the seat.
  app.post("/control/directory/ratings/:id/moderate",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MODERATE);
      await enforceRateLimit(`dir-rating-moderate:${req.control.user_id}`, 30, 3600);
      const id = uuidOf(req.params.id, "mark");
      const body = z.object({
        action: z.enum(["hide", "unhide"]),
        reason: SENTENCE
      }).strict().parse(req.body);
      const { rows } = await pool.query(
        "select platform_auth.moderate_rating($1,$2,$3,$4,$5,$6) as j",
        [id, body.action, body.reason, req.control.user_id, role(req), req.ip]);
      const j = rows[0]?.j;
      const refusal = definerRefusal(j, "The mark could not be moved.");
      if (refusal) throw refusal;
      return j;
    });

  // ============================
  // THE HOLDS — one dated paper per subject, signed by two seats
  // ============================

  app.get("/control/directory/exclusions", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const q = z.object({
      state: z.enum(HOLD_STATES).default("all"),
      kind: z.enum(SUBJECTS).optional(),
      q: SEARCH,
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return board(HOLDS_SQL,
      [q.state, q.kind ?? null, q.q ?? null, q.limit, q.offset]);
  });

  /**
   * One paper, whole: the row, the signature it stands on, the card it is holding down, what the
   * company's marks look like now, and the other holds this account has been under.
   *
   * The last of those is why the read is one call rather than three. A desk asked "have we held
   * this company before" needs the answer on the same screen it is deciding on, and 126's lesson
   * applies to a register: the history has to be beside the decision, not one more click away
   * from it.
   */
  app.get("/control/directory/exclusions/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const id = uuidOf(req.params.id, "hold");
    const { rows } = await pool.query(HOLD_SQL, [id]);
    const d = rows[0]?.d;
    if (!d) throw new ApiError("NOT_FOUND", "No hold under that reference.", 404);
    return d;
  });

  /**
   * Is this subject held right now? The vehicle and driver screens need the same answer as the
   * register row, and a second query that can arrive a moment after the list it annotates is how a
   * desk ends up showing a plate as free while a hold runs on it. One statement, one read.
   */
  app.get("/control/directory/held", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const q = z.object({
      kind: z.enum(SUBJECTS),
      id: UUID
    }).strict().parse(req.query);
    const { rows } = await pool.query(HELD_SQL, [q.kind, q.id]);
    return { held: rows[0]?.h ?? null };
  });

  /**
   * Write the paper. Nothing about the subject is typed here beyond its kind and its id: the
   * trigger reads the name, the plate or the class, the account it stands on and the card it
   * trades under out of the tables that hold them, so a mistyped id is refused by the register
   * rather than filed against the wrong vehicle.
   *
   * The picker for a vehicle or a driver arrives with 132's registry reads; until then this is the
   * one door a desk reaches with an id it copied from somewhere else, and the sentence it has to
   * write is the reason that stays on the paper.
   */
  app.post("/control/directory/exclusions", { preHandler: [requireControl] },
    async (req: any, reply) => {
      await requireControlPermission(req, EXCLUSION);
      await enforceRateLimit(`dir-exclusion-raise:${req.control.user_id}`, 12, 3600);
      const body = z.object({
        subjectKind: z.enum(SUBJECTS),
        subjectId: UUID,
        reasonCode: z.enum(REASONS),
        // Two sentences, because 121 found they are not the same words: one is what the second
        // seat signs, the other is what the company is told.
        reason: SENTENCE,
        note: SENTENCE,
        days: z.number().int().min(1).max(1095)
      }).strict().parse(req.body);

      let j: any;
      try {
        const { rows } = await pool.query(
          "select platform_auth.raise_directory_exclusion($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as j",
          [body.subjectKind, body.subjectId, body.reasonCode, body.reason, body.note, body.days,
           req.control.user_id, role(req), req.ip, uaOf(req)]);
        j = rows[0]?.j;
      } catch (e) {
        const refusal = guardRefusal(e, "The hold could not be raised.");
        if (refusal) throw refusal;
        throw e;
      }
      const refusal = definerRefusal(j, "The hold could not be raised.");
      if (refusal) throw refusal;
      return reply.code(201).send({ ...j, days: body.days, reason_code: body.reasonCode });
    });

  /**
   * Ask a second seat to sign the hold.
   *
   * `propose_directory_exclusion` reads the subject, the reason and the window out of the row and
   * hashes what it read, so the bytes the second seat signs are provably this paper — a window
   * cannot be retyped into a body beside a fresh id on the way to approval. The paper moves to
   * `pending_signature` and nothing happens to the company until the signature is spent on
   * `/control/approvals`, where `apply_directory_exclusion` replays the window from the payload.
   */
  app.post("/control/directory/exclusions/:id/signature", { preHandler: [requireControl] },
    async (req: any, reply) => {
      await requireControlPermission(req, EXCLUSION);
      await enforceRateLimit(`dir-exclusion-propose:${req.control.user_id}`, 12, 3600);
      const id = uuidOf(req.params.id, "hold");
      const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
      let j: any;
      try {
        const { rows } = await pool.query(
          "select platform_auth.propose_directory_exclusion($1,$2,$3,$4,$5,$6) as j",
          [id, body.reason, req.control.user_id, role(req), req.ip, uaOf(req)]);
        j = rows[0]?.j;
      } catch (e) {
        const refusal = guardRefusal(e, "The signature could not be asked for.");
        if (refusal) throw refusal;
        throw e;
      }
      const refusal = definerRefusal(j, "The signature could not be asked for.");
      if (refusal) throw refusal;
      return reply.code(201).send(j);
    });

  // Put the paper down. One seat, because nothing is taken away from anybody by a refusal — and a
  // lapsed or refused signature does not close the paper out, so re-asking stays possible.
  app.post("/control/directory/exclusions/:id/refuse", { preHandler: [requireControl] },
    async (req: any) => {
      await requireControlPermission(req, EXCLUSION);
      await enforceRateLimit(`dir-exclusion-refuse:${req.control.user_id}`, 20, 3600);
      const id = uuidOf(req.params.id, "hold");
      const body = z.object({ note: SENTENCE }).strict().parse(req.body);
      const { rows } = await pool.query(
        "select platform_auth.refuse_directory_exclusion($1,$2,$3,$4,$5,$6) as j",
        [id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
      const j = rows[0]?.j;
      const refusal = definerRefusal(j, "The paper could not be put down.");
      if (refusal) throw refusal;
      return j;
    });

  /**
   * Lift a running hold. One seat is enough — 121's rule guards the hand that stops a company
   * trading, not the one that lets it back, which is how 078's unblock has always worked.
   *
   * The answer says whether the card came back. It does not always: if another hold still runs on
   * the account, or the licence gate has since closed it, the paper leaves the register and the
   * card stays down with the other reason restated on it. A desk that was promised "restored" both
   * times would press reinstate and read the refusal as a bug.
   */
  app.post("/control/directory/exclusions/:id/lift", { preHandler: [requireControl] },
    async (req: any) => {
      await requireControlPermission(req, EXCLUSION);
      await enforceRateLimit(`dir-exclusion-lift:${req.control.user_id}`, 20, 3600);
      const id = uuidOf(req.params.id, "hold");
      const body = z.object({ note: SENTENCE }).strict().parse(req.body);
      const { rows } = await pool.query(
        "select platform_auth.lift_directory_exclusion($1,$2,$3,$4,$5,$6) as j",
        [id, body.note, req.control.user_id, role(req), req.ip, uaOf(req)]);
      const j = rows[0]?.j;
      const refusal = definerRefusal(j, "The hold could not be lifted.");
      if (refusal) throw refusal;
      return j;
    });

  // ============================
  // THE PAPER WARNINGS — 144's ledger of what a company was told about a date
  // ============================

  /**
   * What is owed a warning today. The list comes from the same definer the clock reads, and the
   * rung on each row is the rung `expiry_rung_due` picked, so the desk is looking at the register's
   * own next step rather than at a second copy of the ladder that could disagree with it.
   */
  app.get("/control/directory/expiry/due", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .strict().parse(req.query);
    const { rows } = await pool.query(EXPIRY_CANDIDATES_SQL, [q.limit]);
    return rows[0]?.c ?? { due: 0, rows: [] };
  });

  /**
   * The ledger. Three states and what each one means to a clerk: `told` is evidence the company was
   * reached, `waiting` is a warning raised whose send has not yet landed, and `past` is the honest
   * record of a notice that never arrived and whose date has gone by.
   *
   * `paper_still_says_so` is the column that keeps the board from lying after a renewal: a warning
   * filed against 19 Nov stays on the ledger when the paper now reads 19 Nov next year, and the row
   * says which date the register holds today.
   */
  app.get("/control/directory/expiry/ledger", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const q = z.object({
      state: z.enum(EXPIRY_STATES).default("all"),
      kind: z.enum(EXPIRY_SUBJECTS).optional(),
      limit: LIMIT,
      offset: OFFSET
    }).strict().parse(req.query);
    return board(EXPIRY_LEDGER_SQL, [q.state, q.kind ?? null, q.limit, q.offset]);
  });

  /**
   * Warn now, rather than waiting for the clock.
   *
   * The desk names the paper and the rung; the register resolves the live date, the days left, the
   * words and the recipients. Nothing here can put a sentence into the notice — that is 144's point,
   * and it is why the route takes no `message` field. The recipient list the definer returns is
   * dropped before the answer reaches the browser; what comes back is the masked receipt.
   */
  app.post("/control/directory/expiry/remind", { preHandler: [requireControl] },
    async (req: any) => {
      await requireControlPermission(req, REMIND);
      await enforceRateLimit(`dir-remind:${req.control.user_id}`, 20, 3600);
      const body = z.object({
        subject_kind: z.enum(EXPIRY_SUBJECTS),
        subject_id: UUID,
        document_kind: z.enum(EXPIRY_DOCUMENTS),
        threshold_days: z.number().int().refine(
          (v) => (EXPIRY_RUNGS as readonly number[]).includes(v),
          "A warning is raised at 30, 14 or 7 days."),
        expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
      }).strict().parse(req.body);

      const { result, receipt } = await raiseExpiryReminder({
        subjectKind: body.subject_kind, subjectId: body.subject_id,
        documentKind: body.document_kind, thresholdDays: body.threshold_days,
        expiryDate: body.expiry_date ?? null,
        actorKind: "control", actorUserId: req.control.user_id,
        actorRole: role(req), actorIp: req.ip
      });
      const refusal = definerRefusal(result, "The warning could not be raised.");
      if (refusal) throw refusal;
      return { ...result, receipt };
    });

  /**
   * Run the paper clock now over the whole due list. The same function the six-hour interval calls,
   * so a press cannot apply a rule the timer would not. Capped at three an hour because each pass
   * sends real messages on two channels to real directors.
   */
  app.post("/control/directory/expiry/sweep", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, REMIND);
    await enforceRateLimit(`dir-expiry-sweep:${req.control.user_id}`, 3, 3600);
    const body = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .strict().parse(req.body ?? {});
    return runExpiryReminders(body.limit ?? SWEEP_LIMIT);
  });

  // ============================
  // THE PASSES AND THE LISTINGS — 061's two queues, on duties
  // ============================

  app.get("/control/directory/passes", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const { rows } = await pool.query("select * from platform_auth.list_pending_passes()");
    return rows;
  });

  // The week is re-based on the approval instant inside the definer, because the money usually
  // lands a day after the reference was typed.
  app.post("/control/directory/passes/:id/verify",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MODERATE);
      await enforceRateLimit(`pass-verify:uid:${req.control.user_id}`, 60, 3600);
      const passId = uuidOf(req.params.id, "search pass");
      const body = z.object({
        approve: z.boolean(),
        note: z.string().trim().max(400).optional()
      }).strict().parse(req.body);

      const { rows } = await pool.query(
        "select platform_auth.verify_search_pass($1,$2,$3,$4) as r",
        [passId, req.control.user_id, body.approve, body.note ?? null]);
      const res = rows[0]?.r ?? {};
      if (res.status === "not_found") throw new ApiError("NOT_FOUND", "Pass not found", 404);
      if (res.status === "conflict") {
        throw new ApiError("PASS_NOT_PENDING", String(res.reason), 409,
          [{ currentStatus: res.current_status }]);
      }
      return res;
    });

  app.get("/control/directory/listings", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const q = ((req.query as any)?.q ?? "").toString().trim();
    const { rows } = await pool.query(
      "select * from platform_auth.list_directory_for_control($1)", [q || null]);
    return rows;
  });

  /**
   * Suspend, reinstate, verify, unverify — the four hands 061 gave the office.
   *
   * `held` is the answer a desk needs most and the one that was not available before 131: pressing
   * reinstate on a card a signed exclusion holds is refused by the trigger, and the definer now
   * says so as a status rather than raising. It goes back as a 409 carrying the paper's own number
   * and its end date, because the way out is the hold, not the button.
   */
  app.post("/control/directory/listings/:id/moderate",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MODERATE);
      await enforceRateLimit(`listing-moderate:uid:${req.control.user_id}`, 60, 3600);
      const listingId = uuidOf(req.params.id, "listing");
      const body = z.object({
        action: z.enum(["suspend", "reinstate", "verify", "unverify"]),
        note: z.string().trim().max(400).optional()
      }).strict().parse(req.body);

      const { rows } = await pool.query(
        "select platform_auth.moderate_listing($1,$2,$3,$4) as r",
        [listingId, req.control.user_id, body.action, body.note ?? null]);
      const res = rows[0]?.r ?? {};
      if (res.status === "not_found") throw new ApiError("NOT_FOUND", "Listing not found", 404);
      if (res.status === "invalid") {
        throw new ApiError("VALIDATION_FAILED", String(res.reason), 400,
          [{ field: body.action === "suspend" ? "note" : "action" }]);
      }
      if (res.status === "held") {
        throw new ApiError("LISTING_HELD",
          String(res.reason ?? "A signed exclusion is holding this card off the board."), 409,
          [{ reason: "held", ref: res.ref ?? null, endsAt: res.ends_at ?? null,
             reasonCode: res.reason_code ?? null }]);
      }
      return res;
    });

  // ============================
  // THE TWO REGISTERS, AS FILES
  // ============================

  /**
   * Both registers, flattened. A mark is exported with both names and the answer's author because
   * the question a CSV is asked to answer is "who is being answered and who is being ignored"; a
   * hold is exported with the signature's state and the window, which are the three things a desk
   * needs to check the paper still holds.
   */
  app.get("/control/directory/export", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, VIEW);
    const q = z.object({
      register: z.enum(["ratings", "exclusions"]),
      state: z.string().trim().max(20).optional(),
      kind: z.string().trim().max(20).optional(),
      q: SEARCH
    }).strict().parse(req.query);

    const state = q.state && (q.register === "ratings"
      ? (MARK_STATES as readonly string[]).includes(q.state)
      : (HOLD_STATES as readonly string[]).includes(q.state)) ? q.state : "all";

    let head: string[];
    let rows: Record<string, unknown>[];
    if (q.register === "ratings") {
      head = ["listed_name", "stars", "comment", "basis", "rater_name", "rater_kind",
        "rater_email", "created_at", "reply", "replied_name", "replied_at",
        "hidden_at", "hidden_name", "hidden_reason", "withdrawn_at"];
      rows = (await walk(MARKS_SQL,
        (offset) => [state, q.q ?? null, 100, offset])).map((r) => ({
        ...r,
        created_at: stamp(r.created_at), replied_at: stamp(r.replied_at),
        hidden_at: stamp(r.hidden_at), withdrawn_at: stamp(r.withdrawn_at)
      }));
    } else {
      head = ["ref", "subject_kind", "subject_name", "subject_label", "company_name",
        "reason_code", "reason", "note", "days", "exclusion_status", "raised_name", "raised_at",
        "approval_status", "signed_name", "starts_at", "ends_at", "days_left",
        "lifted_name", "lifted_at", "lifted_note", "refused_name", "refused_at", "refused_note"];
      const kind = (SUBJECTS as readonly string[]).includes(q.kind ?? "") ? q.kind : null;
      rows = (await walk(HOLDS_SQL,
        (offset) => [state, kind, q.q ?? null, 100, offset])).map((r) => ({
        ...r,
        raised_at: stamp(r.raised_at), starts_at: stamp(r.starts_at),
        ends_at: stamp(r.ends_at), lifted_at: stamp(r.lifted_at),
        refused_at: stamp(r.refused_at)
      }));
    }
    reply.header("Content-Disposition",
      `attachment; filename="directory-${q.register}-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.type("text/csv; charset=utf-8");
    return csv(head, rows);
  });
}
