import { randomBytes } from "node:crypto";

// Prints fresh secrets to paste into .env. Back up PAN_ENC_KEY and PAN_HMAC_KEY —
// without them stored PANs can't be decrypted or matched.
console.log(`JWT_SECRET=${randomBytes(48).toString("base64url")}`);
console.log(`PAN_ENC_KEY=${randomBytes(32).toString("base64")}`);
console.log(`PAN_HMAC_KEY=${randomBytes(32).toString("base64")}`);
