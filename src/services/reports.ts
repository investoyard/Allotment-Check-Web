import type { AllotmentStatus, Prisma, PrismaClient } from "@prisma/client";

export interface ReportFilters {
  from?: string; // YYYY-MM-DD, matched against the IPO's allotment date (or when it was added)
  to?: string;
  clientId?: number;
  registrar?: string;
  ipoId?: number;
}

/** One checked result with everything a report needs. */
export interface HistoryRow {
  ipoId: number;
  ipoName: string;
  registrar: string;
  isSme: boolean;
  ipoDate: Date | null;
  panId: number;
  panMasked: string;
  panEncrypted: string;
  holderName: string;
  clientId: number;
  clientName: string;
  status: AllotmentStatus;
  appliedQty: number | null;
  allottedQty: number | null;
  category: string | null;
  price: number | null;
  amountAdjusted: number | null;
  checkedAt: Date;
  /** From the IPO record, entered by staff */
  issuePrice: number | null;
  listingPrice: number | null;
}

/** Price paid per share: the IPO's issue price if set, else what the registrar reported. */
export const effectivePrice = (r: Pick<HistoryRow, "issuePrice" | "price">) => r.issuePrice ?? r.price;

/** Listing-day gain for an allotted result, or null when a price is missing. */
export function listingGain(r: Pick<HistoryRow, "status" | "allottedQty" | "issuePrice" | "price" | "listingPrice">): number | null {
  const paid = effectivePrice(r);
  if (r.status !== "ALLOTTED" || !r.allottedQty || paid == null || r.listingPrice == null) return null;
  return Math.round((r.listingPrice - paid) * r.allottedQty * 100) / 100;
}

const num = (d: { toString(): string } | null) => (d == null ? null : Number(d));

export interface Tally {
  key: number;
  label: string;
  clientName: string;
  panMasked?: string;
  panEncrypted?: string;
  /** IPOs where an application was found (allotted or not) */
  applied: number;
  allotted: number;
  notAllotted: number;
  /** allotted / applied, 0–1; null when nothing applied */
  ratio: number | null;
  sharesApplied: number;
  sharesAllotted: number;
  /** Shares allotted × issue price, where a price is known */
  allottedValue: number;
  /** Sum of listing-day gain/loss over allotments with both prices known */
  listingGain: number;
  /** Allotments missing a listing or issue price (not in listingGain) */
  gainUnknown: number;
  errors: number;
}

const dayStart = (d: string) => new Date(`${d}T00:00:00Z`);
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999Z`);

export function resultWhere(f: ReportFilters): Prisma.CheckResultWhereInput {
  const ipo: Prisma.IpoWhereInput = {};
  if (f.registrar) ipo.registrar = f.registrar;
  if (f.from || f.to) {
    const range = { ...(f.from ? { gte: dayStart(f.from) } : {}), ...(f.to ? { lte: dayEnd(f.to) } : {}) };
    // IPOs without an allotment date are placed by when they were added here.
    ipo.OR = [{ allotmentDate: range }, { allotmentDate: null, createdAt: range }];
  }
  return {
    ...(f.ipoId ? { ipoId: f.ipoId } : {}),
    ipo,
    pan: { active: true, ...(f.clientId ? { clientId: f.clientId } : {}) },
  };
}

export async function loadHistory(prisma: PrismaClient, f: ReportFilters): Promise<HistoryRow[]> {
  const results = await prisma.checkResult.findMany({
    where: resultWhere(f),
    include: {
      ipo: { select: { name: true, registrar: true, isSme: true, allotmentDate: true, createdAt: true, issuePrice: true, listingPrice: true } },
      pan: { select: { panMasked: true, panEncrypted: true, holderName: true, clientId: true, client: { select: { name: true } } } },
    },
    orderBy: [{ ipoId: "desc" }, { panId: "asc" }],
  });
  return results.map((r) => ({
    ipoId: r.ipoId,
    ipoName: r.ipo.name,
    registrar: r.ipo.registrar,
    isSme: r.ipo.isSme,
    ipoDate: r.ipo.allotmentDate ?? r.ipo.createdAt,
    panId: r.panId,
    panMasked: r.pan.panMasked,
    panEncrypted: r.pan.panEncrypted,
    holderName: r.pan.holderName,
    clientId: r.pan.clientId,
    clientName: r.pan.client.name,
    status: r.status,
    appliedQty: r.appliedQty,
    allottedQty: r.allottedQty,
    category: r.category,
    price: num(r.price),
    amountAdjusted: num(r.amountAdjusted),
    checkedAt: r.checkedAt,
    issuePrice: num(r.ipo.issuePrice),
    listingPrice: num(r.ipo.listingPrice),
  }));
}

/** Groups history rows per client or per PAN. Sorted by most IPOs applied, then name. */
export function tally(rows: HistoryRow[], by: "client" | "pan"): Tally[] {
  const map = new Map<number, Tally>();
  for (const r of rows) {
    const key = by === "client" ? r.clientId : r.panId;
    let t = map.get(key);
    if (!t) {
      t = {
        key,
        label: by === "client" ? r.clientName : r.holderName,
        clientName: r.clientName,
        ...(by === "pan" ? { panMasked: r.panMasked, panEncrypted: r.panEncrypted } : {}),
        applied: 0, allotted: 0, notAllotted: 0, ratio: null, sharesApplied: 0, sharesAllotted: 0, allottedValue: 0,
        listingGain: 0, gainUnknown: 0, errors: 0,
      };
      map.set(key, t);
    }
    if (r.status === "ERROR") t.errors++;
    if (r.status !== "ALLOTTED" && r.status !== "NOT_ALLOTTED") continue;
    t.applied++;
    if (r.status === "ALLOTTED") t.allotted++;
    else t.notAllotted++;
    t.sharesApplied += r.appliedQty ?? 0;
    t.sharesAllotted += r.allottedQty ?? 0;
    const paid = effectivePrice(r);
    if (paid != null && r.allottedQty) t.allottedValue += paid * r.allottedQty;
    if (r.status === "ALLOTTED") {
      const g = listingGain(r);
      if (g == null) t.gainUnknown++;
      else t.listingGain += g;
    }
  }
  const out = [...map.values()];
  for (const t of out) t.ratio = t.applied ? t.allotted / t.applied : null;
  return out.sort((a, b) => b.applied - a.applied || a.label.localeCompare(b.label));
}

export function totals(rows: HistoryRow[]) {
  const applied = rows.filter((r) => r.status === "ALLOTTED" || r.status === "NOT_ALLOTTED");
  const allotted = applied.filter((r) => r.status === "ALLOTTED");
  return {
    ipos: new Set(rows.map((r) => r.ipoId)).size,
    pans: new Set(rows.map((r) => r.panId)).size,
    applications: applied.length,
    allotted: allotted.length,
    ratio: applied.length ? allotted.length / applied.length : null,
    sharesAllotted: allotted.reduce((t, r) => t + (r.allottedQty ?? 0), 0),
    allottedValue: allotted.reduce((t, r) => t + (effectivePrice(r) ?? 0) * (r.allottedQty ?? 0), 0),
    listingGain: Math.round(allotted.reduce((t, r) => t + (listingGain(r) ?? 0), 0) * 100) / 100,
    gainUnknown: allotted.filter((r) => listingGain(r) == null).length,
  };
}
