import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { COOKIE_NAME, registerAuth } from "./auth.js";
import { PanVault } from "./services/panVault.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { clientRoutes } from "./routes/clients.js";
import { panRoutes } from "./routes/pans.js";
import { auditRoutes } from "./routes/audit.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    prisma: PrismaClient;
    vault: PanVault;
  }
}

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export async function buildApp(config: Config, prisma = new PrismaClient()) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Request bodies are never logged; also keep cookies out of the logs.
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
    trustProxy: true,
  });

  app.decorate("config", config);
  app.decorate("prisma", prisma);
  app.decorate("vault", new PanVault(config));
  app.addHook("onClose", async () => prisma.$disconnect());

  await app.register(cookie);
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    cookie: { cookieName: COOKIE_NAME, signed: false },
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  registerAuth(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid input", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "Internal server error" : (err as Error).message });
  });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(clientRoutes, { prefix: "/api/clients" });
  await app.register(panRoutes, { prefix: "/api/pans" });
  await app.register(auditRoutes, { prefix: "/api/audit" });

  await app.register(fastifyStatic, { root: publicDir });

  return app;
}
