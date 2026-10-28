import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { historyWorkbook } from "../services/excel.js";
import { loadHistory, tally, totals, type ReportFilters } from "../services/reports.js";
import { fullPanQuery, sendXlsx } from "./ipos.js";

const historyQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  clientId: z.coerce.number().int().positive().optional(),
  registrar: z.string().min(1).optional(),
  ipoId: z.coerce.number().int().positive().optional(),
  groupBy: z.enum(["client", "pan"]).default("client"),
});

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireLogin);

  /** Human-readable summary of the filters, for the Excel overview sheet. */
  async function describe(f: ReportFilters) {
    const parts: string[] = [];
    if (f.from || f.to) parts.push(`Dates ${f.from ?? "…"} to ${f.to ?? "…"}`);
    if (f.clientId) parts.push(`Client: ${(await app.prisma.client.findUnique({ where: { id: f.clientId } }))?.name ?? f.clientId}`);
    if (f.registrar) parts.push(`Registrar: ${app.registry.get(f.registrar)?.name ?? f.registrar}`);
    if (f.ipoId) parts.push(`IPO: ${(await app.prisma.ipo.findUnique({ where: { id: f.ipoId } }))?.name ?? f.ipoId}`);
    return parts.join(" · ") || "All";
  }

  app.get("/history", async (req) => {
    const { groupBy, ...filters } = historyQuery.parse(req.query);
    const rows = await loadHistory(app.prisma, filters);
    return {
      totals: totals(rows),
      groupBy,
      // Never send ciphertext to the browser.
      rows: tally(rows, groupBy).map(({ panEncrypted: _e, ...t }) => t),
    };
  });

  app.get("/history/export", async (req, reply) => {
    const { groupBy: _g, ...filters } = historyQuery.parse(req.query);
    const { fullPan } = fullPanQuery.parse(req.query);
    if (fullPan === "true" && req.currentUser!.role !== "ADMIN") return reply.code(403).send({ error: "Only admins can export full PANs" });

    const rows = await loadHistory(app.prisma, filters);
    const panOf = (p: { panMasked: string; panEncrypted: string }) => (fullPan === "true" ? app.vault.open(p.panEncrypted) : p.panMasked);
    const buf = await historyWorkbook(
      await describe(filters),
      totals(rows),
      tally(rows, "client"),
      tally(rows, "pan"),
      rows,
      panOf,
      (id) => app.registry.get(id)?.name ?? id,
    );
    await audit(req, "export.history", { details: { rows: rows.length, fullPan: fullPan === "true", ...filters } });
    return sendXlsx(reply, "IPO allotment history", buf);
  });
}
