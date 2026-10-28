import type { PrismaClient } from "@prisma/client";
import type { ImportError, ImportRow } from "../lib/import.js";
import { maskPan } from "../lib/pan.js";
import type { PanVault } from "./panVault.js";

/** "Sharma Family" → "SHARMA-FAMILY" */
export function clientCode(name: string): string {
  return (
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "CLIENT"
  );
}

export type PlanAction = "create" | "update" | "unchanged";

export interface PlannedRow {
  rowNumber: number;
  action: PlanAction;
  panMasked: string;
  holderName: string;
  clientCode: string;
  clientName: string;
  changes?: string[];
  existingId?: number;
}

export interface ImportPlan {
  rows: PlannedRow[];
  newClients: { code: string; name: string }[];
  errors: ImportError[];
  summary: { create: number; update: number; unchanged: number; errors: number; newClients: number };
}

/** Works out what an import would do without writing anything. */
export async function planImport(
  prisma: PrismaClient,
  vault: PanVault,
  rows: ImportRow[],
  parseErrors: ImportError[],
): Promise<{ plan: ImportPlan; sealed: Map<number, ReturnType<PanVault["seal"]>> }> {
  const sealed = new Map(rows.map((r) => [r.rowNumber, vault.seal(r.pan)]));
  const hashes = [...sealed.values()].map((s) => s.panHash);
  const existing = await prisma.pan.findMany({ where: { panHash: { in: hashes } }, include: { client: true } });
  const byHash = new Map(existing.map((p) => [p.panHash, p]));

  const codes = [...new Set(rows.map((r) => clientCode(r.clientName)))];
  const clients = await prisma.client.findMany({ where: { code: { in: codes } } });
  const knownCodes = new Set(clients.map((c) => c.code));
  const newClients = new Map<string, string>();

  const planned: PlannedRow[] = rows.map((r) => {
    const s = sealed.get(r.rowNumber)!;
    const code = clientCode(r.clientName);
    if (!knownCodes.has(code) && !newClients.has(code)) newClients.set(code, r.clientName);
    const base = { rowNumber: r.rowNumber, panMasked: maskPan(r.pan), holderName: r.holderName, clientCode: code, clientName: r.clientName };

    const cur = byHash.get(s.panHash);
    if (!cur) return { ...base, action: "create" };

    const changes: string[] = [];
    if (cur.holderName !== r.holderName) changes.push("name");
    if (cur.client.code !== code) changes.push("client");
    // Blank cells in the file don't wipe existing mobile / DP ID.
    if (r.mobile && cur.mobile !== r.mobile) changes.push("mobile");
    if (r.dpClientId && cur.dpClientId !== r.dpClientId) changes.push("dpClientId");
    if (!cur.active) changes.push("reactivated");
    return changes.length
      ? { ...base, action: "update", changes, existingId: cur.id }
      : { ...base, action: "unchanged", existingId: cur.id };
  });

  const count = (a: PlanAction) => planned.filter((p) => p.action === a).length;
  return {
    sealed,
    plan: {
      rows: planned,
      newClients: [...newClients].map(([code, name]) => ({ code, name })),
      errors: parseErrors,
      summary: {
        create: count("create"),
        update: count("update"),
        unchanged: count("unchanged"),
        errors: parseErrors.length,
        newClients: newClients.size,
      },
    },
  };
}

/** Applies a plan in one transaction — either the whole file goes in or nothing does. */
export async function applyImport(
  prisma: PrismaClient,
  rows: ImportRow[],
  plan: ImportPlan,
  sealed: Map<number, ReturnType<PanVault["seal"]>>,
) {
  const rowByNumber = new Map(rows.map((r) => [r.rowNumber, r]));
  await prisma.$transaction(
    async (tx) => {
      if (plan.newClients.length) {
        await tx.client.createMany({ data: plan.newClients, skipDuplicates: true });
      }
      const codes = [...new Set(plan.rows.map((p) => p.clientCode))];
      const clients = await tx.client.findMany({ where: { code: { in: codes } } });
      const clientId = new Map(clients.map((c) => [c.code, c.id]));

      const creates = plan.rows
        .filter((p) => p.action === "create")
        .map((p) => {
          const r = rowByNumber.get(p.rowNumber)!;
          return {
            ...sealed.get(p.rowNumber)!,
            clientId: clientId.get(p.clientCode)!,
            holderName: r.holderName,
            mobile: r.mobile,
            dpClientId: r.dpClientId,
          };
        });
      if (creates.length) await tx.pan.createMany({ data: creates });

      for (const p of plan.rows.filter((p) => p.action === "update")) {
        const r = rowByNumber.get(p.rowNumber)!;
        await tx.pan.update({
          where: { id: p.existingId },
          data: {
            holderName: r.holderName,
            clientId: clientId.get(p.clientCode)!,
            mobile: r.mobile ?? undefined,
            dpClientId: r.dpClientId ?? undefined,
            active: true,
          },
        });
      }
    },
    { timeout: 60_000 },
  );
}
