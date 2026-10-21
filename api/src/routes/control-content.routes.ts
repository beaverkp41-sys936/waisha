import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { requireControl } from "./control.routes.js";
import { controlHolds } from "./control-analytics.routes.js";
import {
  CONTENT_FIELDS, FIELD_BY_KEY, LOCALES, decode, encode, valueSchema,
  type ContentField, type Locale
} from "../content/fields.js";

/**
 * The command center (100; task #243) — the platform's own words, edited without a deploy.
 *
 * `content_blocks` has been readable by the runtime role since 001 and carries the duty key
 * `control.content.manage` since 005. Until 100 nothing could write it and no route had ever
 * checked the key, so the panel shipped a promise the software did not keep: the footer a
 * caller reads out loud, the support address, the answering hours, all of it lived in a
 * repository file. This is the desk for that text, and the reason the registry lives in
 * `src/content/fields.ts` instead of here: the public payload and this desk must agree, key
 * for key, about which blocks a renderer actually reads.
 *
 * The table has no tenant column — the copy belongs to the platform, not to any company — so
 * there is no tenant predicate to bind and the gate is the duty key alone. That is safe for
 * one reason only: 099 made a control session impossible for a seat that is not a platform
 * seat, so `req.control.tenant_id` here is always the platform's own tenant and the seat
 * behind it is always somebody's colleague. The audit rows use that tenant, which is what
 * makes "who changed the phone number, and when" answerable from /control/audit.
 *
 * Writes are presence-based, like the drivers PUT: a locale the desk does not send keeps
 * what it holds, and an explicit "" clears the line without deleting the row. Nothing here
 * can DELETE — 100 granted INSERT and UPDATE only, precisely so that a slip on the desk
 * cannot take away a block that the seed file is the only other copy of.
 */

const FLOOR = "control.view";
const MANAGE = "control.content.manage";

const GROUP_LABELS: Record<ContentField["group"], string> = {
  footer: "Footer",
  signin: "Sign-in and sign-up"
};

// ---------- statements ----------

/** Every registered block in both locales, with the seat that last touched it.
 *  Params: platform tenant (for the name), keys.
 *
 *  The join is bound to the platform tenant because `users` carries row security
 *  (001:395,408) and `updated_by` can only ever name a seat of that tenant — the same
 *  argument that binds every other statement in this module. */
export const CONTENT_BLOCKS_SQL = `
  select cb.key, cb.locale, cb.value, cb.updated_at, cb.updated_by,
         u.full_name as updated_by_name
    from content_blocks cb
    left join users u on u.id = cb.updated_by and u.tenant_id = $1
   where cb.key = any($2::text[])
   order by cb.key, cb.locale`;

/** One block, one locale. Params: key, locale, value, actor.
 *  The PK is (key, locale) (001:229), so the conflict target is the row's identity and a
 *  re-save cannot fork a second copy of the same line. */
export const UPSERT_BLOCK_SQL = `
  insert into content_blocks (key, locale, value, updated_by, updated_at)
  values ($1, $2, $3, $4, now())
  on conflict (key, locale) do update
    set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
  returning key, locale, value, updated_at`;

/** The desk's whole read, in the shape the page renders. Runs on the caller's client so the
 *  write path can answer from the same rows it just committed. */
async function loadDesk(c: PoolClient, tenantId: string) {
  const { rows } = await c.query(CONTENT_BLOCKS_SQL,
    [tenantId, CONTENT_FIELDS.map((f) => f.key)]);
  const byKeyLocale = new Map<string, any>();
  for (const r of rows) byKeyLocale.set(`${r.key}|${r.locale}`, r);

  const groups = (["footer", "signin"] as const).map((group) => ({
    group,
    label: GROUP_LABELS[group],
    fields: CONTENT_FIELDS.filter((f) => f.group === group).map((f) => {
      const cell = {} as Record<Locale, unknown>;
      const edited = {} as Record<Locale, { at: string | null; by: string | null }>;
      for (const locale of LOCALES) {
        const row = byKeyLocale.get(`${f.key}|${locale}`);
        cell[locale] = row ? decode(f, row.value) : (f.kind === "links" || f.kind === "social" ? [] : "");
        edited[locale] = {
          at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
          by: row?.updated_by_name ?? null
        };
      }
      return {
        key: f.key, wire: f.wire, label: f.label, kind: f.kind,
        max: f.max, hint: f.hint, values: cell, edited
      };
    })
  }));

  return { locales: [...LOCALES], groups };
}

// ---------- gates ----------

/** Reading the copy needs a floor key; rewriting it needs the duty 005 seeded for it. */
async function requireContentRead(req: any): Promise<boolean> {
  const held = await controlHolds(req, [FLOOR, MANAGE]);
  const canManage = held.includes(MANAGE);
  if (!canManage && !held.includes(FLOOR)) {
    throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
  }
  return canManage;
}

async function requireContentManage(req: any) {
  if (!(await controlHolds(req, [MANAGE])).includes(MANAGE)) {
    throw new ApiError("FORBIDDEN",
      "Reading the platform's copy is open to every control seat. Writing it is a separate "
      + "duty, and yours does not include it.", 403);
  }
}

/** What the desk may send, before each key is judged by its own rule. An absent locale keeps
 *  the row; a locale sent as null or "" clears it. Unknown keys are refused by name below. */
const envelope = z.object({
  values: z.record(z.object({
    en: z.unknown().optional(),
    sw: z.unknown().optional()
  }).strict()),
  note: z.string().trim().max(300).optional()
}).strict();

export async function controlContentRoutes(app: FastifyInstance, _opts: unknown) {
  const role = (req: any) => (req.control?.roles ?? [])[0] ?? null;

  app.get("/control/content", { preHandler: [requireControl] }, async (req: any) => {
    const canManage = await requireContentRead(req);
    await enforceRateLimit(`content:uid:${req.control.user_id}`, 60, 60);
    const tenantId = req.control.tenant_id;
    return withTenant(tenantId, async (c) => ({
      can_manage: canManage, ...(await loadDesk(c, tenantId))
    }));
  });

  app.put("/control/content", { preHandler: [requireControl] }, async (req: any) => {
    await requireContentManage(req);
    await enforceRateLimit(`content-write:uid:${req.control.user_id}`, 40, 3600);
    const body = envelope.parse(req.body ?? {});
    const keys = Object.keys(body.values ?? {});
    if (!keys.length) throw new ApiError("VALIDATION_FAILED", "Say what to change.", 400,
      [{ field: "values" }]);
    const tenantId = req.control.tenant_id;

    return withTenant(tenantId, async (c) => {
      const before = await c.query(CONTENT_BLOCKS_SQL,
        [tenantId, CONTENT_FIELDS.map((f) => f.key)]);
      const stored = new Map<string, string>(
        before.rows.map((r: any) => [`${r.key}|${r.locale}`, r.value] as [string, string]));

      // Validate everything, then write nothing: a footer that saves three of nine lines
      // because the fourth had a bad address is worse than a save that refused to start.
      const planned: { key: string; locale: Locale; value: string; label: string }[] = [];
      const problems: { field: string; message: string }[] = [];
      for (const key of keys) {
        const field = FIELD_BY_KEY.get(key);
        if (!field) {
          problems.push({
            field: key,
            message: "There is no content block here to edit. The desk only offers lines that "
              + "a page actually reads."
          });
          continue;
        }
        for (const locale of LOCALES) {
          const sent = body.values[key] as Record<string, unknown>;
          if (!(locale in sent)) continue;
          const parsed = valueSchema(field).safeParse(sent[locale]);
          if (!parsed.success) {
            problems.push({
              field: `${key}.${locale}`,
              message: parsed.error.issues[0]?.message ?? "That value does not fit the field."
            });
            continue;
          }
          const next = encode(field, parsed.data);
          const now = stored.get(`${key}|${locale}`);
          // A block that does not exist yet is written; a block that says the same thing is
          // left alone so the audit trail only carries the lines that really moved.
          if (now === next) continue;
          planned.push({ key, locale, value: next, label: field.label });
        }
      }
      if (problems.length) {
        throw new ApiError("VALIDATION_FAILED", problems[0].message, 400, problems);
      }
      if (!planned.length) {
        return { changed: 0, unchanged: true, can_manage: true, ...(await loadDesk(c, tenantId)) };
      }

      const after: Record<string, Record<string, string>> = {};
      for (const p of planned) {
        const r = await c.query(UPSERT_BLOCK_SQL, [p.key, p.locale, p.value, req.control.user_id]);
        (after[p.key] ??= {})[p.locale] = r.rows[0].value;
      }
      await writeAudit(c, {
        tenantId, actorUserId: req.control.user_id, actorRole: role(req),
        ip: req.ip, requestId: req.requestId, userAgent: req.headers["user-agent"] ?? null,
        entity: "content_blocks", entityId: null, action: "control.content.updated",
        before: Object.fromEntries(planned.map((p) =>
          [`${p.key}.${p.locale}`, stored.get(`${p.key}|${p.locale}`) ?? null])),
        after: { ...after, note: body.note ?? null, lines: planned.length }
      });

      return { changed: planned.length, lines: planned.map((p) => `${p.key} (${p.locale})`),
        can_manage: true, ...(await loadDesk(c, tenantId)) };
    });
  });
}
