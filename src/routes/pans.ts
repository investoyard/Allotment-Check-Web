import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin, requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { parseRows, readSheet } from "../lib/import.js";
import { isValidPan, normalizePan } from "../lib/pan.js";
import { createCheckJob } from "../services/checkJobs.js";
import { applyImport, planImport } from "../services/panImport.js";

const listQuery = z.object({
  clientId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().optional(),
  includeInactive: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

const panField = z
  .string()
  .transform(normalizePan)
  .refine(isValidPan, "Invalid PAN format (expected e.g. ABCPX1234K)");

const createBody = z.object({
  pan: panField,
  holderName: z.string().trim().min(1),
  clientId: z.number().int().positive(),
  mobile: z.string().trim().optional(),
  dpClientId: z.string().trim().optional(),
});

const updateBody = z.object({
  holderName: z.string().trim().min(1).optional(),
  clientId: z.number().int().positive().optional(),
  mobile: z.string().trim().nullable().optional(),
  dpClientId: z.string().trim().nullable().optional(),
  active: z.boolean().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });
const importQuery = z.object({
  dryRun: z.enum(["true", "false"]).default("true"),
  skipErrors: z.enum(["true", "false"]).default("false"),
  /** Comma-separated IPO ids to check the imported PANs for, right after the import. */
  checkIpoIds: z
    .string()
    .optional()
    .transform((s) => (s ? [...new Set(s.split(",").map((x) => Number(x.trim())))] : []))
    .pipe(z.array(z.number().int().positive()).max(50)),
});

const panSelect = {
  id: true,
  panMasked: true,
  holderName: true,
  mobile: true,
  dpClientId: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, code: true, name: true } },
} satisfies Prisma.PanSelect;

export async function panRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireLogin }, async (req) => {
    const { clientId, q, includeInactive, page, pageSize } = listQuery.parse(req.query);
    const where: Prisma.PanWhereInput = {};
    if (clientId) where.clientId = clientId;
    if (includeInactive !== "true") where.active = true;
    if (q) {
      // A full PAN is matched exactly through its hash; anything else searches names.
      const asPan = normalizePan(q);
      where.OR = isValidPan(asPan)
        ? [{ panHash: app.vault.hash(asPan) }]
        : [
            { holderName: { contains: q, mode: "insensitive" } },
            { client: { name: { contains: q, mode: "insensitive" } } },
          ];
    }
    const [total, pans] = await Promise.all([
      app.prisma.pan.count({ where }),
      app.prisma.pan.findMany({
        where,
        select: panSelect,
        orderBy: [{ client: { name: "asc" } }, { holderName: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, pans };
  });

  app.post("/", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const sealed = app.vault.seal(body.pan);
    if (await app.prisma.pan.findUnique({ where: { panHash: sealed.panHash } })) {
      return reply.code(409).send({ error: `${sealed.panMasked} is already registered` });
    }
    if (!(await app.prisma.client.findUnique({ where: { id: body.clientId } }))) {
      return reply.code(400).send({ error: "Client not found" });
    }
    const pan = await app.prisma.pan.create({
      data: { ...sealed, holderName: body.holderName, clientId: body.clientId, mobile: body.mobile, dpClientId: body.dpClientId },
      select: panSelect,
    });
    await audit(req, "pan.create", { entity: "Pan", entityId: pan.id, details: { pan: pan.panMasked } });
    return reply.code(201).send({ pan });
  });

  app.patch("/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    if (!(await app.prisma.pan.findUnique({ where: { id } }))) return reply.code(404).send({ error: "PAN not found" });
    const pan = await app.prisma.pan.update({ where: { id }, data: body, select: panSelect });
    await audit(req, "pan.update", { entity: "Pan", entityId: id, details: { pan: pan.panMasked, changed: Object.keys(body) } });
    return { pan };
  });

  /** Permanent delete, for client data-removal requests (DPDP). Use PATCH active=false to just hide. */
  app.delete("/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = await app.prisma.pan.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "PAN not found" });
    await app.prisma.pan.delete({ where: { id } });
    await audit(req, "pan.delete", { entity: "Pan", entityId: id, details: { pan: existing.panMasked } });
    return { ok: true };
  });

  app.get("/:id/reveal", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const existing = await app.prisma.pan.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "PAN not found" });
    await audit(req, "pan.reveal", { entity: "Pan", entityId: id, details: { pan: existing.panMasked } });
    reply.header("Cache-Control", "no-store");
    return { pan: app.vault.open(existing.panEncrypted) };
  });

  /**
   * Upload .xlsx/.csv. dryRun=true (default) returns a preview of what would change;
   * dryRun=false applies it (invalid rows are skipped only with skipErrors=true).
   * Required columns: PAN, Name. Optional: Client/Group, Mobile, DP ID.
   */
  app.post("/import", { preHandler: requireAdmin }, async (req, reply) => {
    const { dryRun, skipErrors, checkIpoIds } = importQuery.parse(req.query);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });
    const buffer = await file.toBuffer();

    let sheet: string[][];
    try {
      sheet = await readSheet(buffer, file.filename);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message || "Could not read file" });
    }
    const { rows, errors } = parseRows(sheet);
    const { plan, sealed } = await planImport(app.prisma, app.vault, rows, errors);

    if (dryRun === "false") {
      if (errors.length && skipErrors !== "true") {
        return reply.code(400).send({ error: "File has errors — fix them or import with skipErrors=true", plan });
      }
      await applyImport(app.prisma, rows, plan, sealed);
      await audit(req, "pan.import", { details: { file: file.filename, ...plan.summary } });

      // Check the new PANs right away for the chosen IPOs. "unchecked" picks up exactly the
      // PANs with no result for that IPO yet, which includes everything just imported.
      const checks = [];
      const ipos = await app.prisma.ipo.findMany({ where: { id: { in: checkIpoIds }, archived: false } });
      for (const ipo of ipos) {
        const r = await createCheckJob(app.prisma, app.runner, ipo, "unchecked", {
          userId: req.currentUser!.id,
          trigger: "import",
          queueBehindActive: true,
        });
        checks.push({ ipoId: ipo.id, name: ipo.name, jobId: r.ok ? r.job.id : null, total: r.ok ? r.job.total : 0 });
        if (r.ok) await audit(req, "ipo.check", { entity: "Ipo", entityId: ipo.id, details: { jobId: r.job.id, scope: "unchecked", total: r.job.total, trigger: "import" } });
      }
      return { dryRun: false, plan, checks };
    }
    return { dryRun: true, plan, checks: [] };
  });
}
