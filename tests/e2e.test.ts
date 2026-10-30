// End-to-end test against the real Postgres, in a throwaway schema, with a fake registrar.
// Run with:  npm run test:e2e
import { execSync } from "node:child_process";
import "dotenv/config";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/lib/crypto.js";
import { createRegistry } from "../src/registrars/index.js";
import { summarize, type RegistrarAdapter } from "../src/registrars/types.js";
import { istParts } from "../src/services/scheduler.js";

const run = process.env.RUN_E2E === "1";
const SCHEMA = "e2e_test";
const url = (process.env.DATABASE_URL ?? "").replace(/schema=[^&]*/, `schema=${SCHEMA}`);

// Fake registrar: outcome depends on the PAN's 9th character (a digit).
const fake: RegistrarAdapter = {
  id: "fake",
  name: "Fake Registrar",
  minDelayMs: 0,
  listIpos: async () => [{ registrarIpoId: "F1", name: "Fake Ltd - IPO", isSme: false }],
  check: async (_ipo, pan) => {
    const d = Number(pan[8]);
    if (d === 1) return { ...summarize([{ category: "RETAIL", applicantName: "X", appliedQty: 28, allottedQty: 28, price: 500, amountAdjusted: 14000 }]), message: null };
    if (d === 2) return { ...summarize([{ category: "RETAIL", applicantName: "X", appliedQty: 28, allottedQty: 0, price: 500, amountAdjusted: 0 }]), message: null };
    return { ...summarize([]), message: null };
  },
};

// Registrar that hasn't published yet until `published` flips; then behaves like `fake`.
let published = false;
let lateCalls = 0;
const late: RegistrarAdapter = {
  ...fake,
  id: "late",
  name: "Late Registrar",
  check: async (ipo, pan) => {
    lateCalls++;
    return published ? fake.check(ipo, pan) : { ...summarize([]), message: null };
  },
};

const CSV = [
  "PAN,Name,Client,Mobile,DP ID",
  "AAAPA0001A,Holder One,Family A,9000000001,",
  "AAAPB0002B,Holder Two,Family A,,",
  "AAAPC0003C,Holder Three,Family B,,",
  "BADPAN,Broken Row,Family B,,",
].join("\n");

function multipart(filename: string, content: string) {
  const boundary = "----e2eboundary";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe.runIf(run)("end to end", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const cookies: Record<string, string> = {};

  async function login(who: "admin" | "operator") {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@e2e.test`, password: "e2e-password-123" } });
    expect(res.statusCode).toBe(200);
    cookies[who] = res.cookies.find((c) => c.name === "aca_token")!.value;
  }
  const as = (who: "admin" | "operator") => ({ cookies: { aca_token: cookies[who]! } });

  beforeAll(async () => {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    prisma = new PrismaClient({ datasourceUrl: url });
    const passwordHash = await hashPassword("e2e-password-123");
    await prisma.user.create({ data: { email: "admin@e2e.test", name: "Admin", role: "ADMIN", passwordHash } });
    await prisma.user.create({ data: { email: "operator@e2e.test", name: "Op", role: "OPERATOR", passwordHash } });
    app = await buildApp({ ...loadConfig(), DATABASE_URL: url, LOG_LEVEL: (process.env.E2E_LOG ?? "silent") as "silent" }, { prisma, registry: createRegistry([fake, late]) });
    await app.ready();
    await login("admin");
    await login("operator");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    const p = new PrismaClient({ datasourceUrl: url });
    await p.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await p.$disconnect();
  });

  it("imports PANs with preview, skip-errors and idempotent re-import", async () => {
    const preview = await app.inject({ method: "POST", url: "/api/pans/import?dryRun=true", ...as("admin"), ...multipart("pans.csv", CSV) });
    expect(preview.json().plan.summary).toMatchObject({ create: 3, update: 0, errors: 1, newClients: 2 });
    expect(await prisma.pan.count()).toBe(0);

    const blocked = await app.inject({ method: "POST", url: "/api/pans/import?dryRun=false", ...as("admin"), ...multipart("pans.csv", CSV) });
    expect(blocked.statusCode).toBe(400);

    const commit = await app.inject({ method: "POST", url: "/api/pans/import?dryRun=false&skipErrors=true", ...as("admin"), ...multipart("pans.csv", CSV) });
    expect(commit.statusCode).toBe(200);
    expect(await prisma.pan.count()).toBe(3);

    const again = await app.inject({ method: "POST", url: "/api/pans/import?dryRun=true", ...as("admin"), ...multipart("pans.csv", CSV) });
    expect(again.json().plan.summary).toMatchObject({ create: 0, unchanged: 3 });

    // Stored encrypted, never in plain text.
    const raw = await prisma.pan.findMany();
    expect(raw.every((p) => !p.panEncrypted.includes("AAAP") && p.panMasked.includes("****"))).toBe(true);
  });

  it("operators have every right except Users and Audit log; PANs are shown in full", async () => {
    const op = await app.inject({ method: "POST", url: "/api/pans/import?dryRun=true", ...as("operator"), ...multipart("pans.csv", CSV) });
    expect(op.statusCode).toBe(200);
    expect(op.json().plan.rows[0]).toMatchObject({ pan: "AAAPA0001A" });
    const list = (await app.inject({ url: "/api/pans", ...as("operator") })).json();
    expect(list.pans.map((p: { pan: string }) => p.pan)).toContain("AAAPA0001A");
    expect(JSON.stringify(list)).not.toContain("panEncrypted");
    for (const url of ["/api/users", "/api/audit"]) {
      expect((await app.inject({ url, ...as("operator") })).statusCode).toBe(403);
      expect((await app.inject({ url, ...as("admin") })).statusCode).toBe(200);
    }
    const pan = await prisma.pan.findFirstOrThrow({ where: { holderName: "Holder One" } });
    expect((await app.inject({ url: `/api/pans/${pan.id}/reveal`, ...as("admin") })).statusCode).toBe(404); // no longer needed
  });

  it("finds a PAN by exact search", async () => {
    const res = await app.inject({ url: "/api/pans?q=aaapb0002b", ...as("operator") });
    expect(res.json().pans.map((p: { holderName: string }) => p.holderName)).toEqual(["Holder Two"]);
  });

  let ipoId: number;
  it("tracks an IPO from the registrar list and runs a check job", async () => {
    const live = await app.inject({ url: "/api/registrars/fake/ipos", ...as("operator") });
    expect(live.json().ipos[0]).toMatchObject({ registrarIpoId: "F1", trackedIpoId: null });

    const created = await app.inject({ method: "POST", url: "/api/ipos", ...as("operator"), payload: { registrar: "fake", registrarIpoId: "F1", name: "Fake Ltd - IPO" } });
    expect(created.statusCode).toBe(201);
    ipoId = created.json().ipo.id;
    const dup = await app.inject({ method: "POST", url: "/api/ipos", ...as("operator"), payload: { registrar: "fake", registrarIpoId: "F1", name: "Fake Ltd - IPO" } });
    expect(dup.statusCode).toBe(409);

    const before = await app.inject({ url: `/api/ipos/${ipoId}`, ...as("operator") });
    expect(before.json().ipo.counts).toMatchObject({ PENDING: 3, ALLOTTED: 0 });

    const start = await app.inject({ method: "POST", url: `/api/ipos/${ipoId}/check`, ...as("operator"), payload: { scope: "unchecked" } });
    expect(start.statusCode).toBe(202);
    const jobId = start.json().job.id;

    for (let i = 0; i < 100; i++) {
      const j = await prisma.checkJob.findUniqueOrThrow({ where: { id: jobId } });
      if (j.state === "DONE") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const job = await prisma.checkJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ state: "DONE", done: 3, failed: 0 });

    const after = await app.inject({ url: `/api/ipos/${ipoId}`, ...as("operator") });
    expect(after.json().ipo.counts).toMatchObject({ ALLOTTED: 1, NOT_ALLOTTED: 1, NOT_APPLIED: 1, PENDING: 0, allottedShares: 28 });

    const none = await app.inject({ method: "POST", url: `/api/ipos/${ipoId}/check`, ...as("operator"), payload: { scope: "unchecked" } });
    expect(none.statusCode).toBe(400); // nothing left unchecked
  });

  it("results grid shows full PANs to everyone; search by full PAN", async () => {
    for (const who of ["admin", "operator"] as const) {
      const res = (await app.inject({ url: `/api/ipos/${ipoId}/results?status=ALLOTTED`, ...as(who) })).json();
      expect(res.rows[0]).toMatchObject({ pan: "AAAPA0001A" });
      expect(JSON.stringify(res)).not.toContain("panEncrypted");
    }
    const byPan = (await app.inject({ url: `/api/ipos/${ipoId}/results?q=aaapb0002b`, ...as("operator") })).json();
    expect(byPan.rows.map((r: { holderName: string }) => r.holderName)).toEqual(["Holder Two"]);
  });

  it("filters results", async () => {
    const res = await app.inject({ url: `/api/ipos/${ipoId}/results?status=ALLOTTED`, ...as("operator") });
    expect(res.json().rows).toHaveLength(1);
    expect(res.json().rows[0]).toMatchObject({ holderName: "Holder One", panMasked: "AAAPA****A", result: { status: "ALLOTTED", allottedQty: 28 } });
  });

  async function readXlsx(body: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as unknown as ArrayBuffer);
    return wb;
  }

  it("exports IPO results with full PANs for everyone (audited)", async () => {
    const op = await app.inject({ url: `/api/ipos/${ipoId}/export`, ...as("operator") });
    expect(op.statusCode).toBe(200);
    expect(op.headers["content-disposition"]).toMatch(/attachment; filename="Fake Ltd - IPO allotment \d{4}-\d{2}-\d{2}\.xlsx"/);
    const wb = await readXlsx(op.rawPayload);
    const res = wb.getWorksheet("Results")!;
    const panCol = (res.getRow(1).values as unknown[]).indexOf("PAN");
    expect(res.getColumn(panCol).values).toContain("AAAPA0001A");
    expect(JSON.stringify(res.getSheetValues())).not.toContain("****");
    expect(await prisma.auditLog.count({ where: { action: "export.ipo" } })).toBe(1);
  });

  it("history report and export", async () => {
    const byClient = (await app.inject({ url: "/api/reports/history?groupBy=client", ...as("operator") })).json();
    expect(byClient.totals).toMatchObject({ ipos: 1, pans: 3, applications: 2, allotted: 1, ratio: 0.5, sharesAllotted: 28, allottedValue: 14000 });
    expect(byClient.rows.find((r: { label: string }) => r.label === "Family A")).toMatchObject({ applied: 2, allotted: 1 });
    expect(JSON.stringify(byClient)).not.toContain("panEncrypted");

    const byPan = (await app.inject({ url: "/api/reports/history?groupBy=pan&registrar=fake", ...as("operator") })).json();
    expect(byPan.rows).toHaveLength(3);
    expect((await app.inject({ url: "/api/reports/history?registrar=nope", ...as("operator") })).json().rows).toEqual([]);

    const x = await app.inject({ url: "/api/reports/history/export", ...as("operator") });
    expect(x.statusCode).toBe(200);
    const wb = await readXlsx(x.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Overview", "By client", "By PAN", "Detail"]);
  });

  it("re-check errors/not-applied picks up only those PANs", async () => {
    const res = await app.inject({ method: "POST", url: `/api/ipos/${ipoId}/check`, ...as("operator"), payload: { scope: "errors" } });
    expect(res.json().job.total).toBe(1);
    await app.runner.cancel(res.json().job.id);
  });

  async function waitForJobs(id: number) {
    for (let i = 0; i < 100; i++) {
      if (!(await prisma.checkJob.count({ where: { ipoId: id, state: { in: ["QUEUED", "RUNNING"] } } }))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("jobs did not finish");
  }

  const today = istParts(new Date()).date;
  const noonIst = () => new Date(`${today}T06:30:00Z`);

  it("operators can set dates, auto-check and archive/restore IPOs", async () => {
    const ok = await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { allotmentDate: today, autoCheck: false } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ipo).toMatchObject({ autoCheck: false });
    expect((await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { archived: true } })).json().ipo.archived).toBe(true);
    expect((await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { archived: false } })).json().ipo.archived).toBe(false);
  });

  it("scheduler ignores IPOs with auto-check off, and does nothing outside hours", async () => {
    const lateIpo = await prisma.ipo.create({ data: { name: "Late Ltd - IPO", registrar: "late", registrarIpoId: "L1", allotmentDate: new Date(`${today}T00:00:00Z`) } });
    expect((await app.scheduler.plan(noonIst())).map((p) => p.ipo.id)).toEqual([lateIpo.id]);

    await app.scheduler.tick(new Date(`${today}T20:00:00Z`)); // 01:30 IST next day → different date, nothing due
    await app.scheduler.tick(new Date(`${today}T00:30:00Z`)); // 06:00 IST, before start hour
    expect(app.scheduler.lastTick!.entries[0]!.decision.reason).toMatch(/Outside checking hours/);
    expect(await prisma.checkJob.count({ where: { ipoId: lateIpo.id } })).toBe(0);
  });

  it("allotment day: checks everyone, probes while unpublished, re-checks all once data is out", async () => {
    const lateIpo = await prisma.ipo.findFirstOrThrow({ where: { registrar: "late" } });

    await app.scheduler.tick(noonIst());
    expect(app.scheduler.lastTick!.entries[0]!.decision).toMatchObject({ action: "job", scope: "unchecked" });
    await waitForJobs(lateIpo.id);
    expect(await prisma.checkResult.count({ where: { ipoId: lateIpo.id, status: "NOT_APPLIED" } })).toBe(3);

    // Not published: a probe of the sample, then wait.
    lateCalls = 0;
    await app.scheduler.tick(noonIst());
    expect(app.scheduler.lastTick!.entries[0]!.decision.reason).toMatch(/hasn't published/);
    expect(lateCalls).toBe(3); // sample = all 3 PANs here
    await app.scheduler.tick(noonIst());
    expect(app.scheduler.lastTick!.entries[0]!.decision.reason).toMatch(/next probe/);
    expect(lateCalls).toBe(3); // throttled, no new calls

    // Registrar publishes; once the probe interval passes, the probe finds data and re-checks all.
    published = true;
    await prisma.ipo.update({ where: { id: lateIpo.id }, data: { lastProbeAt: new Date(Date.now() - 31 * 60_000) } });
    await app.scheduler.tick(new Date());
    expect(app.scheduler.lastTick!.entries[0]!.decision).toMatchObject({ action: "job", scope: "all" });
    await waitForJobs(lateIpo.id);
    expect(await prisma.checkResult.count({ where: { ipoId: lateIpo.id, status: "ALLOTTED" } })).toBe(1);

    await app.scheduler.tick(new Date());
    expect(app.scheduler.lastTick!.entries[0]!.decision).toEqual({ action: "wait", reason: "Done" });

    const status = (await app.inject({ url: "/api/scheduler", ...as("operator") })).json();
    expect(status.ipos).toHaveLength(1);
    expect(status.ipos[0]).toMatchObject({ name: "Late Ltd - IPO", next: { action: "wait", reason: "Done" } });
    expect(await prisma.checkJob.count({ where: { ipoId: lateIpo.id, trigger: "auto" } })).toBe(2);
  });

  it("scheduler retries errors only", async () => {
    const lateIpo = await prisma.ipo.findFirstOrThrow({ where: { registrar: "late" } });
    const pan = await prisma.pan.findFirstOrThrow({ where: { holderName: "Holder Three" } });
    await prisma.checkResult.update({ where: { ipoId_panId: { ipoId: lateIpo.id, panId: pan.id } }, data: { status: "ERROR", message: "timeout" } });
    await prisma.checkJob.updateMany({ where: { ipoId: lateIpo.id }, data: { finishedAt: new Date(Date.now() - 20 * 60_000) } });

    await app.scheduler.tick(new Date());
    expect(app.scheduler.lastTick!.entries[0]!.decision).toMatchObject({ action: "job", scope: "failed" });
    const job = await prisma.checkJob.findFirstOrThrow({ where: { ipoId: lateIpo.id }, orderBy: { id: "desc" } });
    expect(job).toMatchObject({ trigger: "auto", scope: "failed", total: 1 });
    await waitForJobs(lateIpo.id);
    expect((await prisma.checkResult.findUniqueOrThrow({ where: { ipoId_panId: { ipoId: lateIpo.id, panId: pan.id } } })).status).toBe("NOT_APPLIED");
  });

  it("listing P&L on the IPO, in reports and in the export", async () => {
    const before = (await app.inject({ url: `/api/ipos/${ipoId}`, ...as("operator") })).json().ipo;
    expect(before.listingGain).toBeNull();

    const patch = await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { listingPrice: 612.5 } });
    expect(patch.statusCode).toBe(200);
    // Holder One: 28 shares, registrar price 500 → (612.5 − 500) × 28
    expect((await app.inject({ url: `/api/ipos/${ipoId}`, ...as("operator") })).json().ipo.listingGain).toBe(3150);

    await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { issuePrice: 520 } });
    expect((await app.inject({ url: `/api/ipos/${ipoId}`, ...as("operator") })).json().ipo.listingGain).toBe(2590);

    const rep = (await app.inject({ url: `/api/reports/history?ipoId=${ipoId}`, ...as("operator") })).json();
    expect(rep.totals).toMatchObject({ listingGain: 2590, gainUnknown: 0 });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await app.inject({ url: `/api/ipos/${ipoId}/export?status=ALLOTTED`, ...as("operator") })).rawPayload as unknown as ArrayBuffer);
    const res = wb.getWorksheet("Results")!;
    const col = (res.getRow(1).values as unknown[]).indexOf("Listing gain");
    expect(res.getRow(2).getCell(col).value).toBe(2590);

    expect((await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { listingPrice: -5 } })).statusCode).toBe(400);
  });

  it("live IPOs across all registrars, flagged when tracked", async () => {
    const live = (await app.inject({ url: "/api/registrars/live", ...as("operator") })).json();
    expect(live.registrars.map((r: { id: string; count: number; error: unknown }) => [r.id, r.count, r.error])).toEqual([["fake", 1, null], ["late", 1, null]]);
    const f1 = live.ipos.filter((i: { registrar: string }) => i.registrar === "fake")[0];
    expect(f1).toMatchObject({ registrarIpoId: "F1", registrarName: "Fake Registrar", trackedIpoId: ipoId });
    // "late" lists F1 too, but it isn't tracked under that registrar.
    expect(live.ipos.find((i: { registrar: string }) => i.registrar === "late").trackedIpoId).toBeNull();
  });

  it("uploading new PANs checks them straight away for the chosen IPOs", async () => {
    const csv = ["PAN,Name,Client", "AAAPD0001D,New Holder,Family C", "AAAPE0002E,Other New,Family C"].join("\n");
    const res = await app.inject({ method: "POST", url: `/api/pans/import?dryRun=false&checkIpoIds=${ipoId}`, ...as("admin"), ...multipart("new.csv", csv) });
    expect(res.statusCode, res.body).toBe(200);
    const [c] = res.json().checks;
    // Only the 2 new PANs — the 3 existing ones already have results for this IPO.
    expect(c).toMatchObject({ ipoId, total: 2 });
    const job = await prisma.checkJob.findUniqueOrThrow({ where: { id: c.jobId } });
    expect(job.trigger).toBe("import");
    await waitForJobs(ipoId);
    const newPan = await prisma.pan.findFirstOrThrow({ where: { holderName: "New Holder" } });
    expect((await prisma.checkResult.findUniqueOrThrow({ where: { ipoId_panId: { ipoId, panId: newPan.id } } })).status).toBe("ALLOTTED");

    // Dry runs never start checks; a re-upload of the same file finds nothing new.
    const dry = await app.inject({ method: "POST", url: `/api/pans/import?dryRun=true&checkIpoIds=${ipoId}`, ...as("admin"), ...multipart("new.csv", csv) });
    expect(dry.json().checks).toEqual([]);
    const again = await app.inject({ method: "POST", url: `/api/pans/import?dryRun=false&checkIpoIds=${ipoId}`, ...as("admin"), ...multipart("new.csv", csv) });
    expect(again.json().checks[0]).toMatchObject({ jobId: null, total: 0 });
  });

  it("queues new PANs behind a check that is already running", async () => {
    // Hold a fake running job for this IPO covering the existing PANs.
    const all = await prisma.pan.findMany({ select: { id: true } });
    const running = await prisma.checkJob.create({ data: { ipoId, scope: "all", panIds: all.map((p) => p.id), total: all.length, state: "RUNNING" } });
    const csv = ["PAN,Name,Client", "AAAPF0003F,Third New,Family C"].join("\n");
    const res = await app.inject({ method: "POST", url: `/api/pans/import?dryRun=false&checkIpoIds=${ipoId}`, ...as("admin"), ...multipart("more.csv", csv) });
    const [c] = res.json().checks;
    expect(c.total).toBe(1);
    const followUp = await prisma.checkJob.findUniqueOrThrow({ where: { id: c.jobId } });
    expect(followUp.panIds).toHaveLength(1);
    await prisma.checkJob.update({ where: { id: running.id }, data: { state: "DONE" } });
    await app.runner.cancel(followUp.id);
  });

  it("editing a PAN's name, mobile and DP ID", async () => {
    const pan = await prisma.pan.findFirstOrThrow({ where: { holderName: "Holder Two" } });
    const res = await app.inject({ method: "PATCH", url: `/api/pans/${pan.id}`, ...as("admin"), payload: { holderName: "Holder Two Edited", mobile: "9111111111", dpClientId: "" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().pan).toMatchObject({ holderName: "Holder Two Edited", mobile: "9111111111", dpClientId: null });
    expect((await app.inject({ method: "PATCH", url: `/api/pans/${pan.id}`, ...as("operator"), payload: { mobile: "9222222222" } })).json().pan.mobile).toBe("9222222222");
  });

  it("deleting PANs keeps their IPO history in reports, with the full PAN", async () => {
    const one = await prisma.pan.findFirstOrThrow({ where: { holderName: "Holder One" } }); // allotted 28 in Fake IPO
    const before = (await app.inject({ url: `/api/reports/history?ipoId=${ipoId}`, ...as("operator") })).json().totals;

    expect((await app.inject({ method: "DELETE", url: `/api/pans/${one.id}`, ...as("admin") })).statusCode).toBe(200);
    expect(await prisma.pan.findUnique({ where: { id: one.id } })).toBeNull();
    const kept = await prisma.checkResult.findFirstOrThrow({ where: { ipoId, holderName: "Holder One" } });
    expect(kept).toMatchObject({ panId: null, panMasked: "AAAPA****A", clientName: "Family A", status: "ALLOTTED" });
    expect(kept.panEncrypted).toBeTruthy();
    expect(kept.panEncrypted).not.toContain("AAAPA0001A"); // still encrypted at rest

    // Report totals for the IPO are unchanged; the PAN shows as deleted.
    const after = (await app.inject({ url: `/api/reports/history?ipoId=${ipoId}&groupBy=pan`, ...as("operator") })).json();
    expect(after.totals).toMatchObject({ applications: before.applications, allotted: before.allotted, sharesAllotted: before.sharesAllotted });
    expect(after.rows.find((r: { label: string }) => r.label === "Holder One")).toMatchObject({ deleted: true, pan: "AAAPA0001A", allotted: 1 });
    // Client filter still finds it through the snapshot.
    const famA = await prisma.client.findFirstOrThrow({ where: { name: "Family A" } });
    const byClient = (await app.inject({ url: `/api/reports/history?clientId=${famA.id}&groupBy=pan`, ...as("operator") })).json();
    expect(byClient.rows.map((r: { label: string }) => r.label)).toContain("Holder One");

    // The export shows the deleted PAN in full too.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await app.inject({ url: `/api/reports/history/export?ipoId=${ipoId}`, ...as("operator") })).rawPayload as unknown as ArrayBuffer);
    const detail = JSON.stringify(wb.getWorksheet("Detail")!.getSheetValues());
    expect(detail).toContain("Holder One (deleted)");
    expect(detail).toContain("AAAPA0001A");
    expect(detail).toContain("AAAPB0002B");

    // The IPO page only counts live PANs.
    const ipo = (await app.inject({ url: `/api/ipos/${ipoId}`, ...as("operator") })).json().ipo;
    expect(ipo.counts.ALLOTTED).toBe(1); // New Holder; Holder One is gone from the live list
  });

  it("report shows full PANs to everyone; only PANs deleted before full-PAN history existed stay masked", async () => {
    const res = (await app.inject({ url: `/api/reports/history?ipoId=${ipoId}&groupBy=pan`, ...as("operator") })).json();
    expect(res.rows.find((r: { label: string }) => r.label === "New Holder").pan).toBe("AAAPD0001D");
    expect(res.rows.find((r: { label: string }) => r.label === "Holder One")).toMatchObject({ deleted: true, pan: "AAAPA0001A" });
    expect(JSON.stringify(res)).not.toContain("panEncrypted");
    // A PAN deleted by an older version has no full PAN left: it falls back to masked.
    await prisma.checkResult.updateMany({ where: { ipoId, holderName: "Holder One" }, data: { panEncrypted: null } });
    const old = (await app.inject({ url: `/api/reports/history?ipoId=${ipoId}&groupBy=pan`, ...as("operator") })).json();
    expect(old.rows.find((r: { label: string }) => r.label === "Holder One").pan).toBe("AAAPA****A");
  });

  it("bulk delete by selection, by filter, and from an Excel list (with preview)", async () => {
    const famC = await prisma.client.findFirstOrThrow({ where: { name: "Family C" } });
    const cPans = await prisma.pan.findMany({ where: { clientId: famC.id }, orderBy: { id: "asc" } });
    expect(cPans.length).toBe(3);

    const sel = await app.inject({ method: "POST", url: "/api/pans/bulk-delete", ...as("admin"), payload: { ids: [cPans[0]!.id] } });
    expect(sel.json()).toEqual({ deleted: 1 });

    const csv = ["PAN", "AAAPE0002E", "aaapf0003f", "ZZZPZ9999Z", "BAD"].join("\n");
    const preview = (await app.inject({ method: "POST", url: "/api/pans/bulk-delete/file?dryRun=true", ...as("admin"), ...multipart("del.csv", csv) })).json();
    expect(preview.matched.map((m: { pan: string }) => m.pan).sort()).toEqual(["AAAPE0002E", "AAAPF0003F"]);
    expect(preview.notFound).toEqual([{ rowNumber: 4, pan: "ZZZPZ9999Z", panMasked: "ZZZPZ****Z" }]);
    expect(preview.errors).toEqual([{ rowNumber: 5, message: "Invalid PAN format" }]);
    expect(await prisma.pan.count({ where: { clientId: famC.id } })).toBe(2); // preview deletes nothing

    const done = (await app.inject({ method: "POST", url: "/api/pans/bulk-delete/file?dryRun=false", ...as("operator"), ...multipart("del.csv", csv) })).json();
    expect(done.deleted).toBe(2);
    expect(await prisma.pan.count({ where: { clientId: famC.id } })).toBe(0);

    // Filter-based: everything matching "Holder Three".
    const byFilter = (await app.inject({ method: "POST", url: "/api/pans/bulk-delete", ...as("admin"), payload: { filter: { q: "Holder Three" } } })).json();
    expect(byFilter.deleted).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "pan.bulk_delete" } })).toBeGreaterThanOrEqual(1);
  });

  it("download formats for bulk uploads", async () => {
    for (const [type, cols] of [["pans", ["PAN", "Name", "Client", "Mobile", "DP ID"]], ["delete", ["PAN"]]] as const) {
      const res = await app.inject({ url: `/api/templates/${type}`, ...as("operator") });
      expect(res.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
      expect((wb.getWorksheet("PANs")!.getRow(1).values as unknown[]).slice(1)).toEqual(cols);
      expect(wb.getWorksheet("PANs")!.rowCount).toBe(1); // headers only — no sample rows to import by mistake
    }
    expect((await app.inject({ url: "/api/templates/nope", ...as("operator") })).statusCode).toBe(404);
  });

  it("behind IIS (HTTPS): Secure cookie and the real client IP in the audit log", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login",
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
      payload: { email: "operator@e2e.test", password: "e2e-password-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === "aca_token")!.secure).toBe(true);
    // IIS appends the real client IP last; a client-supplied first entry ("6.6.6.6") is ignored.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "auth.login" }, orderBy: { id: "desc" } });
    expect(log.ip).toBe("203.0.113.9");
    // Plain local access still works without Secure.
    const local = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "operator@e2e.test", password: "e2e-password-123" } });
    expect(local.cookies.find((c) => c.name === "aca_token")!.secure).toBeFalsy();
  });

  it("admins can edit users: name, username, role and password", async () => {
    const opUser = await prisma.user.findFirstOrThrow({ where: { email: "operator@e2e.test" } });
    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: "admin@e2e.test" } });

    expect((await app.inject({ method: "PATCH", url: `/api/users/${opUser.id}`, ...as("operator"), payload: { name: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/users/${opUser.id}`, ...as("admin"), payload: { email: "admin@e2e.test" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/api/users/${adminUser.id}`, ...as("admin"), payload: { role: "OPERATOR" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/users/${opUser.id}`, ...as("admin"), payload: { password: "short" } })).statusCode).toBe(400);

    const res = await app.inject({ method: "PATCH", url: `/api/users/${opUser.id}`, ...as("admin"),
      payload: { name: "Op Renamed", email: "Op.Renamed", role: "ADMIN", password: "new-password-456" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ name: "Op Renamed", email: "op.renamed", role: "ADMIN" });
    expect(JSON.stringify(res.json())).not.toContain("passwordHash");

    // New username + password work; the old ones don't.
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "op.renamed", password: "new-password-456" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "operator@e2e.test", password: "e2e-password-123" } })).statusCode).toBe(401);
    expect(await prisma.auditLog.count({ where: { action: "user.update", entityId: String(opUser.id) } })).toBeGreaterThanOrEqual(1);

    // Put things back for any later tests.
    await app.inject({ method: "PATCH", url: `/api/users/${opUser.id}`, ...as("admin"),
      payload: { name: "Op", email: "operator@e2e.test", role: "OPERATOR", password: "e2e-password-123" } });
  });

  it("anyone signed in can trigger the scheduler manually", async () => {
    expect((await app.inject({ method: "POST", url: "/api/scheduler/run", ...as("operator") })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/scheduler/run", ...as("admin") })).statusCode).toBe(200);
  });
});
