import type { FastifyInstance, FastifyReply } from "fastify";
import type { AllotmentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin, requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { CHECK_SCOPES, createCheckJob } from "../services/checkJobs.js";
import { ipoWorkbook, type IpoExportRow } from "../services/excel.js";

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
  autoCheck: z.boolean().optional(),
  archived: z.boolean().optional(),
});
/** Operators may set dates and auto-check; renaming and archiving are admin-only. */
const ADMIN_ONLY_FIELDS = ["name", "archived"] as const;

const STATUSES = ["ALLOTTED", "NOT_ALLOTTED", "NOT_APPLIED", "ERROR"] as const;

const resultsQuery = z.object({
  status: z.enum([...STATUSES, "PENDING"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

const checkBody = z.object({ scope: z.enum(CHECK_SCOPES).default("unchecked") });
export const fullPanQuery = z.object({ fullPan: z.enum(["true", "false"]).default("false") });

/** Sends an .xlsx download with a safe file name, e.g. "Paras Healthcare allotment 2026-10-28.xlsx". */
export function sendXlsx(reply: FastifyReply, baseName: string, buf: Buffer) {
  const name = `${baseName.replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80)} ${new Date().toISOString().slice(0, 10)}.xlsx`;
  return reply
    .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .header("Content-Disposition", `attachment; filename="${name}"`)
    .header("Cache-Control", "no-store")
    .send(buf);
}

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

  app.patch("/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    if (req.currentUser!.role !== "ADMIN" && ADMIN_ONLY_FIELDS.some((f) => body[f] !== undefined)) {
      return reply.code(403).send({ error: "Only admins can rename or archive IPOs" });
    }
    if (!(await app.prisma.ipo.findUnique({ where: { id } }))) return reply.code(404).send({ error: "IPO not found" });
    const ipo = await app.prisma.ipo.update({
      where: { id },
      data: { ...body, allotmentDate: toDate(body.allotmentDate), listingDate: toDate(body.listingDate) },
    });
    await audit(req, "ipo.update", { entity: "Ipo", entityId: id, details: { changed: Object.keys(body) } });
    return { ipo };
  });

  /** PAN filter shared by the results table and its Excel export. */
  function resultsPanWhere(id: number, { status, clientId, q }: { status?: string; clientId?: number; q?: string }) {
    const where: Prisma.PanWhereInput = { active: true };
    if (clientId) where.clientId = clientId;
    if (status === "PENDING") where.results = { none: { ipoId: id } };
    else if (status) where.results = { some: { ipoId: id, status: status as AllotmentStatus } };
    if (q) {
      where.OR = [
        { holderName: { contains: q, mode: "insensitive" } },
        { client: { name: { contains: q, mode: "insensitive" } } },
      ];
    }
    return where;
  }

  /** Every active PAN with its result for this IPO (PENDING if not checked yet). */
  app.get("/:id/results", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { page, pageSize, ...filters } = resultsQuery.parse(req.query);
    if (!(await app.prisma.ipo.findUnique({ where: { id } }))) return reply.code(404).send({ error: "IPO not found" });
    const where = resultsPanWhere(id, filters);

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

  /** Excel download of the results table (same filters). Full PANs: admins only, audited. */
  app.get("/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { page: _p, pageSize: _s, ...filters } = resultsQuery.parse(req.query);
    const { fullPan } = fullPanQuery.parse(req.query);
    if (fullPan === "true" && req.currentUser!.role !== "ADMIN") return reply.code(403).send({ error: "Only admins can export full PANs" });
    const ipo = await app.prisma.ipo.findUnique({ where: { id } });
    if (!ipo) return reply.code(404).send({ error: "IPO not found" });

    const pans = await app.prisma.pan.findMany({
      where: resultsPanWhere(id, filters),
      orderBy: [{ client: { name: "asc" } }, { holderName: "asc" }],
      select: {
        panMasked: true,
        panEncrypted: true,
        holderName: true,
        client: { select: { name: true } },
        results: { where: { ipoId: id }, omit: { raw: true } },
      },
    });
    const rows: IpoExportRow[] = pans.map((p) => {
      const r = p.results[0];
      return {
        clientName: p.client.name,
        holderName: p.holderName,
        pan: fullPan === "true" ? app.vault.open(p.panEncrypted) : p.panMasked,
        status: r?.status ?? "PENDING",
        appliedQty: r?.appliedQty ?? null,
        allottedQty: r?.allottedQty ?? null,
        category: r?.category ?? null,
        price: r?.price == null ? null : Number(r.price),
        amountAdjusted: r?.amountAdjusted == null ? null : Number(r.amountAdjusted),
        checkedAt: r?.checkedAt ?? null,
        message: r?.message ?? null,
      };
    });

    const buf = await ipoWorkbook(ipo, app.registry.get(ipo.registrar)?.name ?? ipo.registrar, await counts(id), rows);
    await audit(req, "export.ipo", { entity: "Ipo", entityId: id, details: { rows: rows.length, fullPan: fullPan === "true", ...filters } });
    return sendXlsx(reply, `${ipo.name} allotment`, buf);
  });

  app.post("/:id/check", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { scope } = checkBody.parse(req.body ?? {});
    const ipo = await app.prisma.ipo.findUnique({ where: { id } });
    if (!ipo) return reply.code(404).send({ error: "IPO not found" });

    const r = await createCheckJob(app.prisma, app.runner, ipo, scope, { userId: req.currentUser!.id });
    if (!r.ok && r.reason === "running") return reply.code(409).send({ error: "A check is already running for this IPO", job: r.job });
    if (!r.ok) return reply.code(400).send({ error: "No PANs to check for this selection" });
    await audit(req, "ipo.check", { entity: "Ipo", entityId: id, details: { jobId: r.job.id, scope, total: r.job.total } });
    return reply.code(202).send({ job: r.job });
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
