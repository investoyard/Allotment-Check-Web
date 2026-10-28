import { createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MufgIntimeAdapter, encryptToken, parseIpoList, parseSearchResponse } from "../src/registrars/mufg.js";
import { RetryableError, type RegistrarAdapter } from "../src/registrars/types.js";
import { dataSetRows } from "../src/registrars/xml.js";
import { checkWithRetry } from "../src/services/jobRunner.js";

// Shape copied from a real GetDetails response (2026-10-28).
const IPO_LIST_XML = `<NewDataSet>\r\n  <Table>\r\n    <company_id>11968</company_id>\r\n    <companyname>Paras Healthcare Limited - IPO</companyname>\r\n  </Table>\r\n  <Table>\r\n    <company_id>11965</company_id>\r\n    <companyname>Ravita Engineering Services Limited - SME IPO</companyname>\r\n  </Table>\r\n  <Table>\r\n    <company_id>11966</company_id>\r\n    <companyname>Sahajanand Medical Technologies Limited -  IPO</companyname>\r\n  </Table>\r\n</NewDataSet>`;

// Field names as used by the site's onDataBindPAN().
const row = (f: Record<string, string>) => `<Table>${Object.entries(f).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</Table>`;
const ALLOTTED_XML = `<NewDataSet>${row({ PEMNDG: "RETAIL", NAME1: "RAVI SHARMA", SHARES: "28", offer_price: "540.00", ALLOT: "28", AMTADJ: "15120.00", RFNDAMT: "0" })}</NewDataSet>`;
const TWO_CATEGORIES_XML = `<NewDataSet>${row({ PEMNDG: "RETAIL", NAME1: "A &amp; B", SHARES: "28", ALLOT: "0", offer_price: "540", AMTADJ: "0" })}${row({ PEMNDG: "SHAREHOLDER", NAME1: "A &amp; B", SHARES: "28", ALLOT: "28", offer_price: "540", AMTADJ: "15,120" })}</NewDataSet>`;
const NOT_ALLOTTED_XML = `<NewDataSet>${row({ PEMNDG: "RETAIL", NAME1: "X", SHARES: "28", ALLOT: "0", offer_price: "540", AMTADJ: "0" })}</NewDataSet>`;
const EMPTY_XML = `<NewDataSet />`;
const MSG_XML = (m: string) => `<NewDataSet><Table1><Msg>${m}</Msg></Table1></NewDataSet>`;

describe("xml", () => {
  it("parses DataSet rows, entities and empty elements", () => {
    expect(dataSetRows("<NewDataSet><Table><a>1 &amp; 2</a><b /><c>&#x41;</c></Table></NewDataSet>", "Table")).toEqual([{ a: "1 & 2", b: "", c: "A" }]);
    expect(dataSetRows("<NewDataSet><Table1><Msg>x</Msg></Table1></NewDataSet>", "Table")).toEqual([]);
  });
});

describe("MUFG parsing", () => {
  it("parses the IPO list and flags SME", () => {
    expect(parseIpoList(IPO_LIST_XML)).toEqual([
      { registrarIpoId: "11968", name: "Paras Healthcare Limited - IPO", isSme: false },
      { registrarIpoId: "11965", name: "Ravita Engineering Services Limited - SME IPO", isSme: true },
      { registrarIpoId: "11966", name: "Sahajanand Medical Technologies Limited - IPO", isSme: false },
    ]);
  });

  it("allotted", () => {
    expect(parseSearchResponse(ALLOTTED_XML)).toMatchObject({
      status: "ALLOTTED", appliedQty: 28, allottedQty: 28, price: 540, amountAdjusted: 15120, category: "RETAIL", applicantName: "RAVI SHARMA",
    });
  });

  it("sums multiple categories", () => {
    expect(parseSearchResponse(TWO_CATEGORIES_XML)).toMatchObject({
      status: "ALLOTTED", appliedQty: 56, allottedQty: 28, amountAdjusted: 15120, category: "RETAIL, SHAREHOLDER", applicantName: "A & B",
    });
  });

  it("not allotted / not applied", () => {
    expect(parseSearchResponse(NOT_ALLOTTED_XML)).toMatchObject({ status: "NOT_ALLOTTED", allottedQty: 0 });
    expect(parseSearchResponse(EMPTY_XML)).toMatchObject({ status: "NOT_APPLIED", rows: [] });
  });

  it("site messages: token problems retry, others are errors", () => {
    expect(() => parseSearchResponse(MSG_XML("Invalid Token"))).toThrow(RetryableError);
    expect(parseSearchResponse(MSG_XML("Allotment not yet finalised"))).toMatchObject({ status: "ERROR", message: "Allotment not yet finalised" });
  });

  it("encrypts the token the same way the page's CryptoJS does", () => {
    const enc = encryptToken("592556110");
    const key = Buffer.from("8080808080808080");
    const d = createDecipheriv("aes-128-cbc", key, key);
    expect(Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString()).toBe("592556110");
    // Known value: CryptoJS.AES.encrypt("592556110", key, {iv, CBC, Pkcs7}).toString()
    expect(enc).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("MufgIntimeAdapter", () => {
  function fakeFetch(responses: Array<{ status?: number; body: unknown; cookie?: string } | Error>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      const headers = new Headers({ "content-type": "application/json" });
      if (r.cookie) headers.set("set-cookie", r.cookie);
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers });
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("gets a token, keeps the session cookie and posts the search", async () => {
    const { fn, calls } = fakeFetch([
      { body: { d: "123456" }, cookie: "ASP.NET_SessionId=abc123; path=/; HttpOnly" },
      { body: { d: ALLOTTED_XML } },
    ]);
    const result = await new MufgIntimeAdapter(fn).check("11968", "ABCPX1234K");
    expect(result.status).toBe("ALLOTTED");
    expect(calls[0]!.url).toMatch(/IPO\.aspx\/generateToken$/);
    expect(calls[1]!.url).toMatch(/IPO\.aspx\/SearchOnPan$/);
    expect((calls[1]!.init.headers as Record<string, string>).Cookie).toBe("ASP.NET_SessionId=abc123");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      clientid: "11968", PAN: "ABCPX1234K", IFSC: "", CHKVAL: "1", token: encryptToken("123456"),
    });
  });

  it("treats network errors, 5xx and HTML pages as retryable; 4xx as fatal", async () => {
    await expect(new MufgIntimeAdapter(fakeFetch([new TypeError("fetch failed")]).fn).listIpos()).rejects.toThrow(RetryableError);
    await expect(new MufgIntimeAdapter(fakeFetch([{ status: 503, body: "busy" }]).fn).listIpos()).rejects.toThrow(RetryableError);
    await expect(new MufgIntimeAdapter(fakeFetch([{ body: "<html>Server Error</html>" }]).fn).listIpos()).rejects.toThrow(RetryableError);
    const fatal = new MufgIntimeAdapter(fakeFetch([{ status: 403, body: "no" }]).fn).listIpos();
    await expect(fatal).rejects.toThrow("HTTP 403");
    await expect(fatal).rejects.not.toBeInstanceOf(RetryableError);
  });
});

describe("isTransientDbError", () => {
  it("retries connection-level errors only", async () => {
    const { isTransientDbError } = await import("../src/services/jobRunner.js");
    const { Prisma } = await import("@prisma/client");
    expect(isTransientDbError(new Prisma.PrismaClientUnknownRequestError("Response from the Engine was empty", { clientVersion: "6" }))).toBe(true);
    expect(isTransientDbError(new Prisma.PrismaClientKnownRequestError("timeout", { code: "P2024", clientVersion: "6" }))).toBe(true);
    expect(isTransientDbError(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "6" }))).toBe(false);
    expect(isTransientDbError(new Error("HTTP 403"))).toBe(false);
  });
});

describe("checkWithRetry", () => {
  const adapter = (impl: RegistrarAdapter["check"]): RegistrarAdapter => ({ id: "t", name: "t", minDelayMs: 0, listIpos: async () => [], check: impl });
  const noSleep = { backoffMs: [1, 1, 1], sleepFn: async () => {} };

  it("retries transient errors then succeeds", async () => {
    let n = 0;
    const a = adapter(async () => {
      if (++n < 3) throw new RetryableError("busy");
      return parseSearchResponse(NOT_ALLOTTED_XML);
    });
    const { result, attempts } = await checkWithRetry(a, "1", "ABCPX1234K", noSleep);
    expect(result.status).toBe("NOT_ALLOTTED");
    expect(attempts).toBe(3);
  });

  it("gives up after the backoff list and scrubs the PAN from messages", async () => {
    const a = adapter(async (_id, pan) => {
      throw new RetryableError(`timeout for ${pan}`);
    });
    const { result, attempts } = await checkWithRetry(a, "1", "ABCPX1234K", noSleep);
    expect(attempts).toBe(4);
    expect(result).toMatchObject({ status: "ERROR", message: "timeout for **********" });
  });

  it("does not retry non-retryable errors", async () => {
    const check = vi.fn(async () => {
      throw new Error("HTTP 403");
    });
    const { result, attempts } = await checkWithRetry(adapter(check), "1", "ABCPX1234K", noSleep);
    expect(attempts).toBe(1);
    expect(result.status).toBe("ERROR");
  });
});
