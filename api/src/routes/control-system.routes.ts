import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { env } from "../env.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { storageConfigured } from "../storage/supabase.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import { ERROR_SUMMARY_SQL } from "./control-errors.routes.js";
import { reliabilityAdvisory } from "./control-reliability.routes.js";
import { churnAdvisory, moduleAllocationAdvisory } from "./control-revenue.routes.js";

/**
 * The technical report and the advisory (069).
 *
 * Two sources, deliberately kept apart in the payload. Everything about the database
 * comes from a SECURITY DEFINER reader, for the standing reason — it crosses tenants
 * and reads the catalog. Everything about the running process comes from here, because
 * Postgres cannot see the filesystem it was started from, and one of the most useful
 * sentences in this whole module (a migration file that exists but was never applied)
 * is only true when both halves are compared in one request.
 *
 * The advisory rules are queries with guards, so the list is short when the system is
 * healthy. `not_measured` is part of that honesty: the office asked for forecasts of
 * churn, funnel conversion and reliability, and some of those still have no data behind
 * them. Saying so is better than drawing a line through nothing. Two of them stopped being
 * unknowns: reliability, from 085's stores through reliabilityAdvisory(), and churn, from
 * 086's exit register through churnAdvisory() — both read by the same definers their desks
 * read, so a headline here and a figure on a desk can never be two different numbers.
 */

const SYSTEM = "control.system.view";

/** Exported so the verify script executes the identical string, not a re-typing. */
export const SYSTEM_REPORT_SQL = "select platform_auth.control_system_report() as r";
export const SYSTEM_ADVISORY_SQL =
  "select item_id, rank, kind, priority, area, title, detail, metric, unit, action, evidence " +
  "from platform_auth.control_advisory()";
export const SYSTEM_MIGRATIONS_SQL =
  "select name, applied_at from platform_auth.control_migrations_applied()";

const KIND_ORDER = ["risk", "revenue", "growth", "retention", "improve"] as const;
const PRIORITY_ORDER = ["high", "medium", "low"] as const;

/**
 * Where the .sql files live, from wherever the process was started. Dev runs from
 * api/, a Render service can run from the repo root, and the build output runs from
 * dist/, so all three shapes are tried. Returning null is a legitimate answer: an
 * unreadable migrations directory means the drift check cannot run, and saying that
 * is better than reporting "no drift", which would be the most reassuring lie in the
 * report.
 */
function migrationsDir(): string | null {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    join(process.cwd(), "migrations"),
    join(process.cwd(), "api", "migrations"),
    join(process.cwd(), "..", "api", "migrations")
  ].filter((d): d is string => !!d);
  for (const dir of candidates) {
    if (existsSync(dir) && existsSync(join(dir, "001_foundation.sql"))) return dir;
  }
  return null;
}

const MIGRATION_FILE = /^\d{3}_[A-Za-z0-9_]+\.sql$/;

/** Facts about this process. Values only — nothing here is a secret or a guess. */
function runtimeFacts() {
  const uptimeSeconds = Math.round(process.uptime());
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    started_at: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
    uptime_seconds: uptimeSeconds,
    environment: env.NODE_ENV,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    web_origin: env.WEB_ORIGIN,
    readiness: {
      // Presence flags, never values — except the sender, which is public by design.
      mail_configured: !!env.RESEND_API_KEY,
      // The sender is a public part of every message the platform sends, so it is safe to
      // show — and it is the one field that tells the office whether Resend will deliver.
      mail_sender: env.MAIL_FROM,
      storage_configured: storageConfigured(),
      scheduler_secret_configured: !!env.INTERNAL_TICK_SECRET,
      app_role_password_configured: !!env.APP_DB_PASSWORD,
      payment_provider: env.PAYMENT_PROVIDER,
      tin_checksum_mode: env.TIN_CHECKSUM_MODE,
      documents_bucket: env.DOCUMENTS_BUCKET
    },
    booking_timer: {
      // The in-process loop is the only scheduler that always runs; the HTTP tick
      // needs the shared secret. Both are facts about what will actually fire.
      in_process_loop: true,
      http_tick_enabled: !!env.INTERNAL_TICK_SECRET
    }
  };
}

/**
 * Runtime items the SQL rules cannot know about. These are the highest-value lines on
 * the screen: a seeker who cannot get their verification email, or a migration that
 * was merged but never applied to this database, are both invisible to Postgres.
 */
function runtimeAdvisory(drift: {
  dir_found: boolean; unapplied: string[]; missing_files: string[];
}) {
  const items: Array<Record<string, unknown>> = [];

  if (!drift.dir_found) {
    items.push({
      item_id: "migrations_dir_unreadable", rank: 0, kind: "risk", priority: "medium",
      area: "Deployment",
      title: "The migration files could not be located from this process",
      detail: "Without them the panel can only report what the database says it has "
        + "applied, and cannot tell whether anything on disk was never run. Set "
        + "MIGRATIONS_DIR on the service if the deploy layout moves the folder.",
      metric: 0, unit: "files compared", action: "Point MIGRATIONS_DIR at the migrations folder.",
      evidence: []
    });
  }
  if (drift.unapplied.length) {
    items.push({
      item_id: "migrations_unapplied", rank: 0, kind: "risk", priority: "high",
      area: "Deployment",
      title: `Migration files present but never applied: ${drift.unapplied.length}`,
      detail: "Code in this build expects tables or functions that are not in the "
        + "database yet. This is the failure that arrives as a 500 on a screen nobody "
        + "has opened since the deploy, so it is worth checking before anything else "
        + "on this list.",
      metric: drift.unapplied.length, unit: "files",
      action: "Run pnpm migrate against this database, then reload this screen.",
      evidence: drift.unapplied.map(name => ({ file: name }))
    });
  }
  if (drift.missing_files.length) {
    items.push({
      item_id: "migrations_applied_without_file", rank: 1, kind: "risk", priority: "medium",
      area: "Deployment",
      title: `Applied migrations with no file on disk: ${drift.missing_files.length}`,
      detail: "The database has run something this checkout does not contain. Either a "
        + "file was removed after shipping or the branch is behind — and since the "
        + "runner keys on the filename, a re-adding migration would be skipped, not "
        + "re-run.",
      metric: drift.missing_files.length, unit: "names",
      action: "Confirm the schema came from this branch before shipping more migrations.",
      evidence: drift.missing_files.map(name => ({ name }))
    });
  }
  if (!env.RESEND_API_KEY) {
    items.push({
      item_id: "mail_unset", rank: 2, kind: "risk", priority: "high",
      area: "Accounts",
      title: "No mail provider is configured on this deployment",
      detail: "Seeker signup and the password reset both end at an email: the OTP is "
        + "generated, stored and sent to nothing. Every self-service account created "
        + "here stays unverified, which caps the marketplace at whatever the office can "
        + "verify by hand.",
      metric: 0, unit: "provider", action: "Set RESEND_API_KEY before inviting seekers.",
      evidence: []
    });
  }
  if (env.RESEND_API_KEY && /@resend\.dev$/i.test(env.MAIL_FROM)) {
    items.push({
      item_id: "mail_sandbox_sender", rank: 2, kind: "risk", priority: "high",
      area: "Accounts",
      title: "Mail is sending from the Resend test address",
      detail: "onboarding@resend.dev is a shared sandbox: Resend accepts the send and "
        + "hands it back, then only delivers it to the address that owns the account. So a "
        + "code shows as sent in the register and never reaches the client who asked for it, "
        + "which is the worst of both outcomes — the office believes people were notified. "
        + "Verify a domain in the Resend console and set MAIL_FROM to an address on it.",
      metric: 0, unit: "sender",
      action: "Verify a sending domain in Resend, then set MAIL_FROM to it.",
      evidence: [{ mail_from: env.MAIL_FROM }]
    });
  }
  if (!storageConfigured()) {
    items.push({
      item_id: "storage_unset", rank: 3, kind: "risk", priority: "high",
      area: "Documents",
      title: "Document storage is not configured, so uploads answer 503",
      detail: "The vault holds the bill of lading, the licence scan and the signed "
        + "contract, and every one of those is the reason a CFA keeps a file in this "
        + "system instead of a folder. Without SUPABASE_URL and the service key the "
        + "routes refuse the upload, and the compliance screens have nothing to show.",
      metric: 0, unit: "bucket", action: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      evidence: []
    });
  }
  if (!env.INTERNAL_TICK_SECRET) {
    items.push({
      item_id: "scheduler_http_off", rank: 12, kind: "improve", priority: "low",
      area: "Operations",
      title: "The booking timers only run inside this process",
      detail: "The 60-second in-process loop handles reminders and releases, but it "
        + "stops when the worker sleeps and runs once per worker. An external scheduler "
        + "calling the internal tick is what makes the twelve-hour auto-release "
        + "punctual. Nothing is broken — the timing just depends on uptime.",
      metric: 0, unit: "secret", action: "Set INTERNAL_TICK_SECRET and schedule the tick.",
      evidence: []
    });
  }
  return items;
}

/** Exported so the verify script executes the identical string, not a re-typing. */
export const MAIL_SUMMARY_SQL =
  "select channel, purpose, status, sends, distinct_addresses, last_at " +
  "from platform_auth.message_delivery_summary($1)";

/** Purposes that end with a person waiting at a screen. A tenant notice that never sent
 *  is a complaint; a sign-up code that never sent is an account that cannot exist. */
const BLOCKING_PURPOSES = ["signup_otp", "otp_resend", "password_reset", "staff_invite"];

/**
 * What the delivery register (112) says actually left the building.
 *
 * Every other rule here is about configuration, and configuration is only a promise. This
 * is the one mail line that is a fact about the last two days: an operator with a key set
 * and a sandbox sender looks healthy on every rule above, and the register is the only
 * place where the sends that were accepted but undeliverable are separated from the ones
 * that were refused outright.
 */
async function mailDeliveryAdvisory(days: number) {
  const items: Array<Record<string, unknown>> = [];
  const { rows } = await pool.query(MAIL_SUMMARY_SQL, [days]);
  const summary = rows.map((r: any) => ({
    channel: r.channel, purpose: r.purpose, status: r.status,
    sends: Number(r.sends), addresses: Number(r.distinct_addresses), last_at: r.last_at
  }));

  const count = (pick: (x: (typeof summary)[number]) => boolean) =>
    summary.filter(pick).reduce((acc, x) => acc + x.sends, 0);
  const failed = count(x => x.status === "failed" && BLOCKING_PURPOSES.includes(x.purpose));
  const skipped = count(x => x.status === "skipped" && BLOCKING_PURPOSES.includes(x.purpose));

  if (failed > 0) {
    items.push({
      item_id: "mail_sends_failed", rank: 1, kind: "risk", priority: "high",
      area: "Accounts",
      title: `${failed} message${failed === 1 ? "" : "s"} to a waiting person was refused by the provider`,
      detail: "These are codes, reset links and invitations that the provider rejected, so "
        + "nobody received them. The address is stored masked and the provider's own words "
        + "are kept next to it, so the desk can tell a bad address from a rejected sender "
        + "without opening a database console.",
      metric: failed, unit: "sends refused",
      action: "Open Deliveries in the panel, read the error on the newest failed line, then "
        + "act on whichever of the two it is.",
      evidence: summary.filter(x => x.status === "failed").slice(0, 8)
    });
  }
  if (skipped > 0) {
    items.push({
      item_id: "mail_sends_skipped", rank: 2, kind: "risk",
      priority: skipped >= 5 ? "high" : "medium",
      area: "Accounts",
      title: `${skipped} message${skipped === 1 ? "" : "s"} went to the server log instead of to anyone`,
      detail: "A skipped line means the code was generated and stored and then sent to "
        + "nothing: either no provider key was set when it was written, or it was an SMS and "
        + "no aggregator is wired. Every one of these is a person sitting on a verification "
        + "screen that can never be completed by them.",
      metric: skipped, unit: "sends logged only",
      action: "Configure the provider, then reinvite or let the person resend their code.",
      evidence: summary.filter(x => x.status === "skipped").slice(0, 8)
    });
  }
  return { items, headline: { window_days: days, rows: summary, failed, skipped } };
}

/* ---------------- the delivery register (112) ---------------- */

const MANAGE = "control.system.manage";

/** The CHECK lists on message_deliveries, kept here so a bad filter is refused by Zod with a
 *  400 instead of quietly matching nothing — an empty register and a filtered-empty register
 *  look identical on screen and mean completely different things. */
const DELIVERY_PURPOSES = ["signup_otp", "otp_resend", "password_reset", "staff_invite",
  "tenant_notice", "platform_test"] as const;
const DELIVERY_STATUSES = ["sent", "failed", "skipped"] as const;
const DELIVERY_CHANNELS = ["email", "sms"] as const;

export const MAIL_LOG_SQL =
  "select id, channel, purpose, to_masked, subject, status, provider, " +
  "provider_message_id, error, attempts, tenant_id, user_id, sent_at " +
  "from platform_auth.message_delivery_log($1,$2,$3,$4,$5,$6)";
export const MAIL_PRUNE_SQL = "select platform_auth.prune_message_deliveries($1) as r";

export const NOT_MEASURED = [
  {
    thing: "Conversion between signup and first real use",
    why: "There is no funnel to measure: no page views, no signup source and no "
      + "invitation table. tenants.created_at is the only door anyone walks through, so "
      + "a rate drawn from it would be invented."
  },
  {
    thing: "Money earned by one feature inside an office",
    why: "088 splits a bundle across the three offices it sells, weighted by the work each "
      + "office recorded, so transport, CFA and office each carry a share and the panel says "
      + "which part came from evidence and which from the even fall-back. Nothing narrower "
      + "than that exists: payroll and attendance both sit inside the office share, and no "
      + "table holds a price for a feature, so a per-feature figure would be invented."
  },
  {
    thing: "Storage cost",
    why: "Documents record the byte size the uploader declared; the bucket itself lives "
      + "in Supabase and its true size and egress are not readable from Postgres."
  }
];

export async function controlSystemRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- the technical report ----------
  app.get("/control/system/report", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, SYSTEM);
    await enforceRateLimit(`system:uid:${req.control.user_id}`, 60, 60);

    const { rows } = await pool.query(SYSTEM_REPORT_SQL);
    const report = rows[0]?.r ?? {};

    // Applied-versus-present is the one check that needs both halves of the system.
    const applied = await pool.query(SYSTEM_MIGRATIONS_SQL);
    const appliedNames = applied.rows.map((r: any) => r.name as string);
    const dir = migrationsDir();
    let onDisk: string[] = [];
    if (dir) {
      onDisk = readdirSync(dir).filter(f => MIGRATION_FILE.test(f)).sort();
    }
    const unapplied = onDisk.filter(f => !appliedNames.includes(f));
    const missingFiles = appliedNames.filter(n => !onDisk.includes(n));

    // Reliability, from 082's register. Read through the same definer the error desk
    // uses, so the report and the desk can never disagree about how many failures
    // there were — one number, one source.
    const errors = await pool.query(ERROR_SUMMARY_SQL, [7]);

    return {
      ...report,
      runtime: runtimeFacts(),
      errors: errors.rows[0]?.s ?? {},
      migrations: {
        ...(report.migrations ?? {}),
        files_on_disk: onDisk.length,
        dir_found: !!dir,
        unapplied,
        applied_without_file: dir ? missingFiles : []
      }
    };
  });

  // ---------- the advisory ----------
  app.get("/control/system/advisory", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, SYSTEM);
    await enforceRateLimit(`system:uid:${req.control.user_id}`, 60, 60);

    const { rows } = await pool.query(SYSTEM_ADVISORY_SQL);
    const dbItems = rows.map((r: any) => ({
      ...r,
      metric: r.metric === null ? null : Number(r.metric),
      evidence: r.evidence ?? []
    }));

    const applied = await pool.query(SYSTEM_MIGRATIONS_SQL);
    const appliedNames = applied.rows.map((r: any) => r.name as string);
    const dir = migrationsDir();
    const onDisk = dir
      ? readdirSync(dir).filter(f => MIGRATION_FILE.test(f)).sort()
      : [];
    const driftItems = runtimeAdvisory({
      dir_found: !!dir,
      unapplied: onDisk.filter(f => !appliedNames.includes(f)),
      missing_files: dir ? appliedNames.filter(n => !onDisk.includes(n)) : []
    });

    // Failures the users actually walked into. The register only knows what was served,
    // so this is the one line on the advisory that is a fact about the last day rather
    // than a rule about the schema.
    const errSummary = (await pool.query(ERROR_SUMMARY_SQL, [2])).rows[0]?.s ?? {};
    const errorItems: Array<Record<string, unknown>> = [];
    const server24 = Number(errSummary.server_in_last_24h ?? 0);
    if (server24 > 0) {
      errorItems.push({
        item_id: "errors_server_24h", rank: 0,
        priority: server24 >= 20 ? "high" : "medium", kind: "risk",
        area: "Reliability",
        title: `${server24} server failure${server24 === 1 ? "" : "s"} answered in the last 24 hours`,
        detail: "Every one of these was a request the API could not complete. They are "
          + "listed by bug on the error desk, newest first, with the stack and the request "
          + "id the caller was given — start there before guessing which screen broke.",
        metric: server24, unit: "occurrences",
        action: "Open Errors in the panel, triage what is understood, and raise the rest.",
        evidence: []
      });
    }

    // Uptime, latency and bloat, measured from 085's stores. Each line carries its own
    // guard, so a week with no traffic or no second snapshot says that instead of adding
    // a percentiles figure the store cannot support yet.
    const reliability = await reliabilityAdvisory(7);

    // Who left, and who is past their term without the office having written it down. The
    // same churn_report the Customers desk draws, on the same window, so the two agree.
    const churn = await churnAdvisory(90);

    // How much of the allocation is evidence and how much is a fall-back. Same definer the
    // Revenue desk reads, same window, so a card and a panel cannot disagree.
    const allocation = await moduleAllocationAdvisory(90);

    // Messages that left the building, from 112's register. Configuration rules can say a
    // key is set; only this can say whether the codes reached anyone.
    const mail = await mailDeliveryAdvisory(2);

    const items = [...dbItems, ...driftItems, ...errorItems, ...mail.items,
      ...reliability.items, ...churn.items, ...allocation.items]
      .sort((a: any, b: any) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const p = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
      if (p !== 0) return p;
      return KIND_ORDER.indexOf(a.kind as any) - KIND_ORDER.indexOf(b.kind as any);
    });

    const count = (pick: (x: any) => string) => items.reduce((acc: Record<string, number>, x) => {
      const k = pick(x);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

    return {
      generated_at: new Date().toISOString(),
      total: items.length,
      by_priority: count((x: any) => x.priority),
      by_kind: count((x: any) => x.kind),
      items,
      not_measured: NOT_MEASURED,
      // The headline behind the Reliability lines, so the advisory can point at the desk
      // instead of restating it: four numbers, all read from the same definers.
      reliability: {
        uptime_pct: reliability.uptime.uptime_pct ?? null,
        requests: Number(reliability.overall.requests ?? 0),
        p95_ms: reliability.overall.p95_ms === null
          || reliability.overall.p95_ms === undefined
          ? null : Number(reliability.overall.p95_ms),
        captures: Number(reliability.snapshot.captures ?? 0)
      },
      // The same for the churn lines: four figures off one churn_report call.
      churn: churn.headline,
      // And for the allocation lines: what part of the split is evidence and what is the
      // even fall-back, off one control_module_allocation call.
      allocation: allocation.headline,
      // And for the two mail lines: the register grouped by channel, purpose and status.
      mail: mail.headline
    };
  });

  // ---------- the delivery register ----------
  app.get("/control/system/deliveries", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, SYSTEM);
    await enforceRateLimit(`deliveries:uid:${req.control.user_id}`, 60, 60);

    const q = z.object({
      purpose: z.enum(DELIVERY_PURPOSES).optional(),
      status: z.enum(DELIVERY_STATUSES).optional(),
      channel: z.enum(DELIVERY_CHANNELS).optional(),
      q: z.string().trim().max(200).optional(),
      days: z.coerce.number().int().min(1).max(90).default(7),
      limit: z.coerce.number().int().min(1).max(500).default(100)
    }).strict().parse(req.query ?? {});

    const { rows } = await pool.query(MAIL_LOG_SQL,
      [q.purpose ?? null, q.status ?? null, q.channel ?? null, q.q || null, q.days, q.limit]);
    const summary = await pool.query(MAIL_SUMMARY_SQL, [q.days]);

    return {
      window_days: q.days,
      filters: { purpose: q.purpose ?? null, status: q.status ?? null, channel: q.channel ?? null, q: q.q ?? null },
      // Said out loud because it changes how to read every line below: with no key, an
      // address on this list was printed to a server log and delivered to nobody.
      readiness: { mail_configured: !!env.RESEND_API_KEY, mail_sender: env.MAIL_FROM },
      summary: summary.rows.map((r: any) => ({
        channel: r.channel, purpose: r.purpose, status: r.status, sends: Number(r.sends),
        addresses: Number(r.distinct_addresses), last_at: r.last_at
      })),
      // Masked addresses only — the register cannot answer "does this exact email have an
      // account", which is the reason it is safe to show a platform seat at all.
      items: rows
    };
  });

  // ---------- retention: an operator decision, not a background job ----------
  app.post("/control/system/deliveries/retention", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`deliveries-prune:uid:${req.control.user_id}`, 5, 3600);

    const body = z.object({ keepDays: z.number().int().min(7).max(3650) }).strict().parse(req.body);
    const { rows } = await pool.query(MAIL_PRUNE_SQL, [body.keepDays]);
    const result = rows[0]?.r ?? {};
    if (result.status !== "ok") {
      throw new ApiError("CONFLICT", result.message ?? "Retention was refused.", 400);
    }

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "message_deliveries", entityId: null, action: "control.delivery.retention",
      after: { keep_days: body.keepDays, deleted: result.deleted, cutoff: result.cutoff }
    }));
    return {
      deleted: result.deleted ?? 0,
      keep_days: body.keepDays,
      cutoff: result.cutoff ? new Date(result.cutoff).toISOString() : null
    };
  });
}
