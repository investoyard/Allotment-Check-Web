import type { FastifyBaseLogger } from "fastify";
import type { CheckJob, Ipo, PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import type { Registry } from "../registrars/index.js";
import { createCheckJob, type CheckScope } from "./checkJobs.js";
import { checkWithRetry, type JobRunner } from "./jobRunner.js";
import type { PanVault } from "./panVault.js";

// Allotment-day automation. For each IPO with auto-check on and an allotment date of today or
// yesterday (IST), every tick decides one of: start a job, probe a sample, or wait.

export const PROBE_SAMPLE = 10;
export const PROBE_EVERY_MIN = 30;
export const ERROR_RETRY_GAP_MIN = 15;
export const MAX_AUTO_ERROR_RETRIES = 3;
const MIN = 60_000;

/** "YYYY-MM-DD" and hour (0–23) of `now` in India time. */
export function istParts(now: Date): { date: string; hour: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** True when the IPO's allotment date is today or yesterday (IST) — yesterday catches late publishing. */
export function inAllotmentWindow(allotmentDate: Date | null, today: string): boolean {
  if (!allotmentDate) return false;
  const d = allotmentDate.toISOString().slice(0, 10);
  return d === today || d === addDays(today, -1);
}

export interface IpoState {
  activeJob: boolean;
  unchecked: number;
  /** ALLOTTED + NOT_ALLOTTED — applications the registrar actually returned */
  found: number;
  errors: number;
  lastAutoJob: Pick<CheckJob, "finishedAt" | "createdAt"> | null;
  /** Auto "failed"-scope jobs since the allotment date */
  autoErrorRetries: number;
  lastProbeAt: Date | null;
}

export type Decision =
  | { action: "wait"; reason: string }
  | { action: "job"; scope: CheckScope; reason: string }
  | { action: "probe"; reason: string };

/** Pure decision logic, so it can be tested without a database or a clock. */
export function decide(s: IpoState, now: Date): Decision {
  if (s.activeJob) return { action: "wait", reason: "Check in progress" };
  if (s.unchecked > 0) return { action: "job", scope: "unchecked", reason: `Checking ${s.unchecked} unchecked PANs` };

  if (s.found === 0) {
    // Everything came back "not applied" (or errored): the registrar probably hasn't published yet.
    // Probe a small sample instead of re-checking every PAN.
    const since = s.lastProbeAt ? now.getTime() - s.lastProbeAt.getTime() : Infinity;
    if (since < PROBE_EVERY_MIN * MIN) {
      const next = new Date(s.lastProbeAt!.getTime() + PROBE_EVERY_MIN * MIN);
      return { action: "wait", reason: `Waiting for registrar data — next probe ${next.toISOString()}` };
    }
    return { action: "probe", reason: "No applications found yet — probing a sample" };
  }

  if (s.errors > 0) {
    if (s.autoErrorRetries >= MAX_AUTO_ERROR_RETRIES) return { action: "wait", reason: `Done — ${s.errors} errors left after ${MAX_AUTO_ERROR_RETRIES} retries` };
    const last = s.lastAutoJob?.finishedAt ?? s.lastAutoJob?.createdAt;
    if (last && now.getTime() - last.getTime() < ERROR_RETRY_GAP_MIN * MIN) return { action: "wait", reason: `Retrying ${s.errors} errors shortly` };
    return { action: "job", scope: "failed", reason: `Retrying ${s.errors} errors` };
  }
  return { action: "wait", reason: "Done" };
}

export interface ScheduleEntry {
  ipoId: number;
  name: string;
  registrar: string;
  allotmentDate: string;
  decision: Decision;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  lastTick: { at: Date; entries: ScheduleEntry[]; outsideHours: boolean } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: Registry,
    private readonly runner: JobRunner,
    private readonly vault: PanVault,
    private readonly config: Pick<Config, "SCHEDULER_INTERVAL_MIN" | "SCHEDULER_START_HOUR" | "SCHEDULER_END_HOUR">,
    private readonly log: FastifyBaseLogger,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.SCHEDULER_INTERVAL_MIN * MIN);
    void this.tick();
    this.log.info({ everyMin: this.config.SCHEDULER_INTERVAL_MIN }, "allotment scheduler started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async ipoState(ipo: Ipo): Promise<IpoState> {
    const since = ipo.allotmentDate ?? ipo.createdAt;
    const [active, activePans, grouped, lastAutoJob, autoErrorRetries] = await Promise.all([
      this.prisma.checkJob.count({ where: { ipoId: ipo.id, state: { in: ["QUEUED", "RUNNING"] } } }),
      this.prisma.pan.count({ where: { active: true } }),
      this.prisma.checkResult.groupBy({ by: ["status"], where: { ipoId: ipo.id, pan: { active: true } }, _count: true }),
      this.prisma.checkJob.findFirst({ where: { ipoId: ipo.id, trigger: "auto" }, orderBy: { id: "desc" } }),
      this.prisma.checkJob.count({ where: { ipoId: ipo.id, trigger: "auto", scope: "failed", createdAt: { gte: since } } }),
    ]);
    const n = (s: string) => grouped.find((g) => g.status === s)?._count ?? 0;
    const checked = grouped.reduce((t, g) => t + g._count, 0);
    return {
      activeJob: active > 0,
      unchecked: Math.max(0, activePans - checked),
      found: n("ALLOTTED") + n("NOT_ALLOTTED"),
      errors: n("ERROR"),
      lastAutoJob,
      autoErrorRetries,
      lastProbeAt: ipo.lastProbeAt,
    };
  }

  /** Works out what to do for every IPO in today's window. Read-only. */
  async plan(now = new Date()): Promise<{ ipo: Ipo; decision: Decision }[]> {
    const { date } = istParts(now);
    const ipos = await this.prisma.ipo.findMany({
      where: {
        archived: false,
        autoCheck: true,
        allotmentDate: { gte: new Date(`${addDays(date, -1)}T00:00:00Z`), lte: new Date(`${date}T00:00:00Z`) },
      },
      orderBy: { id: "asc" },
    });
    const out = [];
    for (const ipo of ipos) {
      if (!inAllotmentWindow(ipo.allotmentDate, date)) continue;
      if (!this.registry.has(ipo.registrar)) continue;
      out.push({ ipo, decision: decide(await this.ipoState(ipo), now) });
    }
    return out;
  }

  /** One scheduler pass. Safe to call any time; overlapping calls are skipped. */
  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { hour } = istParts(now);
      const outsideHours = hour < this.config.SCHEDULER_START_HOUR || hour >= this.config.SCHEDULER_END_HOUR;
      const planned = await this.plan(now);
      const entries: ScheduleEntry[] = [];
      for (const { ipo, decision } of planned) {
        let d = decision;
        if (outsideHours && d.action !== "wait") {
          d = { action: "wait", reason: `Outside checking hours (${this.config.SCHEDULER_START_HOUR}:00–${this.config.SCHEDULER_END_HOUR}:00 IST)` };
        } else if (d.action === "job") {
          const r = await createCheckJob(this.prisma, this.runner, ipo, d.scope, { trigger: "auto" });
          if (r.ok) this.log.info({ ipo: ipo.name, scope: d.scope, total: r.job.total }, "scheduler started check");
        } else if (d.action === "probe") {
          d = await this.probe(ipo);
        }
        entries.push({ ipoId: ipo.id, name: ipo.name, registrar: ipo.registrar, allotmentDate: ipo.allotmentDate!.toISOString().slice(0, 10), decision: d });
      }
      this.lastTick = { at: now, entries, outsideHours };
    } catch (err) {
      this.log.error({ err }, "scheduler tick failed");
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Checks a random sample of PANs directly. If any application turns up, the registrar has
   * published, so queue a full re-check; otherwise wait for the next probe.
   */
  private async probe(ipo: Ipo): Promise<Decision> {
    const adapter = this.registry.get(ipo.registrar)!;
    await this.prisma.ipo.update({ where: { id: ipo.id }, data: { lastProbeAt: new Date() } });
    const sample = await this.prisma.$queryRaw<{ id: number; panEncrypted: string }[]>`
      SELECT id, "panEncrypted" FROM "Pan" WHERE active = true ORDER BY random() LIMIT ${PROBE_SAMPLE}`;
    let found = 0;
    for (const p of sample) {
      const { result } = await checkWithRetry(adapter, ipo.registrarIpoId, this.vault.open(p.panEncrypted));
      if (result.status === "ALLOTTED" || result.status === "NOT_ALLOTTED") found++;
      await new Promise((r) => setTimeout(r, adapter.minDelayMs));
    }
    if (!found) return { action: "wait", reason: `Probed ${sample.length} PANs — registrar hasn't published yet` };
    const r = await createCheckJob(this.prisma, this.runner, ipo, "all", { trigger: "auto" });
    this.log.info({ ipo: ipo.name, found }, "probe found applications; re-checking all PANs");
    return r.ok
      ? { action: "job", scope: "all", reason: `Registrar data is out (${found}/${sample.length} found in probe) — re-checking all PANs` }
      : { action: "wait", reason: "Registrar data is out; a check is already running" };
  }
}
