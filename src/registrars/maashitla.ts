import { readJson, request, USER_AGENT, type Fetch } from "./http.js";
import { summarize, toNumber, type CheckResult, type IpoRef, type RegistrarAdapter } from "./types.js";

// Maashitla Securities — https://maashitla.com/allotment-status/public-issues (React app).
//   IPO list:  GET https://api.maashitla.com/api/company-directory → { companies: [{ company_name, company_slug }] }
//   Lookup:    GET <API>/check/<slug>?pan=<PAN> → { name, shares_applied, shares_allotted }
//              404, or name == null → no application. No captcha, no token.

const LIST = "https://api.maashitla.com/api/company-directory";
const CHECK = "https://pnjbvxj6md.execute-api.ap-south-1.amazonaws.com/prod/check";
const HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json", Origin: "https://maashitla.com", Referer: "https://maashitla.com/" };

interface MaashitlaResult {
  name?: string | null;
  shares_applied?: string | number | null;
  shares_allotted?: string | number | null;
}

export function parseMaashitla(body: MaashitlaResult | null): CheckResult {
  if (!body || body.name == null) return { ...summarize([]), message: null };
  const row = {
    category: null,
    applicantName: String(body.name).trim() || null,
    appliedQty: toNumber(String(body.shares_applied ?? "0")),
    allottedQty: toNumber(String(body.shares_allotted ?? "0")),
    price: null,
    amountAdjusted: null,
  };
  return { ...summarize([row]), message: null };
}

export class MaashitlaAdapter implements RegistrarAdapter {
  id = "maashitla";
  name = "Maashitla Securities";
  minDelayMs = 1000;

  constructor(private readonly fetchFn: Fetch = fetch) {}

  async listIpos(): Promise<IpoRef[]> {
    const res = await request(this.fetchFn, "Maashitla list", LIST, { headers: HEADERS });
    const { companies = [] } = await readJson<{ companies?: { company_name: string; company_slug: string }[] }>(res, "Maashitla list");
    return companies
      .filter((c) => c.company_slug)
      .map((c) => {
        const name = c.company_name.replace(/\s+/g, " ").trim();
        return { registrarIpoId: c.company_slug, name, isSme: /\bSME\b/i.test(name) };
      });
  }

  async check(registrarIpoId: string, pan: string): Promise<CheckResult> {
    const url = `${CHECK}/${encodeURIComponent(registrarIpoId)}?${new URLSearchParams({ pan })}`;
    const res = await request(this.fetchFn, "Maashitla lookup", url, { headers: HEADERS, okStatuses: [404] });
    if (res.status === 404) return parseMaashitla(null);
    return parseMaashitla(await readJson<MaashitlaResult>(res, "Maashitla lookup"));
  }
}
