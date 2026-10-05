import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { registerErrorHandling } from "./plugins/errors.js";
import { authRoutes } from "./routes/auth.routes.js";
import { contentRoutes } from "./routes/content.routes.js";
import { controlRoutes } from "./routes/control.routes.js";
import { licenceRoutes } from "./routes/licence.routes.js";
import { paymentsRoutes } from "./routes/payments.routes.js";
import { profileRoutes } from "./routes/profile.routes.js";
import { routesRoutes } from "./routes/routes.routes.js";
import { driversRoutes } from "./routes/drivers.routes.js";
import { fleetRoutes } from "./routes/fleet.routes.js";
import { tripsRoutes } from "./routes/trips.routes.js";
import { usersRoutes } from "./routes/users.routes.js";
import { documentsRoutes } from "./routes/documents.routes.js";

async function main() {
  const app = Fastify({
    logger: true,
    trustProxy: true,
    pluginTimeout: 60000, // slow first boots on Windows: Defender scans native modules
    bodyLimit: 12 * 1024 * 1024 // 12MB — document uploads (8MB file cap enforced per file)
  });

  await app.register(helmet);
  await app.register(cors, { origin: [env.WEB_ORIGIN], credentials: true });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1 }
  });
  registerErrorHandling(app);

  app.get("/api/v1/health", async () => ({ status: "ok", time: new Date().toISOString() }));
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(contentRoutes, { prefix: "/api/v1" });
  await app.register(controlRoutes, { prefix: "/api/v1" });
  await app.register(licenceRoutes, { prefix: "/api/v1" });
  await app.register(paymentsRoutes, { prefix: "/api/v1" });
  await app.register(profileRoutes, { prefix: "/api/v1" });
  await app.register(fleetRoutes, { prefix: "/api/v1" });
  await app.register(routesRoutes, { prefix: "/api/v1" });
  await app.register(driversRoutes, { prefix: "/api/v1" });
  await app.register(tripsRoutes, { prefix: "/api/v1" });
  await app.register(usersRoutes, { prefix: "/api/v1" });
  await app.register(documentsRoutes, { prefix: "/api/v1" });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((e) => { console.error(e); process.exit(1); });