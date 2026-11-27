import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  publishPrivateAdaptiveFile,
  readOrRecoverPrivateAdaptiveFile,
  secureAdaptiveKeyPath,
} from "./adaptiveKeyFiles.js";
import { AdaptiveKeyError } from "./adaptiveKeyErrors.js";

export type AdaptiveHashKind = "FINGERPRINT" | "TOKEN" | "TRIGRAM";
type Features = {
  fingerprintHash: string;
  tokenHashes: readonly string[];
  trigramHashes: readonly string[];
  families?: ReadonlyArray<{ tokenHash: string; trigramHashes: readonly string[] }>;
};

export class AdaptivePrivacy {
  readonly keyId: string;
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new AdaptiveKeyError("LENGTH");
    this.#key = Buffer.from(key);
    this.keyId = createHash("sha256").update("adaptive-key-id-v2\0").update(key).digest("hex");
  }
  wrap(kind: AdaptiveHashKind, legacyHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(legacyHash)) throw new Error("Invalid legacy adaptive hash.");
    return createHmac("sha256", this.#key).update(`adaptive-v2\0${kind}\0${legacyHash}`).digest("hex");
  }
  protect<T extends Features>(features: T): T {
    const wrap = (kind: AdaptiveHashKind, hash: string) =>
      /^[a-f0-9]{64}$/i.test(hash) ? this.wrap(kind, hash.toLowerCase()) : "";
    const families = features.families;
    return {
      ...features,
      fingerprintHash: wrap("FINGERPRINT", features.fingerprintHash),
      tokenHashes: features.tokenHashes.map((hash) => wrap("TOKEN", hash)).filter(Boolean),
      trigramHashes: features.trigramHashes.map((hash) => wrap("TRIGRAM", hash)).filter(Boolean),
      ...(families
        ? {
            families: families.map((family) => ({
              tokenHash: wrap("TOKEN", family.tokenHash),
              trigramHashes: family.trigramHashes.map((hash) => wrap("TRIGRAM", hash)).filter(Boolean),
            })),
          }
        : {}),
    };
  }
}

export function defaultAdaptiveKeyPath(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), ".adaptive-private", "adaptive.key");
}

export function loadAdaptivePrivacy(
  databasePath: string,
  configuredPath?: string,
  expectedKeyId?: string,
  createIfMissing = true
): AdaptivePrivacy {
  if (databasePath === ":memory:" && !configuredPath) return new AdaptivePrivacy(randomBytes(32));
  const secured = secureAdaptiveKeyPath(configuredPath || defaultAdaptiveKeyPath(databasePath));
  const file = secured.file;
  if ((expectedKeyId || !createIfMissing) && !fs.existsSync(file)) throw new AdaptiveKeyError("MISSING");
  if (!fs.existsSync(file)) {
    if (expectedKeyId || !createIfMissing) throw new AdaptiveKeyError("MISSING");
    secured.verify();
    try {
      publishPrivateAdaptiveFile(file, randomBytes(32));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  secured.verify();
  const privacy = new AdaptivePrivacy(readOrRecoverPrivateAdaptiveFile(file));
  secured.sync();
  secured.verify();
  if (expectedKeyId && privacy.keyId !== expectedKeyId) throw new AdaptiveKeyError("MISMATCH");
  return privacy;
}
