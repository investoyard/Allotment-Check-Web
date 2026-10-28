import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { clientCode } from "../services/panImport.js";
import { sameName } from "../lib/names.js";

const createBody = z.object({
  name: z.string().trim().min(1),
  code: z.string().trim().min(1).optional(),
  notes: z.string().trim().optional(),
});
const updateBody = z.object({ name: z.string().trim().min(1).optional(), notes: z.string().trim().nullable().optional() });
const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function clientRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireLogin }, async () => {
    const clients = await app.prisma.client.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: { select: { pans: { where: { active: true } } } },
        pans: { where: { active: true }, select: { holderName: true }, take: 1 },
      },
    });
    return {
      clients: clients.map(({ _count, pans, ...c }) => ({
        ...c,
        panCount: _count.pans,
        // A real group: several PANs, or one PAN filed under a different name (e.g. "Sharma Family").
        isGroup: _count.pans > 1 || (pans[0] != null && !sameName(pans[0].holderName, c.name)),
      })),
    };
  });

  app.post("/", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const code = clientCode(body.code ?? body.name);
    if (await app.prisma.client.findUnique({ where: { code } })) {
      return reply.code(409).send({ error: `Client code ${code} already exists` });
    }
    const client = await app.prisma.client.create({ data: { name: body.name, code, notes: body.notes } });
    await audit(req, "client.create", { entity: "Client", entityId: client.id, details: { code } });
    return reply.code(201).send({ client });
  });

  app.patch("/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    if (!(await app.prisma.client.findUnique({ where: { id } }))) return reply.code(404).send({ error: "Client not found" });
    const client = await app.prisma.client.update({ where: { id }, data: body });
    await audit(req, "client.update", { entity: "Client", entityId: id, details: { changed: Object.keys(body) } });
    return { client };
  });
}
