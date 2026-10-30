import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { parsePanList, parseRows, readSheet } from "../lib/import.js";
import { isValidPan, maskPan, normalizePan } from "../lib/pan.js";
import { createCheckJob } from "../services/checkJobs.js";
import { deletePans } from "../services/panDelete.js";
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

const optionalText = z.string().trim().max(50).nullable().optional().transform((v) => (v === "" ? null : v));
const updateBody = z.object({
  holderName: z.string().trim().min(1).max(200).optional(),
  clientId: z.number().int().positive().optional(),
  mobile: optionalText,
  dpClientId: optionalText,
  active: z.boolean().optional(),
});

const listFilter = z.object({
  clientId: z.number().int().positive().optional(),
  q: z.string().trim().optional(),
  includeInactive: z.boolean().optional(),
});
/** Either explicit ids (tickboxes) or "everything matching this filter". */
const bulkDeleteBody = z.union([
  z.object({ ids: z.array(z.number().int().positive()).min(1).max(10_000) }),
  z.object({ filter: listFilter }),
]);
const fileDeleteQuery = z.object({ dryRun: z.enum(["true", "false"]).default("true") });

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
  panEncrypted: true,
  client: { select: { id: true, code: true, name: true } },
} satisfies Prisma.PanSelect;

/** Full PAN for the browser; the ciphertext stays on the server. */
function withPan(vault: { open(c: string): string }, { panEncrypted, ...p }: Prisma.PanGetPayload<{ select: typeof panSelect }>) {
  return { ...p, pan: vault.open(panEncrypted) };
}

export async function panRoutes(app: FastifyInstance) {
  /** Shared by the PAN list and "delete everything matching this filter". */
  function panWhere({ clientId, q, includeInactive }: { clientId?: number; q?: string; includeInactive?: boolean }) {
    const where: Prisma.PanWhereInput = {};
    if (clientId) where.clientId = clientId;
    if (!includeInactive) where.active = true;
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
    return where;
  }

  async function deleteAndAudit(req: Parameters<typeof audit>[0], ids: number[], source: string) {
    const deleted = await deletePans(app.prisma, ids);
    if (deleted.length) {
      await audit(req, deleted.length === 1 ? "pan.delete" : "pan.bulk_delete", {
        entity: "Pan",
        entityId: deleted.length === 1 ? deleted[0]!.id : undefined,
        // Masked PANs only; cap the list so a huge delete doesn't bloat the log.
        details: { source, count: deleted.length, pans: deleted.slice(0, 200).map((d) => d.panMasked) },
      });
    }
    return deleted;
  }

  app.get("/", { preHandler: requireLogin }, async (req) => {
    const { clientId, q, includeInactive, page, pageSize } = listQuery.parse(req.query);
    const where = panWhere({ clientId, q, includeInactive: includeInactive === "true" });
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
    return { total, page, pageSize, pans: pans.map((x) => withPan(app.vault, x)) };
  });

  app.post("/", { preHandler: requireLogin }, async (req, reply) => {
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
    return reply.code(201).send({ pan: withPan(app.vault, pan) });
  });

  app.patch("/:id", { preHandler: requireLogin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    if (!(await app.prisma.pan.findUnique({ where: { id } }))) return reply.code(404).send({ error: "PAN not found" });
    const pan = await app.prisma.pan.update({ where: { id }, data: body, select: panSelect });
    await audit(req, "pan.update", { entity: "Pan", entityId: id, details: { pan: pan.panMasked, changed: Object.keys(body) } });
    return { pan: withPan(app.vault, pan) };
  });

  /**
   * Removes a PAN from the list and future checks. Its IPO results stay in reports with the full PAN,
   * holder and client (kept on the results). Use PATCH active=false to just pause it.
   */
  app.delete("/:id", { preHandler: requireLogin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const deleted = await deleteAndAudit(req, [id], "single");
    if (!deleted.length) return reply.code(404).send({ error: "PAN not found" });
    return { ok: true, deleted: deleted.length };
  });

  /** Bulk delete by tickbox ids, or everything matching the PAN list's current filter. */
  app.post("/bulk-delete", { preHandler: requireLogin }, async (req) => {
    const body = bulkDeleteBody.parse(req.body);
    const ids =
      "ids" in body
        ? body.ids
        : (await app.prisma.pan.findMany({ where: panWhere(body.filter), select: { id: true } })).map((p) => p.id);
    const deleted = await deleteAndAudit(req, ids, "ids" in body ? "selection" : "filter");
    return { deleted: deleted.length };
  });

  /**
   * Bulk delete from an uploaded Excel/CSV with a PAN column. dryRun=true (default) previews
   * which PANs match; dryRun=false deletes the matches.
   */
  app.post("/bulk-delete/file", { preHandler: requireLogin }, async (req, reply) => {
    const { dryRun } = fileDeleteQuery.parse(req.query);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });
    let sheet: string[][];
    try {
      sheet = await readSheet(await file.toBuffer(), file.filename);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message || "Could not read file" });
    }
    const { pans, errors } = parsePanList(sheet);
    const byHash = new Map(pans.map((p) => [app.vault.hash(p.pan), p]));
    const found = await app.prisma.pan.findMany({
      where: { panHash: { in: [...byHash.keys()] } },
      select: { id: true, panHash: true, panMasked: true, holderName: true, active: true, client: { select: { name: true } } },
    });
    const foundHashes = new Set(found.map((f) => f.panHash));
    const matched = found.map(({ panHash, ...f }) => {
      const src = byHash.get(panHash)!;
      return { ...f, pan: src.pan, rowNumber: src.rowNumber, clientName: f.client.name };
    });
    const notFound = pans.filter((p) => !foundHashes.has(app.vault.hash(p.pan))).map((p) => ({ rowNumber: p.rowNumber, pan: p.pan, panMasked: maskPan(p.pan) }));

    let deleted = 0;
    if (dryRun === "false") deleted = (await deleteAndAudit(req, found.map((f) => f.id), `file:${file.filename}`)).length;
    return {
      dryRun: dryRun === "true",
      matched: matched.map(({ client: _c, ...m }) => m),
      notFound,
      errors,
      deleted,
    };
  });


  /**
   * Upload .xlsx/.csv. dryRun=true (default) returns a preview of what would change;
   * dryRun=false applies it (invalid rows are skipped only with skipErrors=true).
   * Required columns: PAN, Name. Optional: Client/Group, Mobile, DP ID.
   */
  app.post("/import", { preHandler: requireLogin }, async (req, reply) => {
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
