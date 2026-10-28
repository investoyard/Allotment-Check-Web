import type { FastifyInstance, FastifyReply } from "fastify";
import type { AllotmentStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin, requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { CHECK_SCOPES, createCheckJob } from "../services/checkJobs.js";
import { ipoWorkbook, type IpoExportRow } from "../services/excel.js";
import { listingGain } from "../services/reports.js";
import type { IpoRef } from "../registrars/types.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const dateField = z.iso.date().nullable().optional();
const priceField = z.number().positive().max(1e7).nullable().optional();

const createBody = z.object({
  registrar: z.string().min(1),
  registrarIpoId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  isSme: z.boolean().optional(),
  allotmentDate: dateField,
  listingDate: dateField,
  issuePrice: priceField,
});

const updateBody = z.object({
  name: z.string().trim().min(1).optional(),
  allotmentDate: dateField,
  listingDate: dateField,
  issuePrice: priceField,
  listingPrice: priceField,
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
  const num = (d: { toString(): string } | null | undefined) => (d == null ? null : Number(d));

  /** Total listing gain across allotted, active PANs; null until a listing price is entered. */
  async function ipoListingGain(ipo: { id: number; issuePrice: unknown; listingPrice: unknown }) {
    if (ipo.listingPrice == null) return null;
    const allotted = await app.prisma.checkResult.findMany({
      where: { ipoId: ipo.id, status: "ALLOTTED", pan: { active: true } },
      select: { allottedQty: true, price: true },
    });
    let total = 0;
    for (const r of allotted) {
      const g = listingGain({ status: "ALLOTTED", allottedQty: r.allottedQty, price: num(r.price), issuePrice: num(ipo.issuePrice as never), listingPrice: num(ipo.listingPrice as never) });
      total += g ?? 0;
    }
    return Math.round(total * 100) / 100;
  }

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
    return { ipo: { ...ipo, counts: await counts(id), job: await latestJob(id), listingGain: await ipoListingGain(ipo) } };
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
        price: num(r?.price),
        amountAdjusted: num(r?.amountAdjusted),
        checkedAt: r?.checkedAt ?? null,
        message: r?.message ?? null,
        listingGain: r
          ? listingGain({ status: r.status, allottedQty: r.allottedQty, price: num(r.price), issuePrice: num(ipo.issuePrice), listingPrice: num(ipo.listingPrice) })
          : null,
      };
    });

    const buf = await ipoWorkbook(
      { ...ipo, issuePrice: num(ipo.issuePrice), listingPrice: num(ipo.listingPrice) },
      app.registry.get(ipo.registrar)?.name ?? ipo.registrar,
      await counts(id),
      rows,
    );
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
    if (!r.ok) {
      const why = {
        unchecked: "Every active PAN already has a result for this IPO, so nothing is left to check. New uploads are checked automatically; use \"Re-check all\" to check everyone again.",
        failed: "No PANs have errors for this IPO.",
        errors: "No PANs have errors or \"not applied\" for this IPO.",
        all: "There are no active PANs to check. Import PANs first.",
      }[scope];
      return reply.code(400).send({ error: why });
    }
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

  // Registrar IPO lists change a few times a day; cache them so page loads don't hit the sites.
  const LIVE_TTL_MS = 10 * 60_000;
  const liveCache = new Map<string, { at: number; ipos: IpoRef[] }>();

  /** IPOs open for status check at every registrar, flagged if tracked. One failing site doesn't fail the rest. */
  app.get("/live", async (req) => {
    const { refresh } = z.object({ refresh: z.enum(["true", "false"]).default("false") }).parse(req.query);
    const adapters = [...app.registry.values()];
    const results = await Promise.all(
      adapters.map(async (a) => {
        const hit = liveCache.get(a.id);
        if (hit && refresh !== "true" && Date.now() - hit.at < LIVE_TTL_MS) return { registrar: a, ipos: hit.ipos, error: null, fetchedAt: hit.at };
        try {
          const ipos = await a.listIpos();
          liveCache.set(a.id, { at: Date.now(), ipos });
          return { registrar: a, ipos, error: null, fetchedAt: Date.now() };
        } catch (err) {
          req.log.warn({ err, registrar: a.id }, "registrar IPO list failed");
          return { registrar: a, ipos: [] as IpoRef[], error: `${a.name} didn't respond`, fetchedAt: null };
        }
      }),
    );
    const tracked = await app.prisma.ipo.findMany({ select: { id: true, registrar: true, registrarIpoId: true, allotmentDate: true } });
    const key = (r: string, id: string) => `${r}|${id}`;
    const trackedBy = new Map(tracked.map((t) => [key(t.registrar, t.registrarIpoId), t]));
    return {
      registrars: results.map((r) => ({ id: r.registrar.id, name: r.registrar.name, count: r.ipos.length, error: r.error, fetchedAt: r.fetchedAt })),
      ipos: results.flatMap((r) =>
        r.ipos.map((i) => {
          const t = trackedBy.get(key(r.registrar.id, i.registrarIpoId));
          return { ...i, registrar: r.registrar.id, registrarName: r.registrar.name, trackedIpoId: t?.id ?? null, allotmentDate: t?.allotmentDate ?? null };
        }),
      ),
    };
  });

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
