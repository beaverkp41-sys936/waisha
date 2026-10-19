import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { rolesArePortalOnly, isOpenSurface, PORTAL_ONLY_ROLES } = await import("../src/security/audience.js");

describe("portal-only role detection", () => {
  it("recognises every portal role", () => {
    for (const r of PORTAL_ONLY_ROLES) expect(rolesArePortalOnly([r])).toBe(true);
  });
  it("treats a mixed bag as staff — one staff role opens the surface", () => {
    expect(rolesArePortalOnly(["shipper", "director"])).toBe(false);
    expect(rolesArePortalOnly(["shipper_portal", "finance"])).toBe(false);
  });
  it("is fail-closed when there is no role claim at all", () => {
    expect(rolesArePortalOnly([])).toBe(true);
    expect(rolesArePortalOnly(undefined)).toBe(true);
    expect(rolesArePortalOnly(null)).toBe(true);
  });
  it("does not mistake a staff key for a portal one by substring", () => {
    expect(rolesArePortalOnly(["shipper_manager"])).toBe(false);
  });
  it("lists seeker — its absence is what let a seeker token use the staff fast path", () => {
    expect(PORTAL_ONLY_ROLES).toContain("seeker");
    expect(rolesArePortalOnly(["seeker"])).toBe(true);
    expect(rolesArePortalOnly(["seeker", "director"])).toBe(false);
  });
});

describe("open surface allowlist", () => {
  it("keeps auth plumbing reachable for portal accounts", () => {
    for (const p of ["/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/me"]) {
      expect(isOpenSurface(p)).toBe(true);
    }
  });
  it("keeps the portal, control plane and public surfaces open", () => {
    expect(isOpenSurface("/api/v1/portal/files")).toBe(true);
    expect(isOpenSurface("/api/v1/control/announcements")).toBe(true);
    expect(isOpenSurface("/api/v1/announcements")).toBe(true);
  });
  it("leaves the staff surface closed", () => {
    for (const p of ["/api/v1/drivers", "/api/v1/notifications", "/api/v1/reports/cargo"]) {
      expect(isOpenSurface(p)).toBe(false);
    }
  });
  it("ignores the query string when matching", () => {
    expect(isOpenSurface("/api/v1/health?verbose=1")).toBe(true);
    expect(isOpenSurface("/api/v1/drivers?search=x")).toBe(false);
  });
  it("does not let a prefix-shaped path sneak through", () => {
    expect(isOpenSurface("/api/v1/portal-evil")).toBe(false);
    expect(isOpenSurface("/api/v1/control-x")).toBe(false);
    expect(isOpenSurface("/api/v1/internal-x")).toBe(false);
  });
  it("opens the seeker directory and pass surfaces, anchored on the slash", () => {
    expect(isOpenSurface("/api/v1/directory/search")).toBe(true);
    expect(isOpenSurface("/api/v1/seeker/passes")).toBe(true);
    expect(isOpenSurface("/api/v1/directory-x")).toBe(false);
    expect(isOpenSurface("/api/v1/seeker")).toBe(false);
  });
  it("opens the root health probes exactly, because the deploy platform has no token", () => {
    expect(isOpenSurface("/health")).toBe(true);
    expect(isOpenSurface("/health/ready")).toBe(true);
    expect(isOpenSurface("/health?deep=1")).toBe(true);
  });
  it("does not open the rest of the root beside them", () => {
    expect(isOpenSurface("/health-x")).toBe(false);
    expect(isOpenSurface("/health/ready/deep")).toBe(false);
    expect(isOpenSurface("/healthz")).toBe(false);
  });
});
