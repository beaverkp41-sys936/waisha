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
const STATUSES = ["stored", "released", "cancelled"] as const;
const money = z.number().nonnegative().max(1e12);

/**
 * The crate's marking, or nothing at all.
 *
 * The desk sends an empty box to clear a number that turned out to be wrong, so "" is a valid
 * answer; four characters is what 118's CHECK demands of anything else. Said here as a refusal
 * naming the box rather than as a constraint error out of the database, because a clerk who typed
 * "ABC" needs to know which field to go back to.
 */
const container = z.string().trim().max(30)
  .refine((v) => v === "" || v.length >= 4,
    "A container number is the whole marking cast on the door — four characters at least.")
  .nullable().optional();

const openSchema = z.object({
  shipmentId: z.string().uuid(),
  place: z.string().trim().min(3).max(120),
  goods: z.string().trim().min(3).max(200),
  unit: z.string().trim().min(1).max(24).default("pcs"),
  containerNumber: container,
  dailyRate: money.default(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("TZS"),
  freeDays: z.number().int().min(0).max(365).default(0),
  notes: z.string().max(1000).nullable().optional(),
  // The first docket comes with the hold: a crate does not arrive without being counted, and a
  // desk that had to save twice would leave a hold on the shelf that received nothing.
  entryDay: dateOnly.optional(),
  quantity: z.number().positive().max(1e9).optional(),
  docketRef: z.string().trim().max(60).nullable().optional()
});

const editSchema = z.object({
  place: z.string().trim().min(3).max(120),
  goods: z.string().trim().min(3).max(200),
  unit: z.string().trim().min(1).max(24).default("pcs"),
  containerNumber: container,
  dailyRate: money.default(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("TZS"),
  freeDays: z.number().int().min(0).max(365).default(0),
  notes: z.string().max(1000).nullable().optional()
});

const entrySchema = z.object({
  slipDay: dateOnly,
  quantity: z.number().positive().max(1e9),
  docketRef: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional()
});

const exitSchema = entrySchema;

const voidSchema = z.object({
  reason: z.string().trim().min(3).max(300)
});

const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(300)
});

/**
 * The register, priced against one clock.
 *
 * `today` is read from the working day of the country (Africa/Dar_es_Salaam), not from the row and
 * not from UTC — a hold still in the store grows by one day every morning, and two clerks looking
 * at the same register at 23:00 must see the same figure. It arrives as a bind and is handed to the
 * three functions of 118, so the number printed here is the number printed everywhere.
 *
 * The quantity and the two dates are projections of the dockets, so they are read, never computed
 * in this file; the balance is the only arithmetic left, and it is a subtraction.
 *
 * The last predicate is the single-hold read. It is a parameter rather than a second copy of this
 * SQL because a register and a detail card that are written twice drift, and the desk would then
 * show a clerk one figure in the list and another when they opened the row.
 *
 * Every statement below is exported so that scripts/verify-warehouse-sql.ts can run the same words
 * as `app_runtime`: a column list, a parameter count or a missing grant is then caught against what
 * the desks actually send, not against a re-typed copy a typecheck is happy with.
 */
export const STAYS_SQL = `
  with clock as (select (timezone('Africa/Dar_es_Salaam', now()))::date as today)
  select w.id, w.ref, w.shipment_id, s.file_number, s.shipment_type, s.stage,
         s.status as file_status, s.consignee_name,
         w.place, w.goods, w.unit, w.container_number,
         w.daily_rate::float8 as daily_rate, w.currency, w.free_days, w.status,
         w.entered_on::text as entered_on, w.exited_on::text as exited_on,
         w.quantity_in::float8 as quantity_in, w.quantity_out::float8 as quantity_out,
         (w.quantity_in - w.quantity_out)::float8 as balance,
         public.warehouse_days_held(w.entered_on, w.exited_on, k.today) as days_held,
         public.warehouse_charge_days(w.entered_on, w.exited_on, w.free_days, k.today) as charge_days,
         public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
                                         w.daily_rate, k.today)::float8 as storage_charge,
         k.today::text as priced_on,
         w.notes, w.cancel_reason,
         w.opened_by, ob.full_name as opened_by_name,
         w.released_by, rb.full_name as released_by_name,
         w.cancelled_by, cb.full_name as cancelled_by_name,
         w.created_at, w.created_by, ub.full_name as created_by_name,
         (select count(*)::int from warehouse_slips x
           where x.stay_id = w.id and x.tenant_id = w.tenant_id and x.state = 'filed') as docket_count,
         (select count(*)::int from documents d
           where d.tenant_id = w.tenant_id and d.entity_type = 'warehouse_stay'
             and d.entity_id = w.id) as attachments
    from warehouse_stays w
    join cargo_shipments s on s.id = w.shipment_id and s.tenant_id = w.tenant_id
    cross join clock k
    left join users ob on ob.id = w.opened_by and ob.tenant_id = w.tenant_id
    left join users rb on rb.id = w.released_by and rb.tenant_id = w.tenant_id
    left join users cb on cb.id = w.cancelled_by and cb.tenant_id = w.tenant_id
    left join users ub on ub.id = w.created_by and ub.tenant_id = w.tenant_id
   where w.tenant_id = $1 and w.deleted_at is null
     and ($2::text[] is null or w.status = any($2::text[]))
     and ($3::uuid is null or w.shipment_id = $3::uuid)
     and ($4::text is null or w.place = $4::text)
     and ($5::date is null or w.entered_on >= $5::date)
     and ($6::date is null or w.entered_on <= $6::date)
     and ($7::text is null or w.ref ilike '%' || $7 || '%'
          or w.goods ilike '%' || $7 || '%'
          or w.place ilike '%' || $7 || '%'
          or coalesce(w.container_number,'') ilike '%' || $7 || '%'
          or s.file_number ilike '%' || $7 || '%')
     and ($10::uuid is null or w.id = $10::uuid)
   order by (w.status = 'stored') desc, w.entered_on asc nulls last, w.created_at desc
   limit $8 offset $9`;

export const DOCKETS_SQL = `
  select x.id, x.kind, x.ref, x.slip_day::text as slip_day, x.quantity::float8 as quantity,
         x.docket_ref, x.note, x.state,
         x.filed_by, fb.full_name as filed_by_name, x.filed_at,
         x.voided_by, vb.full_name as voided_by_name, x.voided_at, x.void_reason
    from warehouse_slips x
    left join users fb on fb.id = x.filed_by and fb.tenant_id = x.tenant_id
    left join users vb on vb.id = x.voided_by and vb.tenant_id = x.tenant_id
   where x.stay_id = $1 and x.tenant_id = $2
   order by x.slip_day desc, x.filed_at desc`;

/** The store's own clock, read once per act so a docket is never dated ahead of the register. */
export const STORE_CLOCK_SQL =
  `select (timezone('Africa/Dar_es_Salaam', now()))::date::text as today`;

/**
 * The hold, locked, in this company's register.
 *
 * `for update` is the point as much as the read: two dockets filed in the same second against one
 * hold would each check a balance the other had not yet moved, and the store would release or
 * receive twice. 118's own trigger takes the same lock, so the two paths cannot disagree.
 */
export const HOLD_LOCK_SQL = `
       select id, ref, status, place, goods, unit, container_number,
              daily_rate::float8 as daily_rate, currency, free_days, notes,
              entered_on::text as entered_on, exited_on::text as exited_on,
              quantity_in::float8 as quantity_in, quantity_out::float8 as quantity_out,
              (quantity_in - quantity_out)::float8 as balance
         from warehouse_stays
        where id = $1 and tenant_id = $2 and deleted_at is null
        for update`;

/** The picker's five columns — see the note on the door that runs it. */
export const FILES_SQL = `
    select s.id, s.file_number, s.shipment_type, s.stage, s.status, s.consignee_name,
           s.container_count,
           (select count(*)::int from warehouse_stays w
             where w.tenant_id = s.tenant_id and w.shipment_id = s.id
               and w.deleted_at is null and w.status = 'stored') as holds_in_store
      from cargo_shipments s
     where s.tenant_id = $1 and s.deleted_at is null
       and ($2::text is null or s.file_number ilike '%' || $2 || '%'
            or s.consignee_name ilike '%' || $2 || '%'
            or s.cargo_description ilike '%' || $2 || '%')
     order by s.created_at desc
     limit 100`;

/** The four figures under the register. `held_quantity` counts only goods still standing in the store. */
export const TOTALS_SQL = `
          select (count(*))::int as holds,
                 (count(*) filter (where w.status = 'stored'))::int as in_store,
                 (count(*) filter (where w.status = 'released'))::int as released,
                 (count(*) filter (where w.status = 'cancelled'))::int as cancelled,
                 coalesce(sum(w.quantity_in - w.quantity_out) filter (where w.status = 'stored'), 0)::float8 as held_quantity,
                 (timezone('Africa/Dar_es_Salaam', now()))::date::text as priced_on
            from warehouse_stays w
           where w.tenant_id = $1 and w.deleted_at is null`;

/** Money is summed per currency, never across one: a store billing a container in USD and
 *  the rest in TZS does not have one total, and inventing one would print a figure that is neither. */
export const BY_CURRENCY_SQL = `
          select w.currency,
                 (count(*))::int as holds,
                 coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
                                                             w.daily_rate, k.today)), 0)::float8 as charge
            from warehouse_stays w
            cross join (select (timezone('Africa/Dar_es_Salaam', now()))::date as today) k
           where w.tenant_id = $1 and w.deleted_at is null and w.status <> 'cancelled'
           group by w.currency, k.today
           order by coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
                                                                w.daily_rate, k.today)), 0) desc`;

export const BY_PLACE_SQL = `
          select w.place,
                 (count(*))::int as holds,
                 (count(*) filter (where w.status = 'stored'))::int as in_store,
                 coalesce(sum(w.quantity_in - w.quantity_out) filter (where w.status = 'stored'), 0)::float8 as held_quantity,
                 max(w.entered_on)::text as oldest_entry
            from warehouse_stays w
           where w.tenant_id = $1 and w.deleted_at is null
           group by w.place
           order by (count(*) filter (where w.status = 'stored')) desc, sum(w.quantity_in) desc
           limit 12`;

/** The files that are costing the most to sit on — the list a clearing agent works down. */
export const BY_FILE_SQL = `
          select s.file_number, s.consignee_name, s.shipment_type,
                 w.currency,
                 (count(*))::int as holds,
                 coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
                                                             w.daily_rate, k.today)), 0)::float8 as charge
            from warehouse_stays w
            join cargo_shipments s on s.id = w.shipment_id and s.tenant_id = w.tenant_id
            cross join (select (timezone('Africa/Dar_es_Salaam', now()))::date as today) k
           where w.tenant_id = $1 and w.deleted_at is null and w.status = 'stored'
           group by s.file_number, s.consignee_name, s.shipment_type, w.currency
           order by coalesce(sum(public.warehouse_storage_charge(w.entered_on, w.exited_on, w.free_days,
                                                                w.daily_rate, k.today)), 0) desc
           limit 12`;

/**
 * A hold as it opens. Only the header is typed here: the reference and the status come from 118's
 * shape trigger, and the two quantities and two dates are the dockets' conclusions, written by the
 * booking trigger as the first delivery is filed.
 */
export const OPEN_INSERT_SQL = `
          insert into warehouse_stays
            (id, tenant_id, shipment_id, place, goods, unit, container_number,
             daily_rate, currency, free_days, notes, opened_by, created_by, updated_by)
          values ($1, $2, $3, $4, $5, $6, nullif($7,''), $8, $9, $10, nullif($11,''), $12, $12, $12)
          returning id, ref, status`;

/**
 * One docket, priced into the hold it belongs to. Every caller of the register writes through here.
 * The reference and the balance are written by 118's triggers, so no column of theirs appears.
 */
export const DOCKET_INSERT_SQL = `
     insert into warehouse_slips (id, tenant_id, stay_id, kind, slip_day, quantity,
                                  docket_ref, note, filed_by, filed_at, created_at)
     values ($1, $2, $3, $4, $5::date, $6, nullif($7,''), nullif($8,''), $9, now(), now())
     returning id, ref, kind, slip_day::text as slip_day, quantity::float8 as quantity,
               docket_ref, note, state, filed_by`;

async function fileDocket(c: any, tid: string, stayId: string,
  kind: "entry" | "exit", slipDay: string, quantity: number,
  docketRef: string | null, note: string | null, filedBy: string) {
  const { rows } = await c.query(DOCKET_INSERT_SQL,
    [uuidv7(), tid, stayId, kind, slipDay, quantity, docketRef, note, filedBy]);
  return rows[0];
}

/** The hold after an act that moves its balance: whether the store now calls it released is the
 *  booking trigger's conclusion, so the desk is told what the row says rather than what it hoped. */
export const HOLD_STATE_SQL = `
             select w.status, w.quantity_out::float8 as quantity_out, w.exited_on::text as exited_on,
                    w.released_by, rb.full_name as released_by_name
               from warehouse_stays w
               left join users rb on rb.id = w.released_by and rb.tenant_id = w.tenant_id
              where w.id = $1 and w.tenant_id = $2`;

/** The header a tariff change writes. Quantities, the two dates and the status are absent on
 *  purpose — they are the dockets' conclusions, and the freeze trigger refuses them anyway. */
export const HOLD_EDIT_SQL = `
           update warehouse_stays
              set place = $3, goods = $4, unit = $5, container_number = nullif($6,''),
                  daily_rate = $7, currency = $8, free_days = $9, notes = nullif($10,''),
                  updated_by = $11
            where id = $1 and tenant_id = $2 and deleted_at is null
            returning id, ref, place, goods, unit, container_number,
                      daily_rate::float8 as daily_rate, currency, free_days, notes`;

/** A called-off hold carries its reason and the name that called it off, or the trigger refuses it. */
export const HOLD_CANCEL_SQL = `
           update warehouse_stays
              set status = 'cancelled', cancel_reason = $3, cancelled_by = $4, updated_by = $4
            where id = $1 and tenant_id = $2 and deleted_at is null and status <> 'cancelled'
            returning id, ref, status, cancel_reason, cancelled_by`;

/** The docket and the hold it hangs on, read together, before anything is allowed to move it. */
export const SLIP_HOLD_SQL = `
            select x.id, x.ref, x.kind, x.state, x.quantity::float8 as quantity,
                   x.stay_id, w.ref as hold_ref, w.status as hold_status,
                   w.quantity_in::float8 as quantity_in, w.quantity_out::float8 as quantity_out
              from warehouse_slips x
              join warehouse_stays w on w.id = x.stay_id and w.tenant_id = x.tenant_id
             where x.id = $1 and x.tenant_id = $2`;

export const SLIP_VOID_SQL = `
           update warehouse_slips
              set state = 'voided', voided_by = $3, voided_at = now(), void_reason = $4
            where id = $1 and tenant_id = $2 and state = 'filed'
            returning id, ref, kind, state, void_reason, voided_at`;

/** What the voiding did to the balance — the booking trigger has already taken the quantity back. */
export const HOLD_BALANCE_SQL = `
             select status, quantity_in::float8 as quantity_in, quantity_out::float8 as quantity_out
               from warehouse_stays where id = $1 and tenant_id = $2`;

/** The register read for one hold — the same SQL the list runs, so a card and its row agree. */
function stayParams(tid: string, id: string) {
  return [tid, null, null, null, null, null, null, 1, 0, id];
}

export async function warehouseRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The register ----------
  app.get("/warehouse/stays", { preHandler: [requireAuth, requirePermission("warehouse.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(STATUSES).optional(),
        shipmentId: z.string().uuid().optional(),
        place: z.string().trim().max(120).optional(),
        from: dateOnly.optional(), to: dateOnly.optional(),
        q: z.string().trim().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).max(5000).default(0)
      }).parse(req.query);

      const statuses = q.status ? [q.status] : null;

      return withTenant(req.user.tid, async (c) => {
        const held = {
          entry: await checkPermission(c, req.user.sub, "warehouse.entry"),
          exit: await checkPermission(c, req.user.sub, "warehouse.exit"),
          edit: await checkPermission(c, req.user.sub, "warehouse.edit"),
          void: await checkPermission(c, req.user.sub, "warehouse.void"),
          cancel: await checkPermission(c, req.user.sub, "warehouse.cancel")
        };
        const { rows } = await c.query(STAYS_SQL, [
          req.user.tid, statuses, q.shipmentId ?? null, q.place ?? null,
          q.from ?? null, q.to ?? null, q.q || null, q.limit, q.offset, null
        ]);
        return rows.map((r: any) => ({
          ...r,
          // A hold is worked on while it is still the store's problem. Once the goods left, or the
          // hold was called off, 118 freezes the row and a new delivery needs its own hold — so the
          // button and the door say the same thing, and the desk never offers an act it will refuse.
          can_edit: r.status === "stored" && held.edit,
          can_enter: r.status === "stored" && held.entry,
          can_exit: r.status === "stored" && held.exit && Number(r.balance) > 0,
          can_cancel: r.status === "stored" && Number(r.quantity_in) === 0 && held.cancel,
          can_void: r.status !== "cancelled" && held.void,
          edit_block: r.status !== "stored" ? r.status : held.edit ? null : "no_key"
        }));
      });
    });

  // ---------- One hold, with the paper behind it ----------
  app.get("/warehouse/stays/:id", { preHandler: [requireAuth, requirePermission("warehouse.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const stay = await c.query(STAYS_SQL, stayParams(req.user.tid, id));
        if (!stay.rowCount) throw new ApiError("NOT_FOUND", "Hold not found", 404);
        const dockets = await c.query(DOCKETS_SQL, [id, req.user.tid]);
        return { ...stay.rows[0], dockets: dockets.rows };
      });
    });

  // ---------- Which file the goods belong to ----------
  //
  // A hold is opened *from* a cargo file, so the desk needs a picker. It cannot use GET /cargo:
  // that answers `shipments.view` and carries the whole file sheet. These are the five columns a
  // clerk reads to choose, and nothing else.
  app.get("/warehouse/files", { preHandler: [requireAuth, requirePermission("warehouse.view")] },
    async (req: any) => {
      const q = z.object({ q: z.string().trim().max(80).optional() }).parse(req.query);
      const { rows } = await withTenant(req.user.tid, (c) =>
        c.query(FILES_SQL, [req.user.tid, q.q || null]));
      return rows;
    });

  // ---------- What the store is holding and costing ----------
  app.get("/warehouse/summary", { preHandler: [requireAuth, requirePermission("warehouse.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const totals = await c.query(TOTALS_SQL, [req.user.tid]);
        const byCurrency = await c.query(BY_CURRENCY_SQL, [req.user.tid]);
        const byPlace = await c.query(BY_PLACE_SQL, [req.user.tid]);
        const byFile = await c.query(BY_FILE_SQL, [req.user.tid]);

        return {
          totals: totals.rows[0], byCurrency: byCurrency.rows,
          byPlace: byPlace.rows, byFile: byFile.rows
        };
      });
    });

  // ---------- Open a hold, and count the first goods into it ----------
  app.post("/warehouse/stays", { preHandler: [requireAuth, requirePermission("warehouse.entry")] },
    async (req: any, reply) => {
      await enforceRateLimit(`wh:open:uid:${req.user.sub}`, 120, 3600);
      const body = openSchema.parse(req.body);
      const hasEntry = body.quantity != null;

      if (hasEntry && !body.entryDay) {
        throw new ApiError("VALIDATION_FAILED",
          "A docket that counts goods in is dated the day they arrived.", 400, [{ field: "entryDay" }]);
      }

      const id = uuidv7();
      const out = await withTenant(req.user.tid, async (c) => {
        const today = await c.query(STORE_CLOCK_SQL);
        const localToday = String(today.rows[0].today);
        const day = body.entryDay ?? localToday;
        if (day > localToday) {
          throw new ApiError("SLIP_DATE_FUTURE",
            `Goods cannot be counted in on ${day} — the store's clock reads ${localToday}. `
            + "A docket is written the day the crate arrives.", 400);
        }

        const file = await c.query(
          `select file_number, shipment_type, status from cargo_shipments
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [body.shipmentId, req.user.tid]);
        if (!file.rowCount) {
          throw new ApiError("NOT_FOUND",
            "That cargo file is not in your register — a hold is opened against one of your own files.", 404);
        }

        const stay = await c.query(OPEN_INSERT_SQL,
          [id, req.user.tid, body.shipmentId, body.place, body.goods, body.unit,
           body.containerNumber ?? null, body.dailyRate, body.currency, body.freeDays,
           body.notes ?? null, req.user.sub]).then((r) => r.rows[0]);

        const slip = hasEntry
          ? await fileDocket(c, req.user.tid, id, "entry", day,
            Number(body.quantity), body.docketRef ?? null, null, req.user.sub)
          : null;

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "warehouse_stays", entityId: id,
          action: "warehouse.hold_opened",
          after: {
            ref: stay.ref, file: file.rows[0].file_number, place: body.place,
            goods: body.goods, unit: body.unit, daily_rate: body.dailyRate,
            currency: body.currency, free_days: body.freeDays,
            entry: slip ? { ref: slip.ref, day: slip.slip_day, quantity: slip.quantity } : null
          }
        });

        // Read back through the register's own SQL: the projections the booking trigger wrote from
        // the docket are what the desk is told, not what this route hoped they would be.
        const read = await c.query(STAYS_SQL, stayParams(req.user.tid, id));
        return { ...read.rows[0], dockets: slip ? [slip] : [] };
      });

      return reply.status(201).send(out);
    });

  // ---------- Another delivery into a hold already open ----------
  app.post("/warehouse/stays/:id/entries",
    { preHandler: [requireAuth, requirePermission("warehouse.entry")] },
    async (req: any, reply) => {
      await enforceRateLimit(`wh:entry:uid:${req.user.sub}`, 240, 3600);
      const { id } = req.params as { id: string };
      const body = entrySchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const hold = await lockHold(c, id, req.user.tid);
        refuseClosedHold(hold);
        const today = await c.query(STORE_CLOCK_SQL);
        if (body.slipDay > String(today.rows[0].today)) {
          throw new ApiError("SLIP_DATE_FUTURE",
            `Goods cannot be counted in on ${body.slipDay} — the store's clock reads `
            + `${today.rows[0].today}.`, 400);
        }
        const slip = await fileDocket(c, req.user.tid, id, "entry",
          body.slipDay, body.quantity, body.docketRef ?? null, body.note ?? null, req.user.sub);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "warehouse_stays", entityId: id,
          action: "warehouse.goods_entered",
          after: { ref: hold.ref, docket: slip.ref, day: slip.slip_day, quantity: slip.quantity }
        });
        return slip;
      });
      return reply.status(201).send(out);
    });

  // ---------- A docket that takes goods out ----------
  app.post("/warehouse/stays/:id/exits",
    { preHandler: [requireAuth, requirePermission("warehouse.exit")] },
    async (req: any, reply) => {
      await enforceRateLimit(`wh:exit:uid:${req.user.sub}`, 240, 3600);
      const { id } = req.params as { id: string };
      const body = exitSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const hold = await lockHold(c, id, req.user.tid);
        refuseCancelledHold(hold);
        const today = await c.query(STORE_CLOCK_SQL);
        if (body.slipDay > String(today.rows[0].today)) {
          throw new ApiError("SLIP_DATE_FUTURE",
            `Goods cannot leave the store on ${body.slipDay} — the store's clock reads `
            + `${today.rows[0].today}.`, 400);
        }
        if (hold.entered_on && body.slipDay < hold.entered_on) {
          throw new ApiError("SLIP_BEFORE_ARRIVAL",
            `The goods were counted in on ${hold.entered_on}, so they cannot leave on `
            + `${body.slipDay}.`, 400);
        }
        if (Number(body.quantity) > Number(hold.balance)) {
          throw new ApiError("OVER_RELEASE",
            `Hold ${hold.ref} has ${hold.balance.toLocaleString()} ${hold.unit} of the `
            + `${hold.quantity_in.toLocaleString()} it received. It cannot let out `
            + `${body.quantity.toLocaleString()} — the store would hand over goods it does not have.`, 409);
        }

        const slip = await fileDocket(c, req.user.tid, id, "exit",
          body.slipDay, body.quantity, body.docketRef ?? null, body.note ?? null, req.user.sub);

        // Read after the booking trigger has run: whether the store now calls this released, and the
        // day it says it released it, are conclusions about the dockets, not this route's hope.
        const after = await c.query(HOLD_STATE_SQL, [id, req.user.tid]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "warehouse_stays", entityId: id,
          action: "warehouse.goods_released",
          after: {
            ref: hold.ref, docket: slip.ref, day: slip.slip_day, quantity: slip.quantity,
            status: after.rows[0].status, exited_on: after.rows[0].exited_on
          }
        });
        return { ...slip, hold: after.rows[0] };
      });
      return reply.status(201).send(out);
    });

  // ---------- Set the tariff, the place or the goods on a hold still in the store ----------
  //
  // One static UPDATE: a re-sent form is a write of the whole sheet, and an empty container field
  // has to be able to clear a crate that turned out not to be one. The quantities, the two dates
  // and the status are absent on purpose — they are the dockets' conclusions.
  app.put("/warehouse/stays/:id", { preHandler: [requireAuth, requirePermission("warehouse.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = editSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const hold = await lockHold(c, id, req.user.tid);
        if (hold.status !== "stored") {
          throw new ApiError("CONFLICT",
            `Hold ${hold.ref} is ${hold.status}. A hold that has been emptied or called off is not `
            + "rewritten — the tariff it was priced at is part of the story that was told.", 409);
        }
        const updated = await c.query(HOLD_EDIT_SQL,
          [id, req.user.tid, body.place, body.goods, body.unit, body.containerNumber ?? null,
           body.dailyRate, body.currency, body.freeDays, body.notes ?? null, req.user.sub]);
        if (!updated.rowCount) throw new ApiError("NOT_FOUND", "Hold not found", 404);
        const before = {
          place: hold.place, goods: hold.goods, unit: hold.unit,
          container_number: hold.container_number, daily_rate: hold.daily_rate,
          currency: hold.currency, free_days: hold.free_days
        };
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "warehouse_stays", entityId: id,
          action: "warehouse.hold_edited", before, after: updated.rows[0]
        });
        return updated.rows[0];
      });
      return out;
    });

  // ---------- Call a hold off ----------
  app.post("/warehouse/stays/:id/cancel",
    { preHandler: [requireAuth, requirePermission("warehouse.cancel")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = cancelSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const hold = await lockHold(c, id, req.user.tid);
        if (hold.status === "cancelled") {
          throw new ApiError("CONFLICT", `Hold ${hold.ref} is already called off.`, 409);
        }
        if (Number(hold.quantity_in) > 0) {
          throw new ApiError("HOLD_NOT_EMPTY",
            `Hold ${hold.ref} received ${hold.quantity_in.toLocaleString()} ${hold.unit} on `
            + `${hold.entered_on}. Goods that were actually counted in are got rid of by an exit `
            + "docket, not by calling the hold off — the docket keeps the paper and the correction.", 409);
        }
        const updated = await c.query(HOLD_CANCEL_SQL,
          [id, req.user.tid, body.reason, req.user.sub]);
        if (!updated.rowCount) throw new ApiError("NOT_FOUND", "Hold not found", 404);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "warehouse_stays", entityId: id,
          action: "warehouse.hold_cancelled",
          before: { status: hold.status, ref: hold.ref },
          after: { status: "cancelled", reason: body.reason }
        });
        return updated.rows[0];
      });
      return out;
    });

  // ---------- Void a docket that was filed wrong ----------
  //
  // The docket is not deleted. Its state moves, with a name and a reason, and the booking trigger
  // takes its quantity back out of the balance — so the register keeps the mistake and its
  // correction side by side, which is what a store's paper book actually looks like.
  app.post("/warehouse/slips/:id/void",
    { preHandler: [requireAuth, requirePermission("warehouse.void")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = voidSchema.parse(req.body);

      const out = await withTenant(req.user.tid, async (c) => {
        const slip = await c.query(SLIP_HOLD_SQL, [id, req.user.tid]);
        if (!slip.rowCount) throw new ApiError("NOT_FOUND", "Docket not found", 404);
        const s = slip.rows[0];
        if (s.state === "voided") {
          throw new ApiError("CONFLICT", `Docket ${s.ref} is already voided.`, 409);
        }
        if (s.hold_status === "cancelled") {
          throw new ApiError("CONFLICT",
            `Hold ${s.hold_ref} was called off; its paper is not reopened.`, 409);
        }
        // Said here in the desk's own words because the trigger's answer would be a constraint
        // sentence about a balance, and a clerk needs to know which other dockets to void first.
        const wouldIn = s.kind === "entry" ? Number(s.quantity_in) - Number(s.quantity) : Number(s.quantity_in);
        const wouldOut = s.kind === "exit" ? Number(s.quantity_out) - Number(s.quantity) : Number(s.quantity_out);
        if (wouldOut > wouldIn) {
          throw new ApiError("RELEASED_STILL_OUT",
            `Docket ${s.ref} took ${s.quantity.toLocaleString()} out of hold ${s.hold_ref}, and `
            + "that goods is still released. Void the exit dockets that have not been replaced first, "
            + "or file the delivery back in.", 409);
        }

        const voided = await c.query(SLIP_VOID_SQL,
          [id, req.user.tid, req.user.sub, body.reason]);
        if (!voided.rowCount) throw new ApiError("CONFLICT", "That docket has already been dealt with.", 409);

        const after = await c.query(HOLD_BALANCE_SQL, [s.stay_id, req.user.tid]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "warehouse_slips", entityId: id,
          action: "warehouse.docket_voided",
          before: { ref: s.ref, kind: s.kind, quantity: s.quantity, hold: s.hold_ref },
          after: { state: "voided", reason: body.reason, hold: after.rows[0] }
        });
        return { ...voided.rows[0], hold: after.rows[0] };
      });
      return out;
    });
}

/**
 * The hold, locked, in this company's register.
 *
 * `for update` is the point as much as the read: two dockets filed in the same second against one
 * hold would each check a balance the other had not yet moved, and the store would release or
 * receive twice. 118's own trigger takes the same lock, so the two paths cannot disagree.
 */
async function lockHold(c: any, id: string, tid: string) {
  const { rows } = await c.query(HOLD_LOCK_SQL, [id, tid]);
  if (!rows.length) throw new ApiError("NOT_FOUND", "Hold not found", 404);
  return rows[0];
}

/** A called-off hold takes no paper of any kind — the door that files an exit answers this way. */
function refuseCancelledHold(hold: { ref: string; status: string; cancel_reason?: string | null }) {
  if (hold.status !== "cancelled") return;
  throw new ApiError("HOLD_CANCELLED",
    `Hold ${hold.ref} was called off${hold.cancel_reason ? `: ${hold.cancel_reason}` : ""}. `
    + "Goods that really arrived belong on a new hold, not on the one that was taken off the book.", 409);
}

/**
 * A hold that has been emptied or called off takes no delivery docket.
 *
 * 118's booking trigger would happily recompute the balance and flip an emptied hold back to
 * `stored`, but `entered_on` is the *earliest* filed entry — so goods counted into a hold that
 * closed last month would be charged for every day since the first crate arrived. The register
 * keeps a closed story shut and sends new goods to a new hold, which is what a clerk does with a
 * paper book anyway. The door answers in these words rather than the trigger's, because the clerk
 * needs to know which hold to open.
 */
function refuseClosedHold(hold: {
  ref: string; status: string; exited_on?: string | null; cancel_reason?: string | null;
}) {
  refuseCancelledHold(hold);
  if (hold.status !== "released") return;
  throw new ApiError("HOLD_RELEASED",
    `Hold ${hold.ref} gave out everything it received`
    + `${hold.exited_on ? ` and closed on ${hold.exited_on}` : ""}. A new delivery belongs on a `
    + "new hold — counted into this one it would be charged from the day the first crate arrived.", 409);
}
