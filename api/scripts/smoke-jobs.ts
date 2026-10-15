/**
 * Step 3 — job pipeline smoke (spec Part 1: 10-stage internal task tracker).
 * Expects the API on :4000. Builds two probe tenants, then proves: a new cargo
 * file auto-generates its checklist; a stage cannot be completed before its
 * required documents are verified; stages run in order; blocked stages need a
 * reason; stage 9 records archive / handover / transport consent; a job closes
 * only with proof the cargo left us. Cross-tenant probes run as tenant B, a
 * permission sweep runs as a view-only staff user, and a final SQL check proves
 * B wrote nothing and A's rows are consistent. Everything is cleaned up.
 * Run: npx tsx scripts/smoke-jobs.ts   (DNS_FALLBACK=1 if local DNS is broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET);
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, detail.slice(0, 170)); }
}

async function mint(sub: string, tid: string, typ: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-8000-0000-0000000000cc", typ, roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("1h").sign(key);
}

async function call(path: string, token: string, init: any = {}) {
  const headers: any = { ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  // A body without a method is a POST — keeps the fixture calls short.
  const opts: any = { ...init, headers };
  if (opts.body !== undefined && !opts.method) opts.method = "POST";
  const res = await fetch(API + path, opts);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}
const json = (body: any) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = (body: any) => ({ method: "POST", ...json(body) });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const health = await fetch(API + "/health").then(r => r.json()).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const T1 = randomUUID(), T2 = randomUUID();
  const d1 = randomUUID(), d2 = randomUUID(), viewOnly = randomUUID();
  const ids = [T1, T2, d1, d2, viewOnly];

  const roleOf = async (k: string) => (await owner.query(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const traineeRole = await roleOf("trainee");

  // Dependency order: cargo_tasks points at job_stages, and job_stages points
  // at jobs, so children go first.
  const WIPE = ["job_handovers", "job_documents", "job_activity", "cargo_tasks", "job_stages",
    "jobs", "cargo_shipments", "documents", "company_profiles", "sessions", "otp_codes",
    "password_resets"];
  const wipeRoles = `delete from user_roles where user_id in
    (select id from users where tenant_id = any($1::uuid[]))`;

  // Pre-clean residue from an earlier crashed run (fixtures are named Jobprobe*).
  const oldT = (await owner.query(
    `select id from tenants where name in ('Jobprobe Alpha Ltd','Jobprobe Beta Ltd')`)).rows.map(r => r.id);
  if (oldT.length) {
    for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [oldT]);
    await owner.query(wipeRoles, [oldT]);
    await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [oldT]);
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [oldT]);
    console.log("pre-clean removed", oldT.length, "stale probe tenants");
  }

  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Jobprobe Alpha Ltd')`, [T1]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Jobprobe Beta Ltd')`, [T2]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Jobprobe Alpha Ltd','JP1')`, [randomUUID(), T1]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Jobprobe Beta Ltd','JP2')`, [randomUUID(), T2]);
  for (const [u, t, name] of [[d1, T1, "Alpha Director"], [d2, T2, "Beta Director"],
    [viewOnly, T1, "Alpha Viewer"]]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status)
              values ($1,$2,$3,$4,'active')`, [u, t, "staff", name]);
  }
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d1, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d2, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [viewOnly, traineeRole]);

  const tok1 = await mint(d1, T1, "director", ["director"]);
  const tok2 = await mint(d2, T2, "director", ["director"]);
  const tokView = await mint(viewOnly, T1, "staff", ["trainee"]);

  // ---------- 1. Creating a file auto-generates the checklist ----------
  const created = await call("/cargo", tok1, post({
    shipmentType: "import", containerType: "40ft", containerCount: 1, containerNumbers: ["JPNU1234567"],
    consigneeName: "Jobprobe Consignee", consignorName: "Jobprobe Supplier",
    eta: shiftDays(2), dischargeDate: shiftDays(4)
  }));
  const s1 = created.body?.id;
  check("cargo file created", created.status === 201 && !!s1, `[${created.status}]`);

  const jobsList = await call("/jobs", tok1);
  const job = (jobsList.body ?? []).find((j: any) => j.shipment_id === s1);
  check("job auto-created for the new file", jobsList.status === 200 && !!job, `[${jobsList.status}]`);
  const jobId = job?.id as string;
  check("checklist has all 10 stages", job?.stages_total === 10, `stages_total=${job?.stages_total}`);
  check("checklist auto-generated tasks", (job?.open_tasks ?? 0) >= 15, `open_tasks=${job?.open_tasks}`);
  check("job opens at stage 1", job?.current_stage_key === "job_opening", `${job?.current_stage_key}`);

  const detail = await call(`/jobs/${jobId}`, tok1);
  const stages = detail.body?.stages ?? [];
  check("detail returns 10 ordered stages", detail.status === 200 && stages.length === 10 &&
    stages[0].stage_key === "job_opening" && stages[9].stage_key === "closing_billing",
    `n=${stages.length}`);
  const byKey = new Map(stages.map((g: any) => [g.stage_key, g]));
  check("stage 2 carries its required documents",
    (byKey.get("pre_arrival_docs")?.required_documents ?? []).length === 3,
    JSON.stringify(byKey.get("pre_arrival_docs")?.required_documents));

  // ---------- 2. Stage gate: documents must be verified ----------
  const jumpAhead = await call(`/jobs/${jobId}/stages/${byKey.get("inspection")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "done" }) });
  check("cannot complete a later stage out of order", jumpAhead.status === 409 &&
    JSON.stringify(jumpAhead.body).includes("Job opening"), `[${jumpAhead.status}]`);

  const s1done = await call(`/jobs/${jobId}/stages/${byKey.get("job_opening")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "done" }) });
  check("stage 1 completes (no documents required)", s1done.status === 200, `[${s1done.status}]`);

  const s2blocked = await call(`/jobs/${jobId}/stages/${byKey.get("pre_arrival_docs")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "done" }) });
  check("stage 2 refuses to complete without verified documents",
    s2blocked.status === 409 && JSON.stringify(s2blocked.body).includes("bill_of_lading"),
    `[${s2blocked.status}] ${JSON.stringify(s2blocked.body).slice(0, 120)}`);

  const s2start = await call(`/jobs/${jobId}/stages/${byKey.get("pre_arrival_docs")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "in_progress" }) });
  check("stage 2 moves to in progress", s2start.status === 200, `[${s2start.status}]`);

  // Log then verify each required document of stage 2.
  for (const kind of ["bill_of_lading", "packing_list", "invoice"]) {
    const reg = await call(`/jobs/${jobId}/documents`, tok1, post({
      title: `${kind} for jobprobe`, kind, direction: "received",
      fromParty: "Jobprobe Supplier", toParty: "Jobprobe Consignee",
      docDate: shiftDays(-1), stageKey: "pre_arrival_docs"
    }));
    const docId = reg.body?.id;
    check(`document registered: ${kind}`, reg.status === 201 && !!docId, `[${reg.status}]`);
    const verify = await call(`/jobs/${jobId}/documents/${docId}/status`, tok1,
      { method: "PUT", ...json({ status: "verified" }) });
    check(`document verified: ${kind}`, verify.status === 200, `[${verify.status}]`);
  }
  const s2done = await call(`/jobs/${jobId}/stages/${byKey.get("pre_arrival_docs")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "done" }) });
  check("stage 2 completes once documents are verified", s2done.status === 200, `[${s2done.status}]`);

  // ---------- 3. Rejection path + blocked stage ----------
  const badReg = await call(`/jobs/${jobId}/documents`, tok1, post({
    title: "Wrong packing list", kind: "packing_list", direction: "received",
    stageKey: "pre_arrival_docs"
  }));
  const badDoc = badReg.body?.id;
  const noReason = await call(`/jobs/${jobId}/documents/${badDoc}/status`, tok1,
    { method: "PUT", ...json({ status: "rejected" }) });
  check("rejecting a document needs a reason", noReason.status === 400, `[${noReason.status}]`);
  const rejected = await call(`/jobs/${jobId}/documents/${badDoc}/status`, tok1,
    { method: "PUT", ...json({ status: "rejected", reason: "Weights do not match the BL" }) });
  check("document rejected with reason", rejected.status === 200, `[${rejected.status}]`);

  const blockNoReason = await call(`/jobs/${jobId}/stages/${byKey.get("shipment_tracking")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "blocked" }) });
  check("blocked stage needs a reason", blockNoReason.status === 400, `[${blockNoReason.status}]`);
  const blocked = await call(`/jobs/${jobId}/stages/${byKey.get("shipment_tracking")!.id}/status`,
    tok1, { method: "PUT", ...json({ status: "blocked", blockedReason: "Shipping line has not issued the arrival notice" }) });
  check("stage 3 blocked with reason", blocked.status === 200, `[${blocked.status}]`);

  const dash = await call("/jobs/dashboard", tok1);
  check("dashboard counts the blocked stage", (dash.body?.counts?.blocked_stages ?? 0) >= 1,
    JSON.stringify(dash.body?.counts));
  check("dashboard lists the blocked job", JSON.stringify(dash.body?.blocked ?? []).includes("arrival notice"));
  check("dashboard raises the ETA alert (real deadline)",
    JSON.stringify(dash.body?.deadlines ?? []).includes("eta"), JSON.stringify(dash.body?.deadlines ?? "").slice(0, 120));

  // ---------- 4. Tasks: assign, due, my tasks ----------
  const newTask = await call(`/jobs/${jobId}/tasks`, tok1, post({
    title: "Chase the arrival notice", stageKey: "shipment_tracking",
    assignedTo: d1, dueDate: shiftDays(-2), notes: "Follow up with the line agent"
  }));
  const taskId = newTask.body?.id;
  check("task added to a stage", newTask.status === 201 && !!taskId, `[${newTask.status}]`);
  const mine = await call("/jobs/my-tasks?scope=overdue", tok1);
  check("my-tasks shows the overdue task",
    mine.status === 200 && JSON.stringify(mine.body).includes(taskId), `[${mine.status}]`);
  const foreignAssign = await call(`/jobs/${jobId}/tasks`, tok1,
    json({ title: "Foreign assignee", assignedTo: d2 }));
  check("cannot assign a task to another tenant's user", foreignAssign.status === 400,
    `[${foreignAssign.status}]`);
  const taskDone = await call(`/jobs/${jobId}/tasks/${taskId}`, tok1,
    { method: "PATCH", ...json({ status: "done" }) });
  check("task marked done", taskDone.status === 200, `[${taskDone.status}]`);

  const board = await call("/jobs/board", tok1);
  const cols = board.body?.columns ?? [];
  check("kanban returns 10 stage columns", board.status === 200 && cols.length === 10, `n=${cols.length}`);
  const trackCol = cols.find((x: any) => x.stageKey === "shipment_tracking");
  check("job sits in the stage-3 kanban column",
    !!trackCol && JSON.stringify(trackCol.jobs).includes(s1), JSON.stringify(trackCol?.jobs ?? "").slice(0, 120));

  const timeline = await call(`/jobs/${jobId}/timeline`, tok1);
  const tl = JSON.stringify(timeline.body ?? []);
  check("timeline records stage and document actions",
    timeline.status === 200 && tl.includes("job.opened") && tl.includes("document.verified") &&
      tl.includes("stage.blocked"), `[${timeline.status}]`);

  // ---------- 5. Permission sweep: view-only staff ----------
  const viewOk = await call(`/jobs/${jobId}`, tokView);
  check("view-only staff can read the job", viewOk.status === 200, `[${viewOk.status}]`);
  const viewWrite = await call(`/jobs/${jobId}/stages/${byKey.get("payment")!.id}/status`,
    tokView, { method: "PUT", ...json({ status: "done" }) });
  check("view-only staff cannot change a stage", viewWrite.status === 403, `[${viewWrite.status}]`);
  const viewVerify = await call(`/jobs/${jobId}/documents/${badDoc}/status`,
    tokView, { method: "PUT", ...json({ status: "verified" }) });
  check("view-only staff cannot verify a document", viewVerify.status === 403, `[${viewVerify.status}]`);
  const viewDecision = await call(`/jobs/${jobId}/decision`, tokView,
    json({ recordKind: "archive" }));
  check("view-only staff cannot take the transport decision", viewDecision.status === 403,
    `[${viewDecision.status}]`);
  const viewOpen = await call("/jobs", tokView, { method: "POST" });
  check("view-only staff cannot open a job", viewOpen.status === 403, `[${viewOpen.status}]`);

  // ---------- 6. Free days on the job header (real deadline source) ----------
  const patched = await call(`/jobs/${jobId}`, tok1,
    { method: "PATCH", ...json({ freeDays: 3, freeDaysStart: shiftDays(-1) }) });
  check("job header stores the free-day clock", patched.status === 200, `[${patched.status}]`);
  const notif = await call("/notifications", tok1);
  const notifBody = JSON.stringify(notif.body ?? []);
  check("notification feed raises the free-days alert",
    notif.status === 200 && notifBody.includes("free days"), `[${notif.status}]`);
  check("notification feed raises the blocked-stage alert", notifBody.includes("blocked at"));

  // ---------- 7. Finish the customs stages so closing is reachable ----------
  const DOC_FOR_STAGE: Record<string, string[]> = {
    shipment_tracking: ["arrival_notice", "delivery_order"],
    declaration_prep: ["declaration"],
    customs_submission: ["assessment"],
    payment: ["receipt"],
    inspection: ["inspection"],
    release: ["release_note"]
  };
  for (const [stageKey, kinds] of Object.entries(DOC_FOR_STAGE)) {
    const st = byKey.get(stageKey)!;
    for (const kind of kinds) {
      const reg = await call(`/jobs/${jobId}/documents`, tok1,
        json({ title: `${kind} doc`, kind, direction: "received", stageKey }));
      const did = reg.body?.id;
      await call(`/jobs/${jobId}/documents/${did}/status`, tok1,
        { method: "PUT", ...json({ status: "verified" }) });
    }
    const unblock = await call(`/jobs/${jobId}/stages/${st.id}/status`, tok1,
      { method: "PUT", ...json({ status: "in_progress" }) });
    const done = await call(`/jobs/${jobId}/stages/${st.id}/status`, tok1,
      { method: "PUT", ...json({ status: "done" }) });
    check(`stage ${stageKey} completed after its documents verified`,
      unblock.status === 200 && done.status === 200, `[${unblock.status}/${done.status}]`);
  }

  // ---------- 8. Stage 9 transport decision ----------
  const earlyClose = await call(`/jobs/${jobId}/close`, tok1, { method: "POST" });
  check("cannot close while stages remain open",
    earlyClose.status === 409 && JSON.stringify(earlyClose.body).includes("Transport decision"),
    `[${earlyClose.status}] ${JSON.stringify(earlyClose.body).slice(0, 120)}`);

  const noConsent = await call(`/jobs/${jobId}/decision`, tok1,
    json({ recordKind: "live", transportNeeded: true }));
  check("transport needs the client asked first", noConsent.status === 400, `[${noConsent.status}]`);

  const noHandover = await call(`/jobs/${jobId}/decision`, tok1,
    json({ recordKind: "live", transportNeeded: false }));
  check("client-collect needs a handover record", noHandover.status === 400, `[${noHandover.status}]`);

  const decided = await call(`/jobs/${jobId}/decision`, tok1, post({
    recordKind: "live", transportNeeded: false,
    handover: {
      receivedByName: "Jobprobe Store Keeper", method: "signature",
      happenedAt: new Date().toISOString(), notes: "Signed on the delivery note"
    }
  }));
  check("stage 9 recorded: client collects with handover", decided.status === 200 &&
    decided.body?.consent === "not_asked", `[${decided.status}] ${JSON.stringify(decided.body)}`);
  const detail2 = await call(`/jobs/${jobId}`, tok1);
  check("handover is stored with who and how",
    JSON.stringify(detail2.body?.handovers ?? []).includes("Jobprobe Store Keeper") &&
      JSON.stringify(detail2.body?.handovers ?? []).includes("signature"));

  const closeNoFinal = await call(`/jobs/${jobId}/close`, tok1, { method: "POST" });
  check("cannot close before the billing stage", closeNoFinal.status === 409, `[${closeNoFinal.status}]`);
  const s10 = await call(`/jobs/${jobId}/stages/${byKey.get("closing_billing")!.id}/status`, tok1,
    { method: "PUT", ...json({ status: "done" }) });
  check("stage 10 completed", s10.status === 200, `[${s10.status}]`);
  const closed = await call(`/jobs/${jobId}/close`, tok1, { method: "POST" });
  check("job closes once every stage is done and handover recorded", closed.status === 200,
    `[${closed.status}] ${JSON.stringify(closed.body).slice(0, 120)}`);
  const afterClose = await call(`/cargo/${s1}`, tok1);
  check("closing marks the cargo file completed", afterClose.body?.status === "completed",
    `${afterClose.body?.status}`);
  const closedEdit = await call(`/jobs/${jobId}`, tok1, { method: "PATCH", ...json({ notes: "late edit" }) });
  check("a closed job is frozen", closedEdit.status === 409, `[${closedEdit.status}]`);
  const closedStage = await call(`/jobs/${jobId}/stages/${byKey.get("release")!.id}/status`, tok1,
    { method: "PUT", ...json({ status: "in_progress" }) });
  check("a closed job rejects stage edits", closedStage.status === 409, `[${closedStage.status}]`);

  // ---------- 9. Archive (record of a completed shipment) ----------
  const created2 = await call("/cargo", tok1, post({
    shipmentType: "transit", containerType: "loose_cargo",
    consigneeName: "Jobprobe Archive Consignee", consignorName: "Jobprobe Archive Sender",
    eta: shiftDays(-30)
  }));
  const s2 = created2.body?.id;
  const jobs2 = await call("/jobs", tok1);
  const job2 = (jobs2.body ?? []).find((j: any) => j.shipment_id === s2);
  check("transit file also opens its checklist",
    !!job2 && job2.record_kind === "live" && job2.stages_total === 10, JSON.stringify(job2 ?? {}).slice(0, 140));
  const archived = await call(`/jobs/${job2.id}/decision`, tok1,
    json({ recordKind: "archive", notes: "Historic file, saved for records" }));
  check("archive decision accepted", archived.status === 200 && archived.body?.recordKind === "archive",
    `[${archived.status}]`);
  const jobs2b = await call("/jobs?recordKind=archive", tok1);
  check("archive job listed under record_kind filter",
    JSON.stringify(jobs2b.body).includes(job2.id) && !JSON.stringify(jobs2b.body).includes(jobId));
  const archiveTransport = await call(`/jobs/${job2.id}/decision`, tok1,
    json({ recordKind: "archive", transportNeeded: true, consent: "granted" }));
  check("archive job cannot ask for transport", archiveTransport.status === 200 &&
    archiveTransport.body?.transportNeeded === false, JSON.stringify(archiveTransport.body));
  const job2Detail = await call(`/jobs/${job2.id}`, tok1);
  const st2 = new Map((job2Detail.body?.stages ?? []).map((g: any) => [g.stage_key, g]));
  const archOpen = await call(`/jobs/${job2.id}/stages/${st2.get("job_opening")!.id}/status`, tok1,
    { method: "PUT", ...json({ status: "done" }) });
  const archJump = await call(`/jobs/${job2.id}/stages/${st2.get("closing_billing")!.id}/status`, tok1,
    { method: "PUT", ...json({ status: "done" }) });
  check("archive records may close the billing stage out of order (information only)",
    archOpen.status === 200 && archJump.status === 200, `[${archOpen.status}/${archJump.status}]`);
  const archClose = await call(`/jobs/${job2.id}/close`, tok1, { method: "POST" });
  check("archive job still cannot close while stages remain open", archClose.status === 409,
    `[${archClose.status}]`);

  // ---------- 9b. Transport path: closing needs a verified POD ----------
  const created3 = await call("/cargo", tok1, post({
    shipmentType: "export", containerType: "40ft", containerCount: 1, containerNumbers: ["JPNU7654321"],
    consigneeName: "Jobprobe Buyer", consignorName: "Jobprobe Exporter"
  }));
  const s3 = created3.body?.id;
  const jobs3 = await call("/jobs", tok1);
  const job3 = (jobs3.body ?? []).find((j: any) => j.shipment_id === s3);
  check("export file opens its own checklist", !!job3 && job3.stages_total === 10, `[${jobs3.status}]`);

  const d3 = await call(`/jobs/${job3.id}`, tok1);
  for (const g of (d3.body?.stages ?? []) as any[]) {
    if (g.stage_key === "transport_decision" || g.stage_key === "closing_billing") continue;
    for (const kind of (g.required_documents ?? [])) {
      const reg = await call(`/jobs/${job3.id}/documents`, tok1,
        json({ title: `${kind} (export)`, kind, direction: "received", stageKey: g.stage_key }));
      const v = await call(`/jobs/${job3.id}/documents/${reg.body?.id}/status`, tok1,
        { method: "PUT", ...json({ status: "verified" }) });
      check(`export: ${g.stage_key} doc verified (${kind})`, v.status === 200, `[${v.status}]`);
    }
    const done = await call(`/jobs/${job3.id}/stages/${g.id}/status`, tok1,
      { method: "PUT", ...json({ status: "done" }) });
    check(`export: stage ${g.stage_key} completed`, done.status === 200, `[${done.status}]`);
  }
  const t3 = await call(`/jobs/${job3.id}/decision`, tok1,
    json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
  check("export job: client grants consent for transport", t3.status === 200 &&
    t3.body?.transportNeeded === true && t3.body?.consent === "granted", `[${t3.status}]`);
  const d3b = await call(`/jobs/${job3.id}`, tok1);
  const closeStage = (d3b.body?.stages ?? []).find((g: any) => g.stage_key === "closing_billing");
  await call(`/jobs/${job3.id}/stages/${closeStage.id}/status`, tok1,
    { method: "PUT", ...json({ status: "done" }) });
  const noPod = await call(`/jobs/${job3.id}/close`, tok1, { method: "POST" });
  check("transport job cannot close without proof of delivery",
    noPod.status === 409 && JSON.stringify(noPod.body).includes("proof of delivery"),
    `[${noPod.status}] ${JSON.stringify(noPod.body).slice(0, 120)}`);
  const podReg = await call(`/jobs/${job3.id}/documents`, tok1,
    json({ title: "Signed delivery note", kind: "pod", direction: "received", stageKey: "closing_billing" }));
  const podUnverified = await call(`/jobs/${job3.id}/close`, tok1, { method: "POST" });
  check("an unverified POD is not proof", podUnverified.status === 409, `[${podUnverified.status}]`);
  await call(`/jobs/${job3.id}/documents/${podReg.body?.id}/status`, tok1,
    { method: "PUT", ...json({ status: "verified" }) });
  const closed3 = await call(`/jobs/${job3.id}/close`, tok1, { method: "POST" });
  check("job closes once the POD is verified", closed3.status === 200, `[${closed3.status}]`);

  // ---------- 10. Cross-tenant probes as tenant B ----------
  const allIds = ids.join(",");
  const lists = ["/jobs", "/jobs/board", "/jobs/dashboard", "/jobs/my-tasks?scope=all",
    "/cargo", "/notifications"];
  for (const p of lists) {
    const r = await call(p, tok2);
    const hay = JSON.stringify(r.body ?? "");
    const mine2 = (r.body ?? []).find?.((x: any) => x.id === jobId);
    const leaked = [jobId, s1, s2].filter(x => x && hay.includes(x));
    check(`B list clean ${p}`, r.status === 200 && leaked.length === 0 && !mine2,
      `[${r.status}] ${leaked.join(",")}`);
  }
  const probes: [string, string, any?][] = [
    [`/jobs/${jobId}`, "GET"], [`/jobs/${jobId}/timeline`, "GET"],
    [`/jobs/${jobId}`, "PATCH", { notes: "hijacked" }],
    [`/jobs/${jobId}/stages/${byKey.get("release")!.id}/status`, "PUT", { status: "done" }],
    [`/jobs/${jobId}/tasks`, "POST", { title: "B task" }],
    [`/jobs/${jobId}/tasks/${taskId}`, "PATCH", { status: "pending" }],
    [`/jobs/${jobId}/documents`, "POST", { title: "B doc", kind: "invoice" }],
    [`/jobs/${jobId}/documents/${badDoc}/status`, "PUT", { status: "verified" }],
    [`/jobs/${jobId}/decision`, "POST", { recordKind: "archive" }],
    [`/jobs/${jobId}/handovers`, "POST", { receivedByName: "Beta Clerk", method: "photo" }],
    [`/jobs/${jobId}/close`, "POST"],
    [`/jobs`, "POST", { shipmentId: s1 }]
  ];
  for (const [p, method, body] of probes) {
    const r = await call(p, tok2, { method, ...(body ? json(body) : {}) });
    check(`B probe ${method} ${p} rejected`, r.status === 404 || r.status === 403,
      `[${r.status}] ${JSON.stringify(r.body ?? {}).slice(0, 80)}`);
  }
  const bBoard = await call("/jobs/board", tok2);
  check("B kanban is empty", bBoard.status === 200 &&
    (bBoard.body?.total ?? -1) === 0, JSON.stringify(bBoard.body).slice(0, 80));

  // A document from tenant A cannot be attached to a tenant B job.
  const bCargo = await call("/cargo", tok2, post({
    shipmentType: "import", containerType: "20ft", containerCount: 1, containerNumbers: ["JPNU9999999"],
    consigneeName: "Beta Consignee", consignorName: "Beta Supplier"
  }));
  const bs = bCargo.body?.id;
  const bJobs = await call("/jobs", tok2);
  const bJob = (bJobs.body ?? []).find((j: any) => j.shipment_id === bs);
  check("B can open its own job", !!bJob && bJob.stages_total === 10, `[${bJobs.status}]`);

  // A's stored file (owner-seeded) must not be attachable to B's job register.
  const aDocRow = randomUUID();
  await oi(`insert into documents (id, tenant_id, entity_type, entity_id, kind, file_name, mime_type,
             size_bytes, storage_path, uploaded_by, created_by, updated_by)
           values ($1,$2,'shipment',$3,'invoice','alpha-secret.pdf','application/pdf',1,'alpha/secret.pdf',$4,$4,$4)`,
    [aDocRow, T1, s1, d1]);
  const bOwnDoc = await call(`/jobs/${bJob.id}/documents`, tok2,
    json({ title: "Beta own document", kind: "invoice", direction: "received" }));
  check("positive: B registers a document on its own job", bOwnDoc.status === 201, `[${bOwnDoc.status}]`);
  const attachForeign = await call(`/jobs/${bJob.id}/documents`, tok2,
    json({ title: "stolen attach", kind: "invoice", documentId: aDocRow }));
  check("B cannot attach tenant A's stored file", attachForeign.status === 404,
    `[${attachForeign.status}]`);
  const bStageOnA = await call(`/jobs/${bJob.id}/stages/${byKey.get("release")!.id}/status`, tok2,
    { method: "PUT", ...json({ status: "done" }) });
  check("B cannot drive one of A's stages through its own job id", bStageOnA.status === 404,
    `[${bStageOnA.status}]`);
  const bTaskOnA = await call(`/jobs/${bJob.id}/tasks`, tok2,
    json({ title: "A task injection", assignedTo: d1 }));
  check("B cannot hand work to a tenant A user", bTaskOnA.status === 400, `[${bTaskOnA.status}]`);

  // Positive control on B: the transport path (consent asked, POD needed).
  const bTransport = await call(`/jobs/${bJob.id}/decision`, tok2,
    json({ recordKind: "live", transportNeeded: true, consent: "granted" }));
  check("positive: B records consent to reuse the shipment for transport",
    bTransport.status === 200 && bTransport.body?.consent === "granted",
    `[${bTransport.status}] ${JSON.stringify(bTransport.body)}`);
  const bDecline = await call(`/jobs/${bJob.id}/decision`, tok2,
    json({ recordKind: "live", transportNeeded: false, consent: "declined",
      handover: { receivedByName: "Beta Clerk", method: "photo" } }));
  check("B can switch to declined-collect later", bDecline.status === 200 &&
    bDecline.body?.consent === "declined", `[${bDecline.status}]`);

  // ---------- 11. SQL verification ----------
  const sqlCheck = await owner.query(
    `select
       (select count(*) from jobs where tenant_id = $1)::int        as a_jobs,
       (select count(*) from jobs where tenant_id = $2)::int        as b_jobs,
       (select count(*) from job_stages where tenant_id = $1)::int   as a_stages,
       (select count(*) from job_stages where tenant_id = $1 and status = 'done')::int as a_done,
       (select count(*) from job_stages where tenant_id = $2)::int   as b_stages,
       (select count(*) from job_documents where tenant_id = $1)::int as a_docs,
       (select count(*) from job_handovers where tenant_id = $1)::int as a_hv,
       (select count(*) from jobs where tenant_id = $1 and status = 'closed')::int as a_closed,
       (select count(*) from jobs where tenant_id = $1 and record_kind = 'archive')::int as a_archive,
       (select count(*) from cargo_tasks where tenant_id = $1 and stage_id is not null)::int as staged_tasks,
       (select count(*) from job_stages g join jobs j on j.id = g.job_id
         where g.tenant_id = $1 and g.status = 'blocked'
           and (g.blocked_reason is null or trim(g.blocked_reason) = ''))::int as bad_blocks,
       (select count(*) from job_documents where tenant_id = $1
         and status = 'rejected' and (rejection_reason is null or trim(rejection_reason) = ''))::int as bad_rejects,
       (select count(*) from job_stage_templates where tenant_id is not null)::int as tenant_templates,
       -- isolation: no B row may point at an A-owned job, shipment, stage or file
       (select count(*) from jobs j join cargo_shipments s on s.id = j.shipment_id
         where j.tenant_id = $2 and s.tenant_id = $1)::int as x_job_shipment,
       (select count(*) from job_stages g join jobs j on j.id = g.job_id
         where g.tenant_id = $2 and j.tenant_id = $1)::int as x_stage_job,
       (select count(*) from job_documents d join jobs j on j.id = d.job_id
         where d.tenant_id = $2 and j.tenant_id = $1)::int as x_doc_job,
       (select count(*) from job_documents d where d.tenant_id = $2
         and d.document_id = $3)::int as x_doc_file,
       (select count(*) from job_activity a where a.tenant_id = $2
         and (a.job_id = any($4::uuid[]) or a.shipment_id = any($5::uuid[])))::int as x_activity,
       (select count(*) from cargo_tasks k where k.tenant_id = $2
         and k.shipment_id = any($5::uuid[]))::int as x_tasks,
       (select count(*) from jobs where tenant_id = $1 and transport_needed
         and transport_consent = 'not_asked')::int as consent_gap
     `, [T1, T2, aDocRow, [jobId, job2.id, job3.id], [s1, s2, s3]]);
  const sq = sqlCheck.rows[0];
  check("SQL: A holds its 3 jobs, B holds only its own",
    sq.a_jobs === 3 && sq.b_jobs === 1, JSON.stringify(sq));
  check("SQL: A generated 30 stage rows (10 per job)", sq.a_stages === 30, `a_stages=${sq.a_stages}`);
  check("SQL: B generated 10 stage rows for its own job", sq.b_stages === 10, `b_stages=${sq.b_stages}`);
  check("SQL: A recorded documents, handover, archive and two closures",
    sq.a_docs >= 10 && sq.a_hv === 1 && sq.a_archive === 1 && sq.a_closed === 2, JSON.stringify(sq));
  check("SQL: zero cross-tenant references (job/stage/document/file/activity/task)",
    sq.x_job_shipment === 0 && sq.x_stage_job === 0 && sq.x_doc_job === 0 &&
      sq.x_doc_file === 0 && sq.x_activity === 0 && sq.x_tasks === 0, JSON.stringify(sq));
  check("SQL: every stage of a closed job is done",
    (await owner.query(`select count(*)::int n from jobs j
      where j.tenant_id = $1 and j.status = 'closed'
        and (select count(*) from job_stages g where g.job_id = j.id and g.status <> 'done') > 0`,
      [T1])).rows[0].n === 0);
  check("SQL: blocked stages all carry a reason", sq.bad_blocks === 0, `bad_blocks=${sq.bad_blocks}`);
  check("SQL: rejected documents all carry a reason", sq.bad_rejects === 0);
  check("SQL: checklist tasks are attached to stages", sq.staged_tasks >= 20, `staged=${sq.staged_tasks}`);
  check("SQL: templates stay global (no tenant rows)", sq.tenant_templates === 0);
  check("SQL: no transport job is missing consent", sq.consent_gap === 0, `consent_gap=${sq.consent_gap}`);

  // ---------- 12. Idempotent open + template read ----------
  const reopen = await call("/jobs", tok1, post({ shipmentId: s1 }));
  check("opening an existing job is idempotent",
    reopen.status === 200 && reopen.body?.existing === true, `[${reopen.status}]`);
  const tpl = await call("/jobs/templates/transit", tok1);
  check("template legend readable", (tpl.body?.rows ?? tpl.body ?? []).length === 10,
    JSON.stringify(tpl.body).slice(0, 80));

  // ---------- cleanup ----------
  for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await owner.query(wipeRoles, [[T1, T2]]);
  await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await owner.query(`delete from tenants where id = any($1::uuid[])`, [[T1, T2]]);
  const residue = await owner.query(
    `select (select count(*) from jobs where tenant_id = any($1::uuid[]))::int as j,
            (select count(*) from tenants where id = any($1::uuid[]))::int as t`, [[T1, T2]]);
  check("cleanup: no probe rows left", residue.rows[0].j === 0 && residue.rows[0].t === 0,
    JSON.stringify(residue.rows[0]));
  console.log(`\njob smoke: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILURES"} (ids ${allIds.slice(0, 8)}…)`);
  await owner.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
