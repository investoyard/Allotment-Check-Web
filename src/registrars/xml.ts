// Minimal parser for ASP.NET DataSet XML (<NewDataSet><Table><col>v</col>…</Table>…</NewDataSet>).
// The responses are flat, so a full XML library isn't needed.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Returns the rows of every <tableName> element as plain objects. */
export function dataSetRows(xml: string, tableName: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const tableRe = new RegExp(`<${tableName}>([\\s\\S]*?)</${tableName}>`, "g");
  for (const [, body] of xml.matchAll(tableRe)) {
    const row: Record<string, string> = {};
    for (const [, key, value] of body!.matchAll(/<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g)) {
      row[key!] = decode(value!).trim();
    }
    for (const [, key] of body!.matchAll(/<([A-Za-z_][\w.-]*)\s*\/>/g)) row[key!] = "";
    rows.push(row);
  }
  return rows;
}
