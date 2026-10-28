import type { FastifyInstance } from "fastify";
import { requireAdmin, requireLogin } from "../auth.js";
import { audit } from "../audit.js";
import { istParts } from "../services/scheduler.js";

export async function schedulerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireLogin);

  /** Today's allotment-day IPOs and what the scheduler intends to do with each (read-only). */
  app.get("/", async () => {
    const now = new Date();
    const { date, hour } = istParts(now);
    const c = app.config;
    const plan = await app.scheduler.plan(now);
    const last = new Map(app.scheduler.lastTick?.entries.map((e) => [e.ipoId, e.decision]) ?? []);
    return {
      enabled: c.SCHEDULER_ENABLED,
      today: date,
      hours: { start: c.SCHEDULER_START_HOUR, end: c.SCHEDULER_END_HOUR, insideNow: hour >= c.SCHEDULER_START_HOUR && hour < c.SCHEDULER_END_HOUR },
      everyMin: c.SCHEDULER_INTERVAL_MIN,
      lastTickAt: app.scheduler.lastTick?.at ?? null,
      ipos: plan.map(({ ipo, decision }) => ({
        ipoId: ipo.id,
        name: ipo.name,
        registrar: ipo.registrar,
        allotmentDate: ipo.allotmentDate!.toISOString().slice(0, 10),
        // What the last tick actually did is more useful than the plan when it probed or started a job.
        lastAction: last.get(ipo.id) ?? null,
        next: decision,
      })),
    };
  });

  /** Run a scheduler pass now instead of waiting for the next tick. */
  app.post("/run", { preHandler: requireAdmin }, async (req) => {
    await app.scheduler.tick();
    await audit(req, "scheduler.run");
    return { ok: true, lastTick: app.scheduler.lastTick };
  });
}
