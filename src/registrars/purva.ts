import { request, USER_AGENT, type Fetch } from "./http.js";
import { CookieJar, hasCaptcha, inputValue, parseHtmlAllotment, selectOptions } from "./html.js";
import type { CheckResult, IpoRef, RegistrarAdapter } from "./types.js";

// Purva Sharegistry — https://www.purvashare.com/investor-service/ipo-query (Django).
//   IPO list:  <select id="company_id"> on the page
//   Lookup:    GET the page (csrftoken cookie + csrfmiddlewaretoken), then POST
//              csrfmiddlewaretoken=…&company_id=<id>&applicationNumber=&panNumber=<PAN> → HTML result
// No captcha today (the page CSS hints one existed before; we stop if one appears).
// Result layout not yet seen with a real PAN, so it's parsed generically.

const PAGE = "https://www.purvashare.com/investor-service/ipo-query";

export class PurvaAdapter implements RegistrarAdapter {
  id = "purva";
  name = "Purva Sharegistry (beta)";
  minDelayMs = 1500;

  constructor(private readonly fetchFn: Fetch = fetch) {}

  private async page(jar?: CookieJar) {
    const res = await request(this.fetchFn, "Purva page", PAGE, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
    jar?.absorb(res);
    return res.text();
  }

  async listIpos(): Promise<IpoRef[]> {
    return selectOptions(await this.page(), "company_id");
  }

  async check(registrarIpoId: string, pan: string): Promise<CheckResult> {
    const jar = new CookieJar();
    const html = await this.page(jar);
    if (hasCaptcha(html)) throw new Error("Purva now shows a captcha — automatic checks are disabled for this registrar");
    const token = inputValue(html, "csrfmiddlewaretoken");
    if (!token) throw new Error("Purva: search form not found — the site layout may have changed");

    const res = await request(this.fetchFn, "Purva search", PAGE, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": USER_AGENT,
        Referer: PAGE,
        Origin: "https://www.purvashare.com",
        Cookie: jar.header(),
      },
      body: new URLSearchParams({ csrfmiddlewaretoken: token, company_id: registrarIpoId, applicationNumber: "", panNumber: pan }).toString(),
    });
    return parseHtmlAllotment(await res.text(), "Purva");
  }
}
