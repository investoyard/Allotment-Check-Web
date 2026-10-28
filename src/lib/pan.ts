// PAN format: 5 letters, 4 digits, 1 letter (e.g. ABCPX1234K).
// The 4th letter is the holder type (P individual, C company, H HUF, F firm, ...);
// not restricted here so new holder types don't get rejected.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function normalizePan(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidPan(pan: string): boolean {
  return PAN_RE.test(pan);
}

/** ABCPX1234K → ABCPX****K */
export function maskPan(pan: string): string {
  return `${pan.slice(0, 5)}****${pan.slice(9)}`;
}
