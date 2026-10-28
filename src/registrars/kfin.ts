import { readJson, request, USER_AGENT, type Fetch } from "./http.js";
import { summarize, toNumber, type ApplicationRow, type CheckResult, type IpoRef, type RegistrarAdapter } from "./types.js";

// KFin Technologies — https://ipostatus.kfintech.com/
// A React app. The IPO list is a JSON literal inside its main bundle (the bundle file name
// changes on every deploy, so we find it from index.html). The status lookup is
//   GET <API>?type=pan   with headers  reqparam: <PAN>, client_id: <IPO clientId>
// and returns { data: [ { Appln_No, Name, DP_CLID, Pan_No, App_Shares, All_Shares, category } ] }.
// 404 means no application found. No captcha.

const SITE = "https://ipostatus.kfintech.com/";
const API = "https://0uz601ms56.execute-api.ap-south-1.amazonaws.com/prod/api/query";

interface KfinRow {
  Appln_No?: string;
  Name?: string;
  App_Shares?: string | number;
  All_Shares?: string | number;
  category?: string;
}

const str = (v: unknown) => (v == null ? null : String(v));

/** Finds the main bundle path in KFin's index.html. */
export function findBundlePath(html: string): string | null {
  return html.match(/src="\.?\/?(static\/js\/main\.[\w]+\.js)"/)?.[1] ?? null;
}

/** Pulls the IPO list out of the bundle: JSON.parse('[{"clientId":"…","name":"…"}, …]'). */
export function parseBundleIpos(js: string): IpoRef[] {
  const m = js.match(/JSON\.parse\('(\[\{"clientId"[\s\S]*?\}\])'\)/);
  if (!m) return [];
  const json = m[1]!.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  const list = JSON.parse(json) as { clientId: string; name: string }[];
  return list.map((i) => {
    const name = i.name.replace(/\s+/g, " ").trim();
    return { registrarIpoId: String(i.clientId), name, isSme: /\bSME\b/i.test(name) };
  });
}

export function parseKfinResponse(body: { data?: KfinRow[] } | null): CheckResult {
  const rows: ApplicationRow[] = (body?.data ?? []).map((r) => ({
    category: r.category?.trim() || null,
    applicantName: r.Name?.trim() || null,
    appliedQty: toNumber(str(r.App_Shares)),
    allottedQty: toNumber(str(r.All_Shares)),
    price: null,
    amountAdjusted: null,
  }));
  return { ...summarize(rows), message: null };
}

export class KfinAdapter implements RegistrarAdapter {
  id = "kfin";
  name = "KFin Technologies";
  minDelayMs = 1000;

  constructor(private readonly fetchFn: Fetch = fetch) {}

  private headers(extra: Record<string, string> = {}) {
    return { "User-Agent": USER_AGENT, Accept: "application/json, text/plain, */*", Origin: "https://ipostatus.kfintech.com", Referer: SITE, ...extra };
  }

  async listIpos(): Promise<IpoRef[]> {
    const html = await (await request(this.fetchFn, "KFin index", SITE, { headers: this.headers({ Accept: "text/html" }) })).text();
    const bundle = findBundlePath(html);
    if (!bundle) throw new Error("KFin: couldn't find the app bundle — the site layout may have changed");
    const js = await (await request(this.fetchFn, "KFin bundle", new URL(bundle, SITE).href, { headers: this.headers({ Accept: "*/*" }) })).text();
    const ipos = parseBundleIpos(js);
    if (!ipos.length) throw new Error("KFin: IPO list not found in the app bundle — the site may have changed");
    return ipos;
  }

  async check(registrarIpoId: string, pan: string): Promise<CheckResult> {
    const res = await request(this.fetchFn, "KFin query", `${API}?type=pan`, {
      headers: this.headers({ reqparam: pan, client_id: registrarIpoId }),
      okStatuses: [404],
    });
    if (res.status === 404) return parseKfinResponse(null);
    return parseKfinResponse(await readJson<{ data?: KfinRow[] }>(res, "KFin query"));
  }
}
