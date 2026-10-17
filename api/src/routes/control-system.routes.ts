import type { FastifyInstance } from "fastify";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db/pool.js";
import { env } from "../env.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { storageConfigured } from "../storage/supabase.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

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
 * churn, funnel conversion and reliability, and some of those have no data behind them
 * at all. Saying so is better than drawing a line through nothing.
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
      // Booleans only. The values are never read out of env for this payload.
      mail_configured: !!env.RESEND_API_KEY,
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

const NOT_MEASURED = [
  {
    thing: "Conversion between signup and first real use",
    why: "There is no funnel to measure: no page views, no signup source and no "
      + "invitation table. tenants.created_at is the only door anyone walks through, so "
      + "a rate drawn from it would be invented."
  },
  {
    thing: "Churn",
    why: "subscriptions.status 'cancelled' has no writer anywhere in the API. A lapse "
      + "is recorded by the licence gate as expired or suspended, which is a different "
      + "event — the register can show lapsed companies, not companies that chose to leave."
  },
  {
    thing: "Uptime, latency and error rate",
    why: "The API has no metrics endpoint, no request-timing store and no error "
      + "collector. /api/v1/health answers 'ok' for a process and nothing else. This is "
      + "the single most useful thing to build next if the panel is to say anything "
      + "about reliability."
  },
  {
    thing: "Revenue per feature or per module",
    why: "invoices link to a subscription, and a bundle is sold as one price, so income "
      + "can be attributed to a package but never split across transport, CFA and office. "
      + "Search-pass money has no offering at all."
  },
  {
    thing: "Storage cost",
    why: "Documents record the byte size the uploader declared; the bucket itself lives "
      + "in Supabase and its true size and egress are not readable from Postgres."
  },
  {
    thing: "Index and table bloat over time",
    why: "pg_stat is read live and reset by a restart, and nothing stores a history of "
      + "it, so growth can be reported only as today's snapshot, never as a trend."
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

    return {
      ...report,
      runtime: runtimeFacts(),
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

    const items = [...dbItems, ...driftItems].sort((a: any, b: any) => {
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
      not_measured: NOT_MEASURED
    };
  });
}
