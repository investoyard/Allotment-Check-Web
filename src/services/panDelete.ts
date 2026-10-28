import type { PrismaClient } from "@prisma/client";

/**
 * Permanently deletes PANs (the full PAN and its ciphertext are gone afterwards) while keeping
 * their IPO results for reports: each result first gets a snapshot of the masked PAN, holder
 * and client, then the PAN row is deleted and the results' panId becomes null.
 */
export async function deletePans(prisma: PrismaClient, ids: number[]) {
  if (!ids.length) return [];
  return prisma.$transaction(
    async (tx) => {
      const pans = await tx.pan.findMany({
        where: { id: { in: ids } },
        select: { id: true, panMasked: true, holderName: true, clientId: true, client: { select: { name: true } } },
      });
      for (const p of pans) {
        await tx.checkResult.updateMany({
          where: { panId: p.id },
          data: { panMasked: p.panMasked, holderName: p.holderName, clientId: p.clientId, clientName: p.client.name },
        });
      }
      await tx.pan.deleteMany({ where: { id: { in: pans.map((p) => p.id) } } });
      return pans.map((p) => ({ id: p.id, panMasked: p.panMasked, holderName: p.holderName, clientName: p.client.name }));
    },
    { timeout: 120_000 },
  );
}
