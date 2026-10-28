import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Registry } from "../registrars/index.js";
import { RetryableError, summarize, type CheckResult, type RegistrarAdapter } from "../registrars/types.js";
import type { PanVault } from "./panVault.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.5);

export const RETRY_BACKOFF_MS = [3_000, 10_000, 30_000];
const MAX_CRASH_RETRIES = 3;
const CRASH_RETRY_MS = 2_000;

// Connection/engine-level Prisma failures that are worth retrying. Data errors (bad input,
// constraint violations) are not.
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"]);
export function isTransientDbError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; constructor?: { name?: string } };
  const name = e?.constructor?.name ?? e?.name;
  if (name === "PrismaClientUnknownRequestError" || name === "PrismaClientInitializationError") return true;
  return name === "PrismaClientKnownRequestError" && !!e.code && TRANSIENT_CODES.has(e.code);
}

/** Runs one check, retrying transient failures. Never throws — failures become ERROR results. */
export async function checkWithRetry(
  adapter: RegistrarAdapter,
  registrarIpoId: string,
  pan: string,
  opts: { backoffMs?: number[]; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<{ result: CheckResult; attempts: number }> {
  const backoff = opts.backoffMs ?? RETRY_BACKOFF_MS;
  const wait = opts.sleepFn ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return { result: await adapter.check(registrarIpoId, pan), attempts: attempt };
    } catch (err) {
      const retryable = err instanceof RetryableError;
      if (!retryable || attempt > backoff.length) {
        // Error text from adapters never contains the PAN, but scrub it to be safe.
        const message = ((err as Error).message || "Unknown error").replaceAll(pan, "**********");
        return { result: { ...summarize([]), status: "ERROR", message }, attempts: attempt };
      }
      // If the registrar said how long to wait, wait at least that long.
      await wait(Math.max(backoff[attempt - 1]!, (err as RetryableError).retryAfterMs ?? 0));
    }
  }
}

/**
 * In-process job queue. Jobs for the same registrar run one at a time (so we never hammer
 * a registrar); jobs for different registrars run in parallel. Progress lives in the DB, so a
 * restart resumes where it left off.
 */
export class JobRunner {
  private queues = new Map<string, number[]>();
  private active = new Set<string>();
  private cancelled = new Set<number>();
  private stopping = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly vault: PanVault,
    private readonly registry: Registry,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Re-queues jobs that were queued or running when the server last stopped. */
  async resume() {
    const jobs = await this.prisma.checkJob.findMany({
      where: { state: { in: ["QUEUED", "RUNNING"] } },
      include: { ipo: true },
      orderBy: { id: "asc" },
    });
    for (const j of jobs) this.enqueue(j.id, j.ipo.registrar);
    if (jobs.length) this.log.info({ jobs: jobs.map((j) => j.id) }, "resumed check jobs");
  }

  enqueue(jobId: number, registrar: string) {
    const q = this.queues.get(registrar) ?? [];
    if (!q.includes(jobId)) q.push(jobId);
    this.queues.set(registrar, q);
    void this.drain(registrar);
  }

  async cancel(jobId: number) {
    let wasQueued = false;
    for (const q of this.queues.values()) {
      const i = q.indexOf(jobId);
      if (i >= 0) {
        q.splice(i, 1);
        wasQueued = true;
      }
    }
    // Only a job that's (about to be) running needs the in-memory flag; a queued one is just dropped.
    if (!wasQueued) this.cancelled.add(jobId);
    await this.prisma.checkJob.updateMany({
      where: { id: jobId, state: { in: ["QUEUED", "RUNNING"] } },
      data: { state: "CANCELLED", finishedAt: new Date() },
    });
  }

  /** Stops picking up work and waits (up to `timeoutMs`) for in-flight steps to finish. */
  async stop(timeoutMs = 15_000) {
    this.stopping = true;
    const until = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < until) await sleep(50);
  }

  private crashRetries = new Map<number, number>();

  private async drain(registrar: string) {
    if (this.active.has(registrar)) return;
    this.active.add(registrar);
    try {
      const q = this.queues.get(registrar)!;
      while (q.length && !this.stopping) {
        const jobId = q.shift()!;
        try {
          await this.run(jobId);
          this.crashRetries.delete(jobId);
        } catch (err) {
          if (this.stopping) return; // shutting down: the job stays queued/running and resumes on next start
          const retries = this.crashRetries.get(jobId) ?? 0;
          if (isTransientDbError(err) && retries < MAX_CRASH_RETRIES) {
            // A database blip shouldn't leave a job stuck: try again shortly. Progress is in the DB,
            // so the job carries on from the last PAN it recorded.
            this.crashRetries.set(jobId, retries + 1);
            this.log.warn({ err, jobId, retry: retries + 1 }, "check job hit a database error; retrying");
            await sleep(CRASH_RETRY_MS);
            q.unshift(jobId);
            continue;
          }
          this.crashRetries.delete(jobId);
          this.log.error({ err, jobId }, "check job crashed");
          await this.prisma.checkJob
            .update({ where: { id: jobId }, data: { state: "FAILED", error: (err as Error).message, finishedAt: new Date() } })
            .catch(() => {});
        }
      }
    } finally {
      this.active.delete(registrar);
    }
  }

  private async run(jobId: number) {
    const job = await this.prisma.checkJob.findUnique({ where: { id: jobId }, include: { ipo: true } });
    if (!job || job.state === "CANCELLED" || job.state === "DONE") return;
    const adapter = this.registry.get(job.ipo.registrar);
    if (!adapter) throw new Error(`No adapter for registrar "${job.ipo.registrar}"`);

    // Conditional updates: a cancel can land between our read and this write, and must win.
    const live = { id: jobId, state: { in: ["QUEUED" as const, "RUNNING" as const] } };
    const started = await this.prisma.checkJob.updateMany({
      where: live,
      data: { state: "RUNNING", startedAt: job.startedAt ?? new Date() },
    });
    if (!started.count) return;
    this.log.info({ jobId, ipo: job.ipo.name, total: job.total, from: job.done }, "check job started");

    let { done, failed } = job;
    // `done` counts processed PANs, so a resumed job picks up where it stopped.
    for (const panId of job.panIds.slice(done)) {
      if (this.stopping) return; // stays RUNNING → resumed on next start
      if (this.cancelled.has(jobId)) {
        this.cancelled.delete(jobId);
        await this.prisma.checkJob.updateMany({ where: live, data: { state: "CANCELLED", finishedAt: new Date() } });
        return;
      }

      const pan = await this.prisma.pan.findUnique({ where: { id: panId } });
      if (pan) {
        const started = Date.now();
        const { result, attempts } = await checkWithRetry(adapter, job.ipo.registrarIpoId, this.vault.open(pan.panEncrypted));
        await this.saveResult(job.ipoId, panId, result, attempts);
        if (result.status === "ERROR") failed++;
        await sleep(Math.max(0, jitter(adapter.minDelayMs) - (Date.now() - started)));
      }
      done++;
      await this.prisma.checkJob.update({ where: { id: jobId }, data: { done, failed } });
    }

    const finished = await this.prisma.checkJob.updateMany({ where: live, data: { state: "DONE", finishedAt: new Date() } });
    this.cancelled.delete(jobId);
    if (finished.count) this.log.info({ jobId, done, failed }, "check job finished");
  }

  private async saveResult(ipoId: number, panId: number, r: CheckResult, attempts: number) {
    const data = {
      status: r.status,
      appliedQty: r.appliedQty,
      allottedQty: r.allottedQty,
      category: r.category,
      applicantName: r.applicantName,
      price: r.price,
      amountAdjusted: r.amountAdjusted,
      message: r.message,
      raw: r.rows as unknown as Prisma.InputJsonValue,
      checkedAt: new Date(),
    };
    await this.prisma.checkResult.upsert({
      where: { ipoId_panId: { ipoId, panId } },
      create: { ipoId, panId, attempts, ...data },
      update: { ...data, attempts: { increment: attempts } },
    });
  }
}
