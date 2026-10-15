import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { enforceRateLimit } from "./security/ratelimit.js";
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
import { invoicesRoutes } from "./routes/invoices.routes.js";
import { ledgerRoutes } from "./routes/ledger.routes.js";
import { dutyRoutes } from "./routes/duty.routes.js";
import { fuelRoutes } from "./routes/fuel.routes.js";
import { inventoryRoutes } from "./routes/inventory.routes.js";
import { incidentsRoutes } from "./routes/incidents.routes.js";
import { clientsRoutes } from "./routes/clients.routes.js";
import { notificationsRoutes } from "./routes/notifications.routes.js";
import { reportsRoutes } from "./routes/reports.routes.js";
import { cargoRoutes } from "./routes/cargo.routes.js";
import { jobsRoutes } from "./routes/jobs.routes.js";
import { calendarRoutes } from "./routes/calendar.routes.js";
import { messagesRoutes } from "./routes/messages.routes.js";
import { complianceRoutes } from "./routes/compliance.routes.js";
import { employeesRoutes } from "./routes/employees.routes.js";
import { officeCostsRoutes } from "./routes/office-costs.routes.js";
import { shipperAccountsRoutes } from "./routes/shipper-accounts.routes.js";
import { portalRoutes } from "./routes/portal.routes.js";

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

  // Global baseline cap per client IP — backstops probing/flooding on routes
  // that have no stricter dedicated bucket (auth buckets stay tighter).
  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS" || req.url.startsWith("/api/v1/health")) return;
    await enforceRateLimit(`ip:${req.ip}`, 600, 60);
  });

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
  await app.register(invoicesRoutes, { prefix: "/api/v1" });
  await app.register(ledgerRoutes, { prefix: "/api/v1" });
  await app.register(dutyRoutes, { prefix: "/api/v1" });
  await app.register(fuelRoutes, { prefix: "/api/v1" });
  await app.register(inventoryRoutes, { prefix: "/api/v1" });
  await app.register(incidentsRoutes, { prefix: "/api/v1" });
  await app.register(clientsRoutes, { prefix: "/api/v1" });
  await app.register(notificationsRoutes, { prefix: "/api/v1" });
  await app.register(reportsRoutes, { prefix: "/api/v1" });
  await app.register(cargoRoutes, { prefix: "/api/v1" });
  await app.register(jobsRoutes, { prefix: "/api/v1" });
  await app.register(calendarRoutes, { prefix: "/api/v1" });
  await app.register(messagesRoutes, { prefix: "/api/v1" });
  await app.register(complianceRoutes, { prefix: "/api/v1" });
  await app.register(employeesRoutes, { prefix: "/api/v1" });
  await app.register(officeCostsRoutes, { prefix: "/api/v1" });
  await app.register(shipperAccountsRoutes, { prefix: "/api/v1" });
  await app.register(portalRoutes, { prefix: "/api/v1" });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((e) => { console.error(e); process.exit(1); });