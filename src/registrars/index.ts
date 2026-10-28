import { BigshareAdapter } from "./bigshare.js";
import { KfinAdapter } from "./kfin.js";
import { MaashitlaAdapter } from "./maashitla.js";
import { MufgIntimeAdapter } from "./mufg.js";
import { PurvaAdapter } from "./purva.js";
import { SkylineAdapter } from "./skyline.js";
import type { RegistrarAdapter } from "./types.js";

// Deliberately not supported, because their status pages show a captcha:
//   BSE/NSE (and they only re-display registrar data), Cameo, Integrated Registry.
export function createRegistry(
  adapters: RegistrarAdapter[] = [
    new MufgIntimeAdapter(),
    new KfinAdapter(),
    new BigshareAdapter(),
    new SkylineAdapter(),
    new PurvaAdapter(),
    new MaashitlaAdapter(),
  ],
) {
  return new Map(adapters.map((a) => [a.id, a]));
}

export type Registry = ReturnType<typeof createRegistry>;
