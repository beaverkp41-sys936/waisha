import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { encryptField } from "../util/crypto.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import { build, hint, invalidate, loadGatewayByKey, seal } from "../payments/registry.js";

/**
 * The payment gateway desk (#283).
 *
 * The office asked for one thing: *"I can enter the credential in admin panel, then activate it
 * and the system work."* Everything before this desk existed said otherwise — a gateway was three
 * environment variables and a restart, which is a deployment shape, not a commercial one. So
 * this is the surface where a rail gets filed, tried, switched on and switched off, and
 * `src/payments/registry.ts` is the code that reads whatever it decides.
 *
 * **Credentials go in and never come out.** The form posts a JSON credential set; this route
 * encrypts it (`seal`) and hands the bytes to the definer. Nothing here reads the blob back —
 * the list endpoint calls `list_payment_gateways()`, a function that was written without the
 * credential columns in its `select`, so a route that wanted to leak one could not. What the
 * operator sees instead is `credential_hint`: the first characters of the app id, or the last
 * four of the secret. Enough to tell two saved keys apart, not enough to use one.
 *
 * **Re-posting a form with the secret blank does not clear it.** `upsert_payment_gateway` treats
 * null as "keep what is stored", because the ordinary case is an operator changing a base URL on
 * a rail that already works. Clearing is a different, deliberate action — the DELETE below — and
 * it says so in the audit row.
 *
 * **Activating is refused before it is refused by the network.** The register carries an
 * `adapter` column, and a rail whose adapter is `none` has no code that could use its
 * credentials. M-Pesa, Airtel, Tigo Pesa and Halo are all filed and all honestly marked as
 * waiting for an adapter; switching one on would otherwise leave a desk that says "live" while
 * the API quietly keeps charging nobody. The refusal is this route's answer, not a silent
 * fallback.
 */

const VIEW = "control.gateway.view";
const MANAGE = "control.gateway.manage";

export const GATEWAY_LIST_SQL = "select * from platform_auth.list_payment_gateways()";

const KEY = z.string().trim().regex(/^[a-z0-9_]{2,32}$/, "Unknown gateway");

/** The desk's answer when trying a rail threw. An ApiError is already plain English written by
 *  the registry ("no adapter", "not configured"); a network failure is a fetch error, and a
 *  timeout has no message worth showing, so it is named here rather than left as `The user aborted a request.` */
function explain(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError") return "The gateway did not answer within 8 seconds.";
  if (err?.name === "AbortError") return "The gateway connection was closed before it answered.";
  // Every network failure arrives as `TypeError: fetch failed`, with the reason one level down in
  // `cause`. "fetch failed" is not something an operator can act on, and the address they typed is
  // the thing to check, so the code is read back out and named.
  const code = err?.cause?.code ?? "";
  const why = `${code} ${err?.cause?.message ?? ""} ${err?.message ?? ""}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENOTDNS")
    return `Nothing answers for that gateway address — the name does not resolve (${code}).`;
  if (code === "ECONNREFUSED") return "The gateway address refused the connection.";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT" || code === "EHOSTUNREACH")
    return "The gateway address did not take a connection in time.";
  if (/certificate|self-signed|TLS|SSL/i.test(why))
    return "The gateway's TLS certificate could not be verified.";
  return String(err?.cause?.message ?? err?.message ?? e).slice(0, 300);
}

/** A credential set is stored as one sealed blob, so posting one replaces every field in it.
 *  An all-blank set would therefore silently wipe a working key while the operator was editing
 *  the label — so it is refused, and the desk says so on the form. */
const credentialShape = z.object({
  clientId: z.string().trim().max(120).optional(),
  clientSecret: z.string().trim().max(200).optional(),
  appId: z.string().trim().max(120).optional(),
  username: z.string().trim().max(120).optional(),
  apiKey: z.string().trim().max(200).optional()
}).catchall(z.string().trim().max(200))
  .refine(v => Object.values(v).some(s => s && s.length > 0),
    "A new credential set must carry at least one value — leave the fields alone to keep what is stored.");

const putShape = z.object({
  label: z.string().trim().max(80).optional(),
  baseUrl: z.string().trim().max(200).optional(),
  environment: z.enum(["sandbox", "live"]).optional(),
  credentials: credentialShape.optional(),
  webhookSecret: z.string().trim().min(8).max(200).optional(),
  config: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional()
});

function refusal(result: any): never {
  const code = result?.code ?? "GATEWAY_REFUSED";
  const label = result?.label ? ` ${result.label}` : "";
  const messages: Record<string, [string, number]> = {
    NO_ADAPTER: [`Nothing can send through${label} yet — its credentials are filed, but the adapter for this rail has not been written.`, 400],
    NO_CREDENTIALS: [`Nothing is filed for${label} yet. Enter its credentials first.`, 400],
    NO_BASE_URL: [`${label.trim() || "This rail"} has no gateway address, so there is nowhere to send a charge.`, 400],
    BAD_BASE_URL: ["A gateway address must be https, with no spaces.", 400],
    BAD_ENVIRONMENT: ["A rail is either sandbox or live.", 400],
    BAD_KEY: ["That gateway is not in the register.", 404],
    NOT_FOUND: ["That gateway is not in the register.", 404],
    ALREADY_LIVE: [`Another rail is already live. Switch it off before turning${label} on.`, 409]
  };
  const [message, status] = messages[code] ?? ["The gateway register refused this change.", 400];
  throw new ApiError(code, message, status);
}

export async function controlGatewayRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The register ----------
  app.get("/control/gateway", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    const { rows } = await pool.query(GATEWAY_LIST_SQL);
    return {
      rails: rows.map((r: any) => ({
        providerKey: r.provider_key,
        label: r.label,
        adapter: r.adapter,
        // The desk says "no adapter yet" in the same breath as the credentials, because the
        // difference between those two states is the whole of what an operator can do next.
        adaptable: r.adapter !== "none",
        baseUrl: r.base_url,
        environment: r.environment,
        enabled: r.enabled,
        hasCredentials: r.has_credentials,
        hasWebhookSecret: r.has_webhook_secret,
        credentialHint: r.credential_hint,
        config: r.config,
        updatedAt: r.updated_at,
        lastCheck: r.last_check
      })),
      // What the money path is doing right now, which is not the same question as what is
      // switched on: with nothing live the API still answers from PAYMENT_PROVIDER.
      fallback: process.env.PAYMENT_PROVIDER ?? "mock"
    };
  });

  // ---------- File a rail's credentials ----------
  app.put("/control/gateway/:key", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    const key = KEY.parse((req.params as { key: string }).key);
    await enforceRateLimit(`gateway:put:${req.control.user_id}`, 30, 3600);
    const body = putShape.parse(req.body ?? {});

    const credentials = body.credentials ? seal({ ...(body.credentials as Record<string, string>) }) : null;
    const webhook = body.webhookSecret ? encryptField(body.webhookSecret) : null;
    const hintValue = body.credentials ? hint(body.credentials as Record<string, string>) : null;

    const r = await pool.query(
      `select platform_auth.upsert_payment_gateway($1,$2,$3,$4,$5,$6,$7,$8,$9) as r`,
      [key, body.label ?? null, body.baseUrl ?? null, credentials, webhook, hintValue,
       body.config ? JSON.stringify(body.config) : null, body.environment ?? null,
       req.control.user_id]);
    const result = r.rows[0].r;
    if (result.status !== "ok") refusal(result);
    invalidate();

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      // `audit_logs.entity_id` is a uuid and a rail is keyed by its provider name, so the name
      // goes in `after` — same as the content desk, which keys on `footer.copyright`. Leaving it
      // out of the column is the difference between a trail and a 500 on every save.
      entity: "payment_gateways", entityId: null, action: "gateway.configured",
      // What changed, never what it was. An audit trail that stores a credential is a second
      // copy of the secret in the one table everyone with `control.audit.view` can read.
      after: {
        provider_key: key,
        base_url: body.baseUrl ?? null,
        environment: body.environment ?? null,
        credentials_replaced: !!credentials,
        credential_hint: hintValue,
        webhook_secret_replaced: !!webhook,
        config_changed: !!body.config
      }
    }));
    return { status: "ok", providerKey: key, adapter: result.adapter };
  });

  // ---------- The switch ----------
  app.post("/control/gateway/:key/enable", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    const key = KEY.parse((req.params as { key: string }).key);
    const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    await enforceRateLimit(`gateway:enable:${req.control.user_id}`, 20, 3600);

    const r = await pool.query("select platform_auth.set_payment_gateway_enabled($1,$2,$3) as r",
      [key, enabled, req.control.user_id]);
    const result = r.rows[0].r;
    if (result.status !== "ok") refusal(result);
    // The registry holds the live rail for twenty seconds. This desk just changed it, and the
    // next customer must be charged through the gateway the operator chose a moment ago.
    invalidate();

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "payment_gateways", entityId: null,
      action: enabled ? "gateway.activated" : "gateway.deactivated",
      after: { provider_key: key, enabled, deactivated: result.deactivated ?? null }
    }));
    return { status: "ok", providerKey: key, enabled, deactivated: result.deactivated ?? null };
  });

  // ---------- Try it ----------
  //
  // The only check that means anything for a gateway is the one the network itself answers: ask
  // its token endpoint with the filed credentials and keep whatever comes back. So this reaches
  // out — over https, to the address the operator typed, with the credentials the operator chose
  // to file, at the moment the operator pressed the button. Nothing here runs on a timer, and no
  // charge is created, so testing a live rail cannot take money from anybody.
  //
  // It goes through `build()`, the same function the money path uses. That is the point: a green
  // light here is a statement about the client a customer would actually be charged through, not
  // about a second implementation of the same call that could drift from it.
  app.post("/control/gateway/:key/test", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    const key = KEY.parse((req.params as { key: string }).key);
    await enforceRateLimit(`gateway:test:${req.control.user_id}`, 10, 600);

    let check: { ok: boolean; detail: string };
    try {
      // Not the cached live rail — the named one, switched on or not. A rail can be filed and
      // tested before it is ever activated, because discovering a mistyped app id by watching a
      // customer's payment fail is not a way to find out.
      const gateway = await loadGatewayByKey(key);
      if (!gateway) {
        check = { ok: false, detail: "That gateway is not in the register." };
      } else if (!gateway.baseUrl) {
        check = { ok: false, detail: "Nothing is sent: this rail has no gateway address yet." };
      } else {
        const provider = build(gateway);
        check = { ok: true, detail: provider.probe
          ? await provider.probe()
          : `The ${provider.name} client cannot be asked anything without creating a charge, so this proves only that the register accepted its credentials.` };
      }
    } catch (e) {
      check = { ok: false, detail: explain(e) };
    }

    await pool.query("select platform_auth.record_gateway_check($1,$2)", [key, JSON.stringify(check)]);
    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "payment_gateways", entityId: null, action: "gateway.tested",
      after: { provider_key: key, ...check }
    }));
    return { status: "checked", ...check };
  });

  // ---------- Wipe it ----------
  app.delete("/control/gateway/:key", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    const key = KEY.parse((req.params as { key: string }).key);
    await enforceRateLimit(`gateway:clear:${req.control.user_id}`, 10, 3600);
    const r = await pool.query("select platform_auth.clear_payment_gateway($1,$2) as r",
      [key, req.control.user_id]);
    const result = r.rows[0].r;
    if (result.status !== "ok") refusal(result);
    invalidate();
    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "payment_gateways", entityId: null, action: "gateway.cleared",
      after: { provider_key: key, credentials_removed: true, disabled: true }
    }));
    return { status: "ok", providerKey: key };
  });
}
