import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { sniffFileType } from "../util/upload.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission, controlHolds } from "./control-analytics.routes.js";
import { sanitizeFileName } from "./documents.routes.js";
import {
  storageConfigured, putObject, getObject, StorageUnavailableError
} from "../storage/supabase.js";

/**
 * The Service desk (126; task #341) — what the office does *after* a call is settled.
 *
 * 101 wrote the calls down, 123 gave the desks a week and two promises, 125 made the book one
 * inbox. Four things the spec's Service module asks for did not exist and are what this file
 * serves: a dispute a caller can be quoted a number for, the satisfaction question asked after
 * the desk has finished the work, a mark on how a call was handled that the graded seat can
 * answer once, and a refund paper that cannot be released by the hand that wrote it.
 *
 * The same division of labour the tickets register runs on. Every state rule is in the table —
 * `dispute_is_upheld_on_paper` refuses a finding with nothing filed on it, `dispute_settles_on_its_figure`
 * refuses a settled line whose paper says a different number, `quality_mark_is_read_from_its_checks`
 * works the mark out of six ticks, `refund_release_needs_two_seats` refuses a release without a
 * second seat's signature. What the route adds is the sentence, the duty and the rate limit —
 * never a check the schema already makes, because a check in two places is two checks that drift.
 * So a guard exception is passed through as a 409 in the trigger's own words rather than
 * re-derived here.
 *
 * Money goes through 121's register and nowhere else. This desk can raise a paper and ask for a
 * signature (`propose_refund_release`, whose payload is read out of the row so the signed bytes
 * provably are the paper) and refuse one (`decline_refund`). Releasing it is not a door on this
 * file at all: it is the second seat pressing "sign" on `/control/approvals`, which spends the
 * signature and calls `apply_refund_release` in the same transaction. A desk that could both
 * write and release a refund would be the thing the office's own rule exists to prevent.
 *
 * The register is platform-owned, exactly as 101's is: `req.control.tenant_id` is the platform
 * tenant, and the company a paper is about is kept beside it in `company_tenant_id`/`company_name`
 * — copied off the call by a trigger, never typed. Nothing here selects a caller's phone number:
 * the dispute names the incidence, and the incidence is where the PII lives.
 */

const VIEW = "control.service.view";
const MANAGE = "control.service.manage";
const REVIEW = "control.service.review";
/**
 * The money duty 126 points at instead of inventing one: asking a second seat to sign a figure
 * is the same act the payments desk has always charged `control.payments.manage` for (005).
 */
const PAYMENTS = "control.payments.manage";
/**
 * The second-seat duty 121 charges for signing a money paper. The desk's refusal of a paper
 * somebody has already been asked to sign is that same signature's other answer, so it is charged
 * the same key — see the decline route.
 */
const DECIDE = "control.approvals.decide";

const GROUNDS = ["wrong_advice", "missed_promise", "unanswered_call", "fee_dispute",
  "overcharge", "lost_paperwork", "discourtesy", "other"] as const;
const DISPUTE_STATUSES = ["open", "investigating", "upheld", "rejected", "settled",
  "withdrawn"] as const;
/** The four moves that end the argument. Each one needs a finding in writing, which is the
 *  table's CHECK, and the route asks for the same sentence before it tries. */
const DECIDED = ["upheld", "rejected", "settled", "withdrawn"] as const;
const CURRENCIES = ["TZS", "USD"] as const;
const PAY_BACK = ["original_channel", "mpesa", "telwa", "airtel", "bank", "credit_note"] as const;
const REFUND_STATUSES = ["raised", "pending_signature", "released", "declined", "void"] as const;
const ASKED_CHANNELS = ["phone_call", "whatsapp", "email", "walk_in", "other"] as const;
const CHECK_KEYS = ["answered_the_caller", "identity_confirmed", "right_desk", "action_offered",
  "words_suitable", "settled_with_answer"] as const;
const RESULTS = ["met", "partly_met", "below"] as const;
const REGISTERS = ["disputes", "refunds", "satisfaction", "quality"] as const;

const REASON = z.string().trim().min(4).max(300);
/** 8-2000, the same band `service_disputes.outcome` is checked against. */
const OUTCOME = z.string().trim().min(8).max(2000);
/** 8-600, the band the refund paper's own reason and the two seat's sentence are checked against. */
const SENTENCE = z.string().trim().min(8).max(600);
const LIMIT = z.coerce.number().int().min(1).max(200).default(60);
const OFFSET = z.coerce.number().int().min(0).default(0);
const SEARCH = z.string().trim().max(140).optional();
const MONEY = z.coerce.number().gt(0).max(10000000000);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/** numeric(14,2) is exact money, so the figure is sent as a decimal string, never as a float. */
const money = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

function uuidOf(value: unknown, what: string): string {
  const r = z.string().uuid().safeParse(value);
  if (!r.success) throw new ApiError("VALIDATION_FAILED", `That is not ${what}.`, 400);
  return r.data;
}

/**
 * The guards in 126 refuse with 23514 (a row that is not allowed to exist), 23503 (a pointer at
 * a line that is not on the register) and P0001 (a definer that answered `conflict`). None of the
 * three is a server fault, and each sentence was written for the person at the desk — the paper
 * guard names the finding it wants filed, the figure guard names both numbers. So the words go
 * through as a 409 and only the table's own name comes off the front.
 */
function guardRefusal(err: unknown, fallback: string): ApiError | null {
  const code = String((err as any)?.code ?? "");
  if (!["23514", "23503", "22023", "P0001", "42501"].includes(code)) return null;
  const line = String((err as any)?.message ?? "").split("\n")[0]
    .replace(/^(service_disputes|service_dispute_events|service_refund_requests|service_satisfaction|service_quality_reviews|documents|platform_approvals):\s*/i, "");
  return new ApiError("CONFLICT", line || fallback, 409);
}

// ---------- the calls the papers stand on ----------

/** One call, enough to name it and to say whether it is finished. Params: id, tenant. */
const CALL_SQL = `
  select t.id, t.ref, t.status, t.channel, t.subject, t.company_name, t.company_tenant_id,
         t.dept_ref, t.ts, t.resolved_at, t.resolution, t.deleted_at
    from support_tickets t
   where t.id = $1 and t.tenant_id = $2`;

/** The picker a dispute is opened from. Params: tenant, search. No phone, no email: a search box
 *  on a service desk matches the incidence number, the subject and the company. */
const CALLS_SQL = `
  select t.id, t.ref, t.subject, t.status, t.channel, t.company_name, t.dept_ref, t.ts,
         (select count(*)::int from service_disputes d
           where d.ticket_id = t.id and d.deleted_at is null) as disputes,
         (select count(*)::int from service_satisfaction c where c.ticket_id = t.id) as asked,
         (select count(*)::int from service_quality_reviews q where q.ticket_id = t.id) as marks
    from support_tickets t
   where t.tenant_id = $1 and t.deleted_at is null
     and ($2::text is null or t.ref ilike '%' || $2 || '%'
          or t.subject ilike '%' || $2 || '%'
          or t.company_name ilike '%' || $2 || '%')
   order by t.ts desc
   limit 25`;

/** The platform seats a call can be graded against. Params: tenant. */
const SEATS_SQL = `
  select u.id, u.full_name, coalesce(a.roles, '{}') as roles
    from users u
    left join lateral (
      select array_agg(r.key order by r.key) as roles
        from user_roles ur
        join roles r on r.id = ur.role_id
       where ur.user_id = u.id and r.tenant_id is null and r.deleted_at is null
         and (ur.expires_at is null or ur.expires_at > now())
    ) a on true
   where u.tenant_id = $1 and u.deleted_at is null and u.status = 'active'
   order by u.full_name
   limit 200`;

// ---------- the dispute register ----------

/** Params: ticket, ground, claim, amount|null, currency|null, company tenant|null, company,
 *  actor. The ref, the incidence number and the register's tenant are the table's business —
 *  `service_disputes_number` is a sequence and two triggers copy the rest. */
const INSERT_DISPUTE_SQL = `
  insert into service_disputes (ref, ticket_id, ticket_ref, ground, claim, amount, currency,
      company_tenant_id, company_name, status, opened_by)
  values (
    'DP-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('service_dispute_number_seq')::text, 5, '0'),
    $1, '', $2, $3, $4::numeric, $5, $6, $7, 'open', $8
  )
  returning id, ref, ticket_id, ticket_ref, ground, claim, amount, currency, status,
            company_name, company_tenant_id, opened_at`;

/** Params: dispute, tenant. */
const DISPUTE_SQL = `
  select s.id, s.ref, s.ground, s.claim, s.amount, s.currency, s.status, s.outcome,
         s.ticket_id, s.ticket_ref, s.company_name, s.company_tenant_id,
         s.opened_at, s.decided_at, s.refund_request_id,
         ou.full_name as opened_name, du.full_name as decided_name,
         r.ref as refund_ref, r.amount as refund_amount, r.currency as refund_currency,
         r.status as refund_status, r.pay_back as refund_pay_back,
         t.status as ticket_status, t.subject as ticket_subject, t.channel as ticket_channel,
         t.dept_ref as ticket_dept_ref, t.resolved_at as ticket_resolved_at,
         d.name as department_name,
         coalesce((select jsonb_agg(json_build_object(
             'id', f.id, 'file_name', f.file_name, 'mime_type', f.mime_type,
             'size_bytes', f.size_bytes, 'created_at', f.created_at,
             'uploaded_name', uu.full_name) order by f.created_at desc)
           from documents f
           left join users uu on uu.id = f.uploaded_by
          where f.tenant_id = s.tenant_id and f.entity_type = 'service_dispute'
            and f.entity_id = s.id and f.deleted_at is null), '[]'::jsonb) as files,
         coalesce((select jsonb_agg(json_build_object(
             'id', q.id, 'ref', q.ref, 'amount', q.amount, 'currency', q.currency,
             'pay_back', q.pay_back, 'request_status', q.status, 'raised_at', q.raised_at,
             'raised_name', ru.full_name) order by q.raised_at desc)
           from service_refund_requests q
           left join users ru on ru.id = q.raised_by
          where q.tenant_id = s.tenant_id and q.dispute_id = s.id), '[]'::jsonb) as papers
    from service_disputes s
    left join service_refund_requests r on r.id = s.refund_request_id
    left join support_tickets t on t.id = s.ticket_id
    left join platform_departments d on d.id = t.department_id
    left join users ou on ou.id = s.opened_by
    left join users du on du.id = s.decided_by
   where s.id = $1 and s.tenant_id = $2 and s.deleted_at is null`;

/** Params: tenant, status|null, ground|null, search|null, limit, offset. */
const DISPUTES_SQL = `
  select s.id, s.ref, s.ground, s.claim, s.amount, s.currency, s.status, s.outcome,
         s.ticket_id, s.ticket_ref, s.company_name, s.opened_at, s.decided_at,
         s.refund_request_id,
         ou.full_name as opened_name, du.full_name as decided_name,
         r.ref as refund_ref, r.status as refund_status,
         f.n as papers, e.n as lines,
         count(*) over ()::int as total
    from service_disputes s
    left join service_refund_requests r on r.id = s.refund_request_id
    left join users ou on ou.id = s.opened_by
    left join users du on du.id = s.decided_by
    cross join lateral (
      select count(*)::int as n from documents d
       where d.tenant_id = s.tenant_id and d.entity_type = 'service_dispute'
         and d.entity_id = s.id and d.deleted_at is null
    ) f
    cross join lateral (
      select count(*)::int as n from service_dispute_events q
       where q.tenant_id = s.tenant_id and q.dispute_id = s.id
    ) e
   where s.tenant_id = $1 and s.deleted_at is null
     and ($2::text is null or s.status = $2)
     and ($3::text is null or s.ground = $3)
     and ($4::text is null or s.ref ilike '%' || $4 || '%'
          or s.ticket_ref ilike '%' || $4 || '%'
          or s.company_name ilike '%' || $4 || '%'
          or s.claim ilike '%' || $4 || '%')
   order by s.opened_at desc
   limit $5 offset $6`;

/** Params: tenant. */
const DISPUTE_COUNTS_SQL = `
  select count(*)::int as total,
         count(*) filter (where s.status = 'open')::int as open,
         count(*) filter (where s.status = 'investigating')::int as investigating,
         count(*) filter (where s.status = 'upheld')::int as upheld,
         count(*) filter (where s.status = 'rejected')::int as rejected,
         count(*) filter (where s.status = 'settled')::int as settled,
         count(*) filter (where s.status = 'withdrawn')::int as withdrawn,
         count(*) filter (where s.status in ('open','investigating')
                          and coalesce(f.n, 0) = 0)::int as awaiting_paper,
         count(*) filter (where s.status in ('open','investigating')
                          and s.amount is not null
                          and s.refund_request_id is null)::int as awaiting_refund,
         coalesce(sum(s.amount) filter (where s.currency = 'TZS'
             and s.status in ('open','investigating','upheld','settled')), 0)::text as claimed_tzs,
         coalesce(sum(s.amount) filter (where s.currency = 'USD'
             and s.status in ('open','investigating','upheld','settled')), 0)::text as claimed_usd
    from service_disputes s
    cross join lateral (
      select count(*)::int as n from documents d
       where d.tenant_id = s.tenant_id and d.entity_type = 'service_dispute'
         and d.entity_id = s.id and d.deleted_at is null
    ) f
   where s.tenant_id = $1 and s.deleted_at is null`;

/** Params: tenant, dispute, actor, role, ip, action, from, to, reason, detail. */
const INSERT_DISPUTE_EVENT_SQL = `
  insert into service_dispute_events (tenant_id, dispute_id, ref, actor_user_id, actor_role,
      ip, action, from_label, to_label, reason, detail)
  values ($1, $2,
          (select d.ref from service_disputes d where d.id = $2),
          $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
  returning id, action, ts`;

/** Params: tenant, dispute. */
const DISPUTE_EVENTS_SQL = `
  select e.id, e.ts, e.action, e.from_label, e.to_label, e.reason, e.detail,
         u.full_name as actor_name
    from service_dispute_events e
    left join users u on u.id = e.actor_user_id
   where e.tenant_id = $1 and e.dispute_id = $2
   order by e.ts`;

/** Params: dispute, tenant, to, outcome, actor. */
const MOVE_DISPUTE_SQL = `
  update service_disputes
     set status = $3,
         outcome = case when $3 in ('upheld','rejected','settled','withdrawn')
                        then coalesce($4, outcome) else outcome end,
         decided_by = case when $3 in ('upheld','rejected','settled','withdrawn')
                           then $5 else decided_by end,
         decided_at = case when $3 in ('upheld','rejected','settled','withdrawn')
                           then now() else decided_at end,
         updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
   returning id, ref, status, outcome, decided_at, updated_at`;

/** Params: dispute, tenant, paper. */
const LINK_DISPUTE_PAPER_SQL = `
  update service_disputes
     set refund_request_id = $3, updated_at = now()
   where id = $1 and tenant_id = $2 and deleted_at is null
     and refund_request_id is null
   returning id, ref, refund_request_id`;

// ---------- the paper on a dispute ----------

/** Params: tenant, dispute. */
const DISPUTE_FILES_SQL = `
  select f.id, f.kind, f.file_name, f.mime_type, f.size_bytes, f.created_at,
         u.full_name as uploaded_by_name
    from documents f
    left join users u on u.id = f.uploaded_by and u.tenant_id = f.tenant_id
   where f.tenant_id = $1 and f.entity_type = 'service_dispute' and f.entity_id = $2
     and f.deleted_at is null
   order by f.created_at desc`;

/** Params: document, tenant, dispute. */
const DISPUTE_FILE_SQL = `
  select f.id, f.entity_id, f.file_name, f.mime_type, f.size_bytes, f.storage_path
    from documents f
   where f.id = $1 and f.tenant_id = $2 and f.entity_type = 'service_dispute'
     and f.entity_id = $3 and f.deleted_at is null`;

/** Params: id, tenant, dispute, name, mime, bytes, path, actor. */
const INSERT_DISPUTE_FILE_SQL = `
  insert into documents (id, tenant_id, entity_type, entity_id, kind, file_name, mime_type,
                         size_bytes, storage_path, uploaded_by, created_by, updated_by)
  values ($1, $2, 'service_dispute', $3, 'attachment', $4, $5, $6, $7, $8, $8, $8)
  returning id, file_name, mime_type, size_bytes, created_at`;

/** Params: document, tenant, dispute, actor. */
const RETIRE_DISPUTE_FILE_SQL = `
  update documents set deleted_at = now(), updated_by = $4
   where id = $1 and tenant_id = $2 and entity_type = 'service_dispute' and entity_id = $3
     and deleted_at is null
   returning id, file_name`;

// ---------- the refund paper ----------

/** Params: ticket, dispute|null, amount, currency, pay_back, reason, company tenant|null,
 *  company, actor. Ref, incidence number and tenant come from the sequence and the trigger. */
const INSERT_REFUND_SQL = `
  insert into service_refund_requests (ref, ticket_id, ticket_ref, dispute_id,
      company_tenant_id, company_name, amount, currency, pay_back, reason,
      status, raised_by)
  values (
    'RF-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('service_refund_number_seq')::text, 5, '0'),
    $1, '', $2, $6, $7, $3::numeric, $4, $5, $8, 'raised', $9
  )
  returning id, ref, ticket_id, ticket_ref, dispute_id, company_name, amount, currency,
            pay_back, reason, status, raised_at`;

/** Params: id, tenant. */
const REFUND_SQL = `
  select r.id, r.ref, r.amount, r.currency, r.pay_back, r.reason, r.status,
         r.ticket_id, r.ticket_ref, r.dispute_id, r.company_name, r.company_tenant_id,
         r.raised_at, r.approval_id, r.released_at, r.declined_note, r.void_note,
         ru.full_name as raised_name, lu.full_name as released_name,
         du.full_name as declined_name, d.ref as dispute_ref, d.status as dispute_status
    from service_refund_requests r
    left join users ru on ru.id = r.raised_by
    left join users lu on lu.id = r.released_by
    left join users du on du.id = r.declined_by
    left join service_disputes d on d.id = r.dispute_id
   where r.id = $1 and r.tenant_id = $2`;

/** The only thing a finished-by-nobody paper may become without a signature: void, with its own
 *  sentence. `released_paper_is_kept` is what actually decides this. Params: id, tenant, note. */
const VOID_REFUND_SQL = `
  update service_refund_requests
     set status = 'void', void_note = $3, updated_at = now()
   where id = $1 and tenant_id = $2 and status = 'released'
   returning id, ref, status, void_note, updated_at`;

/** Params: tenant, status|null, search|null, limit, offset. */
const REFUNDS_BOARD_SQL =
  "select platform_auth.service_refunds_board($1,$2,$3,$4,$5) as b";
/** Params: tenant. */
const BOARD_SQL = "select platform_auth.service_board($1) as b";
/** Params: paper, reason, actor, role, ip, ua. */
const PROPOSE_SQL = "select platform_auth.propose_refund_release($1,$2,$3,$4,$5,$6) as r";
/** Params: paper, note, actor, role, ip, ua. */
const DECLINE_SQL = "select platform_auth.decline_refund($1,$2,$3,$4,$5,$6) as r";

// ---------- the satisfaction question ----------

/** Params: ticket, actor, channel. The incidence number and the tenant are copied by 126's trigger. */
const INSERT_SATISFACTION_SQL = `
  insert into service_satisfaction (ticket_id, ticket_ref, asked_by, asked_channel)
  values ($1, '', $2, $3)
  returning id, ticket_id, ticket_ref, asked_at, asked_channel`;

/** Params: id, tenant, score, word, recommends. */
const ANSWER_SATISFACTION_SQL = `
  update service_satisfaction
     set score = $3, word = nullif($4, ''), recommends = $5::boolean,
         answered_at = now(), updated_at = now()
   where id = $1 and tenant_id = $2 and answered_at is null
   returning id, ticket_ref, score, word, recommends, answered_at`;

/** Params: tenant, state|null, search|null, limit, offset. */
const SATISFACTION_SQL = `
  select c.id, c.ticket_id, c.ticket_ref, c.asked_at, c.asked_channel,
         c.answered_at, c.score, c.word, c.recommends,
         au.full_name as asked_name, t.status as ticket_status, t.company_name,
         t.subject as ticket_subject,
         count(*) over ()::int as total
    from service_satisfaction c
    left join users au on au.id = c.asked_by
    left join support_tickets t on t.id = c.ticket_id
   where c.tenant_id = $1
     and ($2::text is null
          or ($2 = 'unanswered' and c.score is null)
          or ($2 = 'answered' and c.score is not null)
          or ($2 = 'low' and c.score <= 2)
          or ($2 = 'good' and c.score >= 4))
     and ($3::text is null or c.ticket_ref ilike '%' || $3 || '%'
          or t.company_name ilike '%' || $3 || '%'
          or coalesce(c.word, '') ilike '%' || $3 || '%')
   order by c.asked_at desc
   limit $4 offset $5`;

/** Params: tenant. */
const SATISFACTION_COUNTS_SQL = `
  select count(*)::int as asked,
         count(*) filter (where c.score is not null)::int as answered,
         count(*) filter (where c.score is null)::int as unanswered,
         coalesce(round(avg(c.score) filter (where c.score is not null), 2), 0)::text as mean,
         count(*) filter (where c.score in (4,5))::int as happy,
         count(*) filter (where c.score in (1,2))::int as unhappy,
         count(*) filter (where c.recommends)::int as would_recommend,
         count(*) filter (where c.word is not null)::int as with_words
    from service_satisfaction c where c.tenant_id = $1`;

// ---------- the quality mark ----------

/** Params: ticket, seat, actor, checks, result, note. `score` is not a parameter on purpose —
 *  126 works it out of the six ticks, and a hand-typed mark is the argument the office would
 *  have to settle afterwards. */
const INSERT_QUALITY_SQL = `
  insert into service_quality_reviews (ticket_id, ticket_ref, reviewed_seat, reviewed_by,
      checks, score, result, note)
  values ($1, '', $2, $3, $4::jsonb, 0, $5, nullif($6, ''))
  returning id, ticket_ref, reviewed_seat, reviewed_by, checks, score, result, note, reviewed_at`;

/** Params: id, tenant, response. */
const ANSWER_QUALITY_SQL = `
  update service_quality_reviews
     set agent_response = $3, responded_at = now(), updated_at = now()
   where id = $1 and tenant_id = $2 and responded_at is null and withdrawn_at is null
   returning id, ticket_ref, agent_response, responded_at, reviewed_seat, result, score`;

/** Params: id, tenant, actor. */
const WITHDRAW_QUALITY_SQL = `
  update service_quality_reviews
     set withdrawn_at = now(), withdrawn_by = $3, updated_at = now()
   where id = $1 and tenant_id = $2 and withdrawn_at is null
   returning id, ticket_ref, withdrawn_at, withdrawn_by`;

/** Params: tenant, result|null, seat|null, search|null, limit, offset. */
const QUALITY_SQL = `
  select q.id, q.ticket_id, q.ticket_ref, q.checks, q.score, q.result, q.note,
         q.agent_response, q.responded_at, q.withdrawn_at, q.reviewed_at,
         q.reviewed_seat, q.reviewed_by,
         su.full_name as seat_name, ru.full_name as reviewer_name,
         t.company_name, t.dept_ref as ticket_dept_ref,
         count(*) over ()::int as total
    from service_quality_reviews q
    left join users su on su.id = q.reviewed_seat
    left join users ru on ru.id = q.reviewed_by
    left join support_tickets t on t.id = q.ticket_id
   where q.tenant_id = $1
     and ($2::text is null or q.result = $2)
     and ($3::uuid is null or q.reviewed_seat = $3)
     and ($4::text is null or q.ticket_ref ilike '%' || $4 || '%'
          or t.company_name ilike '%' || $4 || '%'
          or coalesce(q.note, '') ilike '%' || $4 || '%'
          or coalesce(q.agent_response, '') ilike '%' || $4 || '%')
   order by q.reviewed_at desc
   limit $5 offset $6`;

/** Params: tenant. */
const QUALITY_COUNTS_SQL = `
  select count(*) filter (where q.withdrawn_at is null)::int as live,
         count(*) filter (where q.result = 'met' and q.withdrawn_at is null)::int as met,
         count(*) filter (where q.result = 'partly_met' and q.withdrawn_at is null)::int as partly,
         count(*) filter (where q.result = 'below' and q.withdrawn_at is null)::int as below,
         count(*) filter (where q.responded_at is not null
                          and q.withdrawn_at is null)::int as answered,
         count(*) filter (where q.withdrawn_at is not null)::int as withdrawn,
         coalesce(round(avg(q.score) filter (where q.withdrawn_at is null), 1), 0)::text as mean
    from service_quality_reviews q where q.tenant_id = $1`;

/** Where the marks have landed, seat by seat. Params: tenant.
 *  This is the half of the spec's "workload board" that 126 can honestly add to: per-seat
 *  workload already ships on the staff desk, and this says how the work behind it was handled. */
const QUALITY_SEATS_SQL = `
  select u.id as seat_id, u.full_name as seat_name,
         count(q.id) filter (where q.withdrawn_at is null)::int as marks,
         coalesce(round(avg(q.score) filter (where q.withdrawn_at is null), 1), 0)::text as mean,
         count(*) filter (where q.result = 'met' and q.withdrawn_at is null)::int as met,
         count(*) filter (where q.result = 'below' and q.withdrawn_at is null)::int as below,
         count(*) filter (where q.responded_at is not null)::int as answered,
         max(q.reviewed_at) as last_mark
    from service_quality_reviews q
    join users u on u.id = q.reviewed_seat
   where q.tenant_id = $1
   group by u.id, u.full_name
   order by count(q.id) desc, u.full_name
   limit 60`;

/** The six ticks as six columns, so a CSV of marks can be sorted by the one thing it failed on.
 *  Params: tenant, result|null, seat|null, search. */
const QUALITY_EXPORT_SQL = `
  select q.ticket_ref, su.full_name as seat_name, ru.full_name as reviewer_name,
         q.reviewed_at, q.score, q.result, q.note, q.agent_response,
         q.checks ->> 'answered_the_caller' as answered_the_caller,
         q.checks ->> 'identity_confirmed' as identity_confirmed,
         q.checks ->> 'right_desk' as right_desk,
         q.checks ->> 'action_offered' as action_offered,
         q.checks ->> 'words_suitable' as words_suitable,
         q.checks ->> 'settled_with_answer' as settled_with_answer,
         q.withdrawn_at
    from service_quality_reviews q
    left join users su on su.id = q.reviewed_seat
    left join users ru on ru.id = q.reviewed_by
   where q.tenant_id = $1
     and ($2::text is null or q.result = $2)
     and ($3::uuid is null or q.reviewed_seat = $3)
     and ($4::text is null or q.ticket_ref ilike '%' || $4 || '%')
   order by q.reviewed_at desc limit 2000`;

const DISPUTES_EXPORT_SQL = `
  select s.ref, s.status, s.ground, s.claim, s.amount, s.currency, s.ticket_ref, s.company_name,
         ou.full_name as opened_name, s.opened_at, s.outcome, du.full_name as decided_name,
         s.decided_at, r.ref as refund_ref, r.status as refund_status
    from service_disputes s
    left join service_refund_requests r on r.id = s.refund_request_id
    left join users ou on ou.id = s.opened_by
    left join users du on du.id = s.decided_by
   where s.tenant_id = $1 and s.deleted_at is null
     and ($2::text is null or s.status = $2)
     and ($3::text is null or s.ground = $3)
     and ($4::text is null or s.ref ilike '%' || $4 || '%'
          or s.ticket_ref ilike '%' || $4 || '%' or s.company_name ilike '%' || $4 || '%')
   order by s.opened_at desc limit 2000`;

const SATISFACTION_EXPORT_SQL = `
  select c.ticket_ref, c.asked_at, au.full_name as asked_name, c.asked_channel,
         t.company_name, c.score, c.recommends, c.word, c.answered_at
    from service_satisfaction c
    left join users au on au.id = c.asked_by
    left join support_tickets t on t.id = c.ticket_id
   where c.tenant_id = $1
     and ($2::text is null
          or ($2 = 'unanswered' and c.score is null)
          or ($2 = 'answered' and c.score is not null)
          or ($2 = 'low' and c.score <= 2)
          or ($2 = 'good' and c.score >= 4))
     and ($3::text is null or c.ticket_ref ilike '%' || $3 || '%'
          or t.company_name ilike '%' || $3 || '%')
   order by c.asked_at desc limit 2000`;

/**
 * The papers for the CSV come out of `service_refunds_board`, a page at a time, and no statement
 * in this file selects `platform_approvals`.
 *
 * The API's role happens to own that register, so a join would work — which is exactly why it is
 * not written. 121 put the signature behind definers so that the only way to read it is a way
 * that also decides what the reader is allowed to see, and a route that gets away with reaching
 * around the door today is the precedent somebody follows tomorrow. The board caps a page at 100
 * rows, so the export walks pages and stops when one comes back short.
 */
const REFUND_HEAD = ["ref", "request_status", "amount", "currency", "pay_back", "ticket_ref",
  "company_name", "reason", "raised_name", "raised_at", "approval_proposed_name",
  "approval_status", "approval_expires_at", "signed_name", "signed_at", "released_name",
  "released_at", "declined_note", "void_note"];

async function refundRows(tenant: string, status: string | null, search: string | null) {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = (await pool.query(REFUNDS_BOARD_SQL,
      [tenant, status, search, 100, offset])).rows[0].b;
    const rows = (page.rows ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}


function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // A claim and a reason are typed by whoever opened the dispute, and a cell that starts with an
  // operator is a formula the moment the CSV reaches a spreadsheet. One apostrophe costs nothing
  // and stops that.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const csv = (head: string[], rows: Record<string, unknown>[]): string => [
  head.map(csvCell).join(","),
  ...rows.map((r) => head.map((h) => csvCell(r[h])).join(","))
].join("\r\n");

export async function controlServiceRoutes(app: FastifyInstance, _opts: unknown) {
  const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;
  const tenantOf = (req: any) => req.control.tenant_id as string;

  /** One line on one dispute, and the ordinary audit row beside it — same transaction as the
   *  write that caused it, so a dispute whose history lost an act has also lost that act. */
  const line = async (c: PoolClient, req: any, row: {
    dispute: { id: string };
    action: "opened" | "paper_filed" | "paper_retired" | "status_changed"
      | "refund_raised" | "decided" | "note";
    fromLabel?: string | null; toLabel?: string | null;
    reason: string; detail?: object;
  }) => {
    const e = await c.query(INSERT_DISPUTE_EVENT_SQL, [
      tenantOf(req), row.dispute.id, req.control.user_id, role(req), req.ip ?? null,
      row.action, row.fromLabel ?? null, row.toLabel ?? null, row.reason,
      JSON.stringify(row.detail ?? {})
    ]);
    await writeAudit(c, {
      tenantId: tenantOf(req), actorUserId: req.control.user_id, actorRole: role(req),
      ip: req.ip, requestId: req.requestId, userAgent: req.headers["user-agent"] ?? null,
      entity: "service_disputes", entityId: row.dispute.id,
      action: `control.service.${row.action}`,
      before: { from: row.fromLabel ?? null },
      after: { to: row.toLabel ?? null, reason: row.reason, event_id: e.rows[0].id }
    });
    return e.rows[0];
  };

  /** A plain audit row for the three registers that have no event table of their own. */
  const audit = async (c: PoolClient, req: any, entity: string, id: string,
    action: string, before: unknown, after: unknown) => {
    await writeAudit(c, {
      tenantId: tenantOf(req), actorUserId: req.control.user_id, actorRole: role(req),
      ip: req.ip, requestId: req.requestId, userAgent: req.headers["user-agent"] ?? null,
      entity, entityId: id, action, before, after
    });
  };

  /** The call a paper is about: on this register, not deleted, and answered with enough to
   *  copy the company off it rather than let a desk type a company name. */
  const call = async (c: PoolClient, id: string, tenant: string) => {
    const r = await c.query(CALL_SQL, [id, tenant]);
    if (!r.rowCount) throw new ApiError("NOT_FOUND",
      "That incidence is not on the register.", 404);
    if (r.rows[0].deleted_at) {
      throw new ApiError("CONFLICT", "That call has been taken off the register.", 409);
    }
    return r.rows[0];
  };

  // ============================================================
  // the board
  // ============================================================

  app.get("/control/service/board", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-board:${req.control.user_id}`, 120, 60);
    const { rows } = await pool.query(BOARD_SQL, [tenantOf(req)]);
    return rows[0].b;
  });

  // The picker every one of the four papers is opened from. Gated on this desk's own view duty
  // rather than on `control.tickets.view`, because a supervisor grading a call is not necessarily
  // a person who works the inbox — but both need to find the call.
  app.get("/control/service/calls", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-calls:${req.control.user_id}`, 120, 60);
    const q = z.object({ search: SEARCH, ticket: z.string().uuid().optional() })
      .parse(req.query ?? {});
    return withTenant(tenantOf(req), async (c) => {
      if (q.ticket) return { rows: [await call(c, q.ticket, tenantOf(req))] };
      const r = await c.query(CALLS_SQL, [tenantOf(req), q.search || null]);
      return { rows: r.rows };
    });
  });

  app.get("/control/service/seats", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, REVIEW);
    await enforceRateLimit(`service-seats:${req.control.user_id}`, 60, 60);
    const r = await withTenant(tenantOf(req),
      (c) => c.query(SEATS_SQL, [tenantOf(req)]));
    return { rows: r.rows };
  });

  // ============================================================
  // disputes
  // ============================================================

  app.get("/control/service/disputes", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-disputes:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(DISPUTE_STATUSES).or(z.literal("all")).optional(),
      ground: z.enum(GROUNDS).optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const rows = await c.query(DISPUTES_SQL, [tenant,
        q.status && q.status !== "all" ? q.status : null, q.ground ?? null,
        q.search || null, q.limit, q.offset]);
      const counts = (await c.query(DISPUTE_COUNTS_SQL, [tenant])).rows[0];
      return { rows: rows.rows, counts };
    });
  });

  app.get("/control/service/disputes/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-dispute-read:${req.control.user_id}`, 120, 60);
    const id = uuidOf(req.params.id, "dispute");
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const d = await c.query(DISPUTE_SQL, [id, tenant]);
      if (!d.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
      const events = await c.query(DISPUTE_EVENTS_SQL, [tenant, id]);
      return { ...d.rows[0], events: events.rows };
    });
  });

  /**
   * Open a dispute. It always stands on a call, so the company and the incidence number are
   * copied off that call by 126's trigger and nothing here is typed about them.
   *
   * The figure is the caller's claim and it is optional: a discourtesy has no number, and a desk
   * that had to invent one to file the paper would invent one that then has to be paid.
   */
  app.post("/control/service/disputes", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`service-dispute-open:${req.control.user_id}`, 30, 3600);
    const body = z.object({
      ticketId: z.string().uuid(),
      ground: z.enum(GROUNDS),
      claim: z.string().trim().min(10).max(4000),
      amount: MONEY.optional(),
      currency: z.enum(CURRENCIES).optional(),
      reason: REASON
    }).strict().refine(
      (b) => (b.amount === undefined) === (b.currency === undefined),
      { message: "A figure needs a currency, and a currency needs a figure.", path: ["amount"] }
    ).parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const t = await call(c, body.ticketId, tenant);
      let made;
      try {
        made = await c.query(INSERT_DISPUTE_SQL, [
          body.ticketId, body.ground, body.claim,
          body.amount === undefined ? null : money(body.amount),
          body.currency ?? null, t.company_tenant_id ?? null, t.company_name,
          req.control.user_id
        ]);
      } catch (err) {
        throw guardRefusal(err, "The dispute was refused by the register.") ?? err;
      }
      const d = made.rows[0];
      await line(c, req, {
        dispute: { id: d.id }, action: "opened", fromLabel: null,
        toLabel: d.status ?? "open", reason: body.reason,
        detail: { ticket_ref: d.ticket_ref, ground: d.ground, claim: d.claim,
          amount: d.amount, currency: d.currency, company_name: d.company_name }
      });
      return reply.status(201).send(d);
    });
  });

  /**
   * Move a dispute — including ending it. `upheld` and `settled` are the two the table makes the
   * desk work for: something has to be filed on the dispute, and a settled figure has to be the
   * same figure as the paper. Both are refused there, in words that name the row.
   */
  app.post("/control/service/disputes/:id/status",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`service-dispute-move:${req.control.user_id}`, 60, 3600);
      const id = uuidOf(req.params.id, "dispute");
      const body = z.object({
        to: z.enum(DISPUTE_STATUSES),
        reason: REASON,
        outcome: OUTCOME.optional()
      }).strict().refine(
        (b) => !DECIDED.includes(b.to as typeof DECIDED[number]) || b.outcome !== undefined,
        { message: "A decided dispute needs the finding in writing: 8-2000 characters.",
          path: ["outcome"] }
      ).parse(req.body);
      const tenant = tenantOf(req);

      return withTenant(tenant, async (c) => {
        const now = await c.query(DISPUTE_SQL, [id, tenant]);
        if (!now.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
        const row = now.rows[0];
        if (row.decided_at) {
          throw new ApiError("CONFLICT",
            `${row.ref} was decided on ${new Date(row.decided_at).toISOString().slice(0, 10)} `
            + "and a finding is not rewritten. Open a second dispute against it.", 409);
        }
        if (row.status === body.to) {
          throw new ApiError("CONFLICT", `${row.ref} is already ${body.to}.`, 409);
        }
        let moved;
        try {
          moved = await c.query(MOVE_DISPUTE_SQL, [id, tenant, body.to,
            body.outcome ?? null, req.control.user_id]);
        } catch (err) {
          throw guardRefusal(err, "The move was refused by the register.") ?? err;
        }
        await line(c, req, {
          dispute: { id }, action: DECIDED.includes(body.to as typeof DECIDED[number])
            ? "decided" : "status_changed",
          fromLabel: row.status, toLabel: moved.rows[0].status, reason: body.reason,
          detail: { outcome: moved.rows[0].outcome ?? null }
        });
        return moved.rows[0];
      });
    });

  /** A sentence on the file, and nothing else. Notes are the reason the event line exists: the
   *  desk can say what it did and when without editing a finding that is already signed. */
  app.post("/control/service/disputes/:id/note",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`service-dispute-note:${req.control.user_id}`, 120, 3600);
      const id = uuidOf(req.params.id, "dispute");
      const body = z.object({ reason: REASON }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const found = await c.query(DISPUTE_SQL, [id, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
        const e = await line(c, req, {
          dispute: { id }, action: "note", fromLabel: null, toLabel: null,
          reason: body.reason
        });
        return reply.status(201).send(e);
      });
    });

  /** File the paper a finding stands on. 126 makes this mandatory for `upheld` and `settled`,
   *  which is the whole point: "the office agreed" is easy to write and hard to prove a month
   *  later. Same limits and the same byte sniff as a photograph on a call. */
  app.post("/control/service/disputes/:id/papers",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      await requireControlPermission(req, MANAGE);
      const id = uuidOf(req.params.id, "dispute");
      const tenant = tenantOf(req);
      if (!storageConfigured()) {
        throw new ApiError("STORAGE_UNAVAILABLE",
          "Uploads are not configured yet — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);
      }
      await enforceRateLimit(`service-dispute-papers:uid:${req.control.user_id}`, 20, 3600);

      const data = await req.file();
      if (!data) throw new ApiError("VALIDATION_FAILED", "Attach a file first.", 400,
        [{ field: "file" }]);
      const fields = data.fields as Record<string, any>;
      const reason = REASON.safeParse(fields.reason?.value ?? "");
      if (!reason.success) {
        throw new ApiError("VALIDATION_FAILED",
          "Say why this paper belongs on the dispute.", 400, [{ field: "reason" }]);
      }
      const bytes = await data.toBuffer();
      if (bytes.length === 0) throw new ApiError("VALIDATION_FAILED", "The file is empty.", 400);
      if (bytes.length > MAX_FILE_BYTES) {
        throw new ApiError("VALIDATION_FAILED", "Files are limited to 8 MB.", 400,
          [{ field: "file" }]);
      }
      const mime = (data.mimetype || "").toLowerCase();
      if (!FILE_MIMES.includes(mime) || sniffFileType(bytes) !== mime) {
        throw new ApiError("VALIDATION_FAILED",
          "A paper on a dispute must be a real JPEG, PNG, WebP or PDF.", 400, [{ field: "file" }]);
      }

      return withTenant(tenant, async (c) => {
        const found = await c.query(DISPUTE_SQL, [id, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
        const docId = uuidv7();
        const path = `${tenant}/service_dispute/${id}/${docId}-${sanitizeFileName(data.filename)}`;
        try {
          await putObject(path, bytes, mime);
        } catch (e) {
          if (e instanceof StorageUnavailableError) throw e;
          req.log.error(e, "storage upload failed (service dispute paper)");
          throw new ApiError("INTERNAL", "The file could not be stored. Try again.", 502);
        }
        const file = await c.query(INSERT_DISPUTE_FILE_SQL, [docId, tenant, id,
          sanitizeFileName(data.filename), mime, bytes.length, path, req.control.user_id]);
        await line(c, req, {
          dispute: { id }, action: "paper_filed", fromLabel: null,
          toLabel: file.rows[0].file_name, reason: reason.data,
          detail: { document_id: docId, mime_type: mime, size_bytes: bytes.length }
        });
        return reply.status(201).send(file.rows[0]);
      });
    });

  /** Through the API rather than a bucket link, so the duty that read the dispute is the duty
   *  that opened the paper and nothing on it ever gets a public URL. */
  app.get("/control/service/disputes/:id/papers/:docId/content",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      await requireControlPermission(req, VIEW);
      await enforceRateLimit(`service-paper-read:${req.control.user_id}`, 120, 60);
      const { id, docId } = req.params as { id: string; docId: string };
      const dispute = uuidOf(id, "dispute"); const doc = uuidOf(docId, "document");
      const tenant = tenantOf(req);
      if (!storageConfigured()) {
        throw new ApiError("STORAGE_UNAVAILABLE", "Files are not configured yet.", 503);
      }
      const row = await withTenant(tenant, (c) => c.query(DISPUTE_FILE_SQL, [doc, tenant, dispute]));
      if (!row.rowCount) throw new ApiError("NOT_FOUND", "No such paper on that dispute.", 404);
      try {
        const got = await getObject(row.rows[0].storage_path);
        const inline = got.contentType?.startsWith("image/")
          || row.rows[0].mime_type.startsWith("image/");
        return reply
          .header("Content-Type", got.contentType ?? row.rows[0].mime_type)
          .header("X-Content-Type-Options", "nosniff")
          .header("Content-Disposition",
            `${inline ? "inline" : "attachment"}; filename="${sanitizeFileName(row.rows[0].file_name)}"`)
          .send(got.bytes);
      } catch (e) {
        req.log.error(e, "storage download failed (service dispute paper)");
        throw new ApiError("INTERNAL", "Could not read the file.", 502);
      }
    });

  /**
   * Take a paper away. It is a tombstone, not a delete: `dispute_is_upheld_on_paper` counts only
   * live files, so retiring the one a finding stood on is visible in the event line and the
   * finding itself stays readable rather than vanishing with its evidence.
   */
  app.post("/control/service/disputes/:id/papers/:docId/retire",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`service-dispute-retire:${req.control.user_id}`, 20, 3600);
      const { id, docId } = req.params as { id: string; docId: string };
      const dispute = uuidOf(id, "dispute"); const doc = uuidOf(docId, "document");
      const body = z.object({ reason: REASON }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const found = await c.query(DISPUTE_SQL, [dispute, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
        const gone = await c.query(RETIRE_DISPUTE_FILE_SQL,
          [doc, tenant, dispute, req.control.user_id]);
        if (!gone.rowCount) {
          throw new ApiError("NOT_FOUND", "No such live paper on that dispute.", 404);
        }
        await line(c, req, {
          dispute: { id: dispute }, action: "paper_retired",
          fromLabel: gone.rows[0].file_name, toLabel: null, reason: body.reason,
          detail: { document_id: doc }
        });
        return gone.rows[0];
      });
    });

  // ============================================================
  // the refund paper
  // ============================================================

  /** Raise a paper standing on a dispute. The figure is the dispute's claim or the desk is
   *  saying two numbers about one argument, which is exactly what `dispute_settles_on_its_figure`
   *  exists to refuse. */
  app.post("/control/service/disputes/:id/refund",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`service-dispute-refund:${req.control.user_id}`, 20, 3600);
      const disputeId = uuidOf(req.params.id, "dispute");
      const body = z.object({
        amount: MONEY,
        currency: z.enum(CURRENCIES),
        payBack: z.enum(PAY_BACK),
        reason: SENTENCE
      }).strict().parse(req.body);
      const tenant = tenantOf(req);

      return withTenant(tenant, async (c) => {
        const found = await c.query(DISPUTE_SQL, [disputeId, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
        const d = found.rows[0];
        if (d.refund_request_id) {
          throw new ApiError("CONFLICT",
            `${d.ref} already settles on ${d.refund_ref ?? "a paper"}. A dispute takes one paper.`, 409);
        }
        if (d.status === "settled" || d.status === "withdrawn") {
          throw new ApiError("CONFLICT",
            `${d.ref} is ${d.status} — a paper after the finding is a new dispute.`, 409);
        }
        // Compared in cents, because the register keeps numeric(14,2): a desk that types
        // 400,000.004 is typing the figure the table will store as 400,000.00, and the argument
        // is the same money.
        if (d.amount !== null
          && Math.round(Number(d.amount) * 100) !== Math.round(body.amount * 100)) {
          throw new ApiError("CONFLICT",
            `${d.ref} was claimed at ${d.amount} ${d.currency}. The paper has to say the caller's `
            + "figure or the dispute has to be opened again at the new one.", 409);
        }
        if (d.amount !== null && d.currency !== body.currency) {
          throw new ApiError("CONFLICT",
            `${d.ref} is claimed in ${d.currency}, not ${body.currency}.`, 409);
        }
        let paper;
        try {
          paper = await c.query(INSERT_REFUND_SQL, [d.ticket_id, disputeId,
            money(body.amount), body.currency, body.payBack,
            d.company_tenant_id ?? null, d.company_name, body.reason, req.control.user_id]);
        } catch (err) {
          throw guardRefusal(err, "The paper was refused by the register.") ?? err;
        }
        const r = paper.rows[0];
        const linked = await c.query(LINK_DISPUTE_PAPER_SQL, [disputeId, tenant, r.id]);
        if (!linked.rowCount) {
          throw new ApiError("CONFLICT",
            "Another paper was raised on this dispute while you were writing this one.", 409);
        }
        await line(c, req, {
          dispute: { id: disputeId }, action: "refund_raised", fromLabel: null,
          toLabel: r.ref, reason: body.reason,
          detail: { request_id: r.id, amount: r.amount, currency: r.currency,
            pay_back: r.pay_back }
        });
        return reply.status(201).send({ ...r, dispute_ref: d.ref });
      });
    });

  /** A paper about a call with no dispute on it — the caller was owed something and the office
   *  agrees, and that is a fact worth registering whether or not anybody was challenged. */
  app.post("/control/service/refunds", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`service-refund-raise:${req.control.user_id}`, 20, 3600);
    const body = z.object({
      ticketId: z.string().uuid(),
      disputeId: z.string().uuid().optional(),
      amount: MONEY,
      currency: z.enum(CURRENCIES),
      payBack: z.enum(PAY_BACK),
      reason: SENTENCE
    }).strict().parse(req.body);
    const tenant = tenantOf(req);

    return withTenant(tenant, async (c) => {
      const t = await call(c, body.ticketId, tenant);
      if (body.disputeId) {
        const d = await c.query(DISPUTE_SQL, [body.disputeId, tenant]);
        if (!d.rowCount) throw new ApiError("NOT_FOUND", "No such dispute.", 404);
        if (d.rows[0].ticket_id !== body.ticketId) {
          throw new ApiError("CONFLICT",
            `${d.rows[0].ref} stands on ${d.rows[0].ticket_ref}, not on the call you named.`, 409);
        }
      }
      let paper;
      try {
        paper = await c.query(INSERT_REFUND_SQL, [body.ticketId, body.disputeId ?? null,
          money(body.amount), body.currency, body.payBack,
          t.company_tenant_id ?? null, t.company_name, body.reason, req.control.user_id]);
      } catch (err) {
        throw guardRefusal(err, "The paper was refused by the register.") ?? err;
      }
      const r = paper.rows[0];
      if (body.disputeId) {
        const linked = await c.query(LINK_DISPUTE_PAPER_SQL, [body.disputeId, tenant, r.id]);
        if (!linked.rowCount) {
          throw new ApiError("CONFLICT",
            "Another paper was raised on this dispute while you were writing this one.", 409);
        }
        await line(c, req, {
          dispute: { id: body.disputeId }, action: "refund_raised", fromLabel: null,
          toLabel: r.ref, reason: body.reason,
          detail: { request_id: r.id, amount: r.amount, currency: r.currency }
        });
      } else {
        await audit(c, req, "service_refund_requests", r.id, "control.service.refund_raised",
          null, { ref: r.ref, amount: r.amount, currency: r.currency, pay_back: r.pay_back,
            ticket_ref: r.ticket_ref, reason: body.reason });
      }
      return reply.status(201).send(r);
    });
  });

  app.get("/control/service/refunds", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-refunds:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(REFUND_STATUSES).or(z.literal("all")).optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const { rows } = await pool.query(REFUNDS_BOARD_SQL, [tenantOf(req),
      q.status && q.status !== "all" ? q.status : null, q.search || null, q.limit, q.offset]);
    return rows[0].b;
  });

  /**
   * One paper, with the signature it is waiting on attached.
   *
   * The signature state comes from `service_refunds_board`, because `platform_approvals` has no
   * grant for a route: the desk asks the door that was built for the question "waiting on whom,
   * since when, for what figure?". The ref read first is the register's own, so the search the
   * definer runs is exact.
   */
  app.get("/control/service/refunds/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-refund-read:${req.control.user_id}`, 120, 60);
    const id = uuidOf(req.params.id, "refund paper");
    const tenant = tenantOf(req);
    const row = await withTenant(tenant, (c) => c.query(REFUND_SQL, [id, tenant]));
    if (!row.rowCount) throw new ApiError("NOT_FOUND", "No such refund paper.", 404);
    const board = (await pool.query(REFUNDS_BOARD_SQL, [tenant, null, row.rows[0].ref, 100, 0]))
      .rows[0].b;
    const signed = (board.rows as any[]).find((x) => x.id === id) ?? null;
    return { ...row.rows[0], signature: signed };
  });

  /**
   * Ask a second seat to sign. Nothing is paid by this call, and the answer says so.
   *
   * The payload the seat signs is read out of the paper by the definer, so a desk cannot propose
   * one figure and have another released. The seven-day window, the one-open-per-paper rule and
   * "not the proposer" are 121's, and they answer here in the same words they answer with on a
   * ban.
   */
  app.post("/control/service/refunds/:id/propose",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await requireControlPermission(req, PAYMENTS);
      await enforceRateLimit(`service-refund-propose:${req.control.user_id}`, 10, 3600);
      const id = uuidOf(req.params.id, "refund paper");
      const body = z.object({ reason: SENTENCE }).strict().parse(req.body);
      const a = { id: req.control.user_id as string,
        role: role(req), ip: req.ip as string,
        ua: String(req.headers?.["user-agent"] ?? "").slice(0, 300) };
      const r = (await pool.query(PROPOSE_SQL,
        [id, body.reason, a.id, a.role, a.ip, a.ua])).rows[0].r;
      const message = typeof r?.message === "string" ? r.message : null;
      switch (r?.status) {
        case "ok":
          return r;
        case "not_found":
          throw new ApiError("NOT_FOUND", `No refund paper ${id}.`, 404);
        case "conflict":
          throw new ApiError("APPROVAL_OPEN", message ?? "A signature for this paper is already open.", 409);
        case "invalid":
          throw new ApiError("VALIDATION_FAILED",
            message ?? "The proposal was refused.", 400);
        default:
          throw new ApiError("UPSTREAM_ERROR", "The proposal could not be recorded.", 502);
      }
    });

  /** Refuse the paper. Which seat may do it follows the paper's own state, and the two answers are
   *  both stated in the table. A `raised` paper is the desk's own "no" — saying no to money is not
   *  the act the two-person rule names, so it costs the desk its money duties and nothing else. A
   *  paper already standing on an open proposal is refused by a seat that could have signed it,
   *  because the refusal is that proposal's answer; charging it the proposer's duties instead would
   *  leave the only hand able to refuse it a second super_admin. Either way the definer answers an
   *  open proposal first, so no paper is ever declined while a seat is being asked to sign it, and
   *  `not the seat that raised it` is 126's guard, not a duty. */
  app.post("/control/service/refunds/:id/decline",
    { preHandler: [requireControl] }, async (req: any) => {
      await enforceRateLimit(`service-refund-decline:${req.control.user_id}`, 20, 3600);
      const id = uuidOf(req.params.id, "refund paper");
      const body = z.object({ note: SENTENCE }).strict().parse(req.body);
      const tenant = tenantOf(req);
      const found = await withTenant(tenant, (c) => c.query(REFUND_SQL, [id, tenant]));
      if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such refund paper.", 404);
      if (found.rows[0].status === "pending_signature") {
        if (!(await controlHolds(req, [DECIDE])).length) {
          throw new ApiError("FORBIDDEN",
            "Only a seat that could sign this paper can refuse it.", 403);
        }
      } else {
        await requireControlPermission(req, MANAGE);
        await requireControlPermission(req, PAYMENTS);
      }
      const a = { id: req.control.user_id as string, role: role(req), ip: req.ip as string,
        ua: String(req.headers?.["user-agent"] ?? "").slice(0, 300) };
      const r = (await pool.query(DECLINE_SQL,
        [id, body.note, a.id, a.role, a.ip, a.ua])).rows[0].r;
      const message = typeof r?.message === "string" ? r.message : null;
      switch (r?.status) {
        case "ok":
          return r;
        case "not_found":
          throw new ApiError("NOT_FOUND", `No refund paper ${id}.`, 404);
        case "self":
          throw new ApiError("SELF_APPROVAL",
            message ?? "You raised this signature, so you cannot be the one to refuse it.", 403);
        case "conflict":
          throw new ApiError("CONFLICT", message ?? "This paper is finished.", 409);
        case "invalid":
          throw new ApiError("VALIDATION_FAILED", message ?? "The note was refused.", 400);
        default:
          throw new ApiError("UPSTREAM_ERROR", "The refusal could not be recorded.", 502);
      }
    });

  /** Void a paper that was signed and then never actually paid. `released` is the only state it
   *  comes from and a sentence is the only thing that lets it go — a released refund nobody paid
   *  is exactly what an audit asks about, and the answer has to be on the row. */
  app.post("/control/service/refunds/:id/void",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, PAYMENTS);
      await enforceRateLimit(`service-refund-void:${req.control.user_id}`, 10, 3600);
      const id = uuidOf(req.params.id, "refund paper");
      const body = z.object({ note: SENTENCE }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const found = await c.query(REFUND_SQL, [id, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such refund paper.", 404);
        const row = found.rows[0];
        if (row.status !== "released") {
          throw new ApiError("CONFLICT",
            `${row.ref} is ${row.status}. Only a released paper can be voided — a paper nobody `
            + "has signed yet is refused with a reason instead.", 409);
        }
        let voided;
        try {
          voided = await c.query(VOID_REFUND_SQL, [id, tenant, body.note]);
        } catch (err) {
          throw guardRefusal(err, "The void was refused by the register.") ?? err;
        }
        if (!voided.rowCount) {
          throw new ApiError("CONFLICT", `${row.ref} changed under this call. Nothing was voided.`, 409);
        }
        await audit(c, req, "service_refund_requests", id, "control.service.refund_voided",
          { status: row.status, released_at: row.released_at },
          { status: "void", note: body.note, ref: row.ref });
        return voided.rows[0];
      });
    });

  // ============================================================
  // the satisfaction question
  // ============================================================

  app.get("/control/service/satisfaction",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, VIEW);
      await enforceRateLimit(`service-satisfaction:${req.control.user_id}`, 120, 60);
      const q = z.object({
        state: z.enum(["all", "answered", "unanswered", "low", "good"]).optional(),
        search: SEARCH, limit: LIMIT, offset: OFFSET
      }).parse(req.query ?? {});
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const rows = await c.query(SATISFACTION_SQL, [tenant,
          q.state && q.state !== "all" ? q.state : null, q.search || null, q.limit, q.offset]);
        const counts = (await c.query(SATISFACTION_COUNTS_SQL, [tenant])).rows[0];
        return { rows: rows.rows, counts };
      });
    });

  /**
   * Ask a caller how the call went. The call has to be settled first — 126's trigger says so, and
   * the reason is on the panel: satisfaction asked about work in progress is a number about a
   * promise that has not been kept yet.
   */
  app.post("/control/service/satisfaction",
    { preHandler: [requireControl] }, async (req: any, reply) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`service-csat-ask:${req.control.user_id}`, 60, 3600);
      const body = z.object({
        ticketId: z.string().uuid(),
        askedChannel: z.enum(ASKED_CHANNELS).default("phone_call")
      }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const t = await call(c, body.ticketId, tenant);
        if (!["resolved", "closed"].includes(t.status)) {
          throw new ApiError("CONFLICT",
            `${t.ref} is still ${t.status}. Satisfaction is asked after the desk has settled `
            + "the call.", 409);
        }
        try {
          const made = await c.query(INSERT_SATISFACTION_SQL,
            [body.ticketId, req.control.user_id, body.askedChannel]);
          await audit(c, req, "service_satisfaction", made.rows[0].id,
            "control.service.csat_asked", null,
            { ticket_ref: made.rows[0].ticket_ref, asked_channel: made.rows[0].asked_channel });
          return reply.status(201).send(made.rows[0]);
        } catch (err) {
          if ((err as any)?.code === "23505") {
            throw new ApiError("CONFLICT",
              `${t.ref} has already been asked. One question per call — a caller who rings twice `
              + "gets a line for the second call.", 409);
          }
          throw guardRefusal(err, "The question was refused by the register.") ?? err;
        }
      });
    });

  /** The caller's answer, in the desk's hand. Optional and never overwritten: an answer twice
   *  entered is one answer typed by whoever had the phone last. */
  app.post("/control/service/satisfaction/:id/answer",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`service-csat-answer:${req.control.user_id}`, 60, 3600);
      const id = uuidOf(req.params.id, "satisfaction line");
      const body = z.object({
        score: z.coerce.number().int().min(1).max(5),
        word: z.string().trim().min(2).max(600).optional(),
        recommends: z.boolean().optional()
      }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const before = await c.query(`
          select id, ticket_ref, score, answered_at from service_satisfaction
           where id = $1 and tenant_id = $2`, [id, tenant]);
        if (!before.rowCount) throw new ApiError("NOT_FOUND", "No such line.", 404);
        if (before.rows[0].answered_at) {
          throw new ApiError("CONFLICT",
            `${before.rows[0].ticket_ref} was already answered. An answer is kept, not retyped.`, 409);
        }
        const made = await c.query(ANSWER_SATISFACTION_SQL, [id, tenant, body.score,
          body.word ?? null, body.recommends === undefined ? null : body.recommends]);
        if (!made.rowCount) {
          throw new ApiError("CONFLICT", "That line changed under this call. Nothing was written.", 409);
        }
        await audit(c, req, "service_satisfaction", id, "control.service.csat_answered",
          { ticket_ref: before.rows[0].ticket_ref, score: null },
          made.rows[0]);
        return made.rows[0];
      });
    });

  // ============================================================
  // the quality mark
  // ============================================================

  app.get("/control/service/quality", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-quality:${req.control.user_id}`, 120, 60);
    const q = z.object({
      result: z.enum(RESULTS).or(z.literal("all")).optional(),
      seat: z.string().uuid().optional(),
      search: SEARCH, limit: LIMIT, offset: OFFSET
    }).parse(req.query ?? {});
    const tenant = tenantOf(req);
    return withTenant(tenant, async (c) => {
      const rows = await c.query(QUALITY_SQL, [tenant,
        q.result && q.result !== "all" ? q.result : null, q.seat ?? null,
        q.search || null, q.limit, q.offset]);
      const counts = (await c.query(QUALITY_COUNTS_SQL, [tenant])).rows[0];
      const seats = (await c.query(QUALITY_SEATS_SQL, [tenant])).rows;
      return { rows: rows.rows, counts, seats };
    });
  });

  /**
   * Grade a call. The mark is worked out of the six ticks by the table, the word has to agree
   * with the ticks it summarises, and a seat cannot grade its own call — all three are 126's
   * guards, and the route's only addition is that it refuses self-marking in the same words the
   * desk would want before it wastes a minute pressing a button.
   */
  app.post("/control/service/quality", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, REVIEW);
    await enforceRateLimit(`service-quality-write:${req.control.user_id}`, 30, 3600);
    const checks = z.object({
      answered_the_caller: z.boolean(), identity_confirmed: z.boolean(),
      right_desk: z.boolean(), action_offered: z.boolean(),
      words_suitable: z.boolean(), settled_with_answer: z.boolean()
    }).strict();
    const body = z.object({
      ticketId: z.string().uuid(),
      reviewedSeat: z.string().uuid(),
      checks,
      result: z.enum(RESULTS),
      note: z.string().trim().min(8).max(1200).optional()
    }).strict().parse(req.body);
    const tenant = tenantOf(req);
    if (body.reviewedSeat === req.control.user_id) {
      throw new ApiError("CONFLICT",
        "A seat does not grade its own call. The mark that forbids it is in the table, not here.", 409);
    }

    return withTenant(tenant, async (c) => {
      const t = await call(c, body.ticketId, tenant);
      const seat = await c.query(`
        select u.id, u.full_name from users u
         where u.id = $1 and u.tenant_id = $2 and u.deleted_at is null and u.status = 'active'`,
      [body.reviewedSeat, tenant]);
      if (!seat.rowCount) {
        throw new ApiError("NOT_FOUND",
          "That seat is not a live person on the platform register.", 404);
      }
      if (body.result !== "met" && !body.note) {
        throw new ApiError("VALIDATION_FAILED",
          "A mark short of the promise needs the coach's line: 8-1200 characters, or the seat "
          + "learns nothing and cannot argue with it.", 400, [{ field: "note" }]);
      }
      try {
        const made = await c.query(INSERT_QUALITY_SQL, [body.ticketId, body.reviewedSeat,
          req.control.user_id, JSON.stringify(body.checks), body.result, body.note ?? null]);
        const r = made.rows[0];
        await audit(c, req, "service_quality_reviews", r.id, "control.service.review_marked",
          { ticket_ref: t.ref, seat: seat.rows[0].full_name },
          { score: r.score, result: r.result, checks: r.checks, note: r.note ?? null });
        return reply.status(201).send(r);
      } catch (err) {
        if ((err as any)?.code === "23505") {
          throw new ApiError("CONFLICT",
            `You have already graded ${t.ref}. A reviewer marks a call once — withdraw the first `
            + "mark if it was wrong and raise a new one.", 409);
        }
        throw guardRefusal(err, "The mark was refused by the register.") ?? err;
      }
    });
  });

  /**
   * The graded seat's answer, once. It goes on the row that carries the mark so an appeal can
   * never be read apart from the thing it appeals, and the mark cannot be re-ticked underneath
   * it — that is 126's `review_answer_is_kept`, and the reason the route reads the row first is
   * only to say who the answer came from.
   */
  app.post("/control/service/quality/:id/response",
    { preHandler: [requireControl] }, async (req: any) => {
      await enforceRateLimit(`service-quality-answer:${req.control.user_id}`, 30, 3600);
      const id = uuidOf(req.params.id, "review");
      const body = z.object({
        response: z.string().trim().min(4).max(1200),
        seat: z.string().uuid().optional()
      }).strict().parse(req.body);
      const tenant = tenantOf(req);
      // Either the graded seat answers its own mark, or a service desk records what the seat said.
      // A desk that can do neither of those things has no business writing on a person's grade,
      // so the floor is one of the two service duties — and the row-level check below is what
      // keeps a supervisor from answering an appeal in somebody else's voice.
      const held = await controlHolds(req, [REVIEW, MANAGE]);
      if (!held.length) {
        throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
      }

      return withTenant(tenant, async (c) => {
        const found = await c.query(`
          select q.id, q.ticket_ref, q.reviewed_seat, q.reviewed_by, q.responded_at,
                 q.withdrawn_at, q.result, q.score, q.agent_response,
                 su.full_name as seat_name
            from service_quality_reviews q
            left join users su on su.id = q.reviewed_seat
           where q.id = $1 and q.tenant_id = $2`, [id, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such review.", 404);
        const row = found.rows[0];
        if (row.withdrawn_at) {
          throw new ApiError("CONFLICT",
            `The mark on ${row.ticket_ref} was withdrawn, and a withdrawn review stays off the `
            + "board. There is nothing to answer.", 409);
        }
        if (row.responded_at) {
          throw new ApiError("CONFLICT",
            `${row.ticket_ref} has already been answered by the seat. An answer is given once.`, 409);
        }
        const self = row.reviewed_seat === req.control.user_id;
        if (!self && !body.seat) {
          throw new ApiError("FORBIDDEN",
            `This mark sits on ${row.seat_name ?? "another seat"}, not on you. A desk recording `
            + "what the seat said has to name that seat.", 403);
        }
        if (body.seat && body.seat !== row.reviewed_seat) {
          throw new ApiError("CONFLICT",
            "That is not the seat this mark was given to.", 409);
        }
        const made = await c.query(ANSWER_QUALITY_SQL, [id, tenant, body.response]);
        if (!made.rowCount) {
          throw new ApiError("CONFLICT", "That mark changed under this call. Nothing was written.", 409);
        }
        await audit(c, req, "service_quality_reviews", id, "control.service.review_answered",
          { ticket_ref: row.ticket_ref, response: null },
          { response: body.response, recorded_by: self ? "the seat" : "the desk",
            seat: row.reviewed_seat });
        return made.rows[0];
      });
    });

  /** Take a mark off the board. A door, not a corridor: the score stops counting in the roll-up
   *  and the row itself stays, because a mark that was given and then thought better of is part
   *  of what the office did. */
  app.post("/control/service/quality/:id/withdraw",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, REVIEW);
      await enforceRateLimit(`service-quality-withdraw:${req.control.user_id}`, 20, 3600);
      const id = uuidOf(req.params.id, "review");
      const body = z.object({ reason: REASON }).strict().parse(req.body);
      const tenant = tenantOf(req);
      return withTenant(tenant, async (c) => {
        const found = await c.query(`
          select id, ticket_ref, withdrawn_at, result, score from service_quality_reviews
           where id = $1 and tenant_id = $2`, [id, tenant]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such review.", 404);
        const gone = await c.query(WITHDRAW_QUALITY_SQL, [id, tenant, req.control.user_id]);
        if (!gone.rowCount) {
          throw new ApiError("CONFLICT",
            `${found.rows[0].ticket_ref} is already withdrawn — a withdrawn review stays withdrawn.`, 409);
        }
        await audit(c, req, "service_quality_reviews", id, "control.service.review_withdrawn",
          { ticket_ref: found.rows[0].ticket_ref, result: found.rows[0].result,
            score: found.rows[0].score },
          { withdrawn_at: gone.rows[0].withdrawn_at, reason: body.reason });
        return gone.rows[0];
      });
    });

  // ============================================================
  // the CSV every tab is asked to carry
  // ============================================================

  app.get("/control/service/export", { preHandler: [requireControl] }, async (req: any, reply) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`service-export:${req.control.user_id}`, 12, 3600);
    const q = z.object({
      register: z.enum(REGISTERS),
      status: z.string().trim().max(32).optional(),
      ground: z.string().trim().max(32).optional(),
      seat: z.string().uuid().optional(),
      search: SEARCH
    }).strict().parse(req.query ?? {});

    // The word a filter box sends is checked against the register it belongs to, because a
    // typo in a status is not a server error — it is an empty CSV, and a desk that exports an
    // empty file believes the register is empty.
    const STATES: Record<(typeof REGISTERS)[number], readonly string[]> = {
      disputes: DISPUTE_STATUSES, refunds: REFUND_STATUSES,
      satisfaction: ["unanswered", "answered", "low", "good"], quality: RESULTS
    };
    const state = !q.status || q.status === "all" ? null : q.status;
    if (state && !STATES[q.register].includes(state)) {
      throw new ApiError("VALIDATION_FAILED",
        `${q.register} has no state "${state}". It has: ${STATES[q.register].join(", ")}.`, 400,
        [{ field: "status" }]);
    }
    if (q.ground && q.ground !== "all" && !GROUNDS.includes(q.ground as typeof GROUNDS[number])) {
      throw new ApiError("VALIDATION_FAILED",
        `No dispute is raised on the ground "${q.ground}". It has: ${GROUNDS.join(", ")}.`, 400,
        [{ field: "ground" }]);
    }
    const tenant = tenantOf(req);

    const head: Record<(typeof REGISTERS)[number], string[]> = {
      disputes: ["ref", "status", "ground", "ticket_ref", "company_name", "amount", "currency",
        "claim", "opened_name", "opened_at", "outcome", "decided_name", "decided_at",
        "refund_ref", "refund_status"],
      refunds: REFUND_HEAD,
      satisfaction: ["ticket_ref", "company_name", "asked_at", "asked_name", "asked_channel",
        "score", "recommends", "word", "answered_at"],
      quality: ["ticket_ref", "seat_name", "reviewer_name", "reviewed_at", "score", "result",
        "answered_the_caller", "identity_confirmed", "right_desk", "action_offered",
        "words_suitable", "settled_with_answer", "note", "agent_response", "withdrawn_at"]
    };
    const rows = q.register === "refunds"
      ? await refundRows(tenant, state, q.search || null)
      : (await withTenant(tenant, (c) => c.query(
        { disputes: DISPUTES_EXPORT_SQL, satisfaction: SATISFACTION_EXPORT_SQL,
          quality: QUALITY_EXPORT_SQL }[q.register as "disputes" | "satisfaction" | "quality"],
        q.register === "disputes"
          ? [tenant, state, q.ground && q.ground !== "all" ? q.ground : null, q.search || null]
          : q.register === "quality"
            ? [tenant, state, q.seat ?? null, q.search || null]
            : [tenant, state, q.search || null]))).rows;
    reply.header("Content-Disposition",
      `attachment; filename="service-${q.register}-${new Date().toISOString().slice(0, 10)}.csv"`);
    reply.type("text/csv; charset=utf-8");
    return csv(head[q.register], rows);
  });
}
