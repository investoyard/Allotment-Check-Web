import { MufgIntimeAdapter } from "./mufg.js";
import type { RegistrarAdapter } from "./types.js";

export function createRegistry(adapters: RegistrarAdapter[] = [new MufgIntimeAdapter()]) {
  return new Map(adapters.map((a) => [a.id, a]));
}

export type Registry = ReturnType<typeof createRegistry>;
