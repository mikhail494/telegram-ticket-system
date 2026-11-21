import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
    if (key.length !== 32) throw new Error("Adaptive privacy key must contain exactly 32 bytes.");
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

function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Reject symlinks in every component, including pre-existing parents.
  for (let current = directory; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe adaptive key directory.");
    if (path.dirname(current) === current) break;
  }
  const info = fs.statSync(directory);
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    throw new Error("Adaptive key directory must be owner-only (0700).");
}

function readKey(file: string): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Unsafe adaptive key file.");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      before.ino !== opened.ino ||
      before.dev !== opened.dev ||
      opened.nlink !== 1 ||
      opened.size !== 32 ||
      (process.platform !== "win32" && ((opened.mode & 0o077) !== 0 || opened.uid !== process.getuid?.()))
    )
      throw new Error("Unsafe adaptive key file permissions or identity.");
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function finishPublishedKey(file: string): void {
  const published = fs.lstatSync(file);
  if (!published.isFile() || published.isSymbolicLink() || published.nlink === 1) return;
  // A crash can leave the complete publication inode under both names. Only remove
  // our matching temporary link, never another key or an unrelated hard link.
  for (const name of fs.readdirSync(path.dirname(file))) {
    if (!/^\.key-[a-f0-9]{32}\.tmp$/.test(name)) continue;
    const temporary = path.join(path.dirname(file), name);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isFile() && !info.isSymbolicLink() && info.dev === published.dev && info.ino === published.ino) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function loadAdaptivePrivacy(
  databasePath: string,
  configuredPath?: string,
  expectedKeyId?: string,
  createIfMissing = true
): AdaptivePrivacy {
  if (databasePath === ":memory:" && !configuredPath) return new AdaptivePrivacy(randomBytes(32));
  const file = path.resolve(configuredPath || defaultAdaptiveKeyPath(databasePath));
  const directory = path.dirname(file);
  if ((expectedKeyId || !createIfMissing) && !fs.existsSync(file))
    throw new Error("Adaptive privacy key is missing; restore the original key.");
  secureDirectory(directory);
  if (!fs.existsSync(file)) {
    if (expectedKeyId || !createIfMissing)
      throw new Error("Adaptive privacy key is missing; restore the original key.");
    const temporary = path.join(directory, `.key-${randomBytes(16).toString("hex")}.tmp`);
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, randomBytes(32));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  finishPublishedKey(file);
  if (process.platform !== "win32") {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const privacy = new AdaptivePrivacy(readKey(file));
  if (expectedKeyId && privacy.keyId !== expectedKeyId)
    throw new Error("Adaptive privacy key mismatch; restore the original key.");
  return privacy;
}
