// Creates (or resets the password of) an ADMIN user.
// Usage: npm run create-admin -- you@example.com "Your Name"
// The password is read from the ADMIN_PASSWORD env var, or prompted for.
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto.js";

const [email, ...nameParts] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run create-admin -- <email> "<name>"');
  process.exit(1);
}
const name = nameParts.join(" ") || email;

let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Password (min 10 chars): ");
  rl.close();
}
if (password.length < 10) {
  console.error("Password must be at least 10 characters");
  process.exit(1);
}

const prisma = new PrismaClient();
const passwordHash = await hashPassword(password);
const user = await prisma.user.upsert({
  where: { email: email.toLowerCase() },
  create: { email: email.toLowerCase(), name, role: "ADMIN", passwordHash },
  update: { role: "ADMIN", active: true, passwordHash },
});
await prisma.auditLog.create({ data: { action: "user.create_admin_cli", entity: "User", entityId: String(user.id) } });
console.log(`Admin ready: ${user.email} (id ${user.id})`);
await prisma.$disconnect();
