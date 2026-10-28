import { describe, expect, it, vi } from "vitest";
import { BigshareAdapter, parseBigshareResponse, parseCompanySelect } from "../src/registrars/bigshare.js";
import { retryAfterMs, request } from "../src/registrars/http.js";
import { KfinAdapter, findBundlePath, parseBundleIpos, parseKfinResponse } from "../src/registrars/kfin.js";
import { RetryableError, type RegistrarAdapter } from "../src/registrars/types.js";
import { checkWithRetry } from "../src/services/jobRunner.js";

type Reply = { status?: number; body: unknown; headers?: Record<string, string> } | Error;
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("http", () => {
  it("parses Retry-After", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("99999")).toBe(300_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("garbage")).toBeUndefined();
  });

  it("carries Retry-After on 429", async () => {
    const { fn } = fakeFetch([{ status: 429, body: "", headers: { "retry-after": "12" } }]);
    const err = await request(fn, "x", "https://e").catch((e) => e);
    expect(err).toBeInstanceOf(RetryableError);
    expect(err.retryAfterMs).toBe(12_000);
  });

  it("checkWithRetry waits at least Retry-After", async () => {
    const waits: number[] = [];
    let n = 0;
    const a: RegistrarAdapter = {
      id: "t", name: "t", minDelayMs: 0, listIpos: async () => [],
      check: async () => {
        if (n++ === 0) throw new RetryableError("slow down", 45_000);
        return parseKfinResponse(null);
      },
    };
    await checkWithRetry(a, "1", "ABCPX1234K", { backoffMs: [1000], sleepFn: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([45_000]);
  });
});

describe("KFin", () => {
  // Shape copied from the live bundle (2026-10-28).
  const BUNDLE = `x=1;rf=JSON.parse('[{"clientId":"78061126051","name":"JIO PLATFORMS LIMITED"},{"clientId":"47651989560","name":"SOLLFEGE SMART ELECTRONICS LIMITED"},{"clientId":"1","name":"O\\'BRIEN SME LTD"}]'),of={a:1}`;
  const INDEX = `<html><head><script defer="defer" src="./static/js/main.bd1f330c.js"></script></head></html>`;

  it("finds the bundle and its IPO list", () => {
    expect(findBundlePath(INDEX)).toBe("static/js/main.bd1f330c.js");
    expect(parseBundleIpos(BUNDLE)).toEqual([
      { registrarIpoId: "78061126051", name: "JIO PLATFORMS LIMITED", isSme: false },
      { registrarIpoId: "47651989560", name: "SOLLFEGE SMART ELECTRONICS LIMITED", isSme: false },
      { registrarIpoId: "1", name: "O'BRIEN SME LTD", isSme: true },
    ]);
    expect(parseBundleIpos("nothing here")).toEqual([]);
  });

  it("parses results", () => {
    expect(parseKfinResponse({ data: [{ Name: "RAVI", App_Shares: "14", All_Shares: "14", category: "RII" }] })).toMatchObject({
      status: "ALLOTTED", appliedQty: 14, allottedQty: 14, applicantName: "RAVI", category: "RII",
    });
    expect(parseKfinResponse({ data: [{ App_Shares: 14, All_Shares: 0 }] })).toMatchObject({ status: "NOT_ALLOTTED", allottedQty: 0 });
    expect(parseKfinResponse({ data: [] }).status).toBe("NOT_APPLIED");
    expect(parseKfinResponse(null).status).toBe("NOT_APPLIED");
  });

  it("sends PAN and IPO id as headers; 404 means not applied", async () => {
    const { fn, calls } = fakeFetch([{ body: { data: [{ App_Shares: "14", All_Shares: "14" }] } }, { status: 404, body: "" }]);
    const k = new KfinAdapter(fn);
    expect((await k.check("78061126051", "ABCPX1234K")).status).toBe("ALLOTTED");
    expect(calls[0]!.url).toMatch(/\/prod\/api\/query\?type=pan$/);
    expect(calls[0]!.init.headers).toMatchObject({ reqparam: "ABCPX1234K", client_id: "78061126051" });
    expect((await k.check("78061126051", "ABCPX1234K")).status).toBe("NOT_APPLIED");
  });

  it("listIpos follows index.html to the bundle", async () => {
    const { fn, calls } = fakeFetch([{ body: INDEX }, { body: BUNDLE }]);
    expect(await new KfinAdapter(fn).listIpos()).toHaveLength(3);
    expect(calls[1]!.url).toBe("https://ipostatus.kfintech.com/static/js/main.bd1f330c.js");
  });
});

describe("Bigshare", () => {
  const PAGE = `<select id="ddllang"><option value="en">ENGLISH</option></select>
    <select id="ddlCompany">
      <option>--Select Company--</option>
      <option value="607">SHELLZ INDIA LIMITED</option>
      <!--<option value="606">ACME INDIA INDUSTRIES LIMITED</option>
      <option value="605">PARAMOUNT SYNTEX LIMITED</option>-->
      <option value="608">R &amp; D SME LIMITED</option>
    </select>`;

  it("reads live companies only, ignoring commented-out ones", () => {
    expect(parseCompanySelect(PAGE)).toEqual([
      { registrarIpoId: "607", name: "SHELLZ INDIA LIMITED", isSme: false },
      { registrarIpoId: "608", name: "R & D SME LIMITED", isSme: true },
    ]);
  });

  it("parses statuses", () => {
    expect(parseBigshareResponse({ Status: "OK", Name: "RAVI", APPLIED: "2000", ALLOTED: "2000", APPLICATION_NO: "1" })).toMatchObject({
      status: "ALLOTTED", appliedQty: 2000, allottedQty: 2000, applicantName: "RAVI",
    });
    expect(parseBigshareResponse({ Status: "OK", APPLIED: "2000", ALLOTED: "0", APPLICATION_NO: "1" }).status).toBe("NOT_ALLOTTED");
    expect(parseBigshareResponse({ Status: "NOTFOUND" }).status).toBe("NOT_APPLIED");
    expect(parseBigshareResponse({ Status: "INVALID", Message: "Invalid input" })).toMatchObject({ status: "ERROR", message: "Invalid input" });
    expect(parseBigshareResponse({ DPID: "Please Enter Valid Pan No" })).toMatchObject({ status: "ERROR" });
  });

  it("sums multiple applications", () => {
    const r = parseBigshareResponse({
      Status: "OK", MatchCount: 2, APPLICATION_NO: "1", APPLIED: "2000", ALLOTED: "0",
      Records: [{ APPLICATION_NO: "1", APPLIED: "2000", ALLOTED: "0" }, { APPLICATION_NO: "2", APPLIED: "2000", ALLOTED: "2000" }],
    });
    expect(r).toMatchObject({ status: "ALLOTTED", appliedQty: 4000, allottedQty: 2000 });
  });

  it("rate limit and warming are retryable with a wait", () => {
    const e = (() => { try { parseBigshareResponse({ Status: "RATELIMIT", Message: "slow" }); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).retryAfterMs).toBe(60_000);
    expect(() => parseBigshareResponse({ Status: "WARMING" })).toThrow(RetryableError);
  });

  it("posts a PAN search", async () => {
    const { fn, calls } = fakeFetch([{ body: { d: { Status: "NOTFOUND" } } }]);
    expect((await new BigshareAdapter(fn).check("607", "ABCPX1234K")).status).toBe("NOT_APPLIED");
    expect(calls[0]!.url).toBe("https://ipo.bigshareonline.com/Data.aspx/FetchIpodetails");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ Company: "607", SelectionType: "PN", PanNo: "ABCPX1234K" });
  });
});
