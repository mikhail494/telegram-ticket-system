import readline from "node:readline/promises";
import { Bot } from "grammy";
import { config } from "./config.js";
import { SupportDatabase } from "./db.js";
import { InstallationService } from "./installation.js";
import { AdaptiveKeyError } from "./adaptiveKeyErrors.js";

export async function runOwnerPair(
  options: {
    interactive?: boolean;
    confirm?: () => Promise<string>;
    getUsername?: () => Promise<string>;
    write?: (line: string) => void;
    openDatabase?: () => SupportDatabase;
  } = {}
): Promise<void> {
  const interactive = options.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  if (!interactive) throw new Error("Owner pairing requires an interactive terminal confirmation.");
  let prompt: readline.Interface | undefined;
  const confirm =
    options.confirm ??
    (async () => {
      prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      return prompt.question("Create a one-use OWNER pairing link? Type PAIR: ");
    });
  let answer: string;
  try {
    answer = await confirm();
  } finally {
    prompt?.close();
  }
  if (answer.trim() !== "PAIR") throw new Error("Owner pairing cancelled.");
  let injectedDatabase: SupportDatabase | undefined;
  let db: SupportDatabase;
  try {
    injectedDatabase = options.openDatabase?.();
    db = injectedDatabase ?? new SupportDatabase(config.databaseUrl, { adaptiveKeyPath: config.adaptiveKeyPath });
  } catch (error) {
    if (error instanceof AdaptiveKeyError) throw error;
    throw new Error("Owner pairing database could not be opened.");
  }
  try {
    const service = new InstallationService(db);
    if (service.getOwner()) throw new Error("An OWNER already exists. Use npm run owner:recover for a transfer.");
    let username: string;
    try {
      username = options.getUsername
        ? await options.getUsername()
        : (await new Bot(config.botToken).api.getMe()).username;
    } catch {
      throw new Error("Telegram identity verification failed; no pairing link was created.");
    }
    const token = service.createOwnerPairingToken();
    (options.write ?? console.log)(
      `Open this one-use link within 30 minutes: https://t.me/${username}?start=setup_${token}`
    );
  } finally {
    if (!injectedDatabase) db.close();
  }
}

export async function runOwnerPairCli(options: Parameters<typeof runOwnerPair>[0] = {}): Promise<number> {
  try {
    await runOwnerPair(options);
    return 0;
  } catch (error) {
    const safe = new Set([
      "Owner pairing requires an interactive terminal confirmation.",
      "Owner pairing cancelled.",
      "Owner pairing database could not be opened.",
      "An OWNER already exists. Use npm run owner:recover for a transfer.",
      "Telegram identity verification failed; no pairing link was created.",
    ]);
    console.error(
      error instanceof AdaptiveKeyError
        ? new AdaptiveKeyError(error.code).message
        : error instanceof Error && safe.has(error.message)
          ? error.message
          : "Owner pairing failed."
    );
    return 1;
  }
}
if (process.argv[1]?.endsWith("ownerPair.ts"))
  void runOwnerPairCli().then((code) => {
    process.exitCode = code;
  });
