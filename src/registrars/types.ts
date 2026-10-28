import type { AllotmentStatus } from "@prisma/client";

export interface IpoRef {
  /** Registrar's own id for the IPO (e.g. MUFG company_id) */
  registrarIpoId: string;
  name: string;
  isSme: boolean;
}

/** One application row as returned by the registrar (a PAN can have several, e.g. retail + shareholder). */
export interface ApplicationRow {
  category: string | null;
  applicantName: string | null;
  appliedQty: number | null;
  allottedQty: number | null;
  price: number | null;
  amountAdjusted: number | null;
}

export interface CheckResult {
  status: AllotmentStatus;
  appliedQty: number | null;
  allottedQty: number | null;
  category: string | null;
  applicantName: string | null;
  price: number | null;
  amountAdjusted: number | null;
  message: string | null;
  rows: ApplicationRow[];
}

/** Thrown for failures worth retrying (network, expired token, site overloaded). */
export class RetryableError extends Error {
  /** Set when the registrar told us how long to wait (Retry-After). */
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface RegistrarAdapter {
  id: string;
  name: string;
  /** Minimum gap between requests to this registrar, in ms. */
  minDelayMs: number;
  listIpos(): Promise<IpoRef[]>;
  check(registrarIpoId: string, pan: string): Promise<CheckResult>;
}

/** Combines a PAN's application rows into one result. */
export function summarize(rows: ApplicationRow[]): Omit<CheckResult, "message"> {
  if (!rows.length) {
    return { status: "NOT_APPLIED", appliedQty: null, allottedQty: null, category: null, applicantName: null, price: null, amountAdjusted: null, rows };
  }
  const sum = (k: "appliedQty" | "allottedQty" | "amountAdjusted") =>
    rows.some((r) => r[k] != null) ? rows.reduce((t, r) => t + (r[k] ?? 0), 0) : null;
  const allottedQty = sum("allottedQty");
  return {
    status: (allottedQty ?? 0) > 0 ? "ALLOTTED" : "NOT_ALLOTTED",
    appliedQty: sum("appliedQty"),
    allottedQty,
    category: [...new Set(rows.map((r) => r.category).filter(Boolean))].join(", ") || null,
    applicantName: rows.find((r) => r.applicantName)?.applicantName ?? null,
    price: rows.find((r) => r.price != null)?.price ?? null,
    amountAdjusted: sum("amountAdjusted"),
    rows,
  };
}

/** "1,234.50" → 1234.5; blanks and junk → null */
export function toNumber(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v.replace(/[,\s₹]|Rs\.?/gi, ""));
  return v.trim() === "" || Number.isNaN(n) ? null : n;
}
