import { readJson, request, USER_AGENT, type Fetch } from "./http.js";
import { RetryableError, summarize, toNumber, type ApplicationRow, type CheckResult, type IpoRef, type RegistrarAdapter } from "./types.js";

// Bigshare Services — https://ipo.bigshareonline.com/IPO_Status.html
// The IPO list is the <select id="ddlCompany"> in the page itself (old IPOs are commented out).
// The lookup is POST Data.aspx/FetchIpodetails, returning d: { Status, Message, Name, APPLIED,
// ALLOTED, MatchCount, Records[] }. Status is OK / NOTFOUND / RATELIMIT / WARMING / other error.
// No captcha, but the server rate-limits per IP (429 + Retry-After), so we go slowly.

const BASE = "https://ipo.bigshareonline.com";
const PAGE = `${BASE}/IPO_Status.html`;

interface BigshareRecord {
  APPLICATION_NO?: string;
  Name?: string;
  APPLIED?: string;
  ALLOTED?: string;
}
interface BigshareResponse extends BigshareRecord {
  Status?: string;
  Message?: string;
  DPID?: string;
  MatchCount?: number;
  Records?: BigshareRecord[];
}

const decodeHtml = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function parseCompanySelect(html: string): IpoRef[] {
  const select = html.replace(/<!--[\s\S]*?-->/g, "").match(/<select[^>]*id="ddlCompany"[^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (!select) return [];
  return [...select.matchAll(/<option[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi)].map(([, id, label]) => {
    const name = decodeHtml(label!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    return { registrarIpoId: id!.trim(), name, isSme: /\bSME\b/i.test(name) };
  });
}

// Old-style responses signal input errors through the DPID field.
const DPID_ERRORS = /^Please Enter Valid/i;

export function parseBigshareResponse(d: BigshareResponse): CheckResult {
  const status = d.Status?.toUpperCase();
  if (status === "RATELIMIT") throw new RetryableError(`Bigshare: ${d.Message || "rate limited"}`, 60_000);
  if (status === "WARMING") throw new RetryableError(`Bigshare: ${d.Message || "service warming up"}`, 15_000);
  if (status === "NOTFOUND") return { ...summarize([]), message: null };
  if (status && status !== "OK") return { ...summarize([]), status: "ERROR", message: d.Message || `Bigshare status ${status}` };
  if (d.DPID && DPID_ERRORS.test(d.DPID)) return { ...summarize([]), status: "ERROR", message: d.DPID };

  const records = d.MatchCount && d.MatchCount > 1 && d.Records?.length ? d.Records : [d];
  const rows: ApplicationRow[] = records
    .filter((r) => r.APPLICATION_NO || r.APPLIED || r.ALLOTED)
    .map((r) => ({
      category: null,
      applicantName: r.Name?.trim() || null,
      appliedQty: toNumber(r.APPLIED),
      allottedQty: toNumber(r.ALLOTED),
      price: null,
      amountAdjusted: null,
    }));
  return { ...summarize(rows), message: null };
}

export class BigshareAdapter implements RegistrarAdapter {
  id = "bigshare";
  name = "Bigshare Services";
  // Their server enforces a per-IP limit; stay well under it.
  minDelayMs = 3000;

  constructor(private readonly fetchFn: Fetch = fetch) {}

  async listIpos(): Promise<IpoRef[]> {
    const res = await request(this.fetchFn, "Bigshare page", PAGE, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
    return parseCompanySelect(await res.text());
  }

  async check(registrarIpoId: string, pan: string): Promise<CheckResult> {
    const res = await request(this.fetchFn, "Bigshare lookup", `${BASE}/Data.aspx/FetchIpodetails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Origin: BASE,
        Referer: PAGE,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        Applicationno: "",
        Company: registrarIpoId,
        SelectionType: "PN",
        PanNo: pan,
        txtcsdl: "",
        txtDPID: "",
        txtClId: "",
        ddlType: "0",
        lang: "en",
      }),
    });
    const json = await readJson<{ d?: BigshareResponse }>(res, "Bigshare lookup");
    if (!json.d || typeof json.d !== "object") throw new RetryableError("Bigshare lookup: unexpected response shape");
    return parseBigshareResponse(json.d);
  }
}
