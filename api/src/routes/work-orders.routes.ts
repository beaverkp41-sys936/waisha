import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";
import { requirePermission, checkPermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const KINDS = ["service", "repair", "tyre", "electrical", "bodywork", "inspection", "accident", "other"] as const;
const STATUSES = ["raised", "in_workshop", "awaiting_parts", "returned", "cancelled"] as const;
const OPEN_STATUSES = ["raised", "in_workshop", "awaiting_parts"];

/** The journal line a card writes into the plate's own diary (092). Money never travels here —
 *  092's header is explicit that the bill belongs to this register — so what crosses over is the
 *  fact and the reference, and the journal says where the figures live. */
function journalKind(kind: string): "service" | "damage" {
  return kind === "accident" ? "damage" : "service";
}

/** numeric(14,2) is rounded by Postgres, so the schema bounds the figure instead of counting
 *  its decimals: `multipleOf(0.01)` rejects the float arithmetic of an ordinary bill (a clerk
 *  typing 1234.56 would get a 400 for a number they did not invent). */
const money = z.number().nonnegative().max(1e12);

const createSchema = z.object({
  vesselId: z.string().uuid(),
  raisedOn: dateOnly,
  title: z.string().trim().min(3).max(140),
  detail: z.string().max(2000).nullable().optional(),
  kind: z.enum(KINDS).default("service"),
  place: z.enum(["in_house", "outside_garage"]),
  garageName: z.string().trim().max(140).nullable().optional(),
  garageReference: z.string().trim().max(80).nullable().optional(),
  mechanicEmployeeId: z.string().uuid().nullable().optional(),
  odometerInKm: z.number().int().nonnegative().nullable().optional(),
  partsCost: money.optional(),
  labourCost: money.optional(),
  otherCost: money.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  invoiceRef: z.string().trim().max(80).nullable().optional()
});

const editSchema = createSchema.omit({ vesselId: true, raisedOn: true }).extend({
  raisedOn: dateOnly.optional()
});

const moveSchema = z.object({
  status: z.enum(["in_workshop", "awaiting_parts"]),
  note: z.string().trim().max(300).nullable().optional()
});

const returnSchema = z.object({
  odometerOutKm: z.number().int().nonnegative(),
  roadworthy: z.boolean().default(true),
  partsCost: money.optional(),
  labourCost: money.optional(),
  otherCost: money.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  invoiceRef: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
});

const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(300)
});

/**
 * The register, one company's rows only.
 *
 * Params: tenant, statuses[]|null, vessel|null, place|null, from|null, to|null, pattern|null,
 *         limit, offset. The pattern is matched against the reference, the title, the job detail
 *         and the garage's own name — a clerk searching "Kigamboni" is looking for a place, not
 *         for a uuid. No employee phone, no NIDA, ever: `employees` carries both as encrypted
 *         columns and a list endpoint that could show one is a list endpoint that will.
 *
 * Every side table is joined on its tenant as well as its id. The API connects as a role that
 * bypasses row security, so the only thing keeping another company's mechanic name out of this
 * answer is the predicate written here — a bare `on e.id = …` would be a leak with a foreign key
 * in front of it.
 */
const ORDERS_SQL = `
  select w.id, w.ref, w.raised_on::text as raised_on, w.title, w.detail, w.kind, w.place,
         w.garage_name, w.garage_reference, w.mechanic_employee_id,
         coalesce(e.full_name, case when w.mechanic_employee_id is null then null
                                    else 'a staff record this company does not list' end)
           as mechanic_name,
         e.job_title as mechanic_role, e.status as mechanic_status,
         (e.deleted_at is not null) as mechanic_removed,
         w.vessel_id, v.name as vessel_name, v.plate_number, v.status as vessel_status,
         v.odometer_km as vessel_odometer_km,
         w.status, w.odometer_in_km, w.odometer_out_km,
         w.parts_cost, w.labour_cost, w.other_cost,
         (w.parts_cost + w.labour_cost + w.other_cost) as total_cost,
         w.currency, w.invoice_ref,
         w.opened_at, w.opened_by, ob.full_name as opened_by_name,
         w.returned_at, w.returned_by, rb.full_name as returned_by_name,
         -- A called-off job is a reason and the seat that gave it; 109 stores exactly those two,
         -- so the desk reads the actor's name and never invents a second timestamp column.
         w.cancel_reason, w.cancelled_by, cb.full_name as cancelled_by_name,
         w.created_at, w.created_by, ub.full_name as created_by_name,
         (select count(*)::int from documents d
           where d.tenant_id = w.tenant_id and d.entity_type = 'work_order'
             and d.entity_id = w.id) as attachments
    from work_orders w
    join vessels v on v.id = w.vessel_id and v.tenant_id = w.tenant_id
    left join employees e on e.id = w.mechanic_employee_id and e.tenant_id = w.tenant_id
    left join users ub on ub.id = w.created_by and ub.tenant_id = w.tenant_id
    left join users ob on ob.id = w.opened_by and ob.tenant_id = w.tenant_id
    left join users rb on rb.id = w.returned_by and rb.tenant_id = w.tenant_id
    left join users cb on cb.id = w.cancelled_by and cb.tenant_id = w.tenant_id
   where w.tenant_id = $1 and w.deleted_at is null
     and ($2::text[] is null or w.status = any($2::text[]))
     and ($3::uuid is null or w.vessel_id = $3::uuid)
     and ($4::text is null or w.place = $4::text)
     and ($5::date is null or w.raised_on >= $5::date)
     and ($6::date is null or w.raised_on <= $6::date)
     and ($7::text is null or w.ref ilike '%' || $7 || '%'
          or w.title ilike '%' || $7 || '%'
          or coalesce(w.detail,'') ilike '%' || $7 || '%'
          or coalesce(w.garage_name,'') ilike '%' || $7 || '%')
   order by (w.status = any(array['returned','cancelled'])), w.raised_on desc, w.created_at desc
   limit $8 offset $9`;

export async function workOrdersRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The register ----------
  app.get("/work-orders", { preHandler: [requireAuth, requirePermission("work_orders.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(["open", ...STATUSES]).optional(),
        vesselId: z.string().uuid().optional(),
        place: z.enum(["in_house", "outside_garage"]).optional(),
        from: dateOnly.optional(), to: dateOnly.optional(),
        q: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(80),
        offset: z.coerce.number().int().min(0).max(5000).default(0)
      }).parse(req.query);

      const statuses = q.status === undefined ? null
        : q.status === "open" ? OPEN_STATUSES : [q.status];

      return withTenant(req.user.tid, async (c) => {
        // The two keys the desk's buttons depend on, read on the transaction that already has to
        // open for the register. A clerk is told once, in the same answer as the rows, which
        // buttons are theirs.
        const held = {
          edit: await checkPermission(c, req.user.sub, "work_orders.edit"),
          close: await checkPermission(c, req.user.sub, "work_orders.close")
        };
        const { rows } = await c.query(ORDERS_SQL, [
          req.user.tid, statuses, q.vesselId ?? null, q.place ?? null,
          q.from ?? null, q.to ?? null, q.q || null, q.limit, q.offset
        ]);
        return rows.map((r: any) => {
          const open = OPEN_STATUSES.includes(r.status);
          const mine = r.created_by === req.user.sub;
          // The same lesson #184 left on the leave desk: a seat that is refused an act is told
          // *why*, because "no key" and "this card is already closed" look identical to a clerk
          // until one of them sends them to ask a colleague for nothing.
          return {
            ...r,
            can_edit: open && held.edit,
            can_move: open && held.edit,
            can_return: open && held.close,
            can_cancel: open && (held.close || (mine && r.status === "raised")),
            close_block: !open ? (r.status === "cancelled" ? "cancelled" : "returned")
              : held.close ? null : "no_key",
            // Calling a card off has a second way to be allowed — the seat that wrote it may take
            // it back while the plate has not moved — so the refusal names which of the two failed.
            cancel_block: !open ? "closed" : held.close ? null
              : (mine && r.status === "raised") ? null : mine ? "moved" : "no_key"
          };
        });
      });
    });

  // ---------- Who can hold a wrench ----------
  //
  // The in-house half of a card names a staff record, so the desk needs a picker. It cannot use
  // GET /employees: that route answers `employees.view` and carries the whole profile sheet —
  // salary, contract dates, date of birth — none of which a fleet desk has any business reading.
  // This answers the workshop's own key and returns four columns and nothing else. No phone, no
  // NIDA: those are encrypted columns on the same table and this list never touches them.
  app.get("/work-orders/mechanics",
    { preHandler: [requireAuth, requirePermission("work_orders.view")] }, async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select e.id, e.full_name, e.job_title, e.department, e.status,
                (select count(*)::int from work_orders w
                  where w.tenant_id = e.tenant_id and w.mechanic_employee_id = e.id
                    and w.deleted_at is null and w.status = any($2::text[])) as open_cards
           from employees e
          where e.tenant_id = $1 and e.deleted_at is null
          order by e.full_name
          limit 500`,
        [req.user.tid, OPEN_STATUSES]));
      return rows;
    });

  // ---------- What the workshop is costing ----------
  //
  // Three rollups, because a fleet manager asks three questions: which plate is eating the
  // budget, which kind of job, and which garage. Figures are summed in the database so a desk
  // cannot reach a different total by paging through the register differently.
  //
  // Every figure here is cut to the window the desk asked for. A WINDOW control that moved one
  // column and left four alone would be a control that lies about the other four, and a card
  // counted in the register must not silently disappear from the panel beside it: 109's trigger
  // refuses a cancelled job that keeps a cost, so a called-off card can be counted honestly and
  // still add nothing to the money.
  app.get("/work-orders/summary",
    { preHandler: [requireAuth, requirePermission("work_orders.view")] }, async (req: any) => {
      const q = z.object({ days: z.coerce.number().int().min(30).max(1095).default(365) }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const perVessel = await c.query(`
          select w.vessel_id, v.name, v.plate_number, v.status as vessel_status,
                 (count(*) filter (where w.status = any($2::text[])))::int as open_orders,
                 (count(*) filter (where w.status = 'returned'))::int as returned_orders,
                 -- Only a returned card has a bill; a called-off one has been zeroed by its own
                 -- cancel, and a cancelled figure in a cost column would be a phantom invoice.
                 coalesce(sum(w.parts_cost + w.labour_cost + w.other_cost)
                   filter (where w.status = 'returned'), 0) as spent,
                 -- ::text because a raw date column serialises through UTC and lands on the desk
                 -- as the day before the card was written.
                 max(w.raised_on) filter (where w.status = any($2::text[]))::text as last_raised
            from work_orders w
            join vessels v on v.id = w.vessel_id and v.tenant_id = w.tenant_id
           where w.tenant_id = $1 and w.deleted_at is null
             and w.raised_on >= current_date - $3::int
           group by w.vessel_id, v.name, v.plate_number, v.status
           order by spent desc, open_orders desc, v.plate_number`,
          [req.user.tid, OPEN_STATUSES, q.days]);
        const perKind = await c.query(`
          select w.kind, (count(*))::int as orders,
                 coalesce(sum(w.parts_cost + w.labour_cost + w.other_cost), 0) as cost
            from work_orders w
           where w.tenant_id = $1 and w.deleted_at is null
             and w.raised_on >= current_date - $2::int
           group by w.kind order by cost desc`, [req.user.tid, q.days]);
        const perGarage = await c.query(`
          select coalesce(w.garage_name, 'in house') as garage,
                 (count(*))::int as orders,
                 coalesce(sum(w.parts_cost + w.labour_cost + w.other_cost), 0) as cost,
                 max(w.raised_on)::text as last_job
            from work_orders w
           where w.tenant_id = $1 and w.deleted_at is null
             and w.status in ('returned','cancelled')
             and w.raised_on >= current_date - $2::int
           group by 1 order by cost desc limit 12`, [req.user.tid, q.days]);
        const totals = await c.query(`
          select (count(*))::int as orders,
                 (count(*) filter (where w.status = any($2::text[])))::int as open,
                 (count(*) filter (where w.status = 'cancelled'))::int as cancelled,
                 -- A garage bill may be written in TZS or in dollars, and adding the two makes a
                 -- figure that is neither. The desk is given the currency list so it can say so,
                 -- and the money itself only ever comes back grouped by currency.
                 array_agg(distinct w.currency order by w.currency) as currencies
            from work_orders w
           where w.tenant_id = $1 and w.deleted_at is null
             and w.raised_on >= current_date - $3::int`,
          [req.user.tid, OPEN_STATUSES, q.days]);
        const byCurrency = await c.query(`
          select w.currency,
                 (count(*))::int as orders,
                 coalesce(sum(w.parts_cost), 0) as parts,
                 coalesce(sum(w.labour_cost), 0) as labour,
                 coalesce(sum(w.other_cost), 0) as other,
                 coalesce(sum(w.parts_cost + w.labour_cost + w.other_cost), 0) as total
            from work_orders w
           where w.tenant_id = $1 and w.deleted_at is null
             and w.raised_on >= current_date - $2::int
           group by w.currency
           order by sum(w.parts_cost + w.labour_cost + w.other_cost) desc`, [req.user.tid, q.days]);
        return {
          totals: totals.rows[0],
          byCurrency: byCurrency.rows,
          perVessel: perVessel.rows, perKind: perKind.rows, perGarage: perGarage.rows,
          window_days: q.days
        };
      });
    });

  // ---------- Raise a card ----------
  app.post("/work-orders", { preHandler: [requireAuth, requirePermission("work_orders.create")] },
    async (req: any, reply) => {
      await enforceRateLimit(`wo:create:uid:${req.user.sub}`, 60, 3600);
      const body = createSchema.parse(req.body);

      // 109's trigger refuses these two shapes whatever a route believes, but the field-coded 400
      // is answered here so the desk can put the message under the box the clerk did not fill in.
      if (body.place === "outside_garage" && !body.garageName) {
        throw new ApiError("VALIDATION_FAILED",
          "A job sent outside names the garage that has the vehicle.", 400, [{ field: "garageName" }]);
      }
      if (body.place === "in_house" && !body.mechanicEmployeeId) {
        throw new ApiError("VALIDATION_FAILED",
          "An in-house job names the mechanic who will do it.", 400, [{ field: "mechanicEmployeeId" }]);
      }

      const id = uuidv7();
      const out = await withTenant(req.user.tid, async (c) => {
        // The day is compared against the working day of the country, not against the database
        // clock: UTC turns 06:00 in Dar into "yesterday", and a card written about this morning's
        // breakdown would be refused for dating itself into the future.
        const today = await c.query(
          `select (timezone('Africa/Dar_es_Salaam', now()))::date::text as today`);
        const localToday = String(today.rows[0].today);
        if (body.raisedOn > localToday) {
          throw new ApiError("ORDER_DATE_FUTURE",
            `A work order cannot be dated after today (${localToday}) — the card is written when `
            + "the job is asked for, not when it is hoped to be finished.", 400);
        }

        const vessel = await c.query(
          `select name, plate_number, status, odometer_km from vessels
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [body.vesselId, req.user.tid]);
        if (!vessel.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);
        const stored = Number(vessel.rows[0].odometer_km ?? 0);
        const reading = body.odometerInKm ?? null;
        if (reading != null && reading > stored) {
          throw new ApiError("ODOMETER_AHEAD",
            `That card says the truck rolled in at ${reading.toLocaleString()} km, but this `
            + `register already holds ${stored.toLocaleString()} km for it. A work order opens at `
            + `the reading the vehicle has now or lower — a newer number belongs on the logbook `
            + `or the closing stamp.`, 409);
        }
        // 092's journal wants a name, not a uuid: the garage that has the plate, or the mechanic
        // whose hands are on it.
        let workedBy: string | null = body.place === "outside_garage" ? body.garageName ?? null : null;
        if (body.mechanicEmployeeId) {
          const emp = await c.query(
            `select full_name, status from employees
              where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.mechanicEmployeeId, req.user.tid]);
          if (!emp.rowCount) {
            throw new ApiError("VALIDATION_FAILED",
              "That mechanic is not a staff record of this company.", 400, [{ field: "mechanicEmployeeId" }]);
          }
          workedBy = emp.rows[0].full_name;
        }

        const first = await c.query(`
          insert into work_orders
            (id, tenant_id, vessel_id, ref, raised_on, title, detail, kind, place,
             garage_name, garage_reference, mechanic_employee_id, status, odometer_in_km,
             parts_cost, labour_cost, other_cost, currency, invoice_ref,
             created_by, updated_by)
          select $1, $2, $3,
                 'WO-' || to_char(now(), 'YYYY') || '-' ||
                 lpad(nextval('work_order_number_seq')::text, 5, '0'),
                 $4::date, $5, $6, $7, $8, nullif($9,''), nullif($10,''), $11::uuid, 'raised',
                 $12, coalesce($13, 0), coalesce($14, 0), coalesce($15, 0),
                 coalesce($16, 'TZS'), nullif($17,''), $18, $18
          returning id, ref, raised_on::text as raised_on, status, title, kind, place,
                    garage_name, mechanic_employee_id, odometer_in_km,
                    parts_cost, labour_cost, other_cost, currency, invoice_ref`,
          [id, req.user.tid, body.vesselId, body.raisedOn, body.title, body.detail ?? null,
           body.kind, body.place, body.garageName ?? null, body.garageReference ?? null,
           body.mechanicEmployeeId ?? null, reading,
           body.partsCost ?? 0, body.labourCost ?? 0, body.otherCost ?? 0,
           body.currency ?? "TZS", body.invoiceRef ?? null, req.user.sub]
        ).then((r) => r.rows[0]);

        await c.query(`
          insert into vessel_log_entries (id, tenant_id, vessel_id, entry_date, kind, title,
                                          detail, odometer_km, actor_name, created_by, updated_by)
          values ($1,$2,$3, $4::date, $5, $6, $7, $8, $9, $10, $10)`,
          [uuidv7(), req.user.tid, body.vesselId, body.raisedOn, journalKind(body.kind),
           `Work order ${first.ref}: ${body.title}`,
           `${body.place === "in_house" ? "In house" : `At ${body.garageName}`}. `
           + "The figures live on the work order, not in this journal.",
           reading, workedBy, req.user.sub]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "work_orders", entityId: id,
          action: "work_order.raised",
          after: {
            ref: first.ref, vessel: `${vessel.rows[0].name} ${vessel.rows[0].plate_number}`,
            kind: body.kind, place: body.place, garage: body.garageName ?? null,
            mechanic: body.mechanicEmployeeId ?? null, odometer_in_km: reading,
            parts: body.partsCost ?? 0, labour: body.labourCost ?? 0, other: body.otherCost ?? 0,
            currency: body.currency ?? "TZS"
          }
        });
        return first;
      });

      return reply.status(201).send(out);
    });

  // ---------- Edit an open card ----------
  //
  // The form re-supplies the whole card, so this is one static UPDATE rather than a presence
  // map: an empty garage field has to be able to clear a job that was sent outside and came back
  // to the workshop. The vessel and the closing stamps are absent from the list on purpose —
  // moving a card between plates or ending it are separate acts with their own keys, and 109's
  // trigger refuses an edit to a closed row whatever this route thinks.
  app.put("/work-orders/:id", { preHandler: [requireAuth, requirePermission("work_orders.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = editSchema.parse(req.body);

      if (body.place === "outside_garage" && !body.garageName) {
        throw new ApiError("VALIDATION_FAILED",
          "A job sent outside names the garage that has the vehicle.", 400, [{ field: "garageName" }]);
      }
      if (body.place === "in_house" && !body.mechanicEmployeeId) {
        throw new ApiError("VALIDATION_FAILED",
          "An in-house job names the mechanic who will do it.", 400, [{ field: "mechanicEmployeeId" }]);
      }

      const result = await withTenant(req.user.tid, async (c) => {
        const before = await c.query(
          `select w.status, w.ref, w.raised_on::text as raised_on, w.title, w.kind, w.place,
                  w.garage_name, w.mechanic_employee_id, w.odometer_in_km,
                  w.parts_cost, w.labour_cost, w.other_cost, w.currency, w.invoice_ref,
                  w.vessel_id, v.odometer_km as vessel_odometer_km,
                  (timezone('Africa/Dar_es_Salaam', now()))::date::text as today
             from work_orders w
             join vessels v on v.id = w.vessel_id and v.tenant_id = w.tenant_id
            where w.id = $1 and w.tenant_id = $2 and w.deleted_at is null`,
          [id, req.user.tid]);
        if (!before.rowCount) throw new ApiError("NOT_FOUND", "Work order not found", 404);
        const card = before.rows[0];
        if (!OPEN_STATUSES.includes(card.status)) {
          throw new ApiError("CONFLICT",
            `Work order ${card.ref} is already ${card.status}. A closed card `
            + "is not rewritten — raise a new order for the work that was actually done.", 409);
        }
        // The three rules that opened a card hold to are held to by an edit as well: a re-sent
        // form is a write, and a card that was legal at 09:00 must not become a lie by 10:00.
        if (body.raisedOn && body.raisedOn > card.today) {
          throw new ApiError("ORDER_DATE_FUTURE",
            `A work order cannot be dated after today (${card.today}).`, 400);
        }
        const reading = body.odometerInKm ?? null;
        if (reading != null && reading > Number(card.vessel_odometer_km ?? 0)) {
          throw new ApiError("ODOMETER_AHEAD",
            `The card now says the vehicle rolled in at ${reading.toLocaleString()} km, but this `
            + `register holds ${Number(card.vessel_odometer_km ?? 0).toLocaleString()} km for it. `
            + "Correct the logbook first, then the card.", 409);
        }
        if (body.mechanicEmployeeId && body.mechanicEmployeeId !== card.mechanic_employee_id) {
          const emp = await c.query(
            `select full_name from employees
              where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.mechanicEmployeeId, req.user.tid]);
          if (!emp.rowCount) {
            throw new ApiError("VALIDATION_FAILED",
              "That mechanic is not a staff record of this company.", 400, [{ field: "mechanicEmployeeId" }]);
          }
        }

        const row = await c.query(`
          update work_orders set
            raised_on = coalesce($3::date, raised_on),
            title = $4, detail = $5, kind = $6, place = $7,
            garage_name = nullif($8,''), garage_reference = nullif($9,''),
            mechanic_employee_id = $10::uuid, odometer_in_km = $11,
            parts_cost = coalesce($12, 0), labour_cost = coalesce($13, 0),
            other_cost = coalesce($14, 0), currency = coalesce($15, 'TZS'),
            invoice_ref = nullif($16,''), updated_by = $17, updated_at = now()
          where id = $1 and tenant_id = $2 and deleted_at is null
            and status = any($18::text[])
          returning id, ref, status, title, kind, place, garage_name,
                    raised_on::text as raised_on, odometer_in_km`,
          [id, req.user.tid, body.raisedOn ?? null, body.title, body.detail ?? null, body.kind,
           body.place, body.garageName ?? null, body.garageReference ?? null,
           body.mechanicEmployeeId ?? null, body.odometerInKm ?? null,
           body.partsCost ?? 0, body.labourCost ?? 0, body.otherCost ?? 0,
           body.currency ?? "TZS", body.invoiceRef ?? null, req.user.sub, OPEN_STATUSES]);
        if (!row.rowCount) {
          throw new ApiError("CONFLICT", "That card was closed while you were editing it.", 409);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "work_orders", entityId: id,
          action: "work_order.edited",
          before: {
            raised_on: card.raised_on, title: card.title, kind: card.kind, place: card.place,
            garage: card.garage_name, parts: String(card.parts_cost),
            labour: String(card.labour_cost), other: String(card.other_cost)
          },
          after: {
            raised_on: body.raisedOn ?? card.raised_on,
            title: body.title, kind: body.kind, place: body.place, garage: body.garageName ?? null,
            parts: body.partsCost ?? 0, labour: body.labourCost ?? 0, other: body.otherCost ?? 0
          }
        });
        return row.rows[0];
      });

      return reply.send({ ok: true, ...result });
    });

  // ---------- Into the workshop ----------
  app.post("/work-orders/:id/workshop",
    { preHandler: [requireAuth, requirePermission("work_orders.edit")] }, async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = moveSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const before = await c.query(
          `select status, ref, title, kind, vessel_id, place, garage_name, opened_at,
                  odometer_in_km
             from work_orders where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!before.rowCount) throw new ApiError("NOT_FOUND", "Work order not found", 404);
        const card = before.rows[0];
        if (!OPEN_STATUSES.includes(card.status)) {
          throw new ApiError("CONFLICT",
            `Work order ${card.ref} is already ${card.status}.`, 409);
        }
        // A truck that is somebody's hired rig is not in a workshop, and letting both be true
        // would put the assignment register and the work order in disagreement — which is
        // exactly what 092 was built to stop. The driver's name is the only thing the refusal
        // needs; the phone stays in its encrypted column.
        const heldBy = await c.query(
          `select d.full_name from vessel_assignments a
             join drivers d on d.id = a.driver_id and d.tenant_id = a.tenant_id
            where a.tenant_id = $1 and a.vessel_id = $2 and a.status = 'active'
              and a.deleted_at is null`,
          [req.user.tid, card.vessel_id]);
        if (heldBy.rowCount) {
          throw new ApiError("VESSEL_ON_ASSIGNMENT",
            `This vehicle is on an open assignment with ${heldBy.rows[0].full_name}. End the `
            + "handover before the plate goes into the workshop.", 409);
        }

        // The opening stamp is filled by the first move and never by a later one, so the card
        // remembers when the plate actually arrived rather than when someone last touched it.
        const row = await c.query(`
          update work_orders
             set status = $3,
                 opened_at = coalesce(opened_at, now()),
                 opened_by = coalesce(opened_by, $4),
                 updated_by = $4, updated_at = now()
           where id = $1 and tenant_id = $2 and deleted_at is null
             and status = any($5::text[])
           returning id, ref, status, opened_at`,
          [id, req.user.tid, body.status, req.user.sub, OPEN_STATUSES]);
        if (!row.rowCount) {
          throw new ApiError("CONFLICT", "That card moved while you were working on it.", 409);
        }

        const vessel = await c.query(`
          update vessels set status = 'in_garage',
                 status_reason = $2, updated_by = $3, updated_at = now()
            where id = $1 and tenant_id = $4 and deleted_at is null
              and status <> 'in_garage'
            returning id, status`,
          [card.vessel_id,
           `${card.ref}: ${card.title}${card.place === "outside_garage" ? ` at ${card.garage_name}` : " in house"}`.slice(0, 200),
           req.user.sub, req.user.tid]);

        // A note typed at a move is the clerk's own account of why the plate is standing still,
        // and it belongs where the next reader of the plate will find it. A reason typed into a
        // form that renders nowhere is a dead end, not a record.
        if (body.note) {
          await c.query(`
            insert into vessel_log_entries (id, tenant_id, vessel_id, entry_date, kind, title,
                                            detail, odometer_km, actor_name, created_by, updated_by)
            values ($1,$2,$3, current_date, 'note', $4, $5, null, null, $6, $6)`,
            [uuidv7(), req.user.tid, card.vessel_id,
             `Work order ${card.ref}: ${body.status === "awaiting_parts"
               ? "held for parts" : "opened in the workshop"}`,
             body.note, req.user.sub]);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "work_orders", entityId: id,
          action: body.status === "awaiting_parts" ? "work_order.awaiting_parts" : "work_order.in_workshop",
          before: { status: card.status },
          after: {
            status: body.status, note: body.note ?? null,
            vessel_status_changed: !!vessel.rowCount
          }
        });
        return { row: row.rows[0], vesselMoved: !!vessel.rowCount };
      });

      return reply.send({ ok: true, ...out });
    });

  // ---------- Back on the road ----------
  //
  // The one act that ends a visit and the one that may put money on a closed card. The odometer
  // out is mandatory because it is the number every later conversation starts from, and it is
  // pushed into the vessel with the guarded bump the logbook uses, so a late typing cannot walk
  // the plate backwards.
  app.post("/work-orders/:id/return",
    { preHandler: [requireAuth, requirePermission("work_orders.close")] }, async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = returnSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const before = await c.query(
          `select w.status, w.ref, w.title, w.kind, w.vessel_id, w.place, w.garage_name,
                  w.odometer_in_km, w.parts_cost, w.labour_cost, w.other_cost, w.currency,
                  e.full_name as mechanic_name
             from work_orders w
             left join employees e on e.id = w.mechanic_employee_id and e.tenant_id = w.tenant_id
            where w.id = $1 and w.tenant_id = $2 and w.deleted_at is null`,
          [id, req.user.tid]);
        if (!before.rowCount) throw new ApiError("NOT_FOUND", "Work order not found", 404);
        const card = before.rows[0];
        if (!OPEN_STATUSES.includes(card.status)) {
          throw new ApiError("CONFLICT",
            `Work order ${card.ref} is already ${card.status}. A closed card is not reopened.`, 409);
        }
        if (card.odometer_in_km != null && body.odometerOutKm < Number(card.odometer_in_km)) {
          throw new ApiError("ODOMETER_REGRESSION",
            `The card opened at ${Number(card.odometer_in_km).toLocaleString()} km, so it cannot `
            + `come back at ${body.odometerOutKm.toLocaleString()} km.`, 409);
        }
        const vessel = await c.query(
          `select status, odometer_km from vessels
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [card.vessel_id, req.user.tid]);
        if (!vessel.rowCount) throw new ApiError("NOT_FOUND", "Vessel not found", 404);
        const stored = Number(vessel.rows[0].odometer_km ?? 0);

        // A card can be closed straight from `raised` — the job was done and the clerk is
        // writing it up after the fact — so the opening stamp is filled here too, because 109
        // will not accept a returned row that cannot say when the plate went in.
        const row = await c.query(`
          update work_orders
             set status = 'returned', odometer_out_km = $3,
                 parts_cost = coalesce($4::numeric, parts_cost),
                 labour_cost = coalesce($5::numeric, labour_cost),
                 other_cost = coalesce($6::numeric, other_cost),
                 currency = coalesce($7::text, currency),
                 invoice_ref = coalesce(nullif($8,''), invoice_ref),
                 opened_at = coalesce(opened_at, now()),
                 opened_by = coalesce(opened_by, $9),
                 returned_at = now(), returned_by = $9,
                 updated_by = $9, updated_at = now()
           where id = $1 and tenant_id = $2 and deleted_at is null
             and status = any($10::text[])
           returning id, ref, status, odometer_out_km, returned_at`,
          [id, req.user.tid, body.odometerOutKm,
           body.partsCost ?? null, body.labourCost ?? null, body.otherCost ?? null,
           body.currency ?? null, body.invoiceRef ?? null, req.user.sub, OPEN_STATUSES]);
        if (!row.rowCount) {
          throw new ApiError("CONFLICT", "That card was closed while you were working on it.", 409);
        }

        let odometerMoved = false;
        if (body.odometerOutKm > stored) {
          const r = await c.query(
            `update vessels set odometer_km = $2, updated_by = $3, updated_at = now()
              where id = $1 and tenant_id = $4 and deleted_at is null and odometer_km < $2`,
            [card.vessel_id, body.odometerOutKm, req.user.sub, req.user.tid]);
          odometerMoved = !!r.rowCount;
        }
        // The plate's own state is a projection of this card, so ending the visit moves it: back
        // on the road means standby, and a truck the workshop refused to sign off says so. A plate
        // that has since gone out on a trip is left alone — this card did not put it there.
        const nextStatus = body.roadworthy ? "standby" : "out_of_service";
        const moved = await c.query(`
          update vessels set status = $2, status_reason = $3, updated_by = $4, updated_at = now()
            where id = $1 and tenant_id = $5 and deleted_at is null
              and status in ('in_garage','out_of_service')
            returning id, status`,
          [card.vessel_id, nextStatus,
           body.roadworthy
             ? `Returned from ${card.ref}${card.place === "outside_garage" ? ` (${card.garage_name})` : " in house"}`.slice(0, 200)
             : `${card.ref}: signed off unroadworthy${body.note ? ` — ${body.note}` : ""}`.slice(0, 200),
           req.user.sub, req.user.tid]);

        await c.query(`
          insert into vessel_log_entries (id, tenant_id, vessel_id, entry_date, kind, title,
                                          detail, odometer_km, actor_name, created_by, updated_by)
          values ($1,$2,$3, current_date, $4, $5, $6, $7, $8, $9, $9)`,
          [uuidv7(), req.user.tid, card.vessel_id, journalKind(card.kind),
           `Work order ${card.ref} closed: ${card.title}`,
           `${body.roadworthy ? "Back on the road" : "Left in the workshop as unroadworthy"}`
           + `${body.note ? ` — ${body.note}` : ""}. `
           + "The figures live on the work order, not in this journal.",
           body.odometerOutKm,
           card.place === "outside_garage" ? card.garage_name : card.mechanic_name,
           req.user.sub]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "work_orders", entityId: id,
          action: "work_order.returned",
          before: {
            status: card.status, parts: String(card.parts_cost), labour: String(card.labour_cost),
            other: String(card.other_cost), vessel_status: vessel.rows[0].status,
            vessel_odometer_km: stored
          },
          after: {
            status: "returned", odometer_out_km: body.odometerOutKm,
            parts: body.partsCost ?? Number(card.parts_cost),
            labour: body.labourCost ?? Number(card.labour_cost),
            other: body.otherCost ?? Number(card.other_cost),
            roadworthy: body.roadworthy, vessel_status: nextStatus,
            vessel_status_changed: !!moved.rowCount, vessel_odometer_updated: odometerMoved,
            note: body.note ?? null
          }
        });
        return {
          ref: row.rows[0].ref, status: row.rows[0].status,
          odometer_out_km: row.rows[0].odometer_out_km,
          vessel_status: nextStatus, vessel_status_changed: !!moved.rowCount,
          vessel_odometer_updated: odometerMoved
        };
      });

      return reply.send({ ok: true, ...out });
    });

  // ---------- Called off ----------
  //
  // A card that was typed wrong is cancelled by the seat that typed it while nothing has happened
  // to the vehicle yet; once the plate is in the workshop only a closing seat can call it off,
  // because somebody has started work on it. Either way the reason is typed, not guessed.
  //
  // The gate is deliberately the *view* key: this route decides for itself who may cancel, and
  // the second of its two rules ("you wrote it, and the plate has not moved") is not a duty any
  // role holds — it is a fact about the row, which is why it is answered here rather than by a
  // preHandler that could only ever check a key.
  app.post("/work-orders/:id/cancel",
    { preHandler: [requireAuth, requirePermission("work_orders.view")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = cancelSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const before = await c.query(
          `select status, ref, title, kind, vessel_id, place, garage_name, created_by,
                  parts_cost, labour_cost, other_cost
             from work_orders where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!before.rowCount) throw new ApiError("NOT_FOUND", "Work order not found", 404);
        const card = before.rows[0];
        if (!OPEN_STATUSES.includes(card.status)) {
          throw new ApiError("CONFLICT", `Work order ${card.ref} is already ${card.status}.`, 409);
        }
        const mayClose = await checkPermission(c, req.user.sub, "work_orders.close");
        const maySelfCancel = card.status === "raised" && card.created_by === req.user.sub;
        if (!mayClose && !maySelfCancel) {
          throw new ApiError("FORBIDDEN",
            card.status === "raised"
              ? `Nobody has moved this card yet, but it was written by another seat`
                + `${card.place === "outside_garage" ? ` and names ${card.garage_name}` : ""}. `
                + "Only its author or a seat that closes work orders can call it off."
              : `Work has started on ${card.ref}`
                + `${card.place === "outside_garage" ? ` at ${card.garage_name}` : ""}. `
                + "Only a seat that closes work orders can call it off now.", 403);
        }

        const row = await c.query(`
          update work_orders
             set status = 'cancelled', cancel_reason = $3, cancelled_by = $4,
                 parts_cost = 0, labour_cost = 0, other_cost = 0,
                 updated_by = $4, updated_at = now()
           where id = $1 and tenant_id = $2 and deleted_at is null
             and status = any($5::text[])
           returning id, ref, status, cancel_reason`,
          [id, req.user.tid, body.reason, req.user.sub, OPEN_STATUSES]);
        if (!row.rowCount) {
          throw new ApiError("CONFLICT", "That card was closed while you were working on it.", 409);
        }

        // The truck's own state only follows the card when the workshop was the reason it was
        // parked; a cancelled card that never moved the plate must not put it back on the road.
        let released = false;
        if (card.status !== "raised") {
          const stillHeld = await c.query(`
            select count(*)::int as n from work_orders
             where tenant_id = $1 and vessel_id = $2 and deleted_at is null
               and status = any($3::text[]) and id <> $4`,
            [req.user.tid, card.vessel_id, ["in_workshop", "awaiting_parts"], id]);
          if (!stillHeld.rows[0].n) {
            const moved = await c.query(`
              update vessels set status = 'standby', status_reason = $2,
                     updated_by = $3, updated_at = now()
                where id = $1 and tenant_id = $4 and deleted_at is null and status = 'in_garage'
                returning id`,
              [card.vessel_id, `Work order ${card.ref} called off`.slice(0, 200),
               req.user.sub, req.user.tid]);
            released = !!moved.rowCount;
          }
        }

        await c.query(`
          insert into vessel_log_entries (id, tenant_id, vessel_id, entry_date, kind, title,
                                          detail, odometer_km, actor_name, created_by, updated_by)
          values ($1,$2,$3, current_date, 'note', $4, $5, null, null, $6, $6)`,
          [uuidv7(), req.user.tid, card.vessel_id,
           `Work order ${card.ref} called off: ${card.title}`, body.reason, req.user.sub]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "work_orders", entityId: id,
          action: "work_order.cancelled",
          before: {
            status: card.status, parts: String(card.parts_cost), labour: String(card.labour_cost),
            other: String(card.other_cost)
          },
          after: { status: "cancelled", reason: body.reason, by: req.user.sub, vessel_released: released }
        });
        return { ref: row.rows[0].ref, status: "cancelled", vessel_released: released };
      });

      return reply.send({ ok: true, ...out });
    });
}
