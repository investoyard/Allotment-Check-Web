import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { historyWorkbook, ipoWorkbook } from "../src/services/excel.js";
import { resultWhere, tally, totals, type HistoryRow } from "../src/services/reports.js";

let seq = 0;
const row = (o: Partial<HistoryRow>): HistoryRow => ({
  ipoId: 1, ipoName: "Alpha Ltd - IPO", registrar: "mufg", isSme: false, ipoDate: new Date("2026-10-01"),
  panId: 1, panMasked: "ABCPX****K", panEncrypted: `enc${++seq}`, holderName: "Ravi", clientId: 1, clientName: "Sharma Family",
  status: "NOT_ALLOTTED", appliedQty: 28, allottedQty: 0, category: "RETAIL", price: 500, amountAdjusted: 0, checkedAt: new Date("2026-10-02"),
  ...o,
});

const ROWS: HistoryRow[] = [
  row({ ipoId: 1, panId: 1, status: "ALLOTTED", allottedQty: 28 }),
  row({ ipoId: 2, panId: 1, status: "NOT_ALLOTTED" }),
  row({ ipoId: 3, panId: 1, status: "NOT_APPLIED", appliedQty: null, allottedQty: null }),
  row({ ipoId: 1, panId: 2, holderName: "Asha", panMasked: "ABCPY****L", status: "NOT_ALLOTTED" }),
  row({ ipoId: 2, panId: 2, holderName: "Asha", panMasked: "ABCPY****L", status: "ERROR", appliedQty: null, allottedQty: null }),
  row({ ipoId: 1, panId: 3, holderName: "Om", clientId: 2, clientName: "Om Traders", status: "ALLOTTED", allottedQty: 14, price: null }),
];

describe("tally", () => {
  it("groups by client; not-applied and errors stay out of the ratio", () => {
    const [sharma, om] = [tally(ROWS, "client").find((t) => t.key === 1)!, tally(ROWS, "client").find((t) => t.key === 2)!];
    expect(sharma).toMatchObject({ label: "Sharma Family", applied: 3, allotted: 1, notAllotted: 2, sharesApplied: 84, sharesAllotted: 28, allottedValue: 14000, errors: 1 });
    expect(sharma.ratio).toBeCloseTo(1 / 3);
    // Price unknown → shares counted, value not.
    expect(om).toMatchObject({ applied: 1, allotted: 1, ratio: 1, sharesAllotted: 14, allottedValue: 0 });
  });

  it("groups by PAN and sorts by most applied", () => {
    const t = tally(ROWS, "pan");
    expect(t.map((x) => [x.label, x.applied])).toEqual([["Ravi", 2], ["Asha", 1], ["Om", 1]]);
    expect(t[0]).toMatchObject({ panMasked: "ABCPX****K", ratio: 0.5 });
  });

  it("returns null ratio when nothing was applied", () => {
    expect(tally([row({ status: "NOT_APPLIED" })], "pan")[0]!.ratio).toBeNull();
  });

  it("totals", () => {
    expect(totals(ROWS)).toEqual({ ipos: 3, pans: 3, applications: 4, allotted: 2, ratio: 0.5, sharesAllotted: 42, allottedValue: 14000 });
    expect(totals([]).ratio).toBeNull();
  });
});

describe("resultWhere", () => {
  it("builds date, registrar and client filters", () => {
    const w = resultWhere({ from: "2026-10-01", to: "2026-10-31", registrar: "kfin", clientId: 5, ipoId: 9 });
    expect(w.ipoId).toBe(9);
    expect(w.pan).toEqual({ active: true, clientId: 5 });
    expect(w.ipo).toMatchObject({ registrar: "kfin" });
    const range = { gte: new Date("2026-10-01T00:00:00Z"), lte: new Date("2026-10-31T23:59:59.999Z") };
    expect(w.ipo!.OR).toEqual([{ allotmentDate: range }, { allotmentDate: null, createdAt: range }]);
  });

  it("no filters → active PANs only", () => {
    expect(resultWhere({})).toEqual({ ipo: {}, pan: { active: true } });
  });
});

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("excel", () => {
  it("IPO workbook has summary and results with status labels", async () => {
    const buf = await ipoWorkbook(
      { name: "Alpha Ltd - IPO", registrar: "mufg", registrarIpoId: "11968", allotmentDate: null },
      "MUFG Intime",
      { ALLOTTED: 1, NOT_ALLOTTED: 0, NOT_APPLIED: 0, ERROR: 0, PENDING: 1, allottedShares: 28 },
      [
        { clientName: "Sharma", holderName: "Ravi", pan: "ABCPX****K", status: "ALLOTTED", appliedQty: 28, allottedQty: 28, category: "RETAIL", price: 500, amountAdjusted: 14000, checkedAt: new Date(), message: null },
        { clientName: "Sharma", holderName: "Asha", pan: "ABCPY****L", status: "PENDING", appliedQty: null, allottedQty: null, category: null, price: null, amountAdjusted: null, checkedAt: null, message: null },
      ],
    );
    const wb = await load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Results"]);
    const res = wb.getWorksheet("Results")!;
    expect(res.getRow(1).values).toContain("Status");
    expect(res.getRow(2).getCell(4).value).toBe("Allotted");
    expect(res.getRow(3).getCell(4).value).toBe("Unchecked");
    expect(res.getRow(2).getCell(3).value).toBe("ABCPX****K");
  });

  it("history workbook uses the PAN formatter for By PAN and Detail", async () => {
    const buf = await historyWorkbook("All", totals(ROWS), tally(ROWS, "client"), tally(ROWS, "pan"), ROWS, (p) => `PAN(${p.panMasked})`, (id) => id.toUpperCase());
    const wb = await load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Overview", "By client", "By PAN", "Detail"]);
    expect(wb.getWorksheet("By PAN")!.getRow(2).getCell(3).value).toBe("PAN(ABCPX****K)");
    const detail = wb.getWorksheet("Detail")!;
    expect(detail.rowCount).toBe(ROWS.length + 1);
    expect(detail.getRow(2).getCell(2).value).toBe("MUFG");
    expect(detail.getRow(2).getCell(6).value).toBe("PAN(ABCPX****K)");
    // Ciphertext never lands in the file.
    const all = JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()));
    expect(all).not.toMatch(/enc\d/);
  });
});
