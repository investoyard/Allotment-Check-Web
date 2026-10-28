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
    app = await buildApp({ ...loadConfig(), DATABASE_URL: url, LOG_LEVEL: "silent" }, { prisma, registry: createRegistry([fake, late]) });
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

  it("operators can't import or reveal; admins can reveal (audited)", async () => {
    const op = await app.inject({ method: "POST", url: "/api/pans/import", ...as("operator"), ...multipart("pans.csv", CSV) });
    expect(op.statusCode).toBe(403);
    const pan = await prisma.pan.findFirstOrThrow({ where: { holderName: "Holder One" } });
    expect((await app.inject({ url: `/api/pans/${pan.id}/reveal`, ...as("operator") })).statusCode).toBe(403);
    const reveal = await app.inject({ url: `/api/pans/${pan.id}/reveal`, ...as("admin") });
    expect(reveal.json().pan).toBe("AAAPA0001A");
    expect(await prisma.auditLog.count({ where: { action: "pan.reveal" } })).toBe(1);
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

  it("exports IPO results; full PANs only for admins", async () => {
    const op = await app.inject({ url: `/api/ipos/${ipoId}/export`, ...as("operator") });
    expect(op.statusCode).toBe(200);
    expect(op.headers["content-disposition"]).toMatch(/attachment; filename="Fake Ltd - IPO allotment \d{4}-\d{2}-\d{2}\.xlsx"/);
    const wb = await readXlsx(op.rawPayload);
    const pans = wb.getWorksheet("Results")!.getColumn(3).values.slice(2);
    expect(pans.every((p) => String(p).includes("****"))).toBe(true);

    expect((await app.inject({ url: `/api/ipos/${ipoId}/export?fullPan=true`, ...as("operator") })).statusCode).toBe(403);
    const full = await readXlsx((await app.inject({ url: `/api/ipos/${ipoId}/export?fullPan=true`, ...as("admin") })).rawPayload);
    expect(full.getWorksheet("Results")!.getColumn(3).values).toContain("AAAPA0001A");
    expect(await prisma.auditLog.count({ where: { action: "export.ipo" } })).toBe(2);
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

  it("operators can set dates and auto-check, but not archive", async () => {
    const ok = await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { allotmentDate: today, autoCheck: false } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ipo).toMatchObject({ autoCheck: false });
    expect((await app.inject({ method: "PATCH", url: `/api/ipos/${ipoId}`, ...as("operator"), payload: { archived: true } })).statusCode).toBe(403);
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

  it("only admins can trigger the scheduler manually", async () => {
    expect((await app.inject({ method: "POST", url: "/api/scheduler/run", ...as("operator") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/scheduler/run", ...as("admin") })).statusCode).toBe(200);
  });
});
