import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { z } from "zod";
import { requireLogin } from "../auth.js";
import { sendXlsx } from "./ipos.js";

// Download formats for every bulk upload, so users start from the right columns.
interface Template {
  title: string;
  file: string;
  columns: { header: string; width: number; required: boolean; note: string }[];
  instructions: string[];
}

const TEMPLATES: Record<string, Template> = {
  pans: {
    title: "Import / update PANs",
    file: "PAN import format",
    columns: [
      { header: "PAN", width: 14, required: true, note: "10 characters, e.g. ABCPX1234K" },
      { header: "Name", width: 30, required: true, note: "Holder name as on PAN" },
      { header: "Client", width: 26, required: false, note: "Client or family group. Blank = the holder becomes their own client" },
      { header: "Mobile", width: 14, required: false, note: "Optional" },
      { header: "DP ID", width: 20, required: false, note: "Optional demat / DP-Client ID" },
    ],
    instructions: [
      "Use this file on the Import page to add new PANs or update existing ones.",
      "One row per PAN. Fill from row 2 of the 'PANs' sheet; keep the header row.",
      "A PAN that already exists is updated (name, client, mobile, DP ID), never duplicated.",
      "Blank Mobile / DP ID cells don't erase what's already saved.",
      "Click Preview first; nothing is saved until you click Import.",
      "Tick IPOs on the Import page to check the new PANs straight away.",
    ],
  },
  delete: {
    title: "Delete PANs",
    file: "PAN delete format",
    columns: [{ header: "PAN", width: 14, required: true, note: "10 characters, e.g. ABCPX1234K" }],
    instructions: [
      "Use this file on the PANs page → Delete from Excel.",
      "List the PANs to delete, one per row, from row 2 of the 'PANs' sheet.",
      "Preview shows which PANs match before anything is deleted.",
      "Deleting erases the full PAN permanently. Past IPO results stay in reports with the masked PAN, holder name and client.",
      "To pause a PAN without deleting it, use Deactivate on the PANs page instead.",
    ],
  },
};

export async function templateRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireLogin);

  app.get("/", async () => ({
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, title: t.title })),
  }));

  app.get("/:type", async (req, reply) => {
    const { type } = z.object({ type: z.string() }).parse(req.params);
    const t = TEMPLATES[type];
    if (!t) return reply.code(404).send({ error: "Unknown template" });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("PANs", { views: [{ state: "frozen", ySplit: 1 }] });
    // Text format so Excel keeps leading zeros and long numbers (mobile, DP ID) as typed.
    ws.columns = t.columns.map((c) => ({ header: c.header, width: c.width, style: { numFmt: "@" } }));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    t.columns.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.required ? "FF2563EB" : "FF64748B" } };
      cell.note = `${c.required ? "Required" : "Optional"}: ${c.note}`;
    });

    const help = wb.addWorksheet("How to fill");
    help.columns = [{ width: 18 }, { width: 12 }, { width: 70 }];
    help.addRow([t.title]).font = { bold: true, size: 14 };
    help.addRow([]);
    for (const line of t.instructions) help.addRow(["•", line]);
    help.addRow([]);
    help.addRow(["Column", "Required", "What to enter"]).font = { bold: true };
    for (const c of t.columns) help.addRow([c.header, c.required ? "Yes" : "No", c.note]);
    help.addRow([]);
    help.addRow(["Example"]).font = { bold: true };
    help.addRow(t.columns.map((c) => c.header)).font = { italic: true };
    help.addRow(
      t.columns.map((c) => ({ PAN: "ABCPX1234K", Name: "Ravi Sharma", Client: "Sharma Family", Mobile: "9800000000", "DP ID": "1208160000000001" })[c.header] ?? ""),
    ).font = { italic: true, color: { argb: "FF64748B" } };

    return sendXlsx(reply, t.file, Buffer.from(await wb.xlsx.writeBuffer()));
  });
}
