import { createCipheriv } from "node:crypto";
import { readJson, request, USER_AGENT, type Fetch } from "./http.js";
import { RetryableError, summarize, toNumber, type ApplicationRow, type CheckResult, type IpoRef, type RegistrarAdapter } from "./types.js";
import { dataSetRows } from "./xml.js";

// MUFG Intime (formerly Link Intime) — https://in.mpms.mufg.com/Initial_Offer/public-issues.html
// The page calls three ASP.NET page methods:
//   GetDetails     → IPOs currently open for status check
//   generateToken  → one-time token, which the page AES-encrypts with a key in its own JS
//   SearchOnPan    → application rows for (IPO, PAN, token)
// The captcha on that page is currently disabled in their script; if they turn it back on,
// SearchOnPan will start returning a Table1/Msg error and this adapter will report it.

const BASE = "https://in.mpms.mufg.com/Initial_Offer";
const PAGE = `${BASE}/public-issues.html`;

// Same key/IV the page uses in encVal() — not a secret, it's shipped to every browser.
const TOKEN_KEY = Buffer.from("8080808080808080", "utf8");

export function encryptToken(token: string): string {
  const cipher = createCipheriv("aes-128-cbc", TOKEN_KEY, TOKEN_KEY);
  return Buffer.concat([cipher.update(token, "utf8"), cipher.final()]).toString("base64");
}

/** Converts SearchOnPan's XML into a result. Exported for tests. */
export function parseSearchResponse(xml: string): CheckResult {
  const messages = dataSetRows(xml, "Table1").map((r) => r.Msg).filter(Boolean);
  if (messages.length) {
    const msg = messages.join("; ");
    // Token/session problems clear up on a retry with a fresh token.
    if (/token|session|expired|try again/i.test(msg)) throw new RetryableError(msg);
    return { ...summarize([]), status: "ERROR", message: msg };
  }
  const rows: ApplicationRow[] = dataSetRows(xml, "Table").map((r) => ({
    category: r.PEMNDG || null,
    applicantName: r.NAME1 || null,
    appliedQty: toNumber(r.SHARES),
    allottedQty: toNumber(r.ALLOT),
    price: toNumber(r.offer_price),
    amountAdjusted: toNumber(r.AMTADJ),
  }));
  return { ...summarize(rows), message: null };
}

export function parseIpoList(xml: string): IpoRef[] {
  return dataSetRows(xml, "Table")
    .filter((r) => r.company_id)
    .map((r) => {
      const name = (r.companyname ?? "").replace(/\s+/g, " ").trim();
      return { registrarIpoId: r.company_id!, name, isSme: /\bSME\b/i.test(name) };
    });
}

export class MufgIntimeAdapter implements RegistrarAdapter {
  id = "mufg";
  name = "MUFG Intime (Link Intime)";
  minDelayMs = 800;
  private cookie: string | null = null;

  constructor(private readonly fetchFn: Fetch = fetch) {}

  private async call(method: string, body: object = {}): Promise<string> {
    const label = `MUFG ${method}`;
    const res = await request(this.fetchFn, label, `${BASE}/IPO.aspx/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: PAGE,
        Origin: "https://in.mpms.mufg.com",
        "User-Agent": USER_AGENT,
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    const session = res.headers.get("set-cookie")?.match(/ASP\.NET_SessionId=[^;]+/)?.[0];
    if (session) this.cookie = session;

    const json = await readJson<{ d?: unknown }>(res, label);
    if (typeof json.d !== "string") throw new RetryableError(`${label}: unexpected response shape`);
    return json.d;
  }

  async listIpos(): Promise<IpoRef[]> {
    return parseIpoList(await this.call("GetDetails"));
  }

  async check(registrarIpoId: string, pan: string): Promise<CheckResult> {
    const token = await this.call("generateToken");
    const xml = await this.call("SearchOnPan", {
      clientid: registrarIpoId,
      PAN: pan,
      IFSC: "",
      CHKVAL: "1", // 1 = search by PAN
      token: encryptToken(token),
    });
    return parseSearchResponse(xml);
  }
}
