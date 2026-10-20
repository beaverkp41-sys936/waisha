import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { ProofRejected, readProof } from "../util/geo-proof.js";
import { sniffFileType } from "../util/upload.js";
import { storageConfigured, putObject, signObject, StorageUnavailableError } from "../storage/supabase.js";
import { sanitizeFileName } from "./documents.routes.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission, checkPermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeOnly = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const stamp = z.string().datetime();
const DAY_STATUSES = ["present", "late", "half_day", "absent", "on_leave", "holiday"] as const;
const LEAVE_KINDS = ["annual", "sick", "bereavement", "maternity", "paternity", "unpaid", "other"] as const;

const clockSchema = z.object({
  employeeId: z.string().uuid().optional(),
  // Honouring a caller-supplied time is a correction, and corrections live in
  // attendance.edit. Self-clocking is stamped by the server clock, which is the
  // only reason the register can be trusted.
  at: stamp.optional()
});

const daySchema = z.object({
  employeeId: z.string().uuid(),
  workDate: dateOnly,
  dayStatus: z.enum(DAY_STATUSES),
  clockIn: stamp.nullable().optional(),
  clockOut: stamp.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
});

const attendanceUpdateSchema = z.object({
  workDate: dateOnly.optional(),
  dayStatus: z.enum(DAY_STATUSES).optional(),
  clockIn: stamp.nullable().optional(),
  clockOut: stamp.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
});

const leaveSchema = z.object({
  employeeId: z.string().uuid().optional(),
  leaveKind: z.enum(LEAVE_KINDS),
  startsOn: dateOnly,
  endsOn: dateOnly,
  reason: z.string().trim().max(500).nullable().optional()
});

const leaveUpdateSchema = leaveSchema.partial();

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).nullable().optional()
});

const settingsSchema = z.object({
  workStart: timeOnly,
  workEnd: timeOnly,
  lateGraceMinutes: z.number().int().min(0).max(120),
  annualLeaveDays: z.number().int().min(0).max(60),
  timezone: z.string().trim().max(60)
});

const LINE_SELECT_SQL = `a.id, a.employee_id, e.full_name, e.job_title, e.department,
  e.employment_type, a.work_date::text as work_date, a.day_status,
  a.clock_in, a.clock_out, a.minutes_late, a.note,
  a.confirmed_at, a.proof_kind, a.proof_accuracy_m, a.proof_document_id,
  (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked`;

/** The same cap @fastify/multipart is mounted with, so an over-size file is refused here
 *  with a sentence rather than as a parser error. */
const PROOF_MAX_BYTES = 8 * 1024 * 1024;
const PROOF_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];

const PROOF_REJECTIONS: Record<string, string> = {
  "proof": "Say how the day is confirmed — with the device's location or with a photograph.",
  "lat": "The device did not report a latitude a confirmation can be made of.",
  "lng": "The device did not report a longitude a confirmation can be made of.",
  "accuracyM": "The accuracy figure has to be between 0 and 20 000 metres.",
  "location-has-no-position": "The device reported no position. Take a photograph instead.",
  "photo-has-coordinates": "A photograph is the proof on its own — send a picture or a location, not both."
};

function isClash(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "23505";
}

function hours(value: unknown): number | null {
  return value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100;
}

/**
 * The company's own calendar. Render runs its servers in UTC while a working day
 * is spoken of in wall-clock terms, so "today", "late" and the weekday test are
 * read through office_settings.timezone — never through the server clock. A
 * company with no settings row yet is judged against the defaults 065 gives.
 */
async function companyDay(c: PoolClient, tenantId: string) {
  const { rows } = await c.query(
    `select coalesce(s.work_start, time '08:00')::text as work_start,
            coalesce(s.work_end, time '17:00')::text as work_end,
            coalesce(s.late_grace_minutes, 15)::int as late_grace_minutes,
            coalesce(s.annual_leave_days, 28)::int as annual_leave_days,
            coalesce(s.timezone, 'Africa/Dar_es_Salaam') as timezone,
            (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date::text as today,
            extract(isodow from timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::int as isodow,
            (s.tenant_id is not null) as saved
       from (values (1)) v
       left join office_settings s on s.tenant_id = $1`,
    [tenantId]);
  const r = rows[0];
  return {
    workStart: String(r.work_start).slice(0, 5),
    workEnd: String(r.work_end).slice(0, 5),
    grace: Number(r.late_grace_minutes),
    annualLeaveDays: Number(r.annual_leave_days),
    zone: r.timezone as string,
    today: r.today as string,
    isWeekday: Number(r.isodow) <= 5,
    saved: r.saved as boolean
  };
}

/** The same instant read as a working day over there. */
async function localDate(c: PoolClient, zone: string, at: Date): Promise<string> {
  const { rows } = await c.query(
    `select (timezone($1, $2::timestamptz))::date::text as d`, [zone, at.toISOString()]);
  return rows[0].d;
}

/** Monday to Friday, counted on the date itself rather than on the clock. */
async function isWorkingDay(c: PoolClient, day: string): Promise<boolean> {
  const { rows } = await c.query(`select extract(isodow from $1::date)::int as d`, [day]);
  return Number(rows[0].d) <= 5;
}

async function findOwnEmployee(c: PoolClient, tenantId: string, userId: string) {
  const { rows } = await c.query(
    `select id, full_name, status, user_id, supervisor_id, leave_approver_user_id from employees
      where tenant_id = $1 and user_id = $2 and deleted_at is null
      order by created_at limit 1`,
    [tenantId, userId]);
  return rows[0] ?? null;
}

type LeaveRoute = { to: string | null; reason: string; note: string | null };

/**
 * Whose desk a leave request lands on.
 *
 * 065 answered any request from anybody holding leave.decide, which meant every director and
 * every HR officer could answer every request and no particular person was expected to. This
 * picks one: the seat the office assigned, then the seat of the person named above them, then
 * the office. It is resolved once, at the moment the ask is made, and written onto the row —
 * re-pointing an approver next month must not quietly move a queue that was raised under the
 * old assignment.
 *
 * The person's own seat is never a candidate even when the office has named it, because 108
 * refuses that decision outright; letting a request arrive already undecidable would be a bug
 * dressed as data.
 */
async function resolveLeaveRoute(
  c: PoolClient, tenantId: string,
  emp: { name: string; user_id: string | null; supervisor_id: string | null; leave_approver_user_id: string | null },
  startsOn: string, endsOn: string
): Promise<LeaveRoute> {
  const chain: { id: string; reason: string }[] = [];
  if (emp.leave_approver_user_id && emp.leave_approver_user_id !== emp.user_id) {
    chain.push({ id: emp.leave_approver_user_id, reason: "assigned" });
  }
  if (emp.supervisor_id) {
    const sup = await c.query(
      `select user_id from employees
        where id = $1 and tenant_id = $2 and deleted_at is null and status = 'active' and user_id is not null`,
      [emp.supervisor_id, tenantId]);
    const above = sup.rows[0]?.user_id as string | undefined;
    if (above && above !== emp.user_id && !chain.some(x => x.id === above)) {
      chain.push({ id: above, reason: "supervisor" });
    }
  }
  if (!chain.length) {
    return { to: null, reason: "office", note: `${emp.name} has no approver assigned, so the office decides.` };
  }
  const seats = await c.query(
    `select id, full_name from users
      where id = any($1::uuid[]) and tenant_id = $2 and status = 'active' and deleted_at is null`,
    [chain.map(x => x.id), tenantId]);
  const live = new Map<string, string>(seats.rows.map((r: any) => [r.id, r.full_name]));
  const picked = chain.find(x => live.has(x.id));
  if (!picked) {
    return { to: null, reason: "office", note: "The seat named as the approver is not answering any more, so the office decides." };
  }
  // A request that is sent to somebody who is themselves away for those days does not get
  // answered twice as fast; it gets answered after they come back.
  const away = await c.query(
    `select 1 from leave_requests l
       join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
      where l.tenant_id = $1 and e.user_id = $2 and e.deleted_at is null
        and l.status = 'approved' and l.deleted_at is null
        and l.starts_on <= $4::date and l.ends_on >= $3::date
      limit 1`,
    [tenantId, picked.id, startsOn, endsOn]);
  if (away.rowCount) {
    return {
      to: null, reason: "office",
      note: `${live.get(picked.id)} is on approved leave across those days, so the office decides.`
    };
  }
  return { to: picked.id, reason: picked.reason, note: null };
}

const LEAVE_ROUTE_LABELS: Record<string, string> = {
  assigned: "the assigned approver", supervisor: "their supervisor",
  office: "the office", escalated: "the office, after an escalation"
};

/** The routing columns every leave read has to carry for the chain to be legible. */
const LEAVE_ROUTE_SQL = `l.routed_to_user_id, ru.full_name as routed_to_name,
  l.routed_reason, l.routed_note,
  l.escalated_at, l.escalated_by, eu.full_name as escalated_by_name,
  l.escalated_from, fu.full_name as escalated_from_name`;

const LEAVE_ROUTE_JOINS = `left join users ru on ru.id = l.routed_to_user_id and ru.tenant_id = l.tenant_id
           left join users eu on eu.id = l.escalated_by and eu.tenant_id = l.tenant_id
           left join users fu on fu.id = l.escalated_from and fu.tenant_id = l.tenant_id`;

/**
 * Whose day or whose request is being written. A sign-in with no staff record
 * behind it cannot clock in, and writing for somebody else needs the desk
 * permission — otherwise every employee could fill the register for the company.
 */
async function resolveTarget(
  c: PoolClient, tenantId: string, userId: string,
  employeeId: string | undefined, deskPermission: string
) {
  const own = await findOwnEmployee(c, tenantId, userId);
  if (!employeeId) {
    if (!own) {
      throw new ApiError("VALIDATION_FAILED",
        "This sign-in is not linked to a staff record yet. The office has to add the person to the employees register and connect the account.",
        400, [{ field: "employeeId" }]);
    }
    return {
      id: own.id as string, name: own.full_name as string, isOwn: true, status: own.status as string,
      user_id: own.user_id ?? null, supervisor_id: own.supervisor_id ?? null,
      leave_approver_user_id: own.leave_approver_user_id ?? null
    };
  }
  const { rows } = await c.query(
    `select id, full_name, status, user_id, supervisor_id, leave_approver_user_id from employees
      where id = $1 and tenant_id = $2 and deleted_at is null`,
    [employeeId, tenantId]);
  if (!rows.length) {
    throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
  }
  const isOwn = employeeId === own?.id;
  if (!isOwn && !await checkPermission(c, userId, deskPermission)) {
    throw new ApiError("FORBIDDEN", "Recording another person's time is done by the office.", 403);
  }
  return {
    id: employeeId, name: rows[0].full_name as string, isOwn, status: rows[0].status as string,
    user_id: rows[0].user_id ?? null, supervisor_id: rows[0].supervisor_id ?? null,
    leave_approver_user_id: rows[0].leave_approver_user_id ?? null
  };
}

function assertWorking(target: { name: string; status: string }) {
  if (target.status !== "active") {
    throw new ApiError("CONFLICT", `${target.name} is not an active member of staff.`, 409);
  }
}

function assertSpan(from: string, to: string, maxDays: number, field: string) {
  if (from > to) {
    throw new ApiError("VALIDATION_FAILED", "The end is before the start.", 400, [{ field }]);
  }
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (span > maxDays) {
    throw new ApiError("VALIDATION_FAILED",
      `That period is longer than ${maxDays} days. Ask for a shorter one so it stays readable.`,
      400, [{ field }]);
  }
}

export async function attendanceRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The daily register ----------

  /** Who is in: one line per active employee, with the day's stamp and approved leave. */
  app.get("/attendance/today", { preHandler: [requireAuth, requirePermission("attendance.view")] },
    async (req: any) => {
      const q = z.object({ day: dateOnly.optional() }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const day = await companyDay(c, req.user.tid);
        const workDate = q.day ?? day.today;
        if (workDate > day.today) {
          throw new ApiError("VALIDATION_FAILED", "A day that has not arrived yet has no register.", 400,
            [{ field: "day" }]);
        }
        const { rows } = await c.query(
          `select e.id as employee_id, e.full_name, e.job_title, e.department, e.employment_type,
                  e.user_id is not null as has_account,
                  a.id as attendance_id, a.day_status, a.clock_in, a.clock_out,
                  a.minutes_late, a.note,
                  a.confirmed_at, a.proof_kind, a.proof_accuracy_m, a.proof_document_id,
                  (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked,
                  lr.id as leave_id, lr.leave_kind, lr.status as leave_status,
                  lr.starts_on::text as leave_starts_on, lr.ends_on::text as leave_ends_on
             from employees e
             left join employee_attendance a
               on a.tenant_id = e.tenant_id and a.employee_id = e.id
              and a.deleted_at is null and a.work_date = $2::date
             left join leave_requests lr
               on lr.tenant_id = e.tenant_id and lr.employee_id = e.id
              and lr.deleted_at is null and lr.status = 'approved'
              and $2::date between lr.starts_on and lr.ends_on
            where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
            order by e.full_name`,
          [req.user.tid, workDate]);
        return {
          // The card speaks of the day on the screen, not of today: browsing back
          // to a Wednesday must not call it the Saturday it is seen from.
          day: { ...day, isWeekday: await isWorkingDay(c, workDate) },
          workDate,
          rows: rows.map((r: any) => ({ ...r, hours_worked: hours(r.hours_worked) }))
        };
      });
    });

  /** One person's own recent time and leave — the staff-facing screen. */
  app.get("/attendance/me", { preHandler: [requireAuth, requirePermission("attendance.view")] },
    async (req: any) => {
      const q = z.object({ days: z.coerce.number().int().min(1).max(60).default(14) }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const day = await companyDay(c, req.user.tid);
        const own = await findOwnEmployee(c, req.user.tid, req.user.sub);
        if (!own) return { linked: false, day };
        const from = new Date(Date.parse(`${day.today}T00:00:00Z`) - (q.days - 1) * 86_400_000)
          .toISOString().slice(0, 10);
        const attendance = await c.query(
          `select a.id, a.work_date::text as work_date, a.day_status, a.clock_in, a.clock_out,
                  a.minutes_late, a.note, a.confirmed_at, a.proof_kind, a.proof_accuracy_m,
                  a.proof_document_id,
                  a.proof_lat, a.proof_lng,
                  (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked
             from employee_attendance a
            where a.tenant_id = $1 and a.employee_id = $2 and a.deleted_at is null
              and a.work_date between $3::date and $4::date
            order by a.work_date desc`,
          [req.user.tid, own.id, from, day.today]);
        const leave = await c.query(
          `select l.id, l.leave_kind, l.starts_on::text as starts_on, l.ends_on::text as ends_on,
                  l.working_days, l.status, l.reason, l.decision_note,
                  l.routed_reason, l.routed_note, l.escalated_at, ru.full_name as routed_to_name
             from leave_requests l
             ${LEAVE_ROUTE_JOINS}
            where l.tenant_id = $1 and l.employee_id = $2 and l.deleted_at is null
              and (l.status = 'pending' or l.ends_on >= $3::date)
            order by l.starts_on desc limit 40`,
          [req.user.tid, own.id, from]);
        const year = Number(day.today.slice(0, 4));
        const used = await c.query(
          `select coalesce(sum(working_days), 0)::int as days
             from leave_requests
            where tenant_id = $1 and employee_id = $2 and deleted_at is null
              and status = 'approved' and leave_kind = 'annual'
              and extract(year from starts_on) = $3::int`,
          [req.user.tid, own.id, year]);
        const annualUsed = Number(used.rows[0]?.days ?? 0);
        return {
          linked: true, day, employee: own,
          // numeric(9,6) comes back as "-6.792000"; a card that says the position was kept to
          // about 100 m cannot show six decimals to prove it. Same shape as the other two reads.
          attendance: attendance.rows.map((r: any) => ({
            ...r, hours_worked: hours(r.hours_worked),
            proof_lat: r.proof_lat === null ? null : Number(r.proof_lat),
            proof_lng: r.proof_lng === null ? null : Number(r.proof_lng)
          })),
          leave: leave.rows,
          annual: {
            year, entitlement: day.annualLeaveDays, used: annualUsed,
            remaining: day.annualLeaveDays - annualUsed
          }
        };
      });
    });

  /** A period: the lines, the per-person totals, and the leave that overlaps it. */
  app.get("/attendance", { preHandler: [requireAuth, requirePermission("attendance.view")] },
    async (req: any) => {
      const q = z.object({
        from: dateOnly.optional(), to: dateOnly.optional(),
        employeeId: z.string().uuid().optional(),
        status: z.enum(DAY_STATUSES).optional()
      }).parse(req.query);

      return withTenant(req.user.tid, async (c) => {
        const day = await companyDay(c, req.user.tid);
        const from = q.from ?? `${day.today.slice(0, 8)}01`;
        const to = q.to ?? day.today;
        assertSpan(from, to, 92, "from");

        const lines = await c.query(
          `select ${LINE_SELECT_SQL}
             from employee_attendance a
             join employees e on e.id = a.employee_id
            where a.tenant_id = $1 and a.deleted_at is null
              and a.work_date between $2::date and $3::date
              and ($4::uuid is null or a.employee_id = $4)
              and ($5::text is null or a.day_status = $5)
            order by a.work_date desc, e.full_name
            limit 3000`,
          [req.user.tid, from, to, q.employeeId ?? null, q.status ?? null]);

        const totals = await c.query(
          `select a.employee_id, e.full_name,
                  count(*)::int as days,
                  count(*) filter (where a.day_status in ('present','late'))::int as present_days,
                  count(*) filter (where a.day_status = 'late')::int as late_days,
                  count(*) filter (where a.day_status = 'half_day')::int as half_days,
                  count(*) filter (where a.day_status = 'absent')::int as absent_days,
                  count(*) filter (where a.day_status = 'on_leave')::int as leave_days,
                  count(*) filter (where a.day_status = 'holiday')::int as holiday_days,
                  count(*) filter (where a.clock_in is not null)::int as clocked_days,
                  coalesce(sum(a.minutes_late), 0)::int as minutes_late,
                  coalesce(sum(extract(epoch from (a.clock_out - a.clock_in))), 0)::float8 / 3600 as hours_worked
             from employee_attendance a
             join employees e on e.id = a.employee_id
            where a.tenant_id = $1 and a.deleted_at is null
              and a.work_date between $2::date and $3::date
              and ($4::uuid is null or a.employee_id = $4)
            group by a.employee_id, e.full_name
            order by e.full_name`,
          [req.user.tid, from, to, q.employeeId ?? null]);

        const leave = await c.query(
          `select l.id, l.employee_id, e.full_name, l.leave_kind, l.status,
                  l.starts_on::text as starts_on, l.ends_on::text as ends_on, l.working_days
             from leave_requests l
             join employees e on e.id = l.employee_id
            where l.tenant_id = $1 and l.deleted_at is null
              and l.status in ('pending','approved')
              and l.starts_on <= $3::date and l.ends_on >= $2::date
            order by l.starts_on`,
          [req.user.tid, from, to]);

        return {
          day, range: { from, to },
          lines: lines.rows.map((r: any) => ({ ...r, hours_worked: hours(r.hours_worked) })),
          totals: (totals.rows as any[]).map((r) => ({
            ...r,
            hours_worked: Math.round(Number(r.hours_worked) * 10) / 10,
            punctuality: Number(r.clocked_days) > 0
              ? Math.round((1 - Number(r.late_days) / Number(r.clocked_days)) * 1000) / 10
              : null
          })),
          leave: leave.rows
        };
      });
    });

  // ---------- Clocking ----------

  app.post("/attendance/clock-in", { preHandler: [requireAuth, requirePermission("attendance.clock")] },
    async (req: any, reply) => {
      const body = clockSchema.parse(req.body ?? {});
      try {
        const result = await withTenant(req.user.tid, async (c) => {
          const day = await companyDay(c, req.user.tid);
          const target = await resolveTarget(c, req.user.tid, req.user.sub, body.employeeId, "attendance.edit");
          assertWorking(target);
          if (body.at && !await checkPermission(c, req.user.sub, "attendance.edit")) {
            throw new ApiError("FORBIDDEN", "Only the office can set a time that has already passed.", 403);
          }
          const at = body.at ? new Date(body.at) : new Date();
          const workDate = await localDate(c, day.zone, at);
          if (workDate > day.today) {
            throw new ApiError("VALIDATION_FAILED", "Nobody can be clocked in for a day that has not arrived yet.",
              400, [{ field: "at" }]);
          }

          const prev = await c.query(
            `select id, clock_in, clock_out, day_status from employee_attendance
              where tenant_id = $1 and employee_id = $2 and work_date = $3::date and deleted_at is null`,
            [req.user.tid, target.id, workDate]);
          let id: string;
          if (prev.rowCount) {
            if (prev.rows[0].clock_in) {
              throw new ApiError("CONFLICT", "This person is already clocked in for that day. Use clock-out.", 409);
            }
            id = prev.rows[0].id;
            await c.query(
              `update employee_attendance
                  set clock_in = $2, day_status = 'present', note = coalesce(note, $3),
                      updated_by = $4, updated_at = now()
                where id = $1 and tenant_id = $5`,
              [id, at.toISOString(),
               `Clocked in by ${target.isOwn ? "themselves" : "the office"}`, req.user.sub, req.user.tid]);
          } else {
            id = uuidv7();
            await c.query(
              `insert into employee_attendance
                 (id, tenant_id, employee_id, work_date, clock_in, day_status, note, created_by, updated_by)
               values ($1, $2, $3, $4::date, $5, 'present', $6, $7, $7)`,
              [id, req.user.tid, target.id, workDate, at.toISOString(),
               target.isOwn ? "Self clock-in" : "Clocked in by the office", req.user.sub]);
          }
          const saved = await c.query(
            `select work_date::text as work_date, day_status, clock_in, clock_out, minutes_late
               from employee_attendance where id = $1 and tenant_id = $2`,
            [id, req.user.tid]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "employee_attendance", entityId: id,
            action: "attendance.clocked_in",
            after: { employeeId: target.id, workDate, at: at.toISOString(), forSelf: target.isOwn }
          });
          return { id, ...saved.rows[0], day };
        });
        return reply.status(201).send(result);
      } catch (e) {
        if (isClash(e)) throw new ApiError("CONFLICT", "That day is already recorded for this person.", 409);
        throw e;
      }
    });

  app.post("/attendance/clock-out", { preHandler: [requireAuth, requirePermission("attendance.clock")] },
    async (req: any) => {
      const body = clockSchema.parse(req.body ?? {});
      return withTenant(req.user.tid, async (c) => {
        const day = await companyDay(c, req.user.tid);
        const target = await resolveTarget(c, req.user.tid, req.user.sub, body.employeeId, "attendance.edit");
        assertWorking(target);
        if (body.at && !await checkPermission(c, req.user.sub, "attendance.edit")) {
          throw new ApiError("FORBIDDEN", "Only the office can set a time that has already passed.", 403);
        }
        const at = body.at ? new Date(body.at) : new Date();
        const workDate = await localDate(c, day.zone, at);

        const prev = await c.query(
          `select id, clock_in, clock_out from employee_attendance
            where tenant_id = $1 and employee_id = $2 and work_date = $3::date and deleted_at is null`,
          [req.user.tid, target.id, workDate]);
        if (!prev.rowCount || !prev.rows[0].clock_in) {
          throw new ApiError("CONFLICT", "There is no open clock-in for that day, so there is nothing to close.", 409);
        }
        if (prev.rows[0].clock_out) {
          throw new ApiError("CONFLICT", "That day is already closed.", 409);
        }
        if (at.getTime() <= new Date(prev.rows[0].clock_in).getTime()) {
          throw new ApiError("VALIDATION_FAILED", "The clock-out is before the clock-in.", 400, [{ field: "at" }]);
        }
        const id = prev.rows[0].id;
        await c.query(
          `update employee_attendance set clock_out = $2, updated_by = $3, updated_at = now()
            where id = $1 and tenant_id = $4`,
          [id, at.toISOString(), req.user.sub, req.user.tid]);
        const saved = await c.query(
          `select work_date::text as work_date, day_status, clock_in, clock_out, minutes_late,
                  (extract(epoch from (clock_out - clock_in)) / 3600)::float8 as hours_worked
             from employee_attendance where id = $1 and tenant_id = $2`,
          [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "employee_attendance", entityId: id,
          action: "attendance.clocked_out",
          before: { clockIn: prev.rows[0].clock_in },
          after: { employeeId: target.id, workDate, at: at.toISOString() }
        });
        const row = saved.rows[0];
        return { ...row, id, hours_worked: hours(row.hours_worked) };
      });
    });

  /**
   * "I am at work today" — proved by the device's position or by a photograph (task #182).
   *
   * Only ever the caller's own day: a confirmation is a statement about where *you* were, so
   * holding the desk key for other people is no reason to be able to press their button. The
   * clock stays the server's for the same reason the clock-in's is. Both proofs ride with the
   * day in one request, because a photograph filed on its own is a file with no story, and a
   * confirmation that lost its upload would be a person told they were not at work.
   */
  app.post("/attendance/confirm", { preHandler: [requireAuth, requirePermission("attendance.clock")] },
    async (req: any, reply) => {
      await enforceRateLimit(`attendance-confirm:uid:${req.user.sub}`, 20, 3600);

      let fields: Record<string, unknown> = (req.body ?? {}) as Record<string, unknown>;
      let upload: { bytes: Buffer; filename: string; mimetype: string; cutShort: boolean } | null = null;
      if (typeof req.isMultipart === "function" && req.isMultipart()) {
        const data = await req.file();
        if (!data) {
          throw new ApiError("VALIDATION_FAILED", "Attach the photograph to the confirmation.", 400,
            [{ field: "file" }]);
        }
        const bytes = await data.toBuffer();
        const f = (data.fields ?? {}) as Record<string, { value?: unknown }>;
        // A multipart confirmation is the photograph's shape, but the fields are read in full
        // rather than cherry-picked: a form that carried both a picture and a position has to be
        // refused by name, and one that carried a position and no picture has to be refused for
        // the file. Silently dropping the numbers would store a story the person never told.
        // Hence the order: the body is drained before the fields are read, so a client that put
        // its metadata after the file part is answered from what it actually sent, not from
        // whichever chunk happened to arrive first.
        fields = {
          proof: f.proof?.value, lat: f.lat?.value, lng: f.lng?.value,
          accuracyM: f.accuracyM?.value
        };
        upload = {
          bytes,
          filename: data.filename || "photo",
          mimetype: (data.mimetype || "").toLowerCase(),
          // The plugin stops reading at its own 8 MB and hands back what got through, so a
          // nine-megabyte camera roll arrives here as a truncated file of exactly the cap. Its
          // length then looks lawful and its bytes fail the sniff, and the person is told their
          // photograph is not an image. The flag is the truth about what was sent.
          cutShort: Boolean((data as any).file?.truncated)
        };
      }

      let proof: ReturnType<typeof readProof>;
      try {
        proof = readProof(fields);
      } catch (e) {
        if (e instanceof ProofRejected) {
          throw new ApiError("VALIDATION_FAILED",
            PROOF_REJECTIONS[e.reason] ?? "The proof is not usable.", 400, [{ field: e.reason }]);
        }
        throw e;
      }

      if (proof.kind === "photo") {
        if (!upload) {
          throw new ApiError("VALIDATION_FAILED", "Attach the photograph to the confirmation.", 400,
            [{ field: "file" }]);
        }
        if (!storageConfigured()) {
          throw new ApiError("STORAGE_UNAVAILABLE",
            "Photographs cannot be filed yet — the file store is not configured.", 503);
        }
        if (upload.bytes.length === 0) {
          throw new ApiError("VALIDATION_FAILED", "The photograph is empty.", 400, [{ field: "file" }]);
        }
        if (upload.cutShort || upload.bytes.length > PROOF_MAX_BYTES) {
          throw new ApiError("VALIDATION_FAILED", "A confirmation photograph is limited to 8 MB.",
            400, [{ field: "file" }]);
        }
        if (!PROOF_IMAGE_MIMES.includes(upload.mimetype)) {
          throw new ApiError("VALIDATION_FAILED", "The photograph has to be a JPEG, PNG or WebP image.",
            400, [{ field: "file" }]);
        }
        // The browser's declared type is not evidence — the bytes decide.
        if (sniffFileType(upload.bytes) !== upload.mimetype) {
          throw new ApiError("VALIDATION_FAILED",
            "The file is not the image its name claims.", 400, [{ field: "file" }]);
        }
      } else if (upload) {
        throw new ApiError("VALIDATION_FAILED", "A location confirmation carries no file.", 400,
          [{ field: "file" }]);
      }

      const result = await withTenant(req.user.tid, async (c) => {
        const day = await companyDay(c, req.user.tid);
        const own = await findOwnEmployee(c, req.user.tid, req.user.sub);
        if (!own) {
          throw new ApiError("VALIDATION_FAILED",
            "This sign-in is not linked to a staff record yet. The office has to add the person to the employees register and connect the account.",
            400, [{ field: "employeeId" }]);
        }
        assertWorking({ name: own.full_name, status: own.status });

        const at = new Date();
        const workDate = await localDate(c, day.zone, at);
        const prev = await c.query(
          `select id, clock_in, day_status, confirmed_at from employee_attendance
            where tenant_id = $1 and employee_id = $2 and work_date = $3::date and deleted_at is null`,
          [req.user.tid, own.id, workDate]);
        if (prev.rowCount && prev.rows[0].confirmed_at) {
          throw new ApiError("CONFLICT",
            "This day is already confirmed — its proof is on the register.", 409);
        }
        // A stated absence, a leave day or a holiday is the office's finding about the day,
        // and a clock-in with a picture would contradict it in silence. Say so instead.
        if (prev.rowCount && !prev.rows[0].clock_in
          && !["present", "late", "half_day"].includes(prev.rows[0].day_status)) {
          throw new ApiError("CONFLICT",
            `The office has already stated this day as ${String(prev.rows[0].day_status).replace("_", " ")}. `
            + "Ask them to correct it first.", 409);
        }

        let documentId: string | null = null;
        if (proof.kind === "photo" && upload) {
          documentId = uuidv7();
          const fileName = sanitizeFileName(upload.filename);
          const storagePath = `${req.user.tid}/employee/${own.id}/${documentId}-${fileName}`;
          try {
            await putObject(storagePath, upload.bytes, upload.mimetype);
          } catch (e) {
            if (e instanceof StorageUnavailableError) {
              throw new ApiError("STORAGE_UNAVAILABLE",
                "Photographs cannot be filed yet — the file store is not configured.", 503);
            }
            req.log.error(e, "attendance proof upload failed");
            throw new ApiError("INTERNAL", "The photograph could not be stored. Try again.", 502);
          }
          await c.query(
            `insert into documents (id, tenant_id, entity_type, entity_id, kind,
               file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
             values ($1,$2,'employee',$3,'attendance_proof',$4,$5,$6,$7,$8,$8,$8)`,
            [documentId, req.user.tid, own.id, fileName, upload.mimetype,
             upload.bytes.length, storagePath, req.user.sub]);
        }

        let id: string;
        if (prev.rowCount) {
          id = prev.rows[0].id;
          // An open clock is left alone; a day that was stated with no stamp gets one, so the
          // lateness trigger reads the confirmation exactly as it reads a plain clock-in.
          await c.query(
            `update employee_attendance
                set clock_in = coalesce(clock_in, $2),
                    confirmed_at = $2, confirmed_by = $3,
                    proof_kind = $4, proof_lat = $5, proof_lng = $6,
                    proof_accuracy_m = $7, proof_document_id = $8,
                    updated_by = $3, updated_at = now()
              where id = $1 and tenant_id = $9`,
            [id, at.toISOString(), req.user.sub, proof.kind, proof.lat, proof.lng,
             proof.accuracyM, documentId, req.user.tid]);
        } else {
          id = uuidv7();
          await c.query(
            `insert into employee_attendance
               (id, tenant_id, employee_id, work_date, clock_in, day_status, note,
                confirmed_at, confirmed_by, proof_kind, proof_lat, proof_lng,
                proof_accuracy_m, proof_document_id, created_by, updated_by)
             values ($1,$2,$3,$4::date,$5,'present',$6,$5,$7,$8,$9,$10,$11,$12,$7,$7)`,
            [id, req.user.tid, own.id, workDate, at.toISOString(),
             "Self clock-in", req.user.sub, proof.kind, proof.lat, proof.lng,
             proof.accuracyM, documentId]);
        }

        const saved = await c.query(
          `select id, work_date::text as work_date, day_status, clock_in, clock_out, minutes_late,
                  confirmed_at, confirmed_by, proof_kind, proof_lat, proof_lng,
                  proof_accuracy_m, proof_document_id
             from employee_attendance where id = $1 and tenant_id = $2`,
          [id, req.user.tid]);
        const r = saved.rows[0];
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "employee_attendance", entityId: id,
          action: "attendance.confirmed",
          after: {
            employeeId: own.id, fullName: own.full_name, workDate, at: at.toISOString(),
            proof: r.proof_kind, accuracyM: r.proof_accuracy_m, documentId
            // The coordinates themselves stay in the row: an audit trail that quoted where
            // everybody was every day would be a second register nobody asked for.
          }
        });
        return {
          id, day,
          work_date: r.work_date, day_status: r.day_status,
          clock_in: r.clock_in, clock_out: r.clock_out, minutes_late: r.minutes_late,
          confirmed_at: r.confirmed_at, proof_kind: r.proof_kind,
          proof_accuracy_m: r.proof_accuracy_m, proof_document_id: r.proof_document_id,
          // Back to the person who sent it, at the precision it was kept: "recorded as
          // −6.799, 39.280" is the honest description of what the register now holds.
          proof_lat: r.proof_lat === null ? null : Number(r.proof_lat),
          proof_lng: r.proof_lng === null ? null : Number(r.proof_lng),
          coarse_by: "about 100 m"
        };
      });
      return reply.status(201).send(result);
    });

  /**
   * The evidence behind one confirmed day. This is the only call that answers coordinates, and
   * it is the only place they are read — a register that printed everybody's position would
   * turn a defence against a missed timesheet into a tracking system. Who looked, and at whose
   * day, is written in the company's audit book, because "who saw where I was" is a question a
   * person is entitled to have answered.
   */
  app.get("/attendance/:id/proof", { preHandler: [requireAuth, requirePermission("attendance.view")] },
    async (req: any) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return withTenant(req.user.tid, async (c) => {
        const found = await c.query(
          `select a.id, a.employee_id, e.full_name, a.work_date::text as work_date,
                  a.confirmed_at, a.confirmed_by, a.proof_kind, a.proof_lat, a.proof_lng,
                  a.proof_accuracy_m, a.proof_document_id,
                  d.file_name, d.mime_type, d.size_bytes, d.storage_path
             from employee_attendance a
             join employees e on e.id = a.employee_id
             left join documents d
               on d.id = a.proof_document_id and d.tenant_id = a.tenant_id and d.deleted_at is null
            where a.id = $1 and a.tenant_id = $2 and a.deleted_at is null`,
          [id, req.user.tid]);
        if (!found.rowCount) throw new ApiError("NOT_FOUND", "No such day in the register.", 404);
        const r = found.rows[0];
        if (!r.confirmed_at || !r.proof_kind) {
          throw new ApiError("CONFLICT", "That day was recorded without a confirmation.", 409);
        }

        let document: { id: string; fileName: string; mimeType: string; sizeBytes: number; url: string } | null = null;
        if (r.proof_kind === "photo") {
          if (!r.proof_document_id || !r.storage_path) {
            // The link outlives the file only as a hole, so name the hole rather than 500 on it.
            throw new ApiError("NOT_FOUND", "The photograph that confirmed that day is no longer filed.", 404);
          }
          if (!storageConfigured()) {
            throw new ApiError("STORAGE_UNAVAILABLE",
              "Photographs cannot be opened yet — the file store is not configured.", 503);
          }
          document = {
            id: r.proof_document_id, fileName: r.file_name, mimeType: r.mime_type,
            sizeBytes: Number(r.size_bytes),
            url: await signObject(r.storage_path, 300)
          };
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "employee_attendance", entityId: id,
          action: "attendance.proof_viewed",
          after: { employeeId: r.employee_id, fullName: r.full_name, workDate: r.work_date, proof: r.proof_kind }
        });
        return {
          id: r.id, employee: { id: r.employee_id, fullName: r.full_name },
          workDate: r.work_date, confirmedAt: r.confirmed_at, confirmedBy: r.confirmed_by,
          proofKind: r.proof_kind,
          lat: r.proof_lat === null ? null : Number(r.proof_lat),
          lng: r.proof_lng === null ? null : Number(r.proof_lng),
          accuracyM: r.proof_accuracy_m,
          keptTo: "about 100 m",
          document
        };
      });
    });

  /** The desk states a day — absent, a holiday, a half day — with or without a clock. */
  app.post("/attendance/day", { preHandler: [requireAuth, requirePermission("attendance.edit")] },
    async (req: any, reply) => {
      const body = daySchema.parse(req.body);
      try {
        const result = await withTenant(req.user.tid, async (c) => {
          const day = await companyDay(c, req.user.tid);
          const emp = await c.query(
            `select id, full_name from employees where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
          if (body.workDate > day.today) {
            throw new ApiError("VALIDATION_FAILED", "A day that has not arrived yet cannot be stated.", 400,
              [{ field: "workDate" }]);
          }
          const openIn = body.clockIn ?? null;
          const openOut = body.clockOut ?? null;
          if (openIn && openOut && new Date(openOut) <= new Date(openIn)) {
            throw new ApiError("VALIDATION_FAILED", "The clock-out is before the clock-in.", 400, [{ field: "clockOut" }]);
          }

          const prev = await c.query(
            `select id, day_status, clock_in, clock_out from employee_attendance
              where tenant_id = $1 and employee_id = $2 and work_date = $3::date and deleted_at is null`,
            [req.user.tid, body.employeeId, body.workDate]);
          let id: string;
          if (prev.rowCount) {
            // An existing clock is kept unless the desk supplies one; clearing a
            // stamp is a correction and belongs to PUT /attendance/:id.
            id = prev.rows[0].id;
            await c.query(
              `update employee_attendance
                  set day_status = $3,
                      clock_in   = coalesce($4, clock_in),
                      clock_out  = coalesce($5, clock_out),
                      note       = coalesce($6, note),
                      updated_by = $7, updated_at = now()
                where id = $1 and tenant_id = $2 and deleted_at is null`,
              [id, req.user.tid, body.dayStatus, openIn, openOut,
               body.note ?? null, req.user.sub]);
          } else {
            id = uuidv7();
            await c.query(
              `insert into employee_attendance
                 (id, tenant_id, employee_id, work_date, day_status, clock_in, clock_out, note, created_by, updated_by)
               values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $9)`,
              [id, req.user.tid, body.employeeId, body.workDate, body.dayStatus,
               openIn, openOut, body.note ?? null, req.user.sub]);
          }
          const saved = await c.query(
            `select a.id, a.employee_id, e.full_name, a.work_date::text as work_date, a.day_status,
                    a.clock_in, a.clock_out, a.minutes_late, a.note
               from employee_attendance a join employees e on e.id = a.employee_id
              where a.id = $1 and a.tenant_id = $2`,
            [id, req.user.tid]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "employee_attendance", entityId: id,
            action: prev.rowCount ? "attendance.day_corrected" : "attendance.day_stated",
            before: prev.rowCount ? { dayStatus: prev.rows[0].day_status } : null,
            after: { employeeId: body.employeeId, fullName: emp.rows[0].full_name, workDate: body.workDate, dayStatus: body.dayStatus }
          });
          return saved.rows[0];
        });
        return reply.status(201).send(result);
      } catch (e) {
        if (isClash(e)) throw new ApiError("CONFLICT", "That day is already recorded for this person.", 409);
        throw e;
      }
    });

  app.put("/attendance/:id", { preHandler: [requireAuth, requirePermission("attendance.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = attendanceUpdateSchema.parse(req.body);
      try {
        return await withTenant(req.user.tid, async (c) => {
          const day = await companyDay(c, req.user.tid);
          const prev = await c.query(
            `select a.employee_id, e.full_name, a.work_date::text as work_date, a.day_status,
                    a.clock_in, a.clock_out, a.minutes_late, a.note
               from employee_attendance a join employees e on e.id = a.employee_id
              where a.id = $1 and a.tenant_id = $2 and a.deleted_at is null`,
            [id, req.user.tid]);
          if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Attendance line not found", 404);
          const before = prev.rows[0];
          if (body.workDate && body.workDate > day.today) {
            throw new ApiError("VALIDATION_FAILED", "A day that has not arrived yet cannot be recorded.", 400,
              [{ field: "workDate" }]);
          }
          const clockIn = "clockIn" in body ? body.clockIn ?? null : before.clock_in;
          // A day with no arrival cannot have a departure either, so clearing the
          // clock-in takes the clock-out with it unless the desk gave a new one.
          const clockOut = "clockOut" in body
            ? body.clockOut ?? null
            : ("clockIn" in body && !body.clockIn ? null : before.clock_out);
          if (clockIn && clockOut && new Date(clockOut) <= new Date(clockIn)) {
            throw new ApiError("VALIDATION_FAILED", "The clock-out is before the clock-in.", 400, [{ field: "clockOut" }]);
          }

          const sets: string[] = ["updated_by = $2", "updated_at = now()"];
          const params: unknown[] = [id, req.user.sub, req.user.tid];
          const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
          const clockTouched = "clockIn" in body || "workDate" in body;
          if ("workDate" in body) set("work_date", body.workDate);
          if ("dayStatus" in body) set("day_status", body.dayStatus);
          // Writing clock_in in the same statement — even back to its own value —
          // is what lets 065's stamp see the change; a day with no clock has no
          // lateness to report, so that case clears the column instead.
          if (clockTouched) set("clock_in", clockIn);
          if ("clockOut" in body || clockTouched) set("clock_out", clockOut);
          if ("note" in body) set("note", body.note ?? null);
          if (clockTouched && !clockIn) set("minutes_late", null);

          await c.query(
            `update employee_attendance set ${sets.join(", ")}
              where id = $1 and tenant_id = $3 and deleted_at is null`, params);

          const saved = await c.query(
            `select a.id, a.employee_id, e.full_name, a.work_date::text as work_date, a.day_status,
                    a.clock_in, a.clock_out, a.minutes_late, a.note,
                    (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked
               from employee_attendance a join employees e on e.id = a.employee_id
              where a.id = $1 and a.tenant_id = $2`,
            [id, req.user.tid]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "employee_attendance", entityId: id,
            action: "attendance.corrected",
            before: { employee: before.full_name, workDate: before.work_date, dayStatus: before.day_status, clockIn: before.clock_in, clockOut: before.clock_out },
            after: saved.rows[0] ? { workDate: saved.rows[0].work_date, dayStatus: saved.rows[0].day_status, clockIn: saved.rows[0].clock_in, clockOut: saved.rows[0].clock_out, minutesLate: saved.rows[0].minutes_late } : null
          });
          return saved.rows[0] ?? { ok: true };
        });
      } catch (e) {
        if (isClash(e)) {
          throw new ApiError("CONFLICT", "That person already has a line for the day you moved this one to.", 409);
        }
        throw e;
      }
    });

  // ---------- Leave ----------

  app.get("/leave", { preHandler: [requireAuth, requirePermission("leave.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
        employeeId: z.string().uuid().optional(),
        from: dateOnly.optional(), to: dateOnly.optional()
      }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const { rows } = await c.query(
          `select l.id, l.employee_id, e.full_name, e.job_title, e.department,
                  l.leave_kind, l.starts_on::text as starts_on, l.ends_on::text as ends_on,
                  l.working_days, l.reason, l.status, l.decision_note, l.created_at,
                  l.decided_by, u.full_name as decided_by_name, l.decided_at,
                  e.user_id as employee_user_id, l.created_by,
                  ${LEAVE_ROUTE_SQL},
                  (l.created_by = $6::uuid or e.user_id = $6::uuid) as mine
             from leave_requests l
             join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
             left join users u on u.id = l.decided_by and u.tenant_id = l.tenant_id
             ${LEAVE_ROUTE_JOINS}
            where l.tenant_id = $1 and l.deleted_at is null
              and ($2::text is null or l.status = $2)
              and ($3::uuid is null or l.employee_id = $3)
              and ($4::date is null or l.ends_on >= $4)
              and ($5::date is null or l.starts_on <= $5)
            order by case when l.status = 'pending' then 0 else 1 end,
                     l.starts_on desc, l.created_at desc
            limit 500`,
          [req.user.tid, q.status ?? null, q.employeeId ?? null, q.from ?? null, q.to ?? null, req.user.sub]);
        // can_decide is said here rather than left to the register's guess, because the answer
        // depends on two things the row does not hold: whether this seat carries the deciding
        // key, and whether the request is still the one it was sent to. can_escalate is the
        // same style of answer for the other act — the desk that may push a stalled request up
        // is the requester's own, the holder's, or the office's, and a register cannot tell
        // those three from a column. can_cancel follows /leave/:id/cancel: closing a granted
        // day unwinds somebody's decision, and a refused one is a record, not a draft.
        const mayOffice = await checkPermission(c, req.user.sub, "leave.decide");
        return rows.map((r: any) => {
          const mine = r.employee_user_id === req.user.sub || r.created_by === req.user.sub;
          const held = r.routed_to_user_id === req.user.sub;
          const withAPerson = r.routed_reason === "assigned" || r.routed_reason === "supervisor";
          return {
            ...r,
            can_decide: r.status === "pending" && !mine
              && (held || (mayOffice && (r.routed_reason === "office" || r.routed_reason === "escalated"))),
            can_escalate: r.status === "pending" && !r.escalated_at && withAPerson
              && (mine || held || mayOffice),
            can_cancel: r.status === "pending" ? (mine || mayOffice)
              : r.status === "approved" ? mayOffice : false
          };
        });
      });
    });

  /**
   * The queue of the person a request was sent to. It is not the office register: a staff
   * member the office named as an approver holds no desk permission, and `leave.view` would
   * hand them every colleague's request instead of the handful that are theirs to answer.
   * Only rows routed to this seat are ever read.
   */
  app.get("/leave/for-me", { preHandler: [requireAuth, requirePermission("leave.request")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select l.id, l.employee_id, e.full_name, e.job_title, e.department,
                l.leave_kind, l.starts_on::text as starts_on, l.ends_on::text as ends_on,
                l.working_days, l.reason, l.created_at, l.routed_reason, l.routed_note,
                (l.created_by = $2::uuid) as raised_by_me,
                (select coalesce(sum(p.working_days), 0)::int from leave_requests p
                  where p.tenant_id = l.tenant_id and p.employee_id = l.employee_id
                    and p.deleted_at is null and p.status = 'approved'
                    and p.leave_kind = 'annual'
                    and extract(year from p.starts_on) = extract(year from l.starts_on)) as annual_taken,
                (select coalesce(sum(p.working_days), 0)::int from leave_requests p
                  where p.tenant_id = l.tenant_id and p.employee_id = l.employee_id
                    and p.deleted_at is null and p.status = 'pending'
                    and p.leave_kind = 'annual'
                    and extract(year from p.starts_on) = extract(year from l.starts_on)
                    and p.id <> l.id) as annual_also_waiting
           from leave_requests l
           join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
          where l.tenant_id = $1 and l.deleted_at is null and l.status = 'pending'
            and l.routed_to_user_id = $2
          order by l.created_at
          limit 200`,
        [req.user.tid, req.user.sub]));
      return rows;
    });

  /** Entitlement against what was taken and what is still queued, per person. */
  app.get("/leave/balances", { preHandler: [requireAuth, requirePermission("leave.view")] },
    async (req: any) => {
      const q = z.object({ year: z.coerce.number().int().min(2000).max(2999).optional() }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const day = await companyDay(c, req.user.tid);
        const year = q.year ?? Number(day.today.slice(0, 4));
        const roster = await c.query(
          `select id as employee_id, full_name, job_title, department
             from employees
            where tenant_id = $1 and deleted_at is null and status = 'active'
            order by full_name`,
          [req.user.tid]);
        const taken = await c.query(
          `select employee_id, leave_kind, status,
                  coalesce(sum(working_days), 0)::int as days, count(*)::int as requests
             from leave_requests
            where tenant_id = $1 and deleted_at is null
              and status in ('approved','pending')
              and extract(year from starts_on) = $2::int
            group by employee_id, leave_kind, status`,
          [req.user.tid, year]);
        const map = new Map<string, { approved: number; pending: number }>();
        for (const r of taken.rows as any[]) {
          const key = `${r.employee_id}|${r.leave_kind}`;
          const cur = map.get(key) ?? { approved: 0, pending: 0 };
          if (r.status === "approved") cur.approved += Number(r.days); else cur.pending += Number(r.days);
          map.set(key, cur);
        }
        const rows = (roster.rows as any[]).map((e) => {
          const annual = map.get(`${e.employee_id}|annual`) ?? { approved: 0, pending: 0 };
          return {
            ...e,
            entitlement: day.annualLeaveDays,
            annualUsed: annual.approved,
            annualPending: annual.pending,
            annualRemaining: day.annualLeaveDays - annual.approved,
            byKind: LEAVE_KINDS.filter((k) => map.has(`${e.employee_id}|${k}`))
              .map((k) => ({ kind: k, ...map.get(`${e.employee_id}|${k}`)! }))
          };
        });
        return {
          day, year,
          totals: {
            entitlement: rows.reduce((a, r) => a + r.entitlement, 0),
            used: rows.reduce((a, r) => a + r.annualUsed, 0),
            pending: rows.reduce((a, r) => a + r.annualPending, 0),
            overdrawn: rows.filter((r) => r.annualRemaining < 0).length
          },
          rows
        };
      });
    });

  app.post("/leave", { preHandler: [requireAuth, requirePermission("leave.request")] },
    async (req: any, reply) => {
      const body = leaveSchema.parse(req.body);
      assertSpan(body.startsOn, body.endsOn, 365, "endsOn");
      try {
        const result = await withTenant(req.user.tid, async (c) => {
          const target = await resolveTarget(c, req.user.tid, req.user.sub, body.employeeId, "leave.decide");
          assertWorking(target);
          const route = await resolveLeaveRoute(
            c, req.user.tid,
            {
              name: target.name, user_id: (target as any).user_id ?? null,
              supervisor_id: (target as any).supervisor_id ?? null,
              leave_approver_user_id: (target as any).leave_approver_user_id ?? null
            },
            body.startsOn, body.endsOn);
          const id = uuidv7();
          await c.query(
            `insert into leave_requests
               (id, tenant_id, employee_id, leave_kind, starts_on, ends_on, reason, created_by, updated_by,
                routed_to_user_id, routed_reason, routed_note)
             values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $8, $9, $10, $11)`,
            [id, req.user.tid, target.id, body.leaveKind, body.startsOn, body.endsOn,
             body.reason ?? null, req.user.sub,
             route.to, route.reason, route.note]);
          const saved = await c.query(
            `select l.id, l.employee_id, e.full_name, l.leave_kind, l.starts_on::text as starts_on,
                    l.ends_on::text as ends_on, l.working_days, l.status, l.reason,
                    l.routed_to_user_id, l.routed_reason, l.routed_note, ru.full_name as routed_to_name
               from leave_requests l
               join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
               left join users ru on ru.id = l.routed_to_user_id and ru.tenant_id = l.tenant_id
              where l.id = $1 and l.tenant_id = $2`,
            [id, req.user.tid]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "leave_requests", entityId: id,
            action: target.isOwn ? "leave.requested" : "leave.requested_for_staff",
            after: { employeeId: target.id, employee: saved.rows[0].full_name, leaveKind: body.leaveKind, startsOn: saved.rows[0].starts_on, endsOn: saved.rows[0].ends_on, workingDays: saved.rows[0].working_days, routedTo: saved.rows[0].routed_to_name ?? null, routedReason: saved.rows[0].routed_reason }
          });
          return saved.rows[0];
        });
        return reply.status(201).send(result);
      } catch (e) {
        const msg = (e as any)?.message ?? "";
        if (typeof msg === "string" && msg.includes("already has a leave request")) {
          throw new ApiError("CONFLICT", msg.replace(/^relation .*? failed: /, ""), 409);
        }
        throw e;
      }
    });

  app.put("/leave/:id", { preHandler: [requireAuth, requirePermission("leave.request")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = leaveUpdateSchema.parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select l.employee_id, l.status, l.starts_on::text as starts_on, l.ends_on::text as ends_on,
                  l.leave_kind, l.reason, l.escalated_at, e.user_id, e.full_name,
                  e.supervisor_id, e.leave_approver_user_id
             from leave_requests l
             join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
            where l.id = $1 and l.tenant_id = $2 and l.deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Leave request not found", 404);
        const row = prev.rows[0];
        if (row.user_id !== req.user.sub && !await checkPermission(c, req.user.sub, "leave.decide")) {
          throw new ApiError("FORBIDDEN", "That is somebody else's request.", 403);
        }
        if (row.status !== "pending") {
          throw new ApiError("CONFLICT", "A request that has been decided is not edited — cancel it and raise a fresh one.", 409);
        }
        // Absent key keeps the stored value, resolved from the row just read in the same
        // tenant scope, so the statement below is static and the scanner can prove it.
        const startsOn = "startsOn" in body ? body.startsOn! : row.starts_on;
        const endsOn = "endsOn" in body ? body.endsOn! : row.ends_on;
        assertSpan(startsOn, endsOn, 365, "endsOn");
        const leaveKind = "leaveKind" in body ? body.leaveKind! : row.leave_kind;
        const reason = "reason" in body ? (body.reason ?? null) : row.reason;

        await c.query(
          `update leave_requests
              set starts_on = $4, ends_on = $5, leave_kind = $6, reason = $7,
                  updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $3`,
          [id, req.user.sub, req.user.tid, startsOn, endsOn, leaveKind, reason]);

        if (row.status === "pending" && !row.escalated_at) {
          // Moving the dates can move the answer: a request now sent to a person who is away
          // for the new days goes to the office, and one the office was holding goes back to
          // the approver named since. A request already escalated keeps the route it was
          // escalated onto — pushing it upstairs was somebody's decision, not a side effect.
          const route = await resolveLeaveRoute(c, req.user.tid, {
            name: row.full_name, user_id: row.user_id ?? null,
            supervisor_id: row.supervisor_id ?? null,
            leave_approver_user_id: row.leave_approver_user_id ?? null
          }, startsOn, endsOn);
          await c.query(
            `update leave_requests
                set routed_to_user_id = $4, routed_reason = $5, routed_note = $6,
                    updated_by = $2, updated_at = now()
              where id = $1 and tenant_id = $3`,
            [id, req.user.sub, req.user.tid, route.to, route.reason, route.note]);
        }

        const saved = await c.query(
          `select l.id, l.employee_id, l.leave_kind, l.starts_on::text as starts_on,
                  l.ends_on::text as ends_on, l.working_days, l.reason, l.status,
                  ${LEAVE_ROUTE_SQL}
             from leave_requests l
             ${LEAVE_ROUTE_JOINS}
            where l.id = $1 and l.tenant_id = $2`,
          [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "leave_requests", entityId: id,
          action: "leave.updated",
          before: { startsOn: row.starts_on, endsOn: row.ends_on, leaveKind: row.leave_kind },
          after: saved.rows[0] ? { startsOn: saved.rows[0].starts_on, endsOn: saved.rows[0].ends_on, workingDays: saved.rows[0].working_days } : null
        });
        return saved.rows[0];
      });
    });

  /**
   * The answer. It is not gated on leave.decide any more, because the person the request was
   * sent to is usually a colleague with no desk permission at all — and gating on the key was
   * the whole of #183's complaint. What is left: this seat holds the request, or the request
   * is with the office and this seat holds the deciding key. Nobody else, including a director
   * who simply got there first.
   */
  app.post("/leave/:id/decision", { preHandler: [requireAuth] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = decisionSchema.parse(req.body);
      const status = body.decision === "approve" ? "approved" : "rejected";
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select l.status, l.employee_id, l.working_days, l.created_by,
                  l.routed_to_user_id, l.routed_reason, l.routed_note,
                  e.full_name, e.user_id as employee_user_id, ru.full_name as routed_to_name
             from leave_requests l
             join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
             left join users ru on ru.id = l.routed_to_user_id and ru.tenant_id = l.tenant_id
            where l.id = $1 and l.tenant_id = $2 and l.deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Leave request not found", 404);
        const row = prev.rows[0];
        if (row.status !== "pending") {
          throw new ApiError("CONFLICT", "That request has already been decided.", 409);
        }
        // 108 refuses this on the row as well; said here it is a sentence rather than a 500.
        if (row.employee_user_id === req.user.sub || row.created_by === req.user.sub) {
          throw new ApiError("FORBIDDEN",
            "This request came from you. It is decided by the person above you, not by you.", 403);
        }
        const mine = row.routed_to_user_id === req.user.sub;
        const withTheOffice = row.routed_reason === "office" || row.routed_reason === "escalated";
        const mayOffice = withTheOffice && await checkPermission(c, req.user.sub, "leave.decide");
        if (!mine && !mayOffice) {
          throw new ApiError("FORBIDDEN", withTheOffice
            ? "This one is the office's to decide."
            : `This request is ${row.routed_to_name ?? "somebody else"}'s to decide. It is not taken off their desk here — ask them, or escalate it to the office.`,
            403);
        }
        await c.query(
          `update leave_requests set status = $4, decided_by = $2, decided_at = now(),
                     decision_note = $5, updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $3 and deleted_at is null and status = 'pending'`,
          [id, req.user.sub, req.user.tid, status, body.note ?? null]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "leave_requests", entityId: id,
          action: body.decision === "approve" ? "leave.approved" : "leave.rejected",
          before: { status: "pending", employee: row.full_name, days: row.working_days, routedTo: row.routed_to_name ?? null, routedReason: row.routed_reason },
          after: { status, note: body.note ?? null, decidedBy: req.user.sub }
        });
        return { ok: true, status };
      });
    });

  /**
   * Pushing a request upstairs. Three people can do it and each has a different reason: the
   * one who asked (nobody has answered), the one it was sent to (they cannot answer), and the
   * office (it has been sitting). It is the only way a request leaves a desk that will never
   * be cleared — an approver who has left the company, or simply stopped signing in — so the
   * chain cannot stall, and it is one act per request rather than a queue going round.
   */
  app.post("/leave/:id/escalate", { preHandler: [requireAuth, requirePermission("leave.request")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body ?? {});
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select l.status, l.employee_id, l.escalated_at, l.routed_to_user_id, l.routed_reason,
                  e.full_name, e.user_id as employee_user_id, ru.full_name as routed_to_name
             from leave_requests l
             join employees e on e.id = l.employee_id and e.tenant_id = l.tenant_id
             left join users ru on ru.id = l.routed_to_user_id and ru.tenant_id = l.tenant_id
            where l.id = $1 and l.tenant_id = $2 and l.deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Leave request not found", 404);
        const row = prev.rows[0];
        if (row.status !== "pending") {
          throw new ApiError("CONFLICT", "That request has already been answered; there is nothing to move.", 409);
        }
        if (row.escalated_at) {
          throw new ApiError("CONFLICT", "It is already with the office. The office is not asked twice.", 409);
        }
        const isOwner = row.employee_user_id === req.user.sub || row.created_by === req.user.sub;
        const isHolder = row.routed_to_user_id === req.user.sub;
        const mayOffice = await checkPermission(c, req.user.sub, "leave.decide");
        if (!isOwner && !isHolder && !mayOffice) {
          throw new ApiError("FORBIDDEN",
            "Only the person who asked, the one it was sent to, or the office can move it upstairs.", 403);
        }
        // The reason travels with the request: an office that is handed a pile and told
        // "escalated" learns nothing, but one that reads why can answer it.
        const note = body.note?.trim()
          ?? (isHolder
            ? `Sent up from ${row.routed_to_name ?? "the approver"} by the approver themselves.`
            : `Sent up from ${row.routed_to_name ?? "the approver"} to the office.`);
        await c.query(
          `update leave_requests
              set routed_to_user_id = null, routed_reason = 'escalated', routed_note = $4,
                  escalated_at = now(), escalated_by = $2, escalated_from = $5,
                  updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $3 and status = 'pending' and deleted_at is null`,
          [id, req.user.sub, req.user.tid, note, row.routed_to_user_id]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "leave_requests", entityId: id,
          action: "leave.escalated",
          before: { routedTo: row.routed_to_name ?? null, routedReason: row.routed_reason },
          after: { routedReason: "escalated", note, from: row.routed_to_user_id ?? null }
        });
        return { ok: true, status: "pending", routedReason: "escalated", note };
      });
    });

  app.post("/leave/:id/cancel", { preHandler: [requireAuth, requirePermission("leave.request")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body ?? {});
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select l.status, e.user_id, e.full_name
             from leave_requests l join employees e on e.id = l.employee_id
            where l.id = $1 and l.tenant_id = $2 and l.deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Leave request not found", 404);
        const row = prev.rows[0];
        if (row.status === "cancelled") return { ok: true, status: row.status };
        if (row.status === "rejected") {
          throw new ApiError("CONFLICT", "A refused request stays on record as refused.", 409);
        }
        // Closing granted leave unwinds a decision somebody already took, so it
        // needs the deciding seat rather than just the requesting one.
        const mayClose = row.status === "pending"
          ? (row.user_id === req.user.sub || await checkPermission(c, req.user.sub, "leave.decide"))
          : await checkPermission(c, req.user.sub, "leave.decide");
        if (!mayClose) {
          throw new ApiError("FORBIDDEN", "Leave that was granted is closed by the office.", 403);
        }
        await c.query(
          `update leave_requests set status = 'cancelled',
                     decision_note = coalesce($4, decision_note),
                     updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid, body.note ?? null]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "leave_requests", entityId: id,
          action: "leave.cancelled",
          before: { status: row.status, employee: row.full_name },
          after: { status: "cancelled", note: body.note ?? null }
        });
        return { ok: true, status: "cancelled" };
      });
    });

  // ---------- The working day itself ----------

  app.get("/office-settings", { preHandler: [requireAuth, requirePermission("attendance.view")] },
    async (req: any) => withTenant(req.user.tid, async (c) => await companyDay(c, req.user.tid)));

  app.put("/office-settings", { preHandler: [requireAuth, requirePermission("office_settings.manage")] },
    async (req: any) => {
      const body = settingsSchema.parse(req.body);
      if (body.workStart >= body.workEnd) {
        throw new ApiError("VALIDATION_FAILED", "The working day ends before it starts.", 400, [{ field: "workEnd" }]);
      }
      return withTenant(req.user.tid, async (c) => {
        const zone = await c.query("select name from pg_timezone_names where name = $1 limit 1", [body.timezone]);
        if (!zone.rowCount) {
          throw new ApiError("VALIDATION_FAILED", "That timezone is not one the server knows.", 400,
            [{ field: "timezone" }]);
        }
        await c.query(
          `insert into office_settings
             (tenant_id, work_start, work_end, late_grace_minutes, annual_leave_days, timezone, updated_by)
           values ($1, $2::time, $3::time, $4, $5, $6, $7)
           on conflict (tenant_id) do update set
             work_start = excluded.work_start, work_end = excluded.work_end,
             late_grace_minutes = excluded.late_grace_minutes,
             annual_leave_days = excluded.annual_leave_days,
             timezone = excluded.timezone, updated_by = excluded.updated_by, updated_at = now()`,
          [req.user.tid, body.workStart, body.workEnd, body.lateGraceMinutes,
           body.annualLeaveDays, body.timezone, req.user.sub]);
        const saved = await companyDay(c, req.user.tid);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_settings", entityId: req.user.tid,
          action: "office_settings.updated", after: saved
        });
        return saved;
      });
    });
}
