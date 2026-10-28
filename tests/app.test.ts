import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// These checks never reach the database: unauthenticated requests are rejected first.
const config = loadConfig({
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  LOG_LEVEL: "silent",
  JWT_SECRET: randomBytes(48).toString("base64url"),
  PAN_ENC_KEY: randomBytes(32).toString("base64"),
  PAN_HMAC_KEY: randomBytes(32).toString("base64"),
});

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(config);
  await app.ready();
});
afterAll(() => app.close());

describe("app", () => {
  it("serves the UI", async () => {
    const res = await app.inject("/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Allotment Checker");
  });

  it.each([
    ["GET", "/api/auth/me"],
    ["GET", "/api/pans"],
    ["GET", "/api/clients"],
    ["GET", "/api/users"],
    ["GET", "/api/audit"],
    ["GET", "/api/pans/1/reveal"],
    ["POST", "/api/pans/import"],
    ["GET", "/api/ipos"],
    ["GET", "/api/ipos/1/results"],
    ["POST", "/api/ipos/1/check"],
    ["GET", "/api/jobs/1"],
    ["GET", "/api/registrars"],
    ["GET", "/api/registrars/mufg/ipos"],
    ["GET", "/api/ipos/1/export"],
    ["GET", "/api/reports/history"],
    ["GET", "/api/reports/history/export"],
  ] as const)("%s %s requires login", async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a forged session cookie", async () => {
    const res = await app.inject({ url: "/api/pans", cookies: { aca_token: "not.a.jwt" } });
    expect(res.statusCode).toBe(401);
  });

  it("validates login input", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nope", password: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects bad config", () => {
    expect(() => loadConfig({ DATABASE_URL: "x", JWT_SECRET: "short", PAN_ENC_KEY: "abc", PAN_HMAC_KEY: "abc" })).toThrow(/JWT_SECRET/);
  });
});
