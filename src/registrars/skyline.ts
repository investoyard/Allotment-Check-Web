import { request, USER_AGENT, type Fetch } from "./http.js";
import { CookieJar, hasCaptcha, inputValue, parseHtmlAllotment, selectOptions } from "./html.js";
import type { CheckResult, IpoRef, RegistrarAdapter } from "./types.js";

// Skyline Financial Services — https://www.skylinerta.com/ipo.php (server-rendered PHP).
//   IPO list:  <select id="company"> on ipo.php
//   Step 1:    POST display_application.php  company=<id>   → PHPSESSID cookie + csrf_token in the form
//   Step 2:    POST display_application.php  pan=…&csrf_token=…&company=<id>&action=search → HTML result
// No captcha. The result page layout hasn't been seen with a real PAN yet, so it's parsed
// generically; anything unrecognised is reported as an error rather than guessed.

const BASE = "https://www.skylinerta.com";
const FORM = { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html", "User-Agent": USER_AGENT };

export class SkylineAdapter implements RegistrarAdapter {
  id = "skyline";
  name = "Skyline Financial Services (beta)";
  minDelayMs = 1500;

  constructor(private readonly fetchFn: Fetch = fetch) {}

  async listIpos(): Promise<IpoRef[]> {
    const res = await request(this.fetchFn, "Skyline page", `${BASE}/ipo.php`, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
    return selectOptions(await res.text(), "company");
  }

  async check(registrarIpoId: string, pan: string): Promise<CheckResult> {
    const jar = new CookieJar();
    const step1 = await request(this.fetchFn, "Skyline form", `${BASE}/display_application.php`, {
      method: "POST",
      headers: { ...FORM, Referer: `${BASE}/ipo.php` },
      body: new URLSearchParams({ company: registrarIpoId }).toString(),
      redirect: "manual",
    });
    jar.absorb(step1);
    const form = await step1.text();
    if (hasCaptcha(form)) throw new Error("Skyline now shows a captcha — automatic checks are disabled for this registrar");
    const csrf = inputValue(form, "csrf_token");
    if (!csrf) throw new Error("Skyline: search form not found — the site layout may have changed");

    const res = await request(this.fetchFn, "Skyline search", `${BASE}/display_application.php`, {
      method: "POST",
      headers: { ...FORM, Referer: `${BASE}/display_application.php`, Cookie: jar.header() },
      body: new URLSearchParams({ client_id: "", application_no: "", pan, csrf_token: csrf, company: registrarIpoId, action: "search" }).toString(),
    });
    return parseHtmlAllotment(await res.text(), "Skyline");
  }
}
