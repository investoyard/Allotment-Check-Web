import type { FastifyInstance } from "fastify";
import type { AllotmentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin, requireLogin } from "../auth.js";
import { audit } from "../audit.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const dateField = z.iso.date().nullable().optional();

const createBody = z.object({
  registrar: z.string().min(1),
  registrarIpoId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  isSme: z.boolean().optional(),
  allotmentDate: dateField,
  listingDate: dateField,
});

const updateBody = z.object({
  name: z.string().trim().min(1).optional(),
  allotmentDate: dateField,
  listingDate: dateField,
  archived: z.boolean().optional(),
});

const STATUSES = ["ALLOTTED", "NOT_ALLOTTED", "NOT_APPLIED", "ERROR"] as const;

const resultsQuery = z.object({
  status: z.enum([...STATUSES, "PENDING"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

const checkBody = z.object({ scope: z.enum(["all", "unchecked", "errors"]).default("unchecked") });

const toDate = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`));

export async function ipoRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireLogin);

  /** Status counts for an IPO across currently active PANs. Unchecked PANs count as PENDING. */
  async function counts(ipoId: number) {
    const [activePans, grouped] = await Promise.all([
      app.prisma.pan.count({ where: { active: true } }),
      app.prisma.checkResult.groupBy({ by: ["status"], where: { ipoId, pan: { active: true } }, _count: true }),
    ]);
    const c: Record<AllotmentStatus | "PENDING", number> = { ALLOTTED: 0, NOT_ALLOTTED: 0, NOT_APPLIED: 0, ERROR: 0, PENDING: 0 };
    for (const g of grouped) c[g.status] = g._count;
    c.PENDING = Math.max(0, activePans - STATUSES.reduce((t, s) => t + c[s], 0));
    const allottedQty = await app.prisma.checkResult.aggregate({
      where: { ipoId, status: "ALLOTTED", pan: { active: true } },
      _sum: { allottedQty: true },
    });
    return { ...c, totalPans: activePans, allottedShares: allottedQty._sum.allottedQty ?? 0 };
  }

  const latestJob = (ipoId: number) => app.prisma.checkJob.findFirst({ where: { ipoId }, orderBy: { id: "desc" } });

  app.get("/", async (req) => {
    const { archived } = z.object({ archived: z.enum(["true", "false"]).default("false") }).parse(req.query);
    const ipos = await app.prisma.ipo.findMany({
      where: { archived: archived === "true" },
      orderBy: [{ allotmentDate: { sort: "desc", nulls: "first" } }, { id: "desc" }],
    });
    return { ipos: await Promise.all(ipos.map(async (i) => ({ ...i, counts: await counts(i.id), job: await latestJob(i.id) }))) };
  });

  app.get("/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const ipo = await app.prisma.ipo.findUnique({ where: { id } });
    if (!ipo) return reply.code(404).send({ error: "IPO not found" });
    return { ipo: { ...ipo, counts: await counts(id), job: await latestJob(id) } };
  });

  app.post("/", async (req, reply) => {
    const body = createBody.parse(req.body);
    if (!app.registry.has(body.registrar)) return reply.code(400).send({ error: `Unknown registrar "${body.registrar}"` });
    const existing = await app.prisma.ipo.findUnique({
      where: { registrar_registrarIpoId: { registrar: body.registrar, registrarIpoId: body.registrarIpoId } },
    });
    if (existing) return reply.code(409).send({ error: "This IPO is already being tracked", ipo: existing });
    const ipo = await app.prisma.ipo.create({
      data: {
        ...body,
        isSme: body.isSme ?? /\bSME\b/i.test(body.name),
        allotmentDate: toDate(body.allotmentDate),
        listingDate: toDate(body.listingDate),
      },
    });
    await audit(req, "ipo.create", { entity: "Ipo", entityId: ipo.id, details: { name: ipo.name, registrar: ipo.registrar } });
    return reply.code(201).send({ ipo });
  });

  app.patch("/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    if (!(await app.prisma.ipo.findUnique({ where: { id } }))) return reply.code(404).send({ error: "IPO not found" });
    const ipo = await app.prisma.ipo.update({
      where: { id },
      data: { ...body, allotmentDate: toDate(body.allotmentDate), listingDate: toDate(body.listingDate) },
    });
    await audit(req, "ipo.update", { entity: "Ipo", entityId: id, details: { changed: Object.keys(body) } });
    return { ipo };
  });

  /** Every active PAN with its result for this IPO (PENDING if not checked yet). */
  app.get("/:id/results", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { status, clientId, q, page, pageSize } = resultsQuery.parse(req.query);
    if (!(await app.prisma.ipo.findUnique({ where: { id } }))) return reply.code(404).send({ error: "IPO not found" });

    const where: Prisma.PanWhereInput = { active: true };
    if (clientId) where.clientId = clientId;
    if (status === "PENDING") where.results = { none: { ipoId: id } };
    else if (status) where.results = { some: { ipoId: id, status } };
    if (q) {
      where.OR = [
        { holderName: { contains: q, mode: "insensitive" } },
        { client: { name: { contains: q, mode: "insensitive" } } },
      ];
    }

    const [total, pans] = await Promise.all([
      app.prisma.pan.count({ where }),
      app.prisma.pan.findMany({
        where,
        orderBy: [{ client: { name: "asc" } }, { holderName: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          panMasked: true,
          holderName: true,
          client: { select: { id: true, name: true } },
          results: { where: { ipoId: id }, omit: { raw: true } },
        },
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      rows: pans.map(({ results, ...p }) => ({ ...p, result: results[0] ?? null })),
    };
  });

  app.post("/:id/check", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { scope } = checkBody.parse(req.body ?? {});
    const ipo = await app.prisma.ipo.findUnique({ where: { id } });
    if (!ipo) return reply.code(404).send({ error: "IPO not found" });

    const running = await app.prisma.checkJob.findFirst({ where: { ipoId: id, state: { in: ["QUEUED", "RUNNING"] } } });
    if (running) return reply.code(409).send({ error: "A check is already running for this IPO", job: running });

    const where: Prisma.PanWhereInput = { active: true };
    if (scope === "unchecked") where.results = { none: { ipoId: id } };
    // NOT_APPLIED is included: registrars sometimes publish data in batches on allotment day.
    if (scope === "errors") where.results = { some: { ipoId: id, status: { in: ["ERROR", "NOT_APPLIED"] } } };
    const pans = await app.prisma.pan.findMany({ where, select: { id: true }, orderBy: { id: "asc" } });
    if (!pans.length) return reply.code(400).send({ error: "No PANs to check for this selection" });

    const job = await app.prisma.checkJob.create({
      data: { ipoId: id, scope, panIds: pans.map((p) => p.id), total: pans.length, createdById: req.currentUser!.id },
    });
    app.runner.enqueue(job.id, ipo.registrar);
    await audit(req, "ipo.check", { entity: "Ipo", entityId: id, details: { jobId: job.id, scope, total: job.total } });
    return reply.code(202).send({ job });
  });
}

export async function jobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireLogin);

  app.get("/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await app.prisma.checkJob.findUnique({ where: { id }, omit: { panIds: true } });
    return job ? { job } : reply.code(404).send({ error: "Job not found" });
  });

  app.post("/:id/cancel", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await app.prisma.checkJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job not found" });
    await app.runner.cancel(id);
    await audit(req, "job.cancel", { entity: "CheckJob", entityId: id });
    return { ok: true };
  });
}

export async function registrarRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireLogin);

  app.get("/", async () => ({
    registrars: [...app.registry.values()].map((r) => ({ id: r.id, name: r.name })),
  }));

  /** IPOs the registrar currently lists for status checks, flagged if already tracked here. */
  app.get("/:id/ipos", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const adapter = app.registry.get(id);
    if (!adapter) return reply.code(404).send({ error: "Unknown registrar" });
    let live;
    try {
      live = await adapter.listIpos();
    } catch (err) {
      req.log.warn({ err, registrar: id }, "registrar IPO list failed");
      return reply.code(502).send({ error: `${adapter.name} didn't respond. Try again in a minute.` });
    }
    const tracked = await app.prisma.ipo.findMany({
      where: { registrar: id, registrarIpoId: { in: live.map((l) => l.registrarIpoId) } },
      select: { id: true, registrarIpoId: true },
    });
    const trackedId = new Map(tracked.map((t) => [t.registrarIpoId, t.id]));
    return { ipos: live.map((l) => ({ ...l, trackedIpoId: trackedId.get(l.registrarIpoId) ?? null }) ) };
  });
}
