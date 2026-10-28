// Helpers for registrars that answer with server-rendered HTML instead of JSON.
import { summarize, toNumber, type ApplicationRow, type CheckResult, type IpoRef } from "./types.js";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const textOf = (html: string) =>
  decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

/** Options of a <select> found by id or name, skipping placeholders (empty/0 values). */
export function selectOptions(html: string, idOrName: string): IpoRef[] {
  const re = new RegExp(`<select[^>]*(?:id|name)=["']?${idOrName}["']?[^>]*>([\\s\\S]*?)</select>`, "i");
  const body = stripComments(html).match(re)?.[1];
  if (!body) return [];
  return [...body.matchAll(/<option[^>]*value=["']?([^"'\s>]*)["']?[^>]*>([\s\S]*?)(?=<\/option>|<option|$)/gi)]
    .map(([, id, label]) => ({ id: decodeEntities(id!).trim(), name: textOf(label!) }))
    .filter((o) => o.id && o.id !== "0" && o.id !== "-1" && o.name && !/^-*\s*select/i.test(o.name))
    .map((o) => ({ registrarIpoId: o.id, name: o.name, isSme: /\bSME\b/i.test(o.name) }));
}

/** Value of a hidden/other input by name. */
export function inputValue(html: string, name: string): string | null {
  const tag = html.match(new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, "i"))?.[0];
  return tag?.match(/value=["']([^"']*)["']/i)?.[1] ?? null;
}

/** True when a form on the page asks for a captcha — adapters must stop, not work around it. */
export function hasCaptcha(html: string): boolean {
  return /<(input|img|div)[^>]*(name|id|class|src)=["'][^"']*(captcha|recaptcha|turnstile|hcaptcha)/i.test(stripComments(html));
}

/** Tracks cookies across a short request sequence (session + CSRF). */
export class CookieJar {
  private cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
  get(name: string) {
    return this.cookies.get(name);
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function tables(html: string): string[][][] {
  return [...stripComments(html).matchAll(/<table[\s\S]*?<\/table>/gi)].map(([t]) =>
    [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(([tr]) => [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(([, c]) => textOf(c!))),
  );
}

// Header/label matchers. "Application No" must not count as "applied".
const IS_APPLIED = /\b(applied|bid\s*(qty|quantity)|shares?\s*bid|qty\s*applied|no\.?\s*of\s*shares\s*applied)\b/i;
const IS_ALLOTTED = /\ballot+(ed|ment)\b/i;
const IS_NAME = /\b(name|applicant)\b/i;
const IS_CATEGORY = /\bcateg/i;
const NO_RECORD = /no\s*(record|data|application|details?)s?\s*(found|available|exist)|not\s*found|does\s*not\s*exist|no\s*such/i;

interface Cols { applied?: number; allotted?: number; name?: number; category?: number }

function colsFrom(header: string[]): Cols {
  const c: Cols = {};
  header.forEach((h, i) => {
    if (c.allotted === undefined && IS_ALLOTTED.test(h)) c.allotted = i;
    else if (c.applied === undefined && IS_APPLIED.test(h)) c.applied = i;
    else if (c.name === undefined && IS_NAME.test(h) && !/company|issue/i.test(h)) c.name = i;
    else if (c.category === undefined && IS_CATEGORY.test(h)) c.category = i;
  });
  return c;
}

/** "28" → 28; "Not Allotted" → 0; "Allotted" (no number) → undefined but known positive. */
function allottedCell(v: string | undefined): { qty: number | null; positive?: boolean } {
  if (v == null) return { qty: null };
  const n = toNumber(v.replace(/shares?/i, ""));
  if (n != null) return { qty: n };
  if (/not\s*allot|non[-\s]*allot|rejected|nil/i.test(v)) return { qty: 0 };
  if (/allot/i.test(v)) return { qty: null, positive: true };
  return { qty: null };
}

/**
 * Reads an allotment result out of an HTML page without knowing its exact layout.
 * Understands (a) a table with a header row, one row per application, and
 * (b) label/value tables ("Shares Allotted | 28"). Throws when it can't tell —
 * an unrecognised page must surface as an error, never as a guessed status.
 */
export function parseHtmlAllotment(html: string, label: string): CheckResult {
  const rows: ApplicationRow[] = [];
  let positiveWithoutQty = false;

  for (const t of tables(html)) {
    // (a) header row
    const hi = t.findIndex((r) => r.some((c) => IS_ALLOTTED.test(c)) && r.length > 1 && r.some((c) => IS_APPLIED.test(c) || IS_NAME.test(c)));
    if (hi >= 0) {
      const cols = colsFrom(t[hi]!);
      for (const r of t.slice(hi + 1)) {
        if (!r.length || r.every((c) => !c)) continue;
        const a = allottedCell(r[cols.allotted!]);
        if (a.qty == null && !a.positive) continue;
        positiveWithoutQty ||= !!a.positive;
        rows.push({
          category: cols.category !== undefined ? r[cols.category] || null : null,
          applicantName: cols.name !== undefined ? r[cols.name] || null : null,
          appliedQty: cols.applied !== undefined ? toNumber(r[cols.applied]) : null,
          allottedQty: a.qty,
          price: null,
          amountAdjusted: null,
        });
      }
      if (rows.length) break;
    }
    // (b) label/value pairs anywhere in the table
    const pairs = new Map<string, string>();
    for (const r of t) for (let i = 0; i + 1 < r.length; i += 2) if (r[i]) pairs.set(r[i]!, r[i + 1] ?? "");
    const find = (re: RegExp) => [...pairs].find(([k]) => re.test(k))?.[1];
    const allot = find(IS_ALLOTTED);
    if (allot !== undefined) {
      const a = allottedCell(allot);
      if (a.qty != null || a.positive) {
        positiveWithoutQty ||= !!a.positive;
        rows.push({
          category: find(IS_CATEGORY) || null,
          applicantName: find(IS_NAME) || null,
          appliedQty: toNumber(find(IS_APPLIED)),
          allottedQty: a.qty,
          price: null,
          amountAdjusted: null,
        });
        break;
      }
    }
  }

  if (rows.length) {
    const s = summarize(rows);
    if (positiveWithoutQty && s.status !== "ALLOTTED") s.status = "ALLOTTED";
    return { ...s, message: positiveWithoutQty ? "Allotted (quantity not shown by registrar)" : null };
  }
  const text = textOf(html);
  if (NO_RECORD.test(text)) return { ...summarize([]), message: null };
  throw new Error(`${label}: unrecognised result page — the site layout may have changed`);
}
