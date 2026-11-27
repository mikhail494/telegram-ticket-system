import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";
import { SupportDatabase } from "./db.js";
import { ADAPTIVE_RECOVERY_CONFIRMATION } from "./persistence/adaptivePrivacyRecovery.js";
import { AdaptiveKeyError } from "./adaptiveKeyErrors.js";

export async function runAdaptiveRecovery(
  options: {
    interactive?: boolean;
    confirm?: () => Promise<string>;
    databaseUrl?: string;
    adaptiveKeyPath?: string;
    write?: (line: string) => void;
  } = {}
) {
  if (!(options.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))))
    throw new Error("Offline adaptive recovery requires an interactive terminal.");
  const write = options.write ?? console.log;
  write(
    "STOP the application, all pollers and database tools. Retain an offline copy of SQLite, sidecars and the key directory first. Permanent key loss blocks the entire database. This reset destroys only adaptive message features, signal observations, OWNER learning feedback and maintenance counters; it preserves ticket/delivery/Batch state and moderation sanctions. Never use it if the original key can be restored."
  );
  let prompt: readline.Interface | undefined;
  let answer: string;
  try {
    answer = options.confirm
      ? await options.confirm()
      : await (prompt = readline.createInterface({ input: process.stdin, output: process.stdout })).question(
          `Type ${ADAPTIVE_RECOVERY_CONFIRMATION}: `
        );
  } finally {
    prompt?.close();
  }
  if (answer.trim() !== ADAPTIVE_RECOVERY_CONFIRMATION) throw new Error("Offline adaptive recovery cancelled.");
  const result = SupportDatabase.recoverAdaptivePrivacy(options.databaseUrl ?? config.databaseUrl, {
    adaptiveKeyPath: options.adaptiveKeyPath ?? config.adaptiveKeyPath,
    confirmation: answer.trim(),
  });
  write(
    `ADAPTIVE RECOVERY COMPLETE\nResumed: ${result.resumed}\nAdaptive reset performed: ${result.resetPerformed}\nRemoved feature/observation/feedback/maintenance rows: ${result.removed.features}/${result.removed.observations}/${result.removed.feedback}/${result.removed.maintenance}\nBack up the new key separately before restarting.`
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
  void runAdaptiveRecovery().catch((error) => {
    console.error(
      error instanceof AdaptiveKeyError
        ? new AdaptiveKeyError(error.code).message
        : "Offline adaptive recovery did not complete. Keep the application stopped, check exclusive ownership, and rerun the same command to resume. No backup is automatically restored."
    );
    process.exitCode = 1;
  });
