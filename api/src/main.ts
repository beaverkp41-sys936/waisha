import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { enforceRateLimit } from "./security/ratelimit.js";
import { isHealthPath, requireStaffAudience } from "./security/audience.js";
import { requireOperationalTenant } from "./security/tenant-state.js";
import { requireSupportReadonly } from "./security/support.js";
import { registerErrorHandling } from "./plugins/errors.js";
import { registerReliability, startReliabilityLoops } from "./security/reliability.js";
import { authRoutes } from "./routes/auth.routes.js";
import { contentRoutes } from "./routes/content.routes.js";
import { controlRoutes } from "./routes/control.routes.js";
import { controlTenantsRoutes } from "./routes/control-tenants.routes.js";
import { controlSupportRoutes } from "./routes/control-support.routes.js";
import { controlAnalyticsRoutes } from "./routes/control-analytics.routes.js";
import { controlRevenueRoutes } from "./routes/control-revenue.routes.js";
import { controlStaffRoutes } from "./routes/control-staff.routes.js";
import { controlSystemRoutes } from "./routes/control-system.routes.js";
import { controlReliabilityRoutes } from "./routes/control-reliability.routes.js";
import { controlRecommendationRoutes } from "./routes/control-recommendations.routes.js";
import { controlErrorRoutes } from "./routes/control-errors.routes.js";
import { controlDepartmentRoutes } from "./routes/control-departments.routes.js";
import { controlContentRoutes } from "./routes/control-content.routes.js";
import { controlTicketRoutes } from "./routes/control-tickets.routes.js";
import { errorIntakeRoutes } from "./routes/errors.routes.js";
import { recommendationRoutes } from "./routes/recommendations.routes.js";
import { announcementsRoutes } from "./routes/announcements.routes.js";
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
import { quotationsRoutes } from "./routes/quotations.routes.js";
import { ledgerRoutes } from "./routes/ledger.routes.js";
import { dutyRoutes } from "./routes/duty.routes.js";
import { fuelRoutes } from "./routes/fuel.routes.js";
import { inventoryRoutes } from "./routes/inventory.routes.js";
import { incidentsRoutes } from "./routes/incidents.routes.js";
import { clientsRoutes } from "./routes/clients.routes.js";
import { notificationsRoutes } from "./routes/notifications.routes.js";
import { reportsRoutes } from "./routes/reports.routes.js";
import { exportRoutes } from "./routes/export.routes.js";
import { cargoRoutes } from "./routes/cargo.routes.js";
import { cargoIntakeRoutes } from "./routes/cargo-intake.routes.js";
import { consolidationRoutes } from "./routes/consolidation.routes.js";
import { jobsRoutes } from "./routes/jobs.routes.js";
import { transportRoutes } from "./routes/transport.routes.js";
import { boardRoutes } from "./routes/board.routes.js";
import { calendarRoutes } from "./routes/calendar.routes.js";
import { messagesRoutes } from "./routes/messages.routes.js";
import { complianceRoutes } from "./routes/compliance.routes.js";
import { employeesRoutes } from "./routes/employees.routes.js";
import { proceduresRoutes } from "./routes/procedures.routes.js";
import { traineeReportsRoutes } from "./routes/trainee-reports.routes.js";
import { officeCostsRoutes } from "./routes/office-costs.routes.js";
import { attendanceRoutes } from "./routes/attendance.routes.js";
import { payrollRoutes } from "./routes/payroll.routes.js";
import { driverPayRoutes } from "./routes/driver-pay.routes.js";
import { financeRoutes } from "./routes/finance.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { debitNotesRoutes } from "./routes/debitnotes.routes.js";
import { shipperAccountsRoutes } from "./routes/shipper-accounts.routes.js";
import { portalRoutes } from "./routes/portal.routes.js";
import { seekerRoutes } from "./routes/seeker.routes.js";
import { directoryRoutes } from "./routes/directory.routes.js";
import { internalRoutes } from "./routes/internal.routes.js";
import { startBookingTimerLoop } from "./util/booking-timer.js";
import { startTenantPolicyLoop } from "./util/tenant-policy.js";

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

  // Uptime and latency are recorded from the same process they describe, so the hooks are
  // installed before anything else runs — a request that never reaches a handler still
  // cost the server something, and that is the number worth having during a flood.
  registerReliability(app);

  // Global baseline cap per client IP — backstops probing/flooding on routes
  // that have no stricter dedicated bucket (auth buckets stay tighter). The health
  // surface is exempt because a platform probe shares its source IP with everyone
  // behind it, and a check that gets a 429 answers "unhealthy" for a service that is fine.
  app.addHook("onRequest", async (req) => {
    if (req.method === "OPTIONS" || isHealthPath(req.url)) return;
    await enforceRateLimit(`ip:${req.ip}`, 600, 60);
  });

  // Audience boundary: portal accounts (shipper / temporary customer) may only
  // reach /portal and the auth plumbing — never the staff surface of the
  // transporter tenant they live inside. Registered before the routes so every
  // plugin inherits it.
  app.addHook("preHandler", requireStaffAudience);

  // A blocked company stops being served, mid-token. Revoking the refresh sessions is
  // what a block does to the seat, but an access token is valid for 15 minutes from
  // issue and nothing else consults the database about it — this closes that window.
  app.addHook("preHandler", requireOperationalTenant);

  // A borrowed seat (task #177) may look at a company but must not change it. The mark is
  // the `act` claim, so this is the one place it can be enforced: the route files all carry
  // their own requireAuth and none of them has ever heard of support.
  app.addHook("preHandler", requireSupportReadonly);

  // Registered without the prefix: the deploy platform probes the root of the service, and
  // this module also answers /api/v1/health for the clients that learned that path first.
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(contentRoutes, { prefix: "/api/v1" });
  await app.register(controlRoutes, { prefix: "/api/v1" });
  await app.register(controlTenantsRoutes, { prefix: "/api/v1" });
  await app.register(controlSupportRoutes, { prefix: "/api/v1" });
  await app.register(controlAnalyticsRoutes, { prefix: "/api/v1" });
  await app.register(controlRevenueRoutes, { prefix: "/api/v1" });
  await app.register(controlStaffRoutes, { prefix: "/api/v1" });
  await app.register(controlSystemRoutes, { prefix: "/api/v1" });
  await app.register(controlReliabilityRoutes, { prefix: "/api/v1" });
  await app.register(controlRecommendationRoutes, { prefix: "/api/v1" });
  await app.register(controlErrorRoutes, { prefix: "/api/v1" });
  await app.register(controlDepartmentRoutes, { prefix: "/api/v1" });
  await app.register(controlContentRoutes, { prefix: "/api/v1" });
  await app.register(controlTicketRoutes, { prefix: "/api/v1" });
  await app.register(errorIntakeRoutes, { prefix: "/api/v1" });
  await app.register(recommendationRoutes, { prefix: "/api/v1" });
  await app.register(announcementsRoutes, { prefix: "/api/v1" });
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
  await app.register(quotationsRoutes, { prefix: "/api/v1" });
  await app.register(ledgerRoutes, { prefix: "/api/v1" });
  await app.register(dutyRoutes, { prefix: "/api/v1" });
  await app.register(fuelRoutes, { prefix: "/api/v1" });
  await app.register(inventoryRoutes, { prefix: "/api/v1" });
  await app.register(incidentsRoutes, { prefix: "/api/v1" });
  await app.register(clientsRoutes, { prefix: "/api/v1" });
  await app.register(notificationsRoutes, { prefix: "/api/v1" });
  await app.register(reportsRoutes, { prefix: "/api/v1" });
  await app.register(exportRoutes, { prefix: "/api/v1" });
  await app.register(cargoRoutes, { prefix: "/api/v1" });
  await app.register(cargoIntakeRoutes, { prefix: "/api/v1" });
  await app.register(consolidationRoutes, { prefix: "/api/v1" });
  await app.register(jobsRoutes, { prefix: "/api/v1" });
  await app.register(transportRoutes, { prefix: "/api/v1" });
  await app.register(boardRoutes, { prefix: "/api/v1" });
  await app.register(calendarRoutes, { prefix: "/api/v1" });
  await app.register(messagesRoutes, { prefix: "/api/v1" });
  await app.register(complianceRoutes, { prefix: "/api/v1" });
  await app.register(employeesRoutes, { prefix: "/api/v1" });
  await app.register(proceduresRoutes, { prefix: "/api/v1" });
  await app.register(traineeReportsRoutes, { prefix: "/api/v1" });
  await app.register(officeCostsRoutes, { prefix: "/api/v1" });
  await app.register(attendanceRoutes, { prefix: "/api/v1" });
  await app.register(payrollRoutes, { prefix: "/api/v1" });
  await app.register(driverPayRoutes, { prefix: "/api/v1" });
  await app.register(financeRoutes, { prefix: "/api/v1" });
  await app.register(debitNotesRoutes, { prefix: "/api/v1" });
  await app.register(shipperAccountsRoutes, { prefix: "/api/v1" });
  await app.register(portalRoutes, { prefix: "/api/v1" });
  await app.register(seekerRoutes, { prefix: "/api/v1" });
  await app.register(directoryRoutes, { prefix: "/api/v1" });
  await app.register(internalRoutes, { prefix: "/api/v1" });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  startBookingTimerLoop(app.log);
  startTenantPolicyLoop(app.log);
  // The boot line and the first beat go out only once the port is actually open: this
  // register describes the process that was serving, and a boot that died before listen
  // belongs in the log, not in the uptime figure.
  startReliabilityLoops(app.log);
}

main().catch((e) => { console.error(e); process.exit(1); });