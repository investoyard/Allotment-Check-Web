import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hashPassword, hmac, verifyPassword } from "../src/lib/crypto.js";
import { parseRows, readSheet } from "../src/lib/import.js";
import { isValidPan, maskPan, normalizePan } from "../src/lib/pan.js";
import { clientCode } from "../src/services/panImport.js";

describe("pan", () => {
  it("normalises, validates and masks", () => {
    expect(normalizePan(" abcpx 1234k ")).toBe("ABCPX1234K");
    expect(isValidPan("ABCPX1234K")).toBe(true);
    expect(isValidPan("ABCPX123K")).toBe(false);
    expect(isValidPan("1BCPX1234K")).toBe(false);
    expect(maskPan("ABCPX1234K")).toBe("ABCPX****K");
  });
});

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips AES-GCM with a fresh IV each time", () => {
    const a = encrypt("ABCPX1234K", key);
    const b = encrypt("ABCPX1234K", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("ABCPX1234K");
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const [iv, tag, data] = encrypt("ABCPX1234K", key).split(":");
    const flipped = Buffer.from(data!, "base64");
    flipped[0]! ^= 1;
    expect(() => decrypt(`${iv}:${tag}:${flipped.toString("base64")}`, key)).toThrow();
    expect(() => decrypt(encrypt("ABCPX1234K", key), randomBytes(32))).toThrow();
  });

  it("hmac is deterministic per key", () => {
    expect(hmac("X", key)).toBe(hmac("X", key));
    expect(hmac("X", key)).not.toBe(hmac("X", randomBytes(32)));
  });

  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("clientCode", () => {
  it("slugifies names", () => {
    expect(clientCode("Sharma Family")).toBe("SHARMA-FAMILY");
    expect(clientCode("  r.k. & sons ")).toBe("R-K-SONS");
    expect(clientCode("!!!")).toBe("CLIENT");
  });
});

describe("parseRows", () => {
  it("maps header aliases and defaults client to holder name", () => {
    const { rows, errors } = parseRows([
      ["PAN No", "Investor Name", "Family", "Mobile No", "DP ID"],
      ["abcpx1234k", "Ravi Sharma", "Sharma Family", "9800000000", "1208160000000001"],
      ["ABCPY1234L", "Asha", "", "", ""],
    ]);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { rowNumber: 2, pan: "ABCPX1234K", holderName: "Ravi Sharma", clientName: "Sharma Family", mobile: "9800000000", dpClientId: "1208160000000001" },
      { rowNumber: 3, pan: "ABCPY1234L", holderName: "Asha", clientName: "Asha", mobile: null, dpClientId: null },
    ]);
  });

  it("reports invalid, empty and duplicate rows; skips blank lines", () => {
    const { rows, errors } = parseRows([
      ["PAN", "Name"],
      ["ABCPX1234K", "A"],
      ["BAD", "B"],
      ["", ""],
      ["ABCPZ1234K", ""],
      ["abcpx1234k", "A again"],
    ]);
    expect(rows.map((r) => r.rowNumber)).toEqual([2]);
    expect(errors).toEqual([
      { rowNumber: 3, message: "Invalid PAN format" },
      { rowNumber: 5, message: "Name is empty for ABCPZ****K" },
      { rowNumber: 6, message: "Duplicate of row 2 (ABCPX****K)" },
    ]);
  });

  it("errors on missing required columns", () => {
    const { errors } = parseRows([["Name", "Mobile"], ["A", "1"]]);
    expect(errors[0]!.message).toMatch(/Missing required column\(s\): PAN/);
  });
});

describe("readSheet", () => {
  it("reads xlsx, including rich text and formula cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("PANs");
    ws.addRow(["PAN", "Name"]);
    ws.addRow([{ richText: [{ text: "ABCPX" }, { text: "1234K" }] }, { formula: '"Ravi"', result: "Ravi" }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const sheet = await readSheet(buf, "clients.xlsx");
    expect(parseRows(sheet).rows[0]).toMatchObject({ pan: "ABCPX1234K", holderName: "Ravi" });
  });

  it("reads csv and rejects other types", async () => {
    const sheet = await readSheet(Buffer.from("PAN,Name\nABCPX1234K,Ravi\n"), "c.csv");
    expect(parseRows(sheet).rows).toHaveLength(1);
    await expect(readSheet(Buffer.from("x"), "c.xls")).rejects.toThrow(/Unsupported/);
  });
});
