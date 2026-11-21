import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defaultAdaptiveKeyPath, loadAdaptivePrivacy } from "./adaptivePrivacy.js";
import {
  publishPrivateAdaptiveFile,
  readOrRecoverPrivateAdaptiveFile,
  secureAdaptiveKeyPath,
} from "./adaptiveKeyFiles.js";

const journalSchema = z
  .object({
    version: z.literal(1),
    database: z.string(),
    originalKeyId: z.string().regex(/^[a-f0-9]{64}$/),
    newKeyId: z.string().regex(/^[a-f0-9]{64}$/),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type AdaptiveRecoveryJournal = z.infer<typeof journalSchema>;

export function adaptiveRecoveryFiles(database: string, keyPath?: string) {
  const secured = secureAdaptiveKeyPath(keyPath || process.env.ADAPTIVE_KEY_PATH || defaultAdaptiveKeyPath(database));
  const journalFile = `${secured.file}.recovery.json`;
  const candidate = (journal: { nonce: string }) =>
    path.join(path.dirname(secured.file), `recovery-${journal.nonce}.key`);
  return {
    keyFile: secured.file,
    read(): AdaptiveRecoveryJournal | undefined {
      secured.verify();
      if (!fs.existsSync(journalFile)) return undefined;
      const journal = journalSchema.parse(JSON.parse(readOrRecoverPrivateAdaptiveFile(journalFile).toString("utf8")));
      if (journal.database !== fs.realpathSync(database))
        throw new Error("Adaptive recovery journal belongs to a different database.");
      return journal;
    },
    prepare(originalKeyId: string): AdaptiveRecoveryJournal {
      secured.verify();
      const nonce = randomBytes(16).toString("hex");
      const pending = { nonce };
      const privacy = loadAdaptivePrivacy(database, candidate(pending));
      const journal: AdaptiveRecoveryJournal = {
        version: 1,
        database: fs.realpathSync(database),
        originalKeyId,
        newKeyId: privacy.keyId,
        nonce,
      };
      publishPrivateAdaptiveFile(journalFile, Buffer.from(JSON.stringify(journal)));
      secured.sync();
      return journal;
    },
    publish(journal: AdaptiveRecoveryJournal): void {
      secured.verify();
      const pending = candidate(journal);
      if (fs.existsSync(pending) && fs.existsSync(secured.file)) {
        const a = fs.lstatSync(pending),
          b = fs.lstatSync(secured.file);
        if (
          a.ino === b.ino &&
          a.dev === b.dev &&
          a.isFile() &&
          b.isFile() &&
          !a.isSymbolicLink() &&
          !b.isSymbolicLink()
        ) {
          fs.unlinkSync(pending);
          secured.sync();
        }
      }
      if (fs.existsSync(secured.file)) {
        const current = loadAdaptivePrivacy(database, secured.file, undefined, false);
        if (current.keyId !== journal.newKeyId) {
          const quarantine = path.join(path.dirname(secured.file), `replaced-${journal.nonce}.key`);
          if (fs.existsSync(quarantine))
            throw new Error("Adaptive key changed during recovery; refusing to overwrite retained key.");
          fs.renameSync(secured.file, quarantine);
          secured.sync();
        }
      }
      if (!fs.existsSync(secured.file)) {
        loadAdaptivePrivacy(database, pending, journal.newKeyId, false);
        fs.linkSync(pending, secured.file);
        secured.sync();
        fs.unlinkSync(pending);
        secured.sync();
      }
      loadAdaptivePrivacy(database, secured.file, journal.newKeyId, false);
    },
    complete(journal: AdaptiveRecoveryJournal): void {
      secured.verify();
      fs.renameSync(journalFile, path.join(path.dirname(secured.file), `recovery-completed-${journal.nonce}.json`));
      secured.sync();
    },
  };
}
