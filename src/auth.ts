import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Role, User } from "@prisma/client";

export const COOKIE_NAME = "aca_token";
export const SESSION_HOURS = 12;

export interface TokenPayload {
  sub: number;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser: User | null;
  }
}

/** Resolves the logged-in user from the session cookie on every request. */
export function registerAuth(app: FastifyInstance) {
  app.decorateRequest("currentUser", null);
  app.addHook("onRequest", async (req) => {
    if (!req.cookies[COOKIE_NAME]) return;
    try {
      const { sub } = await req.jwtVerify<TokenPayload>();
      const user = await app.prisma.user.findUnique({ where: { id: sub } });
      req.currentUser = user?.active ? user : null;
    } catch {
      req.currentUser = null;
    }
  });
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.currentUser) return reply.code(401).send({ error: "Not logged in" });
    if (roles.length && !roles.includes(req.currentUser.role)) {
      return reply.code(403).send({ error: "Not allowed for your role" });
    }
  };
}

export const requireLogin = requireRole();
export const requireAdmin = requireRole("ADMIN");

/** Strips the password hash before a user goes out in a response. */
export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt };
}
