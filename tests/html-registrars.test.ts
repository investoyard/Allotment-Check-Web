import { describe, expect, it, vi } from "vitest";
import { CookieJar, hasCaptcha, inputValue, parseHtmlAllotment, selectOptions } from "../src/registrars/html.js";
import { MaashitlaAdapter, parseMaashitla } from "../src/registrars/maashitla.js";
import { PurvaAdapter } from "../src/registrars/purva.js";
import { SkylineAdapter } from "../src/registrars/skyline.js";

type Reply = { status?: number; body: string; headers?: [string, string][] };
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies.shift()!;
    return new Response(r.body, { status: r.status ?? 200, headers: new Headers(r.headers ?? []) });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("html helpers", () => {
  it("reads select options, skipping placeholders and comments", () => {
    const html = `<select name="company" id="company"><option value="">--Select--</option><OPTION value="3418">ACETECH E-COMMERCE LIMITED</OPTION>
      <!--<option value="1">OLD LTD</option>--><option value="2">R &amp; D SME LIMITED</option></select>`;
    expect(selectOptions(html, "company")).toEqual([
      { registrarIpoId: "3418", name: "ACETECH E-COMMERCE LIMITED", isSme: false },
      { registrarIpoId: "2", name: "R & D SME LIMITED", isSme: true },
    ]);
  });

  it("reads inputs, cookies and spots captchas", () => {
    expect(inputValue(`<input type="hidden" name="csrf_token" value="abc123">`, "csrf_token")).toBe("abc123");
    expect(hasCaptcha(`<img id="imgCaptcha" src="GenerateCaptcha.aspx">`)).toBe(true);
    expect(hasCaptcha(`<input name="pan"><!-- <input name="captcha"> -->`)).toBe(false);
    const jar = new CookieJar();
    jar.absorb(new Response("", { headers: new Headers([["set-cookie", "PHPSESSID=s1; path=/"], ["set-cookie", "csrftoken=t2; Max-Age=1"]]) }));
    expect(jar.header()).toBe("PHPSESSID=s1; csrftoken=t2");
  });
});

describe("parseHtmlAllotment", () => {
  it("header-row table, one row per application", () => {
    const html = `<table><tr><th>Application No</th><th>Name</th><th>Shares Applied</th><th>Shares Allotted</th></tr>
      <tr><td>123</td><td>RAVI SHARMA</td><td>1,200</td><td>1,200</td></tr></table>`;
    expect(parseHtmlAllotment(html, "x")).toMatchObject({ status: "ALLOTTED", appliedQty: 1200, allottedQty: 1200, applicantName: "RAVI SHARMA" });
  });

  it("label/value table", () => {
    const html = `<table><tr><td>Applicant Name</td><td>ASHA</td></tr><tr><td>No. of Shares Applied</td><td>2000</td></tr>
      <tr><td>Shares Allotted</td><td>0</td></tr></table>`;
    expect(parseHtmlAllotment(html, "x")).toMatchObject({ status: "NOT_ALLOTTED", appliedQty: 2000, allottedQty: 0, applicantName: "ASHA" });
  });

  it("text-only allotment status", () => {
    const html = `<table><tr><th>Name</th><th>Allotment Status</th></tr><tr><td>OM</td><td>Not Allotted</td></tr></table>`;
    expect(parseHtmlAllotment(html, "x")).toMatchObject({ status: "NOT_ALLOTTED", allottedQty: 0 });
    const yes = `<table><tr><th>Name</th><th>Allotment Status</th></tr><tr><td>OM</td><td>Allotted</td></tr></table>`;
    expect(parseHtmlAllotment(yes, "x")).toMatchObject({ status: "ALLOTTED", message: expect.stringMatching(/quantity not shown/) });
  });

  it("no record, and unknown pages throw instead of guessing", () => {
    expect(parseHtmlAllotment(`<p style="color:red">No Record Found!</p><table><tr><td>PAN</td></tr></table>`, "x").status).toBe("NOT_APPLIED");
    expect(() => parseHtmlAllotment(`<html><body>Welcome</body></html>`, "Skyline")).toThrow(/unrecognised result page/);
  });
});

describe("Maashitla", () => {
  it("parses results", () => {
    expect(parseMaashitla({ name: "RAVI", shares_applied: "2000", shares_allotted: "2000" })).toMatchObject({ status: "ALLOTTED", allottedQty: 2000 });
    expect(parseMaashitla({ name: "RAVI", shares_applied: "2000" })).toMatchObject({ status: "NOT_ALLOTTED", allottedQty: 0 });
    expect(parseMaashitla({ name: null }).status).toBe("NOT_APPLIED");
    expect(parseMaashitla(null).status).toBe("NOT_APPLIED");
  });

  it("lists by slug and looks up by slug + pan; 404 = not applied", async () => {
    const { fn, calls } = fakeFetch([
      { body: JSON.stringify({ companies: [{ company_name: "DUDANI RETAIL LIMITED", company_slug: "dudani-retail-limited" }] }) },
      { status: 404, body: "" },
    ]);
    const m = new MaashitlaAdapter(fn);
    expect(await m.listIpos()).toEqual([{ registrarIpoId: "dudani-retail-limited", name: "DUDANI RETAIL LIMITED", isSme: false }]);
    expect((await m.check("dudani-retail-limited", "ABCPX1234K")).status).toBe("NOT_APPLIED");
    expect(calls[1]!.url).toBe("https://pnjbvxj6md.execute-api.ap-south-1.amazonaws.com/prod/check/dudani-retail-limited?pan=ABCPX1234K");
  });
});

describe("Skyline", () => {
  const FORM = `<form name="display_application"><input type="hidden" name="csrf_token" value="${"a".repeat(64)}"><input name="pan"></form>`;
  it("gets session + csrf, then searches", async () => {
    const { fn, calls } = fakeFetch([
      { body: FORM, headers: [["set-cookie", "PHPSESSID=sess1; path=/"]] },
      { body: `<table><tr><th>Name</th><th>Applied</th><th>Allotted</th></tr><tr><td>X</td><td>1600</td><td>1600</td></tr></table>` },
    ]);
    expect((await new SkylineAdapter(fn).check("3418", "ABCPX1234K")).status).toBe("ALLOTTED");
    expect(calls[0]!.init.body).toBe("company=3418");
    const body = new URLSearchParams(calls[1]!.init.body as string);
    expect(Object.fromEntries(body)).toMatchObject({ pan: "ABCPX1234K", company: "3418", action: "search", csrf_token: "a".repeat(64) });
    expect((calls[1]!.init.headers as Record<string, string>).Cookie).toBe("PHPSESSID=sess1");
  });

  it("stops if a captcha appears", async () => {
    const { fn } = fakeFetch([{ body: `${FORM}<img src="captcha.php">` }]);
    await expect(new SkylineAdapter(fn).check("3418", "ABCPX1234K")).rejects.toThrow(/captcha/);
  });
});

describe("Purva", () => {
  const PAGE = `<form method="post"><input type="hidden" name="csrfmiddlewaretoken" value="tok"><select name="company_id" id="company_id">
    <option value="">Select</option><option value="93">Dove Soft Ltd</option></select></form>`;
  it("lists companies and posts with the Django CSRF token, cookie and referer", async () => {
    const { fn, calls } = fakeFetch([
      { body: PAGE },
      { body: PAGE, headers: [["set-cookie", "csrftoken=ck; Path=/"]] },
      { body: `<div class="notification-banner">No records found</div>` },
    ]);
    const p = new PurvaAdapter(fn);
    expect(await p.listIpos()).toEqual([{ registrarIpoId: "93", name: "Dove Soft Ltd", isSme: false }]);
    expect((await p.check("93", "ABCPX1234K")).status).toBe("NOT_APPLIED");
    const h = calls[2]!.init.headers as Record<string, string>;
    expect(h.Cookie).toBe("csrftoken=ck");
    expect(h.Referer).toMatch(/ipo-query$/);
    expect(Object.fromEntries(new URLSearchParams(calls[2]!.init.body as string))).toEqual({
      csrfmiddlewaretoken: "tok", company_id: "93", applicationNumber: "", panNumber: "ABCPX1234K",
    });
  });
});
