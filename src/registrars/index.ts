import { BigshareAdapter } from "./bigshare.js";
import { KfinAdapter } from "./kfin.js";
import { MufgIntimeAdapter } from "./mufg.js";
import type { RegistrarAdapter } from "./types.js";

// BSE/NSE application-status pages are deliberately not supported: they are captcha-gated,
// and they only re-display registrar data that the adapters above already fetch.
export function createRegistry(
  adapters: RegistrarAdapter[] = [new MufgIntimeAdapter(), new KfinAdapter(), new BigshareAdapter()],
) {
  return new Map(adapters.map((a) => [a.id, a]));
}

export type Registry = ReturnType<typeof createRegistry>;
