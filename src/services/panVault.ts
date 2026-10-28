import type { Config } from "../config.js";
import { decrypt, encrypt, hmac } from "../lib/crypto.js";
import { maskPan, normalizePan } from "../lib/pan.js";

/** All PAN encryption goes through here so keys never leave this class. */
export class PanVault {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(config: Pick<Config, "PAN_ENC_KEY" | "PAN_HMAC_KEY">) {
    this.encKey = Buffer.from(config.PAN_ENC_KEY, "base64");
    this.hmacKey = Buffer.from(config.PAN_HMAC_KEY, "base64");
  }

  /** Expects an already validated PAN. */
  seal(pan: string) {
    const p = normalizePan(pan);
    return { panEncrypted: encrypt(p, this.encKey), panHash: this.hash(p), panMasked: maskPan(p) };
  }

  hash(pan: string) {
    return hmac(normalizePan(pan), this.hmacKey);
  }

  open(panEncrypted: string) {
    return decrypt(panEncrypted, this.encKey);
  }
}
