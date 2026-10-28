import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { isValidPan, maskPan, normalizePan } from "./pan.js";

export interface ImportRow {
  rowNumber: number;
  pan: string;
  holderName: string;
  clientName: string;
  mobile: string | null;
  dpClientId: string | null;
}

export interface ImportError {
  rowNumber: number;
  message: string;
}

export interface ParseResult {
  rows: ImportRow[];
  errors: ImportError[];
}

type Field = "pan" | "holderName" | "clientName" | "mobile" | "dpClientId";

// Header names are compared after lowercasing and stripping everything but letters/digits.
const HEADER_ALIASES: Record<Field, string[]> = {
  pan: ["pan", "panno", "pannumber", "pancard", "pancardno"],
  holderName: ["name", "holdername", "investorname", "applicantname", "panname", "fullname"],
  clientName: ["client", "clientname", "group", "clientgroup", "family", "familyname", "clientcode"],
  mobile: ["mobile", "mobileno", "mobilenumber", "phone", "phoneno", "contact"],
  dpClientId: ["dpid", "dpclientid", "demat", "dematid", "demataccount", "dematno", "boid", "clientid"],
};

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if ("richText" in value) return value.richText.map((r) => r.text).join("").trim();
    if ("text" in value) return String(value.text).trim();
    if ("result" in value) return value.result == null ? "" : String(value.result).trim();
    return "";
  }
  return String(value).trim();
}

export async function readSheet(buffer: Buffer, filename: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet | undefined;
  if (/\.csv$/i.test(filename)) {
    ws = await wb.csv.read(Readable.from(buffer));
  } else if (/\.xlsx$/i.test(filename)) {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    ws = wb.worksheets[0];
  } else {
    throw new Error("Unsupported file type — upload .xlsx or .csv");
  }
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as ExcelJS.CellValue[]; // 1-indexed
    out[row.number - 1] = values.slice(1).map(cellText);
  });
  return Array.from(out, (r) => r ?? []);
}

/** Turns raw sheet rows (first row = headers) into validated import rows. */
export function parseRows(sheet: string[][]): ParseResult {
  const [header, ...body] = sheet;
  if (!header) return { rows: [], errors: [{ rowNumber: 1, message: "File is empty" }] };

  const col: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) {
      if (col[field] === undefined && aliases.includes(n)) col[field] = i;
    }
  });

  const missing = (["pan", "holderName"] as const).filter((f) => col[f] === undefined);
  if (missing.length) {
    return {
      rows: [],
      errors: [{ rowNumber: 1, message: `Missing required column(s): ${missing.map((m) => (m === "pan" ? "PAN" : "Name")).join(", ")}` }],
    };
  }

  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];
  const seen = new Map<string, number>();
  const get = (r: string[], f: Field) => (col[f] === undefined ? "" : (r[col[f]!] ?? "").trim());

  body.forEach((r, i) => {
    const rowNumber = i + 2;
    if (r.every((c) => !c)) return; // blank line

    const pan = normalizePan(get(r, "pan"));
    const holderName = get(r, "holderName");
    if (!pan) return void errors.push({ rowNumber, message: "PAN is empty" });
    if (!isValidPan(pan)) return void errors.push({ rowNumber, message: "Invalid PAN format" });
    if (!holderName) return void errors.push({ rowNumber, message: `Name is empty for ${maskPan(pan)}` });
    const firstRow = seen.get(pan);
    if (firstRow) return void errors.push({ rowNumber, message: `Duplicate of row ${firstRow} (${maskPan(pan)})` });
    seen.set(pan, rowNumber);

    rows.push({
      rowNumber,
      pan,
      holderName,
      // Without a client/group column each PAN holder becomes their own client.
      clientName: get(r, "clientName") || holderName,
      mobile: get(r, "mobile") || null,
      dpClientId: get(r, "dpClientId") || null,
    });
  });

  return { rows, errors };
}
