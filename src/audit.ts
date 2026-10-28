import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";

/** Never pass a full PAN in details — use the masked form. */
export async function audit(
  req: FastifyRequest,
  action: string,
  opts: { entity?: string; entityId?: string | number; details?: Prisma.InputJsonValue; userId?: number } = {},
) {
  await req.server.prisma.auditLog.create({
    data: {
      userId: opts.userId ?? req.currentUser?.id ?? null,
      action,
      entity: opts.entity ?? null,
      entityId: opts.entityId == null ? null : String(opts.entityId),
      details: opts.details,
      ip: req.ip,
    },
  });
}
