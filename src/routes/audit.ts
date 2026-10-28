import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireAdmin }, async (req) => {
    const { limit, before } = query.parse(req.query);
    const logs = await app.prisma.auditLog.findMany({
      where: before ? { id: { lt: before } } : undefined,
      orderBy: { id: "desc" },
      take: limit,
      include: { user: { select: { email: true, name: true } } },
    });
    return { logs };
  });
}
