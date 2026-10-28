import ExcelJS from "exceljs";
import { listingGain, type HistoryRow, type Tally } from "./reports.js";
import type { totals as totalsFn } from "./reports.js";

export const STATUS_LABEL: Record<string, string> = {
  ALLOTTED: "Allotted",
  NOT_ALLOTTED: "Not allotted",
  NOT_APPLIED: "Not applied",
  ERROR: "Error",
  PENDING: "Unchecked",
};

const STATUS_FILL: Record<string, string> = { ALLOTTED: "FFDCFCE7", ERROR: "FFFEE2E2", PENDING: "FFFEF3C7" };

interface Col {
  header: string;
  key: string;
  width: number;
  numFmt?: string;
}

const INT = "#,##0";
const MONEY = "#,##0.00";
const PCT = "0.0%";
const DATE = "dd-mmm-yyyy";
const DATETIME = "dd-mmm-yyyy hh:mm";

function addTable(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, unknown>[], statusKey?: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
  header.alignment = { vertical: "middle" };
  for (const r of rows) {
    const row = ws.addRow(r);
    const fill = statusKey ? STATUS_FILL[String(r[`_${statusKey}`] ?? "")] : undefined;
    if (fill && statusKey) row.getCell(statusKey).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

function addKeyValues(wb: ExcelJS.Workbook, name: string, title: string, pairs: [string, unknown, string?][]) {
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 28 }, { width: 40 }];
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([]);
  for (const [k, v, fmt] of pairs) {
    const row = ws.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    if (fmt) row.getCell(2).numFmt = fmt;
    row.getCell(2).alignment = { horizontal: "left" };
  }
  return ws;
}

export interface IpoExportRow {
  clientName: string;
  holderName: string;
  pan: string;
  status: string;
  appliedQty: number | null;
  allottedQty: number | null;
  category: string | null;
  price: number | null;
  amountAdjusted: number | null;
  checkedAt: Date | null;
  message: string | null;
  listingGain: number | null;
}

export async function ipoWorkbook(
  ipo: { name: string; registrar: string; registrarIpoId: string; allotmentDate: Date | null; listingDate?: Date | null; issuePrice?: number | null; listingPrice?: number | null },
  registrarName: string,
  counts: Record<string, number>,
  rows: IpoExportRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const gains = rows.map((r) => r.listingGain).filter((g): g is number => g != null);
  addKeyValues(wb, "Summary", ipo.name, [
    ["Registrar", `${registrarName} (ID ${ipo.registrarIpoId})`],
    ["Allotment date", ipo.allotmentDate, DATE],
    ["Listing date", ipo.listingDate ?? null, DATE],
    ["Issue price", ipo.issuePrice ?? null, MONEY],
    ["Listing price", ipo.listingPrice ?? null, MONEY],
    ["Listing gain (₹)", gains.length ? gains.reduce((a, b) => a + b, 0) : null, MONEY],
    ["Exported", new Date(), DATETIME],
    ["PANs in this export", rows.length, INT],
    ["Allotted", counts.ALLOTTED ?? 0, INT],
    ["Not allotted", counts.NOT_ALLOTTED ?? 0, INT],
    ["Not applied", counts.NOT_APPLIED ?? 0, INT],
    ["Errors", counts.ERROR ?? 0, INT],
    ["Unchecked", counts.PENDING ?? 0, INT],
    ["Shares allotted", counts.allottedShares ?? 0, INT],
  ]);
  addTable(
    wb,
    "Results",
    [
      { header: "Client", key: "clientName", width: 26 },
      { header: "Holder", key: "holderName", width: 28 },
      { header: "PAN", key: "pan", width: 13 },
      { header: "Status", key: "status", width: 13 },
      { header: "Applied", key: "appliedQty", width: 10, numFmt: INT },
      { header: "Allotted", key: "allottedQty", width: 10, numFmt: INT },
      { header: "Category", key: "category", width: 16 },
      { header: "Price", key: "price", width: 10, numFmt: MONEY },
      { header: "Amount adjusted", key: "amountAdjusted", width: 16, numFmt: MONEY },
      { header: "Listing gain", key: "listingGain", width: 14, numFmt: MONEY },
      { header: "Checked", key: "checkedAt", width: 18, numFmt: DATETIME },
      { header: "Message", key: "message", width: 40 },
    ],
    rows.map((r) => ({ ...r, status: STATUS_LABEL[r.status] ?? r.status, _status: r.status })),
    "status",
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function historyWorkbook(
  filterText: string,
  t: ReturnType<typeof totalsFn>,
  byClient: Tally[],
  byPan: Tally[],
  detail: HistoryRow[],
  panOf: (encryptedOrMasked: { panMasked: string; panEncrypted: string }) => string,
  registrarName: (id: string) => string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  addKeyValues(wb, "Overview", "IPO allotment history", [
    ["Filters", filterText],
    ["Exported", new Date(), DATETIME],
    ["IPOs", t.ipos, INT],
    ["PANs", t.pans, INT],
    ["Applications found", t.applications, INT],
    ["Allotted", t.allotted, INT],
    ["Allotment ratio", t.ratio, PCT],
    ["Shares allotted", t.sharesAllotted, INT],
    ["Allotted value (₹)", t.allottedValue, MONEY],
    ["Listing gain (₹)", t.listingGain, MONEY],
    ["Allotments without listing price", t.gainUnknown, INT],
  ]);

  const tallyCols = (first: Col[]): Col[] => [
    ...first,
    { header: "IPOs applied", key: "applied", width: 13, numFmt: INT },
    { header: "Allotted", key: "allotted", width: 10, numFmt: INT },
    { header: "Not allotted", key: "notAllotted", width: 12, numFmt: INT },
    { header: "Ratio", key: "ratio", width: 9, numFmt: PCT },
    { header: "Shares applied", key: "sharesApplied", width: 15, numFmt: INT },
    { header: "Shares allotted", key: "sharesAllotted", width: 15, numFmt: INT },
    { header: "Allotted value (₹)", key: "allottedValue", width: 18, numFmt: MONEY },
    { header: "Listing gain (₹)", key: "listingGain", width: 16, numFmt: MONEY },
    { header: "Errors", key: "errors", width: 8, numFmt: INT },
  ];

  addTable(wb, "By client", tallyCols([{ header: "Client", key: "label", width: 30 }]), byClient as unknown as Record<string, unknown>[]);
  addTable(
    wb,
    "By PAN",
    tallyCols([
      { header: "Client", key: "clientName", width: 26 },
      { header: "Holder", key: "label", width: 28 },
      { header: "PAN", key: "pan", width: 13 },
    ]),
    byPan.map((p) => ({ ...p, pan: panOf({ panMasked: p.panMasked!, panEncrypted: p.panEncrypted! }) })),
  );
  addTable(
    wb,
    "Detail",
    [
      { header: "IPO", key: "ipoName", width: 36 },
      { header: "Registrar", key: "registrar", width: 18 },
      { header: "Date", key: "ipoDate", width: 13, numFmt: DATE },
      { header: "Client", key: "clientName", width: 26 },
      { header: "Holder", key: "holderName", width: 28 },
      { header: "PAN", key: "pan", width: 13 },
      { header: "Status", key: "status", width: 13 },
      { header: "Applied", key: "appliedQty", width: 10, numFmt: INT },
      { header: "Allotted", key: "allottedQty", width: 10, numFmt: INT },
      { header: "Category", key: "category", width: 16 },
      { header: "Price", key: "paid", width: 10, numFmt: MONEY },
      { header: "Listing price", key: "listingPrice", width: 13, numFmt: MONEY },
      { header: "Listing gain", key: "gain", width: 13, numFmt: MONEY },
      { header: "Checked", key: "checkedAt", width: 18, numFmt: DATETIME },
    ],
    detail.map((r) => ({
      ...r,
      paid: r.issuePrice ?? r.price,
      gain: listingGain(r),
      registrar: registrarName(r.registrar),
      pan: panOf(r),
      status: STATUS_LABEL[r.status] ?? r.status,
      _status: r.status,
    })),
    "status",
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}
