import type { Ipo, Prisma, PrismaClient } from "@prisma/client";
import type { JobRunner } from "./jobRunner.js";

export type CheckScope = "all" | "unchecked" | "errors" | "failed";
export const CHECK_SCOPES = ["all", "unchecked", "errors", "failed"] as const;

export function scopeWhere(ipoId: number, scope: CheckScope): Prisma.PanWhereInput {
  const where: Prisma.PanWhereInput = { active: true };
  if (scope === "unchecked") where.results = { none: { ipoId } };
  // NOT_APPLIED is included: registrars sometimes publish data in batches on allotment day.
  if (scope === "errors") where.results = { some: { ipoId, status: { in: ["ERROR", "NOT_APPLIED"] } } };
  if (scope === "failed") where.results = { some: { ipoId, status: "ERROR" } };
  return where;
}

export type CreateJobResult =
  | { ok: true; job: Awaited<ReturnType<PrismaClient["checkJob"]["create"]>> }
  | { ok: false; reason: "running" | "empty"; job?: unknown };

/** Creates and queues a check job unless one is already active or there's nothing to check. */
export async function createCheckJob(
  prisma: PrismaClient,
  runner: JobRunner,
  ipo: Ipo,
  scope: CheckScope,
  opts: {
    userId?: number | null;
    trigger?: "manual" | "auto" | "import";
    /** Instead of refusing when a job is active, queue a follow-up for PANs that job doesn't cover. */
    queueBehindActive?: boolean;
  } = {},
): Promise<CreateJobResult> {
  const active = await prisma.checkJob.findMany({ where: { ipoId: ipo.id, state: { in: ["QUEUED", "RUNNING"] } } });
  if (active.length && !opts.queueBehindActive) return { ok: false, reason: "running", job: active[0] };
  const covered = new Set(active.flatMap((j) => j.panIds));

  const pans = (await prisma.pan.findMany({ where: scopeWhere(ipo.id, scope), select: { id: true }, orderBy: { id: "asc" } }))
    .filter((p) => !covered.has(p.id));
  if (!pans.length) return { ok: false, reason: "empty" };

  const job = await prisma.checkJob.create({
    data: {
      ipoId: ipo.id,
      scope,
      trigger: opts.trigger ?? "manual",
      panIds: pans.map((p) => p.id),
      total: pans.length,
      createdById: opts.userId ?? null,
    },
  });
  runner.enqueue(job.id, ipo.registrar);
  return { ok: true, job };
}
