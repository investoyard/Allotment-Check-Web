// Talk to a registrar adapter directly, without the database. Handy for testing adapters.
//   npm run registrar -- ipos mufg
//   npm run registrar -- check mufg <registrarIpoId> <PAN>
import { createRegistry } from "../src/registrars/index.js";
import { maskPan, normalizePan, isValidPan } from "../src/lib/pan.js";

const [cmd, registrarId, ...rest] = process.argv.slice(2);
const registry = createRegistry();
const adapter = registry.get(registrarId ?? "");

if (!adapter || !["ipos", "check"].includes(cmd ?? "")) {
  console.error(`Usage:\n  npm run registrar -- ipos <registrar>\n  npm run registrar -- check <registrar> <ipoId> <PAN>\nRegistrars: ${[...registry.keys()].join(", ")}`);
  process.exit(1);
}

if (cmd === "ipos") {
  for (const i of await adapter.listIpos()) console.log(`${i.registrarIpoId.padEnd(8)} ${i.isSme ? "[SME] " : ""}${i.name}`);
} else {
  const [ipoId, rawPan] = rest;
  const pan = normalizePan(rawPan ?? "");
  if (!ipoId || !isValidPan(pan)) {
    console.error("Need a registrar IPO id and a valid PAN");
    process.exit(1);
  }
  const r = await adapter.check(ipoId, pan);
  console.log(JSON.stringify({ pan: maskPan(pan), ...r }, null, 2));
}
