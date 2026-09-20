import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  APP_DB_PASSWORD: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  FIELD_ENCRYPTION_KEY: z.string().length(64),
  SEARCH_HASH_KEY: z.string().length(64),
  WEB_ORIGIN: z.string().url(),
  RESEND_API_KEY: z.string().optional().default(""),
  MAIL_FROM: z.string().default("WAISHA <onboarding@resend.dev>"),
  TIN_CHECKSUM_MODE: z.enum(["structure", "strict"]).default("structure")
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";