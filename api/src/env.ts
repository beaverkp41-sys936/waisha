import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  APP_DB_PASSWORD: z.string().optional(),
  DB_SSL_CA_FILE: z.string().optional().default(""),
  JWT_SECRET: z.string().min(32),
  FIELD_ENCRYPTION_KEY: z.string().length(64),
  SEARCH_HASH_KEY: z.string().length(64),
  WEB_ORIGIN: z.string().url(),
  RESEND_API_KEY: z.string().optional().default(""),
  MAIL_FROM: z.string().default("WAISHA <onboarding@resend.dev>"),
  TIN_CHECKSUM_MODE: z.enum(["structure", "strict"]).default("structure"),
  PAYMENT_PROVIDER: z.enum(["mock", "azampay"]).default("mock"),
  PAYMENT_MOCK_KEY: z.string().optional(),
  AZAMPAY_BASE_URL: z.string().optional().default(""),
  AZAMPAY_CLIENT_ID: z.string().optional().default(""),
  AZAMPAY_CLIENT_SECRET: z.string().optional().default(""),
  AZAMPAY_WEBHOOK_SECRET: z.string().optional().default(""),
  SUPABASE_URL: z.string().optional().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
  DOCUMENTS_BUCKET: z.string().default("waisha-documents"),
  // Shared secret for the internal scheduler endpoint (booking timers).
  // Never sent to a browser; the in-process loop calls the same functions.
  INTERNAL_TICK_SECRET: z.string().optional().default(""),
  // Set by the deploy platform, absent locally. The health answer names the build that is
  // actually serving, which is the first question an operator asks after a bad deploy — so
  // it is optional rather than required, and the field is simply left out when unknown.
  RENDER_GIT_COMMIT: z.string().optional().default("")
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";