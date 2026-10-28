import { createCipheriv } from "node:crypto";
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
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

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

type Fetch = typeof fetch;

export class MufgIntimeAdapter implements RegistrarAdapter {
  id = "mufg";
  name = "MUFG Intime (Link Intime)";
  minDelayMs = 800;
  private cookie: string | null = null;

  constructor(private readonly fetchFn: Fetch = fetch, private readonly timeoutMs = 20_000) {}

  private async call(method: string, body: object = {}): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(`${BASE}/IPO.aspx/${method}`, {
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RetryableError(`MUFG ${method}: ${(err as Error).message}`);
    }
    const setCookie = res.headers.get("set-cookie");
    const session = setCookie?.match(/ASP\.NET_SessionId=[^;]+/)?.[0];
    if (session) this.cookie = session;

    if (res.status >= 500 || res.status === 429) throw new RetryableError(`MUFG ${method}: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`MUFG ${method}: HTTP ${res.status}`);
    let json: { d?: unknown };
    try {
      json = (await res.json()) as { d?: unknown };
    } catch {
      // Overloaded registrar sites often return an HTML error page with 200.
      throw new RetryableError(`MUFG ${method}: unexpected non-JSON response`);
    }
    if (typeof json.d !== "string") throw new RetryableError(`MUFG ${method}: unexpected response shape`);
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
