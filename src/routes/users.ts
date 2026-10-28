import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publicUser, requireAdmin } from "../auth.js";
import { audit } from "../audit.js";
import { hashPassword } from "../lib/crypto.js";

const password = z.string().min(10, "Password must be at least 10 characters");
const role = z.enum(["ADMIN", "OPERATOR"]);

/** Login name: a username or an email address, stored lowercase. */
export const loginName = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters")
  .max(100)
  .regex(/^[a-z0-9._@+-]+$/, "Use letters, digits and . _ @ + - only");

const createBody = z.object({
  email: loginName,
  name: z.string().trim().min(1),
  password,
  role: role.default("OPERATOR"),
});

const updateBody = z.object({
  name: z.string().trim().min(1).optional(),
  password: password.optional(),
  role: role.optional(),
  active: z.boolean().optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/", async () => {
    const users = await app.prisma.user.findMany({ orderBy: { createdAt: "asc" } });
    return { users: users.map(publicUser) };
  });

  app.post("/", async (req, reply) => {
    const body = createBody.parse(req.body);
    if (await app.prisma.user.findUnique({ where: { email: body.email } })) {
      return reply.code(409).send({ error: "A user with this email already exists" });
    }
    const user = await app.prisma.user.create({
      data: { email: body.email, name: body.name, role: body.role, passwordHash: await hashPassword(body.password) },
    });
    await audit(req, "user.create", { entity: "User", entityId: user.id, details: { email: user.email, role: user.role } });
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.patch("/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateBody.parse(req.body);
    const me = req.currentUser!;
    if (id === me.id && (body.active === false || body.role === "OPERATOR")) {
      return reply.code(400).send({ error: "You can't deactivate or demote yourself" });
    }
    const existing = await app.prisma.user.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "User not found" });

    const user = await app.prisma.user.update({
      where: { id },
      data: {
        name: body.name,
        role: body.role,
        active: body.active,
        passwordHash: body.password ? await hashPassword(body.password) : undefined,
      },
    });
    const changed = Object.keys(body).filter((k) => k !== "password");
    if (body.password) changed.push("password");
    await audit(req, "user.update", { entity: "User", entityId: id, details: { changed } });
    return { user: publicUser(user) };
  });
}
