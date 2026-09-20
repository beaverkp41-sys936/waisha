/**
 * Live end-to-end demo against the running API:
 * transporter sign-up -> OTP verify (read code from the API terminal) -> login -> /auth/me.
 * Requires: pnpm dev running in another terminal.
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API = process.env.API_ORIGIN ?? "http://localhost:4000/api/v1";

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const s = Math.floor(Math.random() * 1e9).toString().padStart(9, "0");

  // Random policy-compliant password each run: fixed parts guarantee the
  // required character classes, the random middle makes it unique — so the
  // Have-I-Been-Pwned check never trips.
  const password = `Wsh!${Math.random().toString(36).slice(2, 10)}A1`;

  const payload = {
    companyName: "Demo Kilimanjaro Freight Ltd",
    tin: `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6, 9)}`,
    phone: `+25571${Math.floor(100000 + Math.random() * 899999)}`,
    email: `demo.${Date.now()}@example.com`,
    password,
    confirmPassword: password,
    acceptTerms: true
  };

  console.log("1) Signing up transporter:");
  console.log(`   company: ${payload.companyName}`);
  console.log(`   TIN:     ${payload.tin}`);
  console.log(`   email:   ${payload.email}`);
  console.log(`   phone:   ${payload.phone}`);
  console.log(`   password used: ${password}`);

  const signup = await post("/auth/transporter/signup", payload);
  if (!signup.ok) {
    console.error("SIGN-UP FAILED:", signup.status, JSON.stringify(signup.json, null, 2));
    process.exit(1);
  }
  console.log("   -> 201 Created. userId:", signup.json.userId);

  console.log("\n>>> NOW LOOK AT THE pnpm dev TERMINAL. Find the newest line like:");
  console.log('>>>   [sms:console] to=+25571... message="Your WAISHA verification code is XXXXXX ..."');
  const code = await rl.question("\n2) Type that 6-digit code here and press Enter: ");
  rl.close();

  const verify = await post("/auth/otp/verify", { userId: signup.json.userId, code: code.trim() });
  if (!verify.ok) {
    console.error("OTP VERIFY FAILED:", verify.status, JSON.stringify(verify.json, null, 2));
    process.exit(1);
  }
  console.log("   -> account verified and activated.");

  const login = await post("/auth/login", {
    mode: "transporter", tin: payload.tin, email: payload.email, password: payload.password
  });
  if (!login.ok) {
    console.error("LOGIN FAILED:", login.status, JSON.stringify(login.json, null, 2));
    process.exit(1);
  }
  console.log("   -> login ok. roles:", login.json.roles.join(", "));
  console.log("   -> access token starts:", login.json.accessToken.slice(0, 40) + "...");

  const me = await fetch(`${API}/auth/me`, {
    headers: { Authorization: `Bearer ${login.json.accessToken}` }
  });
  console.log("\n3) /auth/me says:", JSON.stringify(await me.json(), null, 2));
  console.log("\n=== DEMO COMPLETE: a real tenant now exists in your database. ===");
  console.log("Check Supabase Table Editor -> tenants, users, sessions, audit_logs.");
}

main().catch((e) => { console.error(e); process.exit(1); });