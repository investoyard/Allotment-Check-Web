// A "client" whose name is just the holder's own name isn't a real group (that's what an
// import without a Client column produces), so screens and exports hide it.

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export const sameName = (a: string | null | undefined, b: string | null | undefined) => norm(a) === norm(b);

/** True when at least one row is grouped under a client other than the holder themself. */
export const usesGroups = (rows: { clientName: string; holderName: string }[]) => rows.some((r) => !sameName(r.clientName, r.holderName));

/** Client name to display: blank when it's just the holder's own name. */
export const groupName = (clientName: string, holderName: string) => (sameName(clientName, holderName) ? "" : clientName);
