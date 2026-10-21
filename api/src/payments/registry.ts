/**
 * The gateway registry — which rail the platform charges through today (#283).
 *
 * Before this file the answer was `env.PAYMENT_PROVIDER`, which meant turning on a mobile-money
 * rail needed a shell and a restart. The office signs a contract with a network; it does not
 * deploy anything. So the register written by migration 114 is now the source of truth and the
 * environment is the fallback, kept for exactly one reason: a platform that has never opened the
 * desk must go on answering the way it answers today.
 *
 * Two rules hold this together.
 *
 * **Plaintext credentials exist only inside this process.** The register stores AES-256-GCM
 * blobs; `loadActiveGateway` decrypts one into an object, hands it to an adapter, and nothing
 * else. No function here returns a credential to a route, and the desk reads the register
 * through `list_payment_gateways()`, which never sees the blob column at all.
 *
 * **The cache is short and the desk can end it.** A payment intent is not a place to run a
 * config query, but a gateway switched on in the admin panel must take effect on the next
 * customer, not on the next restart — so 20 seconds, and every write from the desk calls
 * `invalidate()` so the switch is immediate for the one process that made it. (A second API
 * instance sees it within the TTL; that gap is stated rather than hidden, because it is the
 * price of not querying on every push.)
 */
import { pool } from "../db/pool.js";
import { decryptField, encryptField } from "../util/crypto.js";
import { env } from "../env.js";
import { ApiError } from "../util/errors.js";
import { MockProvider, AzamPayProvider, type PaymentProvider } from "./provider.js";

export interface ActiveGateway {
  providerKey: string;
  adapter: string;
  baseUrl: string | null;
  environment: string;
  credentials: Record<string, string>;
  webhookSecret: string | null;
  config: Record<string, unknown>;
}

const TTL_MS = 20_000;
let cached: { at: number; gateway: ActiveGateway | null } | null = null;

export function invalidate(): void { cached = null; }

function unseal(blob: unknown, field: string): string | null {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob), "hex");
  try {
    return decryptField(buf);
  } catch {
    // The key rotated under a row written with the old one, or the bytes are not ours. Either
    // way this is not a reason to 500 a customer's payment attempt with a mystery; it is a
    // named failure the desk can read.
    throw new ApiError("GATEWAY_SEAL_BROKEN",
      `The stored ${field} for this gateway could not be opened. Re-enter the credentials `
      + "on the payment gateway desk.", 503);
  }
}

/** What the two definer readers hand back: one register row, secrets still sealed. */
interface GatewayRow {
  provider_key: string;
  adapter: string;
  base_url: string | null;
  environment: string | null;
  credentials: unknown;
  webhook_secret: unknown;
  config: unknown;
}

/**
 * Open a register row. The only place a sealed credential set becomes an object, and the object
 * never leaves this module — callers hand it straight to an adapter or read one field of it.
 */
function unbox(row: GatewayRow): ActiveGateway {
  const sealed = unseal(row.credentials, "credential set");
  let credentials: Record<string, string> = {};
  if (sealed) {
    try {
      credentials = JSON.parse(sealed);
    } catch {
      throw new ApiError("GATEWAY_SEAL_BROKEN",
        "The stored credential set for this gateway is not readable. Re-enter the credentials "
        + "on the payment gateway desk.", 503);
    }
  }
  return {
    providerKey: row.provider_key,
    adapter: row.adapter,
    baseUrl: row.base_url ?? null,
    environment: row.environment ?? "sandbox",
    credentials,
    webhookSecret: unseal(row.webhook_secret, "webhook secret"),
    config: (row.config && typeof row.config === "object") ? row.config as Record<string, unknown> : {}
  };
}

/**
 * The rail currently live, or null when the register has nothing to say.
 */
export async function loadActiveGateway(): Promise<ActiveGateway | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.gateway;
  const r = await pool.query(`select * from platform_auth.active_payment_gateway()`);
  const row = r.rows[0] as GatewayRow | undefined;
  const gateway = row ? unbox(row) : null;
  cached = { at: Date.now(), gateway };
  return gateway;
}

/**
 * A named rail, whether or not it is the live one — which is what the desk's Test button needs.
 *
 * Checking credentials before switching a company over to them is the difference between a desk
 * that answers "these keys work" and one that only finds out on a paying customer. `adapter` is
 * still trusted rather than re-derived here, so a test on an unadapted rail fails the same way
 * activation does.
 */
export async function loadGatewayByKey(providerKey: string): Promise<ActiveGateway | null> {
  const r = await pool.query(`select * from platform_auth.payment_gateway_secrets($1)`, [providerKey]);
  const row = r.rows[0] as GatewayRow | undefined;
  return row ? unbox(row) : null;
}

/**
 * The adapter for a credential set, or null when nothing is live.
 *
 * `adapter` is a column the schema constrains to the set of values this function understands,
 * so a rail filed in the register with 'none' can never reach here — activation is refused in
 * SQL. That is the whole of the honesty of this design: the desk can hold M-Pesa credentials,
 * and it cannot claim to be able to use them.
 */
export function build(gateway: ActiveGateway): PaymentProvider {
  if (gateway.adapter === "azampay") {
    const clientId = gateway.credentials.clientId ?? gateway.credentials.appId ?? "";
    const clientSecret = gateway.credentials.clientSecret ?? "";
    if (!gateway.baseUrl || !clientId || !clientSecret) {
      throw new ApiError("GATEWAY_NOT_CONFIGURED",
        `The ${gateway.providerKey} rail is switched on but its base URL, app id or secret is `
        + "missing. Complete it on the payment gateway desk.", 503);
    }
    return new AzamPayProvider(gateway.baseUrl, clientId, clientSecret);
  }
  throw new ApiError("GATEWAY_ADAPTER_MISSING",
    `No payment adapter is written for the ${gateway.providerKey} rail yet, so it cannot be `
    + "used even though its credentials are filed.", 503);
}

/**
 * Who takes the money right now: the register first, then the environment it had before.
 */
export async function getProvider(): Promise<PaymentProvider> {
  const gateway = await loadActiveGateway();
  if (gateway) return build(gateway);
  if (env.PAYMENT_PROVIDER === "azampay") {
    return new AzamPayProvider(env.AZAMPAY_BASE_URL, env.AZAMPAY_CLIENT_ID, env.AZAMPAY_CLIENT_SECRET);
  }
  return new MockProvider();
}

/**
 * Seal a credential set for storage. The desk sends the fields; this is the only place that
 * knows the wire format they are kept in.
 */
export function seal(credentials: Record<string, string>): Buffer {
  return encryptField(JSON.stringify(credentials ?? {}));
}

/**
 * A few characters that tell two saved keys apart. Built from the widest non-secret field the
 * set carries, else the tail of the secret — never the middle of anything.
 */
export function hint(credentials: Record<string, string>): string {
  const id = credentials?.clientId || credentials?.appId || credentials?.username || "";
  if (id) return `${id.slice(0, 6)}***`;
  const secret = credentials?.clientSecret || credentials?.apiKey || "";
  return secret ? `***${secret.slice(-4)}` : "";
}
