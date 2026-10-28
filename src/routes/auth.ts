import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COOKIE_NAME, SESSION_HOURS, publicUser, requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { verifyPassword } from "../lib/crypto.js";

// "email" holds the login name: a username (e.g. "superadmin") or an email address. Case-insensitive.
const loginBody = z.object({ email: z.string().trim().toLowerCase().min(1).max(100), password: z.string().min(1) });

// Simple in-memory brute-force guard: 5 failures per IP+email per 15 minutes.
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

export async function authRoutes(app: FastifyInstance) {
  app.post("/login", async (req, reply) => {
    const { email, password } = loginBody.parse(req.body);
    const key = `${req.ip}|${email}`;
    const f = failures.get(key);
    if (f && Date.now() - f.first < WINDOW_MS && f.count >= MAX_FAILS) {
      return reply.code(429).send({ error: "Too many failed attempts. Try again in 15 minutes." });
    }

    const user = await app.prisma.user.findUnique({ where: { email } });
    const ok = !!user && user.active && (await verifyPassword(password, user.passwordHash));
    if (!ok) {
      const cur = f && Date.now() - f.first < WINDOW_MS ? f : { count: 0, first: Date.now() };
      failures.set(key, { ...cur, count: cur.count + 1 });
      await audit(req, "auth.login_failed", { details: { email } });
      return reply.code(401).send({ error: "Wrong email or password" });
    }

    failures.delete(key);
    const token = await reply.jwtSign({ sub: user.id }, { expiresIn: `${SESSION_HOURS}h` });
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: app.config.COOKIE_SECURE,
      path: "/",
      maxAge: SESSION_HOURS * 3600,
    });
    await audit(req, "auth.login", { userId: user.id });
    return { user: publicUser(user) };
  });

  app.post("/logout", async (req, reply) => {
    if (req.currentUser) await audit(req, "auth.logout");
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { preHandler: requireLogin }, async (req) => ({ user: publicUser(req.currentUser!) }));
}
