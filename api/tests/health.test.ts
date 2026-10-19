import { describe, expect, it } from "vitest";
import Fastify from "fastify";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { ProbeCache, healthBody, healthRoutes, reasonFor } =
  await import("../src/routes/health.routes.js");
const { env } = await import("../src/env.js");

const up = { ok: true, latencyMs: 7, reason: null, at: Date.now() };
const down = { ok: false, latencyMs: null, reason: "timed_out", at: Date.now() };

describe("failure words the answer may use", () => {
  it("names the conditions an operator can act on", () => {
    expect(reasonFor("53300")).toBe("too_many_connections");
    expect(reasonFor("57P01")).toBe("shutting_down");
    expect(reasonFor("ENOTFOUND")).toBe("host_not_found");
    expect(reasonFor("PROBE_TIMEOUT")).toBe("timed_out");
  });
  it("folds anything unmapped instead of repeating it", () => {
    expect(reasonFor("99999")).toBe("unreachable");
    expect(reasonFor(undefined)).toBe("unreachable");
    expect(reasonFor(null)).toBe("unreachable");
  });
  it("never echoes a driver message, which can carry the pooler host and port", () => {
    const leaked = reasonFor("connect ECONNREFUSED 76.115.20.31:6543 to postgres://user:s3cret");
    expect(leaked).toBe("unreachable");
  });
});

describe("the answer body", () => {
  it("says up when the probe was answered", () => {
    const body = healthBody(up, 3);
    expect(body.status).toBe("ok");
    expect(body.checks.database).toMatchObject({ status: "up", latency_ms: 7, probes: 3 });
    expect(body.checks.database).not.toHaveProperty("reason");
  });
  it("says degraded, keeps the reason, and never invents a latency", () => {
    const body = healthBody(down, 12);
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toMatchObject({ status: "down", latency_ms: null, reason: "timed_out" });
  });
  it("names the build only when the platform provided one", () => {
    expect(healthBody(up, 1).commit).toBeUndefined();
    const saved = env.RENDER_GIT_COMMIT;
    env.RENDER_GIT_COMMIT = "e4054fe1".repeat(6).slice(0, 60);
    expect(healthBody(up, 1).commit).toHaveLength(40);
    env.RENDER_GIT_COMMIT = saved;
  });
});

describe("one probe per window, shared", () => {
  it("answers a burst from a single round trip", async () => {
    let calls = 0;
    const cache = new ProbeCache(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ...up, at: Date.now() };
    }, 5000);
    const ten = await Promise.all(Array.from({ length: 10 }, () => cache.check()));
    expect(calls).toBe(1);
    expect(cache.runs).toBe(1);
    expect(new Set(ten.map((p) => p.at)).size).toBe(1);
  });
  it("re-probes once the window has passed", async () => {
    let calls = 0;
    const cache = new ProbeCache(async () => {
      calls += 1;
      return { ...up, at: Date.now() };
    }, 0);
    await cache.check();
    await cache.check();
    expect(calls).toBe(2);
    expect(cache.runs).toBe(2);
  });
});

async function serve(probe: () => Promise<any>) {
  const app = Fastify();
  await app.register(healthRoutes, { probe });
  return app;
}

describe("the three paths", () => {
  it("liveness answers 200 with the honest verdict while the database is unreachable", async () => {
    const app = await serve(async () => down);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toMatchObject({ status: "down", reason: "timed_out" });
    expect(body.service).toBe("waisha-api");
    await app.close();
  });

  it("readiness is the one that refuses traffic", async () => {
    const app = await serve(async () => down);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("unavailable");
    await app.close();
  });

  it("answers 200 everywhere when the probe was fine", async () => {
    const app = await serve(async () => ({ ...up, at: Date.now() }));
    for (const url of ["/health", "/health/ready", "/api/v1/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().status, url).toBe("ok");
    }
    await app.close();
  });

  it("carries no string that could name the database", async () => {
    const app = await serve(async () => ({ ...down, reason: "unreachable" }));
    const raw = (await app.inject({ method: "GET", url: "/health/ready" })).body;
    for (const forbidden of ["://", "postgres", "5432", "6543", "message", "stack", "supabase"]) {
      expect(raw.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    await app.close();
  });

  it("registers exactly the probe paths and nothing beside them", async () => {
    const app = await serve(async () => up);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/health" })).statusCode).toBe(404);
    await app.close();
  });
});
