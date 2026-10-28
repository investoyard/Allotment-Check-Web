import "dotenv/config";
import { z } from "zod";

const key32 = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64 encoded (run npm run gen-keys)");

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("127.0.0.1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "silent"]).default("info"),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters (run npm run gen-keys)"),
  PAN_ENC_KEY: key32,
  PAN_HMAC_KEY: key32,
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration in .env:\n${issues}`);
  }
  return parsed.data;
}
