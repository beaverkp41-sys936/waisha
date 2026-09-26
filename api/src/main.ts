import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { env } from "./env.js";
import { registerErrorHandling } from "./plugins/errors.js";
import { authRoutes } from "./routes/auth.routes.js";
import { contentRoutes } from "./routes/content.routes.js";
import { controlRoutes } from "./routes/control.routes.js";
import { licenceRoutes } from "./routes/licence.routes.js";

async function main() {
  const app = Fastify({
    logger: true,
    trustProxy: true,
    pluginTimeout: 60000, // slow first boots on Windows: Defender scans native modules
    bodyLimit: 3 * 1024 * 1024 // 3MB hard limit (spec 6.18)
  });

  await app.register(helmet);
  await app.register(cors, { origin: [env.WEB_ORIGIN], credentials: true });
  await app.register(cookie);
  registerErrorHandling(app);

  app.get("/api/v1/health", async () => ({ status: "ok", time: new Date().toISOString() }));
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(contentRoutes, { prefix: "/api/v1" });
  await app.register(controlRoutes, { prefix: "/api/v1" });
  await app.register(licenceRoutes, { prefix: "/api/v1" });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((e) => { console.error(e); process.exit(1); });